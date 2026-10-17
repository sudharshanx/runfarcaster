// SPDX-License-Identifier: MIT
//
// Include/exclude filters for the feed. Persisted in localStorage (key "filters.v1").
// Exclude rules always win over include rules.
import { type KV, readJSON, writeJSON } from "./storage";

export interface Filters {
  /** Exclude: never show casts from these FIDs. */
  mutedFids: number[];
  /** Exclude: hide casts whose text contains any of these (case-insensitive, whole substring). */
  mutedKeywords: string[];
  /** Include: if non-empty, only show casts from these FIDs. */
  includeFids: number[];
  /** Include: if non-empty, only show casts containing at least one of these. */
  includeKeywords: string[];
}

export const FILTERS_KEY = "filters.v1";

export const emptyFilters = (): Filters => ({ mutedFids: [], mutedKeywords: [], includeFids: [], includeKeywords: [] });

export interface FilterableCast { fid: number; text: string }

const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();

export function parseFid(input: string): number | null {
  const t = input.trim();
  if (!/^\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function normalizeKeyword(input: string): string | null {
  const k = norm(input);
  return k.length > 0 && k.length <= 100 ? k : null;
}

const containsAny = (text: string, words: string[]) => {
  const t = norm(text);
  return words.some((w) => w.length > 0 && t.includes(w));
};

/** Returns the reason a cast is hidden, or null if it is shown. */
export function hiddenReason(cast: FilterableCast, f: Filters): string | null {
  if (f.mutedFids.includes(cast.fid)) return `muted FID ${cast.fid}`;
  const muted = f.mutedKeywords.find((w) => norm(cast.text).includes(w));
  if (muted) return `muted keyword "${muted}"`;
  if (f.includeFids.length > 0 && !f.includeFids.includes(cast.fid)) return "FID not in include list";
  if (f.includeKeywords.length > 0 && !containsAny(cast.text, f.includeKeywords)) return "no include keyword";
  return null;
}

export const applyFilters = <T extends FilterableCast>(casts: T[], f: Filters): T[] =>
  casts.filter((c) => hiddenReason(c, f) === null);

function sanitize(raw: unknown): Filters {
  const f = emptyFilters();
  if (!raw || typeof raw !== "object") return f;
  const r = raw as Record<string, unknown>;
  const fids = (v: unknown) => (Array.isArray(v) ? v.map((x) => parseFid(String(x))).filter((x): x is number => x !== null) : []);
  const words = (v: unknown) => (Array.isArray(v) ? v.map((x) => normalizeKeyword(String(x))).filter((x): x is string => x !== null) : []);
  return {
    mutedFids: [...new Set(fids(r.mutedFids))],
    mutedKeywords: [...new Set(words(r.mutedKeywords))],
    includeFids: [...new Set(fids(r.includeFids))],
    includeKeywords: [...new Set(words(r.includeKeywords))],
  };
}

export const loadFilters = (kv: KV): Filters => sanitize(readJSON<unknown>(kv, FILTERS_KEY, null));
export const saveFilters = (kv: KV, f: Filters): void => writeJSON(kv, FILTERS_KEY, sanitize(f));

type ListKey = keyof Filters;
const isFidList = (k: ListKey) => k === "mutedFids" || k === "includeFids";

/** Adds a value to one list. Returns the new Filters, or an error string for invalid input. */
export function addToList(f: Filters, list: ListKey, input: string): Filters | string {
  if (isFidList(list)) {
    const fid = parseFid(input);
    if (fid === null) return "FID must be a positive integer";
    const cur = f[list] as number[];
    return cur.includes(fid) ? f : { ...f, [list]: [...cur, fid] };
  }
  const k = normalizeKeyword(input);
  if (k === null) return "keyword must be 1-100 characters";
  const cur = f[list] as string[];
  return cur.includes(k) ? f : { ...f, [list]: [...cur, k] };
}

export function removeFromList(f: Filters, list: ListKey, value: string | number): Filters {
  return { ...f, [list]: (f[list] as Array<string | number>).filter((v) => v !== value) };
}
