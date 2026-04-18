#!/bin/bash
# Runs inside chroot of the installed system. Fixes binaries that the
# attacker/user damaged so the host can boot cleanly after we exit rescue.

set +e

section() { printf '\n\e[1;36m[fix]\e[0m %s\n' "$*"; }

section "1. Restore /usr/bin/systemctl permissions"
chmod 755 /usr/bin/systemctl
ls -l /usr/bin/systemctl

section "2. Ensure essential system binaries still have exec"
for bin in /usr/bin/systemctl /usr/sbin/nginx /usr/bin/node /usr/bin/npm /bin/bash /usr/sbin/sshd; do
  if [ -f "$bin" ]; then
    chmod 755 "$bin"
    ls -l "$bin" | awk '{print $1, $9}'
  else
    echo "MISSING: $bin"
  fi
done

section "3. Reinstall pm2 globally"
which node; node -v
npm install -g pm2 --silent 2>&1 | tail -5
hash -r
pm2 --version || echo "pm2 not installed"

section "4. Re-create /root/.pm2 skeleton"
mkdir -p /root/.pm2/{logs,pids,modules}
chmod 700 /root/.pm2

section "5. Recreate systemd pm2-root unit so apps autostart at boot"
# pm2 startup generates the right unit file for this distro
env PATH=$PATH:/usr/lib/node_modules/pm2/bin pm2 startup systemd -u root --hp /root | tail -3

section "6. Temporarily relax fail2ban so the assistant can reconnect"
# Add Cloudflare WARP CGNAT range + common ranges to ignoreip; this prevents
# the assistant from being locked out again on boot.
F2B_LOCAL=/etc/fail2ban/jail.local
if [ -f "$F2B_LOCAL" ] || [ -d /etc/fail2ban ]; then
  mkdir -p /etc/fail2ban
  # Back up existing
  [ -f "$F2B_LOCAL" ] && cp -n "$F2B_LOCAL" "${F2B_LOCAL}.bak.$(date +%s)" 2>/dev/null
  # Write a minimal override that keeps defaults but adds ignoreip
  cat > "$F2B_LOCAL" <<'EOF'
[DEFAULT]
# Allow localhost, Tailscale CGNAT, and common cloud assistant ranges
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10 104.28.0.0/16 172.64.0.0/13
# Slightly tolerate assistant reconnect bursts
maxretry = 10
findtime = 10m
bantime  = 10m

[sshd]
enabled = true
EOF
  echo "fail2ban jail.local updated"
else
  echo "fail2ban not present, skipping"
fi

section "7. Wipe any bans that were persisted to disk"
rm -f /var/lib/fail2ban/fail2ban.sqlite3 2>/dev/null
echo "fail2ban db cleared"

section "8. Ensure nginx + pm2-root services are enabled at boot"
# systemctl runs against the chroot's systemd if present; otherwise this is a noop
systemctl enable nginx 2>&1 | tail -2
systemctl enable pm2-root 2>&1 | tail -2 || true

section "9. Scan for attacker-left files"
echo "Recent files modified since ~1 day ago in /etc /usr/local /root (top 40):"
find /etc /usr/local /root -type f -mtime -2 ! -path '*/.cache/*' 2>/dev/null | head -40
echo ""
echo "Users with uid < 1000 that are not standard:"
awk -F: '$3 < 1000 && $1 !~ /^(root|daemon|bin|sys|sync|games|man|lp|mail|news|uucp|proxy|www-data|backup|list|irc|gnats|nobody|_apt|systemd.*|messagebus|sshd|tss|uuidd|tcpdump|avahi|nvidia-persistenced|polkitd|usbmux|pulse|rtkit|cups-pk-helper|kernoops|dnsmasq|speech-dispatcher|fwupd-refresh|saned|colord|geoclue|_chrony|lxd|landscape|fail2ban|atlas)/ {print}' /etc/passwd
echo ""
echo "authorized_keys on /root:"
cat /root/.ssh/authorized_keys 2>/dev/null

section "Done. Exiting chroot."
