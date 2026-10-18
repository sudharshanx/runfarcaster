#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# snapshot-space-saver.sh - runs ON THE VM while a new Snapchain node restores its snapshot, and
# frees disk space the official restore keeps around until the very end.
#
# Why (snapchain src/storage/db/snapshot.rs @fc87f26, download_snapshots): for each shard it
#   1. downloads every gzipped chunk into .rocks.snapshot/shard-N/,
#   2. gunzips ALL of them into one uncompressed .rocks.snapshot/shard_N_snapshot.tar,
#   3. untars that into .rocks,
# and only deletes .rocks.snapshot after the LAST shard. So the peak is roughly all compressed
# chunks + all tars + the database. Mainnet on 2026-10-18 was 5689 chunks (~520 GB compressed),
# so a 1 TB disk cannot hold that peak.
#
# What this does, every INTERVAL seconds, without touching anything the node still needs:
#   * chunk files whose "Unzipping snapshot chunk" step has finished (a later chunk of the same
#     shard is being unzipped) are deleted. They are only ever read once, in order.
#   * once "Unpacking snapshot file ... for shard N" is logged, all of shard N's chunks are deleted.
#   * while the tar is being unpacked, the part BEFORE the node's current read offset (from
#     /proc/<pid>/fdinfo, minus MARGIN_MB) is hole-punched (fallocate --punch-hole). Unpacking reads
#     the tar strictly sequentially, so that data is never read again.
#   * once a different shard starts downloading, the previous shard's tar is deleted.
# It never touches .rocks (the database). It exits once .rocks.snapshot is gone (restore finished).
# With WAIT_FOR_SNAPSHOT_SECS > 0, `run` first waits up to that long for .rocks.snapshot to appear
# (node.sh arms it before the node starts its restore), then exits if it never does.
#
#   ./snapshot-space-saver.sh install | run | once | uninstall
# Env: SNAPCHAIN_DIR=/root/snapchain, CONTAINER=snapchain-snapchain-1, INTERVAL=20, MARGIN_MB=512,
#      WAIT_FOR_SNAPSHOT_SECS=0, DRY_RUN=1 (log what would be freed, change nothing),
#      LOG=/var/log/snapchain-space-saver.log, SYSTEMD_DIR, SBIN_DIR, SYSTEMCTL (for tests)

set -euo pipefail
SNAPCHAIN_DIR="${SNAPCHAIN_DIR:-/root/snapchain}"
CONTAINER="${CONTAINER:-snapchain-snapchain-1}"
INTERVAL="${INTERVAL:-20}"
MARGIN_MB="${MARGIN_MB:-512}"
DRY_RUN="${DRY_RUN:-0}"
WAIT_FOR_SNAPSHOT_SECS="${WAIT_FOR_SNAPSHOT_SECS:-0}"
WAIT_POLL_SECS="${WAIT_POLL_SECS:-10}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LOG="${LOG:-/var/log/snapchain-space-saver.log}"
SNAPDIR="$SNAPCHAIN_DIR/.rocks.snapshot"
CONTAINER_SNAPDIR="${CONTAINER_SNAPDIR:-/app/.rocks.snapshot}"
LOGS_CMD="${LOGS_CMD:-docker logs $CONTAINER}"   # overridable for tests
UNIT=snapchain-space-saver

