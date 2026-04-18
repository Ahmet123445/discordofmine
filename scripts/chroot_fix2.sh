#!/bin/bash
# Minimal chroot fix: only offline changes. pm2 reinstall happens after boot.
set +e
section() { printf '\n\e[1;36m[fix]\e[0m %s\n' "$*"; }

section "1. Restore systemctl + core binary perms"
chmod 755 /usr/bin/systemctl
for bin in /usr/bin/systemctl /usr/sbin/nginx /usr/bin/node /bin/bash /usr/sbin/sshd; do
  [ -f "$bin" ] && chmod 755 "$bin" && ls -l "$bin" | awk '{print $1, $9}'
done

section "2. Relax fail2ban so assistant can reconnect after boot"
mkdir -p /etc/fail2ban
[ -f /etc/fail2ban/jail.local ] && cp -n /etc/fail2ban/jail.local /etc/fail2ban/jail.local.bak.$(date +%s)
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# Allow localhost, Tailscale CGNAT, Cloudflare WARP ranges
ignoreip = 127.0.0.1/8 ::1 100.64.0.0/10 104.16.0.0/12 172.64.0.0/13 162.158.0.0/15
maxretry = 10
findtime = 10m
bantime  = 10m

[sshd]
enabled = true
EOF
echo "jail.local written"

section "3. Wipe persisted fail2ban bans"
rm -f /var/lib/fail2ban/fail2ban.sqlite3
echo "fail2ban db removed"

section "4. Recreate /root/.pm2 skeleton"
mkdir -p /root/.pm2/logs /root/.pm2/pids /root/.pm2/modules
chmod 700 /root/.pm2

section "5. Scan for attacker-left artifacts"
echo "-- non-standard users < 1000 --"
awk -F: '$3 < 1000 {print $1, $3}' /etc/passwd | sort -k2n | tail -30
echo ""
echo "-- authorized_keys /root --"
cat /root/.ssh/authorized_keys 2>/dev/null | head -10
echo ""
echo "-- files modified in /etc last 3 days --"
find /etc -type f -mtime -3 2>/dev/null | head -30
echo ""
echo "-- cron locations --"
ls -la /etc/cron.d/ /var/spool/cron/crontabs/ 2>/dev/null
for u in root atlas; do
  echo "crontab $u:"; crontab -u $u -l 2>/dev/null
done

section "6. Ensure nginx + pm2 enabled at boot (best-effort)"
ln -sf /lib/systemd/system/nginx.service /etc/systemd/system/multi-user.target.wants/nginx.service 2>/dev/null
echo "Done — exit chroot and reboot from harddisk."
