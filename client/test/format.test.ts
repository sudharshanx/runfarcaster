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
    const p = profileFromUserData([ud("USER_DATA_TYPE_DISPLAY", "Old", 1), ud("USER_DATA_TYPE_DISPLAY", "Dan", 2), ud("USER_DATA_TYPE_USERNAME", "dwr", 1), ud("USER_DATA_TYPE_BIO", "x", 3)]);
    expect(p).toEqual({ displayName: "Dan", username: "dwr" });
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
