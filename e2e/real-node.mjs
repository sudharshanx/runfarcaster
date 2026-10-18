// SPDX-License-Identifier: MIT
// READ-ONLY browser test against a REAL deployed client + node (https://<site>/).
// It never pastes a seed phrase, never creates an app key and never clicks Cast/Like/Recast/Follow.
// The only write is a deliberately INVALID submitMessage (random bytes), which the node must reject.
// Usage: SITE=https://1-2-3-4.sslip.io CHROME=/usr/bin/google-chrome node real-node.mjs
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";

const SITE = process.env.SITE;
if (!SITE) throw new Error("set SITE");
const TEST_FID = Number(process.env.TEST_FID ?? 3);
const WATCH = process.env.WATCH_FIDS ?? "2,3" + (process.env.TEST_FID ? "," + process.env.TEST_FID : ""); // v, dwr (long-lived public accounts) + optional test account
const OUT = process.env.OUT ?? "screenshots";
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "ok  " : "FAIL"} - ${name}${extra ? ` (${extra})` : ""}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const consoleMsgs = [], requests = [];
page.on("console", (m) => consoleMsgs.push({ text: `${m.type()}: ${m.text()}`, url: m.location()?.url ?? "" }));
page.on("pageerror", (e) => consoleMsgs.push({ text: `pageerror: ${e.message}`, url: "" }));
page.on("request", (r) => requests.push({ url: r.url(), method: r.method(), type: r.resourceType() }));
// Screenshots must not show the server's address: replace the hostname in visible text first.
const redact = (p) => p.evaluate(() => {
  const host = location.hostname;
  const label = host.endsWith(".sslip.io") ? "<ip-with-dashes>.sslip.io" : "<your-domain>";
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(host)) n.nodeValue = n.nodeValue.split(host).join(label);
  for (const i of document.querySelectorAll("input, textarea")) if (i.value.includes(host)) i.value = i.value.split(host).join(label);
});
// Side panels and Feed options are <details>; open one before filling the inputs inside it.
const openPanel = async (p, id) => { if (!(await p.evaluate((i) => document.getElementById(i).open, id))) await p.click(`#${id} > summary`); };
const step = async (name, fn) => { try { return await fn(); } catch (e) { check(name, false, String(e).split("\n")[0]); return undefined; } };

const resp = await page.goto(SITE);
const h = resp.headers();
check("served over HTTPS", SITE.startsWith("https://") && resp.ok());
check("CSP connect-src 'self'", (h["content-security-policy"] ?? "").includes("connect-src 'self'"));
check("HSTS header", !!h["strict-transport-security"]);
await step("node status Connected", async () => {
  await page.waitForFunction(() => document.getElementById("node-status")?.textContent?.startsWith("Connected"), null, { timeout: 30000 });
  check("node status Connected", true, await page.textContent("#node-status"));
});

// feed with real casts
await openPanel(page, "feed-options");
await page.fill("#watch-fids", WATCH);
await page.click("#refresh");
await step("real casts in feed", async () => {
  await page.waitForFunction(() => document.querySelectorAll("#feed .cast").length > 0, null, { timeout: 60000 });
  // wait for the refresh to finish, otherwise a cast from the initial (pre-refresh) feed gets picked below
  await page.waitForFunction(() => !(document.getElementById("feed-meta")?.textContent ?? "").startsWith("Loading"), null, { timeout: 60000 });
  check("real casts in feed", true, `${await page.locator("#feed .cast").count()} rendered; ${await page.textContent("#feed-meta")}`);
});
await redact(page); await page.screenshot({ path: `${OUT}/desktop-feed.png`, fullPage: false });
await page.evaluate(() => window.scrollTo(0, 0));
await redact(page); await page.screenshot({ path: `${OUT}/desktop-top.png`, fullPage: false });

// filters on real data
const firstFid = await page.locator("#feed .cast").first().getAttribute("data-fid").then((t) => Number(t));
const before = await page.locator("#feed .cast").count();
await openPanel(page, "filters-panel");
await page.locator("#filters input").nth(0).fill(String(firstFid));
await page.locator("#filters button", { hasText: "Add" }).nth(0).click();
const afterMute = await page.locator(`#feed .cast[data-fid="${firstFid}"]`).count();
check(`mute FID ${firstFid} hides its casts`, Number.isFinite(firstFid) && afterMute === 0 && (await page.locator("#feed .cast").count()) < before, `${before} -> ${await page.locator("#feed .cast").count()}`);
await page.reload();
await page.waitForFunction(() => document.getElementById("node-status")?.textContent?.startsWith("Connected"), null, { timeout: 30000 });
check("mute persists across reload", ((await page.textContent("#filters")) ?? "").includes(String(firstFid)));
await openPanel(page, "filters-panel");
await page.locator("#filters .chip button").first().click();

