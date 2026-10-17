// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { NodeApi, NodeApiError } from "../src/api";
import { fcTimeToDate, loadFeed, mergeFeed, toFeedCast } from "../src/feed";
import type { PendingItem } from "../src/pending";

function recorder(responses: Record<string, unknown> = {}, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? responses[key] : { messages: [] }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("NodeApi", () => {
  it("uses same-origin relative URLs by default and serde_qs-compatible booleans", async () => {
    const { calls, fetchFn } = recorder();
    await new NodeApi("", fetchFn).castsByFid(2, 5);
    expect(calls[0]!.url).toBe("/v1/castsByFid?fid=2&pageSize=5&reverse=true");
  });
  it("submitMessage POSTs raw bytes as application/octet-stream", async () => {
    const { calls, fetchFn } = recorder({ submitMessage: { hash: "0x1" } });
    await new NodeApi("https://node.example/", fetchFn).submitMessage(new Uint8Array([1, 2, 3]));
    expect(calls[0]!.url).toBe("https://node.example/v1/submitMessage");
    expect(calls[0]!.init?.method).toBe("POST");
    expect((calls[0]!.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect(calls[0]!.init?.body).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("maps node error JSON to NodeApiError", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ errCode: "not_found", details: "no such cast" }), { status: 400 })) as unknown as typeof fetch;
    const e = await new NodeApi("", fetchFn).castById(1, "0x00").catch((x) => x);
    expect(e).toBeInstanceOf(NodeApiError);
    expect(e.isNotFound).toBe(true);
    expect(e.message).toMatch(/no such cast/);
  });
  it("encodes reaction/link lookup params as documented", async () => {
    const { calls, fetchFn } = recorder();
    const api = new NodeApi("", fetchFn);
    await api.reactionById(2, "Like", 1795, "0xab").catch(() => {});
    await api.linkById(6833, 2).catch(() => {});
    await api.signersByFid(3);
    expect(calls.map((c) => c.url)).toEqual([
      "/v1/reactionById?fid=2&reaction_type=Like&target_fid=1795&target_hash=0xab",
      "/v1/linkById?fid=6833&target_fid=2&link_type=follow",
      "/v1/signersByFid?fid=3",
    ]);
  });
});

const castMsg = (fid: number, hash: string, ts: number, text: string) => ({
  data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: ts, network: "FARCASTER_NETWORK_MAINNET", castAddBody: { text } }, hash,
});

describe("feed", () => {
  it("converts farcaster time (epoch 2021-01-01)", () => {
    expect(fcTimeToDate(0).toISOString()).toBe("2021-01-01T00:00:00.000Z");
  });
  it("ignores non-cast messages", () => {
    expect(toFeedCast({ data: { type: "MESSAGE_TYPE_LINK_ADD", fid: 1, timestamp: 1, network: "x" }, hash: "0x" })).toBeNull();
  });
  it("merges follows' casts newest first", async () => {
    const api = {
      linksByFid: async () => ({ messages: [{ data: { type: "MESSAGE_TYPE_LINK_ADD", fid: 1, timestamp: 1, network: "x", linkBody: { type: "follow", targetFid: 2 } }, hash: "0xl" }] }),
      castsByFid: async (fid: number) => ({ messages: fid === 1 ? [castMsg(1, "0xa", 10, "old")] : [castMsg(2, "0xb", 20, "new")] }),
    };
    const feed = await loadFeed(api, 1, []);
    expect(feed.map((c) => c.text)).toEqual(["new", "old"]);
  });
  it("shows optimistic casts until the node returns them", () => {
    const p = { hash: "0xp", kind: "cast", fid: 1, text: "pending!", status: "relayed" } as PendingItem;
    const confirmedCasts = [toFeedCast(castMsg(1, "0xa", 10, "x"))!];
    expect(mergeFeed(confirmedCasts, [p], 99).map((c) => c.text)).toEqual(["pending!", "x"]);
    const nowVisible = [...confirmedCasts, toFeedCast(castMsg(1, "0xP", 50, "pending!"))!];
    const merged = mergeFeed(nowVisible, [p], 99);
    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.text === "pending!")!.pending).toBeUndefined();
  });
});
