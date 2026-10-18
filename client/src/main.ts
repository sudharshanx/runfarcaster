// SPDX-License-Identifier: MIT
//
// Snapchain read-node web client. No framework; all user/network text is inserted with
// textContent (never innerHTML), and the production CSP (deploy/Caddyfile) only allows
// connections to the same origin, which limits where a compromised dependency could send data.
//
// SECURITY: Only paste a seed phrase into software from developers you trust. Prefer delegated
// signers wherever possible. See src/signer.ts and README.md.
import "./polyfills";
import { getFarcasterTime } from "@farcaster/core";
import { NodeApi } from "./api";
import { forgetAppKey, generateAppKey, loadAppKey, privateKeyBytes, saveAppKey, toStored, type StoredAppKey } from "./appkey";
import { fcTimeToDate, loadFeed, mergeFeed, type FeedCast } from "./feed";
import { addToList, hiddenReason, loadFilters, removeFromList, saveFilters, type Filters } from "./filters";
import { buildCast, buildFollow, buildReaction, signerFromPrivateKey } from "./messages";
import { Reconciler } from "./pending";
import { DEFAULT_TTL_SECONDS, buildKeyAdd, isKeyActive } from "./signer";
import { browserKV, readJSON, writeJSON } from "./storage";

const kv = browserKV();
const SETTINGS_KEY = "settings.v1";
interface Settings { nodeUrl: string; viewerFid: number | null; watchFids: number[] }
const settings: Settings = { nodeUrl: (import.meta.env.VITE_NODE_URL as string | undefined) ?? "", viewerFid: null, watchFids: [1], ...readJSON<Partial<Settings>>(kv, SETTINGS_KEY, {}) };
const api = new NodeApi(settings.nodeUrl);
let filters: Filters = loadFilters(kv);
let appKey: StoredAppKey | null = loadAppKey(kv);
let feed: FeedCast[] = [];

// ---------- tiny DOM helpers (textContent only)
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) el.className = String(cls);
  Object.assign(el, rest);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const $ = (id: string) => document.getElementById(id)!;
const lab = (forId: string, text: string) => h("label", { htmlFor: forId, class: "lbl" }, text);
// The one-time KEY_ADD step should run from a page on your own computer, so no DNS name you do not
// control (e.g. *.sslip.io) is in the trust path for your recovery phrase.
function originNote() {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "";
  return h("div", { class: "warn" }, h("strong", {}, "Address check. "),
    `This page is served from ${host}. Before you paste a recovery phrase, open this app on your own computer instead (http://localhost:5173, see the guide's "Your first cast" page). Then no DNS name you do not control can swap the page.`);
}
const setText = (id: string, t: string) => { $(id).textContent = t; };

const reconciler = new Reconciler(api, kv, Date.now, undefined, () => { renderPending(); renderFeed(); });

// ---------- layout
const app = $("app");
app.append(
  h("h1", {}, "Snapchain read-node client"),
  h("section", {},
    h("h2", {}, "Node"),
    h("div", { id: "node-status", class: "muted" }, "checking…"),
    h("div", { class: "row" },
      lab("node-url", "Node API URL"),
      h("input", { id: "node-url", placeholder: "Node HTTP API URL (empty = same origin, recommended)", value: settings.nodeUrl }),
      h("button", { id: "save-node" }, "Save")),
    h("div", { class: "muted" }, "Served over HTTPS by Caddy on the node, /v1/* is proxied on the same origin. A different URL only works in development (CSP connect-src 'self')."),
  ),
  h("section", {},
    h("h2", {}, "Signer (app key)"),
    h("div", { id: "signer-box" }),
  ),
  h("section", {},
    h("h2", {}, "Post"),
    lab("compose", "Cast text"),
    h("textarea", { id: "compose", rows: 3, maxLength: 320, placeholder: "What's happening? (max 320 bytes)" }),
    h("button", { id: "post" }, "Cast"),
    lab("follow-fid", "FID to follow"),
    h("div", { class: "row" }, h("input", { id: "follow-fid", placeholder: "FID to follow", inputMode: "numeric" }), h("button", { id: "follow" }, "Follow")),
    h("div", { id: "action-msg", class: "muted" }),
  ),
  h("section", {}, h("h2", {}, "Outgoing messages"), h("div", { id: "pending" })),
  h("section", {},
    h("h2", {}, "Filters"),
    h("div", { id: "filters" }),
  ),
  h("section", {},
    h("h2", {}, "Feed"),
    h("div", { class: "row" },
      lab("viewer-fid", "Your FID"),
      h("input", { id: "viewer-fid", inputMode: "numeric", placeholder: "Your FID (feed = people you follow)", value: settings.viewerFid ? String(settings.viewerFid) : "" }),
      lab("watch-fids", "Extra FIDs"),
      h("input", { id: "watch-fids", placeholder: "Extra FIDs, comma separated", value: settings.watchFids.join(",") }),
      h("button", { id: "refresh" }, "Refresh")),
    h("div", { id: "feed-meta", class: "muted" }),
    h("div", { id: "feed" }),
  ),
);

