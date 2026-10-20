import type { APIRoute } from "astro";
import { pages } from "../llms";
import { REPO } from "../prompts";

export const GET: APIRoute = async ({ site }) => {
  const base = new URL(import.meta.env.BASE_URL, site).href.replace(/\/?$/, "/");
  const home = `- [Home](${base}): RunFarcaster sets up a Farcaster node and app of your own, with no gatekeepers in between.`;
  const list = home + "\n" + (await pages()).map((e) => `- [${e.data.title}](${base}${e.id === "index" ? "" : `${e.id}/`}): ${e.data.description ?? ""}`).join("\n");
  const body = `# RunFarcaster: read and post on Farcaster from your own server

> RunFarcaster sets up a Farcaster node and app of your own, with no gatekeepers in between. Rent a Hetzner server. Start a Snapchain read node on it with the official bootstrap. Open a small web app served from the same server over HTTPS. You need no API keys. On a Hetzner cax31 with a 1000 GB volume, expect about 14 hours from renting the server to synced, $2.31 at an estimated $0.164 an hour, and a database of about 560 GB. With SERVER_TYPE="" the script rents the first 16 GB type for sale in LOCATION; if a type isn't available to rent there, it lists what is, cheapest first. cpx42 has not been tested; with IPv4 and the volume it costs $159.29 a month at list prices. A gasless KEY_ADD and a cast have been tested on mainnet (2026-10-18); likes, recasts and follows only against a mock node.

Full run (${base}quickstart/): the 3 commands below, on your own server. Vouchers do this one.

Key facts:
- An app key is added with a KEY_ADD message that the custody address signs (EIP-712). It needs no transaction on OP Mainnet. Mainnet has accepted it since engine version V16 on 2026-05-07 (https://snapchain.farcaster.xyz/guides/writing-messages; snapchain src/version/version.rs).
- A read node takes submitMessage and publishes the message to validators. It keeps no mempool, so HTTP 200 means sent on, not in a block. Ask for the message back, and resend it if it does not show up (https://snapchain.farcaster.xyz/node-types).
- Ports: 3381/tcp HTTP API and 3383/tcp gRPC (closed to the internet by default), 3382/udp gossip (open). Keep Grafana's 3000 closed.
- Sign the KEY_ADD in the app running on localhost on your own computer. Never paste a recovery phrase into an AI assistant. Never print HCLOUD_TOKEN.

The 3 steps of the Full run (from the repo folder on your computer):
\`\`\`bash
MY_IP=$(curl -4 -s https://ifconfig.me)
export NAME=snapchain-read-node
IP=$(SSH_KEY=my-key SERVER_TYPE="" VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh)
ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh
./deploy-client.sh "$IP"
# when done:
CONFIRM="$NAME" ./teardown.sh
\`\`\`
Use an empty Hetzner project. In a new terminal: export NAME=snapchain-read-node, then IP=$(hcloud server ip "$NAME")
WATCHDOG=0 keeps the server until you delete it. For a trial run, leave it out and add MAX_USD=5 EXPECTED_HOURS=16: watchdog.sh then deletes everything after 24 h.
SERVER_TYPE="" picks the first type for sale from cx43, cax31, cpx42, ccx23. If none is for sale, provision.sh lists the types available in LOCATION; set SERVER_TYPE and/or LOCATION.

Repo (MIT): ${REPO}
Full text: ${base}llms-full.txt
Agent skill: npx skills add sudharshanx/runfarcaster --skill runfarcaster (files in skills/runfarcaster)

## Pages

${list}
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
