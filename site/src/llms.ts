// SPDX-License-Identifier: MIT
// Turns the MDX pages into plain Markdown for /llms.txt and /llms-full.txt.
import { getCollection } from "astro:content";
import { prompts, REPO, type PromptKey } from "./prompts";

export const ORDER = [
  "index", "before-you-start", "quickstart", "tutorial", "first-cast", "troubleshooting",
  "receipts", "docs-issues", "reference", "glossary", "ai-assistant", "how-ai-was-used",
];

const GLANCE = `| | |
|---|---|
| Commands | 3 (plus one teardown). Provision ≈35 s, client deploy ≈35 s (measured) |
| Unattended sync | ≈14 h 06 m from provision to fully synced (measured, one run) |
| Cost to sync | ≈$2.31 at ≈$0.164/h (price-list estimate; invoice not checked) |
| If left on | ≈$120/month (estimate) |
| Server | Hetzner cax31 (ARM64, 8 vCPU, 16 GB RAM) + 1000 GB volume |
| Disk | 557.86 GB database; 75% peak use of the volume during snapshot restore |
| RAM | ≈2.5 GB used on the host at tip |
| API keys | None |`;

const TESTED = `| What | Status |
|---|---|
| provision.sh on Hetzner (cax31, VOLUME_GB=1000) | Tested live (35 s) |
| node.sh: official bootstrap, full mainnet sync, health, idempotent re-run | Tested live |
| deploy-client.sh: Caddy + Let's Encrypt, same-origin /v1 proxy | Tested live |
| Client reads on the real node (e2e/real-node.mjs) | Tested live, read-only, 16/16 |
| submitMessage rejects an invalid message | Tested live (HTTP 400) |
| Gasless KEY_ADD on mainnet | NOT tested (unit tests + local mock node only) |
| Cast, like, recast, follow on mainnet | NOT tested (unit tests + local mock node only) |
| Submit-to-visible latency | Not measured |
| teardown.sh against real resources | NOT tested (DRY_RUN only) |
| snapshot-space-saver.sh | Partly worked (chunk/tar deletion yes, hole-punching no) |
| disk-guard.sh, watchdog.sh | Ran live, never fired |
| 2 TB volume, x86 cx43 | Not tested |`;

export function toMarkdown(body: string): string {
  return body
    .replace(/^import .*$/gm, "")
    .replace(/<AtAGlance \/>/g, GLANCE)
    .replace(/<TestedTable \/>/g, TESTED)
    .replace(/<CopyPrompt id="(\w+)"([^>]*?)\/>/g, (_m, id: string, rest: string) => {
      const q = /question="([^"]*)"/.exec(rest)?.[1];
      let t: string = prompts[id as PromptKey] ?? "";
      if (q) t = t.replace("<my question>", q);
      return "Prompt for a coding assistant:\n\n```text\n" + t + "\n```";
    })
    .replace(/<RepoLink path="([^"]*)"(?: label="([^"]*)")? \/>/g, (_m, p: string, l?: string) => `[${l ?? p}](${p ? `${REPO}/blob/main/${p}` : REPO})`)
    .replace(/<Image [^>]*alt="([^"]*)"[^>]*\/>/g, "[screenshot: $1]")
    .replace(/<\/?(Tabs|TabItem|div|section|figure|figcaption|details|summary|CardGrid|LinkCard)[^>]*>/g, "")
    .replace(/<p class="label">(.*?)<\/p>/g, "$1")
    .replace(/<p class="claim">(.*?)<\/p>/g, "**$1**")
    .replace(/<br \/>/g, "\n")
    .replace(/<\/?p[^>]*>/g, "\n")
    .replace(/<a href="([^"]*)">(.*?)<\/a>/g, "[$2]($1)")
    .replace(/<\/?(strong|code)>/g, (m) => (m.includes("strong") ? "**" : "`"))
    .replace(/<pre class="diagram"[^>]*>\{`([\s\S]*?)`\}<\/pre>/g, "```text\n$1\n```")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function pages() {
  const all = await getCollection("docs");
  return ORDER.map((id) => all.find((e) => e.id === id)).filter((e) => e !== undefined);
}
