# 06 — Deployment, Security, Testing & Roadmap

## 1. Why HTTPS Is Mandatory

Browsers allow `getUserMedia` (camera/mic) **only on HTTPS or localhost**. Without a valid SSL certificate the camera will not open. WebSocket must be `wss://` on HTTPS pages.

## 2. Server Requirements

| Item | MVP | 1,000+ concurrent users |
|------|-----|-------------------------|
| VPS | 1 vCPU, 1 GB RAM | 2 vCPU, 4 GB RAM |
| OS | Ubuntu 22.04/24.04 | same |
| Node.js | 20 LTS | 20 LTS + PM2 cluster / Redis |
| TURN server | same VPS or separate | separate VPS with good bandwidth |
| Domain | `call.yourdomain.com` | + `turn.yourdomain.com` |

Signaling is lightweight. Bandwidth cost comes from **TURN relay** only (about 1–2 Mbps per video stream when relaying).

## 3. Nginx Config (HTTPS + WebSocket)

```nginx
server {
    listen 443 ssl http2;
    server_name call.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/call.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/call.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;    # keep sockets open
    }
}
server { listen 80; server_name call.yourdomain.com; return 301 https://$host$request_uri; }
```

SSL:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d call.yourdomain.com
```

## 4. Run Node with PM2

```bash
npm i -g pm2
pm2 start server/index.js --name vcall
pm2 save && pm2 startup
```

## 5. TURN Server (coturn)

```bash
sudo apt install coturn
```
`/etc/turnserver.conf`:
```
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=YOUR_LONG_RANDOM_SECRET
realm=turn.yourdomain.com
total-quota=100
no-multicast-peers
no-cli
cert=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem
min-port=49152
max-port=65535
```
Open firewall: `3478/udp+tcp`, `5349/tcp`, `49152-65535/udp`.
Enable service: `TURNSERVER_ENABLED=1` in `/etc/default/coturn`, then `systemctl restart coturn`.

Test at: Trickle ICE tester (webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) — you should see `relay` candidates.

## 6. Environment (.env)

```
PORT=3000
DB_HOST=127.0.0.1
DB_USER=vcall
DB_PASS=strongpassword
DB_NAME=vcall
TURN_HOST=turn.yourdomain.com
TURN_SECRET=YOUR_LONG_RANDOM_SECRET
```

## 7. Security Checklist

| # | Item | How |
|---|------|-----|
| 1 | HTTPS/WSS only | Nginx + Let's Encrypt |
| 2 | Hash tokens | store sha256, never raw |
| 3 | Rate limit identity creation | `express-rate-limit` e.g. 5 per hour per IP (stops number-farming bots) |
| 4 | Rate limit WS actions | see protocol doc section 7 |
| 5 | Validate everything | number regex, text length ≤ 2000, JSON size ≤ 64 KB |
| 6 | Never trust `from` | use `ws.number` set at auth |
| 7 | Verify call participants | before relaying `webrtc.*` |
| 8 | Escape chat text | use `textContent`, never `innerHTML` (prevents XSS) |
| 9 | Origin check on WS | reject if `req.headers.origin` not your domain |
| 10 | Helmet + CSP | set Content-Security-Policy allowing only your scripts + CDNs |
| 11 | Prepared SQL statements | always `?` placeholders |
| 12 | Short-lived TURN creds | HMAC with expiry (doc 04, section 5) |
| 13 | Abuse controls | block, report, admin ban, ring limit per caller |
| 14 | Privacy | server never records media; tell users in a Privacy Policy |
| 15 | Backups | daily MySQL dump |

Anti-prank ideas: limit calls to a number that rejected you 3 times in 10 minutes; "Only contacts can call me" setting.

## 8. Scaling Beyond One Server

1. Move `online`, `inCall`, `calls` maps to **Redis**.
2. Use Redis **pub/sub** so a message for number X reaches whichever Node instance holds X's socket.
3. Sticky sessions not required if every instance can reach Redis.
4. Run multiple Node processes with PM2 cluster or Docker replicas behind Nginx `upstream`.
5. For **group calls** (v2): add an SFU such as mediasoup or LiveKit; mesh P2P only works for ~4 people.

## 9. Testing Plan

### Functional
| Test | Expected |
|------|----------|
| Open site first time | Number created, saved in localStorage |
| Refresh page | Same number |
| Open in incognito | New number |
| Dial invalid / own number | Error shown |
| Call offline number | "User offline" |
| Call → accept | Video both sides within 3 s |
| Call → reject | Caller sees "Declined" |
| Caller cancels while ringing | Receiver popup closes, missed call logged |
| No answer 40 s | Timeout both sides |
| Receiver busy | "User busy" |
| Mute / camera off | Other side hears/sees nothing, no crash |
| End call | Both cleaned, camera light turns off |
| Chat online | Delivered ✓✓ instantly |
| Chat offline | Delivered on next login |
| Kill server, restart | Clients auto-reconnect |

### Network
- Two devices on different Wi-Fi/mobile data → must work (tests TURN).
- Throttle to 3G in Chrome DevTools → call stays up, video quality drops.
- Switch Wi-Fi → mobile during call → ICE restart recovers or call ends cleanly.

### Browser matrix
Chrome, Edge, Firefox, Safari iOS, Chrome Android.

### Load
Use `artillery` or a script with 1,000 `ws` clients doing auth + ping; watch CPU and memory.

## 10. Common Problems & Fixes

| Problem | Cause | Fix |
|---------|-------|-----|
| Camera not opening | HTTP not HTTPS | Use SSL |
| Black remote video on iPhone | Missing `playsinline` | add attribute |
| Works on same Wi-Fi only | No TURN | install coturn |
| One-way audio | Tracks added after offer | add tracks before `createOffer` |
| `addIceCandidate` error | Candidate before remote description | queue candidates until `setRemoteDescription` is done |
| WS drops every 60s | Nginx timeout | `proxy_read_timeout 86400s` + heartbeat |
| Ringtone silent | Autoplay policy | require one user click first |
| Echo | Local video not muted | `muted` on local `<video>` |

## 11. Development Roadmap (Task Breakdown)

**Week 1 — Core**
1. Project setup, MySQL schema
2. `/api/identity` + number generator
3. WS hub: auth, heartbeat, presence
4. UI shell: number card, dialpad

**Week 2 — Calling**
5. Signaling handlers (invite/accept/reject/cancel/end)
6. WebRTC client (offer/answer/ICE)
7. Incoming modal, in-call screen, controls
8. Call logging, timeout, busy logic

**Week 3 — Chat & Polish**
9. Chat send/receive/ack/read, offline delivery
10. Contacts, history, block
11. TURN server + credentials endpoint
12. Security hardening, rate limits, testing

**Week 4 — Launch**
13. Nginx + SSL + PM2 deploy
14. Cross-browser/mobile testing
15. Privacy policy, soft launch

## 12. Future Features (Backlog)

- Web Push / FCM for background incoming-call notifications (Service Worker)
- Image/file/voice-note sharing
- Voice → video upgrade mid-call
- Screen sharing (`getDisplayMedia`)
- Custom/VIP numbers
- Group calls with SFU
- End-to-end encrypted chat
- PWA install (add to home screen)
- Admin dashboard (users, active calls, bans)

## 13. Quick Glossary

| Term | Meaning |
|------|---------|
| Signaling | Exchanging connection info (SDP, ICE) through your server before the call |
| SDP | Description of media (codecs, tracks) sent as offer/answer |
| ICE candidate | A possible network path (IP:port) to reach a peer |
| STUN | Tells a browser its public IP |
| TURN | Relay server used when direct P2P is blocked |
| SFU | Server that forwards video streams for group calls |
