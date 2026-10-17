// SPDX-License-Identifier: MIT
//
// ONE-TIME gasless KEY_ADD, authorized by the account's custody address.
//
// ============================================================================================
// SECURITY: A seed phrase (recovery phrase) controls the whole Farcaster account, and often
// the wallet's funds. Only paste a seed phrase into software from developers you trust, after
// reading the code. Prefer delegated signers (e.g. "Sign in with Farcaster" / an app-key
// approval flow in the wallet that holds your custody key) wherever possible, so the seed
// phrase never leaves that wallet.
// ============================================================================================
//
// What this module does with the phrase, and nothing else:
//   1. derives the custody account locally (viem mnemonicToAccount, path m/44'/60'/0'/0/0),
//   2. signs exactly two EIP-712 payloads via makeKeyAddBody (the gasless SignedKeyRequest
//      metadata and the KeyAdd authorization over key, scopes, TTL, nonce, deadline),
//   3. returns. The phrase is never stored, logged or sent; only the signed KEY_ADD message
//      (which contains signatures, not the phrase or private key) is sent to the node.
// JavaScript cannot securely wipe memory: strings are immutable and freed by the garbage
// collector. We drop every reference as early as possible (best effort) and the UI clears the
// input field immediately.
//
// We use makeKeyAddBody (getGaslessSignedKeyRequestMetadata, domain "Farcaster KeyAdd",
// chainId 1). We deliberately do NOT use getSignedKeyRequestMetadata: that signs the onchain
// SignedKeyRequestValidator domain, which snapchain rejects for KEY_ADD (see SOURCES.md).
import "./polyfills";
import {
  MAX_KEY_TTL_SECONDS,
  ViemLocalEip712Signer,
  getFarcasterTime,
  makeKeyAdd,
  makeKeyAddBody,
  type MessageType,
} from "@farcaster/core";
import { mnemonicToAccount } from "viem/accounts";
import { NodeApiError, type NodeApi } from "./api";
import { APP_KEY_SCOPES, NETWORK, encodeMessage, signerFromPrivateKey } from "./messages";

export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // short by default; sliding, refreshed on use
export const DEADLINE_SECONDS = 60 * 60; // the custody authorization expires in 1 hour

export interface KeyAddPlan {
  fid: number;
  custodyAddress: `0x${string}`;
  nonce: number;
  scopes: MessageType[];
  ttl: number;
}

/** Next nonce must be strictly greater than the FID's currentUserNonce from GET /v1/signersByFid. */
export const nextNonce = (currentUserNonce: number): number => {
  if (!Number.isSafeInteger(currentUserNonce) || currentUserNonce < 0) throw new Error("invalid currentUserNonce from node");
  return currentUserNonce + 1;
};

export function validateTtl(ttl: number): number {
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_KEY_TTL_SECONDS) {
    throw new Error(`TTL must be 1..${MAX_KEY_TTL_SECONDS} seconds (max 90 days)`);
  }
  return ttl;
}

export function normalizeMnemonic(raw: string): string {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error("a recovery phrase has 12-24 words");
  return words.join(" ");
}

export interface KeyAddResult {
  plan: KeyAddPlan;
  bytes: Uint8Array;
  hash: Uint8Array;
}

/**
 * Builds and signs the KEY_ADD message. Takes the phrase, returns only signed bytes.
 * `fidLookup` resolves the custody address to its FID (via the node) so the user does not have
 * to type it and a wrong phrase is caught before anything is submitted.
 */
export async function buildKeyAdd(args: {
  mnemonic: string;
  appPrivateKey: Uint8Array;
  api: Pick<NodeApi, "signersByFid" | "idRegistryEventByAddress">;
  ttl?: number;
  scopes?: MessageType[];
  now?: () => number; // farcaster time override for tests
}): Promise<KeyAddResult> {
  const ttl = validateTtl(args.ttl ?? DEFAULT_TTL_SECONDS);
  const scopes = args.scopes ?? APP_KEY_SCOPES;
  // Derive the custody account inside this scope only; never assign it to anything long-lived.
  let account: ReturnType<typeof mnemonicToAccount> | null = mnemonicToAccount(normalizeMnemonic(args.mnemonic));
  try {
    const custodyAddress = account.address;
    const reg = await args.api.idRegistryEventByAddress(custodyAddress);
    const fid = Number(reg.fid);
    if (!Number.isSafeInteger(fid) || fid <= 0) throw new Error(`no FID is registered to custody address ${custodyAddress}`);

    const { currentUserNonce } = await args.api.signersByFid(fid);
    const nonce = nextNonce(currentUserNonce);

    const appSigner = signerFromPrivateKey(args.appPrivateKey);
    const key = (await appSigner.getSignerKey())._unsafeUnwrap();
    const nowFc = args.now ? args.now() : getFarcasterTime()._unsafeUnwrap();

    const body = await makeKeyAddBody(
      { fid: BigInt(fid), key, scopes, ttl, nonce, deadline: nowFc + DEADLINE_SECONDS },
      new ViemLocalEip712Signer(account),
    );
    if (body.isErr()) throw new Error(`could not build KEY_ADD: ${body.error.message}`);

    // Envelope is signed by the NEW app key (proof of possession), not by the custody key.
    const msg = await makeKeyAdd(body.value, { fid, network: NETWORK, timestamp: args.now ? nowFc : undefined }, appSigner);
    if (msg.isErr()) throw new Error(`could not sign KEY_ADD: ${msg.error.message}`);

    return { plan: { fid, custodyAddress, nonce, scopes, ttl }, bytes: encodeMessage(msg.value), hash: msg.value.hash };
  } finally {
    account = null; // best effort: drop the only reference to the derived custody account
  }
}

/** True once the app key is returned by GET /v1/signer (covers onchain and gasless keys). */
export async function isKeyActive(api: Pick<NodeApi, "signer">, fid: number, publicKeyHex: string): Promise<boolean> {
  try {
    const r = await api.signer(fid, publicKeyHex);
    return r.signer.key.toLowerCase() === publicKeyHex.toLowerCase();
  } catch (e) {
    if (e instanceof NodeApiError && (e.isNotFound || e.status === 400)) return false;
    throw e;
  }
}
