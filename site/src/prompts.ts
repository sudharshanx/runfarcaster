// SPDX-License-Identifier: MIT
// Copy-paste prompts for coding assistants. Command names and env vars must match the repo scripts.
import { REPO } from "./config.mjs";
export { REPO };
export const SITE = "https://sudharshanx.github.io/runfarcaster/";

const SAFETY = `Rules for you:
- Never ask for my recovery phrase (also called a seed phrase) or for any private key, and refuse one if I paste it. Tell me to stop, and to treat that account as exposed.
- Never print, log or echo HCLOUD_TOKEN or any other token. Read it from the environment only.
- Ask me before you run teardown.sh, delete anything, or change MAX_USD.
- Show me real output only. If a command fails, show the exact error and stop.`;

const CONTEXT = `Context: I am following the RunFarcaster guide (3 commands: a Hetzner server running a Snapchain read node, and a web app that reads and posts through it).
Repo: ${REPO} (MIT). I cloned it to my computer (git clone ${REPO}, then cd runfarcaster) and run every command from that folder. Scripts: provision.sh (step 1), node.sh (step 2), deploy-client.sh (step 3), teardown.sh, and watchdog.sh (optional).
Server name: export NAME=snapchain-read-node (or another name I pick), in every terminal; all steps and teardown.sh use it. In any new terminal, get the server IP again with: IP=$(hcloud server ip "$NAME")`;

