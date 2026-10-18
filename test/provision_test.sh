#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2016,SC2034,SC2030,SC2031  # assertions are eval'd strings; subshells scope the env on purpose
# Local tests for provision.sh helpers: CIDR validation and the background watchdog start.
# No network, no cloud: provision.sh is sourced (main is not run) and watchdog.sh is a stub.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'kill $(cat "$T"/state*/watchdog.pid 2>/dev/null) 2>/dev/null || true; rm -rf "$T"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }

ok "shellcheck provision.sh" 'shellcheck -x "$ROOT/provision.sh"'

# preflight in DRY_RUN (no token needed): CIDR checks
pf() { ( export DRY_RUN=1 SSH_KEY=k SSH_SOURCE_CIDRS="$1"; source "$ROOT/provision.sh"; preflight ) 2>&1; }
rc=0; out="$(pf "/32")" || rc=$?
ok "empty IP in SSH_SOURCE_CIDRS (/32) is rejected" '[ "$rc" != 0 ] && grep -q "invalid entry" <<<"$out"'
rc=0; out="$(pf "203.0.113.7/32")" || rc=$?
ok "a single /32 passes" '[ "$rc" = 0 ]'
rc=0; out="$(pf "203.0.113.7/32,2001:db8::1/128")" || rc=$?
ok "IPv4 and IPv6 list passes" '[ "$rc" = 0 ]'

# stub watchdogs
cat >"$T/wd-good" <<'S'
#!/bin/sh
echo "$$" >"$STATE_DIR/watchdog.pid"; echo "started MAX_USD=$MAX_USD wall=$MAX_WALL_SECS key=$SSH_KEY_FILE"; exec sleep 30
S
cat >"$T/wd-bad" <<'S'
#!/bin/sh
echo "watchdog: ERROR: HCLOUD_TOKEN not set. NOT RUNNING" >&2; exit 1
S
chmod +x "$T/wd-good" "$T/wd-bad"
sw() { ( export STATE_DIR="$1" WATCHDOG_CMD="$2" WATCHDOG_START_WAIT=1 MAX_USD=5 HOME="$T"; source "$ROOT/provision.sh"; start_watchdog ) 2>&1; }

rc=0; out="$(sw "$T/state1" "$T/wd-good")" || rc=$?
ok "watchdog starts in the background and is reported" '[ "$rc" = 0 ] && grep -q "watchdog started (pid" <<<"$out" && grep -q "after 24 h even if the node is healthy" <<<"$out"'
ok "watchdog gets MAX_USD and the 24 h wall cap" 'grep -q "MAX_USD=5 wall=86400" "$T/state1/watchdog.out"'
ok "watchdog output goes to a log file, not /dev/null" '[ -s "$T/state1/watchdog.out" ]'
rc=0; out="$(sw "$T/state1" "$T/wd-good")" || rc=$?
ok "second run: does not start a second watchdog" '[ "$rc" = 0 ] && grep -q "already running" <<<"$out"'
rc=0; out="$(sw "$T/state2" "$T/wd-bad")" || rc=$?
ok "watchdog that dies (no token): provision fails loudly before creating anything" '[ "$rc" != 0 ] && grep -q "HCLOUD_TOKEN not set" <<<"$out" && grep -q "Nothing was created" <<<"$out"'
rc=0; out="$( ( export WATCHDOG=0; source "$ROOT/provision.sh"; start_watchdog ) 2>&1 )" || rc=$?
ok "WATCHDOG=0 skips it and says so" '[ "$rc" = 0 ] && grep -q "WATCHDOG=0" <<<"$out"'

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
