# Security

This is a developer tutorial. Treat seed phrases the way a Unix tutorial treats `rm -rf`.

## Seed phrases

- **Only paste a seed phrase into software from developers you trust**, after reading the code. It controls the whole Farcaster account and any funds in that wallet.
- **Use a test account** when trying this tutorial.
- **Prefer a delegated signer**: approve an app key from the wallet or app that already holds your custody key, so the phrase never leaves it.
- **Never paste a seed phrase into an AI assistant**, chat, issue or screenshot.

What the client does if you paste a phrase (`client/src/signer.ts`):

1. Generates a new ed25519 app key in the browser (`crypto.getRandomValues` via `@noble/curves`).
2. Derives the custody account locally (`m/44'/60'/0'/0/0`) and signs exactly two EIP-712 payloads through `makeKeyAddBody`: the gasless `SignedKeyRequest` and the `KeyAdd` authorisation (key, scopes, TTL, nonce, deadline).
3. Clears the input field and drops its references to the phrase and the derived account. The phrase is never stored, logged or sent. Only the signed `KEY_ADD` message goes to your node.

JavaScript cannot guarantee memory is wiped (strings are immutable and garbage-collected). Use a trusted device.

## The app key

| Can | Cannot |
|---|---|
| Sign `CAST_ADD`, `REACTION_ADD`, `LINK_ADD` for your FID | Move funds or sign transactions |
| Work until its TTL ends (default 7 days, max 90, sliding on use) | Remove casts, unfollow, edit your profile, add or remove keys |
| | Survive revocation by your custody address |

It is stored in the browser's `localStorage` (`appKey.v1`). Anyone with access to that browser profile can use it until it expires or is revoked. "Forget app key" deletes it locally; it does not revoke it onchain.

## What is stored where

| Item | Where | Notes |
|---|---|---|
| Seed phrase | Nowhere | Used once in memory |
| App key (private) | Browser `localStorage` | Delete with "Forget app key" |
| Filters, settings, outgoing messages | Browser `localStorage` | `filters.v1`, `settings.v1`, `pending.v1` |
| `HCLOUD_TOKEN` | Your shell environment | Scripts never print it (`set +x`) |
| SSH private key | Your machine | Only the public key is uploaded to Hetzner |

## Server

- The Hetzner firewall opens 22/tcp, 80/tcp, 443/tcp, 3381/tcp, 3382/udp, 3383/tcp. Narrow SSH with `SSH_SOURCE_CIDRS`.
- Grafana (3000, default `admin:admin`) and statsd (8125/8126) are published by the official compose file on all interfaces but are **not** opened in the firewall. Keep it that way; Docker-published ports bypass `ufw`.
- Caddy serves the client with `Content-Security-Policy: ... connect-src 'self'`, HSTS, `nosniff`, and blocks `/v1/mesh`.

## Known issues

- `@farcaster/core` 0.20.0 ships `@faker-js/faker` as a runtime dependency (GHSA-qxc2-j82w-r537). The client never calls the affected code path, but it is in the bundle.
- The Vite build warns about a direct `eval` in protobufjs. The CSP blocks `eval`; the browser tests show no CSP violations.

## Reporting a problem

Open a GitHub issue for non-sensitive problems. For anything that could put users' keys at risk, contact the maintainer privately first.
<!-- AUTHOR: add a private contact (email or Farcaster DM handle). -->
