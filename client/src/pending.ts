// SPDX-License-Identifier: MIT
//
// Optimistic UI + reconciliation.
//
// On a READ node, a successful POST /v1/submitMessage only means the message was valid and was
// relayed over gossip. Read nodes keep no mempool: if that gossip is lost, the message is gone.
// So every message we send is:
//   1. shown immediately ("sending" -> "relayed, waiting for a block"),
//   2. queried back from the node by hash/target until it appears ("confirmed"),
//   3. re-submitted (same signed bytes, same hash) if it does not appear in time,
//   4. flagged "failed" with a plain explanation after the retry budget is spent.
import { NodeApiError, type MessageJson, type NodeApi } from "./api";
import type { BuiltMessage } from "./messages";
import { type KV, readJSON, writeJSON } from "./storage";

export type PendingStatus = "sending" | "relayed" | "retrying" | "confirmed" | "failed";

export interface PendingItem {
  hash: string;
  kind: BuiltMessage["kind"];
  fid: number;
  text?: string;
  target?: { fid: number; hash?: string };
  bytesB64: string;
  status: PendingStatus;
  submits: number;
  createdAt: number;
  lastSubmitAt: number;
  nextCheckAt: number;
  note: string;
}

export interface ReconcileConfig {
  checkIntervalMs: number; // how often to query back
  resubmitAfterMs: number; // resubmit if not visible this long after the last submit
  maxSubmits: number; // total submits (first + retries)
}

export const DEFAULT_RECONCILE: ReconcileConfig = { checkIntervalMs: 4_000, resubmitAfterMs: 30_000, maxSubmits: 4 };
export const PENDING_KEY = "pending.v1";

export const NOTES = {
  sending: "Sending to your node…",
  relayed: "Accepted by the node for relay. Waiting to see it in a block (read nodes have no mempool).",
  retrying: "Not visible yet. Re-submitting the same signed message.",
  confirmed: "Confirmed: the node returns this message.",
  failedNever:
    "Never appeared. The node accepted it for relay, but no validator included it. Read nodes keep no mempool, so the gossip was probably lost. Try again later or submit via another node.",
} as const;

type Api = Pick<NodeApi, "submitMessage" | "castById" | "reactionById" | "linkById">;

const b64 = (u: Uint8Array) => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class Reconciler {
  private items: PendingItem[];
  constructor(
    private readonly api: Api,
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
    private readonly cfg: ReconcileConfig = DEFAULT_RECONCILE,
    private readonly onChange: (items: PendingItem[]) => void = () => {},
  ) {
    this.items = readJSON<PendingItem[]>(kv, PENDING_KEY, []).filter((i) => typeof i.hash === "string");
  }

  list(): PendingItem[] { return [...this.items]; }

  private save() { writeJSON(this.kv, PENDING_KEY, this.items); this.onChange(this.list()); }

  private set(item: PendingItem, patch: Partial<PendingItem>) { Object.assign(item, patch); this.save(); }

  /** Shows the item immediately, then submits it. */
  async add(m: BuiltMessage): Promise<PendingItem> {
    const existing = this.items.find((i) => i.hash === m.hash);
    if (existing) return existing;
    const t = this.now();
    const item: PendingItem = {
      hash: m.hash, kind: m.kind, fid: m.fid, text: m.text, target: m.target, bytesB64: b64(m.bytes),
      status: "sending", submits: 0, createdAt: t, lastSubmitAt: t, nextCheckAt: t + this.cfg.checkIntervalMs, note: NOTES.sending,
    };
    this.items.unshift(item);
    this.save();
    await this.submit(item);
    return item;
  }

  private async submit(item: PendingItem) {
    const t = this.now();
    item.submits += 1;
    item.lastSubmitAt = t;
    try {
      await this.api.submitMessage(unb64(item.bytesB64));
      this.set(item, { status: item.submits > 1 ? "retrying" : "relayed", note: item.submits > 1 ? NOTES.retrying : NOTES.relayed, nextCheckAt: t + this.cfg.checkIntervalMs });
    } catch (e) {
      if (e instanceof NodeApiError && e.isDuplicate) {
        // Node already has it: confirm on the next query-back.
        this.set(item, { status: "relayed", note: NOTES.relayed, nextCheckAt: t });
      } else if (e instanceof NodeApiError && e.status >= 400 && e.status < 500) {
        // Validation errors will not fix themselves by retrying.
        this.set(item, { status: "failed", note: `Rejected by the node: ${e.message}` });
      } else {
        this.set(item, { status: "retrying", note: `Could not reach the node (${(e as Error).message}). Will retry.`, nextCheckAt: t + this.cfg.checkIntervalMs });
      }
    }
  }

  private async visible(item: PendingItem): Promise<boolean> {
    let found: MessageJson;
    try {
      if (item.kind === "cast") found = await this.api.castById(item.fid, item.hash);
      else if (item.kind === "follow") found = await this.api.linkById(item.fid, item.target!.fid, "follow");
      else found = await this.api.reactionById(item.fid, item.kind === "like" ? "Like" : "Recast", item.target!.fid, item.target!.hash!);
    } catch (e) {
      if (e instanceof NodeApiError && (e.isNotFound || e.status === 400 || e.status === 404)) return false;
      throw e;
    }
    // For links/reactions the lookup is by target, so make sure it is OUR message (same hash).
    return found.hash?.toLowerCase() === item.hash.toLowerCase();
  }

  /** Call periodically (the UI uses setInterval). */
  async tick(): Promise<void> {
    for (const item of this.items) {
      if (item.status === "confirmed" || item.status === "failed") continue;
      const t = this.now();
      if (t < item.nextCheckAt) continue;
      let seen = false;
      try { seen = await this.visible(item); } catch { /* node unreachable: treat as not seen */ }
      if (seen) { this.set(item, { status: "confirmed", note: NOTES.confirmed }); continue; }
      if (t - item.lastSubmitAt >= this.cfg.resubmitAfterMs) {
        if (item.submits >= this.cfg.maxSubmits) { this.set(item, { status: "failed", note: NOTES.failedNever }); continue; }
        await this.submit(item);
        continue;
      }
      this.set(item, { nextCheckAt: t + this.cfg.checkIntervalMs });
    }
  }

  /** Manual retry for a failed item: resets the budget and submits the same bytes again. */
  async retry(hash: string) {
    const item = this.items.find((i) => i.hash === hash);
    if (!item) return;
    item.submits = 0;
    await this.submit(item);
  }

  dismiss(hash: string) { this.items = this.items.filter((i) => i.hash !== hash); this.save(); }
}
