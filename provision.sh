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
#   MAX_USD=8                  Cost guard: refuse to create anything if
#                              estimated hourly cost x EXPECTED_HOURS (rounded up) > MAX_USD.
#                              Also passed to the watchdog as its budget.
#   EXPECTED_HOURS=24          Expected lifetime of a test run (sync + testing + teardown).
#                              Measured: 14 h 06 m from provision to synced on cax31 (MEASUREMENTS.md);
#                              24 h matches the watchdog's time cap.
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
#                              (as MAX_WALL_SECS; MAX_WALL_SECS is accepted too; default 86400) and SSH_KEY_FILE (default
#                              ~/.ssh/id_ed25519 if it exists). It deletes everything after 24 h by
#                              design. Skipped if one is already running. WATCHDOG=0 to skip.
#   REUSE=0                    If a server named NAME, or the volume NAME-data, already exists, stop
#                              before changing anything: it may belong to someone else in a shared
#                              project. REUSE=1 continues with them (your own earlier run).
#   VOLUME_QUOTA_GB=1024       Account-wide volume quota (new Hetzner accounts: 1024 GB across all
#                              projects). Volumes already in this project count against it; other
#                              projects cannot be seen with this token. Raise it if Hetzner raised yours.
#
# Re-running after a failure: a firewall named NAME-fw that is not applied to any server is reused.

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
MAX_USD="${MAX_USD:-8}"
EXPECTED_HOURS="${EXPECTED_HOURS:-24}"
ESTIMATE_ONLY="${ESTIMATE_ONLY:-0}"
WATCHDOG="${WATCHDOG:-1}"
REUSE="${REUSE:-0}"
VOLUME_QUOTA_GB="${VOLUME_QUOTA_GB:-1024}"
WALL_SECS="${WATCHDOG_MAX_WALL_SECS:-${MAX_WALL_SECS:-86400}}"
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
  [[ "${WATCHDOG_T0:-0}" =~ ^[0-9]+$ ]] || die "WATCHDOG_T0 must be a Unix time in seconds (date +%s), got '$WATCHDOG_T0'"
  (( VOLUME_SIZE_GB >= 10 && VOLUME_SIZE_GB <= 10240 )) || die "VOLUME_SIZE_GB must be 10..10240 (Hetzner volume limits)"
  local c cidrs=()
  IFS=',' read -r -a cidrs <<<"$SSH_SOURCE_CIDRS"
  for c in ${cidrs[@]+"${cidrs[@]}"}; do   # bash 3.2 + set -u: an empty "${a[@]}" is unbound
    [[ "$c" =~ ^[0-9a-fA-F.:]+/[0-9]{1,3}$ ]] || die "SSH_SOURCE_CIDRS has an invalid entry '$c' (expected like 203.0.113.7/32). Did 'curl -4 -s https://ifconfig.me' fail?"
  done
  if [[ "$SSH_SOURCE_CIDRS" == "0.0.0.0/0,::/0" && "$ESTIMATE_ONLY" != "1" ]]; then
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
    log "dry-run: availability is not checked. A live run skips types that are not available to rent and may pick another one; ESTIMATE_ONLY=1 shows the live pick."
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

