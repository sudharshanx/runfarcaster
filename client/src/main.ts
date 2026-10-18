// SPDX-License-Identifier: MIT
//
// RunFarcaster web client: reads from your own Snapchain read node. No framework; all
// user/network text is inserted with textContent (never innerHTML), and the production CSP
// (deploy/Caddyfile) only allows connections to the same origin, which limits where a compromised
// dependency could send data.
//
// SECURITY: Only paste a seed phrase into software from developers you trust. Prefer delegated
// signers wherever possible. See src/signer.ts and README.md.
import "./polyfills";
import "@fontsource-variable/dm-sans";
import "@fontsource/ibm-plex-mono/400.css";
import { getFarcasterTime } from "@farcaster/core";
import { NodeApi } from "./api";
import { forgetAppKey, generateAppKey, loadAppKey, privateKeyBytes, saveAppKey, toStored, type StoredAppKey } from "./appkey";
import { fcTimeToDate, loadFeed, loadProfiles, mergeFeed, type FeedCast, type Profile } from "./feed";
import { addToList, hiddenReason, loadFilters, removeFromList, saveFilters, type Filters } from "./filters";
import { bytesLeft, linkLabel, nodeHealth, sentence, timeAgo } from "./format";
import { buildCast, buildFollow, buildReaction, signerFromPrivateKey } from "./messages";
import { Reconciler, type PendingItem } from "./pending";
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
const profiles = new Map<number, Profile>();
const MAX_CAST_BYTES = 320;

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
const hint = (id: string, text: string) => h("p", { id, class: "hint" }, text);
const attr = <E extends Element>(el: E, a: Record<string, string>) => { for (const [k, v] of Object.entries(a)) el.setAttribute(k, v); return el; };
const setText = (id: string, t: string) => { $(id).textContent = t; };
const isLocalhost = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// The one-time KEY_ADD step should run from a page on your own computer, so no DNS name you do not
// control (e.g. *.sslip.io) is in the trust path for your recovery phrase.
function originNote() {
  if (isLocalhost()) return "";
  return h("div", { class: "notice notice-warn", id: "address-check" },
    h("p", {}, h("strong", {}, "Check the address. "),
      "This page is on ", h("span", { class: "host" }, location.hostname),
      `. Before you paste your recovery phrase, open the app on your own computer at http://localhost:5317 instead (see "Your first cast" in the guide). Then a domain name you don't control can't swap the page.`));
}

// A short message that appears at the bottom of the screen (errors and confirmations).
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string) {
  const t = $("action-msg");
  t.textContent = sentence(text);
  t.hidden = !text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => { t.hidden = true; t.textContent = ""; }, 7000);
}

const reconciler = new Reconciler(api, kv, Date.now, undefined, () => { renderPending(); renderFeed(); });

// ---------- layout
function wordmark() {
  return h("div", { class: "wordmark" }, attr(h("span", { class: "wordmark-mark" }, "R"), { "aria-hidden": "true" }), h("span", { class: "wordmark-text" }, "RunFarcaster"));
}
function panel(id: string, title: string, ...body: Child[]) {
  return h("details", { id, class: "card panel" }, h("summary", {}, h("span", { id: `${id}-title` }, title)), h("div", { class: "panel-body" }, ...body));
}

