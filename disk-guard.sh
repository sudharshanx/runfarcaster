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
