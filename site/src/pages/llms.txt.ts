import type { APIRoute } from "astro";
import { pages } from "../llms";
import { REPO } from "../prompts";

export const GET: APIRoute = async ({ site }) => {
  const base = new URL(import.meta.env.BASE_URL, site).href.replace(/\/?$/, "/");
  const list = (await pages()).map((e) => `- [${e.data.title}](${base}${e.id === "index" ? "" : `${e.id}/`}): ${e.data.description ?? ""}`).join("\n");
  const body = `# Run a Farcaster Snapchain read node and client in 3 steps

> Rent a Hetzner server. Start a Snapchain read node on it with the official bootstrap. Open a small web app served from the same server over HTTPS. You need no API keys. From one mainnet run on 2026-10-18: 14 h 06 m from renting the server to synced, about $2.31 at $0.164 an hour, a 557.86 GB database. Writes (gasless KEY_ADD, casts) have not been tried on mainnet.

Key facts:
- An app key is added with a KEY_ADD message that the custody address signs (EIP-712). It needs no transaction on OP Mainnet (snapchain PR #989, https://snapchain.farcaster.xyz/guides/writing-messages).
- A read node takes submitMessage and publishes the message to validators. It keeps no mempool, so HTTP 200 means sent on, not in a block. Ask for the message back, and resend it if it does not show up (snapchain PR #1034, https://snapchain.farcaster.xyz/node-types).
- Ports: 3381/tcp HTTP API and 3383/tcp gRPC (closed to the internet by default), 3382/udp gossip (open). Keep Grafana's 3000 closed.
- Sign the KEY_ADD in the app running on localhost on your own computer. Never paste a recovery phrase into an AI assistant. Never print HCLOUD_TOKEN.

The 3 steps, as we ran them (from the repo folder on your computer):
\`\`\`bash
MY_IP=$(curl -4 -s https://ifconfig.me)
IP=$(SSH_KEY=my-key SERVER_TYPE=cax31 VOLUME_GB=1000 MAX_USD=5 EXPECTED_HOURS=16 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
./deploy-client.sh "$IP"
# when done:
CONFIRM=snapchain-read-node ./teardown.sh
\`\`\`
In a new terminal: IP=$(hcloud server ip snapchain-read-node)

Repo (MIT): ${REPO}
Full text: ${base}llms-full.txt

## Pages

${list}
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
