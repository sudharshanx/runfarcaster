// SPDX-License-Identifier: MIT
// @farcaster/core 0.20.0 calls Node's global `Buffer` in some browser-reachable paths
// (e.g. validateLinkType, used by makeLinkAdd). Browsers have no Buffer, so provide the
// MIT-licensed `buffer` package. Must be imported before anything from @farcaster/core runs.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
