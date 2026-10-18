// SPDX-License-Identifier: MIT
//
// The "Following" timeline: casts from you and the accounts you follow, read from your node,
// newest first, with no ranking. A node has no home-timeline endpoint, so we read each account's
// casts (GET /v1/castsByFid, newest first, paged) and merge them.
//
// Merging pages from many accounts needs one rule to stay in true time order: we only show casts
// that are newer than the oldest loaded cast of every account that still has older pages
// (the "frontier"). Otherwise a busy account's 10th cast could appear above a quiet account's
// cast we have not loaded yet. "Load older casts" fetches the next page of those accounts.
import type { MessageJson, NodeApi } from "./api";
import { toFeedCast, type FeedCast } from "./feed";

export const PAGE_SIZE = 10;
export const MAX_ACCOUNTS = 100; // one page of /v1/linksByFid

export interface Source { fid: number; cursor?: string; done: boolean; oldest: number }
export interface Timeline {
  viewerFid: number | null;
  following: Set<number>; // FIDs the viewer follows
  followsTruncated: boolean; // the viewer follows more than MAX_ACCOUNTS
  sources: Source[];
  casts: FeedCast[]; // every loaded cast, newest first, no duplicates
  failed: number; // castsByFid requests that failed
}
type Api = Pick<NodeApi, "linksByFid" | "castsByFid">;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
  }));
  return out;
}

function addCasts(existing: FeedCast[], more: FeedCast[]): FeedCast[] {
  const seen = new Set(existing.map((c) => c.hash.toLowerCase()));
  return [...existing, ...more.filter((c) => !seen.has(c.hash.toLowerCase()))].sort((a, b) => b.timestamp - a.timestamp);
}

async function fetchPages(api: Api, sources: Source[]): Promise<{ sources: Source[]; casts: FeedCast[]; failed: number }> {
  let failed = 0;
  const pages = await mapLimit(sources, 6, async (s) => {
    try {
      const r = await api.castsByFid(s.fid, PAGE_SIZE, s.cursor);
      const casts = r.messages.map((m: MessageJson) => toFeedCast(m)).filter((c): c is FeedCast => c !== null);
      const done = !r.nextPageToken || r.messages.length < PAGE_SIZE;
      const oldest = r.messages.length ? Math.min(...r.messages.map((m) => m.data.timestamp)) : s.oldest;
      return { source: { fid: s.fid, cursor: r.nextPageToken, done, oldest }, casts };
    } catch {
      failed++;
      return { source: { ...s, done: true }, casts: [] as FeedCast[] };
    }
  });
  return { sources: pages.map((p) => p.source), casts: pages.flatMap((p) => p.casts), failed };
}

/** First page for you, the accounts you follow and any extra FIDs. */
export async function startTimeline(api: Api, viewerFid: number | null, extraFids: number[]): Promise<Timeline> {
  const following = new Set<number>();
  let followsTruncated = false;
  if (viewerFid) {
    try {
      const links = await api.linksByFid(viewerFid, MAX_ACCOUNTS);
      for (const l of links.messages) if (l.data.linkBody?.targetFid) following.add(l.data.linkBody.targetFid);
      followsTruncated = !!links.nextPageToken;
    } catch { /* show what we can */ }
  }
  const fids = [...new Set([...(viewerFid ? [viewerFid] : []), ...following, ...extraFids])].slice(0, MAX_ACCOUNTS + 1 + extraFids.length);
  const r = await fetchPages(api, fids.map((fid) => ({ fid, done: false, oldest: Infinity })));
  return { viewerFid, following, followsTruncated, sources: r.sources, casts: addCasts([], r.casts), failed: r.failed };
}

/** Next page for every account that has older casts. */
export async function loadOlder(api: Api, tl: Timeline): Promise<Timeline> {
  const open = tl.sources.filter((s) => !s.done);
  if (open.length === 0) return tl;
  const r = await fetchPages(api, open);
  const byFid = new Map(r.sources.map((s) => [s.fid, s]));
  return { ...tl, sources: tl.sources.map((s) => byFid.get(s.fid) ?? s), casts: addCasts(tl.casts, r.casts), failed: tl.failed + r.failed };
}

/** Casts at or after this time are complete; older ones wait for "Load older casts". */
export function frontier(tl: Pick<Timeline, "sources">): number {
  const open = tl.sources.filter((s) => !s.done && Number.isFinite(s.oldest));
  return open.length ? Math.max(...open.map((s) => s.oldest)) : -Infinity;
}
export const hasOlder = (tl: Pick<Timeline, "sources">) => tl.sources.some((s) => !s.done);

/**
 * A reply is shown if it answers you, someone you follow, someone in the extra FIDs, or the
 * author's own cast (a thread). Other replies are hidden unless showAllReplies is on.
 */
export function isHiddenReply(c: FeedCast, tl: Pick<Timeline, "viewerFid" | "following" | "sources">, showAllReplies: boolean): boolean {
  if (showAllReplies || !c.parent) return false;
  const p = c.parent.fid;
  return !(p === c.fid || p === tl.viewerFid || tl.following.has(p) || tl.sources.some((s) => s.fid === p));
}

export interface TimelineView { casts: FeedCast[]; hiddenReplies: number; waiting: number }
/** What the feed shows: complete part of the timeline, with replies to strangers hidden. */
export function timelineView(tl: Timeline, showAllReplies: boolean): TimelineView {
  const f = frontier(tl);
  const complete = tl.casts.filter((c) => c.timestamp >= f);
  const casts = complete.filter((c) => !isHiddenReply(c, tl, showAllReplies));
  return { casts, hiddenReplies: complete.length - casts.length, waiting: tl.casts.length - complete.length };
}

/** How many of these casts were not in the previous load. */
export const countNew = (previous: Set<string>, casts: FeedCast[]) =>
  previous.size === 0 ? 0 : casts.filter((c) => !previous.has(c.hash.toLowerCase())).length;
