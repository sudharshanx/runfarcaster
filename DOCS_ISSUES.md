# Documentation issues found

Each entry gives: page, what it says, what is true, how it was verified. "Code" means the snapchain
source at `fc87f2686472598143062a00e1c2b2633b2d87ab` (v0.14.3), see SOURCES.md. Nothing below was checked
against a live node, because none was run in this phase.

## Live re-verification, 2026-10-18 01:45-01:50 IST (Parallel)

Every live page below was re-fetched with `parallel-cli extract --full-content --max-age-seconds 600`
(parallel-cli 0.9.3) and the text compared with each entry. Code entries were re-checked against the
`main` branch raw files fetched the same way. The raw JSON responses are kept outside the repo in
`/workspace/parallel-audit-2026-10-18/` (extract and search IDs are listed in SOURCES.md).
Status: **Confirmed** = still wrong/missing live; **Already fixed** = the live page now says the right thing;
**Can't verify** = Parallel cannot check it (image, local test or provider behaviour).

| # | Status | Evidence (live, 2026-10-18) |
|---|---|---|
| 1 | Can't verify (image) | Page text still says "add rules until they match the below. inbound outbound"; the rules are only in `inbound.png`, which a text extract cannot read. Ports table on managing-a-node still says 3382/UDP; compose on `main` still publishes `3382:3382/udp`. |
| 2 | Confirmed | Running-a-node still has "select Allow SSH traffic from Anywhere", `get-docker.sh`, and `mkdir snapchain && cd snapchain` (page "Last updated 10/9/26"). Bootstrap on `main` still does `mkdir -p ~/snapchain` / `cd ~/snapchain`. The Neynar mirror (docs.neynar.com/snapchain/guides/running-a-node) has the same text. |
| 3 | Confirmed | Getting Started: "2 TB of free storage"; README on `main`: "1.5TB of free storage". |
| 4 | Confirmed | README: "Ports 3381 - 3383 exposed on both TCP and UDP."; compose publishes `3381/tcp`, `3382/udp`, `3383/tcp` only. |
| 5 | Confirmed | Official table still `reverse=1`; official JS example still `&nextPageToken=${ nextPageToken }` and `response.nextPageToken`. Neynar mirror: JS fixed (`pageToken=`, `response.data.nextPageToken`), table still `reverse=1`. |
| 6 | Confirmed | `reference/httpapi/onchain` documents only `onChainSignersByFid`; llms.txt lists no `signersByFid`/`signer` page. Writing-messages still says `GetOnChainSignersByFid` "is deprecated". |
| 7 | Confirmed (undocumented) | No HTTP page mentions `requesterFids`; writing-messages only mentions it for gRPC `GetSignersByFid`. The bracket behaviour itself comes from a local serde_qs test and was not re-run. |
| 8 | Confirmed | Writing-messages still has ``console.log(`Using address: ... private key: ${ accountPrivateKey }`)``. |
| 9 | Confirmed | `SCOPES` lists 9 types (CAST_ADD/REMOVE, REACTION_ADD/REMOVE, LINK_ADD/REMOVE, USER_DATA_ADD, VERIFICATION_ADD_ETH_ADDRESS, VERIFICATION_REMOVE) and `TTL = 30 * 24 * 60 * 60`. (Entry said "10+"; it is 9.) |
| 10 | Confirmed | Hello World unchanged: "~10$ USD of ETH bridged to Optimism", `KEY_GATEWAY_ADDRESS`/`keyGatewayABI` from `@farcaster/hub-web`, `hoyt.farcaster.xyz:3383`, "Write access to a hub". |
| 11 | Confirmed | Architecture overview still lists "Adding account keys for connected apps" under onchain actions; no mention of validators/read nodes. |
| 12 | Confirmed (partly documented) | Bootstrap on `main` still ends `exec ./snapchain.sh "upgrade" < /dev/tty`; no page mentions the TTY requirement. Getting Started now does say it "starts the node and follows its logs", so the never-returning part is documented. |
| 13 | Already fixed (docs) | managing-a-node now lists `SKIP_CRONTAB` in the env table and has a troubleshooting entry for "`auto-upgrade: Unable to determine upgrade day`" when `HUB_OPERATOR_FID` is 0. Code unchanged (snapchain.sh l.441); `pwd \| cut -d/ -f3` still present (l.400). |
| 14 | Mostly fixed | managing-a-node now says "Port 3000 is published on all interfaces, so change the password and keep the port closed in your firewall", and lists `GRAFANA_CREDS` default `admin:admin`. Still open: the ports table calls 3000 "local use only", and nothing says Docker-published ports bypass ufw. |
| 15 | Confirmed (package) | `packages/core/package.json` on `main` is 0.20.0 with `"@faker-js/faker": "^7.6.0"` under dependencies. Buffer use was a local test, not re-run. |
| 16 | Can't verify (provider) | Getting Started still says "2 TB" and no Snapchain page mentions provider quotas (confirmed). The Hetzner limit itself is from our live run, not a doc. |
| 17 | Confirmed | Getting Started still says "The snapshot is several hundred gigabytes"; `snapshot.rs` on `main` still has `remove_dir_all(snapshot_dir)` once at the end (l.428) and `FixedInterval::from_millis(10_000).take(5)` retries (l.361). |

