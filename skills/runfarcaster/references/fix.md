# Fix a problem

Problems seen while building and running the guide. Match the exact text the user sees. Full page: https://sudharshanx.github.io/runfarcaster/fix/

## Step 1

| You see | Why | Fix |
|---|---|---|
| `volumes size limit exceeded (resource_limit_exceeded)` | New Hetzner accounts can rent at most 1024 GB of volumes in total. | Use `VOLUME_GB=1000`. Limits: https://console.hetzner.cloud/limits |
| `server type cax31: not available in fsn1 right now.` | Hetzner can't rent you that type there right now. The error lists what you can rent. | Run step 1 again with a `SERVER_TYPE` from the list, or another `LOCATION` (fsn1, nbg1, hel1, ash, hil, sin). The guide has been tested on cax31 only. |
| `unknown LOCATION=…` | A typo in `LOCATION`. | Use a name from the list it prints. |
| SSH hangs, then times out. It worked before. | The firewall lets SSH in only from `SSH_SOURCE_CIDRS`, and the user's address changed. | Point the SSH rule at the new address with the command below this table. Expected: `Firewall Rules for Firewall <id> updated`. The server keeps running. |
| `ssh: Could not resolve hostname : Name or service not known` | `$IP` is empty in a new terminal. | `IP=$(hcloud server ip "$NAME")` |
| The server is gone. `.provision-state/watchdog.log` says `wall-clock cap 86400s reached`. | Only without `WATCHDOG=0`: the watchdog deletes everything 24 h after step 1. | Before that: `touch .provision-state/watchdog.disarm` |
| The server is gone. `.provision-state/watchdog.log` says `TEARDOWN triggered: budget: projected <amount> >= MAX_USD <limit> after <seconds>s at <rate>/h`. | Only without `WATCHDOG=0`: the bill, every started hour counted in full plus 15 min for teardown, would reach `MAX_USD`, so the watchdog ran `teardown.sh`. The volume, and the node's database on it, are gone. The watchdog runs on the user's computer: it checks nothing while the computer sleeps, counts the slept hours on wake, and can delete within 60 s of waking. | Run the 3 steps again. Next time set `MAX_USD` and `EXPECTED_HOURS` for the whole run (raise both together), and `WATCHDOG_MAX_WALL_SECS` past 24 h (`172800` = 48 h). Or use `WATCHDOG=0`, or stop a running watchdog without deleting: `touch .provision-state/watchdog.disarm` |
| `watchdog did not start (see …/watchdog.out). Nothing was created.` and `HCLOUD_TOKEN not set. NOT RUNNING: no spending cap is active.` | The terminal has no Hetzner token. | The user sets it without echo: `read -rsp 'Hetzner token: ' HCLOUD_TOKEN && export HCLOUD_TOKEN && echo`, then runs step 1 again. |
| `WATCHDOG_T0 must be a Unix time in seconds (date +%s), got '<value>'` or `the watchdog would delete everything at its first check (WATCHDOG_T0=<epoch> is too far back for MAX_WALL_SECS=86400 / MAX_USD=8). Nothing was created. Unset WATCHDOG_T0 or raise the caps.` | Only without `WATCHDOG=0`: `WATCHDOG_T0` is not a whole number of seconds, or it is so far back that the 24 h cap or `MAX_USD` is already reached, so the watchdog would delete everything while step 1 is still creating it. | `unset WATCHDOG_T0`, then run step 1 again. It is only for restarting a watchdog partway through a run; set it to the `date +%s` value from when step 1 ran. |
| `MAX_USD=<amount> must be above the watchdog's FALLBACK_RATE (0.35/h, used until the server exists), or it deletes everything at its first check. Nothing was created.` | Only without `WATCHDOG=0`: until the server exists the watchdog assumes `FALLBACK_RATE` (0.35 an hour by default) and counts the first hour in full, so it would delete everything at its first check. | Raise `MAX_USD` together with `EXPECTED_HOURS`. The defaults, `MAX_USD=8 EXPECTED_HOURS=24`, pass for cax31 with the 1000 GB volume. |

