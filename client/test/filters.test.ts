// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { addToList, applyFilters, emptyFilters, FILTERS_KEY, hiddenReason, loadFilters, removeFromList, saveFilters } from "../src/filters";
import { MemoryKV } from "../src/storage";

const casts = [
  { fid: 1, text: "Hello Farcaster" },
  { fid: 2, text: "gm everyone" },
  { fid: 3, text: "Buy my SHITCOIN now" },
  { fid: 4, text: "snapchain is live" },
];

describe("filters", () => {
  it("shows everything with empty filters", () => {
    expect(applyFilters(casts, emptyFilters())).toHaveLength(4);
  });
  it("mutes FIDs", () => {
    const f = addToList(emptyFilters(), "mutedFids", "2");
    expect(typeof f).toBe("object");
    expect(applyFilters(casts, f as ReturnType<typeof emptyFilters>).map((c) => c.fid)).toEqual([1, 3, 4]);
  });
  it("mutes keywords case-insensitively", () => {
    const f = addToList(emptyFilters(), "mutedKeywords", "  ShitCoin ") as ReturnType<typeof emptyFilters>;
    expect(f.mutedKeywords).toEqual(["shitcoin"]);
    expect(hiddenReason(casts[2]!, f)).toBe('muted keyword "shitcoin"');
    expect(applyFilters(casts, f)).toHaveLength(3);
  });
  it("include FIDs and keywords narrow the feed; exclude wins", () => {
    let f = addToList(emptyFilters(), "includeFids", "1") as ReturnType<typeof emptyFilters>;
    f = addToList(f, "includeFids", "4") as ReturnType<typeof emptyFilters>;
    expect(applyFilters(casts, f).map((c) => c.fid)).toEqual([1, 4]);
    f = addToList(f, "includeKeywords", "snapchain") as ReturnType<typeof emptyFilters>;
    expect(applyFilters(casts, f).map((c) => c.fid)).toEqual([4]);
    f = addToList(f, "mutedFids", "4") as ReturnType<typeof emptyFilters>;
    expect(applyFilters(casts, f)).toEqual([]);
  });
  it("rejects invalid input and ignores duplicates", () => {
    expect(addToList(emptyFilters(), "mutedFids", "abc")).toBe("FID must be a positive integer");
    expect(addToList(emptyFilters(), "mutedFids", "0")).toBe("FID must be a positive integer");
    expect(addToList(emptyFilters(), "mutedKeywords", "   ")).toBe("keyword must be 1-100 characters");
    const f = addToList(emptyFilters(), "mutedFids", "5") as ReturnType<typeof emptyFilters>;
    expect(addToList(f, "mutedFids", "5")).toBe(f);
  });
  it("removes entries", () => {
    const f = addToList(emptyFilters(), "mutedFids", "5") as ReturnType<typeof emptyFilters>;
    expect(removeFromList(f, "mutedFids", 5).mutedFids).toEqual([]);
  });
  it("persists to storage and sanitizes corrupted data", () => {
    const kv = new MemoryKV();
    const f = addToList(emptyFilters(), "mutedKeywords", "spam") as ReturnType<typeof emptyFilters>;
    saveFilters(kv, f);
    expect(loadFilters(kv)).toEqual(f);
    kv.set(FILTERS_KEY, "{not json");
    expect(loadFilters(kv)).toEqual(emptyFilters());
    kv.set(FILTERS_KEY, JSON.stringify({ mutedFids: ["7", -1, "x", 7], mutedKeywords: [42, " A "] }));
    expect(loadFilters(kv)).toEqual({ mutedFids: [7], mutedKeywords: ["42", "a"], includeFids: [], includeKeywords: [], hideApps: [], includeApps: [] });
  });
});
