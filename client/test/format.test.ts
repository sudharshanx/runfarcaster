// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { bytesLeft, linkLabel, nodeHealth, sentence, timeAgo } from "../src/format";
import { loadProfiles, profileFromUserData, toFeedCast } from "../src/feed";

describe("timeAgo", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const ago = (s: number) => timeAgo(new Date(now.getTime() - s * 1000), now);
  it("uses short relative units", () => {
    expect(ago(5)).toBe("now");
    expect(ago(5 * 60)).toBe("5m");
    expect(ago(3 * 3600)).toBe("3h");
    expect(ago(2 * 86400)).toBe("2d");
  });
  it("falls back to a date after a week", () => {
    expect(timeAgo(new Date("2026-03-04T12:00:00Z"), now)).toBe("Mar 4");
    expect(timeAgo(new Date("2024-03-04T12:00:00Z"), now)).toBe("Mar 4, 2024");
  });
});

describe("nodeHealth", () => {
  it("is ok when every shard is close to the tip", () => {
    expect(nodeHealth({ shardInfos: [{ shardId: 0, maxHeight: 1, blockDelay: 3 }, { shardId: 1, maxHeight: 1, blockDelay: 0 }] })).toBe("ok");
  });
  it("is behind when any shard lags more than a minute", () => {
    expect(nodeHealth({ shardInfos: [{ shardId: 0, maxHeight: 1, blockDelay: 2 }, { shardId: 1, maxHeight: 1, blockDelay: 600 }] })).toBe("behind");
  });
  it("treats missing shard info as ok", () => { expect(nodeHealth({})).toBe("ok"); });
});

describe("compose helpers", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(bytesLeft("abc")).toBe(317);
    expect(bytesLeft("é")).toBe(318);
  });
  it("capitalizes error messages", () => { expect(sentence("cast text is empty")).toBe("Cast text is empty"); });
});

const ud = (type: string, value: string, timestamp: number) => ({ data: { type: "MESSAGE_TYPE_USER_DATA_ADD", fid: 3, timestamp, network: "x", userDataBody: { type, value } }, hash: "0x" });

describe("profiles", () => {
  it("takes the newest display name and username", () => {
    const p = profileFromUserData([ud("USER_DATA_TYPE_DISPLAY", "Old", 1), ud("USER_DATA_TYPE_DISPLAY", "Dan", 2), ud("USER_DATA_TYPE_USERNAME", "dwr", 1), ud("USER_DATA_TYPE_BIO", "x", 3), ud("USER_DATA_TYPE_PFP", "https://imagedelivery.net/x", 1)]);
    expect(p).toEqual({ displayName: "Dan", username: "dwr", pfp: "https://imagedelivery.net/x" });
  });
  it("gives an empty profile when the lookup fails", async () => {
    const api = { userDataByFid: async (fid: number) => { if (fid === 2) throw new Error("down"); return { messages: [ud("USER_DATA_TYPE_USERNAME", "dwr", 1)] }; } };
    const m = await loadProfiles(api, [2, 3]);
    expect(m.get(2)).toEqual({});
    expect(m.get(3)).toEqual({ username: "dwr" });
  });
});

describe("embeds", () => {
  it("keeps URL and quoted-cast embeds", () => {
    const c = toFeedCast({ data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 1, timestamp: 1, network: "x", castAddBody: { text: "", embeds: [{ url: "https://example.com/a" }, { castId: { fid: 3, hash: "0x1" } }] } }, hash: "0xa" });
    expect(c?.embeds).toEqual([{ url: "https://example.com/a" }, { castFid: 3 }]);
  });
  it("shows only http(s) links, shortened", () => {
    expect(linkLabel("javascript:alert(1)")).toBeNull();
    expect(linkLabel("not a url")).toBeNull();
    expect(linkLabel("https://www.example.com/")).toEqual({ href: "https://www.example.com/", label: "example.com" });
    expect(linkLabel("https://example.com/a/b")!.label).toBe("example.com/a/b");
    expect(linkLabel(`https://imagedelivery.net/${"x".repeat(40)}/original`)!.label).toBe("imagedelivery.net/…");
  });
});

describe("embedKind", () => {
  it("spots images by extension or known image host", async () => {
    const { embedKind, hostOf } = await import("../src/format");
    expect(embedKind("https://imagedelivery.net/abc/def/original")).toBe("image");
    expect(embedKind("https://example.com/cat.JPG")).toBe("image");
    expect(embedKind("https://stream.warpcast.com/v1/video/x.m3u8")).toBe("video");
    expect(embedKind("https://example.com/post")).toBe("link");
    expect(embedKind("nonsense")).toBe("link");
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
  });
});

