// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { AppIndex, appFidOfSigner, requestFidFromMetadata } from "../src/apps";
import { addToList, emptyFilters, hiddenReason } from "../src/filters";
import { toFeedCast } from "../src/feed";

// Metadata of FID 3's onchain signer 0xc887…, as returned by GET /v1/signersByFid?fid=3 on our node
// (public chain data, read on 2026-10-18). requestFid is 9152.
const META_FID3 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjwAAAAAAAAAAAAAAAAALveQ3XmTo1/YR8BT7drpQNBVWWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZO55jgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBmUVWQv9Ny0b1L47L0MPftfyiF8T0lECNeNpo2QK0Kv0HB3HHy1nUZ0J19bcxVHVt7jamCIeKonCMgLQe8kfOKBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const word = (n: number) => n.toString(16).padStart(64, "0");
const hexMeta = (fid: number) => `0x${word(32)}${word(fid)}${word(0)}${word(128)}${word(0)}`;
const KEY = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe("app of a signer", () => {
  it("reads requestFid from real onchain metadata (base64)", () => {
    expect(requestFidFromMetadata(META_FID3)).toBe(9152);
  });
  it("reads hex metadata and rejects junk", () => {
    expect(requestFidFromMetadata(hexMeta(600))).toBe(600);
    expect(requestFidFromMetadata("")).toBeNull();
    expect(requestFidFromMetadata("not base64!")).toBeNull();
    expect(requestFidFromMetadata("AAAA")).toBeNull();
  });
  it("finds the metadata in onchain and gasless entries", () => {
    expect(appFidOfSigner({ onChainEvent: { signerEventBody: { metadata: META_FID3 } } })).toBe(9152);
    expect(appFidOfSigner({ metadata: hexMeta(7) })).toBe(7);
    expect(appFidOfSigner({ key: KEY(1) })).toBeNull();
  });
});

describe("AppIndex", () => {
  const store = new Map<string, string>();
  const kv = { get: (k: string) => store.get(k) ?? null, set: (k: string, v: string) => void store.set(k, v), remove: (k: string) => void store.delete(k) };
  const calls: number[] = [];
  const api = { async signersByFid(fid: number) {
    calls.push(fid);
    return { currentUserNonce: 0, signers: fid === 10 ? [{ source: "SIGNER_SOURCE_ONCHAIN", key: KEY(1), fid, onChainEvent: { signerEventBody: { key: KEY(1), metadata: hexMeta(500) } } }] : [] } as never;
  } };
  it("maps each cast's signer to an app, unknown for keys the node doesn't list, and caches per signer", async () => {
    const idx = new AppIndex(api, kv);
    const casts = [{ fid: 10, signer: KEY(1).toUpperCase().replace("0X", "0x") }, { fid: 10, signer: KEY(2) }, { fid: 11, signer: KEY(3) }];
    expect(idx.appOf(casts[0]!)).toBeUndefined();
    await idx.load(casts);
    expect(idx.appOf(casts[0]!)).toBe(500);
    expect(idx.appOf(casts[1]!)).toBeNull();
    expect(idx.appOf(casts[2]!)).toBeNull();
    await idx.load(casts);
    expect(calls).toEqual([10, 11]); // once per author
    const again = new AppIndex(api, kv); // a new page load reads the cache
    expect(again.appOf(casts[0]!)).toBe(500);
    await again.load([casts[0]!]);
    expect(calls).toEqual([10, 11]);
  });
  it("keeps the signer on feed casts", () => {
    const c = toFeedCast({ hash: "0x01", signer: KEY(1), data: { fid: 1, type: "MESSAGE_TYPE_CAST_ADD", timestamp: 1, network: "x", castAddBody: { text: "hi" } } } as never);
    expect(c?.signer).toBe(KEY(1));
  });
});

describe("Posted with filters", () => {
  const c = (app: number | null | undefined) => ({ fid: 1, text: "hi", app });
  it("hides an app; exclude wins over include", () => {
    let f = addToList(emptyFilters(), "hideApps", "500") as ReturnType<typeof emptyFilters>;
    expect(hiddenReason(c(500), f)).toMatch(/hidden app/);
    expect(hiddenReason(c(600), f)).toBeNull();
    f = addToList(f, "includeApps", "500") as typeof f;
    expect(hiddenReason(c(500), f)).toMatch(/hidden app/);
  });
  it("Only shows listed apps, hides unknown apps, and never hides casts not looked up yet", () => {
    const f = addToList(emptyFilters(), "includeApps", "600") as ReturnType<typeof emptyFilters>;
    expect(hiddenReason(c(600), f)).toBeNull();
    expect(hiddenReason(c(500), f)).toMatch(/include list/);
    expect(hiddenReason(c(null), f)).toMatch(/include list/);
    expect(hiddenReason(c(undefined), f)).toBeNull();
  });
});
