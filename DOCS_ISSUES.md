# Documentation issues found

Each entry gives: page, what it says, what is true, how it was verified. "Code" means the snapchain
source at `fc87f2686472598143062a00e1c2b2633b2d87ab` (v0.14.3), see SOURCES.md. Nothing below was checked
against a live node, because none was run in this phase.

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
- **Says:** use 10+ scopes, including USER_DATA_ADD and VERIFICATION_*, with a 30-day TTL.
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
- **True:** when `HUB_OPERATOR_FID=0` and there is no `.hub/default_id.protobuf`, `setup_crontab` exits with "Unable to determine upgrade day". `SKIP_CRONTAB=true` is required, and this is not in the env-var table.
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
