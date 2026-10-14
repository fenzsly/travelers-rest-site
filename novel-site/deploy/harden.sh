#!/usr/bin/env bash
# Lock down the server. Safe to run more than once. Run on the VPS as root:
#   bash /opt/novel-site/repo/novel-site/deploy/harden.sh
#
# What it does:
#  - Firewall (ufw): only SSH (22), HTTP (80) and HTTPS (443) are reachable from the internet.
#  - fail2ban: anyone who gets the SSH password wrong 5 times is banned for 1 hour.
#  - Automatic security updates for Ubuntu.
#  - SSH: fewer guesses per connection; password logins are turned off ONLY if you already
#    set up an SSH key (so you can't lock yourself out).
#  - The site's service runs in a sandbox, and its data files are readable only by the site.
#  - Login cookies are HTTPS-only.
#  - Flood (DDoS) protection: kernel SYN-flood defences, Caddy timeouts against slow connections,
#    and addresses the site bans for flooding are also blocked in the firewall for an hour.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Please run as root (or with sudo)."; exit 1; }
DATA_DIR=/var/lib/novel-site
UNIT=/etc/systemd/system/novel-site.service
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing firewall, fail2ban and automatic updates"
apt-get update -qq
apt-get install -y -qq ufw fail2ban unattended-upgrades >/dev/null

echo "==> Firewall: allow only SSH, HTTP and HTTPS"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null  # HTTP/3
ufw --force enable >/dev/null
ufw status | sed 's/^/   /'

echo "==> fail2ban: ban SSH password guessers"
cat > /etc/fail2ban/jail.d/novel-site.conf <<'JAIL'
[sshd]
enabled  = true
maxretry = 5
findtime = 10m
bantime  = 1h
JAIL
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban

echo "==> Firewall bans for addresses the site catches flooding"
touch "$DATA_DIR/blocked.log" 2>/dev/null && chown novels:novels "$DATA_DIR/blocked.log" 2>/dev/null || true
cat > /etc/fail2ban/filter.d/novel-site-flood.conf <<'FILTER'
[Definition]
failregex = BLOCK <HOST>\s*$
datepattern = {^LN-BEG}%%Y-%%m-%%dT%%H:%%M:%%S
FILTER
if [[ -f $DATA_DIR/blocked.log ]]; then
  cat >> /etc/fail2ban/jail.d/novel-site.conf <<JAIL

[novel-site-flood]
enabled  = true
filter   = novel-site-flood
logpath  = $DATA_DIR/blocked.log
port     = http,https
maxretry = 1
findtime = 1h
bantime  = 1h
JAIL
fi
cat > /etc/logrotate.d/novel-site <<ROTATE
$DATA_DIR/blocked.log {
	weekly
	rotate 4
	compress
	missingok
	notifempty
	copytruncate
}
ROTATE
systemctl restart fail2ban

echo "==> Kernel protection against connection floods"
cat > /etc/sysctl.d/90-novel-site.conf <<'SYSCTL'
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_synack_retries = 2
net.core.somaxconn = 4096
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
SYSCTL
sysctl --system >/dev/null

if [[ -f /etc/caddy/Caddyfile ]] && command -v caddy >/dev/null; then
  echo "==> Caddy: timeouts against slow-connection attacks, real visitor IPs"
  bash "$(dirname "$0")/caddy-protect.sh" || true
fi

echo "==> Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT

echo "==> SSH settings"
mkdir -p /etc/ssh/sshd_config.d
{
  echo "MaxAuthTries 4"
  echo "LoginGraceTime 30"
  echo "X11Forwarding no"
  if [[ -s /root/.ssh/authorized_keys ]]; then
    echo "PasswordAuthentication no"
    echo "KbdInteractiveAuthentication no"
    echo "PermitRootLogin prohibit-password"
    KEYS=1
  fi
} > /etc/ssh/sshd_config.d/90-novel-site.conf
sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
if [[ -n "${KEYS:-}" ]]; then
  echo "   SSH key found: password logins are now OFF (log in with your key)."
else
  echo "   No SSH key set up, so password logins stay on (protected by fail2ban)."
  echo "   Tip: set up a key from your Mac, then run this script again to turn passwords off."
fi

echo "==> Site data: readable only by the site"
if [[ -d $DATA_DIR ]]; then
  chown -R novels:novels "$DATA_DIR"
  chmod 750 "$DATA_DIR"
  find "$DATA_DIR" -maxdepth 1 -type f \( -name '*.db*' -o -name 'secret.key' -o -name 'session-secret' \) -exec chmod 600 {} +
fi

if [[ -f $UNIT ]]; then
  echo "==> Sandboxing the site's service"
  mkdir -p /etc/systemd/system/novel-site.service.d
  cat > /etc/systemd/system/novel-site.service.d/hardening.conf <<'SANDBOX'
[Service]
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
UMask=0027
SANDBOX
  if grep -q '^Environment=PUBLIC_URL=https://' "$UNIT"; then
    sed -i '/^Environment=COOKIE_SECURE=/d' "$UNIT"
    sed -i "/^\[Service\]/a Environment=COOKIE_SECURE=1" "$UNIT"
  fi
  systemctl daemon-reload
  systemctl restart novel-site
  sleep 2
  systemctl is-active --quiet novel-site && echo "   Site restarted OK." || { echo "   The site didn't start; undoing the sandbox."; rm -f /etc/systemd/system/novel-site.service.d/hardening.conf; systemctl daemon-reload; systemctl restart novel-site; }
fi

echo
echo "Done. Your server is hardened."
echo "IMPORTANT: if you ever shared the root password, change it now by typing:  passwd"
