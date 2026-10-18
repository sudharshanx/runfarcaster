#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# provision.sh - create a Hetzner Cloud VM (+ data volume + firewall) for a Snapchain read node,
# using the official `hcloud` CLI. Prints the server's public IPv4.
#
# !!! THIS CREATES BILLABLE RESOURCES. Run teardown.sh to delete them. !!!
#
# Required:
#   HCLOUD_TOKEN    Hetzner Cloud API token (read/write), read by hcloud from the environment.
#                   This script never prints, logs or stores it.
#   SSH_KEY         Name or ID of an SSH key already uploaded to your Hetzner project
#                   (`hcloud ssh-key list`). Only the public key lives at Hetzner.
# Optional:
#   NAME=snapchain-read-node   Server name; volume is "$NAME-data", firewall "$NAME-fw".
#   SERVER_TYPE=cx43           16 GB RAM, 160 GB disk (cheapest >=16 GB x86 type). Checked via the API:
#                              must be available in LOCATION, not deprecated, >= MIN_RAM_GB RAM.
#                              Set SERVER_TYPE="" to auto-pick from SERVER_TYPE_CANDIDATES instead.
#   SERVER_TYPE_CANDIDATES="cx43 cax31 cpx42 ccx23"   Cheapest first (Hetzner price list, Oct 2026).
#                              cax31 is ARM64; the snapchain, statsd and grafana images publish arm64.
#   MAX_USD=2                  Cost guard: refuse to create anything if
#                              estimated hourly cost x EXPECTED_HOURS (rounded up) > MAX_USD.
#   EXPECTED_HOURS=6           Expected lifetime of a test run (sync + testing + teardown). Docs: the
#                              snapshot "can take up to 2 hours" (README) / "a few hours" (docs site).
#   ESTIMATE_ONLY=1            Read-only: pick the type, print the cost estimate, create nothing.
#   LOCATION=fsn1              Hetzner location (server and volume must share it): fsn1, nbg1, hel1,
#                              ash, hil or sin (`hcloud location list`). If SERVER_TYPE is not available
#                              there, the error lists where it is available and which types with
#                              >= MIN_RAM_GB RAM are available in LOCATION, cheapest first.
#   IMAGE=ubuntu-24.04
#   REQUIRED_DISK_GB=2000      Disk the node needs (docs site: 2 TB; repo README: 1.5 TB).
#                              A volume is added only if the server type's local disk is smaller.
#   VOLUME_GB=$REQUIRED_DISK_GB   Volume size (alias: VOLUME_SIZE_GB). Hetzner volumes: 10 GB .. 10 TB,
#                              BUT new Hetzner accounts have an account-wide volume quota of 1024 GB
#                              (console.hetzner.cloud/limits) and may not be allowed to raise it yet.
#                              VOLUME_GB=1000 fits that quota and worked in our live run (557.86 GB DB,
#                              75% peak). node.sh installs disk-guard.sh and snapshot-space-saver.sh
#                              itself on disks under 1500 GB (DISK_HELPERS=auto).
#   MIN_RAM_GB=16
#   SSH_SOURCE_CIDRS=0.0.0.0/0,::/0    Comma list allowed to reach port 22. Narrow this to your IP
#                              (find it with: curl -4 https://ifconfig.me).
#   NODE_API_CIDRS=""          Comma list allowed to reach the node's own HTTP (3381/tcp) and gRPC
#                              (3383/tcp) APIs. Default: closed. The web client reaches the node
#                              through Caddy on 443 (/v1/*), and you can use an SSH tunnel:
#                              ssh -N -L 3381:127.0.0.1:3381 root@$IP. Set 0.0.0.0/0,::/0 to make
#                              the raw API public (anyone can then read it and submit messages).
#   PORT_PROFILE=docs          "docs": 3382/udp gossip (+22, 80, 443, and 3381/3383 if NODE_API_CIDRS).
#                              "readme": additionally 3381/udp, 3382/tcp and 3383/udp, public (README text).
#   DRY_RUN=1                  Print the hcloud commands instead of running them (needs no token).
#   WATCHDOG=1                 Start watchdog.sh in the background before creating anything (output in
#                              .provision-state/watchdog.out). It passes MAX_USD, WATCHDOG_MAX_WALL_SECS
#                              (as MAX_WALL_SECS, default 86400) and SSH_KEY_FILE (default
#                              ~/.ssh/id_ed25519 if it exists). It deletes everything after 24 h by
#                              design. Skipped if one is already running. WATCHDOG=0 to skip.
#
# Idempotent: existing firewall/volume/server with the same names are reused, not duplicated.