const app = $("app");
app.append(
  h("a", { class: "skip", href: "#feed-title" }, "Skip to feed"),
  h("header", { class: "topbar" },
    h("div", { class: "wrap topbar-row" },
      wordmark(),
      h("details", { id: "node-details", class: "node-details" },
        h("summary", {},
          attr(h("span", { id: "node-status", class: "pill" }, attr(h("span", { class: "dot" }), { "aria-hidden": "true" }), attr(h("span", { id: "node-status-text" }, "Checking your node…"), { "aria-live": "polite" })), { "data-state": "checking" }),
          h("span", { class: "details-label" }, "Details")),
        h("div", { class: "popover", id: "node-info" }, h("p", { class: "hint" }, "Checking…"))),
    )),
  h("main", { class: "wrap layout" },
    h("section", { id: "compose-box", class: "card compose" }),
    attr(h("aside", { class: "side" },
      h("section", { id: "appkey-card", class: "card" }),
      h("div", { class: "side-group" },
      panel("follow-panel", "Follow someone",
        lab("follow-fid", "FID to follow"),
        h("div", { class: "row" }, h("input", { id: "follow-fid", inputMode: "numeric", autocomplete: "off" }), h("button", { id: "follow", class: "btn btn-secondary" }, "Follow"))),
      panel("filters-panel", "Filters", h("div", { id: "filters" })),
      panel("pending-panel", "Sent", h("div", { id: "pending" })),
      panel("settings-panel", "Settings",
        lab("node-url", "Node API URL"),
        h("div", { class: "row" },
          attr(h("input", { id: "node-url", placeholder: "Empty: this site (recommended)", value: settings.nodeUrl, autocomplete: "off", spellcheck: false }), { "aria-describedby": "node-url-hint" }),
          h("button", { id: "save-node", class: "btn btn-secondary" }, "Save")),
        hint("node-url-hint", "Caddy on your node serves this app and forwards /v1 requests on the same address. Another URL only works in development, because the page may only connect to its own address (CSP connect-src 'self')."))), ), { "aria-label": "Account and settings" }),
    h("section", { class: "feed" },
      h("div", { class: "feed-head" },
        h("div", {}, h("h1", { id: "feed-title", tabIndex: -1 }, "Feed"), h("p", { id: "feed-meta", class: "hint" })),
        h("button", { id: "refresh", class: "btn btn-secondary" }, "Refresh")),
      h("details", { id: "feed-options", class: "card panel" },
        h("summary", {}, "Feed options"),
        h("div", { class: "panel-body" },
          lab("viewer-fid", "Your FID"),
          attr(h("input", { id: "viewer-fid", inputMode: "numeric", autocomplete: "off", value: settings.viewerFid ? String(settings.viewerFid) : "" }), { "aria-describedby": "viewer-fid-hint" }),
          hint("viewer-fid-hint", "Shows your casts and casts from people you follow."),
          lab("watch-fids", "Also show these FIDs"),
          attr(h("input", { id: "watch-fids", autocomplete: "off", value: settings.watchFids.join(", ") }), { "aria-describedby": "watch-fids-hint" }),
          hint("watch-fids-hint", "Separate FIDs with commas."),
          h("button", { id: "apply-feed", class: "btn btn-secondary" }, "Update feed"))),
      h("div", { id: "feed", class: "feed-list" }),
    ),
  ),
  h("dialog", { id: "add-key-dialog", class: "sheet" }),
  attr(h("div", { id: "action-msg", class: "toast", role: "status", hidden: true }), { "aria-live": "polite" }),
);

// ---------- node status
async function refreshStatus() {
  const pill = $("node-status");
  const info = $("node-info");
  try {
    const i = await api.info();
    const health = nodeHealth(i);
    pill.dataset.state = health;
    setText("node-status-text", health === "ok" ? "Connected to your node" : "Catching up");
    const rows: Child[] = [h("dt", {}, "Version"), h("dd", {}, i.version ?? "unknown")];
    for (const s of i.shardInfos ?? []) rows.push(h("dt", {}, `Shard ${s.shardId}`), h("dd", {}, `${s.blockDelay} s behind`));
    info.replaceChildren(h("dl", {}, ...rows), h("p", { class: "hint" }, "A read node is always slightly behind the validators."));
  } catch (e) {
    pill.dataset.state = "down";
    setText("node-status-text", "Can't reach your node");
    info.replaceChildren(h("p", { class: "hint" }, sentence((e as Error).message)));
  }
}

$("save-node").addEventListener("click", () => {
  settings.nodeUrl = ($("node-url") as HTMLInputElement).value.trim();
  writeJSON(kv, SETTINGS_KEY, settings);
  location.reload(); // simplest way to rebuild every client bound to the old URL
});

// ---------- app key (signer)
function renderSigner() {
  const card = $("appkey-card");
  card.replaceChildren();
  card.hidden = !appKey;
  if (appKey) {
    const active = appKey.status === "active";
    card.append(
      h("div", { class: "card-head" }, h("h2", {}, "App key"),
        attr(h("span", { id: "appkey-state", class: "pill" }, attr(h("span", { class: "dot" }), { "aria-hidden": "true" }), active ? "Active" : "Waiting for your node"), { "data-state": active ? "ok" : "behind" })),
      h("p", { class: "kv" }, h("span", {}, `FID ${appKey.fid}`), h("code", { title: appKey.publicKeyHex }, `${appKey.publicKeyHex.slice(0, 18)}…`)),
      h("p", { class: "hint" }, "This key can post, like, recast and follow. It's saved in this browser and expires on its own. Your wallet can revoke it at any time."),
      h("button", { id: "forget-key", class: "btn btn-secondary btn-block" }, "Remove from this browser"),
    );
    $("forget-key").addEventListener("click", () => { forgetAppKey(kv); appKey = null; renderSigner(); say("App key removed from this browser."); });
  }
  renderComposer();
}

