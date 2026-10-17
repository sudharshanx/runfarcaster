#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# teardown.sh - delete everything provision.sh created on Hetzner Cloud: the server, its data
# volume(s) and the firewall, then list servers/volumes/firewalls to confirm they are gone.
#
# !!! DESTRUCTIVE: the node database on the volume is deleted permanently. !!!
#
# Required: HCLOUD_TOKEN (env; never printed). Confirm by typing the server name, or set
#           CONFIRM=<NAME> for non-interactive use.
# Optional: NAME=snapchain-read-node (must match provision.sh), DRY_RUN=1.

set -euo pipefail
set +x  # never trace: keeps HCLOUD_TOKEN out of any xtrace output

NAME="${NAME:-snapchain-read-node}"
FIREWALL_NAME="$NAME-fw"
VOLUME_NAME="$NAME-data"
DRY_RUN="${DRY_RUN:-0}"
RETRIES="${RETRIES:-12}"

log() { printf '[teardown] %s\n' "$*" >&2; }
die() { printf '[teardown] ERROR: %s\n' "$*" >&2; exit 1; }
hc() {
  if [[ "$DRY_RUN" == "1" ]]; then printf '[dry-run] hcloud %s\n' "$*" >&2; return 0; fi
  hcloud "$@"
}
exists() { [[ "$DRY_RUN" == "1" ]] && return 1; hcloud "$1" describe "$2" >/dev/null 2>&1; }

# retry N CMD...: Hetzner actions are async; e.g. a volume can be "in use" for a moment after
# its server is deleted, and a firewall cannot be deleted while still applied.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1)); (( n >= RETRIES )) && return 1
    log "retrying in 5s ($n/$RETRIES): $*"; sleep 5
  done
}

preflight() {
  command -v jq >/dev/null 2>&1 || die "jq is required"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v hcloud >/dev/null 2>&1 || die "hcloud CLI not found"
    [[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN is not set"
  fi
  local answer="${CONFIRM:-}"
  if [[ -z "$answer" ]]; then
    [[ -t 0 ]] || die "not a terminal: set CONFIRM=$NAME to confirm deletion"
    printf 'This permanently deletes server %s, its volumes and firewall %s.\nType the server name to confirm: ' "$NAME" "$FIREWALL_NAME" >&2
    read -r answer
  fi
  [[ "$answer" == "$NAME" ]] || die "confirmation did not match; nothing deleted"
}

# Collect volume IDs: attached to the server, plus the named volume (even if detached).
VOLUME_IDS=()
collect_volumes() {
  [[ "$DRY_RUN" == "1" ]] && { VOLUME_IDS=("$VOLUME_NAME"); return 0; }
  local id
  if exists server "$NAME"; then
    while read -r id; do [[ -n "$id" ]] && VOLUME_IDS+=("$id"); done \
      < <(hcloud server describe "$NAME" -o json | jq -r '.volumes[]?')
  fi
  if exists volume "$VOLUME_NAME"; then
    id="$(hcloud volume describe "$VOLUME_NAME" -o json | jq -r '.id')"
    [[ " ${VOLUME_IDS[*]-} " == *" $id "* ]] || VOLUME_IDS+=("$id")
  fi
  log "volumes to delete: ${VOLUME_IDS[*]:-none}"
}

delete_server() {
  if exists server "$NAME" || [[ "$DRY_RUN" == "1" ]]; then
    hc server delete "$NAME"
  else
    log "server $NAME not found (already deleted?)"
  fi
}

delete_volumes() {
  local v
  for v in "${VOLUME_IDS[@]}"; do
    if [[ "$DRY_RUN" == "1" ]] || exists volume "$v"; then
      retry hc volume delete "$v" || die "could not delete volume $v"
    fi
  done
}

delete_firewall() {
  if [[ "$DRY_RUN" == "1" ]] || exists firewall "$FIREWALL_NAME"; then
    retry hc firewall delete "$FIREWALL_NAME" || die "could not delete firewall $FIREWALL_NAME"
  else
    log "firewall $FIREWALL_NAME not found (already deleted?)"
  fi
}

verify() {
  [[ "$DRY_RUN" == "1" ]] && { log "dry-run: skipping verification"; return 0; }
  local left=0 v
  echo "--- servers";   hcloud server list
  echo "--- volumes";   hcloud volume list
  echo "--- firewalls"; hcloud firewall list
  echo "--- primary IPs (unassigned ones are still billed)"; hcloud primary-ip list
  if exists server "$NAME"; then log "STILL PRESENT: server $NAME"; left=1; fi
  for v in "${VOLUME_IDS[@]}" "$VOLUME_NAME"; do
    if exists volume "$v"; then log "STILL PRESENT: volume $v"; left=1; fi
  done
  if exists firewall "$FIREWALL_NAME"; then log "STILL PRESENT: firewall $FIREWALL_NAME"; left=1; fi
  if (( left )); then die "some resources remain; check the lists above"; fi
  log "verified: server, volume(s) and firewall are gone."
}

main() {
  preflight
  collect_volumes
  delete_server
  delete_volumes
  delete_firewall
  verify
}

main "$@"
