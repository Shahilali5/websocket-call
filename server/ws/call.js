const { online, inCall, calls } = require('./state');
const { send, sendTo } = require('./sender');
const db = require('../db');
const { sendPushNotification } = require('../services/push');

async function isBlocked(owner, other) {
  try {
    const [r] = await db.query('SELECT 1 FROM blocks WHERE owner_number = ? AND blocked_number = ?', [owner, other]);
    return r.length > 0;
  } catch (err) {
    console.error('[Call] Block check error:', err);
    return false;
  }
}

exports.handleCall = async (ws, m) => {
  const me = ws.number;

  switch (m.type) {
    case 'call.invite': {
      const { to, callId, video } = m;
      const err = (code) => send(ws, { type: 'call.error', callId, code });

      if (!/^[1-9]\d{9}$/.test(to)) return err('NOT_FOUND');
      if (to === me) return err('SELF');

      try {
        const [u] = await db.query('SELECT name, avatar, is_banned FROM users WHERE number = ?', [to]);
        if (!u.length || u[0].is_banned) return err('NOT_FOUND');
        if (await isBlocked(to, me)) return err('BLOCKED');

        const isOnline = online.has(to);
        const [subs] = await db.query('SELECT 1 FROM push_subscriptions WHERE user_number = ?', [to]);
        const hasPush = subs && subs.length > 0;

        if (!isOnline && !hasPush) return err('OFFLINE');
        if (inCall.has(to) || inCall.has(me)) return err('BUSY');

        const [myUser] = await db.query('SELECT name, avatar FROM users WHERE number = ?', [me]);
        const callerName = myUser.length ? myUser[0].name : 'Guest';
        const callerAvatar = myUser.length ? myUser[0].avatar : null;
        const recipientName = u[0].name || 'Guest';
        const recipientAvatar = u[0].avatar || null;

        const call = {
          callId,
          from: me,
          to,
          video: !!video,
          callerName,
          callerAvatar,
          recipientName,
          recipientAvatar,
          state: 'ringing',
          startedAt: Date.now()
        };

        call.timer = setTimeout(() => endCall(callId, 'timeout', 'missed'), 40000);
        calls.set(callId, call);
        inCall.set(me, callId);
        inCall.set(to, callId);

        send(ws, { type: 'call.ringing', callId, pushSent: hasPush });

        if (isOnline) {
          sendTo(to, {
            type: 'call.incoming',
            callId,
            from: me,
            name: callerName,
            avatar: callerAvatar,
            video: !!video
          });
        }

        // Send high-priority Web Push Notification for background/lockscreen ringing
        sendPushNotification(to, {
          type: 'incoming_call',
          callId,
          from: me,
          callerName,
          callerAvatar,
          video: !!video
        }, { urgency: 'high', TTL: 40 });

      } catch (e) {
        console.error('[Call.invite] DB Error:', e);
        return err('SERVER');
      }
      break;
    }

    case 'call.accept': {
      const c = calls.get(m.callId);
      if (!c || c.to !== me) return;
      clearTimeout(c.timer);
      c.state = 'connecting';
      c.answeredAt = Date.now();
      sendTo(c.from, { type: 'call.accepted', callId: c.callId });
      break;
    }

    case 'call.reject': {
      const c = calls.get(m.callId);
      if (!c || c.to !== me) return;
      sendTo(c.from, { type: 'call.rejected', callId: c.callId });
      endCall(c.callId, 'rejected', 'rejected', true);
      break;
    }

    case 'call.cancel': {
      const c = calls.get(m.callId);
      if (!c || c.from !== me) return;
      sendTo(c.to, { type: 'call.cancelled', callId: c.callId });
      endCall(c.callId, 'cancelled', 'cancelled', true);
      break;
    }

    case 'call.end': {
      const c = calls.get(m.callId);
      if (!c || (c.from !== me && c.to !== me)) return;
      const other = c.from === me ? c.to : c.from;
      sendTo(other, { type: 'call.ended', callId: c.callId, reason: 'hangup' });
      endCall(c.callId, 'hangup', 'completed', true);
      break;
    }

    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice':
    case 'call.state': {
      const c = calls.get(m.callId);
      if (!c) return;
      if (c.from !== me && c.to !== me) return; // participant validation
      const recipient = c.from === me ? c.to : c.from;
      sendTo(recipient, m); // relay as-is
      break;
    }
  }
};

async function endCall(callId, reason, status, silent = false) {
  const c = calls.get(callId);
  if (!c) return;
  clearTimeout(c.timer);

  calls.delete(callId);
  inCall.delete(c.from);
  inCall.delete(c.to);

  // Clear background push notification on callee's device
  sendPushNotification(c.to, {
    type: 'call_cancelled',
    callId
  }, { urgency: 'high', TTL: 10 }).catch(() => {});

  if (!silent) {
    sendTo(c.from, { type: 'call.timeout', callId });
    sendTo(c.to, { type: 'call.timeout', callId });
  }

  const duration = c.answeredAt ? Math.round((Date.now() - c.answeredAt) / 1000) : 0;
  const startedEpoch = Math.floor(c.startedAt / 1000);
  const answeredEpoch = c.answeredAt ? Math.floor(c.answeredAt / 1000) : null;

  try {
    await db.query(
      `INSERT INTO calls (id, from_number, to_number, is_video, status, started_at, answered_at, ended_at, duration_sec)
       VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?), ${answeredEpoch ? 'FROM_UNIXTIME(?)' : 'NULL'}, NOW(), ?)`,
      answeredEpoch
        ? [callId, c.from, c.to, c.video ? 1 : 0, status, startedEpoch, answeredEpoch, duration]
        : [callId, c.from, c.to, c.video ? 1 : 0, status, startedEpoch, duration]
    );
  } catch (err) {
    console.error('[endCall] Failed to log call history:', err.message);
  }
}
exports.endCall = endCall;

exports.cleanupUser = (number) => {
  const id = inCall.get(number);
  if (!id) return;
  const c = calls.get(id);
  if (!c) return;

  const other = c.from === number ? c.to : c.from;
  sendTo(other, { type: 'call.ended', callId: id, reason: 'network' });
  endCall(id, 'network', c.answeredAt ? 'completed' : 'failed', true);
};
