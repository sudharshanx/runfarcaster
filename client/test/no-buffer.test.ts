// SPDX-License-Identifier: MIT
// Browsers have no global Buffer. @farcaster/core 0.20.0 uses it in makeLinkAdd's validation.
// Remove it, then check our polyfill makes message construction work anyway.
import { afterAll, describe, expect, it } from "vitest";

const g = globalThis as { Buffer?: unknown };
const saved = g.Buffer;

describe("browser-like environment without global Buffer", () => {
  afterAll(() => { g.Buffer = saved; });
  it("core needs Buffer (documents why the polyfill exists)", async () => {
    delete g.Buffer;
    const core = await import("@farcaster/core");
    const signer = new core.NobleEd25519Signer(new Uint8Array(32).fill(9));
    await expect(core.makeLinkAdd({ type: "follow", targetFid: 2 }, { fid: 1, network: core.FarcasterNetwork.MAINNET }, signer))
      .rejects.toThrow(/Buffer/);
    g.Buffer = saved;
  });
  it("with src/polyfills.ts, follow/cast construction works", async () => {
    delete g.Buffer;
    await import("../src/polyfills");
    expect(typeof g.Buffer).toBe("function");
    const { buildFollow, buildCast, signerFromPrivateKey } = await import("../src/messages");
    const signer = signerFromPrivateKey(new Uint8Array(32).fill(9));
    await expect(buildFollow(2, { fid: 1, signer })).resolves.toMatchObject({ kind: "follow" });
    await expect(buildCast("hi", { fid: 1, signer })).resolves.toMatchObject({ kind: "cast" });
  });
});