// same-origin API reads from inside the page (exactly what the client does)
const api = await page.evaluate(async (fid) => {
  const j = async (u) => { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => null) }; };
  const signers = await j(`/v1/signersByFid?fid=${fid}`);
  const casts = await j(`/v1/castsByFid?fid=${fid}&pageSize=5&reverse=true`);
  const user = await j(`/v1/userDataByFid?fid=${fid}`);
  const storage = await j(`/v1/storageLimitsByFid?fid=${fid}`);
  return { signers, casts: { status: casts.status, n: casts.body?.messages?.length }, user: { status: user.status, n: user.body?.messages?.length }, storage: { status: storage.status, body: storage.body } };
}, TEST_FID);
check(`/v1/signersByFid?fid=${TEST_FID} readable`, api.signers.status === 200 && typeof api.signers.body?.currentUserNonce === "number",
  `currentUserNonce=${api.signers.body?.currentUserNonce} signers=${api.signers.body?.signers?.length} gasless=${api.signers.body?.gaslessSignerCount}/${api.signers.body?.gaslessSignerLimit}`);
check(`reads for FID ${TEST_FID}`, api.casts.status === 200 && api.user.status === 200, `casts=${api.casts.n} userData=${api.user.n}`);
check(`storage for FID ${TEST_FID} readable`, api.storage.status === 200, JSON.stringify(api.storage.body?.limits?.map?.((l) => [l.storeType, l.limit]) ?? api.storage.body).slice(0, 200));

// the Caddyfile must hide the node's /v1/mesh admin view
const meshStatus = await page.evaluate(async () => (await fetch("/v1/mesh")).status);
check("/v1/mesh blocked by Caddy (404)", meshStatus === 404, `HTTP ${meshStatus}`);

// invalid submit: must be rejected, cannot have any effect on mainnet
const bad = await page.evaluate(async () => {
  const junk = crypto.getRandomValues(new Uint8Array(64));
  const r = await fetch("/v1/submitMessage", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: junk });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
});
check("invalid submitMessage rejected (4xx)", bad.status >= 400 && bad.status < 500, `${bad.status} ${bad.body}`);

// mixed content: every request is https to the same origin, except image GETs to the exact
// allowlist in client/src/images.ts (profile pictures and image posts; no referrer is sent).
const origin = new URL(SITE).origin;
const IMAGE_HOSTS = JSON.parse(readFileSync(new URL("../client/src/images.ts", import.meta.url), "utf8").match(/IMAGE_HOSTS = (\[[^\]]*\])/)[1]);
const isAllowedImage = (r) => { try { const u = new URL(r.url); return r.type === "image" && r.method === "GET" && u.protocol === "https:" && !u.port && IMAGE_HOSTS.includes(u.hostname); } catch { return false; } };
const foreign = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:") && !isAllowedImage(r));
check(`no mixed content; third-party requests only for images on ${IMAGE_HOSTS.join(", ")}`, foreign.length === 0, foreign.slice(0, 3).map((r) => `${r.type} ${r.url}`).join(" "));
check("no app key or seed in storage (read-only test)", await page.evaluate(() => !localStorage.getItem("appKey.v1") && !Object.values(localStorage).some((v) => / \w+ \w+ \w+ \w+ \w+ \w+ \w+ \w+ \w+ \w+ \w+ /.test(v))));
// Chrome logs "Failed to load resource: 400" for the deliberately invalid submitMessage above; that one is expected.
const errs = consoleMsgs.filter((m) => (m.text.startsWith("error") || m.text.startsWith("pageerror"))
  && !(m.url.endsWith("/v1/submitMessage") && m.text.includes("status of 400"))
  && !(m.url.endsWith("/v1/mesh") && m.text.includes("status of 404")));
check("no console errors / CSP violations (except the expected invalid-submit 400)", errs.length === 0, errs.map((m) => `${m.text} ${m.url}`).join(" | ").slice(0, 300));

// mobile layout with real data
const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const m = await mctx.newPage();
await m.goto(SITE);
await openPanel(m, "feed-options");
await m.fill("#watch-fids", WATCH);
await m.click("#refresh");
await step("mobile feed", () => m.waitForFunction(() => document.querySelectorAll("#feed .cast").length > 0
  && !(document.getElementById("feed-meta")?.textContent ?? "").startsWith("Loading"), null, { timeout: 60000 }));
const mm = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
check("mobile 375px: no horizontal overflow with real casts", mm.sw <= mm.cw, `scrollWidth=${mm.sw} clientWidth=${mm.cw}`);
await m.evaluate(() => document.getElementById("feed-meta")?.scrollIntoView({ block: "end" }));
await redact(m); await m.screenshot({ path: `${OUT}/mobile-feed.png`, fullPage: false });

// 360 px phone: the feed itself
const sctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const sp = await sctx.newPage();
await sp.goto(SITE);
await openPanel(sp, "feed-options");
await sp.fill("#watch-fids", WATCH);
await sp.click("#refresh");
await step("360 feed", () => sp.waitForFunction(() => document.querySelectorAll("#feed .cast").length > 0
  && !(document.getElementById("feed-meta")?.textContent ?? "").startsWith("Loading"), null, { timeout: 60000 }));
const sm = await sp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
check("mobile 360px: no horizontal overflow with real casts", sm.sw <= sm.cw, `scrollWidth=${sm.sw} clientWidth=${sm.cw}`);
await sp.evaluate(() => document.querySelector("#feed .cast")?.scrollIntoView({ block: "start" }));
await redact(sp); await sp.screenshot({ path: `${OUT}/mobile-360-feed.png`, fullPage: false });
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\npassed: ${results.length - failed}  failed: ${failed}`);
process.exit(failed ? 1 : 0);
