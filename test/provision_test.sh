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

# Defaults and the cost reminder, against a fake hcloud that records state in $T/fake3 and a fixed
# price list (fetch_pricing is redefined after sourcing, so nothing goes to the network).
F3="$T/fake3"; mkdir -p "$F3" "$T/bin3"
cat >"$T/bin3/hcloud" <<S
#!/usr/bin/env bash
F="$ROOT/test/fixtures"; D="$F3"
S
cat >>"$T/bin3/hcloud" <<'S'
echo "$*" >>"$D/calls"
case "$1 $2" in
  "location describe") jq -e --arg n "$3" '.[] | select(.name == $n)' "$F/locations-2026-10-18.json" ;;
  "server-type describe") jq -e --arg n "$3" '.[] | select(.name == $n)' "$F/server-types-2026-10-18.json" ;;
  "server describe") [[ -f "$D/server" ]] || exit 1; echo '{"id":42}' ;;
  "volume describe") [[ -f "$D/volume" ]] || exit 1; echo '{"linux_device":"/dev/disk/by-id/scsi-0HC_Volume_1"}' ;;
  "firewall describe") [[ -f "$D/firewall" ]] || exit 1; echo '{"applied_to":[]}' ;;
  "volume list") echo '[]' ;;
  "firewall create") touch "$D/firewall" ;;
  "firewall replace-rules") : ;;
  "volume create") touch "$D/volume" ;;
  "server create") touch "$D/server" ;;
  "server ip") echo 198.51.100.7 ;;
  *) echo "fake hcloud: unexpected $*" >&2; exit 2 ;;
esac
S
chmod +x "$T/bin3/hcloud"
# cpx42 fsn1: 0.1314/h, 81.99/mo; IPv4 0.001/h, 0.6/mo; 1000 GB x 0.0484/GB/mo = 48.4/mo -> 48.4 x 0.1314 / 81.99
# = 0.077567/h. Total 0.209967/h (shown 0.2100), 130.99/mo; 24 h x 0.209967 = 5.04 <= 8.
cat >"$T/pricing.json" <<'J'
{"pricing":{"currency":"USD","primary_ips":[{"type":"ipv4","prices":[{"location":"fsn1","price_hourly":{"gross":"0.001"},"price_monthly":{"gross":"0.6"}}]}],
 "volume":{"price_per_gb_month":{"gross":"0.0484"}}}}
