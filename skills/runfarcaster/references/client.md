# Step 3: open the app

Needs Node.js 22.12+ (22.x), 24.x or 26+ on the user's computer.

```bash
./deploy-client.sh "$IP"
```

A DNS name of the user's that points at `$IP` can go as the 2nd argument. Without it the script uses `<ip-with-dashes>.sslip.io`.

Expected last line: `[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)`. About 35 s for us with a warm npm cache.

The user then opens the address. The status line should start with `Connected. version`.

If it fails: ports 80 and 443 must be open (`provision.sh` opens them). Look at:

```bash
ssh root@$IP 'cd /opt/snapchain-client && docker compose logs caddy'
```

For a specific SSH key: `SSH_OPTS="-i <keyfile>" ./deploy-client.sh "$IP"`.

If the user started the watchdog in step 1, remind them that it deletes the node 24 h after step 1. To keep it: `touch .provision-state/watchdog.disarm`.

## Posting: add an app key (not tested on mainnet)

Adding an app key and casting have run only in unit tests and against a local mock node. Say so. Suggest a test account.

The user adds the key in a copy of the app on their own computer, not on the HTTPS address. A page from `localhost` comes from files on their own disk. The sslip.io address depends on a DNS service someone else runs.

Terminal 1, the tunnel (leave it running):

```bash
IP=$(hcloud server ip snapchain-read-node)
ssh -N -L 3381:127.0.0.1:3381 root@$IP
```

Terminal 2, the app:

```bash
cd client
npm ci --ignore-scripts
npm run dev
```

The user opens http://localhost:5317. The status line should start with `Connected.`

Then the user, not you:

1. Goes to **Signer (app key)** and picks how long the key lasts: 1, 7, 30 or 90 days.
2. Types the test account's recovery phrase into that page and presses **Sign one KEY_ADD, then forget the phrase**.
3. Sees `App key for FID <n>: 0x… (waiting for the node to show it)`, which changes to `(active)`.

Never ask for the phrase, and never offer to type or paste it for them.

Check it from the terminal:

```bash
curl -s "http://127.0.0.1:3381/v1/signersByFid?fid=<your-fid>" | jq '.currentUserNonce, [.signers[] | .source]'
```

`currentUserNonce` should be one higher than before, with one more signer in the list.

## Cast, follow, like

Post from the local app. Each message shows a state in **Outgoing messages**:

| State | Meaning |
|---|---|
| `[sending]` | The app is sending it to the node |
| `[relayed]` | The node accepted it and sent it on |
| `[retrying]` | Not seen yet, so the app sent it again |
| `[confirmed]` | The node returns it |
| `[failed]` | Still missing after 4 sends, or the node rejected it |

The app can only add. It cannot delete a cast, unfollow or unlike.

When done, the user presses **Forget app key**, then stops the tunnel and the dev server with Ctrl-C.
