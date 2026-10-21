#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# node.sh - install and start a Farcaster Snapchain *read node* on Ubuntu 22.04/24.04
# using the official bootstrap script, wait until it is in sync, print a health check.
#
# Usage (on the VM, as root or a sudo-capable user):
#   SNAPCHAIN_AGREE_NO_REWARDS=yes ./node.sh            # install/start + wait for sync + health
#   ./node.sh wait                                       # only wait for sync, then health
#   ./node.sh health                                     # only print the health check
#   ./node.sh helpers                                    # only install/arm the disk helpers (below)
#   ./node.sh repair-shard N                             # restore only shard N from a fresh snapshot
#   DRY_RUN=1 ./node.sh                                  # print what would run, change nothing
#
# Environment (all optional):
#   SNAPCHAIN_AGREE_NO_REWARDS  "yes" records the official "no rewards for running a node"
#                               agreement non-interactively. Otherwise you are asked on a TTY.
#   OPERATOR_FID                Your FID (digits). Used by snapchain.sh only to pick the weekday
#                               of the weekly auto-upgrade cron job. If unset, HUB_OPERATOR_FID=0
#                               and SKIP_CRONTAB=true are written (auto-upgrade OFF) because
#                               snapchain.sh exits with "Unable to determine upgrade day" otherwise.
#   SNAPCHAIN_DIR               Default: $HOME/snapchain (the bootstrap always uses ~/snapchain of
#                               the user running it; do not change unless you know why).
#   SNAPCHAIN_HTTP              Default: http://127.0.0.1:3381 (HTTP API port from compose file).
#   BOOTSTRAP_URL               Default: the official bootstrap script on main (see SOURCES.md).
#   NODE_UPGRADE=1              Re-run the bootstrap (official upgrade path) even if already running.
#   WAIT_FOR_SYNC=0             Skip waiting for sync.
#   SYNC_MAX_BLOCK_DELAY        Default 10. Synced = every shard's blockDelay < this ("single digits").
#   SYNC_STABLE_CHECKS          Default 3 consecutive passing polls.
#   SYNC_POLL_SECS              Default 60.
#   SYNC_TIMEOUT_SECS           Default 86400 (24 h). Our measured sync took 14 h 06 m.
#   BOOTSTRAP_TIMEOUT_SECS      Default 3600. Max time for bootstrap to reach "Upgrade complete".
#   MIN_FREE_GB                 Default 1500. Preflight free-disk check for SNAPCHAIN_DIR.
#   MIN_RAM_GB                  Default 15 (16 GB VMs report slightly less than 16 GiB).
#   SKIP_PREFLIGHT=1            Downgrade preflight failures to warnings.
#   DISK_HELPERS                auto (default): on a data disk smaller than DISK_HELPERS_BELOW_GB
#                               (default 1500), install disk-guard.sh (stops the node at 90% full)
#                               and snapshot-space-saver.sh (frees restore space) as systemd units.
#                               1 = always install, 0 = never. Both scripts are embedded below, so
#                               `bash -s < node.sh` needs no other file. Re-running is safe.
#   SPACE_SAVER_WAIT_SECS       Default 7200. How long the space saver waits for the node to start
#                               its snapshot restore (.rocks.snapshot) before giving up.
#   SNAPSHOT_REPAIR             auto (default): while waiting for sync, if Snapchain logged
#                               "Failed to download snapshot chunk" for a shard and will not retry,
#                               restore only that shard (see repair_shard). 0 = only print the fix.
#   REPAIR_ATTEMPTS             Default 3. Fresh-metadata attempts per repair.
#   REPAIR_PARALLEL             Default 4. Parallel chunk downloads during a repair.
#   SNAPSHOT_URL                Default: upstream's snapshot_download_url (see repair_shard).
#
# No API keys, tokens, seed phrases or private keys are needed or read by this script.

set -euo pipefail