J
full() {  # full RUN_DIR [ENV...]: runs main; stdout to RUN_DIR/stdout, stderr to RUN_DIR/stderr
  local d="$1"; shift; mkdir -p "$d"; rm -f "$F3"/server "$F3"/volume "$F3"/firewall
  ( env -u MAX_USD -u EXPECTED_HOURS -u MAX_WALL_SECS -u WATCHDOG_MAX_WALL_SECS -u POLL_SECS -u TEARDOWN_RESERVE_SECS -u WATCHDOG_T0 \
      PATH="$T/bin3:$PATH" HCLOUD_TOKEN=fake-not-a-token SSH_KEY=k SERVER_TYPE=cpx42 LOCATION=fsn1 VOLUME_GB=1000 \
      SSH_SOURCE_CIDRS=203.0.113.7/32 STATE_DIR="$d/state" WATCHDOG_CMD="$T/wd-good" WATCHDOG_START_WAIT=1 HOME="$T" \
      PRICING_FILE="$T/pricing.json" "$@" bash -c 'source "$1"; fetch_pricing() { cat "$PRICING_FILE"; }; main' _ "$ROOT/provision.sh" ) >"$d/stdout" 2>"$d/stderr"
}
R="$T/run1"; rc=0; full "$R" || rc=$?
ok "no MAX_USD set: full fake run succeeds" '[ "$rc" = 0 ]'
ok "no MAX_USD set: watchdog receives MAX_USD=8 and the 24 h cap" 'grep -q "MAX_USD=8 wall=86400" "$R/state/watchdog.out"'
ok "no EXPECTED_HOURS set: cost guard projects 24 h against MAX_USD=8" 'grep -q "for 24 h (EXPECTED_HOURS" "$R/stderr" && grep -q "cost guard OK: projected <= MAX_USD=8" "$R/stderr"'
ok "stdout is only the IP" '[ "$(cat "$R/stdout")" = "198.51.100.7" ]'
ok "stderr has the billing reminder with rate, monthly cap and teardown command" 'grep -qF "[provision] Billing now: \$0.2100/h, at most \$130.99/mo. Stop it: CONFIRM=\"snapchain-read-node\" ./teardown.sh" "$R/stderr"'
ok "stderr names the watchdog deadline and the real disarm file" 'grep -q "Watchdog deletes everything by [0-9][0-9]:[0-9][0-9] .* on [0-9]* [A-Z][a-z][a-z] (time cap, 24 h 0 m after it started at" "$R/stderr" && grep -qF "unless you disarm it: touch $R/state/watchdog.disarm" "$R/stderr"'
ok "no 'about' in the reminder" '! grep -E "Billing now|Watchdog deletes" "$R/stderr" | grep -qi about'
# deadline arithmetic (sourced, fixed T0 epoch 1000000, default POLL_SECS=60, TEARDOWN_RESERVE_SECS=900)
dl() { env -u POLL_SECS -u TEARDOWN_RESERVE_SECS -u MAX_WALL_SECS -u WATCHDOG_MAX_WALL_SECS MAX_USD=8 RATE_H="$1" \
  bash -c 'source "$1"; COST_RATE_H="$RATE_H"; watchdog_deadline 1000000' _ "$ROOT/provision.sh"; }
ok "deadline: 0.21/h with MAX_USD=8 hits the 24 h time cap first (T0 + 86400 s + 60 s poll)" '[ "$(dl 0.21)" = "1086460 time" ]'
ok "deadline: 0.33/h with MAX_USD=8 hits the budget at 25 started hours (T0 + 25 h - 4559 s + 60 s poll)" '[ "$(dl 0.33)" = "1085501 budget" ]'
R="$T/run2"; rc=0; full "$R" WATCHDOG=0 || rc=$?
ok "WATCHDOG=0: billing reminder, no watchdog deadline line" '[ "$rc" = 0 ] && grep -q "Billing now" "$R/stderr" && ! grep -q "Watchdog deletes" "$R/stderr" && [ "$(cat "$R/stdout")" = "198.51.100.7" ]'

