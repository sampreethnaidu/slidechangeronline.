const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

const Razorpay = require("razorpay");
const crypto = require("crypto");

admin.initializeApp();

// --- Main API App for creating orders ---
const app = express();
app.use(cors({ origin: ["https://www.slidechangeronline.me", "https://slidechangeronline.me"] }));

const checkAuth = async (req, res, next) => {
    const tokenId = req.get("Authorization")?.split("Bearer ")[1];
    if (!tokenId) {
        return res.status(401).send({ error: "Unauthorized: No token provided." });
    }
    try {
        const decodedToken = await admin.auth().verifyIdToken(tokenId);
        req.user = decodedToken;
        next();
    } catch (error) {
        logger.error("Auth error:", error);
        return res.status(401).send({ error: "Unauthorized: Invalid token." });
    }
};

app.post("/createRazorpayOrder", checkAuth, async (req, res) => {
    const instance = new Razorpay({
        key_id: "rzp_live_ROgTLJRTGurfqx",
        key_secret: "wcNsU5F5ly98RpTAtXgXnl1h",
    });

    const options = {
        amount: 2900,
        currency: "INR",
        receipt: `receipt_${req.user.uid}`,
        // UPDATED: We now add the user's ID to the notes for the webhook to find.
        notes: {
            firebase_user_id: req.user.uid
        }
    };

    try {
        const order = await instance.orders.create(options);
        logger.info("Razorpay order created:", order.id);
        res.status(200).send({ data: { orderId: order.id } });
    } catch (error) {
        logger.error("Error creating Razorpay order:", error);
        res.status(500).send({ error: "Could not create a payment order." });
    }
});

// The /verifyRazorpayPayment route has been removed as it's no longer needed.

exports.api = onRequest({ region: "us-central1" }, app);


// --- NEW, SEPARATE Webhook Function for payment confirmation ---
exports.razorpayWebhook = onRequest(async (req, res) => {
    const secret = "S@mpreethl4E143143"; // IMPORTANT: You will create this in the Razorpay Dashboard.

    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest === req.headers['x-razorpay-signature']) {
        logger.info('Payment signature verified.');
        
        // Check for the "payment.captured" event
        if (req.body.event === 'payment.captured') {
            const payment = req.body.payload.payment.entity;
            const order = req.body.payload.order.entity;
            const userId = order.notes.firebase_user_id;

            if (userId) {
                logger.info(`Payment successful for user: ${userId}`);
                const db = admin.firestore();
                const userRef = db.collection("users").doc(userId);
                
                await userRef.update({ accountTier: "premium" });
                logger.info(`User ${userId} successfully upgraded to premium.`);
            } else {
                logger.error("Webhook received but no firebase_user_id found in order notes.");
            }
        }
        res.status(200).send('Webhook processed.');
    } else {
        logger.error('Webhook signature verification failed.');
        res.status(400).send('Invalid signature.');
    }
});


// --- Cleanup Function (Remains the same) ---
exports.cleanupExpiredPresentations = onSchedule("every 60 minutes", async (event) => {
    // ... This function's code is unchanged ...
    logger.info("Starting cleanup of expired presentations.");
    const now = new Date();
    const db = admin.firestore();
    const storage = admin.storage();
    const query = db.collection("presentations").where("expiresAt", "<=", now);
    const expiredDocsSnapshot = await query.get();

    if (expiredDocsSnapshot.empty) {
        logger.info("No expired presentations found.");
        return null;
    }
    const promises = [];
    expiredDocsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.fileUrl) {
            try {
                const url = new URL(data.fileUrl);
                const filePath = decodeURIComponent(url.pathname.split("/o/")[1]);
                const file = storage.bucket().file(filePath);
                promises.push(file.delete().then(() => logger.log("Deleted file:", filePath)));
            } catch (error) {
                logger.error("Error parsing or deleting file from URL:", data.fileUrl, error);
            }
        }
        promises.push(doc.ref.delete().then(() => logger.log("Deleted doc:", doc.id)));
    });
    await Promise.all(promises);
    logger.info(`Cleanup complete. Deleted ${expiredDocsSnapshot.size} expired sessions.`);
    return null;
});

