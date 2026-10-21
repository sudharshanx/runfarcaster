#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # bash -c bodies use positional args on purpose; subshell env assignments are read by sourced functions
# SPDX-License-Identifier: MIT
# Offline tests for node.sh's one-shard snapshot repair. No VM, no Docker, no real bucket: a fake
# `docker`, a local mock bucket (mock_r2.py) and a tiny fake shard archive built here.
# fixtures/snapshot-404-log.txt is composed from upstream's log format strings (snapchain
# src/storage/db/snapshot.rs l.339-346, 381, 392, 403-420 and src/main.rs l.422 @fc87f26); it is
# not a captured node log.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
FIX="$HERE/fixtures"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
check_not() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }

TMP="$(mktemp -d)"; PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT

check "shellcheck test/snapshot_repair_test.sh" shellcheck -x "$0"

NET=FARCASTER_NETWORK_MAINNET
R2="$TMP/r2"; mkdir -p "$R2"
PORT=38291
python3 "$HERE/mock_r2.py" "$PORT" "$R2" & PIDS+=($!)
URL="http://127.0.0.1:$PORT"

# make_snapshot SHARD KEY: a fake shard-N archive, split into 3 chunks, each gzipped on its own
# (that is how upstream writes them: multi_chunk_writer.rs, one gzip stream per chunk_XXXX.bin).
make_snapshot() {
  local shard="$1" key="$2" src="$TMP/src-$2" i=1 part
  rm -rf "$src"; mkdir -p "$src/shard-$shard"
  echo "restored-$key" > "$src/shard-$shard/CURRENT"
  head -c 300000 /dev/urandom > "$src/shard-$shard/000001.sst"
  tar -C "$src" -cf "$src/all.tar" "shard-$shard"
  mkdir -p "$R2/$NET/$shard/$key"
  (cd "$src" && split -n 3 -d all.tar part.)
  for part in "$src"/part.*; do
    gzip -c "$part" > "$R2/$NET/$shard/$key/$(printf 'chunk_%04d.bin' "$i")"; i=$((i+1))
  done
}
latest() {  # latest SHARD KEY [FILE]: write latest.json (or FILE) pointing at KEY with 3 chunks
  printf '{"key_base":"%s","chunks":["chunk_0001.bin","chunk_0002.bin","chunk_0003.bin"],"timestamp":1}\n' \
    "$NET/$1/$2" > "$R2/$NET/$1/${3:-latest.json}"
}
make_snapshot 0 snap-new.tar.gz; latest 0 snap-new.tar.gz

# A node after Nick's failure: shards 1 and 2 restored, shard 0 holds only what the restarted
# node wrote itself, the failed restore's scratch dir is still there.
mknode() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d/.rocks/shard-1" "$d/.rocks/shard-2" "$d/.rocks/shard-0" \
    "$d/.rocks/global" "$d/.rocks.snapshot/shard-0" "$d/bin"
  echo s1 > "$d/.rocks/shard-1/CURRENT"; echo s2 > "$d/.rocks/shard-2/CURRENT"
  echo empty-after-restart > "$d/.rocks/shard-0/CURRENT"; echo g > "$d/.rocks/global/CURRENT"
  echo '{}' > "$d/.rocks.snapshot/metadata.json"; echo partial > "$d/.rocks.snapshot/shard-0/chunk_0001.bin"
  touch "$d/docker-compose.yml"
  cp "$FIX/snapshot-404-log.txt" "$d/node.log"
  cat > "$d/bin/docker" <<FAKE
#!/bin/bash
# fake docker: 'compose logs' prints the node log, stop/start are recorded
if [[ "\$1" == compose ]]; then
  case "\$2" in
    logs) cat "$d/node.log" ;;
    stop|start) echo "\$2 \${@: -1}" >> "$d/calls" ;;
  esac
