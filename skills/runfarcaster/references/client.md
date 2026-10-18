# Step 3: open the app

Needs Node.js 22.12+ (22.x), 24.x or 26+ on the user's computer.

```bash
./deploy-client.sh "$IP"
```

A DNS name of the user's that points at `$IP` can go as the 2nd argument. Without it the script uses `<ip-with-dashes>.sslip.io`.

Expected last line: `[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)`. Under a minute with a warm npm cache. It can run while the node is still loading its snapshot: then it ends with `[deploy-client] OK: app is up at https://<name>. The node isn't answering yet`, and the app shows **Node still starting** until the node answers.

The user then opens the address. The status at the top should say **Connected to your node**.

If it fails: ports 80 and 443 must be open (`provision.sh` opens them). Look at:

```bash
ssh root@$IP 'cd /opt/snapchain-client && docker compose logs caddy'
```

For a specific SSH key: `SSH_OPTS="-i <keyfile>" ./deploy-client.sh "$IP"`.

If the user started the watchdog in step 1, remind them that it deletes the node 24 h after step 1. To keep it: `touch .provision-state/watchdog.disarm`.

## Posting: add an app key

Adding an app key and posting a cast have been tested on mainnet once. Likes, recasts and follows have been tested against a mock node only. Say so. Suggest a test account and a 1-day key.

The user adds the key in a copy of the app on their own computer, not on the HTTPS address. A page from `localhost` comes from files on their own disk. The sslip.io address depends on a DNS service someone else runs. The dev server passes `/v1` on to the node's HTTPS address, so no SSH tunnel is needed:

```bash
cd client
npm ci --ignore-scripts
SNAPCHAIN_NODE_URL=https://<name> npm run dev
```

`<name>` is the address `deploy-client.sh` printed. The user opens http://localhost:5317. The status at the top should say **Connected to your node**. The address bar must show exactly `localhost:5317`, and the dialog must not show a **Check the address.** box.

Then the user, not you:

1. Presses **Add app key**. The dialog has 4 steps: **What an app key is** (Next), **Before you start** (I understand, continue), **Sign and send**, **App key added**.
2. On **Sign and send**, types the test account's recovery phrase under **Recovery phrase**, picks **1 day** under **Key expires after** and presses **Add app key**. It shows **Signed for FID** with their FID.
3. Waits until the **App key** card shows **Active** (it shows **Waiting for your node** first). A cast sent before that fails.
4. Posts from the post box with **Post**. The cast shows **Sending**, **Waiting for a block**, then **Confirmed**.

This app cannot revoke keys. A gasless key is cancelled with a `KEY_REMOVE` signed by the custody address; KeyRegistry remove does not apply.

Never ask for the phrase, and never offer to type or paste it for them.

Check it from the terminal:

```bash
curl -s "https://<name>/v1/signersByFid?fid=<your-fid>" | jq '.currentUserNonce, [.signers[] | .source]'
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

When done, the user presses **Remove from this browser**, then stops the dev server with Ctrl-C.
