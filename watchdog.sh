#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# watchdog.sh - runs on YOUR machine (not the VM). Tracks elapsed time x live hourly price of the
# resources provision.sh created and runs teardown.sh automatically:
#   * before the projected bill would reach MAX_USD, or
#   * if the node stops making progress for HANG_SECS (see below), or
#   * at MAX_WALL_SECS wall-clock, whatever happens.
# Start it BEFORE provision.sh so billing time is never under-counted:
#
#   SSH_KEY_FILE=~/.ssh/id_ed25519 MAX_USD=5 nohup ./watchdog.sh >/dev/null 2>&1 &
#
# Progress check: every poll it SSHes to the VM and reads the size of /root/snapchain and each
# shard's block height. Progress = the database size changed by more than PROGRESS_MIN_BYTES, or
# any shard height went up. A normal sync (snapshot download, unpack, catch-up, then new blocks at
# the tip) changes one of the two every few minutes. The hang teardown fires only after HANG_SECS
# of successful probes with no progress. A probe that cannot run never counts as a hang:
#   * SSH_KEY_FILE unset, or no timeout command available: the hang check is OFF (logged once);
#     budget and wall-clock caps still apply.
#   * SSH unreachable (e.g. your IP changed and SSH_SOURCE_CIDRS no longer matches): logged as a
#     warning, no teardown. Set UNREACHABLE_IS_HANG=1 to count it as a hang anyway.
#
# Env: HCLOUD_TOKEN (required, never printed), NAME=snapchain-read-node, MAX_USD=5, WATCHDOG_T0=<epoch>,
#      POLL_SECS=60, HANG_SECS=7200, PROGRESS_MIN_BYTES=1048576, MAX_WALL_SECS=86400,
#      TEARDOWN_RESERVE_SECS=900, SSH_KEY_FILE (private key for the progress probe),
#      SSH_KEY_NAME (Hetzner ssh-key to ALSO delete after teardown; default: keep it),
#      FALLBACK_RATE=0.35 (per hour, used if pricing cannot be read), UNREACHABLE_IS_HANG=0,
#      RUN_LOG (markdown log to append to; default .provision-state/watchdog-run.md, untracked).
# MAX_USD is compared in your Hetzner account's currency (the API's pricing.currency), USD or EUR.
# Stop it cleanly (no teardown): touch .provision-state/watchdog.disarm
#
# Billing model (conservative): every started hour is billed in full, for server + IPv4 + volume.

set -euo pipefail
set +x
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${NAME:-snapchain-read-node}"
MAX_USD="${MAX_USD:-5}"
POLL_SECS="${POLL_SECS:-60}"
HANG_SECS="${HANG_SECS:-7200}"
PROGRESS_MIN_BYTES="${PROGRESS_MIN_BYTES:-1048576}"
MAX_WALL_SECS="${MAX_WALL_SECS:-86400}"
TEARDOWN_RESERVE_SECS="${TEARDOWN_RESERVE_SECS:-900}"
FALLBACK_RATE="${FALLBACK_RATE:-0.35}"
UNREACHABLE_IS_HANG="${UNREACHABLE_IS_HANG:-0}"
STATE_DIR="${STATE_DIR:-$HERE/.provision-state}"
RUN_LOG="${RUN_LOG:-$STATE_DIR/watchdog-run.md}"
SSH_KEY_FILE="${SSH_KEY_FILE:-}"
SSH_KEY_NAME="${SSH_KEY_NAME:-}"
TEARDOWN_CMD="${TEARDOWN_CMD:-$HERE/teardown.sh}"   # overridable for tests
SSH_CMD="${SSH_CMD:-ssh}"                           # overridable for tests
API_STUB_DIR="${API_STUB_DIR:-}"                    # tests: read API answers from files
export NAME
LOG="$STATE_DIR/watchdog.log"

ist() { TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M:%S IST'; }
log() { echo "[$(ist)] watchdog: $*" >>"$LOG"; }
runlog() { log "$*"; echo "- $(ist) **watchdog**: $*" >>"$RUN_LOG"; }

api() {  # GET from the Hetzner API without putting the token in argv
  if [[ -n "$API_STUB_DIR" ]]; then cat "$API_STUB_DIR/${1%%\?*}.json"; return; fi
  printf 'Authorization: Bearer %s\n' "$HCLOUD_TOKEN" | curl -fsS -m 30 -H @- "https://api.hetzner.cloud/v1/$1"
}

# run_with_timeout SECS CMD...: GNU timeout, Homebrew gtimeout, or perl's alarm (macOS ships perl).
TIMEOUT_KIND=""
detect_timeout() {
  if command -v timeout >/dev/null 2>&1; then TIMEOUT_KIND=timeout
  elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_KIND=gtimeout
  elif command -v perl >/dev/null 2>&1; then TIMEOUT_KIND=perl
  else TIMEOUT_KIND=""; fi
}
run_with_timeout() {
  local secs="$1"; shift
  case "$TIMEOUT_KIND" in
    timeout|gtimeout) "$TIMEOUT_KIND" "$secs" "$@" ;;
    perl) perl -e 'alarm shift @ARGV; exec @ARGV or exit 127' "$secs" "$@" ;;
    *) return 127 ;;
  esac
}