function renderComposer() {
  const box = $("compose-box");
  box.replaceChildren();
  if (!appKey) {
    box.classList.add("empty");
    box.append(
      h("h2", { class: "empty-title" }, "To post, add an app key first."),
      h("p", { class: "hint" }, "An app key lets this app post, like and follow for your account. You can read the feed without one."),
      h("button", { id: "open-add-key", class: "btn" }, "Add app key"),
    );
    $("open-add-key").addEventListener("click", openAddKey);
    return;
  }
  box.classList.remove("empty");
  const ta = attr(h("textarea", { id: "compose", rows: 3, maxLength: MAX_CAST_BYTES }), { "aria-describedby": "compose-count" });
  const count = h("span", { id: "compose-count", class: "hint" });
  const post = h("button", { id: "post", class: "btn" }, "Post");
  const update = () => {
    const left = bytesLeft(ta.value, MAX_CAST_BYTES);
    count.textContent = `${left} bytes left`;
    count.classList.toggle("over", left < 0);
    post.disabled = left < 0;
  };
  ta.addEventListener("input", update);
  update();
  box.append(lab("compose", `New cast as FID ${appKey.fid}`), ta, h("div", { class: "compose-foot" }, count, post));
  post.addEventListener("click", onPost);
}

function openAddKey() {
  const dlg = $("add-key-dialog") as HTMLDialogElement;
  const ttlSel = attr(h("select", { id: "ttl" },
    ...[1, 7, 30, 90].map((d) => h("option", { value: String(d * 86400), selected: d * 86400 === DEFAULT_TTL_SECONDS, textContent: `${d} day${d > 1 ? "s" : ""}` }))), { "aria-describedby": "ttl-hint" });
  const seed = attr(h("textarea", { id: "seed", rows: 3, placeholder: "12 to 24 words", autocomplete: "off", spellcheck: false } as Partial<HTMLTextAreaElement>),
    { autocapitalize: "off", autocorrect: "off", "data-1p-ignore": "", "data-lpignore": "true" });
  dlg.replaceChildren(
    h("div", { class: "sheet-head" },
      h("h2", { id: "add-key-title" }, "Add an app key"),
      attr(h("button", { id: "close-add-key", class: "icon-btn" }, "×"), { "aria-label": "Close" })),
    h("p", {}, "An app key lets this app post for your account. You sign it once with your recovery phrase."),
    h("div", { class: "notice" },
      h("p", {}, "Your recovery phrase controls your whole account. Only paste it into software you trust. This page uses it once to add an app key, then drops it. It never leaves this browser.")),
    originNote(),
    lab("seed", "Recovery phrase"),
    seed,
    lab("ttl", "Key expires after"),
    ttlSel,
    hint("ttl-hint", "Each time the key is used, this time starts again."),
    h("details", { class: "tech" },
      h("summary", {}, "Show technical details"),
      h("p", {}, "Your seed phrase controls your whole Farcaster account (and any funds in that wallet). Only paste a seed phrase into software from developers you trust."),
      h("p", {}, "Prefer delegated signers (approving an app key from the wallet that holds your custody key) wherever possible."),
      h("p", {}, "Here the phrase is used once, locally in this tab, to sign a single gasless KEY_ADD (EIP-712, from your custody address) for a new app key. It is then discarded: never stored, never logged, never sent. Only the signed KEY_ADD goes to your node."),
      h("p", {}, "The app key can sign CAST_ADD, REACTION_ADD and LINK_ADD messages only. It is kept in this browser's localStorage. Its lifetime is a sliding TTL (90 days at most), and your custody wallet can revoke it.")),
    h("div", { id: "signer-msg", class: "hint", role: "status" }),
    h("div", { class: "sheet-actions" },
      h("button", { id: "cancel-add-key", class: "btn btn-secondary" }, "Cancel"),
      h("button", { id: "add-key", class: "btn" }, "Add app key")),
  );
  attr(dlg, { "aria-labelledby": "add-key-title" });
  $("add-key").addEventListener("click", onAddKey);
  $("cancel-add-key").addEventListener("click", () => dlg.close());
  $("close-add-key").addEventListener("click", () => dlg.close());
  dlg.showModal();
  seed.focus();
}
// Whenever the panel closes (Cancel, ×, Escape, or success), clear the phrase field and drop the form.
($("add-key-dialog") as HTMLDialogElement).addEventListener("close", () => {
  const seedEl = document.getElementById("seed") as HTMLTextAreaElement | null;
  if (seedEl) seedEl.value = "";
  $("add-key-dialog").replaceChildren();
});

