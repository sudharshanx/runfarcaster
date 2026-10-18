// SPDX-License-Identifier: MIT
// One place for the repo URL. CI sets REPO_URL (see .github/workflows/pages.yml); everything on
// the site, including code blocks (the {{REPO_URL}} token), prompts and llms.txt, reads it here.
export const REPO = (process.env.REPO_URL ?? "https://github.com/OWNER/snapchain-tutorial").replace(/\/+$/, "");
export const REPO_TOKEN = "{{REPO_URL}}";

// remark plugin: replace {{REPO_URL}} in text, inline code, code blocks, links and raw HTML.
export function remarkRepoUrl() {
  const fix = (s) => (typeof s === "string" ? s.split(REPO_TOKEN).join(REPO) : s);
  const walk = (node) => {
    if ("value" in node) node.value = fix(node.value);
    if ("url" in node) node.url = fix(node.url);
    if (Array.isArray(node.attributes)) for (const a of node.attributes) if (typeof a.value === "string") a.value = fix(a.value);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  return (tree) => walk(tree);
}

// rehype plugin: wrap each Markdown table in a focusable, labelled scroll region, so keyboard users can
// scroll wide tables on phones (axe: scrollable-region-focusable).
export function rehypeTableScroll() {
  const walk = (node, n = { i: 0 }) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.map((c) => {
      if (c.type === "element" && c.tagName === "table") {
        n.i += 1;
        const text = (x) => (x.type === "text" ? x.value : (x.children || []).map(text).join(""));
        const thead = (c.children || []).find((x) => x.tagName === "thead");
        const ths = [];
        const findTh = (x) => { if (x.tagName === "th") ths.push(text(x).replace(/\s+/g, " ").trim()); (x.children || []).forEach(findTh); };
        if (thead) findTh(thead);
        const cols = ths.filter(Boolean).join(", ");
        const label = cols ? `Table: ${cols}`.slice(0, 120) : `Table ${n.i}`;
        return { type: "element", tagName: "div", properties: { className: ["table-scroll"], role: "region", tabIndex: 0, ariaLabel: label }, children: [c] };
      }
      walk(c, n);
      return c;
    });
  };
  return (tree) => walk(tree);
}
