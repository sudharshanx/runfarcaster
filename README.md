# Run your own Farcaster Snapchain read node and client in three commands

This repo gives you three steps: rent a server, turn it into a Snapchain read node, and serve a small web
client from that node. The client reads the feed, posts casts, follows and reacts. You need no API key
from anyone. Status: built and tested **locally only** (see "What has been tested"). No node has been run
yet, and nothing has been sent to mainnet.

## Quickstart

You need: the `hcloud` CLI, a Hetzner Cloud token in `HCLOUD_TOKEN`, an SSH key uploaded to Hetzner,
Node.js 20+ and `jq`. Your Farcaster account must already have an FID and storage.

```bash
# 1. Provision the compute: a ≥16 GB VM, a 2 TB volume and a firewall. Prints the IP. The cost guard refuses runs over MAX_USD (default $2).
IP=$(SSH_KEY=my-key ./provision.sh)

# 2. Set up the read node: Docker, the official bootstrap with no API keys, then wait for sync and run a health check.
ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes bash -s" < node.sh

# 3. Deploy the client, which reads from that node: HTTPS through Caddy on the same origin as the node API.
./deploy-client.sh "$IP"            # → https://<ip-with-dashes>.sslip.io  (or pass your own DNS name)
```

Then remove everything with `CONFIRM=snapchain-read-node ./teardown.sh`. It deletes the server, the volume
and the firewall, then lists what is left to show it is gone.

Tips:
- **Check your Hetzner volume quota before step 1.** It is set per account at https://console.hetzner.cloud/limits and shared by all your projects. New accounts get **1024 GB** in total and may not be allowed to request more yet. If the volume needs more than that, `provision.sh` stops with `volumes size limit exceeded (resource_limit_exceeded)`. To fit the quota, run `VOLUME_GB=1000 ./provision.sh`. The docs call for 1.5–2 TB, so 1 TB is an experiment (one synced-DB example in the docs showed about 549 GB). Install `disk-guard.sh` on the VM: it stops the node cleanly at 90% full (`scp disk-guard.sh root@$IP: && ssh root@$IP ./disk-guard.sh install`). `MIN_FREE_GB=900` lets `node.sh` accept the smaller disk.
- `watchdog.sh` runs on your own machine. It tears everything down before the projected bill reaches `MAX_USD`, if the node stops making progress, or at a wall-clock cap. Start it before `provision.sh`.
- Sync takes hours. Run step 2 inside `tmux` on the VM, or run `ssh root@$IP 'bash -s wait' < node.sh` later.
- `SNAPCHAIN_AGREE_NO_REWARDS=yes` records the official "running a node earns no rewards" agreement for you. Read it first: https://snapchain.farcaster.xyz/getting-started
- To preview the cost without creating anything, run `ESTIMATE_ONLY=1 ./provision.sh`.
- **cx43 is currently reported unavailable** by the Hetzner API. In that case run `SERVER_TYPE= ./provision.sh` to auto-pick the cheapest available type (cax31 ARM64 today), or set `SERVER_TYPE=cax31`.

## Seed phrases and app keys

> **Only paste a seed phrase into software from developers you trust.** It controls your whole account.
> If you can, use a **delegated signer** instead, created by an app you already trust, rather than pasting the phrase anywhere.

If you do paste it, this is what the client does with it (see `client/src/signer.ts`):
1. It generates a new ed25519 **app key** in the browser.
2. It uses the seed phrase **once**, locally, to sign a gasless `KEY_ADD` through `makeKeyAddBody`, with EIP-712 from your custody address. No ETH is needed. Reference: https://snapchain.farcaster.xyz/guides/writing-messages and snapchain PR #989.
3. It reads the nonce from `/v1/signersByFid` and uses `currentUserNonce + 1`.
4. It asks only for the scopes it needs: `CAST_ADD`, `REACTION_ADD`, `LINK_ADD`. The TTL defaults to 7 days, up to 90, and slides forward on use.
5. It then discards the phrase. It is never stored, logged or sent anywhere; only the signed `KEY_ADD` message leaves the browser. JavaScript cannot guarantee memory is wiped, which is another reason to use a trusted device.
6. The app key is kept in `localStorage`. "Forget app key" removes it from the browser. It does not revoke the key onchain, and an unused key expires when its TTL runs out.

## How writes work on a read node

