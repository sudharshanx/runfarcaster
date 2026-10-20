# Vouching for this tutorial

Thank you for testing. If you ran the 3 steps, please vouch for the tutorial publicly on Farcaster. Report failures as well as successes.

## Before you start

- Use **your own** Hetzner account and machine. It costs money: $0.164/h by our estimate from the price list, and $2.31 to reach sync in our run (14 h 06 m).
- Use a **test** Farcaster account if you try posting. Never share your recovery phrase, Hetzner token, IP address or SSH keys with anyone, including in your cast.

## Checklist

- [ ] Commit tested: `git rev-parse --short HEAD`: ________
- [ ] Followed the Quickstart on the site (link: ________)
- [ ] `provision.sh` finished. Server type ______, volume ______ GB, time ______
- [ ] `node.sh` reported `sync: SYNCED`. Provision to synced: ______ h ______ m
- [ ] `deploy-client.sh` printed `OK:` and the client loads the feed from my node
- [ ] Optional, test account only: app key added (`KEY_ADD`): yes / no / failed
- [ ] Optional: cast posted from the  client: cast hash ________, visible in another client: yes / no
- [ ] Optional: follow / like worked: yes / no
- [ ] `teardown.sh` finished and the Hetzner console shows nothing left: yes / no
- [ ] Cost shown by Hetzner: ______
- [ ] What broke or confused me: ________

## The vouch cast

Post publicly on Farcaster. Suggested content (edit freely, write it in your own words):

> I ran <tutorial URL> on my own Hetzner account (commit <hash>). Provision to synced in <time>, cost about <amount>. Client loaded the feed from my node. Cast from it: <yes/no, hash>. Teardown: <ok/not ok>. Problems: <...>.

Then send the cast link to the author so it can be listed in the Vouches section of the Receipts page.