export const prompts = {
  provision: `${CONTEXT}

Task: step 1, rent the server on Hetzner Cloud.
1. Check: hcloud version, jq --version, ssh -V, curl --version, and that HCLOUD_TOKEN is set without printing it: [ -n "$HCLOUD_TOKEN" ] && echo set. Run hcloud ssh-key list and ask me which key name to use.
2. Find my public IP: MY_IP=$(curl -4 -s https://ifconfig.me) and show it with echo "$MY_IP". If it is empty, stop.
3. Show the price, creating nothing:
   ESTIMATE_ONLY=1 SERVER_TYPE="" VOLUME_GB=1000 ./provision.sh
   Tell me which server type it picked and the price. If it says "none of [...] is usable", show me the types it lists and ask me which SERVER_TYPE (and LOCATION, if I want another place) to use. The guide has been tested on cax31 only. If it picked another type, tell me so, because other types have not been tested.
4. Use an empty Hetzner project. Set the name: export NAME=snapchain-read-node.
5. When I say yes, run (add LOCATION=<location> if I picked one):
   IP=$(SSH_KEY=<key-name> SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
Expected: "[provision] cost guard OK", then "[provision] WATCHDOG=0: no watchdog started", then a "[provision] done. Next" line on stderr, and the IPv4 address on stdout. It takes under a minute.
Known errors: "this project already has: ..." means a server, volume or firewall with that name exists and may be someone else's; nothing was changed. Ask me: another NAME for a new node, or REUSE=1 only if it is my own earlier run. "would pass the 1024 GB account quota" means the volume quota is full. "volumes size limit exceeded (resource_limit_exceeded)" means the account's volume limit (1024 GB for new accounts); keep VOLUME_GB=1000. "not available in <location> right now" or "none of [...] is usable" means those types aren't available to rent there; the error lists what is, cheapest first. "unknown LOCATION" lists the valid names.
Tell me: the server keeps running, and Hetzner bills it by the hour, until I delete it with teardown.sh.
If I say I only want a trial run: run step 1 without WATCHDOG=0 and with MAX_USD=8 EXPECTED_HOURS=24. Then provision.sh starts watchdog.sh, which deletes everything after 24 h, when the bill would pass MAX_USD, or after 2 h without progress. To keep the node after all: touch .provision-state/watchdog.disarm. Its log: .provision-state/watchdog.log.

${SAFETY}`,

  node: `${CONTEXT}

Task: step 2, start the Snapchain read node on the server (1000 GB volume).
1. Use $IP from step 1. Only in a new terminal: IP=$(hcloud server ip "$NAME")
2. ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
   If SSH says "Connection refused" right after step 1, the server is still booting: wait a minute and run it again.
node.sh installs Docker, installs two disk helpers because the disk is under 1500 GB, runs the official bootstrap and waits up to 24 h for sync.
Expected: "[node.sh] Data disk ... arming disk-guard and snapshot-space-saver.", then "[node.sh] ... SYNCING shard 0: height=... blockDelay=..." lines, then "[node.sh] Node is in sync." and a health check with "sync: SYNCED". The HTTP API does not answer while the snapshot loads; that is normal. On cax31, our run took 14 h 06 m from renting the server to synced.
If SSH drops, the node keeps going. Continue waiting with: ssh root@$IP 'bash -s wait' < node.sh
Check: ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'   (synced = every blockDelay in single digits). Port 3381 is closed to the internet, so check over SSH.
Repeated "InsufficientPeers" warnings that mention "read-node-peers" are fine while blockDelay stays in single digits. If blockDelay keeps growing, tell me: the validators may have stopped making blocks.

${SAFETY}`,

  client: `${CONTEXT}

Task: step 3, put the web app in front of the node.
Needs Node.js 22.12+ (22.x), 24.x or 26+ on my computer.
Run: ./deploy-client.sh "$IP"   (a DNS name of mine that points at $IP can go as the 2nd argument; without it the script uses <ip-with-dashes>.sslip.io)
Expected last line: "[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)". Under a minute with a warm npm cache. It can run while the node is still loading its snapshot: then it ends with "[deploy-client] OK: app is up at https://<name>. The node isn't answering yet", and the app shows "Node still starting" until the node answers.
Then I open the address. The status at the top should say "Connected to your node".
If I started the watchdog in step 1, remind me that it deletes the node 24 h after step 1. To keep it: touch .provision-state/watchdog.disarm.
If it fails: ports 80 and 443 must be open (provision.sh opens them). Look at: ssh root@$IP 'cd /opt/snapchain-client && docker compose logs caddy'. For a specific SSH key: SSH_OPTS="-i <keyfile>" ./deploy-client.sh "$IP".

${SAFETY}`,

  teardown: `${CONTEXT}

Task: delete everything provision.sh created. Ask me before running it.
Run: CONFIRM="$NAME" ./teardown.sh
Expected: it deletes the server $NAME, the volume $NAME-data and the firewall $NAME-fw, lists servers, volumes, firewalls and primary IPs, and ends with "[teardown] verified: server, volume(s) and firewall are gone." Running it twice is safe.
Then run hcloud server list, hcloud volume list, hcloud firewall list and hcloud primary-ip list, and check that nothing named $NAME is left. If it says "It may be someone else's node; nothing deleted", stop and show me; only I decide on OTHER_SERVER_OK=1. teardown.sh keeps the uploaded SSH key.

${SAFETY}`,

  concept: `${CONTEXT}

Task: answer a question about the guide. Use only these sources, and say which one each claim comes from:
- https://snapchain.farcaster.xyz/node-types (read nodes and validators; read nodes pass messages on and keep no mempool)
- https://snapchain.farcaster.xyz/guides/writing-messages (gasless KEY_ADD, live on mainnet since engine version V16 on 2026-05-07)
- https://snapchain.farcaster.xyz/reference/httpapi/httpapi (HTTP API)
- The repo files SOURCES.md and client/src/*.ts
Question: <my question>

${SAFETY}`,

  guided: `Set up RunFarcaster for me: fetch ${SITE}agent.md and walk me through the steps. Show me each command and what it costs before you run it.`,

  master: `Set up RunFarcaster with me: a Hetzner server that runs my own Snapchain read node, plus a web app on that server that reads and posts through it.
Guide: ${SITE}  Repo: ${REPO} (MIT)

1. Install the RunFarcaster skill, then open its SKILL.md and follow it. It has the 3 steps, the expected output, the fixes and the rules:
   npx skills add sudharshanx/runfarcaster --skill runfarcaster -y
   If you cannot install skills, read ${SITE}llms.txt and the Full run page it links (${SITE}quickstart.md), and follow those.
2. Take me from an empty Hetzner project to a synced node with the app in front of it: step 1 provision.sh, step 2 node.sh, step 3 deploy-client.sh. Run one step at a time, show me the real output, and wait for my OK before the next.
3. After each step, tell me what you got: the server type and hourly price, the server IP, sync progress (blockDelay per shard), then the https address of the app.
4. Run teardown.sh only when I ask for it.
5. For provision.sh and teardown.sh, show me the exact command and what it costs, then let me choose: you run it once I say yes, or I paste it into my own terminal and share the output. Either works. If I ran step 1, get the IP with IP=$(hcloud server ip "$NAME").

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
