// SPDX-License-Identifier: MIT
// Copy-paste prompts for coding assistants. Command names and env vars must match the repo scripts.
export const REPO = (process.env.REPO_URL ?? "https://github.com/OWNER/snapchain-tutorial").replace(/\/+$/, "");

const SAFETY = `Safety rules (follow them strictly):
- Never ask me for, and never accept, a seed phrase / recovery phrase or private key. If I paste one, tell me to stop and rotate it.
- Never print, log or echo HCLOUD_TOKEN or any API token. Read it from the environment only.
- Never run teardown.sh, delete resources or raise MAX_USD without asking me first.
- Do not invent output. If a command fails, show me the exact error and stop.`;

const CONTEXT = `Context: I am following the tutorial "Run your own Farcaster Snapchain read node and client in three commands".
Repo: ${REPO} (MIT). Run commands from the repo root on my machine. Scripts: provision.sh, node.sh, deploy-client.sh, teardown.sh, watchdog.sh, disk-guard.sh, snapshot-space-saver.sh.`;

export const prompts = {
  provision: `${CONTEXT}

Task: step 1, provision the compute on Hetzner Cloud.
1. Check: hcloud version, jq --version, and that HCLOUD_TOKEN is set (test with: [ -n "$HCLOUD_TOKEN" ] && echo set). Run hcloud ssh-key list and ask me which key name to use.
2. Preview the cost, creating nothing:
   ESTIMATE_ONLY=1 SERVER_TYPE=cax31 VOLUME_GB=1000 EXPECTED_HOURS=16 ./provision.sh
3. After I confirm, run:
   IP=$(SSH_KEY=<key-name> SERVER_TYPE=cax31 VOLUME_GB=1000 MAX_USD=5 EXPECTED_HOURS=16 SSH_SOURCE_CIDRS=<my-ip>/32 ./provision.sh)
Expected: "[provision] cost guard OK" then "[provision] done. Next:" on stderr, and the IPv4 on stdout. It took 35 s for us.
Known errors: "volumes size limit exceeded (resource_limit_exceeded)" = account volume quota (new accounts: 1024 GB total); keep VOLUME_GB=1000. A refused cx43 = sold out; use SERVER_TYPE=cax31.

${SAFETY}`,

  node: `${CONTEXT}

Task: step 2, turn the server at $IP into a Snapchain read node (1000 GB volume).
1. scp disk-guard.sh snapshot-space-saver.sh root@$IP:
2. ssh root@$IP ./disk-guard.sh install
3. ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 SYNC_TIMEOUT_SECS=86400 bash -s" < node.sh
4. In a second terminal, once the snapshot download has started:
   ssh root@$IP 'until [ -d /root/snapchain/.rocks.snapshot ]; do sleep 10; done; ./snapshot-space-saver.sh install'
Expected: "[node.sh] ... SYNCING shard 0: height=... blockDelay=..." lines, then "[node.sh] Node is in sync." and a health check with "sync: SYNCED". The HTTP API is down during the snapshot restore (normal). Our run took about 14 h from provisioning.
If SSH drops, resume with: ssh root@$IP 'bash -s wait' < node.sh
Check: curl -s http://$IP:3381/v1/info | jq '.shardInfos[] | {shardId, blockDelay}' (synced = every blockDelay in single digits).
Harmless: repeated "InsufficientPeers" warnings mentioning "read-node-peers".

${SAFETY}`,

  client: `${CONTEXT}

Task: step 3, deploy the web client to the node at $IP.
Run: ./deploy-client.sh "$IP"   (optionally a DNS name as the 2nd argument; default is <ip-with-dashes>.sslip.io)
Expected last line: "[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)". About 35 s for us.
Then open the URL; the status line should start with "Connected. version".
If it fails: ports 80 and 443 must be open (provision.sh opens them); check ssh root@$IP 'cd /opt/snapchain-client && docker compose logs caddy'. If you need a specific SSH key: SSH_OPTS="-i <keyfile>" ./deploy-client.sh "$IP".

${SAFETY}`,

  teardown: `${CONTEXT}

Task: remove everything provision.sh created. Ask me to confirm before running anything destructive.
Run: CONFIRM=snapchain-read-node ./teardown.sh
Expected: it deletes server snapchain-read-node, volume snapchain-read-node-data and firewall snapchain-read-node-fw, prints server/volume/firewall/primary-IP lists and ends with "[teardown] verified: server, volume(s) and firewall are gone."
Then run hcloud server list, hcloud volume list, hcloud firewall list and confirm nothing named snapchain-read-node remains. Note: teardown.sh does not delete the uploaded SSH key.

${SAFETY}`,

  concept: `${CONTEXT}

Task: explain a concept from the tutorial to me. Use only these sources and say which one each claim comes from:
- https://snapchain.farcaster.xyz/node-types (read nodes vs validators; read nodes relay writes, no mempool; PR #1034)
- https://snapchain.farcaster.xyz/guides/writing-messages (gasless KEY_ADD; PR #989)
- https://snapchain.farcaster.xyz/reference/httpapi/httpapi (HTTP API)
- The repo files SOURCES.md and client/src/*.ts
Question: <my question>

${SAFETY}`,

  master: `${CONTEXT}

Goal: get me from an empty Hetzner Cloud project to a synced Snapchain read node with the web client served from it, then help me tear it down when I say so. Work one step at a time and wait for my OK between steps.

Step 0. Check tools: hcloud, jq, ssh, scp, curl, node (>= 20), npm. Confirm HCLOUD_TOKEN is set without printing it. Ask me for my SSH key name (hcloud ssh-key list) and my public IP for SSH_SOURCE_CIDRS.
Step 1. ESTIMATE_ONLY=1 SERVER_TYPE=cax31 VOLUME_GB=1000 EXPECTED_HOURS=16 ./provision.sh   -> show me the estimate (~0.164 USD/h for us).
        Then: IP=$(SSH_KEY=<key> SERVER_TYPE=cax31 VOLUME_GB=1000 MAX_USD=5 EXPECTED_HOURS=16 SSH_SOURCE_CIDRS=<ip>/32 ./provision.sh)
Step 2. scp disk-guard.sh snapshot-space-saver.sh root@$IP: && ssh root@$IP ./disk-guard.sh install
        ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 SYNC_TIMEOUT_SECS=86400 bash -s" < node.sh
        In parallel: ssh root@$IP 'until [ -d /root/snapchain/.rocks.snapshot ]; do sleep 10; done; ./snapshot-space-saver.sh install'
        Sync took ~14 h for us. Report progress from: curl -s http://$IP:3381/v1/info | jq '.shardInfos[] | {shardId, blockDelay}'
Step 3. ./deploy-client.sh "$IP"  -> give me the https URL it prints.
Step 4 (only when I say so). CONFIRM=snapchain-read-node ./teardown.sh, then verify with hcloud server list / volume list / firewall list.

The SNAPCHAIN_AGREE_NO_REWARDS=yes setting records that running a node earns no rewards; show me that line before step 2 so I agree knowingly.
Posting from the client needs a gasless app key signed by my custody wallet. I will do that myself in the browser. Do not help me paste a seed phrase anywhere.

${SAFETY}`,

  debug: `${CONTEXT}

I am on step <1 provision | 2 node | 3 client | teardown>.
The command I ran (exactly):
<paste command>

Its output (tokens, IPs and hostnames removed):
<paste output>

What I expected: <expected output from the tutorial>

Explain the most likely cause using the repo scripts and the tutorial's Troubleshooting page, then give me the single next command to run. Do not guess beyond the evidence.

${SAFETY}`,
} as const;

export type PromptKey = keyof typeof prompts;