SNAPCHAIN_DIR="${SNAPCHAIN_DIR:-$HOME/snapchain}"
SNAPCHAIN_HTTP="${SNAPCHAIN_HTTP:-http://127.0.0.1:3381}"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-https://raw.githubusercontent.com/farcasterxyz/snapchain/refs/heads/main/scripts/snapchain-bootstrap.sh}"
NODE_UPGRADE="${NODE_UPGRADE:-0}"
WAIT_FOR_SYNC="${WAIT_FOR_SYNC:-1}"
SYNC_MAX_BLOCK_DELAY="${SYNC_MAX_BLOCK_DELAY:-10}"
SYNC_STABLE_CHECKS="${SYNC_STABLE_CHECKS:-3}"
SYNC_POLL_SECS="${SYNC_POLL_SECS:-60}"
SYNC_TIMEOUT_SECS="${SYNC_TIMEOUT_SECS:-86400}"
BOOTSTRAP_TIMEOUT_SECS="${BOOTSTRAP_TIMEOUT_SECS:-3600}"
MIN_FREE_GB="${MIN_FREE_GB:-1500}"
MIN_RAM_GB="${MIN_RAM_GB:-15}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-0}"
DRY_RUN="${DRY_RUN:-0}"
BOOTSTRAP_LOG="${BOOTSTRAP_LOG:-$SNAPCHAIN_DIR/node-sh-bootstrap.log}"
DISK_HELPERS="${DISK_HELPERS:-auto}"
DISK_HELPERS_BELOW_GB="${DISK_HELPERS_BELOW_GB:-1500}"
SPACE_SAVER_WAIT_SECS="${SPACE_SAVER_WAIT_SECS:-7200}"
HELPER_DIR="${HELPER_DIR:-/usr/local/lib/snapchain-tutorial}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
SNAPSHOT_REPAIR="${SNAPSHOT_REPAIR:-auto}"
SNAPSHOT_URL="${SNAPSHOT_URL:-https://pub-d352dd8819104a778e20d08888c5a661.r2.dev}"
SNAPSHOT_NETWORK="${SNAPSHOT_NETWORK:-FARCASTER_NETWORK_MAINNET}"
REPAIR_ATTEMPTS="${REPAIR_ATTEMPTS:-3}"
REPAIR_PARALLEL="${REPAIR_PARALLEL:-4}"
DISK_GUARD_MARKER="${DISK_GUARD_MARKER:-/root/snapchain-DISK-FULL}"

log()  { printf '[node.sh] %s\n' "$*"; }
warn() { printf '[node.sh] WARNING: %s\n' "$*" >&2; }
die()  { printf '[node.sh] ERROR: %s\n' "$*" >&2; exit 1; }

# run CMD...: execute, or only print it when DRY_RUN=1.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

SUDO=""
setup_sudo() {
  if [[ "$(id -u)" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "run as root or install sudo"
    # The official snapchain.sh re-executes itself with sudo; under a pseudo-terminal a password
    # prompt would hang, so require root or passwordless sudo.
    sudo -n true 2>/dev/null || die "run as root or with passwordless sudo (snapchain.sh re-runs itself via sudo)"
    SUDO="sudo"
  fi
}

preflight_fail() {
  if [[ "$SKIP_PREFLIGHT" == "1" ]]; then warn "$1 (continuing, SKIP_PREFLIGHT=1)"; else die "$1 (set SKIP_PREFLIGHT=1 to override)"; fi
}

check_os() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ "${ID:-}" != "ubuntu" ]] || [[ "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
      preflight_fail "this script is written for Ubuntu 22.04/24.04, found ${PRETTY_NAME:-unknown}"
    fi
  else
    preflight_fail "cannot read /etc/os-release"
  fi
}

# On a fresh cloud VM, wait for cloud-init (provision.sh mounts the data volume from it).
wait_cloud_init() {
  if command -v cloud-init >/dev/null 2>&1 && [[ "$DRY_RUN" != "1" ]]; then
    log "Waiting for cloud-init to finish ..."
    $SUDO cloud-init status --wait >/dev/null 2>&1 || warn "cloud-init reported an error; continuing"
  fi
}

check_resources() {
  local mem_kb mem_gb target free_gb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_gb=$(( mem_kb / 1024 / 1024 ))
  log "RAM: ${mem_gb} GiB (docs: 16 GB required)"
  (( mem_gb >= MIN_RAM_GB )) || preflight_fail "only ${mem_gb} GiB RAM, need >= ${MIN_RAM_GB}"

  # The node's database lives in $SNAPCHAIN_DIR/.rocks; check the filesystem it will be on.
  target="$SNAPCHAIN_DIR"
  while [[ ! -e "$target" ]]; do target="$(dirname "$target")"; done
  free_gb="$(df -P -BG "$target" | awk 'NR==2 {gsub("G","",$4); print $4}')"
  log "Free disk at $target: ${free_gb} GB (docs: 2 TB on the docs site, 1.5 TB in the repo README)"
  (( free_gb >= MIN_FREE_GB )) || preflight_fail "only ${free_gb} GB free at $target, need >= ${MIN_FREE_GB} GB"
}

# Docker Engine + Compose plugin from Docker's official apt repository
# (https://docs.docker.com/engine/install/ubuntu/). Skipped when docker + compose already work.
install_docker() {
  if command -v docker >/dev/null 2>&1 && $SUDO docker compose version >/dev/null 2>&1; then
    log "Docker and the compose plugin are already installed."
    return 0
  fi
  log "Installing Docker Engine from download.docker.com ..."
  run $SUDO apt-get update -y </dev/null
  run $SUDO apt-get install -y ca-certificates curl </dev/null
  run $SUDO install -m 0755 -d /etc/apt/keyrings
  run $SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  run $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  local codename arch
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  arch="$(dpkg --print-architecture)"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] write /etc/apt/sources.list.d/docker.list for %s %s\n' "$codename" "$arch"
  else
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
      "$arch" "$codename" | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  fi
  run $SUDO apt-get update -y </dev/null
  run $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin </dev/null
  run $SUDO systemctl enable --now docker
}

