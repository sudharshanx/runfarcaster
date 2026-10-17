// SPDX-License-Identifier: MIT
// Optimistic UI reconciliation against a fake node (no network).
import { describe, expect, it } from "vitest";
import { NodeApiError, type MessageJson } from "../src/api";
import { buildCast, buildFollow, signerFromPrivateKey } from "../src/messages";
import { NOTES, PENDING_KEY, Reconciler } from "../src/pending";
import { MemoryKV } from "../src/storage";

const signer = signerFromPrivateKey(new Uint8Array(32).fill(3));
const opts = { fid: 10, signer, timestamp: 150_000_000 };
const cfg = { checkIntervalMs: 1000, resubmitAfterMs: 5000, maxSubmits: 3 };

function fakeNode() {
  const merged = new Map<string, MessageJson>();
  const state = { submits: 0, dropGossip: true, reject: null as NodeApiError | null, down: false };
  const notFound = () => new NodeApiError("not found", 404, "not_found");
  const api = {
    submitMessage: async (_b: Uint8Array): Promise<MessageJson> => {
      if (state.down) throw new TypeError("Failed to fetch");
      if (state.reject) throw state.reject;
      state.submits++;
      return { data: { type: "x", fid: 10, timestamp: 0, network: "m" }, hash: "0x" };
    },
    castById: async (_fid: number, hash: string) => { const m = merged.get(hash); if (!m) throw notFound(); return m; },
    linkById: async (_fid: number, target: number) => { const m = merged.get(`link:${target}`); if (!m) throw notFound(); return m; },
    reactionById: async () => { throw notFound(); },
  };
  return { api, merged, state };
}

describe("Reconciler", () => {
  it("shows immediately, then confirms once the node returns the message", async () => {
    const { api, merged } = fakeNode();
    let t = 0; const kv = new MemoryKV();
    const r = new Reconciler(api, kv, () => t, cfg);
    const m = await buildCast("hello", opts);
    const item = await r.add(m);
    expect(item.status).toBe("relayed");
    expect(item.note).toBe(NOTES.relayed);
    expect(JSON.parse(kv.get(PENDING_KEY)!)).toHaveLength(1);
    t = 1000; await r.tick();
    expect(r.list()[0]!.status).toBe("relayed");
    merged.set(m.hash, { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 10, timestamp: 1, network: "m" }, hash: m.hash });
    t = 2000; await r.tick();
    expect(r.list()[0]!.status).toBe("confirmed");
  });

  it("resubmits the same bytes when gossip is lost, then flags failure clearly", async () => {
    const { api, state } = fakeNode();
    let t = 0;
    const r = new Reconciler(api, new MemoryKV(), () => t, cfg);
    await r.add(await buildCast("lost", opts));
    for (t = 1000; t <= 30_000; t += 1000) await r.tick();
    expect(state.submits).toBe(3); // maxSubmits
    const it0 = r.list()[0]!;
    expect(it0.status).toBe("failed");
    expect(it0.note).toBe(NOTES.failedNever);
    expect(it0.note).toMatch(/no mempool/);
    await r.retry(it0.hash);
    expect(state.submits).toBe(4);
    expect(r.list()[0]!.status).toBe("relayed");
  });

  it("does not retry messages the node rejects as invalid", async () => {
    const { api, state } = fakeNode();
    state.reject = new NodeApiError("node returned HTTP 400: invalid signer", 400, "bad_request.validation_failure");
    const r = new Reconciler(api, new MemoryKV(), () => 0, cfg);
    const item = await r.add(await buildCast("bad", opts));
    expect(item.status).toBe("failed");
    expect(item.note).toMatch(/Rejected by the node: .*invalid signer/);
  });

  it("treats a network error as retryable", async () => {
    const { api, state, merged } = fakeNode();
    state.down = true;
    let t = 0;
    const r = new Reconciler(api, new MemoryKV(), () => t, cfg);
    const m = await buildFollow(77, opts);
    const item = await r.add(m);
    expect(item.status).toBe("retrying");
    state.down = false;
    t = 6000; await r.tick(); // resubmit
    merged.set("link:77", { data: { type: "MESSAGE_TYPE_LINK_ADD", fid: 10, timestamp: 1, network: "m" }, hash: m.hash });
    t = 7000; await r.tick();
    expect(r.list()[0]!.status).toBe("confirmed");
  });

  it("a follow by someone else's message (different hash) does not count as ours", async () => {
    const { api, merged } = fakeNode();
    let t = 0;
    const r = new Reconciler(api, new MemoryKV(), () => t, cfg);
    await r.add(await buildFollow(55, opts));
    merged.set("link:55", { data: { type: "MESSAGE_TYPE_LINK_ADD", fid: 10, timestamp: 1, network: "m" }, hash: "0xdeadbeef" });
    t = 1000; await r.tick();
    expect(r.list()[0]!.status).not.toBe("confirmed");
  });

  it("survives reload (state in storage) and de-duplicates by hash", async () => {
    const { api } = fakeNode();
    const kv = new MemoryKV();
    const m = await buildCast("persist", opts);
    await new Reconciler(api, kv, () => 0, cfg).add(m);
    const r2 = new Reconciler(api, kv, () => 0, cfg);
    expect(r2.list().map((i) => i.hash)).toEqual([m.hash]);
    await r2.add(m);
    expect(r2.list()).toHaveLength(1);
  });
});
