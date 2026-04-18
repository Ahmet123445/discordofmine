#!/bin/bash
# Discordofmine recovery script.
# Run this on the server as root via: sudo bash recover.sh
# Tested on Ubuntu 24.04 with pre-existing /opt/discordofmine tree.

set +e  # keep going even if a step fails so we get full output

log() { printf '\n\e[1;36m[recover]\e[0m %s\n' "$*"; }
ok()  { printf '\e[1;32m[ok]\e[0m %s\n' "$*"; }
warn(){ printf '\e[1;33m[warn]\e[0m %s\n' "$*"; }
err() { printf '\e[1;31m[err]\e[0m %s\n' "$*"; }

if [ "$(id -u)" != "0" ]; then
  err "Must run as root. Try: sudo bash $0"
  exit 1
fi

# ---------- 1. Fix systemctl permissions ----------
log "1. Fixing /usr/bin/systemctl permissions"
chmod 755 /usr/bin/systemctl
ls -l /usr/bin/systemctl
ok "systemctl ownership/permissions restored"

# ---------- 2. Unban our IP from fail2ban ----------
log "2. Clearing fail2ban bans (so cloud assistant can reconnect)"
if command -v fail2ban-client >/dev/null 2>&1; then
  fail2ban-client status sshd 2>&1 | head
  fail2ban-client unban --all 2>&1 || warn "unban --all failed (may be older fail2ban)"
  # Older fail2ban versions do not have 'unban --all'; fall back to set unbanip for each
  fail2ban-client status sshd 2>&1 | awk -F: '/Banned IP list/ {print $2}' | tr ',' '\n' | while read -r ip; do
    ip=$(echo "$ip" | xargs)
    [ -n "$ip" ] && fail2ban-client set sshd unbanip "$ip" 2>/dev/null
  done
  ok "fail2ban bans cleared"
else
  warn "fail2ban-client not installed"
fi

# ---------- 3. Reinstall PM2 ----------
log "3. Reinstalling pm2 globally via npm"
which node; node -v
npm install -g pm2 --silent
hash -r
if command -v pm2 >/dev/null 2>&1; then
  ok "pm2 installed: $(pm2 --version)"
else
  err "pm2 install failed"
fi

# ---------- 4. Start nginx ----------
log "4. Starting nginx"
systemctl enable nginx 2>&1 | tail -3
systemctl start nginx
systemctl is-active nginx && ok "nginx running" || err "nginx failed to start"

# ---------- 5. Start the two node apps via PM2 ----------
log "5. Starting discord-server and discord-client via pm2"

# discord-server: /opt/discordofmine/server/index.js
if [ -f /opt/discordofmine/server/index.js ]; then
  cd /opt/discordofmine/server
  pm2 delete discord-server 2>/dev/null
  pm2 start index.js --name discord-server --time
  ok "discord-server started"
else
  err "/opt/discordofmine/server/index.js not found"
fi

# discord-client: npm start -- -p 3002 in /opt/discordofmine/client
if [ -d /opt/discordofmine/client ]; then
  cd /opt/discordofmine/client
  pm2 delete discord-client 2>/dev/null
  pm2 start npm --name discord-client --time -- start -- -p 3002
  ok "discord-client started"
else
  err "/opt/discordofmine/client not found"
fi

pm2 save
# ---------- 6. PM2 startup autostart ----------
log "6. Re-enabling pm2 autostart at boot"
pm2 startup systemd -u root --hp /root | tail -5
pm2 save
ok "pm2 startup re-registered"

# ---------- 7. Quick verification ----------
log "7. Verification"
echo "--- pm2 list ---"
pm2 list --no-colors
echo "--- listeners ---"
ss -tlnp | grep -E ':(80|443|3001|3002)\b' | head
echo "--- backend /health ---"
curl -sS -o /dev/null -w 'backend_http=%{http_code} time=%{time_total}\n' http://127.0.0.1:3001/health --max-time 5
echo "--- frontend / ---"
curl -sS -o /dev/null -w 'frontend_http=%{http_code} time=%{time_total}\n' http://127.0.0.1:3002/ --max-time 10
echo "--- nginx external https ---"
curl -sS -o /dev/null -w 'external_https=%{http_code} time=%{time_total}\n' https://167.86.99.131.nip.io/health --max-time 10 --resolve 167.86.99.131.nip.io:443:127.0.0.1

log "Done. Check pm2 logs if any app is not online:"
echo "  pm2 logs discord-server --lines 40"
echo "  pm2 logs discord-client --lines 40"
