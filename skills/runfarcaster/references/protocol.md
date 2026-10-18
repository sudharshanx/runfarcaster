# Farcaster and Snapchain, short

| Word | What it means here |
|---|---|
| FID | The user's Farcaster account number, registered on OP Mainnet. |
| Custody address | The Ethereum address that owns an FID. It approves and cancels app keys. |
| App key (signer) | An ed25519 key an app uses to post for an FID, only for its scopes and until it expires. It cannot move money. |
| KEY_ADD | A message that approves a new app key. The custody address signs it (EIP-712). It needs no transaction on OP Mainnet, so it costs no gas. Mainnet has accepted it since engine version V16 on 2026-05-07. |
| KEY_REMOVE | A message that cancels an app key. The RunFarcaster app does not send it. |
| Snapchain | The network that puts Farcaster messages in order and stores them, split into shards. |
| Shard | Shard 0 holds network-wide data, including gasless `KEY_ADD` messages. Shards 1 and 2 split the accounts. |
| Validator | A Snapchain node that makes blocks and votes on them. |
| Read node | A node that copies finished blocks from its peers, answers the API and sends on messages it receives. It has no mempool and earns nothing. |
| blockDelay | How many seconds a shard's newest block is behind the clock. Single digits on every shard means synced. |
| Snapshot | A compressed copy of the database that a new node downloads first. |

## Sending a message through a read node

A read node takes `submitMessage` and publishes the message to the validators. It keeps no mempool, so HTTP 200 means sent on, not in a block. Ask the node for the message afterwards, and send it again if it does not show up.

## Ports

- 3381/tcp HTTP API and 3383/tcp gRPC: closed to the internet by default.
- 3382/udp gossip: open.
- 3000 (Grafana): keep it closed.

## Sources

- https://snapchain.farcaster.xyz/node-types
- https://snapchain.farcaster.xyz/guides/writing-messages
- https://snapchain.farcaster.xyz/reference/httpapi/httpapi
- https://sudharshanx.github.io/runfarcaster/glossary/
