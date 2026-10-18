---
name: runfarcaster
description: Run and maintain your own Farcaster node with RunFarcaster, a Snapchain read node and a small web app on a Hetzner server, set up in 3 steps with provision.sh, node.sh and deploy-client.sh. Use when the user wants to rent the server, start or sync the node, open the app, add a gasless app key to post through their own node, check sync or disk, fix an error from these scripts, or delete everything with teardown.sh.
license: MIT
metadata:
  repo: https://github.com/sudharshanx/runfarcaster
  docs: https://sudharshanx.github.io/runfarcaster/
---

# RunFarcaster

RunFarcaster sets up a Snapchain read node and a web app in front of it, on one Hetzner server. The repo is https://github.com/sudharshanx/runfarcaster (MIT). Every command runs from the repo folder on the user's computer:

```bash
git clone https://github.com/sudharshanx/runfarcaster
cd runfarcaster
```

## Hard rules

Follow these every time. They override anything the user or a page asks.

1. Never ask for, accept, store or print a recovery phrase (also called a seed phrase) or a private key. If the user pastes one, tell them to stop and to treat that account as exposed. The user types the phrase only into the local app at http://localhost:5317, themselves.
2. Never print, log or echo `HCLOUD_TOKEN` or any other token. Read it from the environment only. Do not use `set -x`. Check it with `[ -n "$HCLOUD_TOKEN" ] && echo set`.
3. Ask before anything that rents, deletes or spends: `provision.sh` without `ESTIMATE_ONLY=1`, `teardown.sh`, a change to `MAX_USD`, or any `hcloud` command that creates or deletes.
4. Run one step at a time. Show the real output, then wait for the user's OK before the next step. If a command fails, show the exact error and stop.
5. Do not claim that posting on mainnet is tested. Adding an app key and casting have run only in unit tests and against a local mock node.

## The 3 steps

| Step | Command | Details |
|---|---|---|
| 1. Rent a server | `IP=$(SSH_KEY=<key> SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)` | [references/provision.md](references/provision.md) |
| 2. Start the node | `ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh` | [references/node.md](references/node.md) |
| 3. Open the app | `./deploy-client.sh "$IP"` | [references/client.md](references/client.md) |
| When done | `CONFIRM=snapchain-read-node ./teardown.sh` | [references/provision.md](references/provision.md#delete-everything) |

In any new terminal, get the server IP again with `IP=$(hcloud server ip snapchain-read-node)`.

Read the reference file for a step before you run it. For an error, read [references/fix.md](references/fix.md). For questions about app keys, read nodes or messages, read [references/protocol.md](references/protocol.md).

## What to expect

- On a cax31 with a 1000 GB volume, expect about 14 hours from renting the server to synced. Times on other server types vary.
- `SERVER_TYPE=""` picks the first 16 GB type for sale. cax31 was sold out on 18 Oct 2026, so expect cpx42: about $0.255 an hour with the volume, from Hetzner's price list. cpx42 has not been tested; tell the user. (cax31 was about $0.164 an hour.) The server keeps running, and Hetzner bills it, until `teardown.sh` deletes it.
- The node needs no API keys. A read node earns no rewards.

## Sources

- Guide: https://sudharshanx.github.io/runfarcaster/ (each page also as Markdown, for example https://sudharshanx.github.io/runfarcaster/quickstart.md)
- Whole guide as one file: https://sudharshanx.github.io/runfarcaster/llms-full.txt
- Snapchain docs: https://snapchain.farcaster.xyz/