# Tools the official scripts call: jq, curl, crontab (cron), sha256sum, script (util-linux/bsdutils).
install_deps() {
  local missing=()
  command -v jq >/dev/null 2>&1      || missing+=(jq)
  command -v curl >/dev/null 2>&1    || missing+=(curl)
  command -v crontab >/dev/null 2>&1 || missing+=(cron)
  command -v script >/dev/null 2>&1  || missing+=(bsdutils)
  if (( ${#missing[@]} > 0 )); then
    log "Installing: ${missing[*]}"
    run $SUDO apt-get update -y </dev/null
    run $SUDO apt-get install -y "${missing[@]}" </dev/null
  fi
}

env_has() { [[ -f "$SNAPCHAIN_DIR/.env" ]] && grep -q "^$1=" "$SNAPCHAIN_DIR/.env"; }
env_set_if_missing() {
  if ! env_has "$1"; then
    if [[ "$DRY_RUN" == "1" ]]; then printf '[dry-run] append %s=%s to %s/.env\n' "$1" "$2" "$SNAPCHAIN_DIR"
    else printf '%s=%s\n' "$1" "$2" >> "$SNAPCHAIN_DIR/.env"; fi
  fi
}

# Pre-seed ~/snapchain/.env so the official snapchain.sh does not block on its two prompts.
# The keys/values are exactly the ones snapchain.sh itself writes (see SOURCES.md).
seed_env() {
  run mkdir -p "$SNAPCHAIN_DIR"
  [[ "$DRY_RUN" == "1" ]] || touch "$SNAPCHAIN_DIR/.env"

  if ! grep -q '^AGREE_NO_REWARDS_FOR_ME=true' "$SNAPCHAIN_DIR/.env" 2>/dev/null; then
    local answer="${SNAPCHAIN_AGREE_NO_REWARDS:-}"
    if [[ -z "$answer" && -t 0 ]]; then
      printf 'IMPORTANT: You will NOT get any rewards for running this node.\nType "Yes" to continue: '
      read -r answer
    fi
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      yes|y) env_set_if_missing AGREE_NO_REWARDS_FOR_ME true ;;
      *) die "the official script requires agreeing that you get no rewards. Re-run with SNAPCHAIN_AGREE_NO_REWARDS=yes or on a TTY." ;;
    esac
  fi

  if ! env_has HUB_OPERATOR_FID; then
    if [[ -n "${OPERATOR_FID:-}" ]]; then
      [[ "$OPERATOR_FID" =~ ^[0-9]+$ ]] || die "OPERATOR_FID must be digits"
      env_set_if_missing HUB_OPERATOR_FID "$OPERATOR_FID"
    else
      warn "OPERATOR_FID not set: writing HUB_OPERATOR_FID=0 and SKIP_CRONTAB=true (weekly auto-upgrade OFF)."
      env_set_if_missing HUB_OPERATOR_FID 0
      env_set_if_missing SKIP_CRONTAB true
    fi
  fi
  if env_has HUB_OPERATOR_FID && grep -q '^HUB_OPERATOR_FID=0$' "$SNAPCHAIN_DIR/.env"; then
    env_set_if_missing SKIP_CRONTAB true
  fi
}

compose() { (cd "$SNAPCHAIN_DIR" && $SUDO docker compose "$@"); }

node_running() {
  [[ -f "$SNAPCHAIN_DIR/docker-compose.yml" ]] || return 1
  [[ -n "$(compose ps --status running -q snapchain 2>/dev/null)" ]]
}

# Runs the OFFICIAL bootstrap script unmodified. Two quirks are handled from the outside:
#  1. It ends with `exec ./snapchain.sh upgrade < /dev/tty`, which fails without a controlling
#     terminal (e.g. `ssh host 'bash -s' < node.sh`). We run it under util-linux `script`, which
#     gives it a pseudo-terminal.
#  2. `upgrade` finishes by following the container logs forever. We wait for its
#     "Upgrade complete." line, then stop the log follower. The containers keep running
#     (they are started with `docker compose up -d`).
run_bootstrap() {
  if node_running && [[ "$NODE_UPGRADE" != "1" ]]; then
    log "snapchain container already running; skipping bootstrap (NODE_UPGRADE=1 to re-run it)."
    return 0
  fi
  local tmp pid elapsed=0
  tmp="$(mktemp)"
  log "Downloading official bootstrap: $BOOTSTRAP_URL"
  curl -fsSL "$BOOTSTRAP_URL" -o "$tmp"
  log "bootstrap sha256: $(sha256sum "$tmp" | awk '{print $1}')"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] script -qefc "bash %s" %s\n' "$tmp" "$BOOTSTRAP_LOG"
    rm -f "$tmp"; return 0
  fi
  : > "$BOOTSTRAP_LOG"
  # setsid: own session, so we can stop the whole tree. stdin from /dev/null: nothing to answer.
  setsid script -qefc "bash '$tmp'" "$BOOTSTRAP_LOG" </dev/null >/dev/null 2>&1 &
  pid=$!
  log "Bootstrap running (pid $pid), log: $BOOTSTRAP_LOG"
  while true; do
    if grep -q 'Upgrade complete' "$BOOTSTRAP_LOG"; then
      log "Bootstrap reported 'Upgrade complete.'"
      sleep 5
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 40 "$BOOTSTRAP_LOG" >&2 || true
      rm -f "$tmp"
      die "bootstrap exited before 'Upgrade complete' (see $BOOTSTRAP_LOG)"
    fi
    if (( elapsed >= BOOTSTRAP_TIMEOUT_SECS )); then
      kill -TERM "$pid" 2>/dev/null || true
      rm -f "$tmp"
      die "bootstrap did not finish within ${BOOTSTRAP_TIMEOUT_SECS}s (see $BOOTSTRAP_LOG)"
    fi
    sleep 5; elapsed=$(( elapsed + 5 ))
  done
  # Stop the trailing `docker compose logs -f` (the node itself is detached and keeps running).
  # `script` starts its child in a new session, so killing $pid alone leaves `docker compose logs -f`
  # orphaned (seen on the first live run): kill the whole process tree, leaves first.
  kill_tree "$pid"
  wait "$pid" 2>/dev/null || true
  rm -f "$tmp"
  node_running || die "bootstrap finished but the snapchain container is not running"
}

kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done
  kill -TERM "$p" 2>/dev/null || true
}

# Size in GB of the filesystem that holds (or will hold) SNAPCHAIN_DIR. DISK_SIZE_GB overrides (tests).
disk_size_gb() {
  if [[ -n "${DISK_SIZE_GB:-}" ]]; then echo "$DISK_SIZE_GB"; return; fi
  local target="$SNAPCHAIN_DIR"
  while [[ ! -e "$target" ]]; do target="$(dirname "$target")"; done
  df -P -BG "$target" | awk 'NR==2 {gsub("G","",$2); print $2}'
}

# The node finished its snapshot restore: database present, restore scratch dir gone or empty
# (on the live run an empty .rocks.snapshot stayed behind after the restore).
restore_finished() {
  [[ -n "$(ls -A "$SNAPCHAIN_DIR/.rocks" 2>/dev/null)" ]] \
    && [[ -z "$(ls -A "$SNAPCHAIN_DIR/.rocks.snapshot" 2>/dev/null)" ]]
}

# install_helper NAME GENERATOR UNIT [ENV...]: write the embedded script to HELPER_DIR and run its
# `install`, unless the same version is already installed and its unit is enabled.
install_helper() {
  local name="$1" gen="$2" unit="$3"; shift 3
  local src="$HELPER_DIR/$name.sh" dst="$SBIN_DIR/snapchain-$name"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] write %s and run: %s install (%s)\n' "$src" "$name.sh" "$*"; return 0
  fi
  $SUDO mkdir -p "$HELPER_DIR"
  "$gen" | $SUDO tee "$src" >/dev/null
  $SUDO chmod 0755 "$src"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst" && $SUDO "$SYSTEMCTL" is-enabled "$unit" >/dev/null 2>&1; then
    log "$name: already installed and enabled ($unit)."
    return 0
  fi
  log "$name: installing $unit"
  $SUDO env SNAPCHAIN_DIR="$SNAPCHAIN_DIR" SYSTEMD_DIR="$SYSTEMD_DIR" SBIN_DIR="$SBIN_DIR" SYSTEMCTL="$SYSTEMCTL" "$@" \
    bash "$src" install >/dev/null || die "$name install failed"
  log "$name: $unit is $($SUDO "$SYSTEMCTL" is-active "$unit" 2>/dev/null || echo inactive)."
}

# Small data disks (Hetzner new accounts get a 1024 GB volume quota): arm the two disk helpers
# before the node starts its restore. Never stops, restarts or touches the node itself.
install_disk_helpers() {
  local size
  case "$DISK_HELPERS" in
    0) log "DISK_HELPERS=0: not installing disk helpers."; return 0 ;;
    1|auto) ;;
    *) die "DISK_HELPERS must be auto, 1 or 0" ;;
  esac
  size="$(disk_size_gb)"
  if [[ "$DISK_HELPERS" == "auto" ]] && (( size >= DISK_HELPERS_BELOW_GB )); then
    log "Data disk ${size} GB >= ${DISK_HELPERS_BELOW_GB} GB: disk helpers not needed (DISK_HELPERS=1 installs them anyway)."
    return 0
  fi
  log "Data disk ${size} GB: arming disk-guard and snapshot-space-saver."
  install_helper disk-guard helper_disk_guard snapchain-disk-guard.timer
  if restore_finished; then
    log "space-saver: snapshot restore already finished; not needed."
  else
    install_helper space-saver helper_space_saver snapchain-space-saver.service \
      WAIT_FOR_SNAPSHOT_SECS="$SPACE_SAVER_WAIT_SECS"
  fi
}

