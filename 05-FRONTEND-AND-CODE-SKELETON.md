# 05 — Frontend, Folder Structure & Starter Code

## 1. Folder Structure

```
vcall/
├── package.json
├── .env                      # PORT, DB_*, TURN_SECRET, TURN_HOST
├── server/
│   ├── index.js              # Express + HTTP server + WS upgrade
│   ├── db.js                 # mysql2 pool
│   ├── routes/
│   │   ├── identity.js       # /api/identity, /login, /register
│   │   ├── me.js             # /me, /ice, /lookup
│   │   └── history.js        # /calls, /chats, /messages, /contacts, /block
│   ├── ws/
│   │   ├── hub.js            # online map, auth, heartbeat, dispatcher
│   │   ├── call.js           # call.* handlers + state machine
│   │   ├── chat.js           # chat.* handlers
│   │   └── presence.js
│   └── utils/
│       ├── number.js         # virtual number generator
│       ├── token.js          # token create/hash
│       └── rateLimit.js
└── public/
    ├── index.html            # single page app shell (Bootstrap 5)
    ├── css/app.css
    ├── js/
    │   ├── app.js            # boot: identity, init modules
    │   ├── api.js            # fetch wrapper
    │   ├── ws.js             # WebSocket client + reconnect + event emitter
    │   ├── dialpad.js
    │   ├── call.js           # WebRTC logic + call UI state
    │   ├── chat.js
    │   └── ui.js             # tabs, toasts, modals
    └── audio/ringtone.mp3, dialtone.mp3
```

## 2. Install

```bash
npm init -y
npm i express ws mysql2 dotenv helmet cors express-rate-limit uuid
```

## 3. Backend — server/index.js (minimal)

```js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const { attachHub } = require('./ws/hub');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', require('./routes/identity'));
app.use('/api', require('./routes/me'));
app.use('/api', require('./routes/history'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
attachHub(wss);

server.listen(process.env.PORT || 3000, () => console.log('VCall running'));
```

## 4. Backend — number + token (server/utils)

```js
// number.js
const crypto = require('crypto');
exports.generateNumber = () =>
  String(crypto.randomInt(1, 10)) + String(crypto.randomInt(0, 1e9)).padStart(9, '0');

// token.js
exports.newToken  = () => crypto.randomBytes(32).toString('hex');
exports.hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
```

## 5. Backend — routes/identity.js

```js
const router = require('express').Router();
const db = require('../db');
const { generateNumber } = require('../utils/number');
const { newToken, hashToken } = require('../utils/token');

router.post('/identity', async (req, res) => {
  for (let i = 0; i < 10; i++) {
    const number = generateNumber();
    const token = newToken();
    try {
      await db.query('INSERT INTO users (number, token_hash) VALUES (?, ?)',
                     [number, hashToken(token)]);
      return res.status(201).json({ number, token, name: 'Guest' });
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') return res.status(500).json({ error: 'SERVER' });
    }
  }
  res.status(500).json({ error: 'NUMBER_GENERATION_FAILED' });
});
module.exports = router;
```

## 6. Backend — ws/hub.js (core)

```js
const db = require('../db');
const { hashToken } = require('../utils/token');
const { handleCall } = require('./call');
const { handleChat } = require('./chat');

const online = new Map();   // number -> ws
const inCall = new Map();   // number -> callId
const calls  = new Map();   // callId -> call object
exports.state = { online, inCall, calls };

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
exports.send = send;
exports.sendTo = (number, obj) => { const w = online.get(number); if (w) send(w, obj); return !!w; };

exports.attachHub = (wss) => {
  wss.on('connection', (ws) => {
    ws.alive = true; ws.number = null;
    const authTimer = setTimeout(() => !ws.number && ws.close(), 5000);

    ws.on('pong', () => ws.alive = true);
    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }

      if (m.type === 'auth') {
        const [rows] = await db.query(
          'SELECT number,name,is_banned FROM users WHERE token_hash=?', [hashToken(m.token || '')]);
        if (!rows.length || rows[0].is_banned) return send(ws, { type: 'auth.error', code: 'INVALID_TOKEN' });
        clearTimeout(authTimer);
        const old = online.get(rows[0].number);
        if (old) { send(old, { type: 'session.replaced' }); old.close(); }
        ws.number = rows[0].number;
        online.set(ws.number, ws);
        send(ws, { type: 'auth.ok', number: ws.number, name: rows[0].name });
        // TODO: push undelivered messages, notify contacts "online"
        return;
      }
      if (!ws.number) return;                    // ignore everything until authed
      if (m.type === 'ping') return send(ws, { type: 'pong' });
      if (m.type.startsWith('call.') || m.type.startsWith('webrtc.')) return handleCall(ws, m);
      if (m.type.startsWith('chat.')) return handleChat(ws, m);
    });

    ws.on('close', () => {
      if (ws.number && online.get(ws.number) === ws) {
        online.delete(ws.number);
        require('./call').cleanupUser(ws.number);   // end active call if any
        // TODO: notify contacts "offline", update last_seen
      }
    });
  });

  setInterval(() => wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  }), 25000);
};
```

