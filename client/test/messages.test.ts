// SPDX-License-Identifier: MIT
// Message construction, decoded and verified locally. No network.
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { FarcasterNetwork, Message, MessageData, MessageType, ReactionType, bytesToHexString } from "@farcaster/core";
import { APP_KEY_SCOPES, buildCast, buildFollow, buildReaction, signerFromPrivateKey } from "../src/messages";

const pk = new Uint8Array(32).fill(7); // deterministic test key, not a real secret
const signer = signerFromPrivateKey(pk);
const opts = { fid: 1234, signer, timestamp: 150_000_000 };

function verify(bytes: Uint8Array) {
  const m = Message.decode(bytes);
  expect(m.dataBytes && m.dataBytes.length).toBeGreaterThan(0); // snapchain requires dataBytes
  const hash = blake3(m.dataBytes!, { dkLen: 20 });
  expect(Buffer.from(m.hash).equals(Buffer.from(hash))).toBe(true);
  expect(ed25519.verify(m.signature, m.hash, ed25519.getPublicKey(pk))).toBe(true);
  expect(Buffer.from(m.signer).equals(Buffer.from(ed25519.getPublicKey(pk)))).toBe(true);
  return { m, data: MessageData.decode(m.dataBytes!) };
}

describe("message construction", () => {
  it("minimum scopes: only what the client uses", () => {
    expect(APP_KEY_SCOPES).toEqual([MessageType.CAST_ADD, MessageType.REACTION_ADD, MessageType.LINK_ADD]);
  });

  it("builds a signed CAST_ADD with dataBytes and a matching hash", async () => {
    const b = await buildCast("  hello snapchain  ", opts);
    const { m, data } = verify(b.bytes);
    expect(data.type).toBe(MessageType.CAST_ADD);
    expect(data.fid).toBe(1234);
    expect(data.network).toBe(FarcasterNetwork.MAINNET);
    expect(data.timestamp).toBe(150_000_000);
    expect(data.castAddBody?.text).toBe("hello snapchain");
    expect(b.hash).toBe(bytesToHexString(m.hash)._unsafeUnwrap());
  });

  it("is deterministic for the same input (resubmits keep the same hash)", async () => {
    const a = await buildCast("same", opts);
    const b = await buildCast("same", opts);
    expect(a.hash).toBe(b.hash);
  });

  it("rejects empty and oversized casts", async () => {
    await expect(buildCast("   ", opts)).rejects.toThrow(/empty/);
    await expect(buildCast("x".repeat(321), opts)).rejects.toThrow(/320 bytes/);
  });

  it("builds REACTION_ADD like/recast", async () => {
    const target = { fid: 2, hash: "0x" + "ab".repeat(20) };
    const like = verify((await buildReaction("like", target, opts)).bytes).data;
    expect(like.type).toBe(MessageType.REACTION_ADD);
    expect(like.reactionBody?.type).toBe(ReactionType.LIKE);
    expect(like.reactionBody?.targetCastId?.fid).toBe(2);
    expect(bytesToHexString(like.reactionBody!.targetCastId!.hash)._unsafeUnwrap()).toBe(target.hash);
    const recast = verify((await buildReaction("recast", target, opts)).bytes).data;
    expect(recast.reactionBody?.type).toBe(ReactionType.RECAST);
  });

  it("builds LINK_ADD follow and refuses self-follow", async () => {
    const d = verify((await buildFollow(99, opts)).bytes).data;
    expect(d.type).toBe(MessageType.LINK_ADD);
    expect(d.linkBody?.type).toBe("follow");
    expect(d.linkBody?.targetFid).toBe(99);
    await expect(buildFollow(1234, opts)).rejects.toThrow(/yourself/);
  });
});
