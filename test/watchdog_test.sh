#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2016,SC2034  # assertions are eval'd strings
# Local tests for watchdog.sh: fake Hetzner API (files), fake ssh, fake teardown. No network, no cloud.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }

ok "shellcheck watchdog.sh" 'shellcheck -x "$ROOT/watchdog.sh"'

# fake API: one server with an IP, cheap pricing, one 1000 GB volume
api="$T/api"; mkdir -p "$api"
echo '{"servers":[{"id":1,"server_type":{"name":"cax31"},"location":{"name":"fsn1"},"public_net":{"ipv4":{"ip":"192.0.2.10"}}}]}' >"$api/servers.json"
echo '{"volumes":[{"server":1,"name":"snapchain-read-node-data","size":1000}]}' >"$api/volumes.json"
echo '{"firewalls":[]}' >"$api/firewalls.json"
cat >"$api/pricing.json" <<'J'
{"pricing":{"currency":"USD","server_types":[{"name":"cax31","prices":[{"location":"fsn1","price_hourly":{"gross":"0.04"},"price_monthly":{"gross":"29.2"}}]}],
 "primary_ips":[{"type":"ipv4","prices":[{"location":"fsn1","price_hourly":{"gross":"0.001"}}]}],
 "volume":{"price_per_gb_month":{"gross":"0.0767"}}}}
J
cat >"$T/teardown" <<'S'
#!/bin/sh
echo "teardown called" >>"$STATE_DIR/teardown.calls"
S
chmod +x "$T/teardown"

# fake ssh: prints whatever "$T/probe.N" says, advancing one file per call (last one repeats)
cat >"$T/ssh" <<'S'
#!/bin/bash
d="$(dirname "$0")"; n=$(cat "$d/probe.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n >"$d/probe.n"
f="$d/probe.$n"; [ -f "$f" ] || f="$(ls "$d"/probe.[0-9]* | sort -t. -k2 -n | tail -1)"
cat "$f"
S
chmod +x "$T/ssh"

run_wd() {  # run_wd SECONDS [ENV...]: run the watchdog for SECONDS, then disarm it
  local secs="$1"; shift
  local sd="$T/state.$RANDOM"; mkdir -p "$sd"; rm -f "$T/probe.n"
  ( env API_STUB_DIR="$api" STATE_DIR="$sd" TEARDOWN_CMD="$T/teardown" SSH_CMD="$T/ssh" \
      POLL_SECS=1 MAX_USD=100 "$@" bash "$ROOT/watchdog.sh" ) &
  local pid=$!
  sleep "$secs"; touch "$sd/watchdog.disarm"
  for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  echo "$sd"
}

# 1. no SSH_KEY_FILE: hang check off, never tears down even with HANG_SECS=1
rm -f "$T"/probe.*; echo "" >"$T/probe.1"
sd="$(run_wd 4 HANG_SECS=1)"
ok "no SSH_KEY_FILE: hang check reported OFF" 'grep -q "hang check OFF: SSH_KEY_FILE is not set" "$sd/watchdog-run.md"'
ok "no SSH_KEY_FILE: no teardown" '[ ! -f "$sd/teardown.calls" ]'

# 2. syncing: DB size grows every poll -> no teardown with HANG_SECS=2
rm -f "$T"/probe.*; for i in 1 2 3 4 5 6 7 8; do echo "$((i * 50000000)) " >"$T/probe.$i"; done
sd="$(run_wd 6 HANG_SECS=2 SSH_KEY_FILE=/dev/null)"
ok "DB growing: no teardown" '[ ! -f "$sd/teardown.calls" ]'

# 3. at tip: DB size flat, heights grow -> no teardown
rm -f "$T"/probe.*; for i in 1 2 3 4 5 6 7 8; do echo "557000000000 $((100+i)),$((200+i)),$((300+i))" >"$T/probe.$i"; done
sd="$(run_wd 6 HANG_SECS=2 SSH_KEY_FILE=/dev/null)"
ok "heights growing, DB flat: no teardown" '[ ! -f "$sd/teardown.calls" ]'

# 4. stuck: same size and heights -> hang teardown
rm -f "$T"/probe.*; echo "557000000000 100,200,300" >"$T/probe.1"
sd="$(run_wd 6 HANG_SECS=2 SSH_KEY_FILE=/dev/null)"
ok "stuck node: hang teardown fires" '[ -f "$sd/teardown.calls" ] && grep -q "hang: no DB growth or new blocks" "$sd/watchdog-run.md"'

# 5. small DB jitter below PROGRESS_MIN_BYTES is not progress
rm -f "$T"/probe.*; for i in 1 2 3 4 5 6 7 8; do echo "$((557000000000 + i * 1000)) 100,200,300" >"$T/probe.$i"; done
sd="$(run_wd 6 HANG_SECS=2 SSH_KEY_FILE=/dev/null)"
ok "1 KB jitter is not progress: teardown fires" '[ -f "$sd/teardown.calls" ]'

# 6. SSH unreachable: warning, no teardown (default)
rm -f "$T"/probe.*; : >"$T/probe.1"
sd="$(run_wd 5 HANG_SECS=2 SSH_KEY_FILE=/dev/null)"
ok "SSH unreachable: warning logged" 'grep -q "cannot reach the VM over SSH" "$sd/watchdog-run.md"'
ok "SSH unreachable: no teardown" '[ ! -f "$sd/teardown.calls" ]'
sd="$(run_wd 5 HANG_SECS=2 SSH_KEY_FILE=/dev/null UNREACHABLE_IS_HANG=1)"
ok "UNREACHABLE_IS_HANG=1: teardown fires" '[ -f "$sd/teardown.calls" ]'

# 7. budget cap still works without SSH_KEY_FILE
rm -f "$T"/probe.*; echo "" >"$T/probe.1"
sd="$(run_wd 4 MAX_USD=0.01)"
ok "budget cap: teardown fires" '[ -f "$sd/teardown.calls" ] && grep -q "budget: projected" "$sd/watchdog-run.md"'
ok "run log is untracked state, not run-log.md" '[ -f "$sd/watchdog-run.md" ]'

# 8. macOS fallback: no timeout/gtimeout on PATH -> perl alarm
nb="$T/nobin"; mkdir -p "$nb"; for c in bash perl sleep env cat date jq dirname; do ln -sf "$(command -v $c)" "$nb/$c"; done
start=$(date +%s)
rc=0; PATH="$nb" bash -c 'source "$1"; detect_timeout; echo "$TIMEOUT_KIND" >"$2"; run_with_timeout 1 sleep 5' _ "$ROOT/watchdog.sh" "$T/kind" || rc=$?
ok "no GNU timeout: falls back to perl" '[ "$(cat "$T/kind")" = perl ]'
ok "perl fallback stops a hung command after 1 s" '[ "$rc" -ne 0 ] && [ $(( $(date +%s) - start )) -lt 4 ]'

# 9. HCLOUD_TOKEN missing: clear message
rc=0; out="$(env -u HCLOUD_TOKEN bash "$ROOT/watchdog.sh" 2>&1)" || rc=$?
ok "missing HCLOUD_TOKEN: exits 1 with a clear message" '[ "$rc" = 1 ] && grep -q "HCLOUD_TOKEN not set" <<<"$out"'
sd9="$T/state9"; rc=0; env -u HCLOUD_TOKEN STATE_DIR="$sd9" bash "$ROOT/watchdog.sh" >/dev/null 2>&1 || rc=$?
ok "missing HCLOUD_TOKEN: error is also written to watchdog.log" '[ "$rc" = 1 ] && grep -q "NOT RUNNING" "$sd9/watchdog.log"'

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
