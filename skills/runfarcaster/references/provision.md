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
ESTIMATE_ONLY=1 SERVER_TYPE="" VOLUME_GB=1000 ./provision.sh
```

It prints the type it would pick. With cpx42 and the 1000 GB volume it is about $0.255 an hour (cax31: about $0.164). cpx42 has not been tested.

## Rent the server

Ask first. Then run (add `LOCATION=<location>` if the user picked one):

```bash
IP=$(SSH_KEY=<key-name> SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
```

Expected: `[provision] cost guard OK`, then `[provision] WATCHDOG=0: no watchdog started`, then a `[provision] done. Next` line on stderr, and the IPv4 address on stdout. It takes under a minute.

Tell the user: the server keeps running, and Hetzner bills it by the hour, until they delete it with `teardown.sh`.

## Server type and location

- The guide has been tested on `cax31` (ARM64, 8 vCPU, 16 GB RAM) only. Times on other types vary.
- `SERVER_TYPE=""` rents the first type for sale in `LOCATION` from cx43, cax31, cpx42 and ccx23 (16 GB RAM or more), logging `skipping …` for sold-out ones. If none is for sale, it stops with `none of [...] is usable in fsn1.` and lists the types available there, cheapest first. A type set by hand that is sold out gives `server type cax31: not available in fsn1 right now.` Show the user the list and ask which `SERVER_TYPE`, and which `LOCATION` if they want another place.
- Locations: `fsn1`, `nbg1`, `hel1`, `ash`, `hil`, `sin`. A typo gives `unknown LOCATION=…` and the list of valid names.

## WATCHDOG=0 and the trial option

`WATCHDOG=0` is the default in the guide: no watchdog runs, and the server stays until the user deletes it.

If the user only wants a trial run, leave out `WATCHDOG=0` and add `MAX_USD=5 EXPECTED_HOURS=16`. Then `provision.sh` starts `watchdog.sh`, which deletes everything after 24 h, when the bill would pass `MAX_USD`, or after 2 h without progress.

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
