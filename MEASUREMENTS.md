# Measurements

Measured on the **first live run**, 2026-10-18 (all times IST, UTC+5:30). Hetzner **cax31** (ARM64, 8 vCPU,
16 GB RAM, fsn1) + **1000 GB volume** + firewall `snapchain-read-node-fw`; snapchain **v0.14.3**
(`farcasterxyz/snapchain:latest`), mainnet. Raw log: `run-log.md`. Anything marked **unmeasured** was not measured.

## Timeline

| Phase | Value | Notes |
|---|---|---|
| Provision (`provision.sh`) | **35 s** | server + volume + firewall, started 01:26:33 |
| Snapshot download | **≈5 h 24 m** for ≈520 GB (5689 chunks), ≈**27 MB/s** avg | shard 1 01:37–04:11, shard 2 05:34–08:24 (download, gunzip, untar are sequential per shard) |
| Snapshot restore, total wall time | **≈8 h 34 m** | download start ≈01:37 → node process start 10:11:13 |
| Block catch-up after restore | **≈5 h 15 m** at **4.3–4.6 blocks/s per shard** (net) | node start 10:11 → all shards at tip ≈15:32 (shard 1 first, ≈14:32) |
| **Provision → fully synced** | **≈14 h 06 m** | 01:26:33 → ≈15:32; "synced" = every shard blockDelay < 10 |

## Resources at sync (15:32–16:16)

| Field | Value | How measured |
|---|---|---|
| DB size | **557.86 GB** (`dbStats.approxSize`); `du .rocks` = 556G: shard-0 37G, shard-1 261G, shard-2 259G, global 4.2M | `/v1/info`, `du -sh` |
| Messages / FIDs | **914,243,963** messages (914,244,196 at 16:04), **3,355,148** FID registrations | `/v1/info` dbStats |
| Disk used after sync | **557G used / 378G free (60%) of 984G** | `df -h /root/snapchain` |
| Peak disk during restore | **699G (75%)** at 09:37 (shard 2 tar + shard 1 DB + partial shard 2 DB) | `df`, 10-min logger; ≈5-min resolution, true peak could be slightly higher |
| RAM, host | **2.4–2.6 GiB used** (+≈13 GiB page cache, 12.7 GiB available) | `free -m`, 16:01–16:16 |
| RAM, containers | snapchain **1.53 GiB**, statsd 264 MiB, grafana 68 MiB, caddy 12 MiB | `docker stats --no-stream` 16:01 |
| RAM, snapchain cgroup peak | **5.94 GB** `memory.peak` since 10:11 (cgroup peak includes page cache, so an upper bound) | `/sys/fs/cgroup/.../memory.peak`; Grafana peak **unmeasured** |
| CPU / load | snapchain ≈1.3% CPU at tip; load avg **≈0.7–1.5** on 8 vCPU throughout catch-up and at tip | `docker stats`, `/proc/loadavg` |
| RAM during snapshot download | ≈0.8–0.9 GiB used | progress logger |

## Network and ports

| Field | Value |
|---|---|
| Listening on VM | 3381/tcp (HTTP), 3383/tcp (gRPC), 3382/udp (gossip QUIC), 22/tcp; also 3000/tcp grafana, 8126/tcp + 8125/udp statsd bound to 0.0.0.0 but **not** opened in the Hetzner firewall (verified filtered from outside) |
| 3381/tcp from outside | reachable: `/v1/info` 200 in ≈0.2–0.9 s from the box |
| 3383/tcp from outside | reachable: gRPC `HubService/GetInfo` → grpc-status 0 |
| Peers | **5 connected, all mainnet validators** (`/v1/mesh`, node-local); 3 of them in our `mempool` mesh |
| `InsufficientPeers ("read-node-peers")` | ≈**18/min** (540 in 30 min, 6364 in 6 h). No connected peer subscribes to the `read-node-peers` topic, so publishes on it fail; sync is unaffected. Two bootstrap peers (34.195.157.114, 44.197.255.20) fail with QUIC `HandshakeTimedOut` every 30 s. |
| Ports truly required | **Partly measured.** Removing inbound 3382/udp for 2 min (16:07–16:09) changed nothing: peers 5/5, blockDelay 0–2 (stateful firewall, node dials out). Long-term effect of no inbound 3382/udp (discovery, new peers) **unmeasured**. 3381/3383 are only needed if clients outside the VM read from the node; the web client goes through Caddy on 443. Rule restored. |

## Cost