# BEGIN EMBEDDED HELPERS (generated by tools/embed-helpers.py from disk-guard.sh and snapshot-space-saver.sh; do not edit here)
helper_disk_guard() {
  cat <<'SNAPCHAIN_HELPER_EOF'
#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# disk-guard.sh - runs ON THE VM (systemd timer, every minute). If the filesystem holding the node
# data passes LIMIT_PCT used, stop the Snapchain compose project cleanly (`docker compose stop`, so
# RocksDB shuts down properly instead of hitting ENOSPC), and write a marker. It never deletes data
# and never restarts the node: deciding what to do next (bigger volume, teardown) is left to you.
#
#   ./disk-guard.sh install   # install + start the systemd timer (root)
#   ./disk-guard.sh check     # one check (what the timer runs)
#   ./disk-guard.sh status    # print usage and marker
#   ./disk-guard.sh uninstall
# Env: SNAPCHAIN_DIR=/root/snapchain, LIMIT_PCT=90, MARKER=/root/snapchain-DISK-FULL,
#      SYSTEMD_DIR, SBIN_DIR, SYSTEMCTL (for tests)

set -euo pipefail
SNAPCHAIN_DIR="${SNAPCHAIN_DIR:-/root/snapchain}"
LIMIT_PCT="${LIMIT_PCT:-90}"
MARKER="${MARKER:-/root/snapchain-DISK-FULL}"
LOG="${LOG:-/var/log/snapchain-disk-guard.log}"
UNIT=snapchain-disk-guard
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"

ts() { TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M:%S IST'; }
used_pct() { df --output=pcent "$SNAPCHAIN_DIR" | tail -1 | tr -dc '0-9'; }

check() {
  local pct
  pct="$(used_pct)"
  if (( pct >= LIMIT_PCT )); then
    if [[ ! -f "$MARKER" ]]; then
      echo "$(ts) disk ${pct}% >= ${LIMIT_PCT}% on $(df --output=target "$SNAPCHAIN_DIR" | tail -1): stopping snapchain (docker compose stop)" | tee -a "$LOG"
      (cd "$SNAPCHAIN_DIR" && docker compose stop) >>"$LOG" 2>&1 || echo "$(ts) docker compose stop FAILED" >>"$LOG"
      { echo "disk-full $(ts) used=${pct}%"; df -h "$SNAPCHAIN_DIR"; } >"$MARKER"
    fi
  fi
}

case "${1:-check}" in
  check) check ;;
  status) df -h "$SNAPCHAIN_DIR"; [[ -f "$MARKER" ]] && cat "$MARKER" || echo "no disk-full marker" ;;
  install)
    install -m 0755 "$(readlink -f "${BASH_SOURCE[0]}")" "$SBIN_DIR/snapchain-disk-guard"
    cat >"$SYSTEMD_DIR/$UNIT.service" <<UNITEOF
[Unit]
Description=Stop Snapchain before its data disk fills up
[Service]
Type=oneshot
Environment=SNAPCHAIN_DIR=$SNAPCHAIN_DIR LIMIT_PCT=$LIMIT_PCT MARKER=$MARKER
ExecStart=$SBIN_DIR/snapchain-disk-guard check
UNITEOF
    cat >"$SYSTEMD_DIR/$UNIT.timer" <<UNITEOF
[Unit]
Description=Run snapchain-disk-guard every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNITEOF
    $SYSTEMCTL daemon-reload && $SYSTEMCTL enable --now $UNIT.timer
    $SYSTEMCTL is-active $UNIT.timer ;;
  uninstall) $SYSTEMCTL disable --now $UNIT.timer || true; rm -f "$SYSTEMD_DIR/$UNIT".{service,timer} "$SBIN_DIR/snapchain-disk-guard"; $SYSTEMCTL daemon-reload ;;
  *) echo "usage: $0 install|check|status|uninstall" >&2; exit 1 ;;
esac
SNAPCHAIN_HELPER_EOF
}
helper_space_saver() {
  cat <<'SNAPCHAIN_HELPER_EOF'
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
SNAPCHAIN_HELPER_EOF
}
# END EMBEDDED HELPERS