SSH hangs, then times out: point the SSH rule at the new address, in the repo folder with `NAME` set:

```bash
MY_IP=$(curl -4 -s https://ifconfig.me) && echo "$MY_IP"
hcloud firewall describe "$NAME-fw" -o json \
  | jq --arg ip "$MY_IP/32" '[.rules[] | if .protocol == "tcp" and .port == "22" then .source_ips = [$ip] else . end]' \
  | hcloud firewall replace-rules --rules-file - "$NAME-fw"
```

## Step 2

| You see | Why | Fix |
|---|---|---|
| The data disk fills hours into step 2. `/root/snapchain-DISK-FULL` exists. | The official restore keeps every chunk, an unpacked copy and the database until the end. `disk-guard.sh` stopped the node at 90%. | Check the helpers: `ssh root@$IP systemctl status snapchain-space-saver snapchain-disk-guard.timer` |
| `HTTP API not answering yet (snapshot download in progress?).` | The node serves no API while it loads the snapshot (8 h 34 m on our cax31 run). | Wait. Used space should grow: `ssh root@$IP df -h /root/snapchain` |
| `not in sync after 43200s. Re-run './node.sh wait' later; it is safe to re-run.` | `node.sh` waits a set time (now 24 h, so the message says `86400s`). | `ssh root@$IP 'bash -s wait' < node.sh` |
| The terminal running step 2 stops, or SSH disconnects. | The node runs on the server, not on the user's computer. | `IP=$(hcloud server ip "$NAME")` then `ssh root@$IP 'bash -s wait' < node.sh` |
| `InsufficientPeers ("read-node-peers")` warnings (540 in 30 min on our run), `HandshakeTimedOut` every 30 s. | No connected peer listens on that topic. Two bootstrap peers do not answer. | Nothing, while `blockDelay` stays in single digits. Check with the command below this table. |

Check `blockDelay`:

```bash
ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'
```

## Step 3

| You see | Why | Fix |
|---|---|---|
| `[deploy-client] ERROR: Node.js 22.12+ (22.x), 24.x or 26+ is required (found: v20.19.2).` | The app's build tools need Node.js 22.12 or later. | Install a current Node.js, then `node --version`. |
| `Error: Port 5317 is already in use` | The local app always uses port 5317 and stops if it is busy. | `lsof -i :5317`, stop that program, start the app again. |
| `bash: line 1: docker: command not found` (or another `docker compose` error) after `[deploy-client] uploading to root@<ip>:/opt/snapchain-client` | Step 3 ran before step 2 installed Docker on the server. | Wait until step 2 prints `[node.sh] Downloading official bootstrap:` (after `Installing Docker Engine …`), or until `ssh root@$IP docker compose version` prints a version. Then run step 3 again; it is safe to repeat. |
| `curl http://<server-ip>:3381/v1/info` hangs. | `provision.sh` keeps ports 3381 and 3383 closed to the internet. | `curl -s https://<name>/v1/info`, or a tunnel: `ssh -N -L 3381:127.0.0.1:3381 root@$IP` |

## Adding an app key

| You see | Why | Fix |
|---|---|---|
| `This recovery phrase doesn't own a Farcaster account that your node knows.` (error: `no FID is registered to custody address 0x…`) | The app derives one address, the first account at `m/44'/60'/0'/0/0`, and the node knows no FID for it: a wrong word, an FID owned by another account from the phrase or moved to another address, or a node that has not synced. | The user checks the words. Check sync: every shard's `blockDelay` in single digits. If the FID belongs to another account, the app cannot use it today; there is nothing else to try in the app. Never ask for the phrase. |

## Reading from the node

| You see | Fix |
|---|---|
| `provided string was not true or false` | Use `reverse=true`, not `reverse=1`. |
| `Multiple values for one key: "requesterFids"` | Use brackets: `requesterFids[]=1&requesterFids[]=2`. |
| `"mempoolSize": 4294967295` | Nothing. A read node has no mempool; the number is a placeholder. |

## Anything else

Ask the user for the exact command and its output, with tokens, IPs and hostnames removed. Give the most likely cause from the scripts and this file, and one next command. Stay with what the output shows.
