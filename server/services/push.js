const fs = require('fs');
const path = require('path');
const db = require('../db');

let webpush = null;
try {
  webpush = require('web-push');
} catch (e) {
  console.warn('[PUSH] Optional web-push package not yet installed. Push notifications will be simulated.');
}

const vapidFile = path.join(__dirname, '../../vapid.json');
let vapidKeys = null;

// Initialize or load VAPID keys
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  };
} else if (fs.existsSync(vapidFile)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
  } catch {}
}

if (!vapidKeys && webpush) {
  try {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(vapidFile, JSON.stringify(vapidKeys, null, 2), 'utf8');
    console.log('[PUSH] Generated new VAPID keys and saved to vapid.json');
  } catch (err) {
    console.warn('[PUSH] Could not generate VAPID keys:', err.message);
  }
}

if (webpush && vapidKeys && vapidKeys.publicKey && vapidKeys.privateKey) {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:admin@vcall.local',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
    console.log('[PUSH] Web Push initialized with VAPID credentials.');
  } catch (err) {
    console.warn('[PUSH] setVapidDetails failed:', err.message);
  }
}

/**
 * Returns VAPID public key for frontend subscription
 */
function getVapidPublicKey() {
  return vapidKeys ? vapidKeys.publicKey : null;
}

/**
 * Sends Web Push Notification to a user's registered devices
 */
async function sendPushNotification(userNumber, payload, options = {}) {
  if (!webpush || !vapidKeys) {
    return { ok: false, count: 0, reason: 'PUSH_UNAVAILABLE' };
  }

  try {
    const [subs] = await db.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_number = ?',
      [userNumber]
    );

    if (!subs || subs.length === 0) {
      return { ok: false, count: 0, reason: 'NO_SUBSCRIPTIONS' };
    }

    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const pushOptions = {
      urgency: options.urgency || 'high',
      TTL: options.TTL !== undefined ? options.TTL : 40,
      headers: options.headers || {}
    };

    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        const pushSubscription = {
          endpoint: s.endpoint,
          keys: {
            p256dh: s.p256dh,
            auth: s.auth
          }
        };

        try {
          await webpush.sendNotification(pushSubscription, payloadString, pushOptions);
          sent++;
        } catch (err) {
          // If subscription expired or was unregistered by browser, delete it
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`[PUSH] Pruning expired subscription for ${userNumber}:`, s.endpoint.slice(0, 35));
            await db.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]).catch(() => {});
          } else {
            console.warn('[PUSH] Failed delivery:', err.statusCode, err.message);
          }
        }
      })
    );

    return { ok: true, count: sent };
  } catch (err) {
    console.error('[PUSH] sendPushNotification error:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getVapidPublicKey,
  sendPushNotification
};
