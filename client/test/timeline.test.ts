// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { NodeApiError } from "../src/api";
import { explainKeyError, lookupMessage, resolveFid } from "../src/help";
import { countNew, frontier, hasOlder, isHiddenReply, loadOlder, startTimeline, timelineView, PAGE_SIZE } from "../src/timeline";

// A fake node: casts per FID (newest first, paged with a numeric pageToken), follows per FID.
function fakeNode(casts: Record<number, Array<{ ts: number; parentFid?: number }>>, follows: Record<number, number[]>, failFids: number[] = []) {
  const calls: string[] = [];
  return {
    calls,
    async linksByFid(fid: number) {
      calls.push(`links ${fid}`);
      return { messages: (follows[fid] ?? []).map((t) => ({ data: { linkBody: { targetFid: t } } })) } as never;
    },
    async castsByFid(fid: number, pageSize = 25, pageToken?: string) {
      calls.push(`casts ${fid} ${pageToken ?? "-"}`);
      if (failFids.includes(fid)) throw new Error("boom");
      const all = [...(casts[fid] ?? [])].sort((a, b) => b.ts - a.ts);
      const start = Number(pageToken ?? 0);
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return {
        messages: page.map((c, i) => ({
          hash: `0x${fid.toString(16)}${(start + i).toString(16).padStart(4, "0")}`,
          data: { fid, type: "MESSAGE_TYPE_CAST_ADD", timestamp: c.ts, castAddBody: { text: `c${c.ts}`, ...(c.parentFid ? { parentCastId: { fid: c.parentFid, hash: "0xab" } } : {}) } },
        })),
        nextPageToken: more ? String(start + pageSize) : undefined,
      } as never;
    },
  };
}
const range = (from: number, n: number, step = 1) => Array.from({ length: n }, (_, i) => ({ ts: from - i * step }));

describe("Following timeline", () => {
  it("reads you, the people you follow and extra FIDs, newest first", async () => {
    const node = fakeNode({ 1: [{ ts: 50 }], 2: [{ ts: 70 }], 3: [{ ts: 60 }], 9: [{ ts: 65 }] }, { 1: [2, 3] });
    const tl = await startTimeline(node, 1, [9]);
    expect([...tl.following]).toEqual([2, 3]);
    expect(timelineView(tl, false).casts.map((c) => c.timestamp)).toEqual([70, 65, 60, 50]);
    expect(hasOlder(tl)).toBe(false);
  });

  it("shows no gaps: casts older than another account's unloaded page wait for Load older", async () => {
    // FID 2 posts a lot (100..81), FID 3 once at 85. The first page of FID 2 ends at 91.
    const node = fakeNode({ 2: range(100, 20), 3: [{ ts: 85 }] }, { 1: [2, 3] });
    let tl = await startTimeline(node, 1, []);
    expect(frontier(tl)).toBe(100 - (PAGE_SIZE - 1));
    let v = timelineView(tl, false);
    expect(v.casts.every((c) => c.timestamp >= 91)).toBe(true);
    expect(v.waiting).toBe(1); // FID 3's cast at 85 is loaded but held back
    expect(hasOlder(tl)).toBe(true);
    tl = await loadOlder(node, tl);
    v = timelineView(tl, false);
    expect(v.casts).toHaveLength(21);
    expect(v.casts.map((c) => c.timestamp)).toEqual([...v.casts.map((c) => c.timestamp)].sort((a, b) => b - a));
    expect(hasOlder(tl)).toBe(false);
    expect(node.calls).toContain(`casts 2 ${PAGE_SIZE}`);
    expect(node.calls.filter((c) => c.startsWith("casts 3"))).toHaveLength(1); // done accounts aren't asked again
  });

  it("hides replies to people you don't follow unless asked", async () => {
    const node = fakeNode({ 2: [{ ts: 10, parentFid: 99 }, { ts: 9, parentFid: 3 }, { ts: 8, parentFid: 2 }, { ts: 7, parentFid: 1 }, { ts: 6 }] }, { 1: [2, 3] });
    const tl = await startTimeline(node, 1, []);
    const v = timelineView(tl, false);
    expect(v.casts.map((c) => c.timestamp)).toEqual([9, 8, 7, 6]);
    expect(v.hiddenReplies).toBe(1);
    expect(timelineView(tl, true).casts).toHaveLength(5);
    expect(isHiddenReply(tl.casts[0]!, tl, false)).toBe(true);
  });

  it("keeps going when one account fails and counts the failure", async () => {
    const node = fakeNode({ 2: [{ ts: 5 }] }, { 1: [2, 3] }, [3]);
    const tl = await startTimeline(node, 1, []);
    expect(tl.failed).toBe(1);
    expect(timelineView(tl, false).casts).toHaveLength(1);
  });

  it("counts new casts since the previous load, none on the first load", () => {
    const casts = [{ hash: "0xA" }, { hash: "0xb" }, { hash: "0xc" }] as never;
    expect(countNew(new Set(), casts)).toBe(0);
    expect(countNew(new Set(["0xa", "0xb"]), casts)).toBe(1);
  });
});

describe("username to FID", () => {
  const api = (fid: number | Error) => ({ async userNameProofByName(n: string) { if (fid instanceof Error) throw fid; return { fid, name: n }; } });
  it("accepts a number as is, without asking the node", async () => {
    expect(await resolveFid(" 42 ", api(new Error("no call")))).toEqual({ ok: true, fid: 42 });
  });
  it("resolves @name, NAME and name.eth on the node", async () => {
    const seen: string[] = [];
    const a = { async userNameProofByName(n: string) { seen.push(n); return { fid: 3 }; } };
    expect(await resolveFid("@DWR", a)).toEqual({ ok: true, fid: 3, name: "dwr" });
    expect((await resolveFid("vitalik.eth", a)).ok).toBe(true);
    expect(seen).toEqual(["dwr", "vitalik.eth"]);
  });
  it("tells unknown names apart from an unreachable node", async () => {
    const nf = await resolveFid("nobody", api(new NodeApiError("node returned HTTP 400", 400)));
    expect(nf).toEqual({ ok: false, reason: "not-found", name: "nobody" });
    expect(lookupMessage(nf as never)).toMatch(/No account called @nobody/);
    const down = await resolveFid("dwr", api(new TypeError("Failed to fetch")));
    expect(down).toMatchObject({ ok: false, reason: "unreachable" });
    expect(await resolveFid("", api(1))).toEqual({ ok: false, reason: "empty" });
    expect(await resolveFid("a b", api(1))).toMatchObject({ ok: false, reason: "invalid" });
    expect(await resolveFid("0", api(1))).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("add-key errors say what to do", () => {
  it("maps known errors and never drops the original", () => {
    expect(explainKeyError("no FID is registered to custody address 0xabc")).toMatch(/doesn't own a Farcaster account/);
    expect(explainKeyError("a recovery phrase has 12-24 words")).toMatch(/12, 15, 18, 21 or 24 words/);
    expect(explainKeyError("Invalid mnemonic")).toMatch(/spelling/);
    expect(explainKeyError("node returned HTTP 502: bad gateway")).toMatch(/HTTP 502.*reachable/);
    expect(explainKeyError("something odd")).toBe("Couldn't add the app key: something odd");
  });
  it("uses no dashes in user copy", () => {
    for (const m of ["no FID is registered", "a recovery phrase has", "Invalid mnemonic", "fetch failed", "x"]) expect(explainKeyError(m)).not.toMatch(/[\u2013\u2014]/);
  });
});
