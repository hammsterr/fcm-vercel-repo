// api/index.js
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

// Загружаем переменные окружения из .env (для локальной разработки)
dotenv.config();

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Health check endpoint ---
app.get('/', (req, res) => {
    res.status(200).json({
        message: 'Setka FCM Call Server is running!',
        timestamp: new Date().toISOString(),
        node_version: process.version,
        // Проверяем, инициализирован ли Firebase
        firebase_initialized: admin.apps.length > 0 && admin.apps[0]?.name === '[DEFAULT]'
    });
});

// --- Lazy Firebase Initialization ---
// Инициализируем Firebase только при первом запросе или при необходимости
let firebaseReady = false;
let firebaseError = null;

function initializeFirebase() {
    if (firebaseReady) return Promise.resolve();
    if (firebaseError) return Promise.reject(firebaseError);

    try {
        // Пытаемся получить учетные данные из переменной окружения Vercel
        const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

        if (serviceAccountRaw) {
            console.log("🔧 Initializing Firebase with Vercel environment variable...");
            const serviceAccount = JSON.parse(serviceAccountRaw);
            
            // Проверка, не инициализирован ли уже Firebase
            if (admin.apps.length === 0) {
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                });
            } else {
                console.log("⚠️  Firebase app already exists.");
            }
        } else {
            console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT_KEY not found. Attempting default initialization...");
            // Попытка инициализации с дефолтными кредами (может не сработать на Vercel)
            if (admin.apps.length === 0) {
                admin.initializeApp(); // Будет использовать Application Default Credentials
            }
        }
        firebaseReady = true;
        console.log("✅ Firebase Admin SDK initialized successfully.");
        return Promise.resolve();
    } catch (error) {
        console.error("❌ Failed to initialize Firebase Admin SDK:", error.message);
        firebaseError = error;
        return Promise.reject(error);
    }
}

// --- Utility: Validate request body ---
function validateCallRequest(body) {
    const { targetUserId, channelName, callerId } = body;
    
    const errors = [];
    if (!targetUserId || typeof targetUserId !== 'string') {
        errors.push('targetUserId is required and must be a string');
    }
    if (!channelName || typeof channelName !== 'string') {
        errors.push('channelName is required and must be a string');
    }
    if (!callerId || typeof callerId !== 'string') {
        errors.push('callerId is required and must be a string');
    }
    
    return errors;
}

// --- Main Endpoint: Send Call Notification ---
app.post('/api/send-call', async (req, res) => {
    console.log('📞 Received /api/send-call request');
    
    // 1. Validate Content-Type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
        console.warn(`.Unsupported Media Type: ${contentType}`);
        return res.status(415).json({
            error: 'Unsupported Media Type',
            message: 'Content-Type must be application/json'
        });
    }

    // 2. Validate request body
    const errors = validateCallRequest(req.body);
    if (errors.length > 0) {
        console.error('Validation failed:', errors);
        return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid request body',
            details: errors
        });
    }

    const { targetUserId, channelName, callerId, isVideoCall = false } = req.body;
    console.log(`➡️  Processing call from ${callerId} to ${targetUserId} (${isVideoCall ? 'video' : 'audio'}) on channel ${channelName}`);

    // 3. Initialize Firebase (lazy)
    try {
        await initializeFirebase();
    } catch (initError) {
        console.error("Firebase initialization error:", initError);
        return res.status(500).json({
            error: 'Server Configuration Error',
            message: 'Server not ready: Firebase Admin SDK initialization failed',
        });
    }

    // 4. Fetch target user's FCM token from Firestore
    let fcmToken;
    try {
        console.log(`🔍 Fetching FCM token for user: ${targetUserId}`);
        const userDoc = await admin.firestore().collection('users').doc(targetUserId).get();

        if (!userDoc.exists) {
            console.warn(`User not found: ${targetUserId}`);
            return res.status(404).json({ error: 'Target user not found' });
        }

        const userData = userDoc.data();
        fcmToken = userData.fcmToken;

        if (!fcmToken) {
            console.warn(`User ${targetUserId} has no FCM token`);
            return res.status(400).json({ error: 'Target user has no FCM token or is not registered for push notifications' });
        }
        console.log(`📱 FCM token retrieved for user ${targetUserId.substring(0, 10)}...`);
    } catch (fetchError) {
        console.error('Error fetching user data:', fetchError);
        return res.status(500).json({
            error: 'Database Error',
            message: 'Failed to retrieve user information'
        });
    }

    // 5. Construct FCM message payload according to FCM HTTP v1 API
    // ВАЖНО: Добавляем и `notification` и `data` поля для работы в фоне и на переднем плане
    const message = {
        token: fcmToken,
        data: { // Data payload для обработки в приложении
            type: 'call',
            channel_name: channelName,
            caller_id: callerId,
            is_video: isVideoCall.toString(),
            timestamp: Date.now().toString()
        },
        notification: { // Notification payload для системного уведомления
            title: 'Входящий звонок',
            body: isVideoCall ? 'Видеовызов' : 'Аудиовызов'
        },
        android: {
            priority: 'high',
            notification: {
                channelId: 'calls', // Должен быть создан в Android-приложении
                sound: 'default',   // Звук уведомления
                // icon: 'ic_call'   // Можно добавить иконку (drawable/ic_call)
            }
        },
        apns: { // Для iOS
            payload: {
                aps: {
                    'content-available': 1, // Background notification
                    'mutable-content': 1,
                    alert: {
                        title: 'Входящий звонок',
                        body: isVideoCall ? 'Видеовызов' : 'Аудиовызов'
                    }
                }
            }
        }
        // webpush configuration would go here if needed
    };

    console.log(`📤 Sending FCM message...`);

    // 6. Send message using Firebase Admin SDK (uses FCM HTTP v1 API internally)
    try {
        const response = await admin.messaging().send(message);
        console.log('✅ FCM message sent successfully:', response);

        res.status(200).json({
            success: true,
            messageId: response,
            details: 'Call notification sent via FCM HTTP v1 API'
        });
    } catch (sendError) {
        console.error('❌ Error sending FCM message:', sendError);
        // Provide more specific error messages based on FCM error codes if needed
        if (sendError.code === 'messaging/invalid-registration-token' ||
            sendError.code === 'messaging/registration-token-not-registered') {
             res.status(400).json({
                error: 'Invalid Token',
                message: 'The provided FCM token is invalid or not registered. The user may have uninstalled the app.'
            });
        } else {
            res.status(503).json({
                error: 'Notification Service Error',
                message: 'Failed to send notification via FCM. Please try again later.',
            });
        }
    }
});

// --- 404 handler for undefined routes ---
app.all('*', (req, res) => {
    console.warn(`_route_not_found: ${req.method} ${req.url}`);
    res.status(404).json({
        error: 'Not Found',
        message: `The requested resource '${req.method} ${req.url}' was not found on this server.`,
        code: 'ROUTE_NOT_FOUND'
    });
});

// --- Global error handler middleware ---
app.use((err, req, res, next) => {
    console.error('Unhandled error caught by global middleware:', err);
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred on the server.'
        });
    } else {
        next(err);
    }
});

// --- Export for Vercel Serverless Functions ---
export default app;

// --- For local development with `node api/index.js` ---
if (import.meta.url === `file://${process.argv[1]}`) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server (Node.js ${process.version}) running locally on http://localhost:${PORT}`);
        console.log(`📝 POST endpoint: http://localhost:${PORT}/api/send-call`);
        console.log(`📊 Health check: http://localhost:${PORT}/`);
    });
}