# Reads /v1/info JSON on stdin, prints one status line, exits 0 iff synced.
# Criterion (docs, Getting Started + Health signals): every shard in shardInfos has
# blockDelay < SYNC_MAX_BLOCK_DELAY ("single digits when synced") and maxHeight > 0.
sync_status() {
  local info line
  info="$(cat)"
  line="$(printf '%s' "$info" | jq -r '
    (.shardInfos // [])
    | map("shard \(.shardId): height=\(.maxHeight // 0) blockDelay=\(.blockDelay // "?")")
    | join(" | ")')" || return 2
  if printf '%s' "$info" | jq -e --argjson max "$SYNC_MAX_BLOCK_DELAY" '
      (.shardInfos // []) as $s
      | ($s | length) > 0
        and ($s | all(((.maxHeight // 0) > 0) and ((.blockDelay // 1e18) < $max)))' >/dev/null; then
    echo "SYNCED $line"; return 0
  fi
  echo "SYNCING $line"; return 1
}

fetch_info() { curl -fsS --max-time 10 "$SNAPCHAIN_HTTP/v1/info"; }

wait_for_sync() {
  local start now info line rc passes=0
  start="$(date +%s)"
  log "Waiting for sync: all shards blockDelay < ${SYNC_MAX_BLOCK_DELAY}s for ${SYNC_STABLE_CHECKS} polls (timeout ${SYNC_TIMEOUT_SECS}s)."
  log "A new node first downloads a snapshot (several hundred GB); the HTTP API may be unreachable meanwhile."
  while true; do
    now="$(date +%s)"
    check_snapshot_failure || true
    if info="$(fetch_info 2>/dev/null)"; then
      rc=0; line="$(printf '%s' "$info" | sync_status)" || rc=$?
      log "$(date -u +%H:%M:%SZ) $line"
      if (( rc == 0 )); then
        passes=$(( passes + 1 ))
        if (( passes >= SYNC_STABLE_CHECKS )); then log "Node is in sync."; return 0; fi
      else
        passes=0
      fi
    else
      passes=0
      log "$(date -u +%H:%M:%SZ) HTTP API not answering yet (snapshot download in progress?)."
    fi
    if (( now - start >= SYNC_TIMEOUT_SECS )); then
      warn "not in sync after ${SYNC_TIMEOUT_SECS}s. Re-run './node.sh wait' later; it is safe to re-run."
      return 1
    fi
    sleep "$SYNC_POLL_SECS"
  done
}

health() {
  local info code
  echo "================ Snapchain health check ================"
  if info="$(fetch_info 2>/dev/null)"; then
    echo "HTTP API $SNAPCHAIN_HTTP/v1/info: OK"
    printf '%s' "$info" | jq -r '"version: \(.version // "?")  peer_id: \(.peer_id // "?")  numShards: \(.numShards // "?")",
      "dbStats: messages=\(.dbStats.numMessages // "?") approxSize=\(.dbStats.approxSize // "?") bytes",
      (.shardInfos // [] | .[] | "  shard \(.shardId): maxHeight=\(.maxHeight) blockDelay=\(.blockDelay)s messages=\(.numMessages)")'
    printf '%s' "$info" | sync_status >/dev/null && echo "sync: SYNCED (blockDelay < ${SYNC_MAX_BLOCK_DELAY}s on all shards)" \
      || echo "sync: NOT YET SYNCED"
  else
    echo "HTTP API $SNAPCHAIN_HTTP/v1/info: NOT REACHABLE"
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$SNAPCHAIN_HTTP/v1/castsByFid?fid=1&pageSize=1" || true)"
  echo "sample query /v1/castsByFid?fid=1&pageSize=1: HTTP $code"
  if [[ -f "$SNAPCHAIN_DIR/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    echo "--- containers"; compose ps 2>/dev/null || true
  fi
  echo "--- disk ($SNAPCHAIN_DIR)"; df -h "$SNAPCHAIN_DIR" 2>/dev/null | tail -n 1 || true
  echo "--- memory"; free -h 2>/dev/null | head -n 2 || true
  if command -v ss >/dev/null 2>&1; then
    echo "--- listening on 3381-3383"; ss -lntu 2>/dev/null | awk 'NR==1 || /:338[123] /' || true
  fi
  echo "========================================================"
}

# ---------------------------------------------------------------------------------------------
# One-shard snapshot repair (snapchain src/storage/db/snapshot.rs and src/main.rs @fc87f26, same
# on main @410f93a). Upstream fetches every shard's latest.json once, at the start, then restores
# the shards one after another in the order [1, 2, 0]. If a shard's snapshot is replaced and the
# old chunks are deleted before the node reaches it, every chunk download fails with 404. After 5
# tries 10 s apart the node logs "Failed to download snapshot chunk .../shard-N/chunk_XXXX.bin",
# panics and Docker restarts it (restart: always). On the restart .rocks is no longer empty, so
# upstream skips the snapshot and runs without shard N's data. It never retries by itself.
#
# This repair never touches a shard that finished restoring. For the failed shard only it reads
# fresh metadata, downloads the chunks itself (parallel, resumable, 404 = fresh metadata again,
# at most REPAIR_ATTEMPTS times), unpacks them into a scratch dir exactly like upstream does
# (gunzip each chunk in order, one tar, unpack), then stops the container, swaps in
# .rocks/shard-N and starts the container again.
node_logs() {
  if [[ -n "${NODE_LOGS_CMD:-}" ]]; then $NODE_LOGS_CMD 2>&1; return 0; fi   # tests
  compose logs --no-color --no-log-prefix snapchain 2>&1 || true
}

# Prints "SHARD COUNT" when upstream gave up on a shard's snapshot and will not retry: the last
# snapshot event in the logs is a failure, and .rocks is not empty. COUNT = failure lines so far.
failed_snapshot_shard() {
  local lines last
  lines="$(node_logs | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -oE 'Downloading snapshots \(legacy method\)|Force downloading snapshots|Failed to download snapshot chunk [^ :]*shard-[0-9]+/' || true)"
  last="$(tail -n 1 <<<"$lines")"
  [[ "$last" == "Failed to download snapshot chunk"* ]] || return 1
  # Empty .rocks: on its restart upstream downloads every snapshot again by itself.
  [[ -n "$(ls -A "$SNAPCHAIN_DIR/.rocks" 2>/dev/null)" ]] || return 1
  printf '%s %s\n' "$(sed -E 's#.*shard-([0-9]+)/$#\1#' <<<"$last")" "$(grep -c '^Failed to download snapshot chunk' <<<"$lines")"
}

repair_marker() { echo "$SNAPCHAIN_DIR/.node-sh-shard-$1-repaired"; }

manual_repair_help() {
  warn "Shard $1 has no snapshot data. Your other shards are fine. To restore only shard $1, run: ./node.sh repair-shard $1"
}

# repair_shard N: restore one shard from fresh metadata. Returns 0 on success.
repair_shard() {
  local shard="$1" attempt meta key n need_mb free_mb missing c rc
  [[ "$shard" =~ ^[0-9]+$ ]] || die "repair-shard needs a shard number, e.g. ./node.sh repair-shard 0"
  local work="$SNAPCHAIN_DIR/.node-sh-repair/shard-$shard" db="$SNAPCHAIN_DIR/.rocks"
  log "Repairing shard $shard only: fresh snapshot metadata, the other shards are not touched."
  if $SUDO test -f "$DISK_GUARD_MARKER"; then
    warn "disk-guard stopped the node ($DISK_GUARD_MARKER exists); not repairing. Free space first."
    return 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] remove %s/.rocks.snapshot, download %s/%s/%s/latest.json and its chunks into %s, stop snapchain, replace %s/shard-%s, start snapchain\n' \
      "$SNAPCHAIN_DIR" "$SNAPSHOT_URL" "$SNAPSHOT_NETWORK" "$shard" "$work" "$db" "$shard"
    return 0
  fi
  # Leftovers of the failed restore: the finished shards are already in .rocks and the failed
  # shard's partial chunks are useless. Upstream deletes this directory itself after a full restore.
  if [[ -e "$SNAPCHAIN_DIR/.rocks.snapshot" ]]; then
    log "Removing the failed restore's scratch dir $SNAPCHAIN_DIR/.rocks.snapshot ($($SUDO du -sh "$SNAPCHAIN_DIR/.rocks.snapshot" 2>/dev/null | cut -f1))."
    $SUDO rm -rf "$SNAPCHAIN_DIR/.rocks.snapshot"
  fi
  $SUDO mkdir -p "$work/chunks"
  for (( attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++ )); do
    log "shard $shard: attempt $attempt of $REPAIR_ATTEMPTS: reading $SNAPSHOT_URL/$SNAPSHOT_NETWORK/$shard/latest.json"
    if ! meta="$(curl -fsS --max-time 60 --retry 3 "$SNAPSHOT_URL/$SNAPSHOT_NETWORK/$shard/latest.json")"; then
      warn "shard $shard: could not read the snapshot metadata."; continue
    fi
    key="$(jq -r '.key_base // empty' <<<"$meta")"
    mapfile -t REPAIR_CHUNKS < <(jq -r '.chunks[]?' <<<"$meta")
    n="${#REPAIR_CHUNKS[@]}"
    if [[ ! "$key" =~ ^[A-Za-z0-9_./-]+$ || "$key" == *..* ]] || (( n == 0 )) \
       || printf '%s\n' "${REPAIR_CHUNKS[@]}" | grep -qvE '^chunk_[0-9]+\.bin$'; then
      warn "shard $shard: unexpected snapshot metadata; not repairing."; return 1
    fi
    if [[ "$($SUDO cat "$work/key_base" 2>/dev/null)" != "$key" ]]; then
      $SUDO rm -rf "$work/chunks"; $SUDO mkdir -p "$work/chunks"
      printf '%s\n' "$key" | $SUDO tee "$work/key_base" >/dev/null
    fi
    # Worst case per chunk: 100 MiB compressed (upstream: "100MB max each") + 100 MiB unpacked.
    need_mb=$(( n * 200 ))
    free_mb="$(df -P -BM "$SNAPCHAIN_DIR" | awk 'NR==2 {gsub("M","",$4); print $4}')"
    if (( free_mb < need_mb )); then
      warn "shard $shard: $n chunks need up to ${need_mb} MiB free, only ${free_mb} MiB free; not repairing."; return 1
    fi
    log "shard $shard: snapshot $key, $n chunks, downloading with $REPAIR_PARALLEL parallel connections."
    $SUDO rm -f "$work/failed"
    # shellcheck disable=SC2016  # the bash -c body gets its values as positional args
    printf '%s\n' "${REPAIR_CHUNKS[@]}" | xargs -P "$REPAIR_PARALLEL" -I{} $SUDO bash -c '
      dst="$1/chunks/$2"; [[ -f "$dst" ]] && exit 0
      code="$(curl -sS --retry 5 --retry-delay 10 --retry-connrefused -C - -o "$dst.part" -w "%{http_code}" "$3/$2")" || true
      if [[ "$code" == 200 || "$code" == 206 ]]; then mv -f "$dst.part" "$dst"
      else rm -f "$dst.part"; echo "$code $2" >> "$1/failed"; fi' _ "$work" {} "$SNAPSHOT_URL/$key" || true
    if [[ -s "$work/failed" ]]; then
      missing="$(wc -l < "$work/failed")"
      if grep -q '^404 ' "$work/failed"; then
        warn "shard $shard: $missing chunks failed, 404 included: the snapshot was replaced during the download. Reading fresh metadata."
      else
        warn "shard $shard: $missing chunks failed ($(head -n 1 "$work/failed")). Retrying."
      fi
      continue
    fi
    if $SUDO test -f "$DISK_GUARD_MARKER"; then
      warn "disk-guard stopped the node during the download ($DISK_GUARD_MARKER); not repairing. Chunks are kept in $work."
      return 1
    fi
    log "shard $shard: all $n chunks downloaded. Unpacking into $work/unpack"
    $SUDO rm -rf "$work/unpack"; $SUDO mkdir -p "$work/unpack"
    rc=0
    for c in "${REPAIR_CHUNKS[@]}"; do $SUDO gunzip -c "$work/chunks/$c" || exit 1; done \
      | $SUDO tar --no-same-owner -x -C "$work/unpack" || rc=$?
    if (( rc != 0 )) || [[ "$(ls -A "$work/unpack")" != "shard-$shard" ]]; then
      warn "shard $shard: unpack failed or the archive does not hold exactly shard-$shard/. Downloading again."
      $SUDO rm -rf "$work/chunks" "$work/unpack" "$work/key_base"; $SUDO mkdir -p "$work/chunks"
      continue
    fi
    log "shard $shard: stopping snapchain to swap in the restored shard (other shards untouched)."
    compose stop snapchain >/dev/null 2>&1 || warn "docker compose stop snapchain failed"
    $SUDO rm -rf "$db/shard-$shard"
    $SUDO mv "$work/unpack/shard-$shard" "$db/shard-$shard"
    printf 'key_base=%s\nfailures=%s\nrestored=%s\n' "$key" "${REPAIR_FAILURES:-0}" "$(date -u +%FT%TZ)" \
      | $SUDO tee "$(repair_marker "$shard")" >/dev/null
    $SUDO rm -rf "$work"
    compose start snapchain >/dev/null 2>&1 || warn "docker compose start snapchain failed"
    log "shard $shard: restored from $key and snapchain started again."
    return 0
  done
  warn "shard $shard: repair failed after $REPAIR_ATTEMPTS attempts. Downloaded chunks are kept in $work; re-running resumes them."
  return 1
}

# Called from wait_for_sync on every poll. Only looks at the logs while the restore's scratch
# metadata exists (upstream deletes .rocks.snapshot after a full restore). Acts once per node.sh run.
REPAIR_TRIED=""
check_snapshot_failure() {
  local found shard count marker_count
  [[ -z "$REPAIR_TRIED" ]] || return 0
  [[ -f "$SNAPCHAIN_DIR/.rocks.snapshot/metadata.json" ]] || $SUDO test -f "$SNAPCHAIN_DIR/.rocks.snapshot/metadata.json" 2>/dev/null || return 0
  # `./node.sh wait` does not set up sudo; the database is root's on the VM.
  if [[ -z "$SUDO" && "$(id -u)" -ne 0 && ! -w "$SNAPCHAIN_DIR/.rocks" ]] && sudo -n true 2>/dev/null; then SUDO=sudo; fi
  found="$(failed_snapshot_shard)" || return 0
  read -r shard count <<<"$found"
  marker_count="$($SUDO sed -n 's/^failures=//p' "$(repair_marker "$shard")" 2>/dev/null || true)"
  [[ -n "$marker_count" ]] && (( count <= marker_count )) && return 0   # already repaired
  REPAIR_TRIED="$shard"
  warn "Snapchain could not download the shard $shard snapshot (log: 'Failed to download snapshot chunk'). The snapshot was most likely replaced during the restore, and the node will not retry it by itself."
  if [[ "$SNAPSHOT_REPAIR" != "auto" ]]; then manual_repair_help "$shard"; return 0; fi
  REPAIR_FAILURES="$count" repair_shard "$shard" || manual_repair_help "$shard"
}

main() {
  local cmd="${1:-all}"
  command -v jq >/dev/null 2>&1 || [[ "$cmd" == "all" ]] || die "jq is required"
  case "$cmd" in
    health) health; return 0 ;;
    wait)   wait_for_sync || true; health; return 0 ;;
    helpers) setup_sudo; install_disk_helpers; return 0 ;;
    repair-shard) setup_sudo; repair_shard "${2:-}"; return $? ;;
    all)    ;;
    *) die "usage: $0 [all|wait|health|helpers|repair-shard N]" ;;
  esac
  setup_sudo
  check_os
  wait_cloud_init
  check_resources
  install_deps
  install_docker
  seed_env
  install_disk_helpers
  run_bootstrap
  if [[ "$WAIT_FOR_SYNC" == "1" && "$DRY_RUN" != "1" ]]; then wait_for_sync || true; fi
  [[ "$DRY_RUN" == "1" ]] || health
}

# Run main unless sourced (tests source this file). Works for `bash node.sh` and `bash -s < node.sh`.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
