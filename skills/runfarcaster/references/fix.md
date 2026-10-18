# Fix a problem

Problems seen while building and running the guide. Match the exact text the user sees. Full page: https://sudharshanx.github.io/runfarcaster/fix/

## Step 1

| You see | Why | Fix |
|---|---|---|
| `volumes size limit exceeded (resource_limit_exceeded)` | New Hetzner accounts can rent at most 1024 GB of volumes in total. | Use `VOLUME_GB=1000`. Limits: https://console.hetzner.cloud/limits |
| `server type cax31: not available in fsn1 right now.` | Hetzner sold out of that type there. The error lists what you can rent. | Run step 1 again with a `SERVER_TYPE` from the list, or another `LOCATION` (fsn1, nbg1, hel1, ash, hil, sin). The guide has been tested on cax31 only. |
| `unknown LOCATION=…` | A typo in `LOCATION`. | Use a name from the list it prints. |
| SSH hangs, then times out. It worked before. | The firewall lets SSH in only from `SSH_SOURCE_CIDRS`, and the user's address changed. | Run step 1 again with every setting and the new address: `SSH_KEY=my-key SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$(curl -4 -s https://ifconfig.me)/32" ./provision.sh`. It updates the firewall and keeps the server. |
| `ssh: Could not resolve hostname : Name or service not known` | `$IP` is empty in a new terminal. | `IP=$(hcloud server ip "$NAME")` |
| The server is gone. `.provision-state/watchdog.log` says `wall-clock cap 86400s reached`. | Only without `WATCHDOG=0`: the watchdog deletes everything 24 h after step 1. | Before that: `touch .provision-state/watchdog.disarm` |
| `watchdog did not start (see …/watchdog.out). Nothing was created.` and `HCLOUD_TOKEN not set. NOT RUNNING: no spending cap is active.` | The terminal has no Hetzner token. | The user sets it without echo: `read -rsp 'Hetzner token: ' HCLOUD_TOKEN && export HCLOUD_TOKEN && echo`, then runs step 1 again. |

## Step 2

| You see | Why | Fix |
|---|---|---|
| The data disk fills hours into step 2. `/root/snapchain-DISK-FULL` exists. | The official restore keeps every chunk, an unpacked copy and the database until the end. `disk-guard.sh` stopped the node at 90%. | Check the helpers: `ssh root@$IP systemctl status snapchain-space-saver snapchain-disk-guard.timer` |
| `HTTP API not answering yet (snapshot download in progress?).` | The node serves no API while it loads the snapshot (about 8 to 9 hours on cax31). | Wait. Used space should grow: `ssh root@$IP df -h /root/snapchain` |
| `not in sync after 43200s. Re-run './node.sh wait' later; it is safe to re-run.` | `node.sh` waits a set time (now 24 h, so the message says `86400s`). | `ssh root@$IP 'bash -s wait' < node.sh` |
| The terminal running step 2 stops, or SSH disconnects. | The node runs on the server, not on the user's computer. | `IP=$(hcloud server ip "$NAME")` then `ssh root@$IP 'bash -s wait' < node.sh` |
| About 18 `InsufficientPeers ("read-node-peers")` warnings a minute, `HandshakeTimedOut` every 30 s. | No connected peer listens on that topic. Two bootstrap peers do not answer. | Nothing, while `blockDelay` stays in single digits: `ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' \| jq '.shardInfos[] \| {shardId, blockDelay}'` |

## Step 3

| You see | Why | Fix |
|---|---|---|
| `[deploy-client] ERROR: Node.js 22.12+ (22.x), 24.x or 26+ is required (found: v20.19.2).` | The app's build tools need Node.js 22.12 or later. | Install a current Node.js, then `node --version`. |
| `Error: Port 5317 is already in use` | The local app always uses port 5317 and stops if it is busy. | `lsof -i :5317`, stop that program, start the app again. |
| `curl http://<server-ip>:3381/v1/info` hangs. | `provision.sh` keeps ports 3381 and 3383 closed to the internet. | `curl -s https://<name>/v1/info`, or a tunnel: `ssh -N -L 3381:127.0.0.1:3381 root@$IP` |

## Reading from the node

| You see | Fix |
|---|---|
| `provided string was not true or false` | Use `reverse=true`, not `reverse=1`. |
| `Multiple values for one key: "requesterFids"` | Use brackets: `requesterFids[]=1&requesterFids[]=2`. |
| `"mempoolSize": 4294967295` | Nothing. A read node has no mempool; the number is a placeholder. |

## Anything else

Ask the user for the exact command and its output, with tokens, IPs and hostnames removed. Give the most likely cause from the scripts and this file, and one next command. Stay with what the output shows.