## 7. Backend — ws/call.js (signaling logic)

```js
const { state, send, sendTo } = require('./hub');
const db = require('../db');
const { online, inCall, calls } = state;

async function isBlocked(owner, other) {
  const [r] = await db.query('SELECT 1 FROM blocks WHERE owner_number=? AND blocked_number=?', [owner, other]);
  return r.length > 0;
}

exports.handleCall = async (ws, m) => {
  const me = ws.number;

  switch (m.type) {
    case 'call.invite': {
      const { to, callId, video } = m;
      const err = (code) => send(ws, { type: 'call.error', callId, code });
      if (!/^[1-9]\d{9}$/.test(to)) return err('NOT_FOUND');
      if (to === me) return err('SELF');
      const [u] = await db.query('SELECT 1 FROM users WHERE number=?', [to]);
      if (!u.length) return err('NOT_FOUND');
      if (await isBlocked(to, me)) return err('BLOCKED');
      if (!online.has(to)) return err('OFFLINE');
      if (inCall.has(to) || inCall.has(me)) return err('BUSY');

      const call = { callId, from: me, to, video: !!video, state: 'ringing', startedAt: Date.now() };
      call.timer = setTimeout(() => endCall(callId, 'timeout', 'missed'), 40000);
      calls.set(callId, call);
      inCall.set(me, callId); inCall.set(to, callId);
      send(ws, { type: 'call.ringing', callId });
      sendTo(to, { type: 'call.incoming', callId, from: me, video: !!video });
      break;
    }
    case 'call.accept': {
      const c = calls.get(m.callId); if (!c || c.to !== me) return;
      clearTimeout(c.timer); c.state = 'connecting'; c.answeredAt = Date.now();
      sendTo(c.from, { type: 'call.accepted', callId: c.callId });
      break;
    }
    case 'call.reject': {
      const c = calls.get(m.callId); if (!c || c.to !== me) return;
      sendTo(c.from, { type: 'call.rejected', callId: c.callId });
      endCall(c.callId, 'rejected', 'rejected', true);
      break;
    }
    case 'call.cancel': {
      const c = calls.get(m.callId); if (!c || c.from !== me) return;
      sendTo(c.to, { type: 'call.cancelled', callId: c.callId });
      endCall(c.callId, 'cancelled', 'cancelled', true);
      break;
    }
    case 'call.end': {
      const c = calls.get(m.callId); if (!c || (c.from !== me && c.to !== me)) return;
      const other = c.from === me ? c.to : c.from;
      sendTo(other, { type: 'call.ended', callId: c.callId, reason: 'hangup' });
      endCall(c.callId, 'hangup', 'completed', true);
      break;
    }
    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice':
    case 'call.state': {
      const c = calls.get(m.callId); if (!c) return;
      if (c.from !== me && c.to !== me) return;           // must be participant
      sendTo(c.from === me ? c.to : c.from, m);           // relay as-is
      break;
    }
  }
};

async function endCall(callId, reason, status, silent) {
  const c = calls.get(callId); if (!c) return;
  clearTimeout(c.timer);
  calls.delete(callId); inCall.delete(c.from); inCall.delete(c.to);
  if (!silent) {
    sendTo(c.from, { type: 'call.timeout', callId });
    sendTo(c.to,   { type: 'call.timeout', callId });
  }
  const duration = c.answeredAt ? Math.round((Date.now() - c.answeredAt) / 1000) : 0;
  await db.query(
    'INSERT INTO calls (id,from_number,to_number,is_video,status,started_at,answered_at,ended_at,duration_sec) ' +
    'VALUES (?,?,?,?,?,FROM_UNIXTIME(?),?,NOW(),?)',
    [callId, c.from, c.to, c.video ? 1 : 0, status, c.startedAt / 1000,
     c.answeredAt ? new Date(c.answeredAt) : null, duration]);
}
exports.cleanupUser = (number) => {
  const id = inCall.get(number); if (!id) return;
  const c = calls.get(id); if (!c) return;
  const other = c.from === number ? c.to : c.from;
  sendTo(other, { type: 'call.ended', callId: id, reason: 'network' });
  endCall(id, 'network', c.answeredAt ? 'completed' : 'failed', true);
};
```

