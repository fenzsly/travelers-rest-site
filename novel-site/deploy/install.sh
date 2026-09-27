#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu 22.04/24.04 VPS (e.g. Contabo).
#
#   curl -fsSL https://raw.githubusercontent.com/fenzsly/travelers-rest-site/main/novel-site/deploy/install.sh | sudo bash -s -- yourdomain.com
#
# Installs Node.js 22 + Caddy (automatic HTTPS), runs the site as a systemd service,
# and sets up nightly backups. Safe to re-run.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/fenzsly/travelers-rest-site.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/novel-site
DATA_DIR=/var/lib/novel-site

if [[ -z "$DOMAIN" ]]; then echo "Usage: install.sh yourdomain.com"; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)."; exit 1; fi

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg sqlite3 ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> Creating service user and folders"
id novels >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin novels
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/backups"

echo "==> Fetching the code"
if [[ -d "$APP_DIR/repo/.git" ]]; then
  git -C "$APP_DIR/repo" fetch origin "$BRANCH" && git -C "$APP_DIR/repo" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR/repo"
fi
cd "$APP_DIR/repo/novel-site"
npm ci --omit=dev
chown -R novels:novels "$APP_DIR" "$DATA_DIR"

echo "==> Creating systemd service"
cat > /etc/systemd/system/novel-site.service <<UNIT
[Unit]
Description=Novel site
After=network.target

[Service]
User=novels
WorkingDirectory=$APP_DIR/repo/novel-site
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATA_DIR=$DATA_DIR
Environment=UPLOAD_DIR=$DATA_DIR/uploads
Environment=TRUST_PROXY=1
Environment=COOKIE_SECURE=1
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now novel-site
systemctl restart novel-site

echo "==> Configuring Caddy (HTTPS for $DOMAIN)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Nightly backups (kept 14 days) in $DATA_DIR/backups"
cat > /etc/cron.daily/novel-site-backup <<CRON
#!/bin/sh
set -e
STAMP=\$(date +%F)
sqlite3 $DATA_DIR/site.db ".backup '$DATA_DIR/backups/site-\$STAMP.db'"
tar -czf $DATA_DIR/backups/uploads-\$STAMP.tar.gz -C $DATA_DIR uploads
find $DATA_DIR/backups -type f -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/novel-site-backup

echo
echo "Done! Open https://$DOMAIN/admin to create your owner account."
echo "(Make sure your domain's DNS A record points to this server's IP first.)"
