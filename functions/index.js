const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ 
    origin: [
        "http://127.0.0.1:5500",
        "https://slidechangeronline.me", 
        "https://www.slidechangeronline.me", 
        "https://slidechangeronline.web.app", 
        "https://slidechangeronline.firebaseapp.com"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// --- Middleware: Auth Security ---
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

// --- Razorpay Initialization ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_live_KksSstXGAnpZpT";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET; // Set this in GCP Secrets/Env

const razorpayInstance = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
});
// --- Endpoint: Health Check ---
app.get("/", (req, res) => {
    res.status(200).send({ 
        status: "online", 
        service: "SlideChanger Payment API",
        timestamp: new Date().toISOString()
    });
});
// --- Endpoint: Create Subscription (Handles Premium, Ads, and Coupons) ---
app.post("/createRazorpaySubscription", checkAuth, async (req, res) => {
    const { planId, couponCode, subscriptionType } = req.body; // subscriptionType: 'premium' or 'ad'
    let activePlanId = planId;

    try {
        // 1. DYNAMIC COUPON VALIDATION
        if (couponCode) {
            const couponDoc = await db.collection("coupons").doc(couponCode.toUpperCase()).get();
            if (couponDoc.exists && couponDoc.data().active) {
                // If coupon is valid, we use the Promo Plan ID stored in Firestore
                activePlanId = couponDoc.data().promoPlanId;
                logger.info(`Coupon Applied: ${couponCode} -> Switching to Plan: ${activePlanId}`);
            } else {
                return res.status(400).send({ error: "Invalid or expired coupon code." });
            }
        }

        // 2. PREPARE RAZORPAY OPTIONS
        const options = {
            plan_id: activePlanId,
            total_count: 120, // 10 Years max
            customer_notify: 1,
            notes: {
                firebase_user_id: req.user.uid,
                subscription_type: subscriptionType || "premium" // Critical for Webhook routing
            }
        };

        const subscription = await razorpayInstance.subscriptions.create(options);
        logger.info(`Subscription Created [${subscriptionType}]:`, subscription.id);
        res.status(200).send({ subscriptionId: subscription.id });
    } catch (error) {
        logger.error("Error creating subscription:", error);
        res.status(500).send({ error: "Subscription creation failed." });
    }
});

exports.api = onRequest({ region: "us-central1" }, app);

// --- Webhook: Handle Payment Success/Failure/Cancel ---
exports.razorpayWebhook = onRequest(async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "S@mpreethl4E143143"; 
    const signature = req.headers['x-razorpay-signature'];

    const expectedSignature = crypto.createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

    if (expectedSignature !== signature) {
        return res.status(400).send('Invalid signature.');
    }

    const payload = req.body.payload.subscription.entity;
    const userId = payload.notes.firebase_user_id;
    const type = payload.notes.subscription_type;
    const subId = payload.id;

    try {
        // ROUTE A: PREMIUM ACCOUNT UPDATES
        if (type === "premium") {
            const userRef = db.collection("users").doc(userId);
            if (req.body.event.includes('authenticated') || req.body.event.includes('charged')) {
                await userRef.set({ tier: "premium" }, { merge: true });
            } else if (req.body.event.includes('halted') || req.body.event.includes('cancelled')) {
                await userRef.set({ tier: "free" }, { merge: true });
            }
        } 
        
        // ROUTE B: AD NETWORK UPDATES
        else if (type === "ad") {
            // Find the ad document linked to this subscription ID
            const adQuery = await db.collection("ads").where("subscriptionId", "==", subId).limit(1).get();
            if (!adQuery.empty) {
                const adRef = adQuery.docs[0].ref;
                if (req.body.event.includes('authenticated') || req.body.event.includes('charged')) {
                    // Note: We don't force 'active' here because Admin must still approve the banner
                    // We just log that it's paid.
                    logger.info(`Ad Paid: ${subId}`);
                } else if (req.body.event.includes('halted') || req.body.event.includes('cancelled')) {
                    await adRef.set({ status: "halted" }, { merge: true });
                    logger.info(`Ad Halted: ${subId}`);
                }
            }
        }
    } catch (error) {
        logger.error("Webhook processing error:", error);
    }

    res.status(200).send('OK');
});

// --- Scheduled Cleanup ---
exports.cleanupExpiredPresentations = onSchedule("every 60 minutes", async (event) => {
    const now = new Date();
    const storage = admin.storage();
    const expiredDocsSnapshot = await db.collection("presentations").where("expiresAt", "<=", now).get();

    if (expiredDocsSnapshot.empty) return null;

    const promises = [];
    expiredDocsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.fileUrl) {
            try {
                const url = new URL(data.fileUrl);
                const filePath = decodeURIComponent(url.pathname.split("/o/")[1]);
                promises.push(storage.bucket().file(filePath).delete().catch(() => {}));
            } catch (e) {}
        }
        promises.push(doc.ref.delete());
    });
    await Promise.all(promises);
    return null;
});