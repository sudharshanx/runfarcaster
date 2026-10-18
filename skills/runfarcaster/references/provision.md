# Step 1: rent a server

`provision.sh` creates one Hetzner server named `snapchain-read-node`, a volume `snapchain-read-node-data` and a firewall `snapchain-read-node-fw`. It prints the server's IPv4 address on stdout.

## Before you run it

1. Check the tools: `hcloud version`, `jq --version`, `ssh -V`, `curl --version`.
2. Check the token without printing it: `[ -n "$HCLOUD_TOKEN" ] && echo set`.
3. Run `hcloud ssh-key list` and ask the user which key name to use.
4. Get the user's public IP and show it. If it is empty, stop.

```bash
MY_IP=$(curl -4 -s https://ifconfig.me)
echo "$MY_IP"
```

## Show the price first

This creates nothing:

```bash
ESTIMATE_ONLY=1 SERVER_TYPE=cax31 VOLUME_GB=1000 ./provision.sh
```

It was about $0.164 an hour for us.

## Rent the server

Ask first. Then run (add `LOCATION=<location>` if the user picked one):

```bash
IP=$(SSH_KEY=<key-name> SERVER_TYPE=cax31 VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
```

Expected: `[provision] cost guard OK`, then `[provision] WATCHDOG=0: no watchdog started`, then a `[provision] done. Next` line on stderr, and the IPv4 address on stdout. It took 35 s for us.

Tell the user: the server keeps running, and Hetzner bills it by the hour, until they delete it with `teardown.sh`.

## Server type and location

- We have only run the node on `cax31` (ARM64, 8 vCPU, 16 GB RAM).
- Hetzner sells out of server types. If the type is sold out, `provision.sh` stops with `server type cax31: not available in fsn1 right now.` and lists the types available there, cheapest first. Show the user that list and ask which `SERVER_TYPE`, and which `LOCATION` if they want another place.
- Locations: `fsn1`, `nbg1`, `hel1`, `ash`, `hil`, `sin`. A typo gives `unknown LOCATION=…` and the list of valid names.

## WATCHDOG=0 and the trial option

`WATCHDOG=0` is the default in the guide: no watchdog runs, and the server stays until the user deletes it.

If the user only wants to try it, leave out `WATCHDOG=0` and add `MAX_USD=5 EXPECTED_HOURS=16` (how we ran it). Then `provision.sh` starts `watchdog.sh`, which deletes everything after 24 h, when the bill would pass `MAX_USD`, or after 2 h without progress.

- To keep the node after all: `touch .provision-state/watchdog.disarm`
- Its log: `.provision-state/watchdog.log`

## Delete everything

Ask first. Then:

```bash
CONFIRM=snapchain-read-node ./teardown.sh
```

Expected: it deletes the server, the volume and the firewall, and ends with `[teardown] verified: server, volume(s) and firewall are gone.` Running it twice is safe. It keeps the uploaded SSH key.

Then check that nothing named `snapchain-read-node` is left:

```bash
hcloud server list
hcloud volume list
hcloud firewall list
hcloud primary-ip list
```
