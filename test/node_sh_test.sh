#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2009  # bash -c bodies use positional args on purpose; ps|grep avoids pgrep self-match
# SPDX-License-Identifier: MIT
# Local tests for node.sh. No VM, no Docker, no real Snapchain network: uses fixtures,
# a local mock HTTP server, and a fake `docker` + fake bootstrap script.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
FIX="$HERE/fixtures"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

TMP="$(mktemp -d)"; MOCK_PID=""
cleanup() { if [[ -n "$MOCK_PID" ]]; then kill "$MOCK_PID" 2>/dev/null || true; fi; rm -rf "$TMP"; }
trap cleanup EXIT

check "shellcheck node.sh" shellcheck -x "$ROOT/node.sh"
check "bash -n node.sh" bash -n "$ROOT/node.sh"

# --- sync criterion on fixtures (docs example output = synced)
# shellcheck source=../node.sh
source "$ROOT/node.sh"
set +e
sync_status < "$FIX/info-synced.json" >/dev/null;      check "docs example /v1/info is SYNCED" test $? -eq 0
sync_status < "$FIX/info-syncing.json" >/dev/null;     check "blockDelay 3600 is SYNCING" test $? -eq 1
sync_status < "$FIX/info-empty.json" >/dev/null;       check "no shardInfos is SYNCING" test $? -eq 1
sync_status < "$FIX/info-zero-height.json" >/dev/null; check "maxHeight 0 is SYNCING" test $? -eq 1
SYNC_MAX_BLOCK_DELAY=1 sync_status < "$FIX/info-synced.json" >/dev/null; check "threshold is respected (delay 1 !< 1)" test $? -eq 1
set -e

# --- wait_for_sync + health against a local mock node
PORT=38181
python3 "$HERE/mock_node.py" "$PORT" "$FIX/info-syncing.json" "$FIX/info-synced.json" & MOCK_PID=$!
sleep 1
out="$(SNAPCHAIN_HTTP="http://127.0.0.1:$PORT" SYNC_POLL_SECS=1 SYNC_STABLE_CHECKS=2 SYNC_TIMEOUT_SECS=20 \
  SNAPCHAIN_DIR="$TMP" bash "$ROOT/node.sh" wait 2>&1)"
check "wait: reports SYNCING then 'Node is in sync.'" bash -c 'grep -q "SYNCING" <<<"$1" && grep -q "Node is in sync." <<<"$1"' _ "$out"
check "health: prints SYNCED and sample query" bash -c 'grep -q "sync: SYNCED" <<<"$1" && grep -q "castsByFid?fid=1&pageSize=1: HTTP 200" <<<"$1"' _ "$out"
out="$(SNAPCHAIN_HTTP="http://127.0.0.1:$PORT" SNAPCHAIN_DIR="$TMP" bash -s health < "$ROOT/node.sh" 2>&1)"
check "'bash -s health < node.sh' runs main" grep -q "Snapchain health check" <<<"$out"
out="$(SNAPCHAIN_HTTP="http://127.0.0.1:1" SNAPCHAIN_DIR="$TMP" bash "$ROOT/node.sh" health 2>&1)"
check "health: unreachable node reported" grep -q "NOT REACHABLE" <<<"$out"
out="$(SNAPCHAIN_HTTP="http://127.0.0.1:1" SYNC_POLL_SECS=1 SYNC_TIMEOUT_SECS=2 SNAPCHAIN_DIR="$TMP" bash "$ROOT/node.sh" wait 2>&1)"
check "wait: times out cleanly when API unreachable" grep -q "not in sync after 2s" <<<"$out"

