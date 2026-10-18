// SPDX-License-Identifier: MIT
// Copy-paste prompts for coding assistants. Command names and env vars must match the repo scripts.
import { REPO } from "./config.mjs";
export { REPO };

const SAFETY = `Rules for you:
- Never ask for my recovery phrase (also called a seed phrase) or for any private key, and refuse one if I paste it. Tell me to stop, and to treat that account as exposed.
- Never print, log or echo HCLOUD_TOKEN or any other token. Read it from the environment only.
- Ask me before you run teardown.sh, delete anything, or change MAX_USD.
- Show me real output only. If a command fails, show the exact error and stop.`;

const CONTEXT = `Context: I am following the RunFarcaster guide (3 commands: a Hetzner server running a Snapchain read node, and a web app that reads and posts through it).
Repo: ${REPO} (MIT). I cloned it to my computer (git clone ${REPO}, then cd runfarcaster) and run every command from that folder. Scripts: provision.sh (step 1), node.sh (step 2), deploy-client.sh (step 3), teardown.sh, and watchdog.sh (optional).
In any new terminal, get the server IP again with: IP=$(hcloud server ip snapchain-read-node)`;

export const prompts = {
  provision: `${CONTEXT}

Task: step 1, rent the server on Hetzner Cloud.
1. Check: hcloud version, jq --version, ssh -V, curl --version, and that HCLOUD_TOKEN is set without printing it: [ -n "$HCLOUD_TOKEN" ] && echo set. Run hcloud ssh-key list and ask me which key name to use.
2. Find my public IP: MY_IP=$(curl -4 -s https://ifconfig.me) and show it with echo "$MY_IP". If it is empty, stop.
3. Show the price, creating nothing:
   ESTIMATE_ONLY=1 SERVER_TYPE="" VOLUME_GB=1000 ./provision.sh
   Tell me which server type it picked and the price. If it says "none of [...] is usable", show me the types it lists and ask me which SERVER_TYPE (and LOCATION, if I want another place) to use. The guide has been tested on cax31 only; cpx42, the likely pick, has not been tested.
4. When I say yes, run (add LOCATION=<location> if I picked one):
   IP=$(SSH_KEY=<key-name> SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
Expected: "[provision] cost guard OK", then "[provision] WATCHDOG=0: no watchdog started", then a "[provision] done. Next" line on stderr, and the IPv4 address on stdout. It takes under a minute.
Known errors: "volumes size limit exceeded (resource_limit_exceeded)" means the account's volume limit (1024 GB for new accounts); keep VOLUME_GB=1000. "not available in <location> right now" or "none of [...] is usable" means Hetzner has sold out of those types there; the error lists what is available. "unknown LOCATION" lists the valid names.
Tell me: the server keeps running, and Hetzner bills it by the hour, until I delete it with teardown.sh.
If I say I only want a trial run: run step 1 without WATCHDOG=0 and with MAX_USD=5 EXPECTED_HOURS=16. Then provision.sh starts watchdog.sh, which deletes everything after 24 h, when the bill would pass MAX_USD, or after 2 h without progress. To keep the node after all: touch .provision-state/watchdog.disarm. Its log: .provision-state/watchdog.log.

${SAFETY}`,

  node: `${CONTEXT}

Task: step 2, start the Snapchain read node on the server (1000 GB volume).
1. IP=$(hcloud server ip snapchain-read-node)
2. ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
   If SSH says "Connection refused" right after step 1, the server is still booting: wait a minute and run it again.
node.sh installs Docker, installs two disk helpers because the disk is under 1500 GB, runs the official bootstrap and waits up to 24 h for sync.
Expected: "[node.sh] Data disk ... arming disk-guard and snapshot-space-saver.", then "[node.sh] ... SYNCING shard 0: height=... blockDelay=..." lines, then "[node.sh] Node is in sync." and a health check with "sync: SYNCED". The HTTP API does not answer while the snapshot loads; that is normal. On cax31, expect about 14 h from renting the server to synced.
If SSH drops, the node keeps going. Continue waiting with: ssh root@$IP 'bash -s wait' < node.sh
Check: ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'   (synced = every blockDelay in single digits). Port 3381 is closed to the internet, so check over SSH.
Repeated "InsufficientPeers" warnings that mention "read-node-peers" are fine while blockDelay stays in single digits. If blockDelay keeps growing, tell me: the validators may have stopped making blocks.

${SAFETY}`,

  client: `${CONTEXT}

Task: step 3, put the web app in front of the node.
Needs Node.js 22.12+ (22.x), 24.x or 26+ on my computer.
Run: ./deploy-client.sh "$IP"   (a DNS name of mine that points at $IP can go as the 2nd argument; without it the script uses <ip-with-dashes>.sslip.io)
Expected last line: "[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)". Under a minute with a warm npm cache.
Then I open the address. The status at the top should say "Connected to your node".
If I started the watchdog in step 1, remind me that it deletes the node 24 h after step 1. To keep it: touch .provision-state/watchdog.disarm.
If it fails: ports 80 and 443 must be open (provision.sh opens them). Look at: ssh root@$IP 'cd /opt/snapchain-client && docker compose logs caddy'. For a specific SSH key: SSH_OPTS="-i <keyfile>" ./deploy-client.sh "$IP".

${SAFETY}`,

  teardown: `${CONTEXT}

Task: delete everything provision.sh created. Ask me before running it.
Run: CONFIRM=snapchain-read-node ./teardown.sh
Expected: it deletes the server snapchain-read-node, the volume snapchain-read-node-data and the firewall snapchain-read-node-fw, lists servers, volumes, firewalls and primary IPs, and ends with "[teardown] verified: server, volume(s) and firewall are gone." Running it twice is safe.
Then run hcloud server list, hcloud volume list, hcloud firewall list and hcloud primary-ip list, and check that nothing named snapchain-read-node is left. teardown.sh keeps the uploaded SSH key.

${SAFETY}`,

  concept: `${CONTEXT}

Task: answer a question about the guide. Use only these sources, and say which one each claim comes from:
- https://snapchain.farcaster.xyz/node-types (read nodes and validators; read nodes pass messages on and keep no mempool)
- https://snapchain.farcaster.xyz/guides/writing-messages (gasless KEY_ADD, live on mainnet since engine version V16 on 2026-05-07)
- https://snapchain.farcaster.xyz/reference/httpapi/httpapi (HTTP API)
- The repo files SOURCES.md and client/src/*.ts
Question: <my question>

${SAFETY}`,

  master: `${CONTEXT}

Goal: take me from an empty Hetzner Cloud project to a synced Snapchain read node with the web app in front of it, then help me delete it all when I say so. Do one step at a time and wait for my OK before the next.

Before step 1. Check the tools: hcloud version, jq --version, ssh -V, curl --version, node --version (22.12+ on 22.x, 24.x or 26+), npm --version. Check that HCLOUD_TOKEN is set without printing it. Ask me for my SSH key name (hcloud ssh-key list). Get my public IP with MY_IP=$(curl -4 -s https://ifconfig.me) and check it with echo "$MY_IP".
Keeping it: step 1 uses WATCHDOG=0, so the server runs until I delete it. Ask me before step 1 whether I only want a trial run. If so, leave out WATCHDOG=0 and add MAX_USD=5 EXPECTED_HOURS=16: provision.sh then starts watchdog.sh, which deletes everything after 24 h, when the bill would pass MAX_USD, or after 2 h without progress (touch .provision-state/watchdog.disarm stops it).
Step 1. ESTIMATE_ONLY=1 SERVER_TYPE="" VOLUME_GB=1000 ./provision.sh   -> show me the type it picked and the price (about 0.255 USD an hour for cpx42 with the 1000 GB volume; cpx42 is untested).
        If it says the type is not available, show me the types it lists and ask me which SERVER_TYPE and LOCATION to use.
        Then: IP=$(SSH_KEY=<key> SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
Step 2. ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
        On cax31 this takes about 14 h. To report progress: ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'
Step 3. ./deploy-client.sh "$IP"  -> give me the https address it prints.
Step 4, only when I say so. CONFIRM=snapchain-read-node ./teardown.sh, then check hcloud server list, volume list and firewall list.
If $IP is empty in a new terminal: IP=$(hcloud server ip snapchain-read-node)

SNAPCHAIN_AGREE_NO_REWARDS=yes says I accept that a read node earns no rewards. Show me that before step 2 so I agree knowingly.
To post, the app needs a gasless app key signed by my custody wallet. I will do that myself, in the app running on localhost on my own computer. Do not help me paste a recovery phrase anywhere.

${SAFETY}`,

  debug: `${CONTEXT}

I am on step <1 rent a server | 2 start the node | 3 open the app | teardown>.
The exact command I ran:
<paste command>

What it printed (tokens, IPs and hostnames removed):
<paste output>

What the guide said I should see: <expected output>

Tell me the most likely cause, based on the repo scripts and the guide's Fix a problem page, and give me one next command to run. Stay with what the output shows.

${SAFETY}`,
} as const;

export type PromptKey = keyof typeof prompts;
