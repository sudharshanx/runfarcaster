// SPDX-License-Identifier: MIT
/** Minimal key-value interface so logic can be unit-tested without a browser. */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryKV implements KV {
  private m = new Map<string, string>();
  get(key: string) { return this.m.get(key) ?? null; }
  set(key: string, value: string) { this.m.set(key, value); }
  remove(key: string) { this.m.delete(key); }
}

export const browserKV = (): KV => ({
  get: (k) => window.localStorage.getItem(k),
  set: (k, v) => window.localStorage.setItem(k, v),
  remove: (k) => window.localStorage.removeItem(k),
});

export function readJSON<T>(kv: KV, key: string, fallback: T): T {
  const raw = kv.get(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function writeJSON(kv: KV, key: string, value: unknown): void {
  kv.set(key, JSON.stringify(value));
}
