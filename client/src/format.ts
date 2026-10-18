// SPDX-License-Identifier: MIT
// Small pure helpers for what the UI shows: relative times and the node health pill.
import type { InfoJson } from "./api";

/** "now", "5m", "3h", "2d", then a short date ("Mar 4", or "Mar 4, 2024" in another year). */
export function timeAgo(then: Date, now: Date = new Date()): string {
  const s = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

export type NodeHealth = "ok" | "behind";
/** A read node always trails the validators by a few blocks; more than this many seconds counts as catching up. */
export const BEHIND_SECONDS = 60;
export function nodeHealth(info: InfoJson): NodeHealth {
  const worst = Math.max(0, ...(info.shardInfos ?? []).map((s) => Number(s.blockDelay) || 0));
  return worst > BEHIND_SECONDS ? "behind" : "ok";
}

/** UTF-8 bytes left for a cast (the protocol limit is in bytes, not characters). */
export const bytesLeft = (text: string, max = 320) => max - new TextEncoder().encode(text).length;

/** Error messages from lower layers start lowercase; show them as a sentence. */
export const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Only http(s) links are shown as links. The label is the host, plus the path when it is short. */
export function linkLabel(raw: string, maxPath = 24): { href: string; label: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.host.replace(/^www\./, "");
  const path = u.pathname === "/" ? "" : u.pathname;
  return { href: u.href, label: path.length <= maxPath ? host + path : `${host}/…` };
}

export type EmbedKind = "image" | "video" | "link";
const IMAGE_HOSTS = ["imagedelivery.net", "i.imgur.com"];
const VIDEO_HOSTS = ["stream.warpcast.com", "stream.farcaster.xyz"];
/** Guess what a link points at from its file extension or a few well-known media hosts. Nothing is fetched. */
export function embedKind(raw: string): EmbedKind {
  let u: URL;
  try { u = new URL(raw); } catch { return "link"; }
  const host = u.hostname.replace(/^www\./, "");
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname) || IMAGE_HOSTS.includes(host)) return "image";
  if (/\.(mp4|webm|mov|m3u8)$/i.test(u.pathname) || VIDEO_HOSTS.includes(host)) return "video";
  return "link";
}
/** Host without "www.", for chip labels. */
export const hostOf = (raw: string) => { try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return ""; } };