## 8. Backend — ws/chat.js (core)

```js
const { state, send, sendTo } = require('./hub');
const db = require('../db');

exports.handleChat = async (ws, m) => {
  const me = ws.number;
  if (m.type === 'chat.send') {
    const text = String(m.text || '').trim().slice(0, 2000);
    if (!text || !/^[1-9]\d{9}$/.test(m.to)) return;
    const [b] = await db.query('SELECT 1 FROM blocks WHERE owner_number=? AND blocked_number=?', [m.to, me]);
    if (b.length) return;
    const [r] = await db.query('INSERT INTO messages (from_number,to_number,body) VALUES (?,?,?)', [me, m.to, text]);
    const delivered = sendTo(m.to, { type: 'chat.receive', id: r.insertId, from: me, text, ts: Date.now() });
    if (delivered) await db.query("UPDATE messages SET status='delivered' WHERE id=?", [r.insertId]);
    send(ws, { type: 'chat.ack', clientMsgId: m.clientMsgId, id: r.insertId,
               status: delivered ? 'delivered' : 'sent' });
  }
  if (m.type === 'chat.typing') sendTo(m.to, { type: 'chat.typing', from: me });
  if (m.type === 'chat.read') {
    await db.query("UPDATE messages SET status='read' WHERE to_number=? AND from_number=? AND id<=?",
                   [me, m.with, m.upToId]);
    sendTo(m.with, { type: 'chat.status', upToId: m.upToId, status: 'read', by: me });
  }
};
```

## 9. Frontend — public/index.html (Bootstrap shell)

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VCall</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css" rel="stylesheet">
  <link href="css/app.css" rel="stylesheet">
</head>
<body class="bg-light">

<div class="container py-3" style="max-width:480px">
  <!-- My number -->
  <div class="card shadow-sm mb-3 text-center p-3">
    <small class="text-muted">Your number</small>
    <h3 id="myNumber" class="fw-bold mb-1">-</h3>
    <button id="copyBtn" class="btn btn-sm btn-outline-secondary"><i class="bi bi-clipboard"></i> Copy</button>
  </div>

  <ul class="nav nav-pills nav-fill mb-3">
    <li class="nav-item"><a class="nav-link active" data-bs-toggle="pill" href="#tabDial">Dial</a></li>
    <li class="nav-item"><a class="nav-link" data-bs-toggle="pill" href="#tabChats">Chats</a></li>
    <li class="nav-item"><a class="nav-link" data-bs-toggle="pill" href="#tabRecents">Recents</a></li>
    <li class="nav-item"><a class="nav-link" data-bs-toggle="pill" href="#tabContacts">Contacts</a></li>
  </ul>

  <div class="tab-content">
    <!-- DIALPAD -->
    <div class="tab-pane fade show active" id="tabDial">
      <input id="dialInput" class="form-control form-control-lg text-center mb-3"
             placeholder="Enter 10-digit number" inputmode="numeric" maxlength="10">
      <div class="row g-2 text-center" id="keys"></div>  <!-- filled by dialpad.js -->
      <div class="d-flex gap-2 mt-3">
        <button id="btnVoice" class="btn btn-success flex-fill btn-lg"><i class="bi bi-telephone-fill"></i> Call</button>
        <button id="btnVideo" class="btn btn-primary flex-fill btn-lg"><i class="bi bi-camera-video-fill"></i> Video</button>
        <button id="btnChat"  class="btn btn-outline-secondary btn-lg"><i class="bi bi-chat-dots"></i></button>
      </div>
    </div>
    <div class="tab-pane fade" id="tabChats"><div id="chatList" class="list-group"></div></div>
    <div class="tab-pane fade" id="tabRecents"><div id="recentList" class="list-group"></div></div>
    <div class="tab-pane fade" id="tabContacts"><div id="contactList" class="list-group"></div></div>
  </div>
</div>

<!-- Incoming call modal -->
<div class="modal fade" id="incomingModal" data-bs-backdrop="static" data-bs-keyboard="false" tabindex="-1">
  <div class="modal-dialog modal-dialog-centered"><div class="modal-content text-center p-4">
    <h5 id="incomingText">Incoming call</h5>
    <h3 id="incomingFrom" class="fw-bold my-3"></h3>
    <div class="d-flex gap-3 justify-content-center">
      <button id="btnReject" class="btn btn-danger btn-lg rounded-circle"><i class="bi bi-telephone-x-fill"></i></button>
      <button id="btnAccept" class="btn btn-success btn-lg rounded-circle"><i class="bi bi-telephone-fill"></i></button>
    </div>
  </div></div>
