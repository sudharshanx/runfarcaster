# Measurements

No node has been run yet. Every value below is **NOT YET MEASURED**. Fill them in from a real run of
`provision.sh` → `node.sh` → `deploy-client.sh` → `teardown.sh`.

| Field | Value | How to measure |
|---|---|---|
| Disk used after sync | NOT YET MEASURED | `du -sh ~/snapchain/.rocks` and `df -h /root/snapchain` after `node.sh wait` succeeds |
| Time to sync | NOT YET MEASURED | node.sh prints start time and "in sync" time; snapshot vs block catch-up split from `docker compose logs` |
| RAM use (steady / peak) | NOT YET MEASURED | `docker stats --no-stream`; peak from Grafana (tunnel: `ssh -L 3000:127.0.0.1:3000`) |
| Ports truly required | NOT YET MEASURED | start with the docs profile (3381/tcp, 3382/udp, 3383/tcp); check peers in `/v1/info` and logs; then remove one rule at a time |
| Cost per hour (actual) | NOT YET MEASURED | Hetzner console usage after teardown |
| Server type actually used | NOT YET MEASURED | |
| Submit → visible on read node latency | NOT YET MEASURED | client pending panel timestamps (relayed → confirmed) |

Test account for a future live run: FID <TEST_FID> (@<TEST_USERNAME>), custody <TEST_CUSTODY_ADDRESS>. Checked onchain with a read-only call, see `e2e/test-account.example.env`.

## Disk choice for the first live run (2026-10-18)

- **Quota:** the Hetzner account's volume quota is **1024 GB in total**, the default for new accounts, which cannot ask for an increase yet. A 2000 GB create failed with `volumes size limit exceeded`.
- **What we used:** the run uses **cax31 + a 1000 GB volume** (`VOLUME_GB=1000`). That is below the documented 1.5 TB (README) and 2 TB (docs site), so it is an **experiment**. The supporting evidence is one synced-DB example in the docs at about 549 GB, and a snapshot of 5689 chunks of about 91 MB (≈520 GB compressed) according to the node's own log.
- **Safety net:** `disk-guard.sh` stops the node at 90% full rather than letting RocksDB hit ENOSPC.
- **Cost:** estimated 0.040 + 0.001 + 1000 × 0.0767 / 624.7 ≈ **$0.164/h**, about $2.62 for 16 h. This is an estimate from the price list.
- Measured results go in the table above when the run finishes.

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