# Edge cases of the cost reminder and the watchdog start (all against the fake hcloud above).
nocreate() { ! grep -q create "$F3/calls" 2>/dev/null; }
for c in EUR CHF; do sed "s/\"USD\"/\"$c\"/" "$T/pricing.json" >"$T/pricing-$c.json"; done
R="$T/eur"; rc=0; full "$R" PRICING_FILE="$T/pricing-EUR.json" || rc=$?
ok "EUR account: reminder uses the euro sign" '[ "$rc" = 0 ] && grep -qF "Billing now: €0.2100/h, at most €130.99/mo." "$R/stderr" && [ "$(cat "$R/stdout")" = "198.51.100.7" ]'
R="$T/eur5"; rc=0; full "$R" PRICING_FILE="$T/pricing-EUR.json" MAX_USD=5 || rc=$?
ok "EUR account: MAX_USD is compared in the account currency (5.04 > 5 refuses)" '[ "$rc" != 0 ] && grep -q "exceeds MAX_USD=5" "$R/stderr" && [ ! -s "$R/stdout" ]'
R="$T/chf"; rc=0; full "$R" PRICING_FILE="$T/pricing-CHF.json" || rc=$?
ok "unknown currency code: shown as a code before the amount" '[ "$rc" = 0 ] && grep -qF "Billing now: CHF 0.2100/h, at most CHF 130.99/mo." "$R/stderr"'
jq 'del(.pricing.primary_ips)' "$T/pricing.json" >"$T/pricing-noip.json"
R="$T/noip"; rc=0; full "$R" PRICING_FILE="$T/pricing-noip.json" || rc=$?
ok "no IPv4 price in the list: counted as 0, run still completes" '[ "$rc" = 0 ] && grep -qF "Billing now: \$0.2090/h, at most \$130.39/mo." "$R/stderr" && [ "$(cat "$R/stdout")" = "198.51.100.7" ]'
R="$T/dry"; rc=0; full "$R" DRY_RUN=1 || rc=$?
ok "DRY_RUN=1: stdout is only the placeholder IP, reminder says nothing is billing" '[ "$rc" = 0 ] && [ "$(cat "$R/stdout")" = "203.0.113.10" ] && grep -q "nothing is billing" "$R/stderr" && ! grep -q "Billing now" "$R/stderr"'
rm -f "$F3/calls"; R="$T/est"; rc=0; full "$R" ESTIMATE_ONLY=1 || rc=$?
ok "ESTIMATE_ONLY=1: estimate only, no 'Billing now', empty stdout, nothing created" '[ "$rc" = 0 ] && grep -q "projected   ~5.04 for 24 h" "$R/stderr" && ! grep -q "Billing now" "$R/stderr" && [ ! -s "$R/stdout" ] && nocreate'
R="$T/w48"; rc=0; full "$R" WATCHDOG_MAX_WALL_SECS=172800 || rc=$?
ok "WATCHDOG_MAX_WALL_SECS=172800 at 0.21/h: the MAX_USD=8 budget fires first and the line says so" '[ "$rc" = 0 ] && grep -q "after 48 h even" "$R/stderr" && grep -qF "(budget cap MAX_USD=8 at \$0.2100/h, every started hour counted; time cap would be" "$R/stderr"'
R="$T/poll"; rc=0; full "$R" POLL_SECS=300 || rc=$?
ok "custom POLL_SECS is named in the reminder" '[ "$rc" = 0 ] && grep -q "checked every 300 s" "$R/stderr"'
R="$T/tiny"; rc=0; full "$R" MAX_USD=0.5 EXPECTED_HOURS=2 || rc=$?
ok "small MAX_USD: budget cap named as the deadline" '[ "$rc" = 0 ] && grep -q "(budget cap MAX_USD=0.5 at" "$R/stderr"'
rm -f "$F3/calls"; R="$T/tiny2"; rc=0; full "$R" MAX_USD=0.3 EXPECTED_HOURS=1 || rc=$?
ok "MAX_USD below the watchdog's fallback rate: refused before anything is created" '[ "$rc" != 0 ] && grep -q "must be above the watchdog.s FALLBACK_RATE" "$R/stderr" && nocreate && [ ! -s "$R/stdout" ]'
t0=$(( $(date +%s) - 3600 )); R="$T/t0"; rc=0; full "$R" WATCHDOG_T0="$t0" || rc=$?
ok "WATCHDOG_T0 an hour ago: deadline counts from it" '[ "$rc" = 0 ] && grep -qF "after it started at $(bash -c "source \"$ROOT/provision.sh\"; fmt_epoch $t0"))" "$R/stderr"'
rm -f "$F3/calls"; R="$T/t0old"; rc=0; full "$R" WATCHDOG_T0="$(( $(date +%s) - 90000 ))" || rc=$?
ok "WATCHDOG_T0 past the 24 h cap: refused before anything is created" '[ "$rc" != 0 ] && grep -q "would delete everything at its first check" "$R/stderr" && nocreate'
R="$T/t0bad"; rc=0; full "$R" WATCHDOG_T0=abc || rc=$?
ok "WATCHDOG_T0 not a number: refused in preflight" '[ "$rc" != 0 ] && grep -q "WATCHDOG_T0 must be a Unix time" "$R/stderr"'
R="$T/running"; sw "$R/state" "$T/wd-good" >/dev/null; t0=$(( $(date +%s) - 7200 )); touch -d "@$t0" "$R/state/watchdog.pid"
rc=0; full "$R" || rc=$?
ok "watchdog already running: deadline counts from its pid file's mtime" '[ "$rc" = 0 ] && grep -q "already running" "$R/stderr" && grep -qF "after it started at $(bash -c "source \"$ROOT/provision.sh\"; fmt_epoch $t0"))" "$R/stderr"'
kill "$(cat "$R/state/watchdog.pid")" 2>/dev/null || true
ok "deadline: POLL_SECS=300 moves the time-cap deadline by one poll" '[ "$(env -u TEARDOWN_RESERVE_SECS -u MAX_WALL_SECS -u WATCHDOG_MAX_WALL_SECS POLL_SECS=300 MAX_USD=8 bash -c "source \"$ROOT/provision.sh\"; COST_RATE_H=0.21; watchdog_deadline 1000000")" = "1086700 time" ]'
ok "deadline: exactly 0.5/h x 16 h = MAX_USD 8 counts as reaching it (T0 + 16 h - 4559 s + 60 s)" '[ "$(dl 0.5)" = "1053101 budget" ]'
if locale -a 2>/dev/null | grep -qi '^de_DE.utf'; then
  R="$T/lc"; rc=0; full "$R" LC_ALL=de_DE.UTF-8 || rc=$?
  ok "comma-decimal locale (de_DE): amounts still printed with a point" '[ "$rc" = 0 ] && grep -qF "Billing now: \$0.2100/h, at most \$130.99/mo." "$R/stderr" && ! grep -q "invalid number" "$R/stderr"'
