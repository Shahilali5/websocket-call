# 02 — Architecture & Full Workflow (A to Z)

## 1. Big Picture

```
 ┌────────────┐        WSS (signaling, chat, presence)        ┌─────────────────┐
 │  Browser A │ ◄───────────────────────────────────────────► │  Node.js Server │
 │ HTML+BS5   │                                               │ Express + ws    │
 └─────┬──────┘                                               │ + MySQL         │
       │                                                      └────────▲────────┘
       │                                                               │ WSS
       │          WebRTC (video + audio, encrypted P2P)                │
       │ ◄───────────────────────────────────────────────────►  ┌──────┴─────┐
       └──────────────────────────────────────────────────────► │ Browser B  │
                  (via STUN / TURN if direct path fails)        └────────────┘
```

### Components

| Component | Tech | Job |
|-----------|------|-----|
| Frontend | HTML, Bootstrap 5, vanilla JS | UI, dialpad, camera/mic, WebRTC, WebSocket client |
| Backend | Node.js, Express, `ws` | Serves site, REST for identity, WebSocket hub |
| Database | MySQL (or SQLite for MVP) | users, messages, calls, contacts, blocks |
| STUN | Google public STUN (free) | Discover public IP |
| TURN | coturn (self-hosted) | Relay media when P2P impossible (~15-20% of calls) |
| Reverse proxy | Nginx + Let's Encrypt | HTTPS/WSS |

## 2. Technology Roles (Remember This)

1. **HTTP (Express)** — page load, create identity (`POST /api/identity`), history APIs.
2. **WebSocket** — everything real-time that is small: who is online, "call ring", chat, SDP offer/answer, ICE candidates.
3. **WebRTC** — the actual camera/mic stream between browsers.

## 3. Workflow A to Z

### Step A — First visit: get a virtual number

```
Browser                         Server                        DB
  │ open site                     │                             │
  │ localStorage.token ?          │                             │
  │── no token ──► POST /api/identity ──► generate 10-digit ──► INSERT users
  │◄── {number, token} ───────────│    number (check unique)    │
  │ save token in localStorage    │                             │
```

Number generation:
```
loop:
  n = random 10-digit, first digit 1-9
  if not exists in users → use it
```
If a token already exists, skip creation and just reconnect (same number).

### Step B — Connect WebSocket & authenticate

```
Browser: new WebSocket("wss://site.com/ws")
Browser → {type:"auth", token}
Server: find user by token → bind ws to number
        onlineUsers.set(number, ws)
Server → {type:"auth.ok", number}
Server → pending offline messages / missed-call list
Server → broadcast presence "online" to that user's contacts
```
Heartbeat: server pings every 25s; no pong in 60s → mark offline & close.

### Step C — Dialpad

- User taps digits; UI shows `7384 9201 55`.
- On **Call** / **Video** press: client checks length = 10 and not own number.
- Client sends `call.invite` over WebSocket.

### Step D — Call setup (the heart of the system)

```
Caller A                    Server                       Receiver B
  │ getUserMedia(cam+mic)     │                              │
  │── call.invite {to:B, callId, video:true} ──►             │
  │                           │ check: B exists? blocked? online? busy?
  │◄── call.error / call.ringing ──                          │
  │                           │── call.incoming {from:A, callId, video} ─►
  │                           │                              │ ringtone + popup
  │                           │◄── call.accept {callId} ─────│ (B did getUserMedia)
  │◄── call.accepted ─────────│                              │
  │ create RTCPeerConnection  │                              │
  │ addTrack(local)           │                              │
  │ createOffer → setLocal    │                              │
  │── webrtc.offer {sdp} ────►│── webrtc.offer ─────────────►│
  │                           │                              │ setRemote(offer)
  │                           │                              │ createAnswer → setLocal
  │◄── webrtc.answer ─────────│◄── webrtc.answer {sdp} ──────│
  │ setRemote(answer)         │                              │
  │◄──── webrtc.ice (both directions, many times) ─────────►│
  │                                                          │
  │═══════════ P2P audio/video starts (WebRTC) ══════════════│
```

**Reject / cancel / timeout**
- B rejects → `call.reject` → A sees "Declined".
- A cancels while ringing → `call.cancel` → B popup closes, missed call logged.
- 40 s no answer → server sends `call.timeout` to both, logs missed call.

### Step E — During call

- Mute/camera: just enable/disable tracks locally (`track.enabled = false`). Optionally send `call.state {muted:true}` so the other side shows an icon.
- Timer starts when `connectionState === "connected"`.
- Network drop: `iceconnectionstatechange → disconnected` → caller does `restartIce()` and sends a new offer.

### Step F — End call

```
User taps End → close RTCPeerConnection, stop all tracks
              → send call.end {callId}
Server → forwards call.end, writes calls row (duration, status)
Other side → shows "Call ended", cleans up
```
Server removes both numbers from the `inCall` map so they are no longer "busy".

### Step G — Chat

```
A → chat.send {to:B, clientMsgId, text}
Server: save in DB (status=sent)
        if B online → chat.receive to B, mark delivered
        else        → stays 'sent', delivered on B's next auth
Server → A: chat.ack {clientMsgId, id, status:"sent" | "delivered"}
B opens chat → chat.read {with:A, upToId}
Server → A: chat.read_receipt
```
Typing: `chat.typing {to}` (not stored, throttled to 1 per 2 s).

### Step H — Presence

- Server keeps `Map<number, ws>`.
- On connect/disconnect, notify only contacts and active chat partners (not everyone) to save bandwidth.
- Client can ask `presence.query {numbers:[...]}`.

### Step I — Reconnect

- Client WebSocket `onclose` → retry after 1s, 2s, 4s, 8s… (max 30s) with same token.
- If a call was active, WebRTC may survive (P2P) while signaling reconnects. After re-auth, send `call.resume {callId}` if needed.

### Step J — Multi-tab / multi-device rule (v1)

One active WebSocket per number. A new login **replaces** the old one; old tab receives `session.replaced` and shows "Opened in another tab".

## 4. Call State Machine

```
idle ──invite──► calling ──ringing──► ringing ──accept──► connecting ──ice connected──► in-call
  ▲                 │                    │                    │                           │
  └──── ended ◄─────┴──cancel/timeout/reject/error────────────┴────────end/failed────────┘
```

Receiver side: `idle → incoming → connecting → in-call → ended`.

## 5. Server In-Memory Structures

```js
const online  = new Map();   // number -> ws
const inCall  = new Map();   // number -> callId
const calls   = new Map();   // callId -> {from, to, video, state, startedAt, ringTimer}
```
For multiple Node instances later: move these to **Redis** + pub/sub so `from` and `to` can be on different servers.

## 6. ICE Servers Config

```js
const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:turn.yourdomain.com:3478", username: "user", credential: "pass" },
  { urls: "turns:turn.yourdomain.com:5349", username: "user", credential: "pass" }
];
```
Serve TURN credentials from the server (`GET /api/ice`) as short-lived values; never hardcode in JS for production.

## 7. Error Cases & Messages

| Situation | Server reply | UI |
|-----------|--------------|----|
| Number not found | `call.error {code:"NOT_FOUND"}` | "This number doesn't exist" |
| Receiver offline | `call.error {code:"OFFLINE"}` | "User is offline" (offer to send chat) |
| Receiver busy | `call.error {code:"BUSY"}` | "User is busy" |
| Blocked | `call.error {code:"BLOCKED"}` | "Cannot call this number" |
| Camera denied | local | "Allow camera/mic in browser settings" |
| ICE failed | local | "Connection failed. Retry" |
