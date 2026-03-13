const admin = require('firebase-admin');
const logger = require('./logger');

let initialized = false;
let devMode = false;   // true when Firebase is unavailable (dev without real credentials)

function initFirebase() {
    if (initialized) return;

    const isDev = process.env.NODE_ENV !== 'production';
    const pk = process.env.FIREBASE_PRIVATE_KEY ?? '';
    const isPlaceholder = pk.includes('PLACEHOLDER') || pk.trim() === '';

    if (isDev && isPlaceholder) {
        devMode = true;
        initialized = true;
        logger.warn('⚠️  Firebase: using DEV stub (no real credentials). '
            + 'Auth verification is DISABLED – do NOT use in production.');
        return;
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: pk.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
    });

    initialized = true;
    logger.info('✅ Firebase Admin SDK initialized');
}

async function verifyIdToken(token) {
    if (devMode) {
        // Dev stub: accept any token starting with 'dev_' as a uid
        if (token?.startsWith('dev_')) {
            return { uid: token.slice(4), email: `${token.slice(4)}@dev.local` };
        }
        throw Object.assign(new Error('DEV mode: pass "dev_<uid>" as Bearer token'), { code: 'auth/dev-mode' });
    }
    return admin.auth().verifyIdToken(token);
}

async function sendPushNotification({ token, title, body, data }) {
    if (devMode) {
        logger.debug(`[FCM stub] → token=${token} title="${title}" body="${body}"`);
        return;
    }
    try {
        // FCM data values MUST all be strings
        const stringData = Object.fromEntries(
            Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])
        );

        const message = {
            token,
            notification: { title, body },
            data: stringData,
            android: {
                priority: 'high',
                notification: {
                    channelId: 'heartbeat_channel',
                    sound: 'default',
                    priority: 'high',
                    defaultVibrateTimings: false,
                    vibrateTimingsMillis: [0, 400, 200, 400, 200, 800],
                    defaultLightSettings: false,
                    lightSettings: {
                        color: { red: 1.0, green: 0.42, blue: 0.62, alpha: 1.0 },
                        lightOnDurationMillis: 500,
                        lightOffDurationMillis: 500,
                    },
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                },
            },
            apns: {
                headers: { 'apns-priority': '10' },
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                        contentAvailable: true,
                    },
                },
            },
        };
        await admin.messaging().send(message);
    } catch (err) {
        logger.error('Push notification error:', err);
    }
}

module.exports = { initFirebase, verifyIdToken, sendPushNotification };
