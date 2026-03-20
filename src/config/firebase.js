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
        return true;
    }

    // FCM data values MUST all be strings
    const stringData = Object.fromEntries(
        Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])
    );

    // NOTE: Do not pass vibrateTimingsMillis here.
    // Some environments/SDK combinations may reject array payloads.
    // Vibration behavior is controlled by Android notification channel on client.
    const primaryMessage = {
        token,
        notification: { title, body },
        data: stringData,
        android: {
            priority: 'high',
            ttl: 60 * 60 * 24,
            collapseKey: 'heartbeat_ping',
            directBootOk: true,
            notification: {
                channelId: 'heartbeat_channel',
                sound: 'default',
                priority: 'high',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
        },
        apns: {
            headers: {
                'apns-priority': '10',
                'apns-push-type': 'alert',
                'apns-expiration': `${Math.floor(Date.now() / 1000) + (60 * 60 * 24)}`,
            },
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1,
                    contentAvailable: true,
                },
            },
        },
    };

    try {
        await admin.messaging().send(primaryMessage);
        return true;
    } catch (err) {
        logger.error(`[FCM] primary send failed: code=${err.code || 'unknown'} message=${err.message}`);
    }

    // Fallback payload (minimal) to maximize deliverability.
    try {
        const fallbackMessage = {
            token,
            notification: { title, body },
            data: stringData,
        };
        await admin.messaging().send(fallbackMessage);
        logger.warn('[FCM] Sent using fallback payload');
        return true;
    } catch (err) {
        logger.error(`[FCM] fallback send failed: code=${err.code || 'unknown'} message=${err.message}`);
        return false;
    }
}

module.exports = { initFirebase, verifyIdToken, sendPushNotification };
