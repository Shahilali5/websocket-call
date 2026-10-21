# PRD — "VCall": Virtual-Number Video Calling & Chat System

Version 1.0 | Stack: Node.js + WebSocket + WebRTC + HTML + Bootstrap 5

---

## 1. Product Overview

VCall is a browser-based calling app (like imo). When a person opens the website, they automatically get a **unique virtual number**. They can type another user's virtual number on a **dialpad** and start a **voice call, video call, or chat**.

No app install. Works in Chrome, Edge, Firefox, Safari (mobile + desktop).

## 2. Goals

| # | Goal |
|---|------|
| G1 | Every visitor gets a unique virtual number instantly (no SMS/OTP needed) |
| G2 | Call any other user by dialing their number on a dialpad |
| G3 | Real-time 1-to-1 video and audio calls |
| G4 | Real-time text chat (online + offline delivery) |
| G5 | Incoming call popup with ringtone, Accept / Reject |
| G6 | Simple, mobile-first Bootstrap UI |

## 3. Non-Goals (v1)

- Real phone numbers / PSTN calls (numbers are virtual, only work inside VCall)
- Group video calls (planned for v2)
- Native mobile apps
- End-to-end encrypted chat (planned v2; WebRTC media is already DTLS-SRTP encrypted)

## 4. Key Concept (Very Important)

> **WebSocket does NOT carry video.**
>
> - **WebSocket** = *signaling + chat + presence* (small JSON messages through your Node.js server).
> - **WebRTC** = *actual video/audio* (peer-to-peer between the two browsers).
> - **STUN/TURN server** = helps the two browsers find each other through NAT/firewalls.

Without WebRTC, sending video through WebSocket would be very slow and expensive. This is how imo, WhatsApp web, Google Meet all work.

## 5. Users & Personas

- **Guest user**: opens the site, gets a number automatically, can call immediately.
- **Registered user** (optional upgrade): sets name + password so the number can be recovered on another device.
- **Admin**: views stats, bans abusive numbers.

## 6. User Stories

1. As a user, I open the site and instantly see "Your number: **7384 9201 55**".
2. As a user, I type a friend's number on the dialpad and press Video Call.
3. As a receiver, I see a full-screen incoming call popup with ringtone and Accept/Reject.
4. As a user, I can send chat messages to a number even before calling.
5. As a user, if the other person is offline, my message is stored and delivered later.
6. As a user, during a call I can mute mic, turn off camera, switch camera, end call.
7. As a user, I can see my call history and recent chats.
8. As a user, I can save contacts with a nickname for a number.
9. As a user, I can block a number.

## 7. Functional Requirements

### 7.1 Virtual Number
- FR-1: Number is **10 digits**, unique, generated server-side on first visit.
- FR-2: Format example `7384920155`; displayed grouped `7384 9201 55`.
- FR-3: First digit never 0. Collision check against DB before assigning.
- FR-4: Optional "VIP/custom number" (user picks, if available) — v1.1.
- FR-5: Identity saved on device via `token` in `localStorage`. Same browser = same number.

### 7.2 Dialpad
- FR-6: Digits 0-9, backspace, clear, Call (voice), Video Call buttons.
- FR-7: Also accepts keyboard input on desktop.
- FR-8: Validates 10 digits and that the number exists; shows "User not found" or "User offline".
- FR-9: Cannot call own number.

### 7.3 Calling
- FR-10: Voice call and video call (1-to-1).
- FR-11: Call states: `idle → calling → ringing → connecting → in-call → ended`.
- FR-12: Ring timeout 40 seconds → "No answer" + missed call entry.
- FR-13: Busy detection: if receiver already in call → "User busy".
- FR-14: Controls: mute, camera on/off, speaker, flip camera, end call, call timer.
- FR-15: Upgrade voice → video during call (v1.1).
- FR-16: Auto-reconnect if network drops under 10 seconds (ICE restart).

### 7.4 Chat
- FR-17: Text messages 1-to-1 via WebSocket.
- FR-18: Delivery states: sent ✓, delivered ✓✓, read (blue ✓✓).
- FR-19: Typing indicator.
- FR-20: Offline messages stored in DB, pushed on next connect.
- FR-21: Message history loaded with pagination.
- FR-22: Emoji supported (native). Images/files in v1.1.

### 7.5 Presence
- FR-23: Online / offline / in-call status per number.
- FR-24: Heartbeat ping every 25s; offline after 60s without pong.

### 7.6 Contacts, History, Block
- FR-25: Save contact (number + nickname).
- FR-26: Call history: outgoing, incoming, missed, duration.
- FR-27: Block / unblock number; blocked numbers cannot call or message.

### 7.7 Notifications
- FR-28: Browser notification for incoming call/message when tab is in background (Web Push / FCM, v1.1).
- FR-29: Ringtone (loop) for incoming call, dial tone for outgoing.

## 8. Non-Functional Requirements

| Area | Requirement |
|------|-------------|
| Latency | Signaling < 200 ms; video start < 3 s |
| Capacity | 5,000 concurrent WebSocket connections per Node instance |
| Security | HTTPS/WSS only, token auth, rate limiting, input validation |
| Reliability | Auto-reconnect WebSocket with exponential backoff |
| Browser | Latest 2 versions Chrome, Edge, Firefox, Safari 15+ |
| Mobile | Responsive 360px+ |
| Privacy | Media peer-to-peer; server never stores audio/video |

## 9. Screens

1. **Splash/Loading** — creating identity
2. **Home** — my number (copy button), dialpad, tabs: Dial | Chats | Recents | Contacts
3. **Chat screen** — messages, input, call/video icons in header
4. **Outgoing call screen** — "Calling 7384…", cancel
5. **Incoming call modal** — caller number, Accept / Reject
6. **In-call screen** — remote video full, local video small, controls
7. **Settings** — name, avatar, ringtone, blocked list, register/recover account

## 10. Success Metrics

- Call setup success rate > 95%
- Median call connect time < 3 s
- Message delivery < 500 ms when online
- Crash-free WebSocket sessions > 99%

## 11. Release Plan

| Phase | Scope |
|-------|-------|
| MVP (week 1-2) | Number generation, WS auth, presence, dialpad, 1-1 video/voice, basic chat |
| v1.0 (week 3) | Offline messages, history, contacts, block, mute/camera controls, TURN |
| v1.1 | Push notifications, file/image share, custom numbers, voice→video upgrade |
| v2 | Group calls (SFU like mediasoup), E2E chat, screen share |

## 12. Risks

| Risk | Mitigation |
|------|-----------|
| Calls fail behind strict NAT | Deploy own TURN server (coturn) |
| Camera blocked without HTTPS | Force HTTPS (getUserMedia needs secure context) |
| Spam / prank calls | Rate limit, block, report, ring limit per caller |
| Guests lose number if they clear browser | Optional register/recover with password |
| iOS Safari quirks | Test early; use `playsinline` on video tags |

## 13. Document Index

- `01-PRD.md` — this file
- `02-ARCHITECTURE-AND-WORKFLOW.md` — how everything works A to Z
- `03-WEBSOCKET-PROTOCOL.md` — every message type
- `04-DATABASE-AND-REST-API.md` — schema + endpoints
- `05-FRONTEND-AND-CODE-SKELETON.md` — folder structure + starter code
- `06-DEPLOYMENT-SECURITY-TESTING.md` — go-live checklist
