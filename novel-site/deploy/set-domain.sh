#!/usr/bin/env bash
# Point the site at a new main domain, optionally redirecting old domains to it. Run on the server:
#   sudo bash /opt/novel-site/repo/novel-site/deploy/set-domain.sh travellermtl.com wutheringwaves.in
# The first domain becomes the main address (with HTTPS); www.<domain> and every other domain listed
# redirect to it permanently, so old links and search results keep working.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run as root (sudo)."; exit 1; fi
if [[ $# -lt 1 ]]; then echo "Usage: set-domain.sh newdomain.com [old-domain.com ...]"; exit 1; fi

MAIN="$(echo "$1" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"
shift
OLD=()
for d in "$@"; do OLD+=("$(echo "$d" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')"); done

valid() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; }
valid "$MAIN" || { echo "\"$MAIN\" doesn't look like a domain name."; exit 1; }
for d in "${OLD[@]}"; do valid "$d" || { echo "\"$d\" doesn't look like a domain name."; exit 1; }; done

REDIRECTS="www.$MAIN"
for d in "${OLD[@]}"; do [[ "$d" != "$MAIN" ]] && REDIRECTS="$REDIRECTS, $d, www.$d"; done

[[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
cat > /etc/caddy/Caddyfile <<CADDY
$MAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}

$REDIRECTS {
	redir https://$MAIN{uri} permanent
}
CADDY

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

# Make links in feeds/sitemaps use the main domain even when reached another way.
UNIT=/etc/systemd/system/novel-site.service
if [[ -f "$UNIT" ]]; then
  sed -i '/^Environment=PUBLIC_URL=/d' "$UNIT"
  sed -i "/^\[Service\]/a Environment=PUBLIC_URL=https://$MAIN" "$UNIT"
  systemctl daemon-reload
  systemctl restart novel-site
fi

echo
echo "Done. Main address: https://$MAIN"
echo "Redirecting to it: $REDIRECTS"
echo "HTTPS certificates are issued automatically once each domain's DNS points to this server."
