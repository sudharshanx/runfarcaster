# RunFarcaster: read and post on Farcaster from your own server

Three commands: rent a Hetzner server, bring up a Snapchain read node there, and open a web app that reads your
feed from that node and posts casts, likes and follows through it. You need no API keys.

This repo holds the scripts for those 3 steps, the web app, the tests and the guide's website. The read node keeps
a full copy of Farcaster.

Status: the 3 steps have been tested end to end once on mainnet (2026-10-18), on a Hetzner cax31 with a 1000 GB
volume. On that hardware, our run took 14 h 06 m from renting the server to a synced node, an estimated $2.31 at
list prices. The app was served over HTTPS from the node. Adding an app key and posting a cast have been tested on
mainnet; likes, recasts and follows have been tested against a mock node only. Numbers: `MEASUREMENTS.md`. Log:
`run-log.md` (server details replaced with placeholders).

Guide website: `site/`. Vouching: `VOUCHER.md`. Key handling: `SECURITY.md`.

## Full run (Quickstart)

You need `hcloud`, `jq`, `ssh`, `curl`, Node.js 22.12 or later (22.x, 24.x or 26+) with npm, a Hetzner Cloud
token (Read & Write) and an SSH key uploaded to the Hetzner project. Posting needs a Farcaster account; use a test
account. Run everything from this folder on your own computer.

Get the code:

```bash
git clone https://github.com/sudharshanx/runfarcaster
cd runfarcaster
```

Set the token first, on its own (the prompt hides what you type):

```bash
read -rsp 'Hetzner token: ' HCLOUD_TOKEN && export HCLOUD_TOKEN && echo
```

Then the 3 steps:

```bash
MY_IP=$(curl -4 -s https://ifconfig.me)
echo "$MY_IP"                       # must print your address
export NAME=snapchain-read-node     # server name; the volume, firewall and teardown.sh follow it

# 1. Rent a server: the first 16 GB type for sale, a 1000 GB volume and a firewall. Prints the IP. Under a minute.
IP=$(SSH_KEY=my-key SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 \
  SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)

# 2. Start the node: Docker, disk helpers (disk < 1500 GB), the official bootstrap, then wait up to 24 h for sync.
ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh

# 3. Open the app: builds it here, serves it with Caddy over HTTPS, /v1 on the same address.
./deploy-client.sh "$IP"            # prints https://<ip-with-dashes>.sslip.io (or pass your own DNS name)
```

Use an empty Hetzner project. If the project already has a server named `$NAME` or the volume `$NAME-data`,
`provision.sh` stops and changes nothing; pick another `NAME`, or set `REUSE=1` for your own earlier run.
Step 3 can run while the node is still loading its snapshot; the app then shows "Node still starting".

In a new terminal, set `NAME` again and get the IP back with `IP=$(hcloud server ip "$NAME")`.

`WATCHDOG=0` keeps the server until you delete it. For a trial run, leave it out and add
`MAX_USD=8 EXPECTED_HOURS=24`: `provision.sh` then starts `watchdog.sh`, which deletes everything
after 24 hours. `SERVER_TYPE=""` makes `provision.sh` rent the first type for sale in `LOCATION` from cx43, cax31,
cpx42 and ccx23 (16 GB RAM or more). If none is for sale, it lists what is and creates nothing. Set `SERVER_TYPE`
and/or `LOCATION` (fsn1, nbg1, hel1, ash, hil, sin) and run it again.

When you no longer need the node, delete the server, the volume and the firewall. Safe to run twice:

```bash
CONFIRM="$NAME" ./teardown.sh
```

