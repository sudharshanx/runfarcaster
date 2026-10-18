// SPDX-License-Identifier: MIT
//
// "Posted with": which app a cast came from, read from your node.
//
// Every cast is signed by an app key (its "signer" field). When an app key is added, the app that
// asked for it signs a SignedKeyRequest, and its FID (requestFid) is stored with the key: onchain
// in the KeyRegistry event's metadata, and for gasless KEY_ADDs in the same ABI-encoded metadata.
// GET /v1/signersByFid lists an account's keys with that metadata, so signer -> app FID needs no
// third-party API. The app's name is the username of that app FID.
//
// Keys that were removed are no longer listed, so casts signed with them show as "unknown app".
import type { NodeApi } from "./api";
import type { KV } from "./storage";

/** ABI-encoded SignedKeyRequestMetadata (requestFid, requestSigner, signature, deadline): the first field is requestFid. */
export function requestFidFromMetadata(meta: string | undefined | null): number | null {
  if (!meta) return null;
  let bytes: Uint8Array;
  try {
    if (/^0x[0-9a-f]*$/i.test(meta)) bytes = Uint8Array.from(meta.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16));
    else bytes = Uint8Array.from(atob(meta), (c) => c.charCodeAt(0));
  } catch { return null; }
  const word = (i: number) => { let v = 0n; for (const b of bytes.slice(i * 32, i * 32 + 32)) v = (v << 8n) | BigInt(b); return v; };
  if (bytes.length < 128) return null;
  // abi.encode(struct with a dynamic member) starts with the offset of the tuple (0x20).
  const first = word(0) === 32n ? 1 : 0;
  const fid = word(first);
  return fid > 0n && fid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fid) : null;
}

type SignerEntry = {
  key?: string;
  metadata?: string;
  requestFid?: number; appFid?: number;
  onChainEvent?: { signerEventBody?: { key?: string; metadata?: string } };
  keyAddBody?: { metadata?: string };
};
/** The app FID recorded for one entry of /v1/signersByFid, or null if it has none. */
export function appFidOfSigner(s: SignerEntry): number | null {
  for (const v of [s.requestFid, s.appFid]) if (Number.isSafeInteger(v) && (v as number) > 0) return v as number;
  return requestFidFromMetadata(s.onChainEvent?.signerEventBody?.metadata ?? s.metadata ?? s.keyAddBody?.metadata);
}

const CACHE_KEY = "signerApps.v1";
const MAX_CACHED = 5000;

/** signer key -> app FID (null: the node lists no app for it). Cached per signer in this browser. */
export class AppIndex {
  private bySigner = new Map<string, number | null>();
  private readFids = new Set<number>();
  constructor(private readonly api: Pick<NodeApi, "signersByFid">, private readonly kv?: KV) {
    try {
      const raw = kv?.get(CACHE_KEY);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) if (/^0x[0-9a-f]{64}$/.test(k) && Number.isSafeInteger(v) && v > 0) this.bySigner.set(k, v);
    } catch { /* ignore a bad cache */ }
  }
  /** App FID for a cast: number, null (unknown app) or undefined (not looked up yet). */
  appOf(c: { signer?: string }): number | null | undefined {
    if (!c.signer) return null;
    return this.bySigner.get(c.signer.toLowerCase());
  }
  /** Look up the keys of these authors, once per author per page load, only where a cast's signer is not cached. */
  async load(casts: Array<{ fid: number; signer?: string }>): Promise<void> {
    const need = [...new Set(casts.filter((c) => c.signer && !this.bySigner.has(c.signer.toLowerCase()) && !this.readFids.has(c.fid)).map((c) => c.fid))];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(6, need.length) }, async () => {
      while (i < need.length) {
        const fid = need[i++]!;
        this.readFids.add(fid);
        try {
          const r = await this.api.signersByFid(fid);
          for (const s of r.signers as SignerEntry[]) {
            const key = (s.key ?? s.onChainEvent?.signerEventBody?.key)?.toLowerCase();
            if (key) this.bySigner.set(key, appFidOfSigner(s));
          }
        } catch { this.readFids.delete(fid); }
      }
    }));
    // Signers we asked about but the node doesn't list (removed keys): unknown app.
    for (const c of casts) if (c.signer && this.readFids.has(c.fid) && !this.bySigner.has(c.signer.toLowerCase())) this.bySigner.set(c.signer.toLowerCase(), null);
    this.save();
  }
  private save() {
    if (!this.kv) return;
    const known = [...this.bySigner].filter((e): e is [string, number] => e[1] !== null).slice(-MAX_CACHED);
    try { this.kv.set(CACHE_KEY, JSON.stringify(Object.fromEntries(known))); } catch { /* storage full */ }
  }
}
