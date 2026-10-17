#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# watchdog.sh - runs on YOUR machine (not the VM). Tracks elapsed time x live hourly price of the
# resources provision.sh created and runs teardown.sh automatically:
#   * before the projected bill would reach MAX_USD, or
#   * if the node shows no progress for HANG_SECS (disk usage / shard heights unchanged, or SSH
#     unreachable), or
#   * at MAX_WALL_SECS wall-clock, whatever happens.
# Start it BEFORE provision.sh so billing time is never under-counted.
#
# Env: HCLOUD_TOKEN (required, never printed), NAME=snapchain-read-node, MAX_USD=5,
#      POLL_SECS=60, HANG_SECS=7200, MAX_WALL_SECS=86400, TEARDOWN_RESERVE_SECS=900,
#      SSH_KEY_FILE (for progress probes), SSH_KEY_NAME (Hetzner ssh-key to delete after teardown),
#      FALLBACK_RATE=0.35 (USD/h used if pricing cannot be read), RUN_LOG (markdown log to append to).
# Stop it cleanly (no teardown): touch "$STATE_DIR/watchdog.disarm".
#
# Billing model (conservative): every started hour is billed in full, for server + IPv4 + volume.

set -euo pipefail
set +x
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${NAME:-snapchain-read-node}"
MAX_USD="${MAX_USD:-5}"
POLL_SECS="${POLL_SECS:-60}"
HANG_SECS="${HANG_SECS:-7200}"
MAX_WALL_SECS="${MAX_WALL_SECS:-86400}"
TEARDOWN_RESERVE_SECS="${TEARDOWN_RESERVE_SECS:-900}"
FALLBACK_RATE="${FALLBACK_RATE:-0.35}"
STATE_DIR="${STATE_DIR:-$HERE/.provision-state}"
RUN_LOG="${RUN_LOG:-$HERE/run-log.md}"
SSH_KEY_FILE="${SSH_KEY_FILE:-}"
SSH_KEY_NAME="${SSH_KEY_NAME:-}"
mkdir -p "$STATE_DIR"
export NAME
LOG="$STATE_DIR/watchdog.log"

[[ -n "${HCLOUD_TOKEN:-}" ]] || { echo "HCLOUD_TOKEN not set" >&2; exit 1; }
ist() { TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M:%S IST'; }
log() { echo "[$(ist)] watchdog: $*" >>"$LOG"; }
runlog() { log "$*"; echo "- $(ist) **watchdog**: $*" >>"$RUN_LOG"; }

api() {  # GET from the Hetzner API without putting the token in argv
  printf 'Authorization: Bearer %s\n' "$HCLOUD_TOKEN" | curl -fsS -m 30 -H @- "https://api.hetzner.cloud/v1/$1"
}

T0="$(date +%s)"
RATE="$FALLBACK_RATE"
LAST_RATE_AT=0
LAST_PROGRESS_AT="$T0"
LAST_PROBE=""

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
           | select(.location == $srv.datacenter.location.name)) as $sp
        | ($sp.price_hourly.gross|tonumber) as $sh
        | ($sp.price_monthly.gross|tonumber) as $sm
        | ($p.pricing.primary_ips[] | select(.type=="ipv4") | .prices[]
           | select(.location == $srv.datacenter.location.name) | .price_hourly.gross|tonumber) as $ip
        | ([$v.volumes[] | select(.server == $srv.id or .name == ($name+"-data")) | .size] | add // 0) as $gb
        | ($p.pricing.volume.price_per_gb_month.gross|tonumber) as $vgb
        | $sh + $ip + ($gb * $vgb) / ($sm / $sh)
      end')" || return 1
  # Before the server exists, keep the conservative fallback rate.
  if [[ "$(jq -n "$r > 0")" == true ]]; then RATE="$r"; fi
  LAST_RATE_AT="$(date +%s)"
}

server_ip() { api "servers?name=$NAME" | jq -r '.servers[0].public_net.ipv4.ip // empty'; }

probe() {  # prints a progress fingerprint, empty if unreachable
  local ip="$1"
  [[ -n "$SSH_KEY_FILE" && -n "$ip" ]] || return 0
  ssh -4 -i "$SSH_KEY_FILE" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$STATE_DIR/known_hosts" "root@$ip" \
    'du -sb /root/snapchain 2>/dev/null | cut -f1; curl -s -m 5 127.0.0.1:3381/v1/info 2>/dev/null | jq -c "[.shardInfos[]?.maxHeight]" 2>/dev/null; cat /root/snapchain-node.progress 2>/dev/null | tail -1' 2>/dev/null | tr '\n' ' ' || true
}

do_teardown() {
  runlog "TEARDOWN triggered: $1"
  local i
  for i in 1 2 3; do
    if CONFIRM="$NAME" "$HERE/teardown.sh" >>"$LOG" 2>&1; then break; fi
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

echo $$ >"$STATE_DIR/watchdog.pid"
runlog "started (pid $$), MAX_USD=$MAX_USD, hang=${HANG_SECS}s, wall cap=${MAX_WALL_SECS}s, fallback rate=$FALLBACK_RATE/h"
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
  [[ "$(jq -n "$projected >= $MAX_USD")" == true ]] && do_teardown "budget: projected \$$projected >= MAX_USD \$$MAX_USD after ${elapsed}s at \$$RATE/h"
  (( elapsed >= MAX_WALL_SECS )) && do_teardown "wall-clock cap ${MAX_WALL_SECS}s reached"
  ip="$(server_ip 2>/dev/null || true)"
  if [[ -n "$ip" ]]; then
    fp="$(probe "$ip")"
    if [[ -n "${fp// /}" && "$fp" != "$LAST_PROBE" ]]; then LAST_PROGRESS_AT="$now"; LAST_PROBE="$fp"; fi
    (( now - LAST_PROGRESS_AT >= HANG_SECS )) && do_teardown "hang: no progress (or SSH unreachable) for $((now - LAST_PROGRESS_AT))s; last probe: ${LAST_PROBE:-none}"
  else
    LAST_PROGRESS_AT="$now"  # nothing to hang yet
  fi
  sleep "$POLL_SECS"
done
