#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# deploy-client.sh - build the web client locally and serve it from the node VM over HTTPS with
# Caddy (same origin as the proxied node API: no mixed content, no CORS preflight).
#
# Usage: ./deploy-client.sh <server-ip> [dns-name]
#   dns-name: a DNS A record pointing at <server-ip>. Let's Encrypt needs a name.
#             If omitted, <ip-with-dashes>.sslip.io is used (third-party wildcard DNS service;
#             see README "Assumptions"). Ports 80 and 443 must be open (provision.sh opens them).
# Env: SSH_USER=root, REMOTE_DIR=/opt/snapchain-client, DRY_RUN=1 (print only),
#      SSH_OPTS="-i key -o UserKnownHostsFile=..." (extra options for ssh/scp, word-split).
#
# No secrets are copied: only client/dist, the Caddyfile and a compose file.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IP="${1:-}"
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "usage: $0 <server-ipv4> [dns-name]" >&2; exit 1; }
SITE="${2:-${IP//./-}.sslip.io}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/opt/snapchain-client}"
DRY_RUN="${DRY_RUN:-0}"
TARGET="$SSH_USER@$IP"
# shellcheck disable=SC2206
SSH_OPTS_ARR=(${SSH_OPTS:-})
ssh() { command ssh "${SSH_OPTS_ARR[@]}" "$@"; }
scp() { command scp "${SSH_OPTS_ARR[@]}" "$@"; }

run() { if [[ "$DRY_RUN" == "1" ]]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

echo "[deploy-client] building client (npm ci, typecheck, tests, build)"
run bash -c "cd '$HERE/client' && npm ci && npm test && npm run build"

echo "[deploy-client] uploading to $TARGET:$REMOTE_DIR"
run ssh "$TARGET" "mkdir -p '$REMOTE_DIR/dist'"
run scp -q "$HERE/deploy/Caddyfile" "$TARGET:$REMOTE_DIR/Caddyfile"
run scp -q "$HERE/deploy/docker-compose.caddy.yml" "$TARGET:$REMOTE_DIR/docker-compose.yml"
run ssh "$TARGET" "rm -rf '$REMOTE_DIR/dist.new' && mkdir -p '$REMOTE_DIR/dist.new'"
run scp -q -r "$HERE/client/dist/." "$TARGET:$REMOTE_DIR/dist.new/"
run ssh "$TARGET" "cd '$REMOTE_DIR' && rm -rf dist.old && mv dist dist.old && mv dist.new dist && rm -rf dist.old \
  && printf 'SITE_ADDRESS=%s\n' '$SITE' > .env && docker compose up -d && docker compose restart caddy"

echo "[deploy-client] waiting for HTTPS on https://$SITE ..."
if [[ "$DRY_RUN" != "1" ]]; then
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 10 "https://$SITE/v1/info" >/dev/null 2>&1; then
      echo "[deploy-client] OK: https://$SITE (client) and https://$SITE/v1/info (node, proxied)"
      exit 0
    fi
    sleep 10
  done
  echo "[deploy-client] not reachable yet. Check: ssh $TARGET 'cd $REMOTE_DIR && docker compose logs caddy'" >&2
  exit 1
fi
