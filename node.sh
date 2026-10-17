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
#   SYNC_TIMEOUT_SECS           Default 43200 (12 h). Docs say snapshot download takes hours.
#   BOOTSTRAP_TIMEOUT_SECS      Default 3600. Max time for bootstrap to reach "Upgrade complete".
#   MIN_FREE_GB                 Default 1500. Preflight free-disk check for SNAPCHAIN_DIR.
#   MIN_RAM_GB                  Default 15 (16 GB VMs report slightly less than 16 GiB).
#   SKIP_PREFLIGHT=1            Downgrade preflight failures to warnings.
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
SYNC_TIMEOUT_SECS="${SYNC_TIMEOUT_SECS:-43200}"
BOOTSTRAP_TIMEOUT_SECS="${BOOTSTRAP_TIMEOUT_SECS:-3600}"
MIN_FREE_GB="${MIN_FREE_GB:-1500}"
MIN_RAM_GB="${MIN_RAM_GB:-15}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-0}"
DRY_RUN="${DRY_RUN:-0}"
BOOTSTRAP_LOG="${BOOTSTRAP_LOG:-$SNAPCHAIN_DIR/node-sh-bootstrap.log}"

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
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$tmp"
  node_running || die "bootstrap finished but the snapchain container is not running"
}

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

main() {
  local cmd="${1:-all}"
  command -v jq >/dev/null 2>&1 || [[ "$cmd" == "all" ]] || die "jq is required"
  case "$cmd" in
    health) health; return 0 ;;
    wait)   wait_for_sync || true; health; return 0 ;;
    all)    ;;
    *) die "usage: $0 [all|wait|health]" ;;
  esac
  setup_sudo
  check_os
  wait_cloud_init
  check_resources
  install_deps
  install_docker
  seed_env
  run_bootstrap
  if [[ "$WAIT_FOR_SYNC" == "1" && "$DRY_RUN" != "1" ]]; then wait_for_sync || true; fi
  [[ "$DRY_RUN" == "1" ]] || health
}

# Run main unless sourced (tests source this file). Works for `bash node.sh` and `bash -s < node.sh`.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
