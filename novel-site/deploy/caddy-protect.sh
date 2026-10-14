#!/usr/bin/env bash
# Add flood protection to the existing Caddy (HTTPS) config. Safe to run more than once.
# Called by harden.sh, set-domain.sh and install.sh; you can also run it on its own:
#   sudo bash /opt/novel-site/repo/novel-site/deploy/caddy-protect.sh
#
#  - Slow-connection attacks (slowloris): clients must send their request headers within 10 seconds.
#  - The app always gets the visitor's real IP address (also behind Cloudflare, see cloudflare.sh),
#    so its rate limits and bans hit the attacker, not everyone.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
DIR=$(dirname "$CADDYFILE")
[[ -f $CADDYFILE ]] || { echo "No Caddyfile at $CADDYFILE"; exit 1; }

# Which proxies may tell us the visitor's IP: nobody by default; Cloudflare after cloudflare.sh on.
[[ -f $DIR/trusted-proxies.caddy ]] || echo "# Not behind Cloudflare: no proxies are trusted." > "$DIR/trusted-proxies.caddy"

cat > "$DIR/novel-global.caddy" <<GLOBAL
{
	servers {
		timeouts {
			read_header 10s
			read_body 10m
			idle 2m
		}
		import $DIR/trusted-proxies.caddy
		client_ip_headers CF-Connecting-IP X-Forwarded-For
	}
}
GLOBAL

cp "$CADDYFILE" "$CADDYFILE.before-protect"
TMP=$(mktemp)
{
  grep -q 'novel-global.caddy' "$CADDYFILE" || echo "import $DIR/novel-global.caddy"
  echo
  # Pass the real visitor IP to the site (replaces any X-Forwarded-For a visitor tries to fake).
  sed -E 's#^([[:space:]]*)reverse_proxy 127\.0\.0\.1:3000[[:space:]]*$#\1reverse_proxy 127.0.0.1:3000 {\n\1\theader_up X-Forwarded-For {client_ip}\n\1}#' "$CADDYFILE"
} > "$TMP"
# Collapse the blank lines that repeated runs would add.
cat -s "$TMP" | sed '/./,$!d' > "$TMP.s" && mv "$TMP.s" "$TMP"

if caddy validate --config "$TMP" --adapter caddyfile >/dev/null 2>&1; then
  cat "$TMP" > "$CADDYFILE"
  rm -f "$TMP"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
  echo "   Caddy flood protection is on."
else
  echo "   Caddy didn't accept the new settings, so nothing was changed:"
  caddy validate --config "$TMP" --adapter caddyfile 2>&1 | tail -3 | sed 's/^/   /'
  rm -f "$TMP"
  exit 1
fi
