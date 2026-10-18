# Step 3: open the app

Needs Node.js 22.12+ (22.x), 24.x or 26+ on the user's computer.

```bash
./deploy-client.sh "$IP"
```

A DNS name of the user's that points at `$IP` can go as the 2nd argument. Without it the script uses `<ip-with-dashes>.sslip.io`.

Expected last line: `[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)`. Under a minute with a warm npm cache.

The user then opens the address. The status at the top should say **Connected to your node**.

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

The user opens http://localhost:5317. The status at the top should say **Connected to your node**.

Then the user, not you:

1. Presses **Add app key**. A dialog has 4 steps: About, Before you start, Sign, Done.
2. On **Sign**, types the test account's recovery phrase into that page, picks **Key expires after** (1, 7, 30 or 90 days) and presses **Add app key**.
3. Sees **Done**. In **Settings**, the **App key** card shows **Waiting for your node**, then **Active**.

Never ask for the phrase, and never offer to type or paste it for them.

Check it from the terminal:

```bash
curl -s "http://127.0.0.1:3381/v1/signersByFid?fid=<your-fid>" | jq '.currentUserNonce, [.signers[] | .source]'
```

`currentUserNonce` should be one higher than before, with one more signer in the list.

## Cast, follow, like

Post from the local app. Each message shows a state under **Settings**, **Sent**:

| State | Meaning |
|---|---|
| **Sending** | The app is sending it to the node |
| **Waiting for a block** | The node accepted it and sent it on |
| **Retrying** | Not seen yet, so the app sent it again |
| **Confirmed** | The node returns it |
| **Failed** | Still missing after 4 sends, or the node rejected it |

The app can only add. It cannot delete a cast, unfollow or unlike.

When done, the user presses **Remove from this browser**, then stops the tunnel and the dev server with Ctrl-C.