let adding = false;
async function onAddKey() {
  if (adding) return;
  const seedEl = $("seed") as HTMLTextAreaElement;
  // Read and immediately clear the field so the phrase is not left in the DOM.
  let phrase: string | null = seedEl.value;
  seedEl.value = "";
  const ttl = Number(($("ttl") as HTMLSelectElement).value);
  const { privateKey } = generateAppKey();
  const btn = $("add-key") as HTMLButtonElement;
  adding = true; btn.disabled = true;
  setText("signer-msg", "Signing in this browser…");
  try {
    const res = await buildKeyAdd({ mnemonic: phrase, appPrivateKey: privateKey, api, ttl });
    phrase = null; // drop our reference as early as possible
    setText("signer-msg", `Signed for FID ${res.plan.fid}. Sending to your node…`);
    await api.submitMessage(res.bytes);
    appKey = toStored(res.plan.fid, privateKey);
    saveAppKey(kv, appKey);
    if (!settings.viewerFid) {
      settings.viewerFid = res.plan.fid; writeJSON(kv, SETTINGS_KEY, settings);
      ($("viewer-fid") as HTMLInputElement).value = String(res.plan.fid);
    }
    ($("add-key-dialog") as HTMLDialogElement).close();
    renderSigner();
    say(`App key added for FID ${res.plan.fid}. Waiting for your node to show it.`);
    void waitForKey();
  } catch (e) {
    // Error messages come from our code / @farcaster/core / the node, never contain the phrase.
    const msg = document.getElementById("signer-msg");
    if (msg) { msg.textContent = `Couldn't add the app key: ${(e as Error).message}`; msg.setAttribute("role", "alert"); msg.classList.add("error"); }
  } finally {
    phrase = null;
    adding = false;
    if (document.getElementById("add-key")) btn.disabled = false;
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
    say("Your node accepted the app key but doesn't show it yet. If it never shows up, remove the key and add it again.");
  }
}

// ---------- actions
function requireKey(): { fid: number; signer: ReturnType<typeof signerFromPrivateKey> } | null {
  if (!appKey) { say("Add an app key first."); return null; }
  return { fid: appKey.fid, signer: signerFromPrivateKey(privateKeyBytes(appKey)) };
}

async function onPost() {
  const k = requireKey(); if (!k) return;
  const el = $("compose") as HTMLTextAreaElement;
  try {
    const m = await buildCast(el.value, k);
    el.value = "";
    el.dispatchEvent(new Event("input"));
    await reconciler.add(m);
  } catch (e) { say((e as Error).message); }
}

$("follow").addEventListener("click", async () => {
  const k = requireKey(); if (!k) return;
  const v = Number(($("follow-fid") as HTMLInputElement).value.trim());
  try { await reconciler.add(await buildFollow(v, k)); say(`Follow for FID ${v} sent.`); }
  catch (e) { say((e as Error).message); }
});

async function react(kind: "like" | "recast", c: FeedCast) {
  const k = requireKey(); if (!k) return;
  try { await reconciler.add(await buildReaction(kind, { fid: c.fid, hash: c.hash }, k)); say(kind === "like" ? "Like sent." : "Recast sent."); }
  catch (e) { say((e as Error).message); }
}

