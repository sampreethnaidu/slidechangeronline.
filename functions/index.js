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

    // *** THIS IS THE ONLY CHANGE AND THE FIX ***
    const options = {
        amount: 2900, // 29 INR in paise
        currency: "INR",
        receipt: `receipt_${req.user.uid}`, // Shortened to be under 40 characters
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

app.post("/verifyRazorpayPayment", checkAuth, async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body.data;
    const userId = req.user.uid;
    const key_secret = "wcNsU5F5ly98RpTAtXgXnl1h"; // Ensure this matches your Razorpay secret

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac("sha256", key_secret).update(body.toString()).digest("hex");

    if (expectedSignature === razorpay_signature) {
        logger.info(`Payment verified for user: ${userId}`);
        const db = admin.firestore();
        const userRef = db.collection("users").doc(userId);
        await userRef.update({ accountTier: "premium" });
        
        logger.info(`User ${userId} successfully upgraded to premium.`);
        res.status(200).send({ data: { status: "success" } });
    } else {
        logger.error(`Payment verification failed for user: ${userId}`);
        res.status(400).send({ error: "Payment verification failed." });
    }
});

exports.api = onRequest({ region: "us-central1" }, app);

exports.cleanupExpiredPresentations = onSchedule("every 60 minutes", async (event) => {
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

