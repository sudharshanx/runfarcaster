// SPDX-License-Identifier: MIT
// Browser E2E against a LOCAL fake node (mock_node.py) behind the real deploy/Caddyfile.
// Uses the PUBLIC Hardhat test mnemonic. No mainnet, no network beyond 127.0.0.1.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
// Decode what was submitted with the client's own pinned @farcaster/core.
import { Message, MessageType } from "../client/node_modules/@farcaster/core/dist/index.mjs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:18080";
const LOG = process.env.E2E_LOG;
const PHRASE = "test test test test test test test test test test test junk";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"} - ${name}${extra ? ` (${extra})` : ""}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? undefined, headless: true });
const page = await browser.newPage();
const consoleMsgs = [];
page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleMsgs.push(`pageerror: ${e.message}`));

// Fail with the page's own console output instead of a bare timeout.
const step = async (fn) => { try { return await fn(); } catch (e) { console.error(String(e).split("\n")[0]); console.error(consoleMsgs.join("\n")); await browser.close(); process.exit(1); } };
const resp = await page.goto(URL);
check("page served with CSP connect-src 'self'", (resp.headers()["content-security-policy"] ?? "").includes("connect-src 'self'"));
const metaCsp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "");
check("page also carries a CSP <meta> with connect-src 'self' (no frame-ancestors)", metaCsp.includes("connect-src 'self'") && !metaCsp.includes("frame-ancestors"));
await step(() => page.waitForFunction(() => document.getElementById("node-status")?.textContent?.startsWith("Connected"), null, { timeout: 15000 }));
check("node status via same-origin /v1/info proxy", true);
await page.evaluate(() => document.fonts.ready);
check("self-hosted fonts load under the CSP", await page.evaluate(() => document.fonts.check('16px "DM Sans Variable"') && [...document.fonts].some((f) => f.family.includes("DM Sans") && f.status === "loaded")));

// --- first run: no FID yet, so the feed asks for one and offers the sample feed
const csp = resp.headers()["content-security-policy"] ?? "";
check("img-src is a host allowlist, never the whole https: scheme", /img-src 'self' data: https:\/\/imagedelivery\.net/.test(csp) && !/https:(\s|;|$)/.test(csp));
await step(() => page.waitForSelector("#first-run", { timeout: 10000 }));
check("first-run prompt asks for the reader's FID", (await page.textContent("#first-run"))?.includes("Enter your FID to see your feed"));
await page.click("#try-sample");
await step(() => page.waitForFunction(() => !document.getElementById("sample-note").hidden && !(document.getElementById("feed-meta")?.textContent ?? "").startsWith("Loading"), null, { timeout: 10000 }));
const sampleReads = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.path === "/v1/castsByFid").map((r) => new URLSearchParams(r.query).get("fid"));
check("Try a sample feed reads casts of the curated accounts (incl. balajis, FID 37)", ["37", "3", "5650", "2", "1"].every((f) => sampleReads.includes(f)), `fids=${[...new Set(sampleReads)].join(",")}`);

// --- signer flow: the empty state offers "Add app key", which opens the panel
check("post box shows the add-app-key empty state", (await page.textContent("#compose-box"))?.includes("To post, add an app key first."));
await page.click("#open-add-key");
check("opening the panel adds a stricter CSP meta: img-src 'self' data:", await page.evaluate(() => [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].some((m) => m.getAttribute("content") === "img-src 'self' data:")));
check("add-app-key panel open as a modal dialog", await page.evaluate(() => document.getElementById("add-key-dialog")?.matches(":modal")));
await page.fill("#seed", PHRASE);
await page.click("#cancel-add-key");
await step(() => page.waitForFunction(() => document.getElementById("seed") === null && !document.getElementById("add-key-dialog").open, null, { timeout: 5000 }));
check("Cancel closes the panel and drops the phrase field", !(await page.evaluate(() => document.body.innerHTML + [...document.querySelectorAll("textarea, input")].map((e) => e.value).join(" "))).includes("junk"));
await page.click("#open-add-key");
await page.fill("#seed", PHRASE);
await page.click("#add-key");
await step(() => page.waitForFunction(() => document.getElementById("appkey-card")?.textContent?.includes("FID 4242"), null, { timeout: 20000 }));
check("KEY_ADD signed and submitted; app key stored for FID 4242", true);
check("seed textarea cleared / removed", (await page.$("#seed")) === null);
await step(() => page.waitForFunction(() => document.getElementById("appkey-state")?.dataset.state === "ok", null, { timeout: 20000 }));
check("app key reconciled as active via /v1/signer", true);

const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }));
check("seed phrase not in localStorage", !ls.includes("test test") && !ls.includes("junk"));
check("seed phrase not in console output", !consoleMsgs.some((m) => m.includes("junk")));