| Field | Value |
|---|---|
| Server type actually used | **cax31** (cx43 unavailable) + 1000 GB volume + primary IPv4 |
| Cost per hour | **≈$0.164/h** estimate from the price list (cax31 $0.040 + IPv4 $0.001 + 1000 GB volume ≈$0.123); actual Hetzner invoice **unmeasured** |
| Spend so far | ≈**$2.43** of the $5 cap at 16:16 (watchdog estimate, ≈14 h 50 m since provision) |
| Cost to reach sync | ≈$2.31 (provision → 15:32) |

## Client

| Field | Value |
|---|---|
| HTTPS deploy (`deploy-client.sh`) | ≈35 s incl. caddy image pull; Let's Encrypt cert (http-01) issued 16:10:46 for `<SERVER_IP_DASHED>.sslip.io` |
| Read latency through Caddy | ≈0.2 s per `/v1/*` read from the box |
| Submit → visible on read node latency | **unmeasured** (no valid mainnet write was made on purpose; the only write was an invalid submit, rejected with HTTP 400) |

Test account for a future live run: FID <TEST_FID> (@<TEST_USERNAME>), custody <TEST_CUSTODY_ADDRESS>. Checked onchain with a read-only call, see `e2e/test-account.example.env`.

## Disk choice for the first live run (2026-10-18)

- **Quota:** the Hetzner account's volume quota is **1024 GB in total**, the default for new accounts, which cannot ask for an increase yet. A 2000 GB create failed with `volumes size limit exceeded`.
- **What we used:** the run uses **cax31 + a 1000 GB volume** (`VOLUME_GB=1000`). That is below the documented 1.5 TB (README) and 2 TB (docs site), so it is an **experiment**. The supporting evidence is one synced-DB example in the docs at about 549 GB, and a snapshot of 5689 chunks of about 91 MB (≈520 GB compressed) according to the node's own log.
- **Safety net:** `disk-guard.sh` stops the node at 90% full rather than letting RocksDB hit ENOSPC.
- **Cost:** estimated 0.040 + 0.001 + 1000 × 0.0767 / 624.7 ≈ **$0.164/h**, about $2.62 for 16 h. This is an estimate from the price list.
- Result: it fit. 557 GB DB, peak 699G (75%) during restore, 60% after sync; the guard never fired.

## ESTIMATE (from the price list, not a measurement)

Source: read-only `GET https://api.hetzner.cloud/v1/pricing` and `/v1/server_types`, 2026-10-18, gross USD, VAT 0.

**Disk decision.** The docs say 2 TB (README: 1.5 TB). Every ≥16 GB type considered has 160 GB local disk (cx43, cax31) or 320 GB (cpx42). That is far short, so **a 2000 GB volume is required**. The cost guard has to include it.

| Item | Price | Hourly (est.) |
|---|---|---|
| cx43 (8 vCPU/16 GB/160 GB, x86) | $0.0296/h, $18.49/mo, **reported `available:false` in fsn1/nbg1/hel1** | 0.0296 |
| cax31 (8/16/160, ARM64), available in fsn1 | $0.040/h | 0.040 |
| cpx42 (8/16/320) | $0.1314/h | 0.1314 |
| Primary IPv4 | $0.001/h | 0.001 |
| Volume 2000 GB | $0.0767/GB/mo = **$153.40/mo** | **≈0.2455** |
| Volume 1500 GB (README figure; not verified as enough) | $115.05/mo | ≈0.184 |

The volume hourly figure is the monthly price divided by the server's monthly/hourly ratio (≈624.7 h). Hetzner prices volumes monthly with hourly billing. This conversion is an assumption.

| Configuration | $/h (est.) | 6 h run (est.) | Under the $2 guard? |
|---|---|---|---|
| cx43 + 2000 GB (if it becomes available) | ≈0.276 | ≈1.66 | yes |
| **cax31 + 2000 GB** (what auto-pick chooses today) | ≈0.2865 | ≈1.72 | yes |
| cax31 + 1500 GB | ≈0.225 | ≈1.35 | yes |
| cpx42 + 2000 GB | ≈0.3782 | ≈2.27 | **no, refused** |

These are `provision.sh` outputs with `ESTIMATE_ONLY=1`, which creates nothing, except the cx43 row, which was worked out by hand because the script refuses an unavailable type.

**The budget depends on sync time, which is not known.** At ≈$0.29/h, $2 buys about 7 hours. The README says the snapshot "can take up to 2 hours", and the docs site says "a few hours" and "several hundred gigabytes". A 200-300 MB/s volume may well be slower than that. `EXPECTED_HOURS=6` is an assumption. Run `teardown.sh` as soon as the measurements are taken.
