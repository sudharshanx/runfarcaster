#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Builds the client, serves it with the real deploy/Caddyfile (HTTP on localhost) in front of a
# local fake node, and drives it with headless Chromium. Requires: caddy, python3, node, chromium.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
CADDY="${CADDY:-caddy}"
TMP="$(mktemp -d)"; PIDS=()
cleanup() { for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
# "|| exit": bash 3.2 (macOS /bin/bash) does not stop on a failing ( ... ) under set -e.
(cd "$ROOT/client" && npm run build >/dev/null) || exit
python3 "$HERE/mock_node.py" 38182 "$TMP/requests.log" & PIDS+=($!)
SITE_ADDRESS="http://127.0.0.1:18080" NODE_UPSTREAM="127.0.0.1:38182" CLIENT_ROOT="$ROOT/client/dist" \
  XDG_DATA_HOME="$TMP" XDG_CONFIG_HOME="$TMP" "$CADDY" run --config "$ROOT/deploy/Caddyfile" --adapter caddyfile >"$TMP/caddy.log" 2>&1 & PIDS+=($!)
sleep 2
E2E_LOG="$TMP/requests.log" node "$HERE/run.mjs"