</div>

<!-- In-call overlay -->
<div id="callScreen" class="d-none position-fixed top-0 start-0 w-100 h-100 bg-dark">
  <video id="remoteVideo" autoplay playsinline class="w-100 h-100" style="object-fit:cover"></video>
  <video id="localVideo" autoplay playsinline muted
         class="position-absolute rounded shadow" style="width:110px;right:12px;top:12px"></video>
  <div class="position-absolute top-0 start-50 translate-middle-x text-white mt-3">
    <div id="callPeer"></div><div id="callTimer">00:00</div>
  </div>
  <div class="position-absolute bottom-0 start-0 w-100 d-flex justify-content-center gap-3 pb-4">
    <button id="btnMute" class="btn btn-secondary btn-lg rounded-circle"><i class="bi bi-mic-fill"></i></button>
    <button id="btnCam"  class="btn btn-secondary btn-lg rounded-circle"><i class="bi bi-camera-video-fill"></i></button>
    <button id="btnFlip" class="btn btn-secondary btn-lg rounded-circle"><i class="bi bi-arrow-repeat"></i></button>
    <button id="btnEnd"  class="btn btn-danger btn-lg rounded-circle"><i class="bi bi-telephone-x-fill"></i></button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script type="module" src="js/app.js"></script>
</body>
</html>
```

## 10. Frontend — js/ws.js (client with reconnect)

```js
const handlers = {};
let socket, retry = 0, token;

export const on = (type, fn) => (handlers[type] ||= []).push(fn);
export const send = (obj) => socket?.readyState === 1 && socket.send(JSON.stringify(obj));

export function connect(tk) {
  token = tk;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onopen = () => { retry = 0; send({ type: 'auth', token }); };
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    (handlers[m.type] || []).forEach(fn => fn(m));
  };
  socket.onclose = () => {
    const wait = Math.min(1000 * 2 ** retry++, 30000);
    setTimeout(() => connect(token), wait);
  };
  setInterval(() => send({ type: 'ping' }), 25000);
}
```

## 11. Frontend — js/app.js (boot + virtual number)

```js
import { connect, on } from './ws.js';
import './dialpad.js';
import './call.js';
import './chat.js';

async function boot() {
  let token = localStorage.getItem('vc_token');
  let number = localStorage.getItem('vc_number');

  if (!token) {
    const r = await fetch('/api/identity', { method: 'POST' }).then(r => r.json());
    token = r.token; number = r.number;
    localStorage.setItem('vc_token', token);
    localStorage.setItem('vc_number', number);
  }
  document.getElementById('myNumber').textContent = number.replace(/(\d{4})(\d{4})(\d{2})/, '$1 $2 $3');

  on('auth.ok', m => window.ME = m.number);
  on('auth.error', () => { localStorage.clear(); location.reload(); });
  on('session.replaced', () => alert('Opened in another tab'));
  connect(token);
}
boot();
```

## 12. Frontend — js/dialpad.js

```js
import { send } from './ws.js';
import { startCall } from './call.js';

const input = document.getElementById('dialInput');
const keys = document.getElementById('keys');

['1','2','3','4','5','6','7','8','9','*','0','⌫'].forEach(k => {
  const col = document.createElement('div'); col.className = 'col-4';
  col.innerHTML = `<button class="btn btn-outline-dark w-100 py-3 fs-4">${k}</button>`;
  col.firstChild.onclick = () => {
    if (k === '⌫') input.value = input.value.slice(0, -1);
    else if (/\d/.test(k) && input.value.length < 10) input.value += k;
  };
  keys.appendChild(col);
});
input.addEventListener('input', () => input.value = input.value.replace(/\D/g, '').slice(0, 10));

const valid = () => /^[1-9]\d{9}$/.test(input.value);
document.getElementById('btnVoice').onclick = () => valid() ? startCall(input.value, false) : alert('Enter valid 10-digit number');
document.getElementById('btnVideo').onclick = () => valid() ? startCall(input.value, true)  : alert('Enter valid 10-digit number');
```

## 13. Frontend — js/call.js (WebRTC core)

```js
import { send, on } from './ws.js';

let pc, localStream, callId, peer, isCaller, video, iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const $ = id => document.getElementById(id);
const incomingModal = new bootstrap.Modal($('incomingModal'));

on('auth.ok', m => { if (m.iceServers) iceServers = m.iceServers; });