# Set by cost_guard (empty in DRY_RUN): hourly rate and monthly cap of server + IPv4 + volume.
COST_RATE_H=""; COST_MONTH=""; COST_CURRENCY=""

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
    | ([$p.pricing.primary_ips[]? | select(.type == "ipv4") | .prices[]? | select(.location == $loc) | .price_monthly.gross | tonumber] | first // 0) as $ip_m
    | ($srv_h + $ip_h + $vol_h) as $total_h
    | (($sp.price_monthly.gross | tonumber) + $ip_m + $vol_m) as $total_m
    | ($hours | ceil) as $billed_h
    | { currency: $p.pricing.currency, server_h: $srv_h, ipv4_h: $ip_h, volume_gb: $vol, volume_month: $vol_m,
        volume_h_est: $vol_h, total_h: $total_h, total_month: $total_m, billed_hours: $billed_h, projected: ($total_h * $billed_h) }')" \
    || die "could not compute a cost estimate (no price for $SERVER_TYPE in $LOCATION?)"
  COST_RATE_H="$(jq -r '.total_h' <<<"$est")"
  COST_MONTH="$(jq -r '.total_month' <<<"$est")"
  COST_CURRENCY="$(jq -r '.currency // ""' <<<"$est")"
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

# Stops before anything is created or changed if NAME is taken in this project (shared projects:
# another person's node, volume or firewall must never be reused or rewritten by accident).
guard_existing() {
  [[ "$DRY_RUN" == "1" ]] && return 0
  local taken=() applied
  exists server "$NAME" && taken+=("server $NAME")
  exists volume "$VOLUME_NAME" && taken+=("volume $VOLUME_NAME")
  if exists firewall "$FIREWALL_NAME"; then
    applied="$(hcloud firewall describe "$FIREWALL_NAME" -o json | jq '[.applied_to[]?] | length')"
    (( applied > 0 )) && taken+=("firewall $FIREWALL_NAME (applied to $applied server(s))")
  fi
  (( ${#taken[@]} == 0 )) && return 0
  if [[ "$REUSE" == "1" ]]; then log "REUSE=1: continuing with existing ${taken[*]}"; return 0; fi
  die "this project already has: ${taken[*]}. It may be someone else's node. Nothing was created or changed.
  New node: pick another name, e.g. export NAME=snapchain-read-node-2, and run it again (use the same NAME for teardown).
  Your own earlier run: REUSE=1 ./provision.sh continues with it.
  Best: use an empty Hetzner project for this guide."
}

# Hetzner's volume quota is per account; this sees only this project's volumes.
check_volume_quota() {
  (( NEED_VOLUME == 1 )) || return 0
  [[ "$DRY_RUN" == "1" ]] && return 0
  exists volume "$VOLUME_NAME" && return 0  # reused, no new space
  local used
  used="$(hcloud volume list -o json | jq '[.[]?.size] | add // 0')" || used=0
  if (( used + VOLUME_SIZE_GB > VOLUME_QUOTA_GB )); then
    die "volumes in this project already use ${used} GB; adding ${VOLUME_SIZE_GB} GB would pass the ${VOLUME_QUOTA_GB} GB account quota (https://console.hetzner.cloud/limits, shared by all projects). Nothing was created.
  Lower VOLUME_GB, delete an old volume, or ask Hetzner to raise the limit and set VOLUME_QUOTA_GB to the new value."
  fi
  log "volume quota: ${used} GB used in this project + ${VOLUME_SIZE_GB} GB new <= ${VOLUME_QUOTA_GB} GB (other projects not visible; if they hold volumes, Hetzner may still refuse)"
}

CREATED_FIREWALL=0
ensure_firewall() {
  local rules; rules="$(mktemp)"
  firewall_rules > "$rules"
  if exists firewall "$FIREWALL_NAME"; then
    log "firewall $FIREWALL_NAME exists; replacing its rules"
  else
    hc firewall create --name "$FIREWALL_NAME" --label "$LABEL_KEY=$LABEL_VAL" >/dev/null
    CREATED_FIREWALL=1
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
    if ! hc volume create --name "$VOLUME_NAME" --size "$VOLUME_SIZE_GB" --location "$LOCATION" \
      --format ext4 --label "$LABEL_KEY=$LABEL_VAL" >/dev/null; then
      if (( CREATED_FIREWALL == 1 )); then
        hcloud firewall delete "$FIREWALL_NAME" >/dev/null 2>&1 && log "removed the firewall $FIREWALL_NAME this run created"
      fi
      die "volume create failed. If the error was 'volumes size limit exceeded (resource_limit_exceeded)',
your ACCOUNT's total volume quota (https://console.hetzner.cloud/limits, shared by all projects) is
below ${VOLUME_SIZE_GB} GB. Request a limit increase there (reviewed manually by Hetzner), then re-run.
No server or volume was created."
    fi
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
  # teardown.sh compares this ID before deleting, so it never removes a same-named server it didn't create.
  if [[ "$DRY_RUN" != "1" ]]; then
    mkdir -p "$STATE_DIR"
    hcloud server describe "$NAME" -o json | jq -r '.id' > "$STATE_DIR/server-$NAME.id" || true
  fi
}

# money AMOUNT DECIMALS: amount with the account currency's symbol ($ USD, € EUR, else "XYZ ").
money() {
  # External printf: bash 3.2 (macOS /bin/bash) ignores LC_ALL=C on its builtin, so a comma-decimal
  # locale (LANG=de_DE.UTF-8) would reject "0.21".
  local n; n="$(env LC_ALL=C printf "%.${2}f" "$1")"
  case "$COST_CURRENCY" in
    USD) printf '$%s' "$n" ;;
    EUR) printf '€%s' "$n" ;;
    "") printf '%s' "$n" ;;
    *) printf '%s %s' "$COST_CURRENCY" "$n" ;;
  esac
}
# GNU date -d, else BSD/macOS date -r; never fails (the reminder must not stop the IP being printed).
fmt_epoch() { date -d "@$1" '+%H:%M %Z on %-d %b' 2>/dev/null || date -r "$1" '+%H:%M %Z on %-d %b' 2>/dev/null || printf 'Unix time %s' "$1"; }

