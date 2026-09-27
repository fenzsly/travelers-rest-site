#!/usr/bin/env bash
# Pull the latest code and restart. Run on the VPS:  sudo bash /opt/novel-site/repo/novel-site/deploy/update.sh
set -euo pipefail
cd /opt/novel-site/repo
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
cd novel-site
npm ci --omit=dev
chown -R novels:novels /opt/novel-site
systemctl restart novel-site
echo "Updated and restarted. Logs: journalctl -u novel-site -f"
