# Security

This is a guide for developers. A recovery phrase deserves the care you give `rm -rf /`.

## The recovery phrase

- It controls the whole Farcaster account and anything else in that wallet. Use a test account for this guide.
- Only type it into code you have read, on your own computer. For the key step, run the app on `localhost`
  (`ssh -N -L 3381:127.0.0.1:3381 root@$IP`, then `cd client && npm ci --ignore-scripts && npm run dev`, then
  http://localhost:5317). A page served from `<ip>.sslip.io` depends on DNS that someone else runs; the app shows
  a warning there.
- Type it rather than paste it. If you paste, clear the clipboard afterwards: clipboard history and sync tools can
  keep a copy, and the app cannot clear it.
- If the wallet or app that holds your custody key can approve an app key itself, use that. Then the phrase stays put.
- Keep it out of AI assistants, chats, issues and screenshots.

What the app does with the phrase (`client/src/signer.ts`):

1. Makes a new ed25519 app key in the browser (`crypto.getRandomValues` via `@noble/curves`).
2. Derives the custody account on your computer (`m/44'/60'/0'/0/0`) and signs exactly two EIP-712 payloads with
   `makeKeyAddBody`: the gasless `SignedKeyRequest` and the `KeyAdd` approval (key, scopes, lifetime, nonce, deadline).
3. Empties the input field and drops its references to the phrase and the derived account. Nothing stores, logs or
   sends the phrase. Only the signed `KEY_ADD` goes to your node.

In JavaScript a string stays in memory until the garbage collector frees it, and code cannot force that. That is another reason to use your own computer.

## The app key

| Can | Cannot |
|---|---|
| Sign `CAST_ADD`, `REACTION_ADD`, `LINK_ADD` for your FID | Move money or sign transactions |
| Keep working for its lifetime (7 days by default, 90 at most, renewed on each use) | Delete casts, unfollow, edit your profile, approve or cancel keys |
| | Keep working after your custody address cancels it |

The app saves it in the page's `localStorage` (`appKey.v1`). Anyone who can use that browser profile can post with it
until the lifetime runs out or the custody address cancels it. "Remove from this browser" deletes the local copy only.

`localStorage` belongs to one address and port. The dev server uses port 5317 with `strictPort`, not Vite's default
5173, so other Vite projects on your computer do not share this storage. Press "Remove from this browser" when you finish on
`localhost` anyway.

`client/index.html` gets a Content-Security-Policy `<meta>` from `client/vite.config.ts`. The build gets the same
policy as the Caddy header (without `frame-ancestors`, which a meta tag cannot set). The dev server also allows
inline styles and its own WebSocket on port 5317, which Vite needs. Either way the page can only connect to its own
address.

## What is stored where

| Item | Where | Notes |
|---|---|---|
| Recovery phrase | Nowhere | Used once in memory |
| App key (private) | Browser `localStorage` | Delete with "Remove from this browser" |
| Filters, settings, outgoing messages | Browser `localStorage` | `filters.v1`, `settings.v1`, `pending.v1` |
| `HCLOUD_TOKEN` | Your shell environment | Scripts never print it (`set +x`) |
| SSH private key | Your computer | Only the public key is uploaded to Hetzner |

## Server

- The Hetzner firewall opens 22/tcp (limit it with `SSH_SOURCE_CIDRS`), 80/tcp, 443/tcp and 3382/udp. The node's API ports 3381/tcp and 3383/tcp stay closed unless you set `NODE_API_CIDRS`; Caddy reaches the node on 127.0.0.1.
- Grafana (3000, default `admin:admin`) and statsd (8125/8126) are published by the official compose file on all interfaces but are **not** opened in the firewall. Keep it that way; Docker-published ports bypass `ufw`.
- Caddy serves the client with `Content-Security-Policy: ... connect-src 'self'`, HSTS, `nosniff`, and blocks `/v1/mesh` (the mesh debug view).
  `/v1/currentPeers` stays public: it lists the connected peers (mainnet validators) and their addresses.

## Known issues

- `@farcaster/core` 0.20.0 ships `@faker-js/faker` as a runtime dependency (GHSA-qxc2-j82w-r537). The client never calls the affected code path, but it is in the bundle.
- The Vite build warns about a direct `eval` in protobufjs. The CSP blocks `eval`; the browser tests show no CSP violations.

## Reporting a problem

Open a GitHub issue for non-sensitive problems. For anything that could put users' keys at risk, contact the maintainer privately first.
<!-- AUTHOR: add a private contact (email or Farcaster DM handle). -->