// ---------- node status
async function refreshStatus() {
  try {
    const info = await api.info();
    const delays = (info.shardInfos ?? []).map((s) => `shard ${s.shardId}: ${s.blockDelay}s behind`).join(", ");
    setText("node-status", `Connected. version ${info.version ?? "?"}; ${delays}. A read node is always slightly behind the validators.`);
  } catch (e) {
    setText("node-status", `Node not reachable: ${(e as Error).message}`);
  }
}

$("save-node").addEventListener("click", () => {
  settings.nodeUrl = ($("node-url") as HTMLInputElement).value.trim();
  writeJSON(kv, SETTINGS_KEY, settings);
  location.reload(); // simplest way to rebuild every client bound to the old URL
});

// ---------- signer
function renderSigner() {
  const box = $("signer-box");
  box.replaceChildren();
  if (appKey) {
    box.append(
      h("div", {}, `App key for FID ${appKey.fid}: `, h("code", {}, `${appKey.publicKeyHex.slice(0, 18)}…`), ` (${appKey.status === "active" ? "active" : "waiting for the node to show it"})`),
      h("div", { class: "muted" }, "Scopes: CAST_ADD, REACTION_ADD, LINK_ADD. The key is stored in this browser's localStorage. It expires on its own (sliding TTL) and your custody wallet can revoke it."),
      h("button", { id: "forget-key" }, "Forget app key (delete from this browser)"),
    );
    $("forget-key").addEventListener("click", () => { forgetAppKey(kv); appKey = null; renderSigner(); });
    return;
  }
  const ttlSel = h("select", { id: "ttl" },
    ...[1, 7, 30, 90].map((d) => h("option", { value: String(d * 86400), selected: d * 86400 === DEFAULT_TTL_SECONDS, textContent: `${d} day${d > 1 ? "s" : ""}` })));
  box.append(
    h("div", { class: "warn" },
      h("strong", {}, "Read this first. "),
      "Your seed phrase controls your whole Farcaster account (and any funds in that wallet). Only paste a seed phrase into software from developers you trust. Prefer delegated signers (approving an app key from the wallet that holds your custody key) wherever possible. ",
      "Here the phrase is used once, locally in this tab, to sign a single gasless KEY_ADD (EIP-712, from your custody address) for a new app key. It is then discarded: never stored, never logged, never sent. Only the signed KEY_ADD goes to your node."),
    originNote(),
    lab("seed", "Recovery phrase (test account)"),
    h("textarea", { id: "seed", rows: 2, placeholder: "12-24 word recovery phrase (custody wallet)", autocomplete: "off", spellcheck: false } as Partial<HTMLTextAreaElement>),
    h("div", { class: "row" }, lab("ttl", "App key lifetime (sliding, max 90 days)"), ttlSel),
    h("button", { id: "add-key" }, "Sign one KEY_ADD, then forget the phrase"),
    h("div", { id: "signer-msg", class: "muted" }),
  );
  $("add-key").addEventListener("click", onAddKey);
}

async function onAddKey() {
  const seedEl = $("seed") as HTMLTextAreaElement;
  // Read and immediately clear the field so the phrase is not left in the DOM.
  let phrase: string | null = seedEl.value;
  seedEl.value = "";
  const ttl = Number(($("ttl") as HTMLSelectElement).value);
  const { privateKey } = generateAppKey();
  setText("signer-msg", "Signing KEY_ADD locally…");
  try {
    const res = await buildKeyAdd({ mnemonic: phrase, appPrivateKey: privateKey, api, ttl });
    phrase = null; // drop our reference as early as possible
    setText("signer-msg", `Signed for FID ${res.plan.fid} (nonce ${res.plan.nonce}). Submitting to node…`);
    await api.submitMessage(res.bytes);
    appKey = toStored(res.plan.fid, privateKey);
    saveAppKey(kv, appKey);
    if (!settings.viewerFid) { settings.viewerFid = res.plan.fid; writeJSON(kv, SETTINGS_KEY, settings); }
    renderSigner();
    void waitForKey();
  } catch (e) {
    // Error messages come from our code / @farcaster/core / the node, never contain the phrase.
    setText("signer-msg", `KEY_ADD failed: ${(e as Error).message}`);
  } finally {
    phrase = null;
  }
}