async function getMedia(wantVideo) {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
  $('localVideo').srcObject = localStream;
}

function createPC() {
  pc = new RTCPeerConnection({ iceServers });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => $('remoteVideo').srcObject = e.streams[0];
  pc.onicecandidate = e => e.candidate && send({ type: 'webrtc.ice', callId, candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') startTimer();
    if (pc.connectionState === 'failed') endCall(true);
  };
}

// ---------- CALLER ----------
export async function startCall(to, withVideo) {
  try { await getMedia(withVideo); } catch { return alert('Allow camera/mic permission'); }
  callId = crypto.randomUUID(); peer = to; isCaller = true; video = withVideo;
  showCallScreen('Calling ' + to + '...');
  send({ type: 'call.invite', to, callId, video: withVideo });
}
on('call.ringing', () => $('callPeer').textContent = 'Ringing...');
on('call.accepted', async () => {
  createPC();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: 'webrtc.offer', callId, sdp: offer });
});
on('call.error', m => { alert('Call failed: ' + m.code); cleanup(); });
on('call.rejected', () => { alert('Call declined'); cleanup(); });
on('call.timeout', () => { alert('No answer'); cleanup(); });

// ---------- RECEIVER ----------
on('call.incoming', m => {
  callId = m.callId; peer = m.from; isCaller = false; video = m.video;
  $('incomingFrom').textContent = m.from;
  $('incomingText').textContent = m.video ? 'Incoming video call' : 'Incoming voice call';
  incomingModal.show(); // + play ringtone
});
on('call.cancelled', () => { incomingModal.hide(); cleanup(); });

$('btnAccept').onclick = async () => {
  incomingModal.hide();
  try { await getMedia(video); } catch { return send({ type: 'call.reject', callId }); }
  showCallScreen(peer);
  send({ type: 'call.accept', callId });
};
$('btnReject').onclick = () => { send({ type: 'call.reject', callId }); incomingModal.hide(); cleanup(); };

// ---------- SIGNALING ----------
on('webrtc.offer', async m => {
  createPC();
  await pc.setRemoteDescription(m.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'webrtc.answer', callId, sdp: answer });
});
on('webrtc.answer', m => pc.setRemoteDescription(m.sdp));
on('webrtc.ice', m => pc?.addIceCandidate(m.candidate).catch(() => {}));

// ---------- CONTROLS ----------
$('btnMute').onclick = () => { const t = localStream.getAudioTracks()[0]; t.enabled = !t.enabled; };
$('btnCam').onclick  = () => { const t = localStream.getVideoTracks()[0]; if (t) t.enabled = !t.enabled; };
$('btnEnd').onclick  = () => endCall();
on('call.ended', () => cleanup());

function endCall() { send({ type: isCaller && !pc ? 'call.cancel' : 'call.end', callId }); cleanup(); }

let timerId, sec = 0;
function startTimer() { sec = 0; timerId = setInterval(() => {
  sec++; $('callTimer').textContent = String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0');
}, 1000); }
function showCallScreen(txt) { $('callPeer').textContent = txt; $('callScreen').classList.remove('d-none'); }
function cleanup() {
  clearInterval(timerId); sec = 0;
  pc?.close(); pc = null;
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
  $('remoteVideo').srcObject = null;
  $('callScreen').classList.add('d-none');
  callId = null;
}
```

> Important: the receiver must call `getUserMedia` **before** `call.accept`, and the caller creates the offer **after** `call.accepted`. This order avoids missing-track bugs.

## 14. Frontend — js/chat.js (outline)

```js
import { send, on } from './ws.js';

export function sendMessage(to, text) {
  const clientMsgId = crypto.randomUUID();
  renderMessage({ mine: true, text, status: 'pending', clientMsgId });
  send({ type: 'chat.send', to, clientMsgId, text });
}
on('chat.ack',     m => updateStatus(m.clientMsgId, m.status));
on('chat.receive', m => { renderMessage({ mine: false, text: m.text, from: m.from });
                          send({ type: 'chat.delivered', id: m.id }); });
on('chat.typing',  m => showTyping(m.from));
on('chat.status',  m => markRead(m.upToId));
```

## 15. UI Notes

- Use `playsinline` on every `<video>` (needed for iOS Safari).
- Add `muted` on local preview video to avoid echo.
- Use Bootstrap `modal` for incoming call, `offcanvas` for chat panel on mobile.
- Play ringtone with `Audio.loop = true`; browsers require a prior user click on the page for autoplay — show a "Tap to enable sound" button on first load.
- Wake lock during call: `navigator.wakeLock.request('screen')`.