// --- post a cast: optimistic, then confirmed
await page.fill("#compose", "hello from the e2e test");
await page.click("#post");
await step(() => page.waitForFunction(() => document.getElementById("feed")?.textContent?.includes("hello from the e2e test"), null, { timeout: 10000 }));
check("cast shown immediately (optimistic)", true);
await step(() => page.waitForFunction(() => document.querySelector('#pending .sent-item[data-status="confirmed"]'), null, { timeout: 20000 }));
check("cast reconciled as confirmed by querying it back", true);

// --- filters persist across reload
if (!(await page.evaluate(() => document.getElementById("filters-panel").open))) await page.click("#filters-panel > summary");
await page.locator("#filters input").nth(1).fill("spam");
await page.locator("#filters button", { hasText: "Add" }).nth(1).click();
await page.reload();
await step(() => page.waitForFunction(() => document.getElementById("filters")?.textContent?.includes("spam"), null, { timeout: 10000 }));
check("muted keyword persisted in localStorage across reload", true);

// --- responsive: no horizontal overflow on a phone and on a desktop, touch targets on mobile
for (const vp of [{ width: 360, height: 740, isMobile: true, hasTouch: true }, { width: 1280, height: 800 }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  const p = await ctx.newPage();
  await p.goto(URL);
  await p.waitForFunction(() => document.getElementById("node-status")?.textContent?.startsWith("Connected"), null, { timeout: 15000 });
  const m = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    minBtn: Math.min(...[...document.querySelectorAll("button")].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height)),
  }));
  check(`no horizontal overflow at ${vp.width}px`, m.sw <= m.cw, `scrollWidth=${m.sw} clientWidth=${m.cw}`);
  if (vp.hasTouch) check("touch targets >= 44px on mobile", m.minBtn >= 44, `min button height=${m.minBtn}`);
  check(`secondary panels start collapsed at ${vp.width}px`, await p.evaluate(() => [...document.querySelectorAll("details.panel")].every((d) => !d.open)));
  if (vp.hasTouch) {
    const before = await p.evaluate(() => ({ tabbar: getComputedStyle(document.querySelector(".tabbar")).display !== "none", side: !!document.getElementById("side")?.offsetParent }));
    await p.click("#tab-settings");
    const after = await p.evaluate(() => ({ side: !!document.getElementById("side")?.offsetParent, feed: !!document.getElementById("feed")?.offsetParent,
      tabs: Math.min(...[...document.querySelectorAll(".tabbar button")].map((b) => b.getBoundingClientRect().height)) }));
    check("mobile tab bar: Settings swaps the feed for the side panels", before.tabbar && !before.side && after.side && !after.feed && after.tabs >= 44, JSON.stringify({ before, after }));
  } else {
    check("no tab bar on desktop; side column visible", await p.evaluate(() => getComputedStyle(document.querySelector(".tabbar")).display === "none" && !!document.getElementById("side")?.offsetParent));
  }
  await ctx.close();
}
await browser.close();

// --- what reached the "node"
const reqs = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const all = JSON.stringify(reqs);
check("seed phrase never sent to the node (URLs/bodies)", !all.includes("test test") && !all.includes("junk"));
const posts = reqs.filter((r) => r.method === "POST");
check("two submitMessage POSTs (KEY_ADD + CAST_ADD), octet-stream", posts.length === 2 && posts.every((p) => p.path === "/v1/submitMessage" && p.ctype === "application/octet-stream"), `got ${posts.length}`);
const [k, c] = posts.map((p) => Message.decode(Buffer.from(p.body_hex, "hex")));
const kb = k?.data?.keyAddBody;
check("1st submit decodes as KEY_ADD for FID 4242, 3 scopes, ttl <= 90d", k?.data?.type === MessageType.KEY_ADD && k.data.fid === 4242 && kb?.scopes?.length === 3 && kb.ttl > 0 && kb.ttl <= 90 * 86400, `type=${k?.data?.type} scopes=${kb?.scopes} ttl=${kb?.ttl} nonce=${kb?.nonce}`);
check("2nd submit decodes as CAST_ADD with the composed text", c?.data?.type === MessageType.CAST_ADD && c.data.castAddBody?.text === "hello from the e2e test");
check("no CORS preflight (same origin)", !reqs.some((r) => r.method === "OPTIONS"));
check("nonce read from /v1/signersByFid", reqs.some((r) => r.path === "/v1/signersByFid"));
const errs = consoleMsgs.filter((m) => m.startsWith("error") || m.startsWith("pageerror"));
check("no console errors / CSP violations", errs.length === 0, errs.join(" | ").slice(0, 400));

const failed = results.filter((r) => !r.ok).length;
console.log(`\npassed: ${results.length - failed}  failed: ${failed}`);
process.exit(failed ? 1 : 0);