fi
if date -d @0 >/dev/null 2>&1 && stat -c %Y / >/dev/null 2>&1; then  # GNU host: simulate macOS date/stat
  mkdir -p "$T/bsd" "$T/nodate"; gd="$(command -v date)"; gs="$(command -v stat)"
  printf '#!/bin/sh\ncase "$1" in -d) exit 1;; -r) exec %s -d "@$2" "$3";; *) exec %s "$@";; esac\n' "$gd" "$gd" >"$T/bsd/date"
  printf '#!/bin/sh\ncase "$1" in -f) [ "$2" = %%m ] && exec %s -c %%Y "$3";; esac\nexit 1\n' "$gs" >"$T/bsd/stat"
  printf '#!/bin/sh\ncase "$1" in -d|-r) exit 1;; *) exec %s "$@";; esac\n' "$gd" >"$T/nodate/date"
  chmod +x "$T/bsd/date" "$T/bsd/stat" "$T/nodate/date"
  R="$T/running2"; sw "$R/state" "$T/wd-good" >/dev/null; t0=$(( $(date +%s) - 7200 )); touch -d "@$t0" "$R/state/watchdog.pid"
  rc=0; full "$R" PATH="$T/bsd:$T/bin3:$PATH" || rc=$?
  ok "macOS date -r / stat -f fallbacks give the same deadline line" '[ "$rc" = 0 ] && grep -qF "after it started at $(bash -c "source \"$ROOT/provision.sh\"; fmt_epoch $t0"))" "$R/stderr" && [ "$(cat "$R/stdout")" = "198.51.100.7" ]'
  kill "$(cat "$R/state/watchdog.pid")" 2>/dev/null || true
  R="$T/nodate"; rc=0; full "$R" PATH="$T/nodate:$T/bin3:$PATH" || rc=$?
  ok "no date that can format an epoch: reminder degrades, stdout is still the IP" '[ "$rc" = 0 ] && grep -q "Watchdog deletes everything by Unix time" "$R/stderr" && [ "$(cat "$R/stdout")" = "198.51.100.7" ]'
fi
kill "$(cat "$T/run1/state/watchdog.pid" 2>/dev/null)" 2>/dev/null || true
for f in "$T"/*/state/watchdog.pid; do kill "$(cat "$f")" 2>/dev/null || true; done

echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