RATE="$FALLBACK_RATE"
LAST_RATE_AT=0

update_rate() {
  local pricing servers vols
  pricing="$(api pricing)" || return 1
  servers="$(api "servers?name=$NAME")" || return 1
  vols="$(api volumes)" || return 1
  local r
  r="$(jq -rn --argjson p "$pricing" --argjson s "$servers" --argjson v "$vols" --arg name "$NAME" '
    ($s.servers[0] // null) as $srv
    | if $srv == null then 0 else
        ($p.pricing.server_types[] | select(.name == $srv.server_type.name) | .prices[]
           | select(.location == ($srv.location.name // $srv.datacenter.location.name))) as $sp
        | ($sp.price_hourly.gross|tonumber) as $sh
        | ($sp.price_monthly.gross|tonumber) as $sm
        | ($p.pricing.primary_ips[] | select(.type=="ipv4") | .prices[]
           | select(.location == ($srv.location.name // $srv.datacenter.location.name)) | .price_hourly.gross|tonumber) as $ip
        | ([$v.volumes[] | select(.server == $srv.id or .name == ($name+"-data")) | .size] | add // 0) as $gb
        | ($p.pricing.volume.price_per_gb_month.gross|tonumber) as $vgb
        | $sh + $ip + ($gb * $vgb) / ($sm / $sh)
      end')" || return 1
  # Before the server exists, keep the conservative fallback rate.
  if [[ -z "$r" ]]; then log "could not compute rate from pricing (keeping $RATE)"; return 1; fi
  if [[ "$(jq -n "$r > 0")" == true ]]; then
    [[ "$r" != "$RATE" ]] && log "live hourly rate: $r/h"
    RATE="$r"
  fi
  LAST_RATE_AT="$(date +%s)"
}

server_ip() { api "servers?name=$NAME" | jq -r '.servers[0].public_net.ipv4.ip // empty'; }

# Prints "BYTES H0,H1,H2 [DISKFULL]" or nothing if the VM cannot be reached.
probe() {
  local ip="$1"
  # shellcheck disable=SC2016  # the remote command is expanded on the VM, not here
  run_with_timeout 90 "$SSH_CMD" -4 -i "$SSH_KEY_FILE" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$STATE_DIR/known_hosts" "root@$ip" \
    'printf "%s " "$(du -sb /root/snapchain 2>/dev/null | cut -f1)"; curl -s -m 5 127.0.0.1:3381/v1/info 2>/dev/null | jq -r "[.shardInfos[]?.maxHeight] | map(tostring) | join(\",\")" 2>/dev/null | tr -d "\n"; test -f /root/snapchain-DISK-FULL && printf " DISKFULL"' 2>/dev/null || true
}

# progressed OLD NEW: DB size moved by more than PROGRESS_MIN_BYTES, or any shard height went up.
progressed() {
  local old="$1" new="$2" ob nb oh nh
  [[ -z "$old" ]] && return 0
  read -r ob oh _ <<<"$old"; read -r nb nh _ <<<"$new"
  ob="${ob:-0}"; nb="${nb:-0}"
  [[ "$ob" =~ ^[0-9]+$ && "$nb" =~ ^[0-9]+$ ]] || { ob=0; nb=0; }
  local d=$(( nb - ob )); (( d < 0 )) && d=$(( -d ))
  (( d > PROGRESS_MIN_BYTES )) && return 0
  local IFS=, i
  local -a oa na
  read -r -a oa <<<"${oh:-}"; read -r -a na <<<"${nh:-}"
  for i in "${!na[@]}"; do
    [[ "${na[$i]}" =~ ^[0-9]+$ ]] || continue
    [[ "${oa[$i]:-}" =~ ^[0-9]+$ ]] || return 0   # a shard appeared (API came up)
    (( na[i] > oa[i] )) && return 0
  done
  return 1
}

do_teardown() {
  runlog "TEARDOWN triggered: $1"
  local i
  for i in 1 2 3; do
    if CONFIRM="$NAME" "$TEARDOWN_CMD" >>"$LOG" 2>&1; then break; fi
    log "teardown attempt $i failed, retrying in 60s"; sleep 60
  done
  if [[ -n "$SSH_KEY_NAME" ]]; then hcloud ssh-key delete "$SSH_KEY_NAME" >>"$LOG" 2>&1 || true; fi
  local left
  left="$(api volumes | jq '.volumes | length'):$(api servers | jq '.servers | length'):$(api firewalls | jq '.firewalls | length')"
  runlog "after teardown: volumes:servers:firewalls remaining = $left"
  if [[ "$left" == "0:0:0" ]]; then runlog "CONFIRMED: no volumes, servers or firewalls left"
  else runlog "WARNING: resources remain - check manually"; fi
  echo "$1" >"$STATE_DIR/watchdog.fired"
  exit 0
}

main() {
  [[ -n "${HCLOUD_TOKEN:-}" || -n "$API_STUB_DIR" ]] || { echo "HCLOUD_TOKEN not set. Export your Hetzner token first (see the Hetzner page)." >&2; exit 1; }
  mkdir -p "$STATE_DIR"
  local T0 LAST_PROGRESS_AT LAST_PROBE="" HANG_CHECK=1 UNREACHABLE_SINCE=0 now elapsed hours_at_risk projected spent ip fp
  T0="${WATCHDOG_T0:-$(date +%s)}"   # set WATCHDOG_T0 (epoch) when restarting a watchdog mid-run
  LAST_PROGRESS_AT="$T0"
  detect_timeout
  echo $$ >"$STATE_DIR/watchdog.pid"
  if [[ -z "$SSH_KEY_FILE" ]]; then
    HANG_CHECK=0; runlog "hang check OFF: SSH_KEY_FILE is not set (budget and wall-clock caps still apply)"
  elif [[ -z "$TIMEOUT_KIND" ]]; then
    HANG_CHECK=0; runlog "hang check OFF: no timeout, gtimeout or perl found (budget and wall-clock caps still apply)"
  fi
  runlog "started (pid $$), MAX_USD=$MAX_USD, hang=${HANG_SECS}s (check $([[ $HANG_CHECK == 1 ]] && echo on || echo off)), wall cap=${MAX_WALL_SECS}s, fallback rate=$FALLBACK_RATE/h"
  trap 'runlog "stopped by signal (no teardown)"; exit 0' TERM INT

  while :; do
    [[ -f "$STATE_DIR/watchdog.disarm" ]] && { runlog "disarmed by $STATE_DIR/watchdog.disarm (no teardown)"; rm -f "$STATE_DIR/watchdog.disarm"; exit 0; }
    now="$(date +%s)"
    (( now - LAST_RATE_AT >= 900 )) && { update_rate || log "pricing read failed; keeping rate $RATE"; }
    elapsed=$(( now - T0 ))
    # Bill if we let it run one more poll plus the time teardown needs, every started hour counted.
    hours_at_risk=$(( (elapsed + POLL_SECS + TEARDOWN_RESERVE_SECS + 3599) / 3600 ))
    projected="$(jq -n "$RATE * $hours_at_risk")"
    spent="$(jq -n "$RATE * $elapsed / 3600 * 1000 | round / 1000")"
    echo "$(ist) elapsed=${elapsed}s rate=$RATE/h spent~$spent projected_next=$projected" >"$STATE_DIR/watchdog.status"
    [[ "$(jq -n "$projected >= $MAX_USD")" == true ]] && do_teardown "budget: projected $projected >= MAX_USD $MAX_USD after ${elapsed}s at $RATE/h"
    (( elapsed >= MAX_WALL_SECS )) && do_teardown "wall-clock cap ${MAX_WALL_SECS}s reached"
    ip="$(server_ip 2>/dev/null || true)"
    if [[ -n "$ip" && "$HANG_CHECK" == 1 ]]; then
      fp="$(probe "$ip")"
      if [[ -z "${fp// /}" ]]; then
        (( UNREACHABLE_SINCE == 0 )) && { UNREACHABLE_SINCE="$now"; runlog "WARNING: progress probe cannot reach the VM over SSH (no teardown for this)"; }
        [[ "$UNREACHABLE_IS_HANG" == 1 ]] || LAST_PROGRESS_AT="$now"
      else
        (( UNREACHABLE_SINCE != 0 )) && { runlog "progress probe reachable again"; UNREACHABLE_SINCE=0; }
        if progressed "$LAST_PROBE" "$fp"; then LAST_PROGRESS_AT="$now"; LAST_PROBE="$fp"; fi
        if [[ "$fp" == *DISKFULL* ]]; then
          [[ -f "$STATE_DIR/disk-full" ]] || { ist >"$STATE_DIR/disk-full"; runlog "DISK-FULL: disk-guard stopped the node (>=90% used). No auto-teardown; waiting for a decision (budget cap still enforced)."; }
          LAST_PROGRESS_AT="$now"
        fi
      fi
      (( now - LAST_PROGRESS_AT >= HANG_SECS )) && do_teardown "hang: no DB growth or new blocks for $((now - LAST_PROGRESS_AT))s; last probe: ${LAST_PROBE:-none}"
    else
      LAST_PROGRESS_AT="$now"  # nothing to hang yet, or the check is off
    fi
    sleep "$POLL_SECS"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
