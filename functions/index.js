// The Cloud Functions for Firebase SDK
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

// The Firebase Admin SDK to access Firestore.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

// NEW: Import Razorpay and crypto for verification
const Razorpay = require("razorpay");
const crypto = require("crypto");

initializeApp();

// --- Function 1: Cleanup Expired Presentations (Existing Function) ---
exports.cleanupExpiredPresentations = onSchedule("every 60 minutes", async (event) => {
    // This function's code remains unchanged.
    logger.info("Starting cleanup of expired presentations.");
    const now = new Date();
    const db = getFirestore();
    const storage = getStorage();
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


// --- NEW Function 2: Create a Razorpay Payment Order ---
exports.createRazorpayOrder = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to subscribe.");
    }

    // IMPORTANT: Replace with your actual Razorpay Keys from your dashboard
    const instance = new Razorpay({
        key_id: "rzp_live_ROgTLJRTGurfqx",
        key_secret: "wcNsU5F5ly98RpTAtXgXnl1h",
    });

    const options = {
        amount: 2900, // Amount in the smallest currency unit (29 * 100 paise)
        currency: "INR",
        receipt: `receipt_user_${request.auth.uid}_${Date.now()}`,
    };

    try {
        const order = await instance.orders.create(options);
        logger.info("Razorpay order created:", order.id);
        return { orderId: order.id };
    } catch (error) {
        logger.error("Error creating Razorpay order:", error);
        throw new HttpsError("internal", "Could not create a payment order.");
    }
});


// --- NEW Function 3: Verify Razorpay Payment and Fulfill Subscription ---
exports.verifyRazorpayPayment = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
    } = request.data;
    const userId = request.auth.uid;
    const key_secret = "wcNsU5F5ly98RpTAtXgXnl1h"; // IMPORTANT: Use the same Key Secret as above

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
        .createHmac("sha256", key_secret)
        .update(body.toString())
        .digest("hex");

    if (expectedSignature === razorpay_signature) {
        logger.info(`Payment verified for user: ${userId}`);
        const db = getFirestore();
        const userRef = db.collection("users").doc(userId);
        
        await userRef.update({
            accountTier: "premium",
        });

        logger.info(`User ${userId} successfully upgraded to premium.`);
        return { status: "success" };
    } else {
        logger.error(`Payment verification failed for user: ${userId}`);
        throw new HttpsError("invalid-argument", "Payment verification failed.");
    }
});

