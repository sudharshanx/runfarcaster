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
const stepNow = () => page.evaluate(() => document.querySelector('#add-key-dialog .stepper [aria-current="step"]')?.textContent ?? "");
check("stepper starts at step 1 (About) with no phrase field", (await stepNow()).includes("About") && (await page.$("#seed")) === null);
await page.click("#step-next");
const warn = (await page.textContent("#phrase-warning")) ?? "";
check("step 2 lists what you need and keeps the trusted-software and delegated-signer warning", (await stepNow()).includes("Before you start") && warn.includes("developers you trust") && warn.includes("delegated signer") && (await page.$("#seed")) === null);
await page.click("#step-next");
check("step 3 (Sign) shows the phrase field and the technical details", (await stepNow()).includes("Sign") && (await page.$("#seed")) !== null && (await page.textContent("#add-key-dialog details.tech"))?.includes("Prefer delegated signers"));
await page.fill("#seed", PHRASE);
await page.click("#step-back");
check("Back from step 3 drops the phrase field and what was typed", (await stepNow()).includes("Before you start") && (await page.$("#seed")) === null && !(await page.evaluate(() => document.body.innerHTML)).includes("junk"));
await page.click("#step-next");
check("returning to step 3 starts with an empty field", (await page.inputValue("#seed")) === "");
await page.fill("#seed", PHRASE);
await page.click("#close-add-key");
await step(() => page.waitForFunction(() => document.getElementById("seed") === null && !document.getElementById("add-key-dialog").open, null, { timeout: 5000 }));
check("Close (×) on the Sign step closes the panel and drops the phrase field", !(await page.evaluate(() => document.body.innerHTML + [...document.querySelectorAll("textarea, input")].map((e) => e.value).join(" "))).includes("junk"));
await page.click("#open-add-key");
await page.click("#step-next"); await page.click("#step-next");
await page.fill("#seed", "test test test");
await page.click("#add-key");
await step(() => page.waitForFunction(() => document.getElementById("signer-msg")?.classList.contains("error"), null, { timeout: 10000 }));
check("a wrong word count says how many words a phrase has", (await page.textContent("#signer-msg"))?.includes("12, 15, 18, 21 or 24 words"));
await page.fill("#seed", PHRASE);
await page.click("#add-key");
await step(() => page.waitForFunction(() => document.getElementById("appkey-card")?.textContent?.includes("FID 4242"), null, { timeout: 20000 }));
check("KEY_ADD signed and submitted; app key stored for FID 4242", true);
check("seed textarea cleared / removed", (await page.$("#seed")) === null);
const done = (await page.textContent("#key-done")) ?? "";
check("step 4 (Done) explains how to remove and revoke the key", (await stepNow()).includes("Done") && done.includes("Remove from this browser") && done.includes("revokes"));
await page.click("#key-done-close");
check("Done closes the dialog", !(await page.evaluate(() => document.getElementById("add-key-dialog").open)));
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
// --- newcomer guidance, username lookup, timeline rules, empty and error states (fresh browser)
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const ready = () => p.waitForFunction(() => document.getElementById("node-status")?.textContent?.startsWith("Connected"), null, { timeout: 15000 });
  const settled = () => p.waitForFunction(() => !(document.getElementById("feed-meta")?.textContent ?? "").startsWith("Loading") && !document.getElementById("refresh").disabled, null, { timeout: 15000 });
  await p.goto(URL); await ready();
  check("first run shows the How this works explainer", await p.isVisible("#intro") && (await p.textContent("#intro")).includes("Your FID is your account number"));
  await p.click("#intro-done");
  await p.reload(); await ready();
  check("explainer stays dismissed after reload and reopens from How this works", !(await p.isVisible("#intro")) && await p.isVisible("#intro-open"));
  await p.click("#intro-open");
  check("How this works reopens the explainer", await p.isVisible("#intro"));
  await p.click("#fid-help-first > summary");
  check("Where do I find my FID? explains the username lookup", (await p.textContent("#fid-help-first")).includes("type your username instead"));
  await p.fill("#first-fid", "nobody");
  await p.click("#first-show");
  await step(() => p.waitForFunction(() => document.getElementById("first-msg")?.textContent, null, { timeout: 10000 }));
  check("unknown username says so and what to do", (await p.textContent("#first-msg")).includes("No account called @nobody"));
  await p.fill("#first-fid", "@Alice");
  await p.click("#first-show");
  await step(() => p.waitForSelector("#feed .cast", { timeout: 15000 })); await settled();
  check("username @Alice resolves to FID 4242 on the node", (await p.inputValue("#viewer-fid")) === "4242");
  check("timeline rule is stated under the Feed header", await p.isVisible("#feed-rule") && (await p.textContent("#feed-rule")).includes("newest first") && (await p.textContent("#feed-rule")).includes("no ranking"));
  const feedText = () => p.textContent("#feed");
  check("reply to someone you follow shows Replying to @bob", (await feedText()).includes("Carol agrees with Bob") && (await feedText()).includes("Replying to @bob"));
  check("reply to someone you don't follow is hidden and counted", !(await feedText()).includes("Bob replying to Dave") && (await p.textContent("#feed-meta")).includes("1 reply to people you don't follow hidden"));
  const times = await p.$$eval("#feed .cast time", (ts) => ts.map((t) => Date.parse(t.getAttribute("datetime"))));
  check("casts are newest first", times.length > 1 && times.every((t, i) => i === 0 || times[i - 1] >= t), times.length + " casts");
  const before = await p.$$eval("#feed .cast", (c) => c.length);
  const olderVisible = await p.isVisible("#load-older");
  if (olderVisible) { await p.click("#load-older"); await p.waitForFunction((n) => document.querySelectorAll("#feed .cast").length > n, before, { timeout: 10000 }); }
  const after = await p.$$eval("#feed .cast", (c) => c.length);
  check("Load older casts pages castsByFid with pageToken and then hides itself", olderVisible && before === 20 && after === 25 && !(await p.isVisible("#load-older")), `${before} then ${after}`);
  const tokens = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.path === "/v1/castsByFid" && new URLSearchParams(r.query).get("pageToken"));
  check("older pages are requested with the node's nextPageToken", tokens.some((r) => new URLSearchParams(r.query).get("fid") === "10"));
  await p.click("#feed-options > summary");
  await p.check("#all-replies");
  check("Show replies to people I don't follow reveals the hidden reply", (await feedText()).includes("Bob replying to Dave") && (await feedText()).includes("Replying to @dave"));
  for (const [fid, sel, what] of [["10", "#feed-no-follows", "follows nobody: notice says how to read others"], ["13", "#feed-empty", "no casts yet: says what to do"], ["777", "#feed-unknown", "unknown FID: says to check it or use a username"]]) {
    await p.fill("#viewer-fid", fid); await p.click("#apply-feed"); await settled();
    check(what, await p.isVisible(sel), (await p.textContent("#feed-notice")) + (await p.textContent("#feed")).slice(0, 120));
  }
  await p.fill("#viewer-fid", "nobody"); await p.click("#apply-feed");
  await step(() => p.waitForFunction(() => document.getElementById("viewer-fid-hint")?.classList.contains("error"), null, { timeout: 10000 }));
  check("Feed options also takes a username and explains a miss", (await p.textContent("#viewer-fid-hint")).includes("No account called @nobody"));
  await p.route("**/v1/**", (r) => r.abort());
  await p.fill("#viewer-fid", "4242"); await p.click("#apply-feed"); await settled();
  check("node unreachable: says so with Try again and Node connection", await p.isVisible("#feed-down") && await p.isVisible("#retry-feed") && await p.isVisible("#open-node-settings"));
  await p.unroute("**/v1/**");
  await p.click("#retry-feed"); await step(() => p.waitForSelector("#feed .cast", { timeout: 15000 }));
  check("Try again recovers once the node answers", true);
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