Note: the file has 17 entries, not 16.

## 1. AWS guide firewall opens gossip on TCP, with no UDP rule
- **Page:** https://snapchain.farcaster.xyz/guides/running-a-node (image `/images/inbound.png`)
- **Says:** the inbound rules are TCP 22, 3381, 3382 and 3383.
- **True:** gossip is QUIC over **UDP** 3382 (compose `/ip4/0.0.0.0/udp/3382/quic-v1`, published as `3382:3382/udp`). The managing-a-node ports table also says 3382/UDP. With the guide's security group, inbound gossip would be blocked.
- **Verified:** looked at inbound.png; read docker-compose.mainnet.yml and the ports table.

## 2. AWS guide: other outdated details
- **Page:** https://snapchain.farcaster.xyz/guides/running-a-node
- **Says:**
  - `mkdir snapchain && cd snapchain` before running the bootstrap;
  - install Docker with get.docker.com;
  - "Allow SSH traffic from Anywhere".
- **True:**
  - The bootstrap always installs into `~/snapchain`, whatever the current directory (PR #1034, Getting Started). The `mkdir` is redundant: the node still ends up in `~/snapchain`, and the extra empty directory is just confusing.
  - snapchain.sh installs Docker itself if it is missing.
  - Opening SSH to the whole internet is unnecessary. Restrict it to your own IP.
- **Verified:** read snapchain-bootstrap.sh and snapchain.sh.

## 3. Disk requirement differs between docs site and README
- **Pages:** https://snapchain.farcaster.xyz/getting-started says "2 TB of free storage". https://github.com/farcasterxyz/snapchain/blob/main/README.md (l.32) says "1.5TB of free storage".
- **True:** unknown until measured; see MEASUREMENTS.md. This repo uses the larger figure, 2 TB.
- **Verified:** read both at fc87f26.

## 4. README port protocols are wrong
- **Page:** README l.34: "Ports 3381 - 3383 exposed on both TCP and UDP."
- **True:**
  - Compose publishes only 3381/tcp, 3382/udp and 3383/tcp. Nothing listens on 3381/udp, 3382/tcp or 3383/udp.
  - Getting Started (l.14) gives "ports 3381 - 3383 exposed" without saying which protocol.
- **Verified:** read compose.
- **In this repo:** `PORT_PROFILE=readme` opens the superset in case the README is right about something the compose file does not show.

## 5. HTTP paging docs: `reverse=1` and the JS paging example
- **Pages:** https://snapchain.farcaster.xyz/reference/httpapi/httpapi (source `site/docs/pages/reference/httpapi/httpapi.md` l.61, 88-93) and the mirror https://docs.neynar.com/snapchain/httpapi/httpapi.md.
- **Says:**
  - The paging table example is `reverse=1`.
  - The snapchain JS example sends `nextPageToken=${...}` as the query parameter and reads `response.nextPageToken`.
- **True:**
  - The query parser is serde_qs 0.13.0, and it rejects `reverse=1` with "provided string was not `true` or `false`". Only `reverse=true` works. Every per-endpoint table on the same site already says `reverse=true`.
  - The parameter is `pageToken`, and with axios the body is `response.data.nextPageToken`. As written, the example re-fetches page 1 forever.
  - The Neynar mirror has fixed the JS example but still says `reverse=1`.
- **Verified:** compiled a serde_qs 0.13.0 test locally; read the http_server.rs query structs; fetched the Neynar page on 2026-10-18.

## 6. `/v1/signersByFid` and `/v1/signer` are missing from the HTTP reference
- **Page:** https://snapchain.farcaster.xyz/reference/httpapi/onchain. It documents `onChainSignersByFid`, which only covers onchain keys.
- **True:**
  - `GET /v1/signersByFid?fid=` returns both onchain and gasless keys plus `currentUserNonce`, which gasless KEY_ADD needs.
  - `GET /v1/signer?fid=&signer=` exists too.
  - The writing-messages guide says `GetOnChainSignersByFid` is deprecated. PR #989 lists this gap as a follow-up.
- **Verified:** read http_server.rs l.1138, 3815, 4578.

## 7. `requesterFids` must use brackets over HTTP
- **Page:** none documents it. The code comment on the query struct suggests repeating the key.
- **True:** `requesterFids=1&requesterFids=2` returns "Multiple values for one key". `requesterFids[]=1&requesterFids[]=2` works (serde_qs).
- **Verified:** local serde_qs 0.13.0 test.

## 8. Writing-messages example prints the private key
- **Page:** https://snapchain.farcaster.xyz/guides/writing-messages
- **Says:** ``console.log(`Using address: ${account.address} with balance: ${balance}, private key: ${accountPrivateKey}`)``
- **True:** keys should never be logged. Shell history, CI logs and screen shares leak them.
- **Verified:** llms-full.txt l.3701.

## 9. Writing-messages recommends broad scopes and a 30-day TTL
- **Page:** https://snapchain.farcaster.xyz/guides/writing-messages
- **Says:** use 9 scopes (re-counted 2026-10-18), including USER_DATA_ADD and VERIFICATION_*, with a 30-day TTL.
- **Better:** request only the message types the app signs. A feed/post/follow/react client needs `CAST_ADD, REACTION_ADD, LINK_ADD`. Use a short TTL, since it slides on every use.
- This is a suggestion, not a factual error.

## 10. Hello World guide is outdated
- **Page:** https://docs.farcaster.xyz/developers/guides/basics/hello-world (fetched 2026-10-18)
- **Says:**
  - Requirements are "~10$ USD of ETH bridged to Optimism" and an OP Mainnet RPC URL.
  - Step 3 adds the account key onchain via `KeyGateway.add()` using `getSignedKeyRequestMetadata`, then "Sleeping 30 seconds".
  - It uses `@farcaster/hub-web`.
  - Its default hub is `hoyt.farcaster.xyz:3383`, and it says to use a 3rd-party provider like Neynar.
  - It calls the node a "hub" throughout.
- **True:**
  - Since V16 (2026-05-07) app keys can be added gaslessly with a `KEY_ADD` message (`makeKeyAddBody`), with no ETH, no RPC and no wait for an OP block (PR #989, writing-messages guide).
  - `getSignedKeyRequestMetadata` signs the onchain domain, which `KEY_ADD` rejects.
  - The migrating guide says hub-web "is not fully supported".
  - A self-run read node accepts writes and relays them (node-types page, PR #1034), so no third-party hub or API key is needed.
  - In the step-3 snippet, `requestFid: APP_FID` and `key: APP_PRIVATE_KEY` are undefined identifiers. The key field should be the *public* key, not a private key. Its `deadline` uses Unix time, while the gasless flow uses Farcaster time.
  - Creating an FID and renting storage are still onchain. That part is still correct.
- **Verified:** read the page; compared it with the writing-messages guide, key.rs, and this repo's KEY_ADD unit test and E2E test (local mock node).

## 11. Architecture overview lists adding account keys as onchain-only
- **Page:** https://docs.farcaster.xyz/learn/architecture/overview (fetched 2026-10-18)
- **Says:** onchain actions include "Adding account keys for connected apps".
- **True:** keys can now also be added offchain, gasless, through a `KEY_ADD` message validated against an EIP-712 signature from the custody address. Onchain key adds still work.
  - The page also doesn't say that Snapchain nodes come in two kinds, validators and read nodes, or that read nodes relay writes.
- **Verified:** writing-messages guide, PR #989, key.rs.

## 12. Bootstrap cannot run non-interactively
- **Page:** Getting Started and the AWS guide (`curl ... | bash`)
- **True:**
  - The bootstrap ends in `exec ./snapchain.sh upgrade < /dev/tty`. Without a TTY (cloud-init, CI, `ssh host 'bash -s' < script`) it fails with "/dev/tty: No such device or address".
  - With a TTY, it never returns, because it ends in `docker compose logs -f`.
  - This is not documented. node.sh works around it by running it under `script` for a pty, with the answers pre-seeded in `.env`.
- **Verified:** ran the bootstrap's tty redirect locally without a TTY; read snapchain.sh.

## 13. FID 0 makes snapchain.sh exit unless the cron job is skipped
- **True:** when `HUB_OPERATOR_FID=0` and there is no `.hub/default_id.protobuf`, `setup_crontab` exits with "Unable to determine upgrade day". `SKIP_CRONTAB=true` is required. *(2026-10-18 re-check: managing-a-node now documents this in its env table and troubleshooting section; already fixed in the docs.)*
- **Also seen (low severity):** `setup_crontab` derives the user from `pwd | cut -d/ -f3`, which gives `snapchain` under `/root/snapchain`.
- **Verified:** read snapchain.sh. Only DRY/mocked parts were run locally.

## 14. Grafana is published on all interfaces with admin:admin
- **True:** compose publishes 3000 on 0.0.0.0, and `GRAFANA_CREDS` defaults to `admin:admin`. Docs call it "local", but a VM with no external firewall exposes it. Docker-published ports bypass ufw.
- **In this repo:** the Hetzner firewall only allows 22, 80, 443 and 3381-3383.
- **Verified:** read compose and snapchain.sh.

## 15. `@farcaster/core` needs a `Buffer` polyfill in browsers
- **True:** `makeLinkAdd` → `validateLinkType` uses the global `Buffer`, so a follow fails in a browser without a polyfill. Core 0.20.0 also ships `@faker-js/faker` as a runtime dependency, affected by GHSA-qxc2-j82w-r537, and calls it at import time. This client never calls `helpers.fake`.
- **Verified:** unit test `no-buffer.test.ts`; `npm audit`; a stub test that broke page load.

## 16. Hetzner default account limits block the documented 2 TB disk (found in the live run)
- **Context:** Getting Started says 2 TB of free storage. On Hetzner Cloud that means a volume, because no ≥16 GB shared type has more than 320 GB of local disk.
- **What happened (2026-10-18 01:21 IST):** `hcloud volume create --size 2000` failed with `volumes size limit exceeded (resource_limit_exceeded)` on a project that had no volumes at all.
- **True:** Hetzner enforces an *account-wide* total volume size limit (console → Limits, shared across projects). Fresh accounts sit below 2 TB, and raising it is a manual request. None of the Snapchain docs mention provider quotas.
- **In this repo:** provision.sh now stops with this explanation. The tutorial README should tell readers to check the limit before step 1.

## 17. Snapshot restore needs far more temporary disk than the docs suggest
- **Pages:** Getting Started ("The snapshot is several hundred gigabytes") and the README (1.5 TB free storage).
- **True:** `download_snapshots` in `src/storage/db/snapshot.rs` (fc87f26, l.265-430) handles each shard in three steps, and nothing is deleted until all shards are done:
  1. Downloads all gzipped chunks.
  2. Gunzips all of them into one *uncompressed* `shard_N_snapshot.tar`.
  3. Unpacks that into `.rocks`.

  `remove_dir_all(snapshot_dir)` only runs after the last shard. Peak usage is therefore about compressed chunks + uncompressed tars + database for all shards together. On 2026-10-18 mainnet that was 5689 chunks of about 91 MB (≈520 GB compressed), so the peak is well above 1 TB. That likely explains the 1.5-2 TB figure, but no doc says so.
  - Also: a chunk download is retried only 5 times, 10 s apart, before the whole restore fails (l.361).
- **Workaround in this repo:** `snapshot-space-saver.sh` frees consumed chunks, hole-punches the already-read part of the tar and deletes finished tars. With it, a ~1 TB volume should be enough, but that has not been measured yet; see MEASUREMENTS.md.
- **Verified:** read the source; watched the restore logs on the live VM.

# New issues from the 2026-10-18 Parallel sweep

All found with `parallel-cli search`/`extract` on 2026-10-18 (01:45-01:50 IST). "Truth" sources are the
writing-messages guide and PR #989 (gasless `KEY_ADD`), the node-types page and PR #1034 (read nodes accept
writes and relay), and files on the `main` branch fetched the same day. Uncertain points are marked.

## 18. docs.farcaster.xyz "Create an account key" is onchain-only
- **Page:** https://docs.farcaster.xyz/developers/guides/accounts/create-account-key
- **Says:** "6. Call the Key Gateway contract to add the key onchain." It sets up `optimism` clients and `keyGatewayABI`, and signs an EIP-712 `Add` for the KeyGateway.
- **True:** since V16 a key can be added with no transaction: a `KEY_ADD` message built with `makeKeyAddBody`/`makeKeyAdd`, authorised by an EIP-712 `KeyAdd` signature from the custody address (domain `Farcaster KeyAdd`), submitted to any node. No OP ETH or RPC is needed. The onchain path still works but the page doesn't mention the alternative.
- **Verified:** live page; https://snapchain.farcaster.xyz/guides/writing-messages ("Gasless signers are live on mainnet as of engine version V16"); `@farcaster/core` CHANGELOG 0.20.0 ("builders and EIP-712 helpers for gasless signers (FIP-272)"; "New builders: `makeKeyAddBody` ...").

## 19. docs.farcaster.xyz "Accounts" describes keys as KeyRegistry-only and links the deprecated signer endpoint
- **Page:** https://docs.farcaster.xyz/learn/what-is-farcaster/accounts
- **Says:** "Keys are managed by the KeyRegistry contract. To add a key, you'll need to submit the public key of an EdDSA key pair along with a requestor signature." and "rent storage and add a key ... These steps require many signatures and onchain transactions". Resource "Get account keys" links to `reference/httpapi/onchain` (`onChainSignersByFid`).
- **True:** keys can also be gasless `KEY_ADD` messages held by Snapchain, not the KeyRegistry. Writing-messages says `GetOnChainSignersByFid` "returns onchain keys only and is deprecated"; `GetSignersByFid` / `GET /v1/signersByFid` returns both.
- **Verified:** live page; writing-messages guide; PR #989.

## 20. docs.farcaster.xyz "Messages": "Hub" terminology and outdated storage price/limits
- **Page:** https://docs.farcaster.xyz/learn/what-is-farcaster/messages
- **Says:** "A node in the Farcaster network is called a Hub, and each Hub stores a copy of the entire network." Storage: "A unit of storage costs $7 today ... 5000 Casts, 2500 Reactions, 2500 Links, 50 Profile Data, 50 Verifications".
- **True:**
  - Nodes are Snapchain nodes (validators and read nodes, node-types page); the network is sharded (Getting Started's `/v1/info` example shows `numShards: 2` plus shard 0 for metadata).
  - The storage figures are outdated. Protocol discussion #229 lists the limits in force before it as Casts 2000 / Reactions 1000 / Links 1000 / UserData 50 / Verification 25, and proposes 100 / 200 / 200 / 25 / 5 for new units. The Snapchain storage API now reports a `unit_details` list with `"unitType": "UnitTypeLegacy"`, so there are now several unit types.
  - **Uncertain:** the exact current per-unit limits and price. A third-party site (caststorage.com) says units bought from 16 July 2025 give 100 casts / 200 follows / 200 reactions for "~$0.30". Neither of those is an official source; check the snapchain storage code before quoting numbers.
- **Verified:** live page; https://github.com/farcasterxyz/protocol/discussions/229; https://snapchain.farcaster.xyz/reference/httpapi/storagelimits; https://caststorage.com/ (third party).

## 21. docs.farcaster.xyz "Get account messages" uses a hub-monorepo app that no longer exists
- **Page:** https://docs.farcaster.xyz/developers/guides/querying/fetch-casts
- **Says:** "If you have the hub-monorepo installed from source, you can use the built in `console`" ... "# Ensure you are in the hubble sub directory / `cd apps/hubble` / `yarn console --insecure -s localhost:3383`".
- **True:** https://github.com/farcasterxyz/hub-monorepo/tree/main/apps/hubble returns 404, and the repo's top level has no `apps/` folder (only `packages/`). The HTTP part of the page (`localhost:3381/v1/castsByFid`) is fine.
- **Verified:** live page; Parallel extract of the GitHub path (HTTP 404) and the repo root listing.

## 22. docs.farcaster.xyz "Apps": dead Replicator link
- **Page:** https://docs.farcaster.xyz/learn/what-is-farcaster/apps
- **Says:** "Replicator - a tool to sync a hub to a postgres database" linking to `hub-monorepo/tree/main/apps/replicator`.
- **True:** that URL returns 404. The current tool is `packages/shuttle`, per https://snapchain.farcaster.xyz/guides/syncing-to-db, which the same page's "Set up replicator" link points to.
- **Verified:** Parallel extract (HTTP 404); syncing-to-db page.

## 23. docs.farcaster.xyz "Signer Requests" only describes onchain registration (uncertain)
- **Page:** https://docs.farcaster.xyz/reference/farcaster/signer-requests
- **Says:** "At this point the signer has been registered onchain and you can start submitting messages to hubs" and "an onchain transaction will be made that grants write permissions to that signer".
- **True / uncertain:** this documents the Farcaster client's hosted signer-request flow. Whether that flow still adds the key onchain or now uses gasless `KEY_ADD` could not be verified from public sources. At minimum "hubs" is outdated terminology, and the page doesn't say that apps can add keys gaslessly themselves (writing-messages guide).
- **Verified:** live page only. Low confidence on whether the flow itself is outdated.

## 24. hub-monorepo README describes an `/apps/` folder that doesn't exist and Hubble as the target
- **Page:** https://github.com/farcasterxyz/hub-monorepo (README.md)
- **Says:** "This monorepo contains packages used to communicate with a Farcaster Hub." "The repository is a monorepo with a primary application in the `/apps/` folder". Packages: hub-nodejs "A Node.js client library for Hubble", hub-web "A Browser client library for Hubble", shuttle "streams Hubble events to Postgres".
- **True:** the repo root has no `apps/` (listing: `.changeset/ .github/ .husky/ .vscode/ packages/ ...`). Snapchain replaced Hubble; the migrating guide says to use `hub-nodejs >=0.13.0` against Snapchain.
- **Verified:** Parallel extract of the repo page; https://snapchain.farcaster.xyz/guides/migrating-to-snapchain.

## 25. `@farcaster/hub-nodejs` README: Hubble framing and dead doc links
- **Page:** https://github.com/farcasterxyz/hub-monorepo/blob/main/packages/hub-nodejs/README.md
- **Says:** "Designed to work with Hubble"; "The HTTP API endpoints are documented here" → https://docs.farcaster.xyz/reference/hubble/httpapi/httpapi; docs/examples links point to `github.com/farcasterxyz/hubble/...`.
- **True:** the docs.farcaster.xyz link returns 404; the HTTP API is now documented at https://snapchain.farcaster.xyz/reference/httpapi/httpapi. The docs live at `hub-monorepo/tree/main/packages/hub-nodejs/docs`. **Not checked:** whether `github.com/farcasterxyz/hubble` still redirects to hub-monorepo.
- **Verified:** Parallel extract (404 for the docs.farcaster.xyz URL; the hub-monorepo docs path exists).

## 26. hub-nodejs package docs document removed `SignerAdd` builders and omit the gasless `KEY_ADD` builders
- **Pages:** https://github.com/farcasterxyz/hub-monorepo/blob/main/packages/hub-nodejs/docs/Builders.md, `docs/signers/README.md`, `docs/README.md`
- **Says:** Builders.md documents `makeSignerAdd` / `makeSignerRemove` and says an Eip712Signer is "necessary signing for some messages like `SignerAdds` and `Verifications`". signers/README: "Eip712 signatures are used to sign SignerAdd and SignerRemove messages" and lists only Noble/Ethers signers. docs/README links the HTTP API to `https://www.thehubble.xyz/docs/httpapi/httpapi.html` and calls a node a "Hub".
- **True:** `packages/core/src/builders.ts` on `main` exports no `makeSignerAdd`/`makeSignerRemove`. It does export `makeKeyAdd`, `makeKeyAddBody`, `makeKeyAddData`, `makeKeyRemove`, `makeKeyRemoveBody`, `makeKeyRemoveBodySelfRevoke`, and none of these are in Builders.md. Core 0.20.0 also added the `signKeyAdd` / `getGaslessSignedKeyRequestMetadata` signer methods, which are undocumented. `docs/signers/ViemLocalEip712Signer.md` exists but the signers README doesn't list it. The thehubble.xyz link returns 404.
- **Verified:** Parallel extract of Builders.md, signers/README, builders.ts (export list) and core CHANGELOG.md; thehubble.xyz returned 404.

## 27. `@farcaster/hub-web` README targets Hubble endpoints and has a broken axios example
- **Page:** https://github.com/farcasterxyz/hub-monorepo/tree/main/packages/hub-web (README.md)
- **Says:** "Designed to work with Hubble"; `const server = "http://nemes.farcaster.xyz:2281";` then `response.messages[0]...` after `axios.get`; docs link `https://www.thehubble.xyz/docs/httpapi/httpapi.html`.
- **True:** Snapchain's HTTP port is 3381 (migrating guide: "Ports have changed. The HTTP port is `3381`"). With axios the body is `response.data`, so `response.messages` is undefined. The docs link is 404. **Not checked:** whether `nemes.farcaster.xyz:2281` still answers. The migrating guide also says "`hub-web` is not fully supported and may not work in some cases."
- **Verified:** Parallel extract of the README and migrating guide; 404 for thehubble.xyz.

## 28. hub-nodejs hello-world example README: onchain signer and wrong directory
- **Page:** https://github.com/farcasterxyz/hub-monorepo/tree/main/packages/hub-nodejs/examples/hello-world
- **Says:** "Create a signer on the KeyRegistry contract"; "Navigate to this folder with `cd packages/hub-nodejs/examples/write-data`".
- **True:** the folder is `examples/hello-world`, not `write-data`. `index.ts` still uses `keyGatewayABI` (onchain). The writing-messages guide itself says "That repository still registers its signer onchain via the key gateway". See #10.
- **Verified:** Parallel extract of the README and index.ts.

## 29. Writing-messages guide mixes `@farcaster/hub-web` imports with gRPC hub-nodejs code (likely, not run)
- **Page:** https://snapchain.farcaster.xyz/guides/writing-messages
- **Says:** step 1 imports `ID_GATEWAY_ADDRESS, ..., MessageType` "from '@farcaster/hub-web'" and `Metadata` from `@grpc/grpc-js`, then calls `hubClient.getSignersByFid(..., rpcMetadata)`. A later note says the builders "come from `@farcaster/hub-nodejs` (or `@farcaster/hub-web`)".
- **True / likely:** `hubClient` with grpc-js `Metadata` is the hub-nodejs gRPC client. The hub-web README describes a REST-like HTTP interface and says its grpc-web mode "has been deprecated and is no longer supported", and the migrating guide says hub-web "is not fully supported". The import should probably be `@farcaster/hub-nodejs`. **Not verified by running the snippet.**
- **Verified:** live page; hub-web README; migrating guide.

## 30. Neynar's Snapchain mirror still teaches the onchain signer flow
- **Page:** https://docs.neynar.com/snapchain/guides/writing-messages
- **Says:** imports `keyGatewayABI` from `@farcaster/hub-web`; "Signer: This is a keypair registered with the key registry"; "we assume the signer is already in the key registry". No gasless `KEY_ADD` section.
- **True:** the official page (snapchain.farcaster.xyz/guides/writing-messages) has replaced step 3 with gasless `KEY_ADD` and moved the onchain flow under "Deprecated: registering a signer onchain (costs gas)". The mirror is behind. Its running-a-node page also repeats #2 (`mkdir snapchain && cd snapchain`).
- **Verified:** Parallel extract of both Neynar pages and the official page.

## 31. Low-severity leftovers (terminology, alt text)
- https://docs.farcaster.xyz/reference: "Snapchain - A design overview and API reference for Farcaster Hubs."
- https://docs.farcaster.xyz/developers/guides/writing/submit-messages: page title "Submit data to the hub" (the body correctly says "Write access to a Snapchain node").
- https://snapchain.farcaster.xyz/guides/syncing-to-db: "While some applications can be written by directly querying Hubble".
- https://snapchain.farcaster.xyz/ (source `site/docs/pages/index.mdx`): the logo is `![inbound](/images/logo.png)`, alt text copied from the AWS firewall image. Step 2 links "Run a Snapchain node" to the AWS guide instead of Getting Started.
- **Verified:** Parallel extract of each page / the raw index.mdx.

Checked and found consistent with the known truths (no new issue): snapchain.farcaster.xyz node-types,
getting-started (apart from #3/#12/#17), migrating-to-snapchain, managing-a-node (apart from #14),
grpcapi message, docs.farcaster.xyz developers index and "Create messages" (both point to Snapchain nodes).
Not covered: the docs.farcaster.xyz contract reference pages (KeyGateway/KeyRegistry describe the contracts
themselves, which are still valid), and every individual HTTP/gRPC reference page beyond those named.