# --- seed_env: never agrees on the user's behalf
D1="$TMP/seed1"; mkdir -p "$D1"
set +e
( SNAPCHAIN_DIR="$D1"; DRY_RUN=0; SNAPCHAIN_AGREE_NO_REWARDS=""; seed_env ) </dev/null >/dev/null 2>&1
rc=$?; set -e
check "seed_env refuses without explicit agreement" test "$rc" -ne 0
( SNAPCHAIN_DIR="$D1"; DRY_RUN=0; SNAPCHAIN_AGREE_NO_REWARDS=yes; unset OPERATOR_FID; seed_env ) </dev/null >/dev/null 2>&1
check "seed_env writes agreement, FID 0 and SKIP_CRONTAB" bash -c 'grep -qx AGREE_NO_REWARDS_FOR_ME=true "$1" && grep -qx HUB_OPERATOR_FID=0 "$1" && grep -qx SKIP_CRONTAB=true "$1"' _ "$D1/.env"
( SNAPCHAIN_DIR="$D1"; DRY_RUN=0; SNAPCHAIN_AGREE_NO_REWARDS=yes; seed_env ) </dev/null >/dev/null 2>&1
check "seed_env is idempotent (no duplicate keys)" test "$(sort "$D1/.env" | uniq -d | wc -l)" -eq 0
D2="$TMP/seed2"; mkdir -p "$D2"
( SNAPCHAIN_DIR="$D2"; DRY_RUN=0; SNAPCHAIN_AGREE_NO_REWARDS=yes; OPERATOR_FID=12345; seed_env ) </dev/null >/dev/null 2>&1
check "seed_env stores OPERATOR_FID, no SKIP_CRONTAB" bash -c 'grep -qx HUB_OPERATOR_FID=12345 "$1" && ! grep -q SKIP_CRONTAB "$1"' _ "$D2/.env"

# --- run_bootstrap with a FAKE bootstrap (pty + "Upgrade complete" + endless log follow) and FAKE docker
D3="$TMP/node"; mkdir -p "$D3" "$TMP/bin"
cat > "$TMP/fake-bootstrap.sh" <<FAKE
#!/bin/bash
# mimics the official script's tail: exec ... < /dev/tty, then follow logs forever
exec bash -c 'echo "fake upgrade"; [ -t 0 ] && echo "stdin is a tty"; touch "$D3/docker-compose.yml" "$D3/.fake_running"; echo "✅ Upgrade complete."; while true; do sleep 1; done' < /dev/tty
FAKE
cat > "$TMP/bin/docker" <<FAKE
#!/bin/bash
# fake docker: 'compose ps ... -q snapchain' prints an id once the fake bootstrap "started" it
if [[ "\$1" == compose && "\$2" == ps && -f "$D3/.fake_running" ]]; then echo abc123; fi
exit 0
FAKE
chmod +x "$TMP/bin/docker"
out="$(PATH="$TMP/bin:$PATH" SNAPCHAIN_DIR="$D3" BOOTSTRAP_URL="file://$TMP/fake-bootstrap.sh" bash -c "source '$ROOT/node.sh'; run_bootstrap" </dev/null 2>&1)"
check "run_bootstrap: completes via pty, detects 'Upgrade complete'" grep -q "Bootstrap reported 'Upgrade complete.'" <<<"$out"
check "run_bootstrap: bootstrap saw a TTY on stdin" grep -q "stdin is a tty" "$D3/node-sh-bootstrap.log"
sleep 1
leftover="$(ps -eo cmd | grep -F "fake upgrade" | grep -vc -e grep -e "ps -eo" || true)"
check "run_bootstrap: log follower stopped (no leftover fake processes)" test "$leftover" -eq 0
out="$(PATH="$TMP/bin:$PATH" SNAPCHAIN_DIR="$D3" BOOTSTRAP_URL="file:///nonexistent" bash -c "source '$ROOT/node.sh'; run_bootstrap" </dev/null 2>&1)"
check "run_bootstrap: idempotent, skips when container running" grep -q "already running; skipping" <<<"$out"
cat > "$TMP/fail-bootstrap.sh" <<'FAKE'
#!/bin/bash
echo "something broke"; exit 1
FAKE
D4="$TMP/node4"; mkdir -p "$D4"
set +e
out="$(PATH="$TMP/bin:$PATH" SNAPCHAIN_DIR="$D4" BOOTSTRAP_URL="file://$TMP/fail-bootstrap.sh" bash -c "source '$ROOT/node.sh'; run_bootstrap" </dev/null 2>&1)"; rc=$?
set -e
check "run_bootstrap: failing bootstrap -> non-zero + clear error" bash -c '[[ $1 -ne 0 ]] && grep -q "exited before" <<<"$2"' _ "$rc" "$out"

# --- DRY_RUN of the full flow (downloads the real bootstrap script text only; executes nothing)
out="$(DRY_RUN=1 SKIP_PREFLIGHT=1 SNAPCHAIN_AGREE_NO_REWARDS=yes SNAPCHAIN_DIR="$TMP/dry" bash "$ROOT/node.sh" all </dev/null 2>&1)" || true
check "DRY_RUN prints the bootstrap invocation" grep -q "\[dry-run\] script -qefc" <<<"$out"
check "DRY_RUN created nothing" test ! -e "$TMP/dry/.env"

echo; echo "passed: $PASS  failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