async function waitForKey(maxTries = 30) {
  if (!appKey || appKey.status === "active") return;
  for (let i = 0; i < maxTries && appKey && appKey.status !== "active"; i++) {
    try {
      if (await isKeyActive(api, appKey.fid, appKey.publicKeyHex)) {
        appKey.status = "active"; saveAppKey(kv, appKey); renderSigner(); return;
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (appKey && appKey.status !== "active") {
    setText("action-msg", "The KEY_ADD was accepted for relay but the key is not visible on your node yet. Read nodes have no mempool; if it never appears, forget the key and try again.");
  }
}

// ---------- actions
function requireKey(): { fid: number; signer: ReturnType<typeof signerFromPrivateKey> } | null {
  if (!appKey) { setText("action-msg", "Add an app key first."); return null; }
  return { fid: appKey.fid, signer: signerFromPrivateKey(privateKeyBytes(appKey)) };
}

$("post").addEventListener("click", async () => {
  const k = requireKey(); if (!k) return;
  const el = $("compose") as HTMLTextAreaElement;
  try {
    const m = await buildCast(el.value, k);
    el.value = "";
    await reconciler.add(m);
  } catch (e) { setText("action-msg", (e as Error).message); }
});

$("follow").addEventListener("click", async () => {
  const k = requireKey(); if (!k) return;
  const v = Number(($("follow-fid") as HTMLInputElement).value.trim());
  try { await reconciler.add(await buildFollow(v, k)); setText("action-msg", `Follow ${v} sent.`); }
  catch (e) { setText("action-msg", (e as Error).message); }
});

async function react(kind: "like" | "recast", c: FeedCast) {
  const k = requireKey(); if (!k) return;
  try { await reconciler.add(await buildReaction(kind, { fid: c.fid, hash: c.hash }, k)); }
  catch (e) { setText("action-msg", (e as Error).message); }
}

// ---------- pending
function renderPending() {
  const box = $("pending");
  box.replaceChildren();
  const items = reconciler.list().slice(0, 20);
  if (items.length === 0) { box.append(h("div", { class: "muted" }, "Nothing sent yet.")); return; }
  for (const p of items) {
    const label = p.kind === "cast" ? `cast "${(p.text ?? "").slice(0, 40)}"` : `${p.kind} → FID ${p.target?.fid}`;
    box.append(h("div", { class: "cast" },
      h("span", { class: `status-${p.status}` }, `[${p.status}] `), label,
      h("div", { class: "muted" }, p.note),
      p.status === "failed" ? h("button", { onclick: () => void reconciler.retry(p.hash) }, "Retry") : null,
      p.status === "confirmed" || p.status === "failed" ? h("button", { onclick: () => reconciler.dismiss(p.hash) }, "Dismiss") : null,
    ));
  }
}

// ---------- filters
const LISTS: Array<[keyof Filters, string, string]> = [
  ["mutedFids", "Mute FID", "FID"],
  ["mutedKeywords", "Mute keyword", "keyword"],
  ["includeFids", "Only show FIDs (include)", "FID"],
  ["includeKeywords", "Only show keywords (include)", "keyword"],
];
function renderFilters() {
  const box = $("filters");
  box.replaceChildren(h("div", { class: "muted" }, "Saved in this browser (localStorage). Exclude rules win over include rules."));
  for (const [key, title, ph] of LISTS) {
    const input = h("input", { id: `filter-${key}`, placeholder: ph });
    const add = h("button", {}, "Add");
    add.addEventListener("click", () => {
      const r = addToList(filters, key, input.value);
      if (typeof r === "string") { setText("action-msg", r); return; }
      filters = r; saveFilters(kv, filters); renderFilters(); renderFeed();
    });
    const chips = (filters[key] as Array<string | number>).map((v) =>
      h("span", { class: "chip" }, String(v), " ", h("button", { onclick: () => { filters = removeFromList(filters, key, v); saveFilters(kv, filters); renderFilters(); renderFeed(); } }, "×")));
    box.append(h("div", {}, lab(`filter-${key}`, title), h("div", { class: "row" }, input, add), h("div", {}, ...chips)));
  }
}

// ---------- feed
function renderFeed() {
  const nowFc = getFarcasterTime().unwrapOr(0);
  const merged = mergeFeed(feed, reconciler.list(), nowFc);
  const shown = merged.filter((c) => hiddenReason(c, filters) === null);
  setText("feed-meta", `${shown.length} shown, ${merged.length - shown.length} hidden by filters.`);
  const box = $("feed");
  box.replaceChildren();
  for (const c of shown.slice(0, 100)) {
    box.append(h("div", { class: "cast" },
      h("div", { class: "muted" }, `FID ${c.fid} · ${fcTimeToDate(c.timestamp).toLocaleString()}`,
        c.pending ? h("span", { class: `status-${c.pending.status}` }, ` · ${c.pending.status}`) : null),
      c.text,
      c.pending ? null : h("div", {},
        h("button", { onclick: () => void react("like", c) }, "Like"),
        h("button", { onclick: () => void react("recast", c) }, "Recast"),
        h("button", { onclick: () => { filters = addToList(filters, "mutedFids", String(c.fid)) as Filters; saveFilters(kv, filters); renderFilters(); renderFeed(); } }, "Mute FID")),
    ));
  }
}

async function refreshFeed() {
  const v = ($("viewer-fid") as HTMLInputElement).value.trim();
  settings.viewerFid = /^\d+$/.test(v) ? Number(v) : null;
  settings.watchFids = ($("watch-fids") as HTMLInputElement).value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  writeJSON(kv, SETTINGS_KEY, settings);
  setText("feed-meta", "Loading…");
  feed = await loadFeed(api, settings.viewerFid, settings.watchFids);
  renderFeed();
}
$("refresh").addEventListener("click", () => void refreshFeed());

// ---------- boot
renderSigner(); renderFilters(); renderPending();
void refreshStatus(); void refreshFeed(); void waitForKey();
setInterval(() => void reconciler.tick(), 2000);
setInterval(() => void refreshStatus(), 30000);
