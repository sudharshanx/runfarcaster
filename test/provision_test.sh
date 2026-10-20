#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2016,SC2034,SC2030,SC2031,SC2163  # assertions are eval'd strings; subshells scope the env on purpose
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

# server type and location checks against a fake hcloud that serves a real read-only listing
# (test/fixtures/*-2026-10-18.json: cax31 and cx43 not available to rent anywhere, cpx41 only in ash/hil)
mkdir -p "$T/bin"
cat >"$T/bin/hcloud" <<S
#!/usr/bin/env bash
F="$ROOT/test/fixtures"
case "\$1 \$2" in
  "server-type list") cat "\$F/server-types-2026-10-18.json" ;;
  "server-type describe") jq -e --arg n "\$3" '.[] | select(.name == \$n)' "\$F/server-types-2026-10-18.json" || exit 1 ;;
  "location list") cat "\$F/locations-2026-10-18.json" ;;
  "location describe") jq -e --arg n "\$3" '.[] | select(.name == \$n)' "\$F/locations-2026-10-18.json" || exit 1 ;;
  *) echo "fake hcloud: unexpected \$*" >&2; exit 2 ;;
esac
S
chmod +x "$T/bin/hcloud"
cst() { ( export PATH="$T/bin:$PATH" DRY_RUN=0 VOLUME_GB=1000 "$@"; source "$ROOT/provision.sh"; check_server_type; echo "picked=$SERVER_TYPE volume=$NEED_VOLUME" ) 2>&1; }

rc=0; out="$(cst SERVER_TYPE=cax31 LOCATION=fsn1)" || rc=$?
ok "cax31 not available: fails and says where it is available (nowhere)" '[ "$rc" != 0 ] && grep -q "not available in fsn1 right now" <<<"$out" && grep -q "cax31 is available now in: no location" <<<"$out"'
ok "cax31 not available: suggests types available in fsn1, cheapest first" 'grep -q "cheapest first: cpx42 (x86, 16 GB RAM, 0.1314 an hour), ccx23" <<<"$out" && grep -q "Nothing was created" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE=cpx41 LOCATION=fsn1)" || rc=$?
ok "cpx41 in fsn1: names the locations that have it (ash, hil)" '[ "$rc" != 0 ] && grep -q "cpx41 is available now in: ash, hil" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE=cpx41 LOCATION=ash)" || rc=$?
ok "LOCATION override: cpx41 in ash passes" '[ "$rc" = 0 ] && grep -q "picked=cpx41 volume=1" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE=cpx42 LOCATION=fsn1)" || rc=$?
ok "SERVER_TYPE override: cpx42 in fsn1 passes and adds a volume" '[ "$rc" = 0 ] && grep -q "picked=cpx42 volume=1" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE= LOCATION=fsn1)" || rc=$?
ok "auto-pick skips unavailable types and picks cpx42" '[ "$rc" = 0 ] && grep -q "skipping cax31" <<<"$out" && grep -q "picked=cpx42" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE= SERVER_TYPE_CANDIDATES="cx43 cax31" LOCATION=fsn1)" || rc=$?
ok "auto-pick with nothing available: lists what is available" '[ "$rc" != 0 ] && grep -q "none of \[cx43 cax31\] is usable in fsn1" <<<"$out" && grep -q "cheapest first: cpx42" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE=cpx42 LOCATION=fsn9)" || rc=$?
ok "unknown LOCATION: fails and lists the locations" '[ "$rc" != 0 ] && grep -q "unknown LOCATION=fsn9. Hetzner locations: fsn1, nbg1, hel1, ash, hil, sin" <<<"$out"'
rc=0; out="$(cst SERVER_TYPE=cx22 LOCATION=fsn1)" || rc=$?
ok "unknown server type: plain error, no hint" '[ "$rc" != 0 ] && grep -q "server type cx22: unknown server type" <<<"$out"'

