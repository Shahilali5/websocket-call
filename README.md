# VCall — Virtual-Number Calling & Chat System

A full-stack, browser-based video calling, voice calling, and chat platform (similar to imo / WhatsApp Web). Visitors instantly receive a unique 10-digit virtual number, can secure it with a PIN/password, and can dial any number for real-time 1-to-1 WebRTC audio/video calls.

---

## ⚡ 1-Click VPS Setup (Port 2083)

Deploy VCall on any Ubuntu / Debian VPS with automated Node.js, PM2, coturn (STUN/TURN), UFW Firewall, and environment setup:

### Step 1: Upload or Clone the project to your VPS
```bash
git clone <your-repo-url> /var/www/vcall
cd /var/www/vcall
```

### Step 2: Make the script executable and run it
```bash
chmod +x setup-vps.sh
sudo bash setup-vps.sh
```

The script automatically:
- Installs Node.js 22 LTS & PM2
- Configures **Port 2083** in `.env`
- Installs and configures a self-hosted **coturn STUN/TURN server** with a secure random key
- Configures the UFW firewall for Port 2083 (TCP) and WebRTC media ports (`3478`, `5349`, `49152-65535/udp`)
- Launches VCall via **PM2** with systemd auto-restart on boot

---

## 🌐 Why Port 2083? (Cloudflare SSL Support)

**Port 2083** is one of [Cloudflare's officially supported HTTPS/WSS ports](https://developers.cloudflare.com/fundamentals/reference/network-ports/).

If your domain uses Cloudflare DNS:
1. Point your domain's **A record** to your VPS Public IP with the Cloudflare Proxy (Orange Cloud) **ON**.
2. Enable **Full (Strict)** SSL in Cloudflare.
3. Access your app directly with free SSL:
   ```
   https://yourdomain.com:2083
   ```
   WebSocket connection automatically upgrades to `wss://yourdomain.com:2083/ws`.

---

## 💻 Local Development

### Requirements
- Node.js 20+ (Node 22 or 24 recommended)
- No build tools required (pure JavaScript + built-in `node:sqlite`)

### Run Locally:
```bash
npm install
npm start
```
Access at: `http://localhost:2083`

---

## 🛠️ Management Commands

| Action | Command |
| :--- | :--- |
| **Check App Status** | `pm2 status` |
| **View Live Logs** | `pm2 logs vcall` |
| **Restart App** | `pm2 restart vcall` |
| **Stop App** | `pm2 stop vcall` |
| **Check TURN Server** | `systemctl status coturn` |
| **Check Firewall** | `sudo ufw status verbose` |

---

## 🏗️ Architecture

- **Signaling & Chat**: Node.js + Express + `ws` WebSocket server on Port 2083.
- **Media**: Peer-to-peer WebRTC with hardware echo cancellation, noise suppression, and 1.5 Mbps HD bitrate stream.
- **Relay**: coturn STUN/TURN server for strict cellular / NAT traversal.
- **Database**: Zero-dependency SQLite via native `node:sqlite` (or MySQL for cluster deployments).