// ---------- sent messages
const STATUS_LABEL: Record<PendingItem["status"], string> = {
  sending: "Sending", relayed: "Waiting for a block", retrying: "Retrying", confirmed: "Confirmed", failed: "Failed",
};
function pendingLabel(p: PendingItem) {
  if (p.kind === "cast") return `Cast: "${(p.text ?? "").slice(0, 40)}"`;
  if (p.kind === "follow") return `Follow FID ${p.target?.fid}`;
  return `${p.kind === "like" ? "Like" : "Recast"} on a cast by FID ${p.target?.fid}`;
}
function renderPending() {
  const box = $("pending");
  box.replaceChildren();
  const all = reconciler.list();
  const open = all.filter((p) => p.status !== "confirmed" && p.status !== "failed").length;
  setText("pending-panel-title", open ? `Sent (${open} in progress)` : "Sent");
  const items = all.slice(0, 20);
  if (items.length === 0) { box.append(h("p", { class: "hint" }, "Nothing sent yet.")); return; }
  for (const p of items) {
    box.append(attr(h("div", { class: "sent-item" },
      h("div", { class: "sent-top" }, attr(h("span", { class: `badge status-${p.status}` }, STATUS_LABEL[p.status]), { "data-status": p.status }), h("span", { class: "sent-label" }, pendingLabel(p))),
      h("p", { class: "hint" }, p.note),
      h("div", { class: "row" },
        p.status === "failed" ? h("button", { class: "btn btn-secondary btn-sm", onclick: () => void reconciler.retry(p.hash) }, "Retry") : null,
        p.status === "confirmed" || p.status === "failed" ? h("button", { class: "btn btn-ghost btn-sm", onclick: () => reconciler.dismiss(p.hash) }, "Dismiss") : null),
    ), { "data-status": p.status }));
  }
}

