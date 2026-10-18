// SPDX-License-Identifier: MIT
// After `astro build`: look for placeholders that must not ship. In CI (CI=true) any hit fails the
// build; locally it only warns, because local builds use the OWNER / example.github.io defaults.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const PATTERNS = [
  ["github.com/OWNER", /github\.com\/OWNER\b/g],
  ["example.github.io", /example\.github\.io/g],
  ["AUTHOR slot", /\[AUTHOR|AUTHOR:/g],
  ["{{REPO_URL}} token", /\{\{REPO_URL\}\}/g],
];

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|txt|xml|js|json)$/.test(n) && !p.includes("/pagefind/")) files.push(p);
  }
})(DIST);

const hits = new Map();
for (const f of files) {
  const s = readFileSync(f, "utf8");
  for (const [label, re] of PATTERNS) {
    const n = (s.match(re) || []).length;
    if (n) hits.set(label, (hits.get(label) || 0) + n);
  }
}

if (!hits.size) { console.log(`check-placeholders: OK (${files.length} files)`); process.exit(0); }
const msg = [...hits].map(([l, n]) => `${l}: ${n}`).join(", ");
if (process.env.CI === "true") { console.error(`check-placeholders: FAIL: ${msg}. Set REPO_URL, SITE_URL and BASE_PATH.`); process.exit(1); }
console.warn(`check-placeholders: warning (local build, CI would fail): ${msg}`);
