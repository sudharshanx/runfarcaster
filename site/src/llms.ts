// SPDX-License-Identifier: MIT
// Turns the MDX pages into plain Markdown for /llms.txt and /llms-full.txt.
import { getCollection } from "astro:content";
import { prompts, REPO, type PromptKey } from "./prompts";

export const ORDER = [
  "instant-run", "quickstart", "how-farcaster-works", "server-and-node", "first-cast", "ai-assistant",
  "build-on-your-node", "recipes", "client-code", "reference", "glossary", "fix", "proof", "docs-issues", "how-ai-was-used",
];

const GLANCE = `| | |
|---|---|
| Steps | 3, plus teardown.sh at the end |
| Sync time | 14 h 06 m from renting the server to fully synced (one run) |
| Cost to sync | About $2.31 at $0.164 an hour (Hetzner price list; invoice not seen) |
| Left running | About $102 a month (each item stops at its monthly price) |
| Server | Hetzner cax31 (ARM64, 8 vCPU, 16 GB RAM) and a 1000 GB volume, Ubuntu 24.04 |
| Disk | 557.86 GB database; the volume peaked at 75% full while the snapshot loaded |
| Memory | About 2.5 GB in use once synced |
| Hands-on time | Renting the server 35 s; deploying the app 35 s with a warm npm cache |
| You need | A terminal, SSH and a Hetzner account |`;

const TESTED = `| What | Status |
|---|---|
| provision.sh on Hetzner (cax31, VOLUME_GB=1000) | Ran live (35 s) |
| node.sh: official bootstrap, full mainnet sync, health check, second run skips the bootstrap | Ran live |
| deploy-client.sh: Caddy, Let's Encrypt, /v1 on the same address | Ran live |
| App reads on the real node (e2e/real-node.mjs) | Ran live, read-only, 17 of 17 |
| Node rejects a broken message | Ran live (HTTP 400) |
| disk-guard.sh and snapshot-space-saver.sh, installed by hand | Ran live; chunk and tar deletion worked, hole-punching did not; the guard never fired |
| node.sh installing those helpers by itself (new) | Unit tests only; not yet used in a live sync |
| watchdog.sh | Ran live (old version); new progress check unit-tested |
| provision.sh starting the watchdog by itself (new) | Unit tests only |
| Gasless KEY_ADD on mainnet | Ran live once (2026-10-18, 1-day key, signed in the browser on localhost) |
| Cast on mainnet | Ran live once; confirmed 18 s after the key was added |
| Like, recast, follow on mainnet | Not tried (unit tests and a local mock node only) |
| Time from sending a message to seeing it | Not measured precisely (one cast: key added to cast confirmed in 18 s) |
| teardown.sh against real servers | Not tried (DRY_RUN and a fake hcloud in tests) |
| 2 TB volume, x86 cx43 | Not tried |
| Inbound 3382/udp closed | 2-minute test only |`;

// Docs pages link to each other with "../<slug>/". Plain Markdown files live at other paths
// (/<slug>.md, /llms-full.txt), so links there use absolute URLs.
const SITE_BASE = new URL(import.meta.env.BASE_URL, import.meta.env.SITE ?? "https://sudharshanx.github.io").href.replace(/\/?$/, "/");

export function toMarkdown(body: string): string {
  return body
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\{\{REPO_URL\}\}/g, REPO)
    .replace(/^import .*$/gm, "")
    .replace(/<AtAGlance \/>/g, GLANCE)
    .replace(/<TestedTable \/>/g, TESTED)
    .replace(/<CopyPrompt id="(\w+)"([^>]*?)\/>/g, (_m, id: string, rest: string) => {
      const q = /question="([^"]*)"/.exec(rest)?.[1];
      let t: string = prompts[id as PromptKey] ?? "";
      if (q) t = t.replace("<my question>", q);
      return "Prompt for a coding assistant:\n\n```text\n" + t + "\n```";
    })
    .replace(/<RepoLink path="([^"]*)"(?: label="([^"]*)")? \/>/g, (_m, p: string, l?: string) => `[${l ?? p}](${p ? `${REPO}/${p.endsWith("/") ? "tree" : "blob"}/main/${p}` : REPO})`)
    .replace(/<Image [^>]*alt="([^"]*)"[^>]*\/>/g, "[screenshot: $1]")
    .replace(/<\/?(Tabs|TabItem|div|section|figure|figcaption|details|summary|CardGrid|LinkCard)[^>]*>/g, "")
    .replace(/<p class="label">(.*?)<\/p>/g, "$1")
    .replace(/<p class="claim">(.*?)<\/p>/g, "**$1**")
    .replace(/<br \/>/g, "\n")
    .replace(/<\/?p(?:\s[^>]*)?>/g, "\n")
    .replace(/<a href="([^"]*)">(.*?)<\/a>/g, "[$2]($1)")
    .replace(/<\/?(strong|code)>/g, (m) => (m.includes("strong") ? "**" : "`"))
    .replace(/<pre class="diagram"[^>]*>\{`([\s\S]*?)`\}<\/pre>/g, "```text\n$1\n```")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\]\(\.\.\//g, `](${SITE_BASE}`)
    .trim();
}

type Entry = { data: { title: string; description?: string }; body?: string };
export const pageMarkdown = (e: Entry) =>
  `# ${e.data.title}\n\n${e.data.description ? `> ${e.data.description}\n\n` : ""}${toMarkdown(e.body ?? "")}`;

export async function pages() {
  const all = await getCollection("docs");
  return ORDER.map((id) => all.find((e) => e.id === id)).filter((e) => e !== undefined);
}
