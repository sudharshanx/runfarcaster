// SPDX-License-Identifier: MIT
// One place for the repo URL. CI sets REPO_URL (see .github/workflows/pages.yml); everything on
// the site, including code blocks (the {{REPO_URL}} token), prompts and llms.txt, reads it here.
export const REPO = (process.env.REPO_URL ?? "https://github.com/sudharshanx/runfarcaster").replace(/\/+$/, "");
export const REPO_TOKEN = "{{REPO_URL}}";
// GitMCP (a free third-party service) serves a GitHub Pages site's llms.txt as an MCP server at
// https://<owner>.gitmcp.io/<repo>. Code blocks use the {{DOCS_MCP_URL}} token.
const [, OWNER = "", NAME = ""] = REPO.match(/github\.com\/([^/]+)\/([^/]+)/) ?? [];
export const DOCS_MCP = `https://${OWNER.toLowerCase()}.gitmcp.io/${NAME}`;
export const DOCS_MCP_TOKEN = "{{DOCS_MCP_URL}}";

// remark plugin: replace {{REPO_URL}} in text, inline code, code blocks, links and raw HTML.
export function remarkRepoUrl() {
  const fix = (s) => (typeof s === "string" ? s.split(REPO_TOKEN).join(REPO).split(DOCS_MCP_TOKEN).join(DOCS_MCP) : s);
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
  const text = (x) => (x.type === "text" ? x.value : (x.children || []).map(text).join(""));
  const clean = (t) => t.replace(/\s+/g, " ").trim();
  // Labels must be unique on a page (axe landmark-unique): name each table after the heading above
  // it plus its column headers, and number repeats.
  const walk = (node, st) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.map((c) => {
      if (c.type === "element" && /^h[1-6]$/.test(c.tagName)) st.heading = clean(text(c));
      if (c.type === "element" && c.tagName === "table") {
        st.i += 1;
        const thead = (c.children || []).find((x) => x.tagName === "thead");
        const ths = [];
        const findTh = (x) => { if (x.tagName === "th") ths.push(clean(text(x))); (x.children || []).forEach(findTh); };
        if (thead) findTh(thead);
        const cols = ths.filter(Boolean).join(", ");
        let label = [st.heading, cols ? `table: ${cols}` : `table ${st.i}`].filter(Boolean).join(", ").slice(0, 120);
        const seen = st.seen.get(label) ?? 0;
        st.seen.set(label, seen + 1);
        if (seen) label = `${label} (${seen + 1})`;
        return { type: "element", tagName: "div", properties: { className: ["table-scroll"], role: "region", tabIndex: 0, ariaLabel: label }, children: [c] };
      }
      walk(c, st);
      return c;
    });
  };
  return (tree) => walk(tree, { i: 0, heading: "", seen: new Map() });
}