Notes:
- New Hetzner accounts may rent at most 1024 GB of volumes in total (https://console.hetzner.cloud/limits).
  The Snapchain docs ask for 1.5 to 2 TB. `VOLUME_GB=1000` works with two helpers that keep the
  snapshot from filling the disk: `disk-guard.sh` stops the node at 90% full and `snapshot-space-saver.sh`
  deletes snapshot files once the node has read them. `node.sh` installs both on disks under 1500 GB.
  **That automatic install has unit tests but has not run during a live sync yet;** on the mainnet run they were
  installed by hand. `MIN_FREE_GB=900` lets `node.sh` accept the volume, which shows 984 GB.
- If SSH drops during step 2, the node keeps going. Wait again with `ssh root@$IP 'bash -s wait' < node.sh`.
- `SNAPCHAIN_AGREE_NO_REWARDS=yes` answers the official bootstrap's question: a read node earns no rewards.
  Read it first: https://snapchain.farcaster.xyz/getting-started
- `ESTIMATE_ONLY=1 SERVER_TYPE="" VOLUME_GB=1000 ./provision.sh` shows the price and creates nothing.
- The tested type is cax31 (ARM64); times on other types vary. If a type isn't available to rent in `LOCATION`,
  the error lists the types that are, cheapest first. **cpx42 (x86, 16 GB RAM) has not been tested.** With IPv4 and
  the 1000 GB volume it costs $159.29 a month at list prices, or an estimated $0.255 an hour.
- Ports 3381 (HTTP API) and 3383 (gRPC) are closed to the internet. The app reaches the node through Caddy.
  Set `NODE_API_CIDRS` in `provision.sh` to open them to chosen addresses.
- Without `WATCHDOG=0`, `provision.sh` starts `watchdog.sh` in the background before it creates anything (output in
  `.provision-state/watchdog.out`, log in `.provision-state/watchdog.log`). If the watchdog cannot start, for
  example without `HCLOUD_TOKEN`, `provision.sh` stops and creates nothing. The watchdog runs `teardown.sh` before
  the bill reaches `MAX_USD` (in your Hetzner account's currency), after 24 hours (`WATCHDOG_MAX_WALL_SECS`), or
  after 2 hours with no growth in the database or block heights. The progress check uses `SSH_KEY_FILE` (default
  `~/.ssh/id_ed25519` if it exists); without it only the money and time limits apply.
  `touch .provision-state/watchdog.disarm` stops it without deleting. `WATCHDOG=0` skips it.

## The recovery phrase and app keys

> **Only paste a seed phrase into software from developers you trust. Delegated signers are preferred wherever possible.**
>
> Use a test account. Only type a recovery phrase into code you have read, on your own computer. Never paste
> it into an AI assistant or a chat. If an app you trust can give you an app key, use that instead.

For the one step that needs the phrase (adding an app key), run the app locally, not from the sslip.io address:

```bash
cd client && npm ci --ignore-scripts
SNAPCHAIN_NODE_URL=https://<name> npm run dev   # <name>: the address deploy-client.sh printed; open http://localhost:5317
```

The dev server passes `/v1` on to your node's HTTPS address, so you need no SSH tunnel. Pick a 1-day key expiry
for a test. The app cannot revoke keys yet: a gasless key is cancelled with a `KEY_REMOVE` message from the custody
address.

Port 5317 is fixed (`strictPort`), so the app's `localStorage` is not shared with other Vite projects on 5173.
The page has a Content-Security-Policy that only lets it connect to its own address. Type the phrase, or clear
the clipboard after pasting it. Press "Remove from this browser" when you are done.

A page on `localhost` comes from files on your disk. A page on `<ip>.sslip.io` depends on a DNS service someone
else runs, so the app warns before you type a phrase there.

What the app does with the phrase (`client/src/signer.ts`):
1. Makes a new ed25519 app key in the browser.
2. Works out the custody address from the phrase, asks the node which FID it owns, and reads `currentUserNonce`
   from `/v1/signersByFid`.
3. Signs one gasless `KEY_ADD` with `makeKeyAddBody` (EIP-712, custody address), with nonce
   `currentUserNonce + 1`, scopes `CAST_ADD`, `REACTION_ADD` and `LINK_ADD`, and a lifetime of 7 days by default
   (90 at most; each use renews it). No ETH is needed. Mainnet has accepted gasless keys since engine version V16 on 2026-05-07
   (snapchain `src/version/version.rs`). Guide: https://snapchain.farcaster.xyz/guides/writing-messages.
4. Drops the phrase. Nothing stores, logs or sends it; only the signed `KEY_ADD` goes to the node. JavaScript
   cannot promise the browser wiped it from memory.
5. Saves the app key in that page's `localStorage`. "Remove from this browser" deletes it there. The network accepts the key
   until it expires or your custody address cancels it.

## How a read node handles your messages

`POST /v1/submitMessage` on a read node checks the message and publishes it to the validators over gossip. The
node keeps no mempool. Sources: https://snapchain.farcaster.xyz/node-types#message-submission-and-the-mempool,
and in the code `submit_message_internal` (`src/network/server.rs`) and `ReadNodeMempool` (`src/mempool/mempool.rs`).

So HTTP 200 means "sent on", not "in a block". The app shows each cast, like or follow at once, then asks the node
for it by hash every 4 seconds. If it has not appeared 30 seconds after the last send, the app sends the
identical message again. After 4 sends it marks it **Failed**, and you can retry or dismiss it.

## Why the app and the node share one address

The node's HTTP API is plain HTTP on 3381. It has no OPTIONS route, and `submitMessage` needs
`Content-Type: application/octet-stream`, so a browser call from another address fails its preflight check.
`deploy/Caddyfile` fixes that:
- Caddy serves the app over HTTPS (Let's Encrypt) and passes `/v1/*` to `127.0.0.1:3381` on the same address.
- The CSP sets `connect-src 'self'`.
- `/v1/mesh` (the mesh debug view) returns 404. `/v1/currentPeers` stays public.

`npm run dev` in `client/` does the same with Vite's proxy (`SNAPCHAIN_NODE_URL`, default
`http://127.0.0.1:3381`). The node URL can also be set in the app; leave it empty for the same address.

## Agent skill

`skills/runfarcaster/` is an [Agent Skill](https://agentskills.io/) for coding agents: the 3 steps, the fixes and
the safety rules, with details in `references/`. Install it with:

```bash
npx skills add sudharshanx/runfarcaster --skill runfarcaster
```

`site/scripts/check-skill.mjs` runs in the site build. It checks the skill's frontmatter and that its commands match
`site/src/prompts.ts` and its error texts match the Fix a problem page.

## The guide website

`site/` is Astro Starlight. Building it needs Node.js 22.22 or later (Astro 7). Build it with:

```bash
cd site && npm ci
npm run build
```

The defaults are `REPO_URL=https://github.com/sudharshanx/runfarcaster`,
`SITE_URL=https://sudharshanx.github.io` and `BASE_PATH=/runfarcaster/`. Set those variables to build a
fork, for example `REPO_URL=https://github.com/<you>/runfarcaster SITE_URL=https://<you>.github.io npm run build`.
`REPO_URL` sets every repo link and the `git clone` command; `SITE_URL` and `BASE_PATH` set the address.
`.github/workflows/pages.yml` sets all three for GitHub Pages.

In CI (`CI=true`) the build fails if a placeholder reaches `dist/`: `github.com/OWNER`, `example.github.io`, an
AUTHOR note, a `{{ALL_CAPS}}` token or a `RERUN_` token. `npm run originality` lists 5-word phrases the site
shares with a set of other pages, to catch copied text.

## The app

- Feed: casts from the accounts an FID follows, plus FIDs you add to watch.
- Posting: cast, follow, like and recast.
- Filters: mute or only show, by FID or keyword, saved in `localStorage`. A mute wins over an only-show rule. They work on casts made in any app.
- Layout: phones (tested at 360 and 375 px, no sideways scroll, 44 px buttons) and desktop.

## Repo layout

| Path | What it is |
|---|---|
| `provision.sh` / `teardown.sh` | Hetzner via the `hcloud` CLI, with a cost guard. The token is read from env and never printed. |
| `node.sh` | Step 2: checks, Docker, disk helpers, official bootstrap, sync wait, health check. Safe to re-run; `DRY_RUN=1`. |
| `watchdog.sh` | Runs on your computer. Runs `teardown.sh` on the money, time or no-progress limit. |
| `disk-guard.sh`, `snapshot-space-saver.sh` | Run on the server (systemd, installed by `node.sh`; copies embedded in `node.sh` by `tools/embed-helpers.py`). |
| `deploy-client.sh`, `deploy/` | Caddy, compose and firewall rules |
| `client/` | The web app (Vite, TypeScript) |
| `test/` | Tests for node.sh, the space saver, the watchdog and teardown, with fake docker, hcloud and ssh |
| `e2e/` | Browser tests: real Caddyfile and a mock node (`run.sh`); the live node, read-only (`real-node.mjs`) |
| `SOURCES.md` | Every fact and where it came from: URLs and SHAs |
| `DOCS_ISSUES.md` | Outdated or wrong official docs found along the way |
| `MEASUREMENTS.md` | Numbers from the live run, plus cost estimates |
| `skills/runfarcaster/` | Agent Skill for coding agents (`SKILL.md` plus `references/`) |
| `site/` | The guide website |

## Tests

```bash
shellcheck -x -P SCRIPTDIR *.sh test/*.sh e2e/*.sh
bash test/node_sh_test.sh        # node.sh with fake docker and a mock /v1/info
bash test/space_saver_test.sh
bash test/watchdog_test.sh       # progress check, SSH loss, money cap, macOS without timeout
bash test/teardown_test.sh       # fake hcloud; running twice, missing token, wrong confirmation
bash test/provision_test.sh      # CIDR check, watchdog start (stub), unavailable types and LOCATION hints (fake hcloud)
python3 tools/embed-helpers.py --check
cd client && npm ci --ignore-scripts && npm run typecheck && npm test && npm run build
cd e2e && npm ci && CADDY=caddy CHROME=/path/to/chrome ./run.sh   # Caddy, mock node, headless Chrome
```

- Ran live on 2026-10-18: `provision.sh` (cax31, `VOLUME_GB=1000`), `node.sh` (official bootstrap, full sync, a
  second run that skipped the bootstrap), the two disk helpers installed by hand, `deploy-client.sh` (Let's
  Encrypt via sslip.io) and `SITE=https://<name> CHROME=... node e2e/real-node.mjs` (read-only, 17 of 17; its one
  write is a broken `submitMessage`, which the node rejects with 400).
- Unit tests only: `node.sh` installing the disk helpers itself, the watchdog progress check, `provision.sh`
  starting the watchdog itself.
- Ran live once: `teardown.sh`, which deleted the server, volume and firewall on 2026-10-20.
- Not tried: likes, recasts and follows on mainnet (a gasless KEY_ADD and one cast did run; see Status above),
  a 2 TB volume.
- For a specific SSH key: `SSH_OPTS="-i key" ./deploy-client.sh "$IP"`.

## Assumptions

- The custody key is at `m/44'/60'/0'/0/0`, the usual path for Farcaster wallets.
- sslip.io, a wildcard DNS run by someone else, is fine for reading. Pass your own DNS name otherwise.
- Hetzner deletes the server's automatic primary IP with the server. `teardown.sh` lists primary IPs so you can check.

## Known warnings

- `npm audit` reports `@faker-js/faker` (GHSA-qxc2-j82w-r537). It is pulled in as a runtime dependency of `@farcaster/core`, which loads it at import. The client never calls `helpers.fake`, so the vulnerable path is not used, but it is in the bundle (about 3.4 MB).
- The Vite build warns about a direct `eval` in protobufjs and about chunk size. The CSP blocks `eval`; the E2E test shows no CSP violations.

## License

MIT. See `LICENSE`.
