// SPDX-License-Identifier: MIT
// Copy-paste prompts for coding assistants. Command names and env vars must match the repo scripts.
import { REPO } from "./config.mjs";
export { REPO };

const SAFETY = `Rules for you:
- Never ask for my recovery phrase (also called a seed phrase) or for any private key, and refuse one if I paste it. Tell me to stop, and to treat that account as exposed.
- Never print, log or echo HCLOUD_TOKEN or any other token. Read it from the environment only.
- Ask me before you run teardown.sh, delete anything, or raise MAX_USD.
- Show me real output only. If a command fails, show the exact error and stop.`;

const CONTEXT = `Context: I am following the guide "Run a Farcaster Snapchain read node and client in 3 steps".
Repo: ${REPO} (MIT). I cloned it to my computer and run every command from its folder. Scripts: provision.sh (step 1), node.sh (step 2), deploy-client.sh (step 3), teardown.sh, watchdog.sh.
In any new terminal, get the server IP again with: IP=$(hcloud server ip snapchain-read-node)`;

export const prompts = {
  provision: `${CONTEXT}

Task: step 1, rent the server on Hetzner Cloud.
1. Check: hcloud version, jq --version, and that HCLOUD_TOKEN is set without printing it: [ -n "$HCLOUD_TOKEN" ] && echo set. Run hcloud ssh-key list and ask me which key name to use.
2. Find my public IP: MY_IP=$(curl -4 -s https://ifconfig.me)
3. Show the price, creating nothing:
   ESTIMATE_ONLY=1 SERVER_TYPE=cax31 VOLUME_GB=1000 EXPECTED_HOURS=16 ./provision.sh
4. When I say yes, run:
   IP=$(SSH_KEY=<key-name> SERVER_TYPE=cax31 VOLUME_GB=1000 MAX_USD=5 EXPECTED_HOURS=16 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
Expected: "[provision] cost guard OK", then a "[provision] done. Next" line on stderr, and the IPv4 address on stdout. It took 35 s for us.
Known errors: "volumes size limit exceeded (resource_limit_exceeded)" means the account's volume limit (1024 GB for new accounts); keep VOLUME_GB=1000. If cx43 is refused, it is sold out; use SERVER_TYPE=cax31.

${SAFETY}`,

  node: `${CONTEXT}

Task: step 2, start the Snapchain read node on the server (1000 GB volume).
1. IP=$(hcloud server ip snapchain-read-node)
2. ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
   If SSH says "Connection refused" right after step 1, the server is still booting: wait a minute and run it again.
node.sh installs Docker, installs two disk helpers because the disk is under 1500 GB, runs the official bootstrap and waits up to 24 h for sync.
Expected: "[node.sh] Data disk ... arming disk-guard and snapshot-space-saver.", then "[node.sh] ... SYNCING shard 0: height=... blockDelay=..." lines, then "[node.sh] Node is in sync." and a health check with "sync: SYNCED". The HTTP API does not answer while the snapshot loads; that is normal. Our sync took about 14 h from renting the server.
If SSH drops, the node keeps going. Continue waiting with: ssh root@$IP 'bash -s wait' < node.sh
Check: ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'   (synced = every blockDelay in single digits). Port 3381 is closed to the internet, so check over SSH.
Ignore repeated "InsufficientPeers" warnings that mention "read-node-peers".

${SAFETY}`,

  client: `${CONTEXT}

Task: step 3, put the web app in front of the node.
Needs Node.js 22.12 or later on my computer.
Run: ./deploy-client.sh "$IP"   (a DNS name of mine that points at $IP can go as the 2nd argument; without it the script uses <ip-with-dashes>.sslip.io)
Expected last line: "[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)". About 35 s for us with a warm npm cache.
Then I open the address. The status line should start with "Connected. version".
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
- https://snapchain.farcaster.xyz/node-types (read nodes and validators; read nodes pass messages on and keep no mempool; PR #1034)
- https://snapchain.farcaster.xyz/guides/writing-messages (gasless KEY_ADD; PR #989)
- https://snapchain.farcaster.xyz/reference/httpapi/httpapi (HTTP API)
- The repo files SOURCES.md and client/src/*.ts
Question: <my question>

${SAFETY}`,

  master: `${CONTEXT}

Goal: take me from an empty Hetzner Cloud project to a synced Snapchain read node with the web app in front of it, then help me delete it all when I say so. Do one step at a time and wait for my OK before the next.

Before step 1. Check the tools: hcloud, jq, ssh, curl, node (22.12 or later), npm. Check that HCLOUD_TOKEN is set without printing it. Ask me for my SSH key name (hcloud ssh-key list). Get my public IP with MY_IP=$(curl -4 -s https://ifconfig.me).
Optional spending cap, in its own terminal: SSH_KEY_FILE=~/.ssh/id_ed25519 MAX_USD=5 nohup ./watchdog.sh >/dev/null 2>&1 &
Step 1. ESTIMATE_ONLY=1 SERVER_TYPE=cax31 VOLUME_GB=1000 EXPECTED_HOURS=16 ./provision.sh   -> show me the price (about 0.164 USD an hour for us).
        Then: IP=$(SSH_KEY=<key> SERVER_TYPE=cax31 VOLUME_GB=1000 MAX_USD=5 EXPECTED_HOURS=16 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
Step 2. ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
        This took about 14 h for us. To report progress: ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'
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

Tell me the most likely cause, based on the repo scripts and the guide's Troubleshooting page, and give me one next command to run. Stay with what the output shows.

${SAFETY}`,
} as const;

export type PromptKey = keyof typeof prompts;
