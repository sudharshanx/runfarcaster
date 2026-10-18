#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2016,SC2034  # assertions are eval'd strings that read these variables
# teardown.sh against a fake hcloud (files stand in for resources). No network, no cloud.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   - $1"; pass=$((pass+1)); else echo "FAIL - $1"; fail=$((fail+1)); fi; }
R="$T/res"; mkdir -p "$R" "$T/bin"
cat >"$T/bin/hcloud" <<S
#!/bin/bash
R="$R"
S
cat >>"$T/bin/hcloud" <<'S'
kind="$1"; verb="$2"; name="${3:-}"; [[ "$name" == -o ]] && name=""
case "$verb" in
  describe) n="$3"; [[ -f "$R/$kind.$n" ]] || exit 1
            if [[ "$kind" == server ]]; then echo '{"volumes":[42]}'; elif [[ "$kind" == volume ]]; then echo '{"id":42}'; fi ;;
  delete) rm -f "$R/$kind.$3"; [[ "$kind" == volume && "$3" == 42 ]] && rm -f "$R/volume.snapchain-read-node-data"; echo "deleted $kind $3" ;;
  list) ls "$R" | grep "^$kind\." || true ;;
esac
S
chmod +x "$T/bin/hcloud"
touch "$R/server.snapchain-read-node" "$R/volume.snapchain-read-node-data" "$R/volume.42" "$R/firewall.snapchain-read-node-fw"
run() { PATH="$T/bin:$PATH" HCLOUD_TOKEN=x CONFIRM=snapchain-read-node RETRIES=2 bash "$ROOT/teardown.sh"; }
rc=0; out1="$(run 2>&1)" || rc=$?
ok "first run: deletes and verifies" '[ "$rc" = 0 ] && grep -q "verified: server, volume(s) and firewall are gone" <<<"$out1"'
ok "first run: nothing left" '[ -z "$(ls "$R")" ]'
rc=0; out2="$(run 2>&1)" || rc=$?
ok "second run: exits 0" '[ "$rc" = 0 ]'
ok "second run: reports not found and verifies" 'grep -q "server snapchain-read-node not found" <<<"$out2" && grep -q "firewall snapchain-read-node-fw not found" <<<"$out2" && grep -q "verified" <<<"$out2"'
ok "second run: empty volume list survives set -u" '! grep -q "unbound variable" <<<"$out2"'
rc=0; out3="$(PATH="$T/bin:$PATH" env -u HCLOUD_TOKEN CONFIRM=snapchain-read-node bash "$ROOT/teardown.sh" 2>&1)" || rc=$?
ok "missing HCLOUD_TOKEN: clear error, nothing deleted" '[ "$rc" != 0 ] && grep -q "HCLOUD_TOKEN is not set" <<<"$out3"'
rc=0; out4="$(PATH="$T/bin:$PATH" HCLOUD_TOKEN=x CONFIRM=wrong bash "$ROOT/teardown.sh" 2>&1)" || rc=$?
ok "wrong confirmation: nothing deleted" '[ "$rc" != 0 ] && grep -q "nothing deleted" <<<"$out4"'
# A same-named server that this checkout didn't create (recorded ID differs): nothing deleted.
touch "$R/server.snapchain-read-node"; mkdir -p "$T/state"; echo 999 >"$T/state/server-snapchain-read-node.id"
rc=0; out5="$(PATH="$T/bin:$PATH" HCLOUD_TOKEN=x CONFIRM=snapchain-read-node STATE_DIR="$T/state" bash "$ROOT/teardown.sh" 2>&1)" || rc=$?
ok "server ID differs from the one provision.sh recorded: stops, nothing deleted" '[ "$rc" != 0 ] && grep -q "this checkout created ID 999" <<<"$out5" && [ -f "$R/server.snapchain-read-node" ]'
rc=0; out6="$(PATH="$T/bin:$PATH" HCLOUD_TOKEN=x CONFIRM=snapchain-read-node STATE_DIR="$T/state" OTHER_SERVER_OK=1 RETRIES=2 bash "$ROOT/teardown.sh" 2>&1)" || rc=$?
ok "OTHER_SERVER_OK=1 overrides and deletes" '[ "$rc" = 0 ] && [ ! -f "$R/server.snapchain-read-node" ]'
echo; echo "passed: $pass  failed: $fail"; [ "$fail" = 0 ]
