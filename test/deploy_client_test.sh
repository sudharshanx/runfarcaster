#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2016,SC2034  # assertions are eval'd strings that read these variables
# deploy-client.sh with stand-in ssh, scp, npm, node and curl (no network, no server), plus
# provision.sh in DRY_RUN and e2e/run.sh stopping on a failed build. Runs them again under
# bash 3.2 (macOS /bin/bash) if one is found: BASH32=/path/to/bash-3.2, or bash32 on PATH.
# Without one those checks are skipped, not failed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0; skip=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }

ok "shellcheck deploy-client.sh" 'shellcheck -x "$ROOT/deploy-client.sh"'

mkdir -p "$T/bin"
for c in ssh scp npm; do  # records each argument as N[value], so empty or merged words show
  cat >"$T/bin/$c" <<S
#!/bin/sh
printf '%s ' "$c" >>"\$CALLS"
S
  cat >>"$T/bin/$c" <<'S'
n=0; for a in "$@"; do n=$((n+1)); printf '%s[%s] ' "$n" "$a"; done >>"$CALLS"; printf '\n' >>"$CALLS"
S
done
printf '#!/bin/sh\necho 200\n' >"$T/bin/curl"
printf '#!/bin/sh\n[ "$1" = --version ] && echo v24.0.0\nexit 0\n' >"$T/bin/node"
chmod +x "$T/bin/"*

# dc SHELL [VAR=value ...]: runs deploy-client.sh with SHELL; calls go to $T/calls.
dc() {
  local sh="$1"; shift
  rm -f "$T/calls"
  env "$@" PATH="$T/bin:$PATH" CALLS="$T/calls" "$sh" "$ROOT/deploy-client.sh" 203.0.113.10 >"$T/out" 2>&1
}
first_ssh() { grep -m1 '^ssh ' "$T/calls"; }

check_dc() {  # check_dc LABEL SHELL
  local l="$1" sh="$2" rc
  rc=0; dc "$sh" -u SSH_OPTS || rc=$?
  ok "$l: SSH_OPTS unset: runs to the end" '[ "$rc" = 0 ] && grep -q "^\[deploy-client\] OK:" "$T/out"'
  ok "$l: SSH_OPTS unset: ssh gets only target and command" '[ "$(first_ssh)" = "ssh 1[root@203.0.113.10] 2[mkdir -p '"'"'/opt/snapchain-client/dist'"'"'] " ]'
  rc=0; dc "$sh" SSH_OPTS= || rc=$?
  ok "$l: SSH_OPTS empty: no 'unbound variable', runs to the end" '[ "$rc" = 0 ] && ! grep -q "unbound variable" "$T/out" && grep -q "^\[deploy-client\] OK:" "$T/out"'
  ok "$l: SSH_OPTS empty: scp gets no empty argument" '! grep "^scp " "$T/calls" | grep -qF "[]"'
  rc=0; dc "$sh" SSH_OPTS="-o BatchMode=yes  -i $T/k*" || rc=$?
  ok "$l: SSH_OPTS with options: each is one word, no glob expansion" '[ "$rc" = 0 ] && first_ssh | grep -qF "ssh 1[-o] 2[BatchMode=yes] 3[-i] 4[$T/k*] 5[root@203.0.113.10]"'
  ok "$l: SSH_OPTS with options: scp gets them too" 'grep "^scp " "$T/calls" | head -1 | grep -qF "scp 1[-o] 2[BatchMode=yes] 3[-i] 4[$T/k*] 5[-q]"'
}

check_dc "bash $(bash -c 'echo "${BASH_VERSION%%(*}"')" bash

# provision.sh DRY_RUN end to end with the optional settings empty (no token, no hcloud needed).
pv() {  # pv SHELL
  env -u HCLOUD_TOKEN PATH="$PATH" DRY_RUN=1 SSH_KEY=k SSH_OPTS= NODE_API_CIDRS= SERVER_TYPE= WATCHDOG=1 \
    STATE_DIR="$T/state" "$1" "$ROOT/provision.sh" >"$T/pv.out" 2>"$T/pv.err"
}
check_pv() {
  local l="$1" sh="$2" rc=0
  pv "$sh" || rc=$?
  ok "$l: provision.sh DRY_RUN with empty SSH_OPTS, NODE_API_CIDRS, SERVER_TYPE: prints the IP" '[ "$rc" = 0 ] && [ "$(cat "$T/pv.out")" = 203.0.113.10 ] && ! grep -q "unbound variable" "$T/pv.err"'
}
check_pv "bash $(bash -c 'echo "${BASH_VERSION%%(*}"')" bash

# e2e/run.sh must stop when the client build fails (bash 3.2 ignores a failing ( ... ) under set -e).
mkdir -p "$T/e2ebin"
printf '#!/bin/sh\nexit 3\n' >"$T/e2ebin/npm"
printf '#!/bin/sh\ntouch "%s/e2e-went-on"\nexit 0\n' "$T" >"$T/e2ebin/python3"
chmod +x "$T/e2ebin/"*
check_e2e() {
  local l="$1" sh="$2" rc=0
  rm -f "$T/e2e-went-on"
  env PATH="$T/e2ebin:$PATH" CADDY=false "$sh" "$ROOT/e2e/run.sh" >"$T/e2e.out" 2>&1 || rc=$?
  ok "$l: e2e/run.sh stops when the client build fails" '[ "$rc" = 3 ] && [ ! -e "$T/e2e-went-on" ]'
}
check_e2e "bash $(bash -c 'echo "${BASH_VERSION%%(*}"')" bash

B32="${BASH32:-$(command -v bash32 || true)}"
if [[ -n "$B32" && -x "$B32" ]] && [[ "$("$B32" -c 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"')" == 3.2 ]]; then
  # deploy-client.sh is started as "$B32 deploy-client.sh", so it really runs in bash 3.2.
  check_dc "bash 3.2" "$B32"
  check_pv "bash 3.2" "$B32"
  check_e2e "bash 3.2" "$B32"
  for f in provision.sh teardown.sh watchdog.sh deploy-client.sh e2e/run.sh; do
    ok "bash 3.2 parses $f" '"$B32" -n "$ROOT/$f"'
  done
else
  echo "skip - bash 3.2 checks (set BASH32=/path/to/bash-3.2 to run them)"; skip=$((skip+1))
fi

echo "deploy_client_test: $pass passed, $fail failed, $skip skipped"
(( fail == 0 ))
