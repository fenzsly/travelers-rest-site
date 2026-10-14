#!/usr/bin/env bash
# Use Cloudflare (free plan) in front of the site, the real protection against big DDoS floods.
# First set up Cloudflare for your domain (orange cloud ON for the A record), then on the server:
#
#   sudo bash /opt/novel-site/repo/novel-site/deploy/cloudflare.sh on travellermtl.com
#       Trust Cloudflare to tell us each visitor's real IP address.
#   sudo bash /opt/novel-site/repo/novel-site/deploy/cloudflare.sh on travellermtl.com --lock
#       Also lock the firewall so ONLY Cloudflare can reach the website. Attackers who know the
#       server's IP address can then no longer go around Cloudflare. (SSH is not affected.)
#   sudo bash /opt/novel-site/repo/novel-site/deploy/cloudflare.sh off
#       Undo everything (do this BEFORE turning Cloudflare off, or the site becomes unreachable).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
CADDY_DIR=/etc/caddy
MODE=${1:-}
DOMAIN=${2:-}
LOCK=""
for a in "$@"; do [[ $a == --lock ]] && LOCK=1; done

FALLBACK_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
FALLBACK_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

remove_cf_firewall_rules() {
  # Delete our "allow from Cloudflare" rules (numbered from the bottom so numbers stay valid).
  ufw status numbered | grep 'cloudflare' | grep -oE '^\[ *[0-9]+\]' | tr -d '[] ' | sort -rn | while read -r n; do
    yes | ufw delete "$n" >/dev/null
  done
}

case "$MODE" in
on)
  [[ -n $DOMAIN && $DOMAIN != --lock ]] || { echo "Usage: cloudflare.sh on yourdomain.com [--lock]"; exit 1; }
  echo "==> Getting Cloudflare's address list"
  V4=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4 | tr '\n' ' ' || true)
  V6=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6 | tr '\n' ' ' || true)
  [[ -n ${V4// /} ]] || V4=$FALLBACK_V4
  [[ -n ${V6// /} ]] || V6=$FALLBACK_V6

  echo "==> Checking that $DOMAIN goes through Cloudflare"
  RESOLVED=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | head -3)
  BEHIND=$(python3 - "$RESOLVED" "$V4" <<'PY'
import ipaddress, sys
ips = sys.argv[1].split()
nets = [ipaddress.ip_network(n) for n in sys.argv[2].split()]
print("yes" if ips and all(any(ipaddress.ip_address(i) in n for n in nets) for i in ips) else "no")
PY
)
  if [[ $BEHIND != yes ]]; then
    echo "   $DOMAIN points to: ${RESOLVED:-nothing}. That isn't Cloudflare yet."
    echo "   In Cloudflare → DNS, make sure the record for $DOMAIN has the orange cloud ON, wait a few minutes, and run this again."
    [[ -n $LOCK ]] && { echo "   (Not locking the firewall, or your site would go offline.)"; exit 1; }
  else
    echo "   OK: $DOMAIN is behind Cloudflare."
  fi

  echo "==> Trusting Cloudflare for visitors' real IP addresses"
  echo "trusted_proxies static $V4 $V6" > "$CADDY_DIR/trusted-proxies.caddy"
  bash "$HERE/caddy-protect.sh"

  if [[ -n $LOCK ]]; then
    echo "==> Locking the website ports to Cloudflare only"
    remove_cf_firewall_rules
    for net in $V4 $V6; do ufw allow proto tcp from "$net" to any port 80,443 comment 'cloudflare' >/dev/null; done
    for rule in 80/tcp 443/tcp 443/udp 'Caddy' 'WWW Full'; do ufw delete allow "$rule" >/dev/null 2>&1 || true; done
    ufw reload >/dev/null
    echo "   Done. Only Cloudflare can reach ports 80/443 now. SSH works as before."
  fi
  echo
  echo "Cloudflare mode is ON."
  ;;
off)
  echo "==> Back to normal (no Cloudflare)"
  echo "# Not behind Cloudflare: no proxies are trusted." > "$CADDY_DIR/trusted-proxies.caddy"
  bash "$HERE/caddy-protect.sh"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  remove_cf_firewall_rules
  ufw reload >/dev/null
  echo "Cloudflare mode is OFF. The website ports are open to everyone again."
  ;;
*)
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
