// SPDX-License-Identifier: MIT
//
// Remote images (profile pictures and image-post thumbnails).
//
// The CSP allows images from a short list of HTTPS hosts only, not from any https: URL.
// An image request is a way to send data out (the URL is the message), so every allowed host is a
// place a compromised dependency could send data to. We only allow large shared hosts whose request
// logs an outsider cannot read, picked from the pfp URLs on real accounts. Other hosts get the
// letter avatar or a link chip. The reader's IP address is visible to these hosts (no referrer is
// sent: <meta name="referrer" content="no-referrer"> and referrerPolicy on each <img>).
//
// While the add-app-key panel is open (and until the page reloads) we tighten the CSP further to
// img-src 'self' data:, so no image request can leave the page while a recovery phrase is in it.
// The same host list is used by vite.config.ts (dev and build CSP meta) and must match
// deploy/Caddyfile (a unit test checks this).
export const IMAGE_HOSTS = ["imagedelivery.net", "i.imgur.com", "pbs.twimg.com", "lh3.googleusercontent.com"] as const;

export const IMG_SRC = `img-src 'self' data: ${IMAGE_HOSTS.map((h) => `https://${h}`).join(" ")}`;
export const IMG_SRC_LOCKED = "img-src 'self' data:";

/** The URL if it is https on an allowed host (exact host match), else null. */
export function allowedImageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  return (IMAGE_HOSTS as readonly string[]).includes(u.hostname) ? u.href : null;
}

let locked = false;
export const imagesLocked = () => locked;
/** Add a stricter CSP meta tag. CSP policies only ever add up, so this cannot be undone without a reload. */
export function lockImages(doc: Document = document): void {
  if (locked) return;
  locked = true;
  const m = doc.createElement("meta");
  m.httpEquiv = "Content-Security-Policy";
  m.content = IMG_SRC_LOCKED;
  doc.head.append(m);
}
