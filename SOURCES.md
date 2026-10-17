# Sources

Everything in this repo was checked against the sources below on **2026-10-18**, not from memory.
Line numbers are from the copies fetched that day. Where a fact comes from the code and not the docs,
the code is the reference.

## Snapchain (farcasterxyz/snapchain)

| What | Where | Pinned to |
|---|---|---|
| Source tree (shallow clone) | https://github.com/farcasterxyz/snapchain | `fc87f2686472598143062a00e1c2b2633b2d87ab` (tag **v0.14.3**, also `@latest` and `main` HEAD, committed 2026-10-16 01:11 IST) |
| Docs site (all pages concatenated) | https://snapchain.farcaster.xyz/llms-full.txt | fetched 2026-10-18; page sources are `site/docs/pages/**` at the SHA above |
| Bootstrap script | https://raw.githubusercontent.com/farcasterxyz/snapchain/refs/heads/main/scripts/snapchain-bootstrap.sh | same SHA |
| `snapchain.sh` it downloads | `scripts/snapchain.sh` (`@latest` and `main` byte-identical) | same SHA |
| Mainnet compose | `docker-compose.mainnet.yml` | same SHA |
| README | `README.md` | same SHA |
| HTTP server | `src/network/http_server.rs` | same SHA |
| KEY_ADD validation | `src/core/validations/key.rs` | same SHA |
| Sliding TTL | `src/storage/store/block_engine.rs` (around l.987 and l.1185) | same SHA |
| Gossip relay by read nodes | `src/network/gossip.rs` l.429-430 | same SHA |
| Query parser | `Cargo.lock`: `serde_qs 0.13.0` | same SHA |
| AWS guide images | `site/docs/public/images/inbound.png`, `outbound.png` | same SHA |

### Facts used, and where they come from

**submitMessage on a read node.** Docs, node-types page (llms-full l.155, 169-178): a read node has no
mempool of its own. It validates the message, gossips it on the `mempool` topic and keeps nothing. "A
successful response means the message passed validation and was accepted for relay, not that it is in
a block. ... query the message back, to confirm inclusion." gossip.rs l.429-430 agrees. `/v1/info`
reports `mempoolSize: 4294967295` for shards 1 and 2 on read nodes (l.184, l.1064).
- What the client does: `client/src/pending.ts` queries each message back by hash, resubmits the same bytes, and flags any message that never shows up.

**Read node lag.** node-types page (l.167): "A read node is always slightly behind the validators, by
however long sync takes to fetch each decided block."

**Sync criterion.** Getting Started (l.97): `blockDelay` is how many seconds each shard's newest block
is behind the current time. "Once every shard is in the single digits, the node is in sync."
- What node.sh does: it treats the node as synced when every shard has `blockDelay < 10` and `maxHeight > 0`, three polls in a row.
- Expected sync time: README l.42 says "can take up to 2 hours". The docs site (l.41) says "a few hours" and calls the snapshot "several hundred gigabytes".

**Gasless KEY_ADD.** writing-messages page (l.3597-3600, 3611-3612, 3669-3682, 3758-3799, 3837-3853) and key.rs:
- Domain: `{name: "Farcaster KeyAdd", version: "1", chainId: 1}`.
  - `KeyAdd(uint256 fid, bytes key, uint32 keyType, uint32[] scopes, uint32 ttl, uint32 nonce, uint256 deadline)` is signed by the custody address.
  - `SignedKeyRequest(uint256 requestFid, bytes key, uint256 deadline)` uses the same domain.
  - The `KEY_ADD` message envelope itself is signed by the new ed25519 key (proof of possession).
- Limits:
  - `MAX_KEY_TTL_SECONDS = 90*24*60*60` (key.rs l.48), and `ttl == 0` is rejected (l.420).
  - `MAX_KEY_ADD_SCOPES = 16` (l.67).
  - `KEY_ADD` and `KEY_REMOVE` are never allowed as scopes.
  - Gasless signer limit per FID: 1000 (`gaslessSignerLimit`, see http_server_tests.rs l.533).
