// SPDX-License-Identifier: MIT
//
// Everything that signs: app key generation, KEY_ADD, casts, likes and follows. It pulls in
// @farcaster/core, viem and the curve code (most of the bundle), so main.ts loads this module only
// when you open "Add app key" or have an app key. Reading the feed never downloads it.
// The modules re-exported here are unchanged; this file only moves them into their own chunk.
export { generateAppKey, privateKeyBytes, toStored } from "./appkey";
export { buildCast, buildFollow, buildReaction, signerFromPrivateKey } from "./messages";
export { DEFAULT_TTL_SECONDS, buildKeyAdd, isKeyActive } from "./signer";