// ---------- filters
const LISTS: Array<[keyof Filters, string, string]> = [
  ["mutedFids", "Mute FID", "FID"],
  ["mutedKeywords", "Mute word", "Word"],
  ["includeFids", "Only show these FIDs", "FID"],
  ["includeKeywords", "Only show casts with these words", "Word"],
];
function renderFilters() {
  const box = $("filters");
  box.replaceChildren(h("p", { class: "hint" }, "Saved in this browser. Mute rules win over \"only show\" rules."));
  let total = 0;
  for (const [key, title, ph] of LISTS) {
    const input = h("input", { id: `filter-${key}`, placeholder: ph, autocomplete: "off" });
    const add = h("button", { class: "btn btn-secondary" }, "Add");
    const submit = () => {
      const r = addToList(filters, key, input.value);
      if (typeof r === "string") { say(r); return; }
      filters = r; saveFilters(kv, filters); renderFilters(); renderFeed();
      ($(`filter-${key}`) as HTMLInputElement).focus();
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
    const values = filters[key] as Array<string | number>;
    total += values.length;
    const chips = values.map((v) =>
      h("span", { class: "chip" }, String(v),
        attr(h("button", { class: "chip-x", onclick: () => { filters = removeFromList(filters, key, v); saveFilters(kv, filters); renderFilters(); renderFeed(); } }, "×"), { "aria-label": `Remove ${v}` })));
    box.append(h("div", { class: "filter" }, lab(`filter-${key}`, title), h("div", { class: "row" }, input, add), chips.length ? h("div", { class: "chips" }, ...chips) : null));
  }
  setText("filters-panel-title", total ? `Filters (${total})` : "Filters");
}

// ---------- feed
function initials(name: string) { return (name.replace(/^@/, "").trim()[0] ?? "?").toUpperCase(); }
function castCard(c: FeedCast) {
  const p = profiles.get(c.fid) ?? {};
  const name = p.displayName ?? p.username ?? `FID ${c.fid}`;
  const date = fcTimeToDate(c.timestamp);
  const card = attr(h("article", { class: "cast" },
    attr(h("div", { class: "avatar" }, initials(name)), { "aria-hidden": "true", "data-hue": String(c.fid % 6) }),
    h("div", { class: "cast-body" },
      h("div", { class: "cast-head" },
        h("span", { class: "cast-name" }, name),
        p.username ? h("span", { class: "cast-handle" }, `@${p.username}`) : null,
        p.displayName || p.username ? h("span", { class: "cast-fid" }, `FID ${c.fid}`) : null,
        h("span", { class: "cast-sep" }, "·"),
        attr(h("time", { dateTime: date.toISOString(), title: date.toLocaleString() }, c.pending ? "now" : timeAgo(date)), {})),
      c.text ? h("p", { class: "cast-text" }, c.text) : null,
      c.embeds?.length ? h("div", { class: "embeds" }, ...c.embeds.map((e) => {
        if (e.castFid !== undefined) return h("span", { class: "embed" }, `Quotes a cast by FID ${e.castFid}`);
        const l = linkLabel(e.url ?? "");
        return l ? h("a", { class: "embed", href: l.href, target: "_blank", rel: "noopener noreferrer" }, l.label) : null;
      })) : null,
      c.pending
        ? attr(h("span", { class: `badge status-${c.pending.status}` }, STATUS_LABEL[c.pending.status]), { "data-status": c.pending.status })
        : h("div", { class: "cast-actions" },
          attr(h("button", { class: "btn btn-ghost btn-sm", onclick: () => void react("like", c) }, "Like"), { "aria-label": `Like cast by ${name}` }),
          attr(h("button", { class: "btn btn-ghost btn-sm", onclick: () => void react("recast", c) }, "Recast"), { "aria-label": `Recast cast by ${name}` }),
          attr(h("button", { class: "btn btn-ghost btn-sm", onclick: () => { filters = addToList(filters, "mutedFids", String(c.fid)) as Filters; saveFilters(kv, filters); renderFilters(); renderFeed(); say(`Muted FID ${c.fid}. Undo under Filters.`); } }, "Mute"), { "aria-label": `Mute FID ${c.fid}` })),
    )), { "data-fid": String(c.fid) });
  return card;
}

let loading = false;
function renderFeed() {
  const nowFc = getFarcasterTime().unwrapOr(0);
  const merged = mergeFeed(feed, reconciler.list(), nowFc);
  const shown = merged.filter((c) => hiddenReason(c, filters) === null);
  const hidden = merged.length - shown.length;
  if (!loading) setText("feed-meta", `${shown.length} ${shown.length === 1 ? "cast" : "casts"}${hidden ? `, ${hidden} hidden by filters` : ""}`);
  const box = $("feed");
  box.replaceChildren();
  if (shown.length === 0 && !loading) {
    box.append(h("div", { class: "card empty" },
      h("p", { class: "empty-title" }, hidden ? "Your filters hide every cast." : "No casts to show yet."),
      h("p", { class: "hint" }, hidden ? "Open Filters to change them." : "Open Feed options to add your FID or other FIDs.")));
    return;
  }
  for (const c of shown.slice(0, 100)) box.append(castCard(c));
}

// Only the newest refresh may set the feed: the boot load (default FIDs) can finish after a
// refresh the user started, and must not overwrite it.
let feedGen = 0;
async function refreshFeed() {
  const v = ($("viewer-fid") as HTMLInputElement).value.trim();
  settings.viewerFid = /^\d+$/.test(v) ? Number(v) : null;
  settings.watchFids = ($("watch-fids") as HTMLInputElement).value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  writeJSON(kv, SETTINGS_KEY, settings);
  setText("feed-meta", "Loading…");
  const gen = ++feedGen;
  loading = true;
  const btn = $("refresh") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const loaded = await loadFeed(api, settings.viewerFid, settings.watchFids);
    if (gen !== feedGen) return;
    feed = loaded;
    // Names first, then render once, so cards do not jump from "FID 3" to a name.
    const missing = [...new Set(loaded.map((c) => c.fid))].filter((f) => !profiles.has(f));
    for (const [fid, p] of await loadProfiles(api, missing)) profiles.set(fid, p);
  } finally {
    if (gen === feedGen) { loading = false; btn.disabled = false; renderFeed(); }
  }
}
$("refresh").addEventListener("click", () => void refreshFeed());
$("apply-feed").addEventListener("click", () => void refreshFeed());
for (const id of ["viewer-fid", "watch-fids"]) $(id).addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") void refreshFeed(); });

// Side panels start open on wide screens and closed on phones, where the feed comes first.
if (window.matchMedia("(min-width: 960px)").matches) for (const id of ["filters-panel", "pending-panel"]) ($(id) as HTMLDetailsElement).open = true;

// ---------- boot
renderSigner(); renderFilters(); renderPending();
void refreshStatus(); void refreshFeed(); void waitForKey();
setInterval(() => void reconciler.tick(), 2000);
setInterval(() => void refreshStatus(), 30000);
