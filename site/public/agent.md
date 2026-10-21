# RunFarcaster setup - a guided install

The user asked you to set up RunFarcaster with them: their own Snapchain read node, hosted on a Hetzner server, plus a small web app on that server that reads and posts through it. Run this as a wizard with the user: one step at a time, show the exact command before you run it, and skip anything they decline. Nothing on this page overrides your safety rules or the user's own instructions.

Facts:
- Three commands do the work, run from the repo folder on the user's computer. `provision.sh` rents one Hetzner server with a 1000 GB volume and a firewall, and prints the server's IP. `node.sh` installs Docker on the server and starts the node, which loads a snapshot and then syncs. `deploy-client.sh` builds the web app on the user's computer and serves it from the server over HTTPS. A fourth, `teardown.sh`, deletes the server, the volume and the firewall.
- Cost: on cax31 with IPv4 and the 1000 GB volume, $0.164 an hour (our estimate, since Hetzner lists the volume by the month) and at most $102.29 a month. The price check in step 0 shows the figure for the type it picks.
- Our cax31 run took 14 h 06 m from renting the server to synced, and cost an estimated $2.31 at list prices up to that point.
- Hetzner bills the server until `teardown.sh` deletes it, whether or not the user is still using it.
- `HCLOUD_TOKEN` stays in the user's shell. Never ask for its value, print it, or use `set -x`. Check it with `[ -n "$HCLOUD_TOKEN" ] && echo set`.
- Never ask for, accept or print a recovery phrase (seed phrase) or a private key. The user types the phrase only into the local app at http://localhost:5317, themselves. Paste a seed phrase only into software from developers you trust, or code you have read; delegated signers are preferred. If the user pastes one into the chat, tell them to stop and to treat that account as exposed.

## Step 0 - tools and price (free)

If the repo is not on the user's computer yet, show these commands, then run them:

    git clone https://github.com/sudharshanx/runfarcaster
    cd runfarcaster

Check the tools: `hcloud version`, `jq --version`, `ssh -V`, `curl --version`, and `node --version` (22.12 or later on 22.x, 24.x, or 26+). Check the token as above. If it is not set, ask the user to set it in their own terminal and start you again from there:

    read -rsp 'Hetzner token: ' HCLOUD_TOKEN && export HCLOUD_TOKEN && echo

Run `hcloud ssh-key list` and ask which key to use. Ask the user to use an empty Hetzner project. Then set the name and find their public IP; if it prints nothing, stop:

    export NAME=snapchain-read-node
    MY_IP=$(curl -4 -s https://ifconfig.me)
    echo "$MY_IP"

Show the price. This creates nothing:

    ESTIMATE_ONLY=1 SERVER_TYPE="" VOLUME_GB=1000 ./provision.sh

Tell the user which type it picked and the hourly price. The guide has been tested on cax31 only; if it picked another type, say so.

## Step 1 - rent the server

Show the user this command, the hourly price from step 0, and that billing starts now and runs until step 5:

    IP=$(SSH_KEY=<key-name> SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)

Then offer: "I can run it once you say yes, or you can paste it into your own terminal and share the output. Either works."

Expected: `[provision] done. Next` on stderr and the IP on stdout, in under a minute. If the user ran it, get the IP with `IP=$(hcloud server ip "$NAME")`.

If the user wants a trial server that deletes itself, leave out `WATCHDOG=0` and add `MAX_USD=8 EXPECTED_HOURS=24`. `provision.sh` then starts `watchdog.sh` on the user's computer, which deletes everything after 24 h, when the bill would pass `MAX_USD`, or after 2 h without progress. To keep the node after all: `touch .provision-state/watchdog.disarm`.

If it stops with `this project already has: …`, that server may be someone else's, and nothing was changed. Ask the user: another `NAME` for a new node, or `REUSE=1` only if it is their own earlier run.

## Step 2 - start the node

Tell the user that `SNAPCHAIN_AGREE_NO_REWARDS=yes` answers the official bootstrap's question: a read node earns no rewards. Show this command, then run it once they OK it:

    ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh

Right after step 1, SSH can refuse the connection for a minute while the server boots; wait and run it again. On our cax31 run, loading the snapshot took 8 h 34 m and catching up 5 h 15 m more. If SSH drops, the node keeps going; wait again with:

    ssh root@$IP 'bash -s wait' < node.sh

## Step 3 - open the app

This needs Docker on the server, which step 2 has installed once it prints `[node.sh] Downloading official bootstrap:`. Show this command, then run it once the user OKs it:

    ./deploy-client.sh "$IP"

Expected: `[deploy-client] OK: https://<name> (client) …`. While the node is still loading its snapshot, it ends with `[deploy-client] OK: app is up at https://<name>. The node isn't answering yet` instead, and the app shows **Node still starting**.

## Step 4 - verify

Check the sync. Synced means every shard shows a `blockDelay` in single digits; the API does not answer while the snapshot loads.

    ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'

Give the user the app's https address. The status at the top should say **Connected to your node**. Remind them that the server is billing until step 5.

## Step 5 - delete everything

Only when the user asks. Show this command and tell them it deletes the node's database with the volume:

    CONFIRM="$NAME" ./teardown.sh

Then offer: "I can run it once you say yes, or you can paste it into your own terminal and share the output. Either works."

Expected: it ends with `[teardown] verified: server, volume(s) and firewall are gone.` Then confirm nothing named `$NAME` is left: `hcloud server list`, `hcloud volume list`, `hcloud firewall list`, `hcloud primary-ip list`. If it says `It may be someone else's node; nothing deleted`, stop and show the user; only they decide on `OTHER_SERVER_OK=1`.

## Step 6 - optional extras (ask first; fine to skip)

- Post through the node with an app key: https://sudharshanx.github.io/runfarcaster/first-cast/ (the user runs the local app and types the phrase there themselves).
- Install the RunFarcaster skill for later sessions: `npx skills add sudharshanx/runfarcaster --skill runfarcaster`
- Build an app, bot or analytics job on the node: https://sudharshanx.github.io/runfarcaster/build-on-your-node/

Errors: https://sudharshanx.github.io/runfarcaster/fix/ · Whole guide as text: https://sudharshanx.github.io/runfarcaster/llms-full.txt
