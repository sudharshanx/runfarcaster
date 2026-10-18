import type { APIRoute } from "astro";
import { pages } from "../llms";
import { REPO } from "../prompts";

export const GET: APIRoute = async ({ site }) => {
  const base = new URL(import.meta.env.BASE_URL, site).href.replace(/\/?$/, "/");
  const list = (await pages()).map((e) => `- [${e.data.title}](${base}${e.id === "index" ? "" : `${e.id}/`}): ${e.data.description ?? ""}`).join("\n");
  const body = `# Run your own Farcaster Snapchain read node and client in three commands

> Rent a Hetzner server, turn it into a Snapchain read node with the official bootstrap, and serve a small web client from it over HTTPS on the same origin. No API keys from anyone. Measured on one mainnet run (2026-10-18): ≈14 h 06 m provision to synced, ≈$2.31 at ≈$0.164/h, 557.86 GB database. Writes (gasless KEY_ADD, casts) are NOT yet tested on mainnet.

Key facts:
- App keys are added gaslessly with a KEY_ADD message signed (EIP-712) by the custody address; no Optimism transaction (snapchain PR #989, https://snapchain.farcaster.xyz/guides/writing-messages).
- Read nodes accept submitMessage and relay to validators; they have no mempool, so a 200 means "accepted for relay", not "included". Query the message back and retry (snapchain PR #1034, https://snapchain.farcaster.xyz/node-types).
- Ports: 3381/tcp HTTP API, 3382/udp gossip, 3383/tcp gRPC. Keep Grafana 3000 closed.
- Never paste a seed phrase into an AI assistant. Never print HCLOUD_TOKEN.

Commands (what we ran):
\`\`\`bash
IP=$(SSH_KEY=my-key SERVER_TYPE=cax31 VOLUME_GB=1000 MAX_USD=5 EXPECTED_HOURS=16 ./provision.sh)
ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh   # plus disk-guard.sh and snapshot-space-saver.sh on a 1 TB volume
./deploy-client.sh "$IP"
CONFIRM=snapchain-read-node ./teardown.sh
\`\`\`

Repo (MIT): ${REPO}
Full text: ${base}llms-full.txt

## Pages

${list}
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