set -euo pipefail
set +x  # never trace: keeps HCLOUD_TOKEN out of any xtrace output

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="${NAME:-snapchain-read-node}"
SERVER_TYPE="${SERVER_TYPE-cx43}"
SERVER_TYPE_CANDIDATES="${SERVER_TYPE_CANDIDATES:-cx43 cax31 cpx42 ccx23}"
LOCATION="${LOCATION:-fsn1}"
IMAGE="${IMAGE:-ubuntu-24.04}"
REQUIRED_DISK_GB="${REQUIRED_DISK_GB:-2000}"
VOLUME_SIZE_GB="${VOLUME_GB:-${VOLUME_SIZE_GB:-$REQUIRED_DISK_GB}}"
MIN_RAM_GB="${MIN_RAM_GB:-16}"
SSH_SOURCE_CIDRS="${SSH_SOURCE_CIDRS:-0.0.0.0/0,::/0}"
PORT_PROFILE="${PORT_PROFILE:-docs}"
NODE_API_CIDRS="${NODE_API_CIDRS:-}"
DRY_RUN="${DRY_RUN:-0}"
MAX_USD="${MAX_USD:-2}"
EXPECTED_HOURS="${EXPECTED_HOURS:-6}"
ESTIMATE_ONLY="${ESTIMATE_ONLY:-0}"
WATCHDOG="${WATCHDOG:-1}"
WATCHDOG_CMD="${WATCHDOG_CMD:-$HERE/watchdog.sh}"   # overridable for tests
STATE_DIR="${STATE_DIR:-$HERE/.provision-state}"
LABEL_KEY="app"
LABEL_VAL="snapchain-tutorial"
FIREWALL_NAME="$NAME-fw"
VOLUME_NAME="$NAME-data"
# Where the node's data (~/snapchain of root, i.e. .rocks + .rocks.snapshot) must live.
DATA_MOUNT="/root/snapchain"

log() { printf '[provision] %s\n' "$*" >&2; }
die() { printf '[provision] ERROR: %s\n' "$*" >&2; exit 1; }

hc() {
  if [[ "$DRY_RUN" == "1" ]]; then printf '[dry-run] hcloud %s\n' "$*" >&2; return 0; fi
  hcloud "$@"
}
exists() { [[ "$DRY_RUN" == "1" ]] && return 1; hcloud "$1" describe "$2" >/dev/null 2>&1; }

