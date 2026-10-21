#!/usr/bin/env bash
# ==============================================================================
# VCall — 1-Click Production VPS Setup Script (Ubuntu / Debian)
# Port: 2083 (Cloudflare-compatible HTTPS/WSS port)
# Stack: Node.js + PM2 + WebRTC (coturn TURN/STUN) + UFW Firewall + Nginx
# ==============================================================================

set -e

# Terminal Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

APP_PORT=2083
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${CYAN}${BOLD}"
echo "===================================================================="
echo "          🚀 VCall Production 1-Click VPS Installer                 "
echo "                   Configuring Port: $APP_PORT                       "
echo "===================================================================="
echo -e "${NC}"

# Check for root / sudo privileges
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] Please run this script with sudo or as root:${NC}"
  echo "  sudo bash setup-vps.sh"
  exit 1
fi

# Detect Server Public IP
SERVER_IP=$(curl -s -4 https://ifconfig.me || curl -s -4 https://api.ipify.org || echo "YOUR_SERVER_IP")
echo -e "${BLUE}[*] Detected Server Public IP:${NC} ${BOLD}$SERVER_IP${NC}"

# Step 1: Update System Packages
echo -e "\n${BLUE}[1/7] Updating system packages...${NC}"
apt-get update -y
apt-get install -y curl wget git ufw coturn dnsutils build-essential

# Step 2: Install Node.js (Node 22 LTS) if not installed
echo -e "\n${BLUE}[2/7] Checking Node.js runtime...${NC}"
if ! command -v node &> /dev/null; then
  echo -e "${YELLOW}[*] Node.js not detected. Installing Node.js 22 LTS...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  NODE_VER=$(node -v)
  echo -e "${GREEN}[✓] Node.js already installed: $NODE_VER${NC}"
fi

# Step 3: Install PM2 Process Manager globally
echo -e "\n${BLUE}[3/7] Setting up PM2 Process Manager...${NC}"
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
else
  echo -e "${GREEN}[✓] PM2 is already installed.${NC}"
fi

# Step 4: Configure TURN/STUN Server (coturn) for Cross-Network WebRTC Calls
echo -e "\n${BLUE}[4/7] Configuring coturn STUN/TURN server...${NC}"
TURN_SECRET=$(openssl rand -hex 32)
cat <<EOF > /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$SERVER_IP
total-quota=200
no-multicast-peers
no-cli
min-port=49152
max-port=65535
verbose
EOF

# Enable coturn daemon
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/g' /etc/default/coturn 2>/dev/null || true
systemctl restart coturn 2>/dev/null || true
systemctl enable coturn 2>/dev/null || true
echo -e "${GREEN}[✓] coturn STUN/TURN server active with secure credentials.${NC}"

# Step 5: Configure Environment (.env) for Port 2083
echo -e "\n${BLUE}[5/7] Writing production environment configuration (.env)...${NC}"
cd "$APP_DIR"

cat <<EOF > .env
PORT=$APP_PORT
DB_CLIENT=sqlite
DB_FILE=./vcall.sqlite

# STUN / TURN Server Configuration
TURN_HOST=$SERVER_IP
TURN_SECRET=$TURN_SECRET
EOF
echo -e "${GREEN}[✓] .env file configured for Port $APP_PORT.${NC}"

# Step 6: Install Node dependencies
echo -e "\n${BLUE}[6/8] Installing project dependencies & web-push...${NC}"
npm install --omit=dev
npm install web-push

# Step 7: Auto-generate SSL Certificate for Direct IP HTTPS
echo -e "\n${BLUE}[7/8] Generating SSL certificate for native HTTPS on $SERVER_IP...${NC}"
mkdir -p "$APP_DIR/certs"
if [ ! -f "$APP_DIR/certs/cert.pem" ] || [ ! -f "$APP_DIR/certs/key.pem" ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$APP_DIR/certs/key.pem" \
    -out "$APP_DIR/certs/cert.pem" \
    -subj "/CN=$SERVER_IP"
  echo -e "${GREEN}[✓] Self-signed SSL certificate created in ./certs${NC}"
else
  echo -e "${GREEN}[✓] SSL certificates already exist in ./certs${NC}"
fi

# Step 8: Configure Firewall (UFW)
echo -e "\n${BLUE}[8/8] Configuring UFW Firewall for Port $APP_PORT & WebRTC...${NC}"
ufw allow 22/tcp comment 'SSH' || true
ufw allow 80/tcp comment 'HTTP' || true
ufw allow 443/tcp comment 'HTTPS' || true
ufw allow $APP_PORT/tcp comment 'VCall Web & WebSocket' || true
ufw allow 3478/tcp comment 'coturn STUN/TURN TCP' || true
ufw allow 3478/udp comment 'coturn STUN/TURN UDP' || true
ufw allow 5349/tcp comment 'coturn TURNS TLS' || true
ufw allow 49152:65535/udp comment 'WebRTC Media Relay UDP' || true
echo "y" | ufw enable || true
echo -e "${GREEN}[✓] Firewall configured.${NC}"

# Free Port 2083 if occupied by LiteSpeed / cPanel
fuser -k $APP_PORT/tcp 2>/dev/null || true
kill -9 $(lsof -t -i:$APP_PORT) 2>/dev/null || true

# Step 9: Start / Restart Application with PM2
echo -e "\n${BLUE}[*] Launching VCall with PM2 on Port $APP_PORT...${NC}"
pm2 delete vcall 2>/dev/null || true
pm2 start server/index.js --name vcall --time
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# Summary
echo -e "\n${GREEN}${BOLD}====================================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 VCall Successfully Deployed with Native HTTPS & Web Push!${NC}"
echo -e "${GREEN}${BOLD}====================================================================${NC}"
echo -e "Native HTTPS App URL : ${CYAN}${BOLD}https://$SERVER_IP:$APP_PORT${NC}"
echo -e "WebSocket WSS URL    : ${CYAN}${BOLD}wss://$SERVER_IP:$APP_PORT/ws${NC}"
echo -e "Port                 : ${YELLOW}${BOLD}$APP_PORT${NC}"
echo -e "PM2 Status           : run ${BOLD}'pm2 status'${NC}"
echo -e "Live Logs            : run ${BOLD}'pm2 logs vcall'${NC}"
echo -e "Restart App          : run ${BOLD}'pm2 restart vcall'${NC}"
echo "--------------------------------------------------------------------"
echo -e "${YELLOW}${BOLD}📌 Important Browser Note:${NC}"
echo -e "When opening https://$SERVER_IP:$APP_PORT for the first time,"
echo -e "click ${BOLD}'Advanced'${NC} -> ${BOLD}'Proceed to $SERVER_IP (unsafe)'${NC}."
echo -e "This allows WebRTC camera, mic, and Web Push notifications to run!"
echo "===================================================================="
