// SPDX-License-Identifier: MIT
// Checks skills/runfarcaster against the Agent Skills spec (agentskills.io/specification) and keeps
// its commands and error texts in line with the site: src/prompts.ts and the Fix a problem page.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const dir = join(root, "skills/runfarcaster");
const read = (p) => readFileSync(join(dir, p), "utf8");
const fail = [];

// Frontmatter: name (1-64, a-z 0-9 and single hyphens, same as the folder), description (1-1024).
const skill = read("SKILL.md");
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
const desc = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
if (name !== "runfarcaster" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) fail.push(`bad name: ${name}`);
if (!desc || desc.length > 1024) fail.push(`description length ${desc.length}`);
if (skill.split("\n").length > 500) fail.push("SKILL.md over 500 lines");

// Every reference SKILL.md links to exists.
const refs = readdirSync(join(dir, "references"));
for (const m of skill.matchAll(/\]\(references\/([^)#]+)/g)) if (!refs.includes(m[1])) fail.push(`missing references/${m[1]}`);

// Commands that must match src/prompts.ts word for word.
const prompts = readFileSync(join(root, "site/src/prompts.ts"), "utf8");
const all = [skill, ...refs.map((r) => read(`references/${r}`))].join("\n");
const shared = [
  'SSH_KEY=<key-name> SERVER_TYPE=cax31 VOLUME_GB=1000 WATCHDOG=0 SSH_SOURCE_CIDRS="$MY_IP/32" ./provision.sh',
  "ESTIMATE_ONLY=1 SERVER_TYPE=cax31 VOLUME_GB=1000 ./provision.sh",
  'ssh root@$IP "SNAPCHAIN_AGREE_NO_REWARDS=yes MIN_FREE_GB=900 bash -s" < node.sh',
  "ssh root@$IP 'bash -s wait' < node.sh",
  "ssh root@$IP 'curl -s 127.0.0.1:3381/v1/info' | jq '.shardInfos[] | {shardId, blockDelay}'",
  './deploy-client.sh "$IP"',
  "CONFIRM=snapchain-read-node ./teardown.sh",
  "IP=$(hcloud server ip snapchain-read-node)",
  "MAX_USD=5 EXPECTED_HOURS=16",
  "touch .provision-state/watchdog.disarm",
  "[provision] WATCHDOG=0: no watchdog started",
  "[deploy-client] OK: https://<name> (client) and https://<name>/v1/info (node, proxied)",
  "[teardown] verified: server, volume(s) and firewall are gone.",
];
for (const s of shared) {
  if (!prompts.includes(s)) fail.push(`not in prompts.ts any more: ${s}`);
  if (!all.includes(s)) fail.push(`not in the skill: ${s}`);
}

// Every error text in the skill's fix.md (first column, in backticks) is on the Fix a problem page.
const fixPage = readFileSync(join(root, "site/src/content/docs/fix.mdx"), "utf8");
for (const line of read("references/fix.md").split("\n").filter((l) => l.startsWith("| `"))) {
  const first = line.split(" | ")[0];
  for (const m of first.matchAll(/`([^`]+)`/g)) if (!fixPage.includes(m[1])) fail.push(`fix.md text not on the Fix page: ${m[1]}`);
}

if (fail.length) { console.error("check-skill: FAIL\n- " + fail.join("\n- ")); process.exit(1); }
console.log(`check-skill: OK (${refs.length} references, ${shared.length} shared commands)`);
