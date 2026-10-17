// SPDX-License-Identifier: MIT
//
// The ed25519 "app key" (Farcaster signer) generated in the browser.
// It is NOT the seed phrase. It can only sign the scoped message types in APP_KEY_SCOPES, expires
// on its own (sliding TTL), and can be revoked by the account's custody address at any time.
// It is stored in localStorage so you can keep posting after a reload; "Forget app key" deletes it.
// Anyone with access to this browser profile can use it until it expires or is revoked.
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes } from "viem";
import { type KV, readJSON, writeJSON } from "./storage";

export interface StoredAppKey {
  fid: number;
  privateKeyHex: `0x${string}`;
  publicKeyHex: `0x${string}`;
  createdAt: number; // unix ms
  status: "pending" | "active"; // pending = KEY_ADD submitted, not yet seen in /v1/signersByFid
}

export const APPKEY_KEY = "appKey.v1";

export function generateAppKey(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  // crypto.getRandomValues under the hood (noble's randomBytes).
  const privateKey = ed25519.utils.randomPrivateKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

export const toStored = (fid: number, privateKey: Uint8Array, now = Date.now()): StoredAppKey => ({
  fid,
  privateKeyHex: bytesToHex(privateKey),
  publicKeyHex: bytesToHex(ed25519.getPublicKey(privateKey)),
  createdAt: now,
  status: "pending",
});

export const loadAppKey = (kv: KV): StoredAppKey | null => {
  const k = readJSON<StoredAppKey | null>(kv, APPKEY_KEY, null);
  return k && /^0x[0-9a-f]{64}$/.test(k.privateKeyHex) ? k : null;
};
export const saveAppKey = (kv: KV, k: StoredAppKey) => writeJSON(kv, APPKEY_KEY, k);
export const forgetAppKey = (kv: KV) => kv.remove(APPKEY_KEY);
export const privateKeyBytes = (k: StoredAppKey) => hexToBytes(k.privateKeyHex);