describe("remote images", () => {
  it("allows only https URLs on the listed hosts", async () => {
    const { allowedImageUrl } = await import("../src/images");
    expect(allowedImageUrl("https://imagedelivery.net/a/b/original")).toBe("https://imagedelivery.net/a/b/original");
    expect(allowedImageUrl("http://imagedelivery.net/a")).toBeNull();
    expect(allowedImageUrl("https://imagedelivery.net.evil.example/a")).toBeNull();
    expect(allowedImageUrl("https://evil.example/?u=https://imagedelivery.net/")).toBeNull();
    expect(allowedImageUrl("https://user:pw@i.imgur.com/a.png")).toBeNull();
    expect(allowedImageUrl("https://i.imgur.com:8443/a.png")).toBeNull();
    expect(allowedImageUrl("javascript:alert(1)")).toBeNull();
    expect(allowedImageUrl(undefined)).toBeNull();
  });
  it("uses the same img-src in the Vite CSP and in deploy/Caddyfile", async () => {
    const { IMG_SRC } = await import("../src/images");
    const { readFileSync } = await import("node:fs");
    const caddy = readFileSync(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");
    expect(caddy).toContain(`${IMG_SRC};`);
    expect(IMG_SRC).not.toMatch(/https:(\s|;|$)/); // never the whole https: scheme
  });
  it("lockImages adds a stricter CSP meta tag once", async () => {
    const { lockImages, imagesLocked } = await import("../src/images");
    const added: Array<{ httpEquiv: string; content: string }> = [];
    const doc = { createElement: () => ({ httpEquiv: "", content: "" }), head: { append: (m: { httpEquiv: string; content: string }) => added.push(m) } } as unknown as Document;
    lockImages(doc); lockImages(doc);
    expect(imagesLocked()).toBe(true);
    expect(added).toEqual([{ httpEquiv: "Content-Security-Policy", content: "img-src 'self' data:" }]);
  });
});

describe("sample feed", () => {
  it("reads a few recent casts from each sample account and nothing else", async () => {
    const { SAMPLE_ACCOUNTS, loadSampleFeed } = await import("../src/feed");
    expect(SAMPLE_ACCOUNTS.find((a) => a.fname === "balajis")?.fid).toBe(37);
    const calls: Array<[number, number]> = [];
    const api = {
      linksByFid: async () => { throw new Error("not used"); },
      castsByFid: async (fid: number, n?: number) => { calls.push([fid, n ?? 0]); return { messages: [{ data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: fid, network: "x", castAddBody: { text: `c${fid}` } }, hash: `0x${fid}` }] }; },
    };
    const feed = await loadSampleFeed(api);
    expect(calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual(SAMPLE_ACCOUNTS.map((a) => a.fid).sort((a, b) => a - b));
    expect(calls.every((c) => c[1] === 5)).toBe(true);
    expect(feed.slice(0, 3).map((c) => c.fid)).toContain(37); // balajis in the top 3
  });
});

describe("sampleOrder", () => {
  const c = (fid: number, ts: number) => ({ fid, hash: `0x${fid}-${ts}`, text: "", timestamp: ts });
  it("puts one cast per account first, then the rest newest first, with the pinned FID in the top 3", async () => {
    const { sampleOrder } = await import("../src/feed");
    // newest first; FID 9 posts a lot, FID 37 posted long ago
    const input = [c(9, 100), c(9, 99), c(8, 98), c(9, 97), c(7, 96), c(6, 95), c(9, 94), c(37, 10), c(8, 5)];
    const out = sampleOrder(input, 37).map((x) => `${x.fid}@${x.timestamp}`);
    expect(out).toEqual(["9@100", "8@98", "37@10", "7@96", "6@95", "9@99", "9@97", "9@94", "8@5"]);
  });
  it("leaves the pinned FID where it is when it is already in the top 3, and keeps every cast", async () => {
    const { sampleOrder } = await import("../src/feed");
    const input = [c(37, 50), c(2, 40), c(2, 30), c(3, 20)];
    expect(sampleOrder(input, 37).map((x) => x.hash)).toEqual(["0x37-50", "0x2-40", "0x3-20", "0x2-30"]);
    expect(sampleOrder([], 37)).toEqual([]);
  });
});
