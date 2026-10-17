// SPDX-License-Identifier: MIT
//
// Construction of Farcaster protocol messages with @farcaster/core. Pure functions: they build
// and sign, but never send anything. Sending happens in api.ts / pending.ts.
import "./polyfills";
import {
  CastType,
  FarcasterNetwork,
  Message,
  MessageType,
  NobleEd25519Signer,
  ReactionType,
  bytesToHexString,
  makeCastAdd,
  makeLinkAdd,
  makeReactionAdd,
  type HubResult,
  type Signer,
} from "@farcaster/core";
import { hexToBytes } from "viem";

/**
 * Minimum scopes for this client's features (post, react, follow). The app key can sign
 * nothing else. KEY_ADD / KEY_REMOVE are never admissible scopes anyway.
 */
export const APP_KEY_SCOPES: MessageType[] = [MessageType.CAST_ADD, MessageType.REACTION_ADD, MessageType.LINK_ADD];

export const NETWORK = FarcasterNetwork.MAINNET;

export interface BuiltMessage {
  kind: "cast" | "like" | "recast" | "follow";
  fid: number;
  hash: string; // 0x-hex
  bytes: Uint8Array; // protobuf Message, ready for POST /v1/submitMessage
  // Fields needed to query the message back from the node:
  target?: { fid: number; hash?: string };
  text?: string;
}

export const MAX_CAST_BYTES = 320; // protocol limit for CastAddBody.text (validated by core too)

export const encodeMessage = (m: Message): Uint8Array => Message.encode(m).finish();

function finish(kind: BuiltMessage["kind"], fid: number, m: Message, extra: Partial<BuiltMessage>): BuiltMessage {
  const hash = bytesToHexString(m.hash);
  if (hash.isErr()) throw hash.error;
  return { kind, fid, hash: hash.value, bytes: encodeMessage(m), ...extra };
}

function unwrap<T>(r: HubResult<T>): T {
  if (r.isErr()) throw new Error(`message construction failed: ${r.error.message}`);
  return r.value;
}

export interface BuildOpts { fid: number; signer: Signer; timestamp?: number }

export async function buildCast(text: string, o: BuildOpts): Promise<BuiltMessage> {
  const t = text.trim();
  if (t.length === 0) throw new Error("cast text is empty");
  if (new TextEncoder().encode(t).length > MAX_CAST_BYTES) throw new Error(`cast text exceeds ${MAX_CAST_BYTES} bytes`);
  const m = unwrap(await makeCastAdd(
    { text: t, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: CastType.CAST },
    { fid: o.fid, network: NETWORK, timestamp: o.timestamp },
    o.signer,
  ));
  return finish("cast", o.fid, m, { text: t });
}

export async function buildReaction(kind: "like" | "recast", target: { fid: number; hash: string }, o: BuildOpts): Promise<BuiltMessage> {
  const m = unwrap(await makeReactionAdd(
    { type: kind === "like" ? ReactionType.LIKE : ReactionType.RECAST, targetCastId: { fid: target.fid, hash: hexToBytes(target.hash as `0x${string}`) } },
    { fid: o.fid, network: NETWORK, timestamp: o.timestamp },
    o.signer,
  ));
  return finish(kind, o.fid, m, { target });
}

export async function buildFollow(targetFid: number, o: BuildOpts): Promise<BuiltMessage> {
  if (!Number.isSafeInteger(targetFid) || targetFid <= 0) throw new Error("invalid target FID");
  if (targetFid === o.fid) throw new Error("cannot follow yourself");
  const m = unwrap(await makeLinkAdd({ type: "follow", targetFid }, { fid: o.fid, network: NETWORK, timestamp: o.timestamp }, o.signer));
  return finish("follow", o.fid, m, { target: { fid: targetFid } });
}

export const signerFromPrivateKey = (pk: Uint8Array): NobleEd25519Signer => new NobleEd25519Signer(pk);