# Shared-project guards against a fake hcloud whose answers come from files in $T/proj
P="$T/proj"; mkdir -p "$P" "$T/bin2"
cat >"$T/bin2/hcloud" <<S
#!/usr/bin/env bash
P="$P"
S
cat >>"$T/bin2/hcloud" <<'S'
case "$1 $2" in
  "server describe"|"volume describe") [[ -f "$P/$1.$3" ]] || exit 1; cat "$P/$1.$3" ;;
  "firewall describe") [[ -f "$P/firewall.$3" ]] || exit 1; cat "$P/firewall.$3" ;;
  "volume list") cat "$P/volumes.json" 2>/dev/null || echo '[]' ;;
  *) echo "fake hcloud: unexpected $*" >&2; exit 2 ;;
esac
S
chmod +x "$T/bin2/hcloud"
ge() { ( export PATH="$T/bin2:$PATH" "$@"; source "$ROOT/provision.sh"; guard_existing && echo GUARD-PASSED ) 2>&1; }
echo '{"id":1}' >"$P/server.snapchain-read-node"
rc=0; out="$(ge)" || rc=$?
ok "server with the same name exists: refuses, says nothing was changed" '[ "$rc" != 0 ] && grep -q "already has: server snapchain-read-node" <<<"$out" && grep -q "Nothing was created or changed" <<<"$out" && grep -q "empty Hetzner project" <<<"$out"'
rc=0; out="$(ge REUSE=1)" || rc=$?
ok "REUSE=1 continues with it" '[ "$rc" = 0 ] && grep -q "GUARD-PASSED" <<<"$out"'
rm -f "$P/server.snapchain-read-node"; echo '{"applied_to":[]}' >"$P/firewall.snapchain-read-node-fw"
rc=0; out="$(ge)" || rc=$?
ok "leftover firewall not applied to any server: reused without REUSE" '[ "$rc" = 0 ] && grep -q "GUARD-PASSED" <<<"$out"'
echo '{"applied_to":[{"type":"server"}]}' >"$P/firewall.snapchain-read-node-fw"
rc=0; out="$(ge)" || rc=$?
ok "firewall applied to a server: refuses" '[ "$rc" != 0 ] && grep -q "applied to 1 server" <<<"$out"'
rm -f "$P/firewall.snapchain-read-node-fw"
rc=0; out="$(ge NAME=snapchain-read-node-2)" || rc=$?
ok "another NAME in the same project: passes" '[ "$rc" = 0 ]'
vq() { ( export PATH="$T/bin2:$PATH" "$@"; source "$ROOT/provision.sh"; NEED_VOLUME=1; check_volume_quota && echo QUOTA-OK ) 2>&1; }
echo '[{"size":1000}]' >"$P/volumes.json"
rc=0; out="$(vq VOLUME_GB=1000)" || rc=$?
ok "1000 GB volume already in the project + 1000 GB: stops before creating anything" '[ "$rc" != 0 ] && grep -q "already use 1000 GB" <<<"$out" && grep -q "Nothing was created" <<<"$out"'
rc=0; out="$(vq VOLUME_GB=20)" || rc=$?
ok "a volume that fits the quota passes" '[ "$rc" = 0 ] && grep -q QUOTA-OK <<<"$out"'
rc=0; out="$(vq VOLUME_GB=1000 VOLUME_QUOTA_GB=4096)" || rc=$?
ok "a raised VOLUME_QUOTA_GB passes" '[ "$rc" = 0 ]'
rc=0; out="$( ( export ESTIMATE_ONLY=1 DRY_RUN=1; source "$ROOT/provision.sh"; preflight ) 2>&1 )" || rc=$?
ok "price check (ESTIMATE_ONLY) does not warn about SSH" '[ "$rc" = 0 ] && ! grep -q "open to the whole internet" <<<"$out"'
rc=0; out="$(sw2() { ( export STATE_DIR="$T/state9" WATCHDOG_CMD="$T/wd-good" WATCHDOG_START_WAIT=1 MAX_USD=5 HOME="$T" MAX_WALL_SECS=7200; source "$ROOT/provision.sh"; start_watchdog ) 2>&1; }; sw2)" || rc=$?
ok "MAX_WALL_SECS on provision.sh reaches the watchdog" 'grep -q "wall=7200" "$T/state9/watchdog.out" && grep -q "after 2 h even" <<<"$out"'

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