- Sliding TTL: the expiry window is refreshed on every use (docs l.3600, block_engine.rs l.1185).
- Nonce: must be strictly greater than `currentUserNonce` from `GET /v1/signersByFid` (docs l.3798-3799, 3837, 3849). The docs example uses `currentUserNonce + 1`.
- Use `makeKeyAddBody` (it calls `getGaslessSignedKeyRequestMetadata`), not `getSignedKeyRequestMetadata`, which signs the onchain variant that snapchain rejects (docs l.3766-3768, 3874).
- The deadline is in Farcaster time (docs l.3799).
- The hello-world repo still uses the old onchain flow. The docs say so themselves (l.3569-3571): https://github.com/farcasterxyz/hub-monorepo/tree/main/packages/hub-nodejs/examples/hello-world (branch URL only; SHA not recorded).
- Endpoints: `GET /v1/signersByFid` and `GET /v1/signer?fid=&signer=` exist in http_server.rs (l.1138, 3815, 4578). The response fields are `signers`, `currentUserNonce`, `gaslessSignerCount`, `gaslessSignerLimit` and `requesterFidNonces`.

**Minimum scopes.** The docs recommend a broad set (CAST_ADD/REMOVE, REACTION_ADD/REMOVE, LINK_ADD/REMOVE,
USER_DATA_ADD, VERIFICATION_*) with a 30-day TTL (l.3670-3682). This client only publishes casts, likes,
recasts and follows, so it requests just `CAST_ADD, REACTION_ADD, LINK_ADD`. Its default TTL is 7 days,
user-selectable from 1 to 90.

