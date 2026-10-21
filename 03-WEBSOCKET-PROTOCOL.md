# 03 — WebSocket Protocol (API Spec)

Endpoint: `wss://yourdomain.com/ws`
Format: every message is JSON text: `{ "type": "...", ...payload }`

Rules:
- First message after connect **must** be `auth` within 5 seconds, or the server closes the socket.
- Max message size: 64 KB. Unknown types are ignored and logged.
- Server never trusts `from` in client messages — it always uses the authenticated number.

---

## 1. Auth & Session

### Client → Server
```json
{ "type": "auth", "token": "a1b2c3...64hex" }
```
### Server → Client
```json
{ "type": "auth.ok", "number": "7384920155", "name": "Guest", "iceServers": [ ... ] }
{ "type": "auth.error", "code": "INVALID_TOKEN" }
{ "type": "session.replaced" }
```
### Heartbeat
```json
{ "type": "ping" }   →   { "type": "pong" }
```

---

## 2. Presence

| Direction | Message |
|-----------|---------|
| C→S | `{ "type":"presence.query", "numbers":["7384920155","9911223344"] }` |
| S→C | `{ "type":"presence.result", "list":[{"number":"7384920155","status":"online"}] }` |
| S→C | `{ "type":"presence.update", "number":"7384920155", "status":"online" \| "offline" \| "in-call" }` |

---

## 3. Calling (Signaling)

### 3.1 Start call
C→S (caller)
```json
{ "type":"call.invite", "to":"9911223344", "callId":"uuid-v4", "video":true }
```
S→C (caller) — errors
```json
{ "type":"call.error", "callId":"...", "code":"NOT_FOUND|OFFLINE|BUSY|BLOCKED|SELF|RATE_LIMIT" }
```
S→C (caller) — OK
```json
{ "type":"call.ringing", "callId":"..." }
```
S→C (receiver)
```json
{ "type":"call.incoming", "callId":"...", "from":"7384920155", "name":"Rahul", "video":true }
```

### 3.2 Answer / decline / cancel
```json
C→S (receiver): { "type":"call.accept", "callId":"..." }
S→C (caller)  : { "type":"call.accepted", "callId":"..." }

C→S (receiver): { "type":"call.reject", "callId":"..." }
S→C (caller)  : { "type":"call.rejected", "callId":"..." }

C→S (caller)  : { "type":"call.cancel", "callId":"..." }
S→C (receiver): { "type":"call.cancelled", "callId":"..." }

S→C (both)    : { "type":"call.timeout", "callId":"..." }
```

### 3.3 WebRTC signaling relay (server just forwards to the other party in that call)
```json
{ "type":"webrtc.offer",  "callId":"...", "sdp":{ "type":"offer",  "sdp":"v=0..." } }
{ "type":"webrtc.answer", "callId":"...", "sdp":{ "type":"answer", "sdp":"v=0..." } }
{ "type":"webrtc.ice",    "callId":"...", "candidate":{ "candidate":"...", "sdpMid":"0", "sdpMLineIndex":0 } }
```
Server checks: sender is a participant of `callId`; otherwise drop.

### 3.4 In-call state & end
```json
{ "type":"call.state", "callId":"...", "muted":true, "cameraOff":false }
{ "type":"call.end",   "callId":"..." }
{ "type":"call.ended", "callId":"...", "reason":"hangup|network|timeout", "duration":125 }
```

---

## 4. Chat

### Send
```json
{ "type":"chat.send", "to":"9911223344", "clientMsgId":"uuid", "text":"Hello" }
```
### Server responses
```json
{ "type":"chat.ack", "clientMsgId":"uuid", "id":10231, "status":"sent|delivered", "ts":1767225600 }
{ "type":"chat.receive", "id":10231, "from":"7384920155", "text":"Hello", "ts":1767225600 }
```
### Receipts & typing
```json
C→S: { "type":"chat.delivered", "id":10231 }
C→S: { "type":"chat.read", "with":"7384920155", "upToId":10231 }
S→C: { "type":"chat.status", "id":10231, "status":"delivered|read" }
C→S: { "type":"chat.typing", "to":"9911223344" }
S→C: { "type":"chat.typing", "from":"7384920155" }
```
### History (over WS or REST)
```json
C→S: { "type":"chat.history", "with":"9911223344", "beforeId":10000, "limit":30 }
S→C: { "type":"chat.history.result", "with":"9911223344", "messages":[ ... ] }
```

---

## 5. Contacts & Block

```json
C→S: { "type":"contact.save",  "number":"9911223344", "nickname":"Amit" }
C→S: { "type":"contact.remove","number":"9911223344" }
C→S: { "type":"block.add",     "number":"9911223344" }
C→S: { "type":"block.remove",  "number":"9911223344" }
```

---

## 6. Error Envelope

```json
{ "type":"error", "code":"BAD_REQUEST|UNAUTHORIZED|RATE_LIMIT|SERVER", "message":"..." }
```

## 7. Rate Limits (per connection)

| Action | Limit |
|--------|-------|
| `call.invite` | 5 per minute |
| `chat.send` | 30 per minute |
| `chat.typing` | 1 per 2 seconds |
| `webrtc.ice` | 100 per call |
| Total messages | 200 per minute, then disconnect |

## 8. Message Flow Cheat-Sheet

```
Outgoing call : invite → ringing → (accepted) → offer → answer → ice* → [connected] → end
Incoming call : incoming → accept → (offer received) → answer → ice* → [connected] → end
Chat          : send → ack(sent) → (receive on B) → delivered → read
```