fi
exit 0
FAKE
  chmod +x "$d/bin/docker"
}
sums() { cat "$1/.rocks/shard-1/CURRENT" "$1/.rocks/shard-2/CURRENT" "$1/.rocks/global/CURRENT"; }
# rep DIR [ENV...]: source node.sh and call repair_shard 0 as the current user (no sudo).
rep() {
  local d="$1"; shift
  env PATH="$d/bin:$PATH" SNAPCHAIN_DIR="$d" SNAPSHOT_URL="$URL" REPAIR_PARALLEL=3 \
    DISK_GUARD_MARKER="$d/no-marker" "$@" bash -c "source '$ROOT/node.sh'; SUDO=''; repair_shard 0" 2>&1
}

# --- detection
det() { SNAPCHAIN_DIR="$1" NODE_LOGS_CMD="cat $1/node.log" bash -c "source '$ROOT/node.sh'; failed_snapshot_shard"; }
N="$TMP/detect"; mknode "$N"
check "detect: 404 failure on shard 0 after shards 1 and 2 -> '0 1'" \
  test "$(det "$N")" = "0 1"
echo "2026-10-21T06:00:00Z  INFO snapchain: Downloading snapshots (legacy method)" >> "$N/node.log"
check_not "detect: a later 'Downloading snapshots' (upstream retrying itself) -> nothing" det "$N"
N2="$TMP/detect2"; mknode "$N2"; rm -rf "$N2/.rocks"/*
check_not "detect: empty .rocks (upstream re-downloads on restart) -> nothing" det "$N2"
N3="$TMP/detect3"; mknode "$N3"; grep -v 'ERROR' "$FIX/snapshot-404-log.txt" > "$N3/node.log"
check_not "detect: only transient 'due to error' warnings -> nothing" det "$N3"
printf '\033[31m%s\033[0m\n' "$(grep ERROR "$FIX/snapshot-404-log.txt" | sed 's/shard-0/shard-2/')" > "$N3/node.log"
check "detect: ANSI-coloured failure on shard 2 -> '2 1'" \
  test "$(det "$N3")" = "2 1"

# --- repair: happy path
A="$TMP/a"; mknode "$A"; before="$(sums "$A")"
out="$(rep "$A")"; rc=$?
check "repair: exit 0" test "$rc" -eq 0
check "repair: shard-0 replaced by the fresh snapshot" grep -qx "restored-snap-new.tar.gz" "$A/.rocks/shard-0/CURRENT"
check "repair: shard-0 data file restored byte-identical" cmp -s "$A/.rocks/shard-0/000001.sst" "$TMP/src-snap-new.tar.gz/shard-0/000001.sst"
check "repair: shards 1, 2 and global untouched" test "$(sums "$A")" = "$before"
check "repair: stop then start of snapchain only" test "$(cat "$A/calls")" = "$(printf 'stop snapchain\nstart snapchain')"
check "repair: failed restore's .rocks.snapshot removed" test ! -e "$A/.rocks.snapshot"
check "repair: scratch dir removed" test ! -e "$A/.node-sh-repair/shard-0"
check "repair: marker records key_base" grep -qx "key_base=$NET/0/snap-new.tar.gz" "$A/.node-sh-shard-0-repaired"
check "repair: never asked the bucket for shard 1 or 2" bash -c '! grep -qE "/$1/(1|2)/" "$2/requests.log"' _ "$NET" "$R2"
check "repair: clear [node.sh] lines" bash -c 'grep -q "\[node.sh\] Repairing shard 0 only" <<<"$1" && grep -q "restored from" <<<"$1"' _ "$out"

# --- rotation during the repair: first metadata points at a snapshot that is already gone
latest 0 snap-gone.tar.gz latest.1.json
B="$TMP/b"; mknode "$B"
out="$(rep "$B")"; rc=$?
rm -f "$R2/$NET/0/latest.1.json"
check "rotation: 404 -> fresh metadata -> success on attempt 2" \
  bash -c '[[ $1 -eq 0 ]] && grep -q "replaced during the download" <<<"$2" && grep -q "attempt 2 of 3" <<<"$2"' _ "$rc" "$out"
check "rotation: restored from the new snapshot" grep -qx "restored-snap-new.tar.gz" "$B/.rocks/shard-0/CURRENT"

# --- the snapshot never becomes available: gives up after 3 attempts, nothing swapped
latest 0 snap-gone.tar.gz
C="$TMP/c"; mknode "$C"; before="$(sums "$C")"
set +e; out="$(rep "$C")"; rc=$?; set -e
check "always 404: gives up with non-zero after 3 attempts" \
  bash -c '[[ $1 -ne 0 ]] && grep -q "attempt 3 of 3" <<<"$2" && ! grep -q "attempt 4" <<<"$2" && grep -q "repair failed after 3 attempts" <<<"$2"' _ "$rc" "$out"
check "always 404: node never stopped, shard-0 not replaced" \
  bash -c '[[ ! -e "$1/calls" ]] && grep -qx empty-after-restart "$1/.rocks/shard-0/CURRENT"' _ "$C"
check "always 404: other shards untouched" test "$(sums "$C")" = "$before"

# --- resume: one chunk missing, then it appears; already downloaded chunks are not fetched again
latest 0 snap-new.tar.gz
mv "$R2/$NET/0/snap-new.tar.gz/chunk_0003.bin" "$TMP/held"
D="$TMP/d"; mknode "$D"
set +e; rep "$D" REPAIR_ATTEMPTS=1 >/dev/null; set -e
check "resume: 2 of 3 chunks kept after a failed run" test "$(find "$D/.node-sh-repair/shard-0/chunks" -name 'chunk_*.bin' | wc -l)" -eq 2
mv "$TMP/held" "$R2/$NET/0/snap-new.tar.gz/chunk_0003.bin"; : > "$R2/requests.log"
out="$(rep "$D")"; rc=$?
check "resume: second run succeeds" bash -c '[[ $1 -eq 0 ]] && grep -qx "restored-snap-new.tar.gz" "$2/.rocks/shard-0/CURRENT"' _ "$rc" "$D"
check "resume: only chunk_0003 downloaded again" \
  bash -c '[[ $(grep -c "chunk_" "$1") -eq 1 ]] && grep -q chunk_0003 "$1"' _ "$R2/requests.log"

# --- corrupt chunk: unpack fails, nothing swapped
cp "$R2/$NET/0/snap-new.tar.gz/chunk_0002.bin" "$TMP/good2"; echo garbage > "$R2/$NET/0/snap-new.tar.gz/chunk_0002.bin"
E="$TMP/e"; mknode "$E"
set +e; out="$(rep "$E" REPAIR_ATTEMPTS=2)"; rc=$?; set -e
cp "$TMP/good2" "$R2/$NET/0/snap-new.tar.gz/chunk_0002.bin"
check "corrupt chunk: unpack failure reported, non-zero, shard-0 kept" \
  bash -c '[[ $1 -ne 0 ]] && grep -q "unpack failed" <<<"$2" && grep -qx empty-after-restart "$3/.rocks/shard-0/CURRENT" && [[ ! -e "$3/calls" ]]' _ "$rc" "$out" "$E"

# --- refusals
printf '{"key_base":"%s/0/../../x","chunks":["chunk_0001.bin"]}\n' "$NET" > "$R2/$NET/0/latest.json"
F="$TMP/f"; mknode "$F"
set +e; out="$(rep "$F")"; rc=$?; set -e
check "metadata with '..' in key_base is refused" bash -c '[[ $1 -ne 0 ]] && grep -q "unexpected snapshot metadata" <<<"$2"' _ "$rc" "$out"
free_mb="$(df -P -BM "$TMP" | awk 'NR==2 {gsub("M","",$4); print $4}')"
python3 -c "import json,sys; n=int(sys.argv[1])//200+10; print(json.dumps({'key_base':'$NET/0/huge.tar.gz','chunks':['chunk_%04d.bin'%i for i in range(1,n+1)]}))" "$free_mb" > "$R2/$NET/0/latest.json"
G="$TMP/g"; mknode "$G"
set +e; out="$(rep "$G")"; rc=$?; set -e
check "not enough free disk: refused before downloading" \
  bash -c '[[ $1 -ne 0 ]] && grep -q "MiB free; not repairing" <<<"$2" && ! grep -q huge.tar.gz/chunk "$3/requests.log"' _ "$rc" "$out" "$R2"
latest 0 snap-new.tar.gz
Hd="$TMP/h"; mknode "$Hd"; touch "$Hd/marker"
set +e; out="$(rep "$Hd" DISK_GUARD_MARKER="$Hd/marker")"; rc=$?; set -e
check "disk-guard marker present: refused, nothing removed" \
  bash -c '[[ $1 -ne 0 ]] && grep -q "disk-guard stopped the node" <<<"$2" && [[ -d "$3/.rocks.snapshot" ]]' _ "$rc" "$out" "$Hd"
set +e; out="$(env SNAPCHAIN_DIR="$TMP/x" bash "$ROOT/node.sh" repair-shard abc 2>&1)"; rc=$?; set -e
check "repair-shard needs a number" bash -c '[[ $1 -ne 0 ]] && grep -q "needs a shard number" <<<"$2"' _ "$rc" "$out"
out="$(env SNAPCHAIN_DIR="$TMP/x" DRY_RUN=1 bash "$ROOT/node.sh" repair-shard 0 2>&1)"
check "DRY_RUN repair-shard prints the plan, creates nothing" bash -c 'grep -q "\[dry-run\] remove" <<<"$1" && [[ ! -e "$2" ]]' _ "$out" "$TMP/x"

# --- end to end: './node.sh wait' detects the failure, repairs shard 0 once, then reports sync
MPORT=38292
python3 "$HERE/mock_node.py" "$MPORT" "$FIX/info-synced.json" & PIDS+=($!)
sleep 1
W="$TMP/w"; mknode "$W"; before="$(sums "$W")"
wrun() { env PATH="$W/bin:$PATH" SNAPCHAIN_DIR="$W" SNAPSHOT_URL="$URL" SNAPCHAIN_HTTP="http://127.0.0.1:$MPORT" \
  SYNC_POLL_SECS=1 SYNC_STABLE_CHECKS=2 SYNC_TIMEOUT_SECS=20 DISK_GUARD_MARKER="$W/no-marker" "$@" bash "$ROOT/node.sh" wait 2>&1; }
out="$(wrun SNAPSHOT_REPAIR=0)"
check "wait, SNAPSHOT_REPAIR=0: explains and prints the one-shard command, changes nothing" \
  bash -c 'grep -q "could not download the shard 0 snapshot" <<<"$1" && grep -q "run: ./node.sh repair-shard 0" <<<"$1" && grep -qx empty-after-restart "$2/.rocks/shard-0/CURRENT" && [[ ! -e "$2/calls" ]]' _ "$out" "$W"
check "wait, SNAPSHOT_REPAIR=0: warns once per run" test "$(grep -c "could not download the shard 0" <<<"$out")" -eq 1
out="$(wrun)"
check "wait: auto-repairs shard 0 and still reports sync" \
  bash -c 'grep -q "Repairing shard 0 only" <<<"$1" && grep -q "Node is in sync." <<<"$1" && grep -qx restored-snap-new.tar.gz "$2/.rocks/shard-0/CURRENT"' _ "$out" "$W"
check "wait: shards 1, 2 and global untouched" test "$(sums "$W")" = "$before"
mkdir -p "$W/.rocks.snapshot"; echo '{}' > "$W/.rocks.snapshot/metadata.json"   # as if Docker recreated it
out="$(wrun)"
check "wait re-run: already repaired, no second repair" bash -c '! grep -q "Repairing" <<<"$1" && [[ $(grep -c start "$2/calls") -eq 1 ]]' _ "$out" "$W"
grep ERROR "$FIX/snapshot-404-log.txt" >> "$W/node.log"
out="$(wrun SNAPSHOT_REPAIR=0)"
check "wait: a NEW failure line after a repair is reported again" grep -q "could not download the shard 0 snapshot" <<<"$out"

echo; echo "passed: $PASS  failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
