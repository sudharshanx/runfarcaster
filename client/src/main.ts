// SPDX-License-Identifier: MIT
//
// RunFarcaster web client: reads from your own Snapchain read node. No framework; all
// user/network text is inserted with textContent (never innerHTML), and the production CSP
// (deploy/Caddyfile) only allows connections to the same origin, which limits where a compromised
// dependency could send data.
//
// SECURITY: Only paste a seed phrase into software from developers you trust. Prefer delegated
// signers wherever possible. See src/signer.ts and README.md.
import "@fontsource-variable/dm-sans";
import "@fontsource/ibm-plex-mono/400.css";
import { NodeApi } from "./api";
import { forgetAppKey, loadAppKey, saveAppKey, type StoredAppKey } from "./appkey";
import { FARCASTER_EPOCH_MS, SAMPLE_ACCOUNTS, fcTimeToDate, loadProfiles, loadSampleFeed, mergeFeed, type FeedCast, type Profile } from "./feed";
import { AppIndex } from "./apps";
import { explainKeyError, lookupMessage, resolveFid } from "./help";
import { countNew, hasOlder, loadOlder, startTimeline, timelineView, type Timeline } from "./timeline";
import { IMAGE_HOSTS, allowedImageUrl, imagesLocked, lockImages } from "./images";
import { addToList, hiddenReason, loadFilters, removeFromList, saveFilters, type Filters } from "./filters";
import { bytesLeft, embedKind, hostOf, linkLabel, nodeHealth, sentence, timeAgo } from "./format";
import { icon, type IconName } from "./icons";
import { Reconciler, type PendingItem } from "./pending";
import { browserKV, readJSON, writeJSON } from "./storage";

// The signing code (src/write.ts) is a separate chunk, loaded on first need.
let writeMod: Promise<typeof import("./write")> | null = null;
const loadWrite = () => (writeMod ??= import("./write"));

const kv = browserKV();
const SETTINGS_KEY = "settings.v1";
interface Settings { nodeUrl: string; viewerFid: number | null; watchFids: number[]; sample?: boolean; allReplies?: boolean; introDone?: boolean; noPictures?: boolean }
const settings: Settings = { nodeUrl: (import.meta.env.VITE_NODE_URL as string | undefined) ?? "", viewerFid: null, watchFids: [], ...readJSON<Partial<Settings>>(kv, SETTINGS_KEY, {}) };
const api = new NodeApi(settings.nodeUrl);
let filters: Filters = loadFilters(kv);
let appKey: StoredAppKey | null = loadAppKey(kv);
let feed: FeedCast[] = [];
const profiles = new Map<number, Profile>();
const apps = new AppIndex(api, kv);
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
      `. Before you paste your recovery phrase, open the app on your own computer at http://localhost:5317 instead (see "Post with an app key" in the guide). Then a domain name you don't control can't swap the page.`));
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

const lastStatus = new Map<string, PendingItem["status"]>();
const reconciler = new Reconciler(api, kv, Date.now, undefined, () => {
  for (const p of reconciler.list()) {
    const before = lastStatus.get(p.hash);
    if (before && before !== "failed" && p.status === "failed") say(p.kind === "cast" ? "Your cast wasn't posted. Open it in the feed to retry." : "Something you sent failed. See Settings, Sent to retry.");
    lastStatus.set(p.hash, p.status);
  }
  renderPending(); renderFeed();
});

// ---------- layout
function wordmark() {
  return h("div", { class: "wordmark" }, attr(h("span", { class: "wordmark-mark" }, "R"), { "aria-hidden": "true" }), h("span", { class: "wordmark-text" }, "RunFarcaster"));
}
function panel(id: string, title: string, ...body: Child[]) {
  return h("details", { id, class: "card panel" }, h("summary", {}, h("span", { id: `${id}-title` }, title)), h("div", { class: "panel-body" }, ...body));
}