A read node accepts `submitMessage`, validates the message and relays it to validators over gossip. It has
no mempool of its own. Sources: https://snapchain.farcaster.xyz/node-types#message-submission-and-the-mempool
and snapchain PR #1034.

A success response therefore only means the message was relayed. The client shows each cast, like or follow
immediately (an optimistic update), then queries the node for it by hash. It resubmits the same bytes if
the message doesn't show up, and marks it **failed** after 4 attempts so you can retry or dismiss it.

## Mixed content and CORS

Snapchain's HTTP API is plain HTTP on 3381. It has no OPTIONS route, and `submitMessage` requires
`application/octet-stream`, so a browser's CORS preflight fails cross-origin. The fix is
`deploy/Caddyfile`:
- Caddy serves the client over HTTPS (Let's Encrypt) and proxies `/v1/*` to `127.0.0.1:3381` on the **same origin**.
- That means no mixed content and no preflight.
- The CSP is `connect-src 'self'`.
- `/v1/mesh` is blocked.

In development, `npm run dev` does the same through Vite's proxy (`SNAPCHAIN_NODE_URL=http://IP:3381`). The
node URL can be changed in the client UI. An empty value means same origin.

## Client features

- **Feed:** casts from the accounts you follow, plus any FIDs you add to watch.
- **Actions:** post a cast, follow, like and recast.
- **Filters:** include and exclude by FID and by keyword, saved in `localStorage`. Exclude wins over include. Filters apply to casts from any client.
- **Layout:** works on phones (tested at 360px: no horizontal scroll, 44px touch targets) and on desktop.

## Repo layout

| Path | What it is |
|---|---|
| `provision.sh` / `teardown.sh` | Hetzner via the `hcloud` CLI, with a cost guard. The token is read from env and never printed. |
| `node.sh` | Read-node installer, sync wait and health check. Idempotent, `DRY_RUN=1` supported. |
| `watchdog.sh` | Runs on your machine. Budget, hang and wall-clock guard that runs `teardown.sh` automatically. |
| `disk-guard.sh` | Runs on the VM (systemd timer). Stops the node cleanly at 90% disk use. |
| `deploy-client.sh`, `deploy/` | Caddy, compose and firewall rules |
| `client/` | Vite + TypeScript client |
| `test/` | node.sh tests with fake docker and a mock node |
| `e2e/` | Headless-browser test: real Caddyfile, mock node |
| `SOURCES.md` | Every fact and where it came from: URLs and SHAs |
| `DOCS_ISSUES.md` | Outdated or wrong official docs found along the way |
| `MEASUREMENTS.md` | Template for real-run numbers, plus cost estimates |

## What has been tested (locally, on the box only)

```bash
shellcheck -x -P SCRIPTDIR *.sh test/*.sh e2e/*.sh
bash test/node_sh_test.sh                       # node.sh against fake docker + mock /v1/info
cd client && npm ci && npm run typecheck && npm test && npm run build
cd e2e && npm ci && CADDY=caddy CHROME=/path/to/chrome ./run.sh   # Caddy + mock node + headless Chrome
```

- `provision.sh` and `teardown.sh`: shellcheck and `DRY_RUN` only. `provision.sh` was also run with `ESTIMATE_ONLY=1`, which makes read-only API calls.
- **Not tested:** a real VM, the real bootstrap, a real sync, real mainnet writes, the ARM type cax31, and Let's Encrypt issuance.

## Assumptions

- The custody key derives at `m/44'/60'/0'/0/0`, the standard path used by Warpcast/Farcaster wallets.
- sslip.io, a third-party wildcard DNS, is acceptable as a fallback name. Pass your own DNS name otherwise.
- Hetzner deletes the auto-created primary IP along with the server. teardown.sh lists primary IPs to check.
- 2 TB of disk is enough. The docs say 2 TB and the README says 1.5 TB; neither has been measured.

## Known warnings

- `npm audit` reports `@faker-js/faker` (GHSA-qxc2-j82w-r537). It is pulled in as a runtime dependency of `@farcaster/core`, which loads it at import. The client never calls `helpers.fake`, so the vulnerable path is not used, but it is in the bundle (about 3.4 MB).
- The Vite build warns about a direct `eval` in protobufjs and about chunk size. The CSP blocks `eval`; the E2E test shows no CSP violations.

## License

MIT. See `LICENSE`.