# Epoch at which the watchdog starts its teardown, mirroring watchdog.sh's main loop: it fires at
# elapsed >= MAX_WALL_SECS (time cap), or once RATE x started hours of (elapsed + POLL_SECS +
# TEARDOWN_RESERVE_SECS) reaches MAX_USD (budget cap), checked every POLL_SECS. Prints
# "EPOCH time|budget"; EPOCH includes one POLL_SECS for the poll that notices it.
watchdog_deadline() {
  local t0="$1" poll="${POLL_SECS:-60}" reserve="${TEARDOWN_RESERVE_SECS:-900}" at="$WALL_SECS" why=time n b
  if [[ -n "$COST_RATE_H" ]] && jq -e -n "$COST_RATE_H > 0" >/dev/null; then
    n="$(jq -n --argjson r "$COST_RATE_H" --argjson m "$MAX_USD" \
      '($m / $r | ceil) as $n | if $n > 1 and $r * ($n - 1) >= $m then $n - 1 else $n end')"
    b=$(( n * 3600 - poll - reserve - 3599 )); (( b < 0 )) && b=0
    (( b < at )) && { at="$b"; why=budget; }
  fi
  echo "$(( t0 + at + poll )) $why"
}

# stderr only: what is billing now, and when the watchdog will delete it.
cost_reminder() {
  if [[ -n "$COST_RATE_H" ]]; then
    log "Billing now: $(money "$COST_RATE_H" 4)/h, at most $(money "$COST_MONTH" 2)/mo. Stop it: CONFIRM=\"$NAME\" ./teardown.sh"
  else
    log "dry-run: nothing was created, so nothing is billing. A live run prints the hourly rate here."
  fi
  [[ -n "$WATCHDOG_T0_EPOCH" ]] || return 0
  local at why
  read -r at why <<<"$(watchdog_deadline "$WATCHDOG_T0_EPOCH")"
  if [[ "$why" == time ]]; then why="time cap, $(( WALL_SECS / 3600 )) h $(( WALL_SECS % 3600 / 60 )) m after it started at $(fmt_epoch "$WATCHDOG_T0_EPOCH")"
  else why="budget cap MAX_USD=$MAX_USD at $(money "$COST_RATE_H" 4)/h, every started hour counted; time cap would be $(fmt_epoch "$(( WATCHDOG_T0_EPOCH + WALL_SECS + ${POLL_SECS:-60} ))")"; fi
  log "Watchdog deletes everything by $(fmt_epoch "$at") ($why) unless you disarm it: touch $STATE_DIR/watchdog.disarm (checked every ${POLL_SECS:-60} s, no teardown)"
}

print_ip() {
  local ip
  if [[ "$DRY_RUN" == "1" ]]; then ip="203.0.113.10 (dry-run placeholder)"
  else ip="$(hcloud server ip "$NAME")"; fi
  local free_env=""
  (( NEED_VOLUME == 1 && VOLUME_SIZE_GB < 1500 )) && free_env=" MIN_FREE_GB=$(( VOLUME_SIZE_GB * 9 / 10 ))"
  log "done. Next (in a new terminal, get the IP back with: IP=\$(hcloud server ip \"$NAME\")):"
  log "  ssh root@${ip%% *} \"SNAPCHAIN_AGREE_NO_REWARDS=yes${free_env} bash -s\" < node.sh"
  log "  ./deploy-client.sh ${ip%% *}"
  # Errors in the reminder must never cost the IP on stdout (resources exist by now).
  cost_reminder || log "could not work out the watchdog deadline; see $STATE_DIR/watchdog.log"
  # The IP is the only thing on stdout, so `IP=$(./provision.sh)` works.
  printf '%s\n' "${ip%% *}"
}