**Ports.** What each source says (unprotocol'd wording is quoted as-is):
| Source | Says |
|---|---|
| Docs, Getting Started (l.14) | "A public IP address with ports 3381 - 3383 exposed" (no protocol) |
| Docs, managing-a-node ports table + l.3401 | 3381/TCP HTTP, 3382/UDP gossip (QUIC), 3383/TCP gRPC; Grafana 3000 and statsd 8125/8126 local. "3381–3383 must be reachable from the internet" |
| README l.34 | "Ports 3381 - 3383 exposed on both TCP and UDP." |
| docker-compose.mainnet.yml | `http_address=0.0.0.0:3381`, `rpc_address=0.0.0.0:3383`, gossip `/ip4/0.0.0.0/udp/3382/quic-v1`; publishes 3381/tcp, 3382/udp, 3383/tcp, 8125/udp, 8126, 3000 |
| Docs, AWS guide (l.3457-3481, inbound.png) | Security group: TCP 22, 3381, **3382 (TCP)**, 3383. No UDP rule. |
| Community (as given in the task brief, not independently sourced) | "3382" |
| README l.63 | gossip port is 3382 |
- **What this repo opens (`deploy/hetzner/firewall-rules.json`):** 22/tcp, 3381/tcp, 3382/udp, 3383/tcp, plus 80/443 for the client. `PORT_PROFILE=readme` also opens the README superset. Which ports are *really* required is listed in MEASUREMENTS.md as not yet measured.

**HTTP API port.** 3381 (docs l.862, compose).

**Disk/RAM.** Docs Getting Started l.11-14: 16 GB RAM, 4 CPU cores, **2 TB** free storage. README
l.30-34: 16 GB RAM, 4 vCPU, **1.5 TB** free storage.

**Bootstrap behaviour** (read from the scripts, partly run locally):
- `snapchain-bootstrap.sh` ends with `exec ./snapchain.sh "upgrade" < /dev/tty`. Without a TTY this fails; reproduced locally.
- `upgrade` then:
  - installs Docker via get.docker.com if it is missing;
  - prompts for the no-rewards agreement (`AGREE_NO_REWARDS_FOR_ME`) and the FID (`HUB_OPERATOR_FID`);
  - sets up Grafana on 3000 with `admin:admin`;
  - installs a cron job (FID 0 without `.hub/default_id.protobuf` means "Unable to determine upgrade day" unless `SKIP_CRONTAB=true`);
  - finally runs `docker compose logs -f`, which never exits.
- No API keys are needed.

**CORS / mixed content.** http_server.rs:
- Responses get `Access-Control-Allow-Origin: *` (l.36, 42, 5398).
- There is **no OPTIONS route**.
- `submitMessage` requires `Content-Type: application/octet-stream` (l.5435, 5618-5624), which is not a CORS-safelisted type, so browsers send a preflight, and it fails.
- What this repo does: the client is served from the same origin as the API (Caddy proxies `/v1`).

**Query parsing.** `serde_qs 0.13.0`, checked by compiling a small Rust test locally:
- `reverse=1` is rejected ("provided string was not `true` or `false`"), and `reverse=true` works.
- `requesterFids=1&requesterFids=2` is rejected ("Multiple values for one key"), and `requesterFids[]=1&requesterFids[]=2` works.

## npm packages (client/package-lock.json)

| Package | Version | integrity |
|---|---|---|
| @farcaster/core | 0.20.0 | sha512-GXrT0MKStzu7bZPATPG8k8N6qMDLohvp2QZ9XkOXYIWVK9Fr9WUe86ic8EAwqeiCzYieWZU6NB7mkBq0vHY4iQ== |
| viem | 2.57.7 | sha512-x3UqqrcQuESaRVK6a0BvNmoNP0SVhu913uxEAxYLJx1lNYnj6ylTntfUdakCUKjk1+T+63gkdwFGJQ2O5C/nRw== |
| @noble/curves | 1.9.7 | sha512-gbKGcRUYIjA3/zCCNaWDciTMFI0dCkvou3TL8Zmy5Nc7sJ47a0jtOeZoTaMxkuqRo9cRhjOdZJXegxYE5FN/xw== |
| buffer | 6.0.3 | sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA== |
| @faker-js/faker (transitive, runtime dep of core) | 7.6.0 | sha512-XK6BTq1NDMo9Xqw/YkYyGjSsg44fbNwYRx7QK2CuoQgyy+f1rrTDHoExVM5PsyXCtfl2vs2vVJ0MN0yN6LppRw== |

Notes on @farcaster/core:
- It uses the global `Buffer` in `validateLinkType` (reached via `makeLinkAdd`). A browser polyfill is needed (`client/src/polyfills.ts`; test `no-buffer.test.ts`).
- It sets `dataBytes` in `makeMessage`.
- It imports faker at module load and builds factories at top level, so faker cannot be aliased out. Verified: a stub broke page load.
- The docs migrating page says "hub-web is not fully supported", so hub-web is not used.

## Hetzner Cloud

| What | Where | Pinned to |
|---|---|---|
| hcloud CLI | https://github.com/hetznercloud/cli | tag v1.70.1 = `36a27dc22eabd9d22091a9d4072119902929b401` |
| hcloud-go (JSON schema fields used: `memory`, `disk`, `linux_device`, `public_net.ipv4.ip`, `volumes`) | https://github.com/hetznercloud/hcloud-go | v2.52.0 |
| Server types | https://docs.hetzner.com/cloud/servers/overview/ | fetched 2026-10-18 |
| Volumes (10 GB-10 TB, ext4 format on create) | https://docs.hetzner.com/cloud/volumes/overview/ | fetched 2026-10-18 |
| Firewalls (no inbound rule = all inbound blocked) | https://docs.hetzner.com/cloud/firewalls/overview/ | fetched 2026-10-18 |
| API reference | https://docs.hetzner.cloud/ | fetched 2026-10-18 |
| Prices and availability | `GET https://api.hetzner.cloud/v1/pricing`, `/v1/server_types` (read-only, with the user's token) | 2026-10-18 |

Values from the read-only API calls on 2026-10-18 (currency USD, VAT 0; gross values):
- cx43 (x86, 8 vCPU / 16 GB / 160 GB): $0.0296/h, $18.49/mo. **`available: false` in fsn1, nbg1 and hel1.**
- cax31 (ARM64, 8 / 16 / 160): $0.040/h. Available in fsn1.
- cpx42: $0.1314/h. ccx23: $0.1626/h. cx53: unavailable.
- Volume: $0.0767 per GB per month. Primary IPv4: $0.001/h.

## Other

- Docker Engine apt install for Ubuntu: https://docs.docker.com/engine/install/ubuntu/ (fetched 2026-10-18).
- Docker Hub: `farcasterxyz/snapchain:latest`, the statsd image and the grafana image all publish linux/arm64 as well as linux/amd64 (manifest checked 2026-10-18).
- Caddy v2.11.7 release binary (sha512 checked against the release checksums) was used for `caddy validate` and the E2E test. Docker image `caddy:2.11` (tag checked on Docker Hub).

## Bounty-relevant citations

- Gasless app keys: https://snapchain.farcaster.xyz/guides/writing-messages, introduced by
  https://github.com/farcasterxyz/snapchain/pull/989 (merged 2026-07-30, merge commit
  `fa4ce09cd38934650ad5c7c7b3ffd3ebe96796f2`). The PR says gasless signers have been live on mainnet since V16
  (2026-05-07 22:30 IST). Its listed follow-ups are still open at `fc87f26`: the hello-world example is
  still onchain, and the HTTP reference has no `/v1/signer` or `/v1/signersByFid` page.
- Read nodes accept writes and relay them to validators:
  https://snapchain.farcaster.xyz/node-types#message-submission-and-the-mempool, added by
  https://github.com/farcasterxyz/snapchain/pull/1034 (merged 2026-10-10 04:01 IST, merge commit
  `cd3805a15e9b1a498a46dc373e10160e89d682f0`, shipped in v0.14.3 via #1039).
- Older references the bounty wants improved, all fetched 2026-10-18 and checked in DOCS_ISSUES.md:
  - https://docs.farcaster.xyz/learn/architecture/overview
  - https://docs.farcaster.xyz/developers/guides/basics/hello-world
  - https://snapchain.farcaster.xyz/guides/running-a-node
  - https://docs.neynar.com/snapchain/httpapi/httpapi.md

## Parallel re-verification (2026-10-18, 01:45-01:50 IST)

Tool: `parallel-cli` 0.9.3 (`uv tool install "parallel-web-tools[cli]"`, the method listed at
https://docs.parallel.ai/integrations/cli), authenticated via the `PARALLEL_API_KEY` env var. Basic mode only,
no deep research. Extracts used `--full-content`, and the first batch used `--max-age-seconds 600` to force a
live fetch. Raw JSON responses are kept outside the repo in `/workspace/parallel-audit-2026-10-18/`.
Usage reported by the API: 4 search requests, 65 extract URLs. The dollar balance is not visible with
env-key auth (`parallel-cli balance get` requires `parallel-cli login`).

| Call | ID | What |
|---|---|---|
| extract | `extract_929b833cc94c8e645418148b4ccdc56e` | the 11 pages behind entries 1-11 (snapchain running-a-node, getting-started, httpapi, onchain, writing-messages, node-types, managing-a-node; docs.farcaster.xyz hello-world, architecture overview; snapchain README; Neynar httpapi mirror) |
| extract | `extract_49871a59639b0c45fe888789df0288c9` | https://snapchain.farcaster.xyz/llms.txt (page list for the sweep) |
| search | `search_7e1628e772bca9f85143d1bcedce0932`, `search_9074a678acfef5681d049d6bcdf2ee61`, `search_196b191424355ae6f5ca2cc6d3c3e3d1` | docs.farcaster.xyz key/signer, hub/FID/storage, and snapchain page discovery |
| extract | `extract_bb6ebcc4077fb31f8ba013e6201fa666` | docs.farcaster.xyz create-account-key, create-account, accounts, apps, messages, signer-requests, submit-messages, writing/messages, fetch-casts, reference, developers, learn, key-gateway, architecture/contracts (404: /hubble/hubble, /learn/architecture/hubs) |
| extract | `extract_412692fb5873babe471fcf20e77bd8f3` | snapchain index, migrating, syncing-to-db, http/grpc message, events, storagelimits, info, grpcapi, validators, datatypes; Neynar getting-started, running-a-node, writing-messages; hub-monorepo README, core, hub-web, hub-nodejs README, hello-world example |
| extract | `extract_eb70c191e561d30236a5b6f56ddb34bc` | existence checks (404: hub-monorepo apps/replicator, apps/hubble; docs.farcaster.xyz/reference/hubble/httpapi/*; thehubble.xyz) + core CHANGELOG, hub-nodejs docs, hello-world index.ts |
| extract | `extract_88416ff0abfc5f65595a46e32b3fcfb4`, `extract_1d403ca4fdfe3ff97a39a6a2c0e05220` | hub-nodejs Builders.md, ViemLocalEip712Signer.md; `packages/core/src/builders.ts` (export list) |
| extract | `extract_35b3c586d92deacc59aea40884162771` | raw `main`: docker-compose.mainnet.yml, snapchain-bootstrap.sh, snapchain.sh, src/storage/db/snapshot.rs, hub-monorepo packages/core/package.json |
| extract | `extract_54452c3a0a9e159bda83993880c4d9c9` | raw `site/docs/pages/index.mdx` |
| search | `search_6c77daa4d13c007ae62d26e7edea7874` | storage unit limits (found protocol discussion #229, caststorage.com) |

The `main` files above were fetched by branch, not by SHA. They matched the facts recorded earlier for
`fc87f26` on every line checked (compose ports, bootstrap `< /dev/tty`, snapchain.sh l.400/441, snapshot.rs
l.361/428).
