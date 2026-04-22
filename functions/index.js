const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

admin.initializeApp();

const app = express();
app.use(cors({ 
    origin: [
        "https://slidechangeronline.me", 
        "https://www.slidechangeronline.me", 
        "https://slidechangeronline.web.app", 
        "https://slidechangeronline.firebaseapp.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

const checkAuth = async (req, res, next) => {
    const tokenId = req.get("Authorization")?.split("Bearer ")[1];
    if (!tokenId) return res.status(401).send({ error: "Unauthorized: No token provided." });
    try {
        req.user = await admin.auth().verifyIdToken(tokenId);
        next();
    } catch (error) {
        logger.error("Auth error:", error);
        return res.status(401).send({ error: "Unauthorized: Invalid token." });
    }
};

// INITIALIZATION USING SECURE ENVIRONMENT VARIABLES
// --- Razorpay Initialization (Safe for Deployment) ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "placeholder_id";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "placeholder_secret";

// This prevents the SDK from throwing an error during Firebase's local analysis
const razorpayInstance = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
});

// REWRITTEN: Create Subscription Endpoint
app.post("/createRazorpaySubscription", checkAuth, async (req, res) => {
    const options = {
        plan_id: "plan_SgYpw6WI3SKFah", // Your injected Plan ID
        total_count: 120, // Bills monthly for up to 10 years
        customer_notify: 1,
        notes: {
            firebase_user_id: req.user.uid
        }
    };

    try {
        const subscription = await razorpayInstance.subscriptions.create(options);
        logger.info("Subscription created:", subscription.id);
        res.status(200).send({ data: { subscriptionId: subscription.id } });
    } catch (error) {
        logger.error("Error creating subscription:", error);
        res.status(500).send({ error: "Could not create a subscription plan." });
    }
});

exports.api = onRequest({ region: "us-central1" }, app);

// REWRITTEN: Subscription Webhook Handler
exports.razorpayWebhook = onRequest(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "S@mpreethl4E143143"; 

    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== req.headers['x-razorpay-signature']) {
        logger.error('Webhook signature verification failed.');
        return res.status(400).send('Invalid signature.');
    }

    logger.info(`Webhook verified. Event type: ${req.body.event}`);
    
    // EXTRACT UID FROM SUBSCRIPTION PAYLOAD
    let userId = null;
    if (req.body.payload && req.body.payload.subscription && req.body.payload.subscription.entity) {
        userId = req.body.payload.subscription.entity.notes.firebase_user_id;
    }

    if (!userId) {
        logger.error("Webhook received but no firebase_user_id found in notes.");
        return res.status(200).send('Webhook processed but unlinked.');
    }

    const db = admin.firestore();
    const userRef = db.collection("users").doc(userId);

    try {
        // UPGRADE LOGIC
        if (req.body.event === 'subscription.authenticated' || req.body.event === 'subscription.charged') {
            await userRef.set({ tier: "premium" }, { merge: true });
            logger.info(`Auto-Pay Success: User ${userId} upgraded/renewed to premium.`);
        } 
        // DOWNGRADE LOGIC
        else if (req.body.event === 'subscription.halted' || req.body.event === 'subscription.cancelled') {
            await userRef.set({ tier: "free" }, { merge: true });
            logger.info(`Auto-Pay Failure/Cancel: User ${userId} downgraded to free.`);
        }
    } catch (error) {
        logger.error("Database update failed:", error);
    }

    res.status(200).send('Webhook processed.');
});

// --- Cleanup Function ---
exports.cleanupExpiredPresentations = onSchedule("every 60 minutes", async (event) => {
    logger.info("Starting cleanup of expired presentations.");
    const now = new Date();
    const db = admin.firestore();
    const storage = admin.storage();
    const query = db.collection("presentations").where("expiresAt", "<=", now);
    const expiredDocsSnapshot = await query.get();

    if (expiredDocsSnapshot.empty) return null;

    const promises = [];
    expiredDocsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.fileUrl) {
            try {
                const url = new URL(data.fileUrl);
                const filePath = decodeURIComponent(url.pathname.split("/o/")[1]);
                const file = storage.bucket().file(filePath);
                promises.push(file.delete().catch(e => logger.error(e)));
            } catch (error) {}
        }
        promises.push(doc.ref.delete());
    });
    await Promise.all(promises);
    return null;
});