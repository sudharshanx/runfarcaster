// SPDX-License-Identifier: MIT
// Builds a simple chronological feed: latest casts of the FIDs you follow (+ yourself + extra
// watched FIDs), merged and sorted newest first. A node has no "home timeline" endpoint, so
// the client assembles one from /v1/linksByFid and /v1/castsByFid.
import type { MessageJson, NodeApi } from "./api";
import type { PendingItem } from "./pending";

export const FARCASTER_EPOCH_MS = 1_609_459_200_000; // 2021-01-01T00:00:00Z

export interface FeedCast {
  fid: number;
  hash: string;
  text: string;
  timestamp: number; // farcaster seconds
  parent?: { fid: number; hash: string };
  pending?: PendingItem; // set for optimistic (not yet confirmed) casts
}

export const fcTimeToDate = (t: number) => new Date(FARCASTER_EPOCH_MS + t * 1000);

export function toFeedCast(m: MessageJson): FeedCast | null {
  const b = m.data?.castAddBody;
  if (!b || m.data.type !== "MESSAGE_TYPE_CAST_ADD") return null;
  return { fid: m.data.fid, hash: m.hash, text: b.text ?? "", timestamp: m.data.timestamp, parent: b.parentCastId };
}

/** Merge confirmed casts with optimistic ones; pending entries are dropped once the node returns them. */
export function mergeFeed(casts: FeedCast[], pending: PendingItem[], nowFc: number): FeedCast[] {
  const seen = new Set(casts.map((c) => c.hash.toLowerCase()));
  const optimistic: FeedCast[] = pending
    .filter((p) => p.kind === "cast" && !seen.has(p.hash.toLowerCase()) && p.status !== "confirmed")
    .map((p) => ({ fid: p.fid, hash: p.hash, text: p.text ?? "", timestamp: nowFc, pending: p }));
  const byHash = new Map<string, FeedCast>();
  for (const c of [...optimistic, ...casts]) if (!byHash.has(c.hash.toLowerCase())) byHash.set(c.hash.toLowerCase(), c);
  return [...byHash.values()].sort((a, b) => b.timestamp - a.timestamp);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
  });
  await Promise.all(workers);
  return out;
}

export async function loadFeed(api: Pick<NodeApi, "linksByFid" | "castsByFid">, viewerFid: number | null, extraFids: number[], maxFids = 40, perFid = 10): Promise<FeedCast[]> {
  const fids = new Set<number>(extraFids);
  if (viewerFid) {
    fids.add(viewerFid);
    try {
      const links = await api.linksByFid(viewerFid);
      for (const l of links.messages) if (l.data.linkBody?.targetFid) fids.add(l.data.linkBody.targetFid);
    } catch { /* show what we can */ }
  }
  const list = [...fids].slice(0, maxFids);
  const pages = await mapLimit(list, 6, async (fid) => {
    try { return (await api.castsByFid(fid, perFid)).messages; } catch { return [] as MessageJson[]; }
  });
  return pages.flat().map(toFeedCast).filter((c): c is FeedCast => c !== null).sort((a, b) => b.timestamp - a.timestamp);
}