preflight() {
  command -v jq >/dev/null 2>&1 || die "jq is required"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v hcloud >/dev/null 2>&1 || die "install the official hcloud CLI: https://github.com/hetznercloud/cli"
    [[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN is not set (export it in your shell; it is never printed)"
  fi
  [[ "$ESTIMATE_ONLY" == "1" || -n "${SSH_KEY:-}" ]] || die "SSH_KEY (name or ID of a key in your Hetzner project) is required"
  [[ "$PORT_PROFILE" == "docs" || "$PORT_PROFILE" == "readme" ]] || die "PORT_PROFILE must be docs or readme"
  (( VOLUME_SIZE_GB >= 10 && VOLUME_SIZE_GB <= 10240 )) || die "VOLUME_SIZE_GB must be 10..10240 (Hetzner volume limits)"
  local c
  IFS=',' read -r -a _cidrs <<<"$SSH_SOURCE_CIDRS"
  for c in "${_cidrs[@]}"; do
    [[ "$c" =~ ^[0-9a-fA-F.:]+/[0-9]{1,3}$ ]] || die "SSH_SOURCE_CIDRS has an invalid entry '$c' (expected like 203.0.113.7/32). Did 'curl -4 -s https://ifconfig.me' fail?"
  done
  if [[ "$SSH_SOURCE_CIDRS" == "0.0.0.0/0,::/0" ]]; then
    log "NOTE: SSH (22/tcp) open to the whole internet. Set SSH_SOURCE_CIDRS=YOUR_IP/32 to narrow it (curl -4 https://ifconfig.me)."
  fi
}

# Prints why a server type is unusable in LOCATION, or nothing if usable. Read-only API call.
type_problem() {
  local st
  st="$(hcloud server-type describe "$1" -o json 2>/dev/null)" || { echo "unknown server type"; return; }
  jq -r --arg loc "$LOCATION" --argjson min "$MIN_RAM_GB" '
    if .deprecated == true then "deprecated"
    elif .memory < $min then "only \(.memory) GB RAM"
    elif ([.locations[]? | select(.name == $loc)] | length) == 0 then "not offered in \($loc)"
    elif ([.locations[]? | select(.name == $loc and .available == false)] | length) > 0 then "not available in \($loc) right now"
    else empty end' <<<"$st"
}

# Read-only. Explains a "not available" error: where TYPE ($1, may be empty) is available now,
# and which types with >= MIN_RAM_GB RAM are available in LOCATION, cheapest first.
availability_hint() {
  local t="$1" where="" alts all
  if [[ -n "$t" ]]; then
    where="$(hcloud server-type describe "$t" -o json 2>/dev/null \
      | jq -r '[.locations[]? | select(.available == true) | .name] | join(", ")' 2>/dev/null)" || where=""
    echo "$t is available now in: ${where:-no location}."
  fi
  all="$(hcloud server-type list -o json 2>/dev/null)" || all='[]'
  alts="$(jq -r --arg loc "$LOCATION" --argjson min "$MIN_RAM_GB" '
    [ .[] | select(.deprecated != true and .deprecation == null and .memory >= $min)
          | select([.locations[]? | select(.name == $loc and .available == true)] | length > 0)
          | { name, arch: .architecture, mem: .memory,
              h: ([.prices[]? | select(.location == $loc) | .price_hourly.gross | tonumber] | first) } ]
    | sort_by(.h // 1e9) | .[:4]
    | map("\(.name) (\(.arch), \(.mem) GB RAM\(if .h then ", \(.h * 10000 | round / 10000) an hour" else "" end))")
    | join(", ")' <<<"$all" 2>/dev/null)" || alts=""
  echo "Available in $LOCATION with at least $MIN_RAM_GB GB RAM, cheapest first: ${alts:-none}."
  echo "Set SERVER_TYPE=<type> and/or LOCATION=<location> and run it again. Nothing was created."
}

# Fails with the list of locations if LOCATION is not a Hetzner location. Read-only API call.
check_location() {
  hcloud location describe "$LOCATION" -o json >/dev/null 2>&1 && return 0
  local names
  names="$(hcloud location list -o json 2>/dev/null | jq -r 'map(.name) | join(", ")' 2>/dev/null)" || names=""
  die "unknown LOCATION=$LOCATION. Hetzner locations: ${names:-see hcloud location list}. Nothing was created."
}

# Picks SERVER_TYPE (if unset) and sets NEED_VOLUME=0/1 from the type's local disk.
NEED_VOLUME=1
check_server_type() {
  if [[ "$DRY_RUN" == "1" ]]; then
    SERVER_TYPE="${SERVER_TYPE:-${SERVER_TYPE_CANDIDATES%% *}}"
    log "dry-run: using $SERVER_TYPE, assuming local disk < ${REQUIRED_DISK_GB} GB -> volume needed"
    NEED_VOLUME=1; return 0
  fi
  local t problem
  check_location
  if [[ -z "$SERVER_TYPE" ]]; then
    for t in $SERVER_TYPE_CANDIDATES; do
      problem="$(type_problem "$t")"
      if [[ -z "$problem" ]]; then SERVER_TYPE="$t"; break; fi
      log "skipping $t: $problem"
    done
    [[ -n "$SERVER_TYPE" ]] || die "none of [$SERVER_TYPE_CANDIDATES] is usable in $LOCATION. $(availability_hint "" | tr '\n' ' ')"
  else
    problem="$(type_problem "$SERVER_TYPE")"
    if [[ -n "$problem" ]]; then
      case "$problem" in
        not\ *) die "server type $SERVER_TYPE: $problem. $(availability_hint "$SERVER_TYPE" | tr '\n' ' ')" ;;
        *) die "server type $SERVER_TYPE: $problem" ;;
      esac
    fi
  fi
  local st disk
  st="$(hcloud server-type describe "$SERVER_TYPE" -o json)"
  disk="$(jq -r '.disk' <<<"$st")"
  log "server type $SERVER_TYPE: $(jq -r '"\(.cores) vCPU (\(.cpu_type)), \(.memory) GB RAM, \(.disk) GB disk, \(.architecture)"' <<<"$st")"
  if (( disk >= REQUIRED_DISK_GB )); then
    NEED_VOLUME=0; log "local disk ${disk} GB >= ${REQUIRED_DISK_GB} GB: no extra volume"
  else
    NEED_VOLUME=1; log "local disk ${disk} GB < ${REQUIRED_DISK_GB} GB: adding a ${VOLUME_SIZE_GB} GB volume"
  fi
}

# Read-only GET of the live price list. The token is passed to curl on stdin (-H @-), so it
# never appears in the process list, the terminal, or any log.
fetch_pricing() {
  printf 'Authorization: Bearer %s\n' "$HCLOUD_TOKEN" \
    | curl -fsS --max-time 30 -H @- "https://api.hetzner.cloud/v1/pricing"
}

# Cost guard. Server + primary IPv4 hourly prices come straight from the API. Volumes are only
# priced per GB per MONTH by the API, so the volume's hourly cost is an ESTIMATE: monthly price
# divided by the server type's own monthly/hourly ratio (Hetzner bills hourly up to a monthly cap).
cost_guard() {
  if [[ "$DRY_RUN" == "1" ]]; then log "dry-run: cost guard skipped (needs the live price list)"; return 0; fi
  local pricing st
  pricing="$(fetch_pricing)" || die "could not read https://api.hetzner.cloud/v1/pricing"
  st="$(hcloud server-type describe "$SERVER_TYPE" -o json)"
  local est
  est="$(jq -n --argjson p "$pricing" --argjson st "$st" --arg loc "$LOCATION" \
      --argjson vol "$(( NEED_VOLUME == 1 ? VOLUME_SIZE_GB : 0 ))" --argjson hours "$EXPECTED_HOURS" '
    ($st.prices[] | select(.location == $loc)) as $sp
    | ($sp.price_hourly.gross | tonumber) as $srv_h
    | (($sp.price_monthly.gross | tonumber) / $srv_h) as $ratio
    | ([$p.pricing.primary_ips[]? | select(.type == "ipv4") | .prices[]? | select(.location == $loc) | .price_hourly.gross | tonumber] | first // 0) as $ip_h
    | (($p.pricing.volume.price_per_gb_month.gross | tonumber) * $vol) as $vol_m
    | ($vol_m / $ratio) as $vol_h
    | ($srv_h + $ip_h + $vol_h) as $total_h
    | ($hours | ceil) as $billed_h
    | { currency: $p.pricing.currency, server_h: $srv_h, ipv4_h: $ip_h, volume_gb: $vol, volume_month: $vol_m,
        volume_h_est: $vol_h, total_h: $total_h, billed_hours: $billed_h, projected: ($total_h * $billed_h) }')" \
    || die "could not compute a cost estimate (no price for $SERVER_TYPE in $LOCATION?)"
  jq -r '
    "COST ESTIMATE (from the live price list, NOT a measurement; currency \(.currency), gross):",
    "  server      \(.server_h) /h",
    "  IPv4        \(.ipv4_h) /h",
    "  volume      \(.volume_gb) GB = \(.volume_month * 100 | round / 100) /month -> ~\(.volume_h_est * 10000 | round / 10000) /h (estimated)",
    "  total       ~\(.total_h * 10000 | round / 10000) /h",
    "  projected   ~\(.projected * 100 | round / 100) for \(.billed_hours) h (EXPECTED_HOURS, rounded up)"' <<<"$est" >&2
  if ! jq -e --argjson max "$MAX_USD" '.projected <= $max' <<<"$est" >/dev/null; then
    die "projected cost exceeds MAX_USD=$MAX_USD. Nothing was created. Lower EXPECTED_HOURS/VOLUME_SIZE_GB or raise MAX_USD."
  fi
  log "cost guard OK: projected <= MAX_USD=$MAX_USD"
}

firewall_rules() {
  local files=("$HERE/deploy/hetzner/firewall-rules.json")
  [[ "$PORT_PROFILE" == "readme" ]] && files+=("$HERE/deploy/hetzner/firewall-rules-readme-superset.json")
  jq -s --arg ssh "$SSH_SOURCE_CIDRS" --arg api "$NODE_API_CIDRS" '
    add | map(if .port == "22" and .protocol == "tcp" then .source_ips = ($ssh | split(",")) else . end)
    + (if $api == "" then [] else [
        {"direction": "in", "protocol": "tcp", "port": "3381", "source_ips": ($api | split(",")), "description": "Snapchain HTTP API (NODE_API_CIDRS)"},
        {"direction": "in", "protocol": "tcp", "port": "3383", "source_ips": ($api | split(",")), "description": "Snapchain gRPC API (NODE_API_CIDRS)"}
      ] end)
  ' "${files[@]}"
}

ensure_firewall() {
  local rules; rules="$(mktemp)"
  firewall_rules > "$rules"
  if exists firewall "$FIREWALL_NAME"; then
    log "firewall $FIREWALL_NAME exists; replacing its rules"
  else
    hc firewall create --name "$FIREWALL_NAME" --label "$LABEL_KEY=$LABEL_VAL" >/dev/null
  fi
  hc firewall replace-rules --rules-file "$rules" "$FIREWALL_NAME" >/dev/null
  rm -f "$rules"
}

VOLUME_DEVICE=""
ensure_volume() {
  (( NEED_VOLUME == 1 )) || return 0
  if exists volume "$VOLUME_NAME"; then
    log "volume $VOLUME_NAME exists; reusing it"
  else
    hc volume create --name "$VOLUME_NAME" --size "$VOLUME_SIZE_GB" --location "$LOCATION" \
      --format ext4 --label "$LABEL_KEY=$LABEL_VAL" >/dev/null \
      || die "volume create failed. If the error was 'volumes size limit exceeded (resource_limit_exceeded)',
your ACCOUNT's total volume quota (https://console.hetzner.cloud/limits, shared by all projects) is
below ${VOLUME_SIZE_GB} GB. Request a limit increase there (reviewed manually by Hetzner), then re-run;
the firewall created so far is reused. No server was created."
  fi
  if [[ "$DRY_RUN" == "1" ]]; then VOLUME_DEVICE="/dev/disk/by-id/scsi-0HC_Volume_DRYRUN"; return 0; fi
  VOLUME_DEVICE="$(hcloud volume describe "$VOLUME_NAME" -o json | jq -r '.linux_device')"
  [[ "$VOLUME_DEVICE" == /dev/* ]] || die "could not read linux_device of $VOLUME_NAME"
}

# cloud-init: mount the volume at /root/snapchain (where the official bootstrap puts the node)
# before node.sh runs. `nofail` keeps the VM bootable if the volume is missing.
write_user_data() {
  local f="$1"
  {
    echo "#cloud-config"
    if [[ -n "$VOLUME_DEVICE" ]]; then
      cat <<YAML
runcmd:
  - [ mkdir, -p, "$DATA_MOUNT" ]
  - [ sh, -c, "grep -q '$VOLUME_DEVICE' /etc/fstab || echo '$VOLUME_DEVICE $DATA_MOUNT ext4 discard,nofail,defaults 0 0' >> /etc/fstab" ]
  - [ mount, -a ]
YAML
    fi
  } > "$f"
}

ensure_server() {
  if exists server "$NAME"; then
    log "server $NAME exists; not recreating"
    return 0
  fi
  local ud; ud="$(mktemp)"
  write_user_data "$ud"
  local args=(server create --name "$NAME" --type "$SERVER_TYPE" --image "$IMAGE" --location "$LOCATION"
              --ssh-key "$SSH_KEY" --firewall "$FIREWALL_NAME" --label "$LABEL_KEY=$LABEL_VAL"
              --user-data-from-file "$ud")
  [[ -n "$VOLUME_DEVICE" ]] && args+=(--volume "$VOLUME_NAME")
  hc "${args[@]}" >/dev/null
  rm -f "$ud"
}

print_ip() {
  local ip
  if [[ "$DRY_RUN" == "1" ]]; then ip="203.0.113.10 (dry-run placeholder)"
  else ip="$(hcloud server ip "$NAME")"; fi
  local free_env=""
  (( NEED_VOLUME == 1 && VOLUME_SIZE_GB < 1500 )) && free_env=" MIN_FREE_GB=$(( VOLUME_SIZE_GB * 9 / 10 ))"
  log "done. Next (in a new terminal, get the IP back with: IP=\$(hcloud server ip $NAME)):"
  log "  ssh root@${ip%% *} \"SNAPCHAIN_AGREE_NO_REWARDS=yes${free_env} bash -s\" < node.sh"
  log "  ./deploy-client.sh ${ip%% *}"
  # The IP is the only thing on stdout, so `IP=$(./provision.sh)` works.
  printf '%s\n' "${ip%% *}"
}

# Starts watchdog.sh in the background unless one is already running. Fails loudly if it does not
# come up (for example HCLOUD_TOKEN missing), before anything is created.
start_watchdog() {
  [[ "$WATCHDOG" == "1" ]] || { log "WATCHDOG=0: no watchdog started (no automatic spending cap)."; return 0; }
  if [[ "$DRY_RUN" == "1" ]]; then log "dry-run: would start $WATCHDOG_CMD (MAX_USD=$MAX_USD)"; return 0; fi
  mkdir -p "$STATE_DIR"
  local pidf="$STATE_DIR/watchdog.pid" pid key="${SSH_KEY_FILE:-}"
  if [[ -f "$pidf" ]] && pid="$(cat "$pidf")" && kill -0 "$pid" 2>/dev/null; then
    log "watchdog already running (pid $pid); not starting another."
    return 0
  fi
  [[ -z "$key" && -f "$HOME/.ssh/id_ed25519" ]] && key="$HOME/.ssh/id_ed25519"
  rm -f "$pidf"
  MAX_USD="$MAX_USD" MAX_WALL_SECS="${WATCHDOG_MAX_WALL_SECS:-86400}" SSH_KEY_FILE="$key" NAME="$NAME" STATE_DIR="$STATE_DIR" \
    nohup "$WATCHDOG_CMD" >>"$STATE_DIR/watchdog.out" 2>&1 </dev/null &
  local wpid=$!
  sleep "${WATCHDOG_START_WAIT:-2}"
  if ! kill -0 "$wpid" 2>/dev/null; then
    tail -n 5 "$STATE_DIR/watchdog.out" >&2 || true
    die "watchdog did not start (see $STATE_DIR/watchdog.out). Nothing was created. Fix it, or set WATCHDOG=0 to go without."
  fi
  log "watchdog started (pid $wpid). It deletes everything when the bill would pass MAX_USD=$MAX_USD, after $(( ${WATCHDOG_MAX_WALL_SECS:-86400} / 3600 )) h even if the node is healthy, or after 2 h without progress${key:+ (progress check over SSH with $key)}."
  log "  log: $STATE_DIR/watchdog.log  stop without deleting: touch $STATE_DIR/watchdog.disarm"
}

main() {
  preflight
  check_server_type
  cost_guard
  if [[ "$ESTIMATE_ONLY" == "1" ]]; then log "ESTIMATE_ONLY=1: nothing created."; return 0; fi
  start_watchdog
  ensure_firewall
  ensure_volume
  ensure_server
  print_ip
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