ts() { TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M:%S IST'; }
log() { echo "$(ts) $*" >>"$LOG"; }
act() { if [[ "$DRY_RUN" == 1 ]]; then log "DRY: $*"; else "$@"; fi; }

# Last log line of each restore phase (ANSI colour codes stripped).
phase_lines() {
  $LOGS_CMD 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Unzipping snapshot chunk|Unpacking snapshot file|Downloading zipped snapshot chunk' || true
}

snapchain_pid() {
  [[ -n "${SNAPCHAIN_PID:-}" ]] && { echo "$SNAPCHAIN_PID"; return 0; }   # tests
  local p
  p="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || true)"
  [[ -n "$p" && "$p" != 0 ]] || return 0
  # docker-init -> bash -> snapchain: pick the process whose comm is snapchain
  pgrep -P "$p" -x snapchain || pgrep -x snapchain | head -1 || true
}

# Read-only fd offset of the node on a given container path, or empty.
read_offset() {
  local pid="$1" cpath="$2" fd
  [[ -n "$pid" ]] || return 0
  for fd in /proc/"$pid"/fd/*; do
    [[ "$(readlink "$fd" 2>/dev/null)" == "$cpath" ]] || continue
    local info flags
    info="$(cat /proc/"$pid"/fdinfo/"${fd##*/}" 2>/dev/null)" || continue
    flags="$(awk '/^flags:/{print $2}' <<<"$info")"
    (( (8#$flags & 3) == 0 )) || continue   # O_RDONLY only (skip the writer fd)
    awk '/^pos:/{print $2}' <<<"$info"
    return 0
  done
}

delete_chunks_before() {  # shard, chunk-basename (exclusive; empty = all)
  local shard="$1" upto="$2" f n=0 bytes=0 sz
  shopt -s nullglob
  for f in "$SNAPDIR/shard-$shard"/chunk_*; do
    if [[ -z "$upto" || "$(basename "$f")" < "$upto" ]]; then
      sz="$(stat -c %s "$f")"; act rm -f -- "$f"; n=$((n+1)); bytes=$((bytes+sz))
    fi
  done
  (( n == 0 )) || log "shard $shard: deleted $n consumed chunk(s), $((bytes/1024/1024)) MiB"
}

once() {
  [[ -d "$SNAPDIR" ]] || { log "no $SNAPDIR: restore finished or not started"; return 3; }
  local lines last unzip unpack dl
  lines="$(phase_lines)"
  last="$(tail -1 <<<"$lines")"
  unzip="$(grep 'Unzipping snapshot chunk' <<<"$lines" | tail -1 || true)"
  unpack="$(grep 'Unpacking snapshot file' <<<"$lines" | tail -1 || true)"
  dl="$(grep 'Downloading zipped snapshot chunk' <<<"$lines" | tail -1 || true)"

  # Unpacked shards (all "Unpacking ... for shard N" lines): their chunks are no longer needed.
  local s
  # shellcheck disable=SC2013  # shard ids are single words
  for s in $(grep -o 'Unpacking snapshot file .* for shard [0-9]*' <<<"$lines" | awk '{print $NF}' | sort -u); do
    delete_chunks_before "$s" ""
  done

  # Currently unzipping: delete chunks of that shard before the current one.
  if [[ "$last" == *"Unzipping snapshot chunk"* ]]; then
    local path shard
    path="$(sed -E 's/.*Unzipping snapshot chunk ([^ ]+) for shard ([0-9]+).*/\1/' <<<"$unzip")"
    shard="$(sed -E 's/.*for shard ([0-9]+).*/\1/' <<<"$unzip")"
    delete_chunks_before "$shard" "$(basename "$path")"
  fi

  # Currently unpacking: hole-punch the consumed prefix of the tar.
  if [[ "$last" == *"Unpacking snapshot file"* ]]; then
    local ctar htar pid pos keep
    ctar="$(sed -E 's/.*Unpacking snapshot file ([^ ]+) for shard.*/\1/' <<<"$unpack")"
    htar="$SNAPDIR/${ctar#"$CONTAINER_SNAPDIR"/}"
    pid="$(snapchain_pid)"
    pos="$(read_offset "$pid" "$ctar")"
    if [[ -n "$pos" && -f "$htar" ]]; then
      keep=$(( MARGIN_MB * 1024 * 1024 ))
      local upto=$(( (pos - keep) / 4096 * 4096 ))
      if (( upto > 0 )); then
        act fallocate --punch-hole --keep-size --offset 0 --length "$upto" "$htar"
        log "punched $(basename "$htar") [0, $((upto/1024/1024)) MiB) (reader at $((pos/1024/1024)) MiB); allocated now $(du -m "$htar" | cut -f1) MiB"
      fi
    fi
  fi

  # Downloading a shard: tars of shards whose unpack already started and that are not this shard
  # are finished (shards are processed strictly one after another).
  if [[ "$last" == *"Downloading zipped snapshot chunk"* ]]; then
    local cur
    cur="$(sed -E 's/.*for shard ([0-9]+).*/\1/' <<<"$dl")"
    # shellcheck disable=SC2013  # shard ids are single words
    for s in $(grep -o 'Unpacking snapshot file .* for shard [0-9]*' <<<"$lines" | awk '{print $NF}' | sort -u); do
      [[ "$s" == "$cur" ]] && continue
      if [[ -f "$SNAPDIR/shard_${s}_snapshot.tar" ]]; then
        log "shard $s unpack finished (now downloading shard $cur): deleting shard_${s}_snapshot.tar ($(du -m "$SNAPDIR/shard_${s}_snapshot.tar" | cut -f1) MiB allocated)"
        act rm -f -- "$SNAPDIR/shard_${s}_snapshot.tar"
      fi
    done
  fi
  return 0
}

case "${1:-run}" in
  once) once ;;
  run)
    log "started (interval ${INTERVAL}s, margin ${MARGIN_MB} MiB, wait ${WAIT_FOR_SNAPSHOT_SECS}s, dry_run=$DRY_RUN)"
    waited=0
    while [[ ! -d "$SNAPDIR" ]] && (( waited < WAIT_FOR_SNAPSHOT_SECS )); do
      sleep "$WAIT_POLL_SECS"; waited=$((waited + WAIT_POLL_SECS))
    done
    [[ -d "$SNAPDIR" ]] && (( waited > 0 )) && log "$SNAPDIR appeared after ${waited}s"
    while :; do
      rc=0; once || rc=$?
      (( rc == 3 )) && { log "exiting"; exit 0; }
      sleep "$INTERVAL"
    done ;;
  install)
    install -m 0755 "$(readlink -f "${BASH_SOURCE[0]}")" "$SBIN_DIR/snapchain-space-saver"
    cat >"$SYSTEMD_DIR/$UNIT.service" <<UNITEOF
[Unit]
Description=Free disk space during Snapchain snapshot restore
After=docker.service
[Service]
Environment=SNAPCHAIN_DIR=$SNAPCHAIN_DIR CONTAINER=$CONTAINER INTERVAL=$INTERVAL MARGIN_MB=$MARGIN_MB WAIT_FOR_SNAPSHOT_SECS=$WAIT_FOR_SNAPSHOT_SECS DRY_RUN=$DRY_RUN
ExecStart=$SBIN_DIR/snapchain-space-saver run
Restart=on-failure
RestartSec=30
[Install]
WantedBy=multi-user.target
UNITEOF
    $SYSTEMCTL daemon-reload && $SYSTEMCTL enable --now $UNIT.service && $SYSTEMCTL is-active $UNIT.service ;;
  uninstall) $SYSTEMCTL disable --now $UNIT.service || true; rm -f "$SYSTEMD_DIR/$UNIT.service" "$SBIN_DIR/snapchain-space-saver"; $SYSTEMCTL daemon-reload ;;
  *) echo "usage: $0 install|run|once|uninstall" >&2; exit 1 ;;
esac