function fidHelp(where: string) {
  return h("details", { class: "tech fid-help", id: `fid-help-${where}` },
    h("summary", {}, "Where do I find my FID?"),
    h("p", {}, "You don't need to: type your username instead (the name after the @ on your profile, like dwr) and this page looks up the FID on your node. Names that end in .eth work too."),
    h("p", {}, "An FID is the number Farcaster gives every account when it is created. It never changes, even if you change your username."));
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
    attr(h("aside", { class: "side", id: "side" },
      h("h1", { class: "side-title", id: "side-title", tabIndex: -1 }, "Settings"),
      h("section", { id: "appkey-card", class: "card" }),
      h("div", { class: "side-group" },
      panel("follow-panel", "Follow someone",
        lab("follow-fid", "FID to follow"),
        h("div", { class: "row" }, h("input", { id: "follow-fid", inputMode: "numeric", autocomplete: "off" }), h("button", { id: "follow", class: "btn btn-secondary" }, "Follow"))),
      panel("filters-panel", "Filters", h("div", { id: "filters" }), h("div", { id: "app-filters", class: "filter" })),
      panel("pending-panel", "Sent", h("div", { id: "pending" })),
      panel("settings-panel", "Node connection",
        lab("node-url", "Node API URL"),
        h("div", { class: "row" },
          attr(h("input", { id: "node-url", placeholder: "Empty: this site (recommended)", value: settings.nodeUrl, autocomplete: "off", spellcheck: false }), { "aria-describedby": "node-url-hint" }),
          h("button", { id: "save-node", class: "btn btn-secondary" }, "Save")),
        hint("node-url-hint", "Caddy on your node serves this app and forwards /v1 requests on the same address. Another URL only works in development, because the page may only connect to its own address (CSP connect-src 'self')."),
        h("label", { class: "check" },
          attr(h("input", { type: "checkbox", id: "show-pictures", checked: !settings.noPictures }), { "aria-describedby": "pictures-hint" }),
          h("span", {}, "Show profile pictures and images")),
        hint("pictures-hint", `Feed data comes only from your node. Pictures are the exception: they load from ${IMAGE_HOSTS.join(", ")}, which see your IP address (no referrer is sent). Turn this off to load nothing from them.`))), ), { "aria-label": "Account and settings" }),
    h("section", { class: "feed" },
      h("div", { id: "intro", class: "card intro", hidden: true },
        h("h2", {}, "How this works"),
        h("ul", {},
          h("li", {}, "RunFarcaster reads Farcaster posts from your own node. Only pictures come from elsewhere: a few public image hosts, which you can turn off in Settings."),
          h("li", {}, "Your FID is your account number. Enter it, or your username, to see your feed."),
          h("li", {}, "To post, like or follow, you add an app key once. Reading needs nothing.")),
        h("button", { id: "intro-done", class: "btn btn-secondary btn-sm" }, "Got it")),
      h("div", { class: "feed-head" },
        h("div", {}, h("h1", { id: "feed-title", tabIndex: -1 }, "Feed"), h("p", { id: "feed-meta", class: "hint" })),
        h("div", { class: "feed-head-actions" },
          h("button", { id: "intro-open", class: "btn btn-ghost btn-sm", hidden: true }, "How this works"),
          h("button", { id: "refresh", class: "btn btn-secondary" }, "Refresh"))),
      h("p", { id: "feed-rule", class: "hint feed-rule", hidden: true }, "Following: casts from you and the accounts you follow, newest first. Read from your node, with no ranking."),
      h("details", { id: "feed-options", class: "card panel" },
        h("summary", {}, "Feed options"),
        h("div", { class: "panel-body" },
          lab("viewer-fid", "Your FID or username"),
          attr(h("input", { id: "viewer-fid", autocomplete: "off", spellcheck: false, value: settings.viewerFid ? String(settings.viewerFid) : "" }), { "aria-describedby": "viewer-fid-hint", autocapitalize: "off" }),
          hint("viewer-fid-hint", "Shows your casts and casts from people you follow."),
          fidHelp("options"),
          h("label", { class: "check" },
            h("input", { type: "checkbox", id: "all-replies", checked: !!settings.allReplies }),
            h("span", {}, "Show replies to people I don't follow")),
          lab("watch-fids", "Also show these FIDs"),
          attr(h("input", { id: "watch-fids", autocomplete: "off", value: settings.watchFids.join(", ") }), { "aria-describedby": "watch-fids-hint" }),
          hint("watch-fids-hint", "Separate FIDs with commas."),
          h("button", { id: "apply-feed", class: "btn btn-secondary" }, "Update feed"))),
      h("div", { id: "sample-note", class: "notice sample-note", hidden: true },
        h("p", {}, h("strong", {}, "Sample feed. "), SAMPLE_ACCOUNTS.map((a) => a.fname).join(", "), "."),
        h("button", { id: "leave-sample", class: "btn btn-secondary btn-sm" }, "Use my FID instead")),
      h("div", { id: "feed-notice" }),
      h("div", { id: "feed", class: "feed-list" }),
      h("div", { class: "load-older" }, h("button", { id: "load-older", class: "btn btn-secondary", hidden: true }, "Load older casts")),
    ),
  ),
  attr(h("nav", { class: "tabbar" },
    attr(h("button", { id: "tab-feed", class: "tab" }, icon("house", 22), h("span", {}, "Feed")), { "data-view": "feed" }),
    h("button", { id: "tab-post", class: "tab" }, icon("pen", 22), h("span", {}, "Post")),
    attr(h("button", { id: "tab-settings", class: "tab" }, icon("settings", 22), h("span", {}, "Settings")), { "data-view": "settings" })), { "aria-label": "Sections" }),
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
let keyGaveUp = false; // waitForKey finished without seeing the key on the node
function renderSigner() {
  const card = $("appkey-card");
  card.replaceChildren();
  card.classList.toggle("only-mobile", !appKey);
  if (!appKey) {
    card.append(h("div", { class: "card-head" }, h("h2", {}, "App key")),
      h("p", { class: "hint" }, "No app key in this browser yet. You need one to post, like or follow. Reading works without it."),
      h("button", { id: "open-add-key-side", class: "btn btn-secondary btn-block" }, "Add app key"));
    $("open-add-key-side").addEventListener("click", openAddKey);
  }
  if (appKey) {
    const active = appKey.status === "active";
    card.append(
      h("div", { class: "card-head" }, h("h2", {}, "App key"),
        attr(h("span", { id: "appkey-state", class: "pill" }, attr(h("span", { class: "dot" }), { "aria-hidden": "true" }), active ? "Active" : keyGaveUp ? "Not confirmed" : "Waiting for your node"), { "data-state": active ? "ok" : keyGaveUp ? "down" : "behind" })),
      h("p", { class: "kv" }, h("span", {}, `FID ${appKey.fid}`), h("code", { title: appKey.publicKeyHex }, `${appKey.publicKeyHex.slice(0, 18)}…`)),
      ...(active ? [] : [attr(h("p", { id: "appkey-wait", class: keyGaveUp ? "hint error" : "hint" },
        keyGaveUp
          ? "Your node still doesn't show this key. Check that your node is in sync (Details, at the top), then remove the key and add it again."
          : "Your node accepted the key. This page checks every few seconds until your node shows it. You can post once it says Active."), keyGaveUp ? { role: "alert" } : {})]),
      h("p", { class: "hint" }, "This key can post, like, recast and follow. It's saved in this browser and expires on its own. Your account's wallet can revoke it at any time."),
      h("button", { id: "forget-key", class: "btn btn-secondary btn-block" }, "Remove from this browser"),
    );
    $("forget-key").addEventListener("click", () => { forgetAppKey(kv); appKey = null; keyGaveUp = false; renderSigner(); say("App key removed from this browser. It stays valid until it expires or your wallet revokes it."); });
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
      h("p", { class: "hint" }, "An app key lets this app post, like and follow for your account. It takes four short steps. You can read the feed without one."),
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

// Add an app key: four steps in one dialog. Only step 3 has the phrase field, and every way out of
// the dialog (Cancel, ×, Escape, Back, Done) removes it.
const STEPS = ["About", "Before you start", "Sign", "Done"] as const;
function stepHeader(n: number, title: string) {
  return [
    h("div", { class: "sheet-head" },
      h("h2", { id: "add-key-title", tabIndex: -1 }, title),
      attr(h("button", { id: "close-add-key", class: "icon-btn" }, "×"), { "aria-label": "Close" })),
    attr(h("ol", { class: "stepper" }, ...STEPS.map((label, i) =>
      attr(h("li", { class: i < n - 1 ? "done" : "" }, h("span", { class: "step-n" }, String(i + 1)), h("span", { class: "step-label" }, label)),
        i === n - 1 ? { "aria-current": "step" } : {}))), { "aria-label": `Step ${n} of ${STEPS.length}` }),
  ];
}
async function showStep(n: 1 | 2 | 3 | 4, fid?: number, ttlDays?: number) {
  const { DEFAULT_TTL_SECONDS } = n === 3 ? await loadWrite() : { DEFAULT_TTL_SECONDS: 0 };
  const dlg = $("add-key-dialog") as HTMLDialogElement;
  const old = document.getElementById("seed") as HTMLTextAreaElement | null;
  if (old) old.value = ""; // leaving step 3 drops anything typed
  const cancel = () => h("button", { id: "cancel-add-key", class: "btn btn-secondary" }, "Cancel");
  const back = (to: 1 | 2) => { const b = h("button", { id: "step-back", class: "btn btn-secondary" }, "Back"); b.addEventListener("click", () => void showStep(to)); return b; };
  const next = (to: 2 | 3, label: string) => { const b = h("button", { id: "step-next", class: "btn" }, label); b.addEventListener("click", () => void showStep(to)); return b; };
  if (n === 1) {
    dlg.replaceChildren(...stepHeader(1, "What an app key is"),
      attr(h("div", { id: "step-about", class: "step-body" },
        h("p", {}, "An app key is a separate key that this app keeps in this browser. With it, the app can post, like, recast and follow for your account."),
        h("ul", { class: "facts" },
          h("li", {}, "It can't move funds, and it can't change who owns the account."),
          h("li", {}, "It never gets your recovery phrase."),
          h("li", {}, "You can remove it here, and your account's wallet can revoke it at any time.")),
        h("p", { class: "hint" }, "You add it once. After that, posting works like in any other app.")), {}),
      h("div", { class: "sheet-actions" }, cancel(), next(2, "Next")));
  } else if (n === 2) {
    dlg.replaceChildren(...stepHeader(2, "Before you start"),
      h("div", { id: "step-needs", class: "step-body" },
        h("p", {}, "You need one thing: your recovery phrase. That's the 12 to 24 words for the wallet that owns your Farcaster account."),
        h("p", {}, settings.viewerFid
          ? `You don't type your FID: this page reads it from the phrase. Your feed is set to FID ${settings.viewerFid}; the key goes to whichever account the phrase owns.`
          : "You don't type your FID: this page reads it from the phrase."),
        h("div", { class: "notice notice-warn", id: "phrase-warning" },
          h("p", {}, h("strong", {}, "Read this first. "), "Your recovery phrase controls your whole account. Only paste it into software from developers you trust. If your Farcaster app can approve app keys for you (a delegated signer), use that instead, so the phrase never leaves your wallet.")),
        h("p", {}, "What happens next: this page uses the phrase once, in this browser, to sign one free (gasless) KEY_ADD message for the new key. It sends only that signed message to your node, then clears the field and keeps no copy."),
        originNote()),
      h("div", { class: "sheet-actions" }, back(1), next(3, "I understand, continue")));
  } else if (n === 3) {
    const ttlSel = attr(h("select", { id: "ttl" },
      ...[1, 7, 30, 90].map((d) => h("option", { value: String(d * 86400), selected: d * 86400 === DEFAULT_TTL_SECONDS, textContent: `${d} day${d > 1 ? "s" : ""}` }))), { "aria-describedby": "ttl-hint" });
    const seed = attr(h("textarea", { id: "seed", rows: 3, placeholder: "12 to 24 words", autocomplete: "off", spellcheck: false } as Partial<HTMLTextAreaElement>),
      { autocapitalize: "off", autocorrect: "off", "data-1p-ignore": "", "data-lpignore": "true", "aria-describedby": "seed-hint" });
    dlg.replaceChildren(...stepHeader(3, "Sign and send"),
      h("div", { class: "step-body" },
        h("div", { class: "notice" },
          h("p", {}, "Your recovery phrase controls your whole account. Only paste it into software you trust. This page uses it once to add an app key, then drops it. It never leaves this browser.")),
        lab("seed", "Recovery phrase"),
        seed,
        hint("seed-hint", "Separate the words with spaces. Capital letters don't matter."),
        lab("ttl", "Key expires after"),
        ttlSel,
        hint("ttl-hint", "Each time the key is used, this time starts again."),
        h("details", { class: "tech" },
          h("summary", {}, "Show technical details"),
          h("p", {}, "Your seed phrase controls your whole Farcaster account (and any funds in that wallet). Only paste a seed phrase into software from developers you trust."),
          h("p", {}, "Prefer delegated signers (approving an app key from the wallet that holds your custody key) wherever possible."),
          h("p", {}, "Here the phrase is used once, locally in this tab, to sign a single gasless KEY_ADD (EIP-712, from your custody address) for a new app key. It is then discarded: never stored, never logged, never sent. Only the signed KEY_ADD goes to your node."),
          h("p", {}, "The app key can sign CAST_ADD, REACTION_ADD and LINK_ADD messages only. It is kept in this browser's localStorage. Its lifetime is a sliding TTL (90 days at most), and your custody wallet can revoke it.")),
        h("div", { id: "signer-msg", class: "hint", role: "status" })),
      h("div", { class: "sheet-actions" }, back(2), h("button", { id: "add-key", class: "btn" }, "Add app key")));
    $("add-key").addEventListener("click", onAddKey);
  } else {
    dlg.replaceChildren(...stepHeader(4, "App key added"),
      h("div", { id: "key-done", class: "step-body" },
        h("p", {}, `Your node accepted the new key for FID ${fid}. The App key card shows Active once your node lists it, usually after a short wait. Then you can post.`),
        h("h3", {}, "To stop using it later"),
        h("ul", { class: "facts" },
          h("li", {}, "Remove from this browser (Settings, App key) deletes the copy here."),
          h("li", {}, `The key itself stays valid until it goes ${ttlDays} day${ttlDays === 1 ? "" : "s"} without use, or until your account's wallet revokes it. This app can't revoke keys yet.`)),
        h("p", { class: "hint" }, "Your recovery phrase is no longer on this page.")),
      h("div", { class: "sheet-actions" },
        h("button", { id: "key-done-close", class: "btn btn-secondary" }, "Close"),
        h("button", { id: "key-done-post", class: "btn" }, "Write a cast")));
    $("key-done-close").addEventListener("click", () => dlg.close());
    $("key-done-post").addEventListener("click", () => { dlg.close(); setView("feed"); window.scrollTo({ top: 0 }); document.getElementById("compose")?.focus(); });
  }
  document.getElementById("cancel-add-key")?.addEventListener("click", () => dlg.close());
  $("close-add-key").addEventListener("click", () => dlg.close());
  attr(dlg, { "aria-labelledby": "add-key-title" });
  (document.getElementById("seed") ?? $("add-key-title")).focus();
}
function openAddKey() {
  // No image request may leave the page while a recovery phrase can be in it (see src/images.ts).
  lockImages();
  void loadWrite(); // fetch the signing code while the first steps are read
  const dlg = $("add-key-dialog") as HTMLDialogElement;
  void showStep(1);
  dlg.showModal();
  $("add-key-title").focus();
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
  const btn = $("add-key") as HTMLButtonElement;
  adding = true; btn.disabled = true;
  setText("signer-msg", "Signing in this browser…");
  try {
    const { generateAppKey, buildKeyAdd, toStored } = await loadWrite();
    const { privateKey } = generateAppKey();
    const res = await buildKeyAdd({ mnemonic: phrase, appPrivateKey: privateKey, api, ttl });
    phrase = null; // drop our reference as early as possible
    setText("signer-msg", `Signed for FID ${res.plan.fid}. Sending to your node…`);
    await api.submitMessage(res.bytes);
    appKey = toStored(res.plan.fid, privateKey);
    saveAppKey(kv, appKey);
    keyGaveUp = false;
    let feedChanged = false;
    if (!settings.viewerFid) {
      settings.viewerFid = res.plan.fid; settings.sample = false; writeJSON(kv, SETTINGS_KEY, settings);
      ($("viewer-fid") as HTMLInputElement).value = String(res.plan.fid);
      feedChanged = true;
    }
    await showStep(4, res.plan.fid, Math.round(ttl / 86400)); // replaces step 3, so the phrase field is gone
    renderSigner();
    if (feedChanged) void refreshFeed();
    void waitForKey();
  } catch (e) {
    // Error messages come from our code / @farcaster/core / the node, never contain the phrase.
    const msg = document.getElementById("signer-msg");
    if (msg) { msg.textContent = explainKeyError((e as Error).message); msg.setAttribute("role", "alert"); msg.classList.add("error"); }
  } finally {
    phrase = null;
    adding = false;
    if (document.getElementById("add-key")) btn.disabled = false;
  }
}

async function waitForKey(maxTries = 30) {
  if (!appKey || appKey.status === "active") return;
  const { isKeyActive } = await loadWrite();
  for (let i = 0; i < maxTries && appKey && appKey.status !== "active"; i++) {
    try {
      if (await isKeyActive(api, appKey.fid, appKey.publicKeyHex)) {
        appKey.status = "active"; saveAppKey(kv, appKey); renderSigner(); say("Your app key is active. You can post now."); return;
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (appKey && appKey.status !== "active") { keyGaveUp = true; renderSigner(); }
}

// ---------- actions
async function requireKey() {
  if (!appKey) { say("Add an app key first."); return null; }
  const w = await loadWrite();
  return { fid: appKey.fid, signer: w.signerFromPrivateKey(w.privateKeyBytes(appKey)), w };
}

async function onPost() {
  const k = await requireKey(); if (!k) return;
  const el = $("compose") as HTMLTextAreaElement;
  try {
    const m = await k.w.buildCast(el.value, k);
    el.value = "";
    el.dispatchEvent(new Event("input"));
    await reconciler.add(m);
  } catch (e) { say((e as Error).message); }
}

$("follow").addEventListener("click", async () => {
  const k = await requireKey(); if (!k) return;
  const v = Number(($("follow-fid") as HTMLInputElement).value.trim());
  try { await reconciler.add(await k.w.buildFollow(v, k)); say(`Follow for FID ${v} sent.`); }
  catch (e) { say((e as Error).message); }
});

async function react(kind: "like" | "recast", c: FeedCast) {
  const k = await requireKey(); if (!k) return;
  try { await reconciler.add(await k.w.buildReaction(kind, { fid: c.fid, hash: c.hash }, k)); say(kind === "like" ? "Like sent." : "Recast sent."); }
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
  total += filters.hideApps.length + filters.includeApps.length;
  setText("filters-panel-title", total ? `Filters (${total})` : "Filters");
}

// "Posted with": hide an app, or show only some apps. Lists the apps in the loaded feed plus any app
// that already has a rule.
function setAppRule(list: "hideApps" | "includeApps", app: number, on: boolean) {
  const other = list === "hideApps" ? "includeApps" : "hideApps";
  let f = removeFromList(filters, other, app); // an app is either hidden or "only", not both
  f = on ? addToList(f, list, String(app)) as Filters : removeFromList(f, list, app);
  filters = f; saveFilters(kv, filters); renderFilters(); renderFeed();
}
function renderAppFilters(casts: FeedCast[]) {
  const box = $("app-filters");
  const counts = new Map<number, number>();
  let unknown = 0;
  for (const c of casts) { const a = apps.appOf(c); if (typeof a === "number") counts.set(a, (counts.get(a) ?? 0) + 1); else if (a === null) unknown++; }
  for (const a of [...filters.hideApps, ...filters.includeApps]) if (!counts.has(a)) counts.set(a, 0);
  const rows = [...counts].sort((x, y) => y[1] - x[1]).map(([app, n]) => {
    const hidden = filters.hideApps.includes(app), only = filters.includeApps.includes(app);
    const name = appName(app);
    const toggle = (list: "hideApps" | "includeApps", label: string, on: boolean) =>
      attr(h("button", { class: `btn btn-sm ${on ? "" : "btn-secondary"}`.trim(), onclick: () => setAppRule(list, app, !on) }, label), { "aria-pressed": String(on), "aria-label": `${label} ${name}` });
    return attr(h("li", { class: "app-row" },
      h("span", { class: "app-name" }, name, h("span", { class: "hint" }, ` ${n} ${n === 1 ? "cast" : "casts"}`)),
      h("span", { class: "app-btns" }, toggle("includeApps", "Only", only), toggle("hideApps", "Hide", hidden))), { "data-app": String(app) });
  });
  box.replaceChildren(
    h("p", { class: "lbl", id: "app-filters-title" }, "Posted with"),
    h("p", { class: "hint" }, "Each cast is signed by an app key, and your node records which app asked for that key. Hide an app, or pick Only to show just those apps."),
    rows.length ? attr(h("ul", { class: "app-list" }, ...rows), { "aria-labelledby": "app-filters-title" }) : h("p", { class: "hint" }, "Apps show up here once the feed has loaded."),
    ...(unknown ? [h("p", { class: "hint" }, `${unknown} ${unknown === 1 ? "cast was" : "casts were"} signed with a key your node no longer lists (unknown app).${filters.includeApps.length ? " Only rules hide them." : ""}`)] : []));
}

// ---------- feed
function initials(name: string) { return (name.replace(/^@/, "").trim()[0] ?? "?").toUpperCase(); }
/** A remote image (allowed hosts only, see src/images.ts); calls onFail and removes itself if it can't load. */
function remoteImg(url: string, cls: string, size: { width: number; height: number }, onFail: (img: HTMLImageElement) => void) {
  const img = h("img", { className: cls, src: url, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", width: size.width, height: size.height });
  img.addEventListener("error", () => onFail(img), { once: true });
  return img;
}
function avatar(fid: number, name: string, pfp: string | undefined) {
  const box = attr(h("div", { class: "avatar" }, initials(name)), { "aria-hidden": "true", "data-hue": String(fid % 6) });
  const url = imagesLocked() || settings.noPictures ? null : allowedImageUrl(pfp);
  if (url) box.append(remoteImg(url, "avatar-img", { width: 44, height: 44 }, (img) => img.remove()));
  return box;
}
function embedChip(e: NonNullable<FeedCast["embeds"]>[number], allowThumb = true): HTMLElement | null {
  if (e.castFid !== undefined) return h("span", { class: "embed" }, icon("quote", 15), `Quotes a cast by FID ${e.castFid}`);
  // http(s) links only. Only images on the allowed hosts are shown inline (src/images.ts).
  const l = linkLabel(e.url ?? "");
  if (!l) return null;
  const kind = embedKind(l.href);
  const thumbUrl = allowThumb && kind === "image" && !imagesLocked() && !settings.noPictures ? allowedImageUrl(l.href) : null;
  if (thumbUrl) {
    // Thumbnail in a fixed-size frame (no layout shift); falls back to the chip if it can't load.
    const t = h("a", { class: "thumb", href: l.href, target: "_blank", rel: "noopener noreferrer" }, h("span", { class: "sr-only" }, `Image on ${hostOf(l.href)} (opens in a new tab)`));
    t.prepend(remoteImg(thumbUrl, "thumb-img", { width: 480, height: 300 }, () => t.replaceWith(embedChip(e, false) ?? "")));
    return t;
  }
  const a = h("a", { class: `embed embed-${kind}`, href: l.href, target: "_blank", rel: "noopener noreferrer" });
  if (kind === "link") a.append(icon("link", 15), h("span", { class: "embed-label" }, l.label));
  else a.append(icon(kind, 15), h("span", { class: "embed-kind" }, kind === "image" ? "Image" : "Video"), h("span", { class: "embed-host" }, hostOf(l.href)));
  a.append(h("span", { class: "sr-only" }, " (opens in a new tab)"));
  return a;
}
function actionBtn(name: IconName, label: string, onclick: () => void, cls = "") {
  return attr(h("button", { class: `act ${cls}`.trim(), onclick, title: label }, icon(name)), { "aria-label": label });
}
function appName(app: number) {
  const p = profiles.get(app);
  return p?.username ? `@${p.username}` : `app FID ${app}`;
}
function appLabel(c: FeedCast) {
  const a = apps.appOf(c);
  if (a === undefined) return null;
  return attr(h("span", { class: "cast-app", title: a === null ? "Your node lists no app for the key that signed this cast" : `Signed with an app key requested by FID ${a}` }, a === null ? "via unknown app" : `via ${appName(a)}`), { "data-app": String(a ?? "") });
}
function replyName(fid: number) {
  const p = profiles.get(fid);
  return p?.username ? `@${p.username}` : p?.displayName ?? `FID ${fid}`;
}
function pendingFoot(p: PendingItem) {
  const badge = attr(h("span", { class: `badge status-${p.status}` }, STATUS_LABEL[p.status]), { "data-status": p.status });
  if (p.status !== "failed") return badge;
  return h("div", { class: "cast-failed" }, badge,
    h("p", { class: "hint" }, `Not posted. ${/[.!?]$/.test(p.note.trim()) ? p.note.trim() : `${p.note.trim()}.`} Retry sends the same signed cast again.`),
    h("div", { class: "row" },
      h("button", { class: "btn btn-secondary btn-sm cast-retry", onclick: () => void reconciler.retry(p.hash) }, "Retry"),
      h("button", { class: "btn btn-ghost btn-sm", onclick: () => reconciler.dismiss(p.hash) }, "Dismiss")));
}
function castCard(c: FeedCast) {
  const p = profiles.get(c.fid) ?? {};
  const name = p.displayName ?? p.username ?? `FID ${c.fid}`;
  const date = fcTimeToDate(c.timestamp);
  const card = attr(h("article", { class: "cast" },
    avatar(c.fid, name, p.pfp),
    h("div", { class: "cast-body" },
      h("div", { class: "cast-head" },
        h("span", { class: "cast-who" },
          h("span", { class: "cast-name" }, name),
          p.username ? h("span", { class: "cast-handle" }, `@${p.username}`) : null,
          p.displayName || p.username ? h("span", { class: "cast-fid" }, `FID ${c.fid}`) : null),
        h("time", { dateTime: date.toISOString(), title: date.toLocaleString() }, c.pending ? "now" : timeAgo(date))),
      c.parent ? h("p", { class: "cast-reply" }, `Replying to ${replyName(c.parent.fid)}`) : null,
      c.text ? h("p", { class: "cast-text" }, c.text) : null,
      c.embeds?.length ? h("div", { class: "embeds" }, ...c.embeds.map((e) => embedChip(e))) : null,
      c.pending
        ? pendingFoot(c.pending)
        : h("div", { class: "cast-actions" },
          actionBtn("heart", `Like cast by ${name}`, () => void react("like", c), "act-like"),
          actionBtn("repeat", `Recast cast by ${name}`, () => void react("recast", c), "act-recast"),
          appLabel(c),
          actionBtn("mute", `Mute FID ${c.fid}`, () => { filters = addToList(filters, "mutedFids", String(c.fid)) as Filters; saveFilters(kv, filters); renderFilters(); renderFeed(); say(`Muted FID ${c.fid}. Undo under Filters.`); }, "act-mute")),
    )), { "data-fid": String(c.fid) });
  return card;
}

let loading = false;
// What the last load found, so the empty state can say what to do next.
type FeedProblem = null | "node-down" | "unknown-fid" | "no-follows" | "load-failed";
let problem: FeedProblem = null;
let timeline: Timeline | null = null;
let lastHashes = new Set<string>();
let newCount = 0;
let loadingOlder = false;

function notice(id: string, title: string, body: string, ...actions: HTMLElement[]) {
  return h("div", { class: "card empty", id },
    h("p", { class: "empty-title" }, title),
    h("p", { class: "hint" }, body),
    ...(actions.length ? [h("div", { class: "row" }, ...actions)] : []));
}
function button(id: string, label: string, onclick: () => void, cls = "btn btn-secondary") {
  const b = h("button", { id, class: cls }, label); b.addEventListener("click", onclick); return b;
}
const openOptions = () => { ($("feed-options") as HTMLDetailsElement).open = true; ($("viewer-fid") as HTMLInputElement).focus(); };

function renderFeed() {
  const nowFc = Math.floor((Date.now() - FARCASTER_EPOCH_MS) / 1000); // Farcaster time, for optimistic casts
  const view = !settings.sample && timeline ? timelineView(timeline, !!settings.allReplies) : null;
  const base = view ? view.casts : feed;
  const merged = mergeFeed(base, reconciler.list(), nowFc, !!settings.sample); // the sample feed keeps sampleOrder
  const shown = merged.filter((c) => hiddenReason({ ...c, app: c.pending ? undefined : apps.appOf(c) }, filters) === null);
  const hidden = merged.length - shown.length;
  renderAppFilters(merged.filter((c) => !c.pending));
  if (!loading) {
    const parts = [`${shown.length} ${shown.length === 1 ? "cast" : "casts"}`];
    if (newCount) parts.push(`${newCount} new since the last refresh`);
    if (hidden) parts.push(`${hidden} hidden by filters`);
    if (view?.hiddenReplies) parts.push(`${view.hiddenReplies} ${view.hiddenReplies === 1 ? "reply" : "replies"} to people you don't follow hidden`);
    setText("feed-meta", parts.join(", "));
  }
  const box = $("feed");
  box.replaceChildren();
  const noticeBox = $("feed-notice");
  noticeBox.replaceChildren();
  $("sample-note").hidden = !settings.sample;
  $("feed-rule").hidden = !!settings.sample || isFirstRun() || problem === "node-down" || problem === "unknown-fid";
  const older = $("load-older") as HTMLButtonElement;
  older.hidden = loading || !view || !timeline || !hasOlder(timeline) || problem === "node-down" || problem === "unknown-fid";
  older.disabled = loadingOlder;
  older.textContent = loadingOlder ? "Loading older casts…" : "Load older casts";
  // First run without an app key: the FID prompt is the only thing to do, so the post box waits.
  $("compose-box").hidden = isFirstRun() && !appKey;
  if (isFirstRun()) { setText("feed-meta", ""); box.append(firstRun()); return; }
  if (loading) return;
  if (problem === "node-down") {
    setText("feed-meta", "");
    box.append(notice("feed-down", "Can't reach your node.",
      `This page reads from ${api.baseUrl || "this site's /v1 address"}, and it didn't answer. Check that your node is running and that Settings, Node connection has the right address, then try again.`,
      button("retry-feed", "Try again", () => void refreshFeed(), "btn"),
      button("open-node-settings", "Node connection", () => { setView("settings"); ($("settings-panel") as HTMLDetailsElement).open = true; $("node-url").focus(); })));
    return;
  }
  if (problem === "unknown-fid") {
    setText("feed-meta", "");
    box.append(notice("feed-unknown", `Your node doesn't know FID ${settings.viewerFid}.`,
      "It has no profile, casts or follows for that number. Check the number, or enter your username instead. If the account is new, your node may still be syncing.",
      button("fix-fid", "Change FID", openOptions, "btn")));
    return;
  }
  if (problem === "no-follows") {
    noticeBox.append(h("div", { class: "notice", id: "feed-no-follows" },
      h("p", {}, `FID ${settings.viewerFid} doesn't follow anyone yet, so this feed shows only its own casts. To read others, use Follow someone in Settings, or add their FIDs under Feed options.`)));
  }
  if (problem === "load-failed") {
    noticeBox.append(h("div", { class: "notice notice-warn", id: "feed-partial" },
      h("p", {}, "Some accounts couldn't be read from your node, so casts may be missing. Refresh to try again.")));
  }
  if (shown.length === 0) {
    if (hidden) box.append(notice("feed-empty", "Your filters hide every cast.", "Open Filters to change them.",
      button("open-filters", "Open Filters", () => { setView("settings"); ($("filters-panel") as HTMLDetailsElement).open = true; })));
    else if (view?.hiddenReplies) box.append(notice("feed-empty", "Only replies to people you don't follow so far.", "Turn on \"Show replies to people I don't follow\" under Feed options, or load older casts.",
      button("show-replies", "Show those replies", () => { ($("all-replies") as HTMLInputElement).checked = true; setAllReplies(true); })));
    else box.append(notice("feed-empty", "No casts yet.",
      settings.viewerFid ? "You and the accounts you follow haven't cast yet. Write the first one, or add other FIDs under Feed options." : "These FIDs have no casts yet. Add other FIDs under Feed options.",
      button("open-options", "Feed options", openOptions)));
    return;
  }
  for (const c of shown.slice(0, 300)) box.append(castCard(c));
}

// ---------- first run and sample feed
const SAMPLE_NAMES = `Posts from ${SAMPLE_ACCOUNTS.slice(0, 3).map((a) => a.fname).join(", ")} and others.`;
const isFirstRun = () => !settings.viewerFid && settings.watchFids.length === 0 && !settings.sample;
function firstRun() {
  const input = attr(h("input", { id: "first-fid", autocomplete: "off", spellcheck: false, placeholder: "3 or dwr" }), { "aria-describedby": "first-fid-hint first-msg", autocapitalize: "off" });
  const show = h("button", { id: "first-show", class: "btn" }, "Show my feed");
  const msg = attr(h("p", { id: "first-msg", class: "hint error" }), { role: "alert" });
  const go = async () => {
    msg.textContent = "";
    show.disabled = true;
    const r = await resolveFid(input.value, api);
    show.disabled = false;
    if (!r.ok) { msg.textContent = lookupMessage(r); input.focus(); return; }
    ($("viewer-fid") as HTMLInputElement).value = String(r.fid);
    settings.sample = false;
    if (r.name) say(`Found @${r.name}: FID ${r.fid}.`);
    void refreshFeed();
  };
  show.addEventListener("click", () => void go());
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") void go(); });
  const sample = h("button", { id: "try-sample", class: "btn btn-secondary" }, "Try a sample feed");
  sample.addEventListener("click", () => { settings.sample = true; void refreshFeed(); });
  return h("div", { class: "card first-run", id: "first-run" },
    h("h2", { class: "empty-title" }, "Enter your FID to see your feed"),
    hint("first-fid-hint", "Your FID is the number of your Farcaster account. Don't know it? Type your username and this page looks it up."),
    h("label", { htmlFor: "first-fid", class: "lbl" }, "Your FID or username"),
    h("div", { class: "row" }, input, show),
    msg,
    fidHelp("first"),
    h("div", { class: "first-or" }, h("span", {}, "or")),
    sample,
    h("p", { class: "hint", id: "sample-names" }, SAMPLE_NAMES));
}
$("leave-sample").addEventListener("click", () => {
  settings.sample = false; writeJSON(kv, SETTINGS_KEY, settings);
  feed = []; timeline = null; problem = null; renderFeed();
  document.getElementById("first-fid")?.focus();
});

async function nodeAnswers() { try { await api.info(); return true; } catch { return false; } }
async function addProfiles(casts: FeedCast[]) {
  await apps.load(casts); // which app posted each cast (src/apps.ts)
  const fids = new Set<number>();
  for (const c of casts) { fids.add(c.fid); if (c.parent) fids.add(c.parent.fid); const a = apps.appOf(c); if (a) fids.add(a); }
  const missing = [...fids].filter((f) => !profiles.has(f));
  for (const [fid, p] of await loadProfiles(api, missing)) profiles.set(fid, p);
}

// Only the newest refresh may set the feed: the boot load (default FIDs) can finish after a
// refresh the user started, and must not overwrite it.
let feedGen = 0;
async function refreshFeed() {
  const fidInput = $("viewer-fid") as HTMLInputElement;
  const v = fidInput.value.trim();
  if (v && !/^\d+$/.test(v)) {
    // A username: look it up on the node first.
    const r = await resolveFid(v, api);
    if (!r.ok) { setText("viewer-fid-hint", lookupMessage(r)); $("viewer-fid-hint").classList.add("error"); ($("feed-options") as HTMLDetailsElement).open = true; fidInput.focus(); return; }
    fidInput.value = String(r.fid);
    setText("viewer-fid-hint", `@${r.name} is FID ${r.fid}.`);
    $("viewer-fid-hint").classList.remove("error");
  }
  const fid = Number(fidInput.value.trim());
  const changedViewer = (Number.isSafeInteger(fid) && fid > 0 ? fid : null) !== settings.viewerFid;
  settings.viewerFid = Number.isSafeInteger(fid) && fid > 0 ? fid : null;
  settings.watchFids = ($("watch-fids") as HTMLInputElement).value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (settings.viewerFid || settings.watchFids.length) settings.sample = false;
  writeJSON(kv, SETTINGS_KEY, settings);
  if (isFirstRun()) { feedGen++; loading = false; feed = []; timeline = null; problem = null; renderFeed(); return; }
  if (changedViewer) lastHashes = new Set();
  setText("feed-meta", "Loading…");
  const gen = ++feedGen;
  loading = true;
  renderFeed();
  const btn = $("refresh") as HTMLButtonElement;
  btn.disabled = true;
  try {
    let next: FeedProblem = null;
    if (settings.sample) {
      const loaded = await loadSampleFeed(api);
      if (gen !== feedGen) return;
      if (loaded.length === 0 && !(await nodeAnswers())) next = "node-down";
      await addProfiles(loaded);
      if (gen !== feedGen) return;
      feed = loaded; timeline = null;
    } else {
      let tl = await startTimeline(api, settings.viewerFid, settings.watchFids);
      // Make the first screen worth reading: a few more pages if the complete part is short.
      for (let i = 0; i < 2 && hasOlder(tl) && timelineView(tl, !!settings.allReplies).casts.length < 15; i++) tl = await loadOlder(api, tl);
      if (gen !== feedGen) return;
      await addProfiles(tl.casts);
      if (settings.viewerFid && !profiles.has(settings.viewerFid)) for (const [f, p] of await loadProfiles(api, [settings.viewerFid])) profiles.set(f, p);
      if (gen !== feedGen) return;
      if (tl.casts.length === 0 && tl.failed > 0 && !(await nodeAnswers())) next = "node-down";
      else if (settings.viewerFid && tl.following.size === 0) {
        next = tl.casts.length === 0 && !profiles.get(settings.viewerFid)?.username && !profiles.get(settings.viewerFid)?.displayName && settings.watchFids.length === 0 ? "unknown-fid" : "no-follows";
      } else if (tl.failed > 0) next = "load-failed";
      const hashes = new Set(tl.casts.map((c) => c.hash.toLowerCase()));
      newCount = countNew(lastHashes, timelineView(tl, !!settings.allReplies).casts);
      lastHashes = hashes;
      timeline = tl; feed = [];
    }
    problem = next;
    if (next === "node-down") void refreshStatus();
  } catch {
    if (gen === feedGen) { problem = (await nodeAnswers()) ? "load-failed" : "node-down"; if (problem === "node-down") void refreshStatus(); }
  } finally {
    if (gen === feedGen) { loading = false; btn.disabled = false; renderFeed(); }
  }
}
async function onLoadOlder() {
  if (!timeline || loadingOlder) return;
  loadingOlder = true; renderFeed();
  const before = timeline;
  try {
    const tl = await loadOlder(api, before);
    await addProfiles(tl.casts);
    if (timeline === before) { timeline = tl; for (const c of tl.casts) lastHashes.add(c.hash.toLowerCase()); if (tl.failed > before.failed) problem = problem ?? "load-failed"; }
  } finally { loadingOlder = false; renderFeed(); }
}
function setAllReplies(on: boolean) { settings.allReplies = on; writeJSON(kv, SETTINGS_KEY, settings); renderFeed(); }
$("all-replies").addEventListener("change", (ev) => setAllReplies((ev.target as HTMLInputElement).checked));
$("load-older").addEventListener("click", () => void onLoadOlder());
$("show-pictures").addEventListener("change", (ev) => { settings.noPictures = !(ev.target as HTMLInputElement).checked; writeJSON(kv, SETTINGS_KEY, settings); renderFeed(); });
$("refresh").addEventListener("click", () => void refreshFeed());
$("apply-feed").addEventListener("click", () => void refreshFeed());
for (const id of ["viewer-fid", "watch-fids"]) $(id).addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") void refreshFeed(); });

// ---------- first-run explainer ("How this works")
function showIntro(open: boolean) {
  $("intro").hidden = !open;
  $("intro-open").hidden = open;
}
$("intro-done").addEventListener("click", () => { settings.introDone = true; writeJSON(kv, SETTINGS_KEY, settings); showIntro(false); $("intro-open").focus(); });
$("intro-open").addEventListener("click", () => { showIntro(true); $("intro-done").focus(); });
showIntro(!settings.introDone);

// ---------- mobile tab bar (hidden on wide screens, where the side column is always shown)
type View = "feed" | "settings";
function setView(v: View) {
  document.body.dataset.view = v;
  for (const t of document.querySelectorAll<HTMLButtonElement>(".tabbar [data-view]")) {
    if (t.dataset.view === v) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  }
}
$("tab-feed").addEventListener("click", () => {
  const already = document.body.dataset.view === "feed";
  setView("feed");
  if (already) window.scrollTo({ top: 0 });
  else ($("feed-title") as HTMLElement).scrollIntoView({ block: "start" });
});
$("tab-post").addEventListener("click", () => {
  setView("feed");
  window.scrollTo({ top: 0 });
  (document.getElementById("compose") ?? $("open-add-key")).focus();
});
$("tab-settings").addEventListener("click", () => { setView("settings"); window.scrollTo({ top: 0 }); ($("side-title") as HTMLElement).focus({ preventScroll: true }); });
setView("feed");

// ---------- boot
renderSigner(); renderFilters(); renderPending();
if (appKey) void loadWrite(); // you can post, so fetch the signing code now rather than on the first Post
void refreshStatus(); void refreshFeed(); void waitForKey();
setInterval(() => void reconciler.tick(), 2000);
setInterval(() => void refreshStatus(), 30000);
