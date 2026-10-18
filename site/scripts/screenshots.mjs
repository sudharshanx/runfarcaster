// SPDX-License-Identifier: MIT
// Screenshots of the built site, reusing the repo's e2e playwright-core install.
// Usage: BASE=http://127.0.0.1:4321/runfarcaster/ CHROME=/usr/bin/google-chrome OUT=/workspace/site-preview node scripts/screenshots.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(new URL("../../e2e/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const BASE = process.env.BASE ?? "http://127.0.0.1:4321/";
const OUT = process.env.OUT ?? "screenshots";
mkdirSync(OUT, { recursive: true });
const pages = [["home", ""], ["quickstart", "quickstart/"], ["tutorial", "tutorial/"], ["hetzner", "hetzner/"], ["proof", "proof/"]];
const views = [["mobile-375", { width: 375, height: 812 }, true], ["desktop", { width: 1440, height: 900 }, false]];

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
let failed = 0;
for (const [vname, viewport, isMobile] of views) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile, colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  for (const [pname, path] of pages) {
    const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const h1 = await page.textContent("h1");
    const ok = res.ok() && overflow <= 0 && errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${vname} ${pname}: HTTP ${res.status()}, horizontal overflow ${overflow}px, h1="${h1?.trim().slice(0, 60)}"${errors.length ? `, errors: ${errors.join(" | ")}` : ""}`);
    await page.screenshot({ path: `${OUT}/${pname}-${vname}.png`, fullPage: false });
    await page.screenshot({ path: `${OUT}/${pname}-${vname}-full.png`, fullPage: true });
    errors.length = 0;
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
