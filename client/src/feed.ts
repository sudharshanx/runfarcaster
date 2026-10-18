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
  embeds?: Array<{ url?: string; castFid?: number }>;
  pending?: PendingItem; // set for optimistic (not yet confirmed) casts
  signer?: string; // the app key that signed it (see src/apps.ts)
}

export const fcTimeToDate = (t: number) => new Date(FARCASTER_EPOCH_MS + t * 1000);

export function toFeedCast(m: MessageJson): FeedCast | null {
  const b = m.data?.castAddBody;
  if (!b || m.data.type !== "MESSAGE_TYPE_CAST_ADD") return null;
  const embeds = (b.embeds ?? []).map((e) => (e.castId ? { castFid: e.castId.fid } : { url: e.url })).filter((e) => e.castFid !== undefined || !!e.url);
  return { fid: m.data.fid, hash: m.hash, text: b.text ?? "", timestamp: m.data.timestamp, parent: b.parentCastId, ...(embeds.length ? { embeds } : {}), ...(m.signer ? { signer: m.signer } : {}) };
}

/** Merge confirmed casts with optimistic ones; pending entries are dropped once the node returns them. */
export function mergeFeed(casts: FeedCast[], pending: PendingItem[], nowFc: number, keepOrder = false): FeedCast[] {
  const seen = new Set(casts.map((c) => c.hash.toLowerCase()));
  const optimistic: FeedCast[] = pending
    .filter((p) => p.kind === "cast" && !seen.has(p.hash.toLowerCase()) && p.status !== "confirmed")
    .map((p) => ({ fid: p.fid, hash: p.hash, text: p.text ?? "", timestamp: nowFc, pending: p }));
  const byHash = new Map<string, FeedCast>();
  for (const c of [...optimistic, ...casts]) if (!byHash.has(c.hash.toLowerCase())) byHash.set(c.hash.toLowerCase(), c);
  const out = [...byHash.values()];
  return keepOrder ? out : out.sort((a, b) => b.timestamp - a.timestamp);
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

export interface Profile { displayName?: string; username?: string; pfp?: string }

/** Latest display name and username from GET /v1/userDataByFid (newest message per type wins). */
export function profileFromUserData(messages: MessageJson[]): Profile {
  const latest = new Map<string, { ts: number; value: string }>();
  for (const m of messages) {
    const b = m.data?.userDataBody;
    if (!b) continue;
    const prev = latest.get(b.type);
    if (!prev || m.data.timestamp >= prev.ts) latest.set(b.type, { ts: m.data.timestamp, value: b.value });
  }
  const p: Profile = {};
  const display = latest.get("USER_DATA_TYPE_DISPLAY")?.value.trim();
  const username = latest.get("USER_DATA_TYPE_USERNAME")?.value.trim();
  if (display) p.displayName = display;
  if (username) p.username = username;
  const pfp = latest.get("USER_DATA_TYPE_PFP")?.value.trim();
  if (pfp) p.pfp = pfp;
  return p;
}

/** Profiles for the given FIDs; a FID whose lookup fails just gets no name. */
export async function loadProfiles(api: Pick<NodeApi, "userDataByFid">, fids: number[]): Promise<Map<number, Profile>> {
  const out = new Map<number, Profile>();
  await mapLimit(fids, 6, async (fid) => {
    try { out.set(fid, profileFromUserData((await api.userDataByFid(fid)).messages)); } catch { out.set(fid, {}); }
  });
  return out;
}

/**
 * "Try a sample feed": a fixed list of well-known accounts. Each FID was checked on 2026-10-18
 * against our own node with GET /v1/userNameProofByName?name=<fname> (the fname's current owner).
 */
export const SAMPLE_ACCOUNTS: ReadonlyArray<{ fname: string; fid: number }> = [
  { fname: "balajis", fid: 37 },
  { fname: "dwr", fid: 3 },
  { fname: "vitalik.eth", fid: 5650 }, // ENS name proof
  { fname: "v", fid: 2 },
  { fname: "jessepollak", fid: 99 },
  { fname: "linda", fid: 12 },
  { fname: "ted", fid: 239 },
  { fname: "cassie", fid: 1325 },
  { fname: "horsefacts", fid: 3621 },
  { fname: "farcaster", fid: 1 },
];

/**
 * Sample feed order: strictly newest first, so the times read top to bottom like any timeline.
 * `pinFid` is kept for callers of the old signature and no longer changes the order.
 */
export function sampleOrder(casts: FeedCast[], _pinFid = SAMPLE_ACCOUNTS[0]!.fid): FeedCast[] {
  return [...casts].sort((a, b) => b.timestamp - a.timestamp);
}

/** Recent casts of the sample accounts (a few each), in sampleOrder. */
export const loadSampleFeed = async (api: Pick<NodeApi, "linksByFid" | "castsByFid">, perFid = 5) =>
  sampleOrder(await loadFeed(api, null, SAMPLE_ACCOUNTS.map((a) => a.fid), SAMPLE_ACCOUNTS.length, perFid));
