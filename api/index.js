// api/index.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

// Загружаем переменные окружения из .env (для локальной разработки)
dotenv.config();

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Ограничиваем размер тела запроса

// --- Инициализация Firebase Admin SDK ---
let isInitialized = false;

function initializeFirebase() {
    if (isInitialized) return;

    try {
        // Пытаемся получить учетные данные из переменной окружения Vercel
        const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

        if (serviceAccountRaw) {
            console.log("Initializing Firebase with Vercel environment variable...");
            const serviceAccount = JSON.parse(serviceAccountRaw);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
        } else {
            // Если переменной нет, Firebase попытается использовать Application Default Credentials
            // Это может работать в некоторых средах GCP, но не гарантируется на Vercel.
            console.warn("FIREBASE_SERVICE_ACCOUNT_KEY not found in environment variables. Initializing with default credentials (might fail on Vercel).");
            admin.initializeApp();
        }
        isInitialized = true;
        console.log("Firebase Admin SDK initialized successfully.");
    } catch (error) {
        console.error("Failed to initialize Firebase Admin SDK:", error.message);
        // Не завершаем процесс, возможно, позже понадобится повторная инициализация
        // или сервер будет работать без FCM.
    }
}

initializeFirebase();

// --- Вспомогательная функция для проверки токена доступа ---
// Firebase Admin SDK сам управляет OAuth2 токеном, нам не нужно делать это вручную.
// Эта функция показана для примера, если бы мы использовали HTTP API напрямую.
/*
async function getAccessToken() {
    // В реальности Firebase Admin SDK делает это за нас.
    // Этот код не используется напрямую в текущей реализации.
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set');

    const serviceAccount = JSON.parse(serviceAccountRaw);
    // ... (логика получения токена через google-auth-library)
}
*/

// --- Маршрут для проверки состояния сервера ---
app.get('/', (req, res) => {
    res.status(200).json({
        message: 'Setka FCM Call Server is running!',
        timestamp: new Date().toISOString(),
        firebase_initialized: isInitialized
    });
});

// --- Маршрут для отправки уведомлений о звонках ---
app.post('/api/send-call', async (req, res) => {
    console.log('Received /api/send-call request:', req.body);

    // 1. Базовая валидация входящих данных
    const { targetUserId, channelName, callerId, isVideoCall } = req.body;

    if (!targetUserId || !channelName || !callerId) {
        console.error('Validation failed: Missing required fields');
        return res.status(400).json({
            error: 'Missing required fields: targetUserId, channelName, callerId'
        });
    }

    // Убедимся, что Firebase инициализирован
    if (!isInitialized) {
        console.error('Firebase Admin SDK is not initialized');
        return res.status(500).json({
            error: 'Server not ready: Firebase Admin SDK initialization failed'
        });
    }

    try {
        // 2. Получаем FCM токен целевого пользователя из Firestore
        console.log(`Fetching FCM token for user: ${targetUserId}`);
        const userDoc = await admin.firestore().collection('users').doc(targetUserId).get();

        if (!userDoc.exists) {
            console.warn(`User not found: ${targetUserId}`);
            return res.status(404).json({ error: 'Target user not found' });
        }

        const userData = userDoc.data();
        const fcmToken = userData.fcmToken;

        if (!fcmToken) {
            console.warn(`User ${targetUserId} has no FCM token`);
            return res.status(400).json({ error: 'Target user has no FCM token' });
        }

        console.log(`FCM token retrieved for user ${targetUserId}`);

        // 3. Формируем сообщение FCM
        const message = {
            token: fcmToken,
             {
                type: 'call',
                channel_name: channelName,
                caller_id: callerId,
                is_video: isVideoCall ? 'true' : 'false',
                timestamp: Date.now().toString()
            },
            notification: {
                title: 'Входящий звонок',
                body: isVideoCall ? 'Видеовызов' : 'Аудиовызов'
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'calls', // Убедитесь, что канал создан в Android-приложении
                    // sound: 'default' // Можно добавить звук
                }
            },
            apns: {
                payload: {
                    aps: {
                        'content-available': 1, // Для фоновой доставки на iOS
                        'mutable-content': 1
                    }
                }
            }
            // webpush настраивается отдельно, если нужно
        };

        console.log(`Sending FCM message to token: ${fcmToken.substring(0, 20)}...`);

        // 4. Отправляем сообщение через Firebase Admin SDK (использует FCM V1 API)
        const response = await admin.messaging().send(message);
        console.log('FCM message sent successfully:', response);

        // 5. Отправляем успешный ответ
        res.status(200).json({
            success: true,
            messageId: response,
            details: 'Call notification sent via FCM V1'
        });

    } catch (error) {
        console.error('Error in /api/send-call:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message || 'Unknown error occurred while sending call notification'
        });
    }
});

// --- Обработка несуществующих маршрутов ---
app.all('*', (req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.url}` });
});

// Экспортируем приложение для Vercel
module.exports = app;

// Для локальной разработки с `node api/index.js`
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📝 POST endpoint: http://localhost:${PORT}/api/send-call`);
    });
}