WATCHDOG_T0_EPOCH=""   # set by start_watchdog when a watchdog is (already) running

# Starts watchdog.sh in the background unless one is already running. Fails loudly if it does not
# come up (for example HCLOUD_TOKEN missing), before anything is created.
start_watchdog() {
  [[ "$WATCHDOG" == "1" ]] || { log "WATCHDOG=0: no watchdog started (no automatic spending cap)."; return 0; }
  if [[ "$DRY_RUN" == "1" ]]; then log "dry-run: would start $WATCHDOG_CMD (MAX_USD=$MAX_USD)"; return 0; fi
  mkdir -p "$STATE_DIR"
  local pidf="$STATE_DIR/watchdog.pid" pid key="${SSH_KEY_FILE:-}"
  if [[ -f "$pidf" ]] && pid="$(cat "$pidf")" && kill -0 "$pid" 2>/dev/null; then
    log "watchdog already running (pid $pid); not starting another."
    # The watchdog writes its pid file when it starts, so the file's mtime is its start time.
    WATCHDOG_T0_EPOCH="$(stat -c %Y "$pidf" 2>/dev/null || stat -f %m "$pidf" 2>/dev/null || true)"
    return 0
  fi
  [[ -z "$key" && -f "$HOME/.ssh/id_ed25519" ]] && key="$HOME/.ssh/id_ed25519"
  rm -f "$pidf"
  WATCHDOG_T0_EPOCH="${WATCHDOG_T0:-$(date +%s)}"   # watchdog.sh counts from WATCHDOG_T0 or its own start
  # A watchdog that would fire at its first check would tear down while this script creates things.
  if [[ -n "$COST_RATE_H" ]]; then
    local at
    read -r at _ <<<"$(watchdog_deadline "$WATCHDOG_T0_EPOCH")"
    (( at - ${POLL_SECS:-60} > $(date +%s) )) || die "the watchdog would delete everything at its first check (WATCHDOG_T0=$WATCHDOG_T0_EPOCH is too far back for MAX_WALL_SECS=$WALL_SECS / MAX_USD=$MAX_USD). Nothing was created. Unset WATCHDOG_T0 or raise the caps."
    jq -e -n --argjson m "$MAX_USD" --argjson f "${FALLBACK_RATE:-0.35}" '$m > $f' >/dev/null \
      || die "MAX_USD=$MAX_USD must be above the watchdog's FALLBACK_RATE (${FALLBACK_RATE:-0.35}/h, used until the server exists), or it deletes everything at its first check. Nothing was created."
  fi
  MAX_USD="$MAX_USD" MAX_WALL_SECS="$WALL_SECS" SSH_KEY_FILE="$key" NAME="$NAME" STATE_DIR="$STATE_DIR" \
    nohup "$WATCHDOG_CMD" >>"$STATE_DIR/watchdog.out" 2>&1 </dev/null &
  local wpid=$!
  sleep "${WATCHDOG_START_WAIT:-2}"
  if ! kill -0 "$wpid" 2>/dev/null; then
    tail -n 5 "$STATE_DIR/watchdog.out" >&2 || true
    die "watchdog did not start (see $STATE_DIR/watchdog.out). Nothing was created. Fix it, or set WATCHDOG=0 to go without."
  fi
  log "watchdog started (pid $wpid). It deletes everything when the bill would pass MAX_USD=$MAX_USD, after $(( WALL_SECS / 3600 )) h even if the node is healthy, or after 2 h without progress${key:+ (progress check over SSH with $key)}."
  log "  log: $STATE_DIR/watchdog.log  stop without deleting: touch $STATE_DIR/watchdog.disarm"
}

main() {
  preflight
  check_server_type
  cost_guard
  if [[ "$ESTIMATE_ONLY" == "1" ]]; then log "ESTIMATE_ONLY=1: nothing created."; return 0; fi
  guard_existing
  check_volume_quota
  start_watchdog
  ensure_firewall
  ensure_volume
  ensure_server
  print_ip
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
