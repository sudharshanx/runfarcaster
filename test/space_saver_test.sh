#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2016,SC2034  # assertions are eval'd strings
# Local test for snapshot-space-saver.sh: fake node logs + a real sequential reader process.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'kill "${RP:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT
S="$T/snapchain"; SNAP="$S/.rocks.snapshot"; mkdir -p "$SNAP/shard-1" "$SNAP/shard-2" "$S/.rocks"
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }
for i in 0001 0002 0003 0004; do head -c 1M /dev/urandom >"$SNAP/shard-1/chunk_$i.bin"; done
echo db >"$S/.rocks/keep"
LOGF="$T/logs"
export SNAPCHAIN_DIR="$S" CONTAINER_SNAPDIR=/app/.rocks.snapshot LOG="$T/saver.log" LOGS_CMD="cat $LOGF" MARGIN_MB=1
run() { "$ROOT/snapshot-space-saver.sh" once; }

printf '%s\n' "x Downloading zipped snapshot chunk chunk_0004.bin for shard 1 (4/4 chunks in shard)" >"$LOGF"
run; ok "download phase: nothing deleted" '[ "$(ls "$SNAP/shard-1" | wc -l)" = 4 ]'

printf '%s\n' "x Unzipping snapshot chunk /app/.rocks.snapshot/shard-1/chunk_0003.bin for shard 1" >>"$LOGF"
run; ok "unzipping chunk 3: chunks 1-2 deleted" '[ "$(ls "$SNAP/shard-1")" = "$(printf "chunk_0003.bin\nchunk_0004.bin")" ]'

# tar being unpacked by a sequential reader holding an O_RDONLY fd
head -c 16M /dev/urandom >"$SNAP/shard_1_snapshot.tar"
printf '%s\n' "x Unpacking snapshot file /app/.rocks.snapshot/shard_1_snapshot.tar for shard 1" >>"$LOGF"
python3 - "$SNAP/shard_1_snapshot.tar" <<'PY' &
import sys, time
f = open(sys.argv[1], 'rb'); f.read(12 * 1024 * 1024); time.sleep(30)
PY
RP=$!; sleep 1
# The fd path seen by the node is the container path; emulate it with a symlinked /proc view is not
# possible, so point CONTAINER_SNAPDIR at the host dir for the offset lookup.
CONTAINER_SNAPDIR="$SNAP" LOGS_CMD="sed s#/app/.rocks.snapshot#$SNAP#g $LOGF" SNAPCHAIN_PID=$RP "$ROOT/snapshot-space-saver.sh" once
ok "unpack phase: all shard-1 chunks deleted" '[ -z "$(ls "$SNAP/shard-1")" ]'
alloc=$(du -k "$SNAP/shard_1_snapshot.tar" | cut -f1)
ok "unpack phase: consumed prefix punched (alloc ${alloc} KiB < 6 MiB, size kept)" '[ "$alloc" -lt 6144 ] && [ "$(stat -c %s "$SNAP/shard_1_snapshot.tar")" = 16777216 ]'
ok "unread tail intact" 'python3 -c "import sys;d=open(sys.argv[1],\"rb\").read();sys.exit(0 if any(d[12*2**20:]) else 1)" "$SNAP/shard_1_snapshot.tar"'
kill $RP 2>/dev/null || true

printf '%s\n' "x Downloading zipped snapshot chunk chunk_0001.bin for shard 2 (1/9 chunks in shard)" >>"$LOGF"
run; ok "next shard downloading: shard 1 tar deleted" '[ ! -e "$SNAP/shard_1_snapshot.tar" ]'
ok "database untouched" '[ -f "$S/.rocks/keep" ]'
DRY_RUN=1 run; ok "dry run logs only" 'grep -q "DRY\|started\|deleted\|punched" "$T/saver.log"'
rm -rf "$SNAP"; rc=0; run || rc=$?; ok "exits 3 when restore finished" '[ "$rc" = 3 ]'

# run mode with WAIT_FOR_SNAPSHOT_SECS (how node.sh arms it before the restore starts)
: >"$T/saver.log"
start=$(date +%s); WAIT_FOR_SNAPSHOT_SECS=2 WAIT_POLL_SECS=1 "$ROOT/snapshot-space-saver.sh" run; rc=$?
ok "wait: gives up after WAIT_FOR_SNAPSHOT_SECS and exits 0" '[ "$rc" = 0 ] && [ $(( $(date +%s) - start )) -ge 2 ] && grep -q exiting "$T/saver.log"'
: >"$T/saver.log"
( WAIT_FOR_SNAPSHOT_SECS=30 WAIT_POLL_SECS=1 INTERVAL=1 "$ROOT/snapshot-space-saver.sh" run ) & SP=$!
sleep 2; mkdir -p "$SNAP"; sleep 3; rm -rf "$SNAP"; wait $SP; rc=$?
ok "wait: picks up .rocks.snapshot when it appears, exits when it is gone" '[ "$rc" = 0 ] && grep -q "appeared after" "$T/saver.log" && grep -q exiting "$T/saver.log"'
ok "wait: database untouched" '[ -f "$S/.rocks/keep" ]'

# install writes the unit with the wait setting (fake systemctl, temp dirs)
mkdir -p "$T/sd" "$T/sbin"; printf '#!/bin/sh\necho "$*" >>"%s"\n' "$T/calls" >"$T/systemctl"; chmod +x "$T/systemctl"
SYSTEMD_DIR="$T/sd" SBIN_DIR="$T/sbin" SYSTEMCTL="$T/systemctl" WAIT_FOR_SNAPSHOT_SECS=7200 "$ROOT/snapshot-space-saver.sh" install >/dev/null
ok "install: unit has WAIT_FOR_SNAPSHOT_SECS and ExecStart in SBIN_DIR" 'grep -q "WAIT_FOR_SNAPSHOT_SECS=7200" "$T/sd/snapchain-space-saver.service" && grep -q "ExecStart=$T/sbin/snapchain-space-saver run" "$T/sd/snapchain-space-saver.service"'
ok "install: enable --now, no restart" 'grep -q "enable --now snapchain-space-saver.service" "$T/calls" && ! grep -q restart "$T/calls"'
echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
