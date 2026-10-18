# Step 2: start the node

```bash
ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
```

Use `$IP` from step 1. Only in a new terminal: `IP=$(hcloud server ip "$NAME")`.

`SNAPCHAIN_AGREE_NO_REWARDS=yes` says the user accepts that a read node earns no rewards. Show the user that before step 2, so they agree knowingly.

If SSH says `Connection refused` right after step 1, the server is still booting. Wait a minute and run it again.

## What node.sh does

- Installs Docker.
- On disks under 1500 GB, installs two helpers: `snapshot-space-saver.sh` deletes snapshot chunks the node has already read, and `disk-guard.sh` stops the node at 90% full.
- Runs the official Snapchain bootstrap.
- Waits up to 24 h for the sync.

Expected output: `[node.sh] Data disk ... arming disk-guard and snapshot-space-saver.`, then `[node.sh] ... SYNCING shard 0: height=... blockDelay=...` lines, then `[node.sh] Node is in sync.` and a health check with `sync: SYNCED`.

## Sync expectations (cax31: 8 cores, 16 GB RAM, 1000 GB volume)

- Loading the snapshot takes about 8 to 9 hours. The HTTP API does not answer during that time. That is normal.
- Catching up takes about 5 more hours, so about 14 hours from renting the server to synced. A faster disk or network shortens both. Times on other server types vary.
- Expect the volume to peak at about 700 GB (75% full) while the snapshot loads, and the database to be about 560 GB once synced.
- Expect about 2.5 GB of memory in use once synced.

The automatic install in `node.sh` has unit tests but has not run during a real sync yet.

## Check progress

Port 3381 is closed to the internet, so check over SSH:

```bash
ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'
```

Synced means every `blockDelay` is in single digits.

While the snapshot loads, check the disk instead. The used space should keep growing:

```bash
ssh root@$IP df -h /root/snapchain
```

## If SSH drops

The node keeps going on the server. Continue waiting with:

```bash
ssh root@$IP 'bash -s wait' < node.sh
```

## Peer warnings

Repeated `InsufficientPeers` warnings that mention `read-node-peers` are fine while `blockDelay` stays in single digits. If `blockDelay` keeps growing, tell the user: the validators may have stopped making blocks.
