// SPDX-License-Identifier: MIT
// Plain-words help: username lookup and what to do when adding an app key fails.
import { NodeApiError, type NodeApi } from "./api";

export type FidLookup =
  | { ok: true; fid: number; name?: string }
  | { ok: false; reason: "empty" | "invalid" | "not-found" | "unreachable"; name?: string };

/** "3", "@dwr", "dwr" or "vitalik.eth" to an FID. Names are resolved on your node (username proofs). */
export async function resolveFid(raw: string, api: Pick<NodeApi, "userNameProofByName">): Promise<FidLookup> {
  const v = raw.trim();
  if (!v) return { ok: false, reason: "empty" };
  if (/^\d+$/.test(v)) {
    const fid = Number(v);
    return Number.isSafeInteger(fid) && fid > 0 ? { ok: true, fid } : { ok: false, reason: "invalid" };
  }
  const name = v.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(name)) return { ok: false, reason: "invalid", name };
  try {
    const r = await api.userNameProofByName(name);
    const fid = Number(r.fid);
    return Number.isSafeInteger(fid) && fid > 0 ? { ok: true, fid, name } : { ok: false, reason: "not-found", name };
  } catch (e) {
    // The node answers an unknown name with a 4xx; anything else means we could not ask it.
    if (e instanceof NodeApiError && e.status >= 400 && e.status < 500) return { ok: false, reason: "not-found", name };
    return { ok: false, reason: "unreachable", name };
  }
}

export function lookupMessage(r: Extract<FidLookup, { ok: false }>): string {
  switch (r.reason) {
    case "empty": return "Enter your FID or your username.";
    case "invalid": return "That isn't an FID or a username. An FID is a number, like 3. A username looks like dwr or vitalik.eth.";
    case "not-found": return `No account called @${r.name} on your node. Check the spelling, or enter your FID number instead.`;
    case "unreachable": return "Couldn't ask your node. Check that it's running, then try again.";
  }
}

/** Turn an add-key error into what to do next. The input never contains the phrase. */
export function explainKeyError(message: string): string {
  if (/no FID is registered/i.test(message)) return "This recovery phrase doesn't own a Farcaster account that your node knows. Check the words. If the account is new, wait until your node has synced it.";
  if (/recovery phrase has/i.test(message)) return "A recovery phrase has 12, 15, 18, 21 or 24 words. Check for a missing or extra word.";
  if (/mnemonic|checksum|word/i.test(message)) return "One of the words isn't valid. Check the spelling of each word.";
  if (/HTTP \d+|fetch|network/i.test(message)) return `Your node didn't accept the request (${message}). Check that your node is reachable, then try again.`;
  return `Couldn't add the app key: ${message}`;
}
