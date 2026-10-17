// SPDX-License-Identifier: MIT
// Gasless KEY_ADD construction, verified independently against the EIP-712 domain/types that
// snapchain's validator uses (src/core/validations/key.rs @ fc87f26, see SOURCES.md).
// Uses the PUBLIC Hardhat/Foundry test mnemonic below; it is a well-known test vector, not a secret.
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { Message, MessageData, MessageType, getFarcasterTime } from "@farcaster/core";
import { bytesToHex, decodeAbiParameters, recoverTypedDataAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { buildKeyAdd, DEADLINE_SECONDS, isKeyActive, nextNonce, normalizeMnemonic, validateTtl } from "../src/signer";
import { APP_KEY_SCOPES } from "../src/messages";
import { NodeApiError } from "../src/api";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const CUSTODY = mnemonicToAccount(TEST_MNEMONIC).address; // 0xf39F...2266 (well-known)
const FID = 4242;
const NOW = getFarcasterTime()._unsafeUnwrap(); // core validates the deadline against the real clock

// Copied from snapchain src/core/validations/key.rs (KEY_DOMAIN_NAME/VERSION, ETH_MAINNET_CHAIN_ID, key_add_types)
const DOMAIN = { name: "Farcaster KeyAdd", version: "1", chainId: 1 } as const;
const KEY_ADD_TYPES = {
  KeyAdd: [
    { name: "fid", type: "uint256" }, { name: "key", type: "bytes" }, { name: "keyType", type: "uint32" },
    { name: "scopes", type: "uint32[]" }, { name: "ttl", type: "uint32" }, { name: "nonce", type: "uint32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const SKR_TYPES = { SignedKeyRequest: [{ name: "requestFid", type: "uint256" }, { name: "key", type: "bytes" }, { name: "deadline", type: "uint256" }] } as const;

const fakeApi = (currentUserNonce = 6) => {
  const calls: string[] = [];
  return {
    calls,
    api: {
      idRegistryEventByAddress: vi.fn(async (address: string) => {
        calls.push(`idRegistryEventByAddress ${address}`);
        if (address.toLowerCase() !== CUSTODY.toLowerCase()) throw new NodeApiError("not found", 400, "not_found");
        return { fid: FID };
      }),
      signersByFid: vi.fn(async (fid: number) => { calls.push(`signersByFid ${fid}`); return { signers: [], currentUserNonce }; }),
    },
  };
};

describe("gasless KEY_ADD", () => {
  it("nonce = currentUserNonce + 1; TTL bounded to 90 days", () => {
    expect(nextNonce(0)).toBe(1);
    expect(nextNonce(41)).toBe(42);
    expect(() => nextNonce(-1)).toThrow();
    expect(validateTtl(90 * 86400)).toBe(7776000);
    expect(() => validateTtl(90 * 86400 + 1)).toThrow(/90 days/);
    expect(() => validateTtl(0)).toThrow();
  });

  it("normalizes phrases and rejects wrong word counts", () => {
    expect(normalizeMnemonic("  Test  test\ntest test test test test test test test test JUNK ")).toBe(TEST_MNEMONIC);
    expect(() => normalizeMnemonic("one two three")).toThrow(/12-24/);
  });

  it("builds a KEY_ADD whose custody signature and metadata recover the custody address", async () => {
    const appPk = ed25519.utils.randomPrivateKey();
    const appPub = ed25519.getPublicKey(appPk);
    const { api, calls } = fakeApi(6);
    const logSpy = vi.spyOn(console, "log"); const errSpy = vi.spyOn(console, "error");

    const res = await buildKeyAdd({ mnemonic: TEST_MNEMONIC, appPrivateKey: appPk, api, ttl: 7 * 86400, now: () => NOW });

    expect(res.plan).toMatchObject({ fid: FID, nonce: 7, ttl: 604800, custodyAddress: CUSTODY });
    expect(calls).toEqual([`idRegistryEventByAddress ${CUSTODY}`, `signersByFid ${FID}`]);

    const msg = Message.decode(res.bytes);
    const data = MessageData.decode(msg.dataBytes!);
    expect(data.type).toBe(MessageType.KEY_ADD);
    expect(data.fid).toBe(FID);
    const body = data.keyAddBody!;
    expect(bytesToHex(body.key)).toBe(bytesToHex(appPub));
    expect(body.keyType).toBe(1);
    expect(body.metadataType).toBe(1);
    expect(body.nonce).toBe(7);
    expect(body.ttl).toBe(604800);
    expect(body.scopes).toEqual(APP_KEY_SCOPES);
    expect(body.scopes).not.toContain(MessageType.KEY_ADD);
    expect(body.scopes).not.toContain(MessageType.KEY_REMOVE);
    expect(body.deadline).toBe(NOW + DEADLINE_SECONDS);

    // 1) KeyAdd custody authorization, recovered with snapchain's domain + types.
    const signer = await recoverTypedDataAddress({
      domain: DOMAIN, types: KEY_ADD_TYPES, primaryType: "KeyAdd",
      message: { fid: BigInt(FID), key: bytesToHex(body.key), keyType: 1, scopes: body.scopes, ttl: body.ttl, nonce: body.nonce, deadline: BigInt(body.deadline) },
      signature: bytesToHex(body.custodySignature),
    });
    expect(signer).toBe(CUSTODY);

    // 2) Gasless SignedKeyRequest metadata (ABI tuple), same "Farcaster KeyAdd" domain - NOT the
    //    onchain "Farcaster SignedKeyRequestValidator" domain used by getSignedKeyRequestMetadata.
    const [meta] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "requestFid", type: "uint256" }, { name: "requestSigner", type: "address" }, { name: "signature", type: "bytes" }, { name: "deadline", type: "uint256" }] }],
      bytesToHex(body.metadata),
    );
    expect(meta.requestFid).toBe(BigInt(FID));
    expect(meta.requestSigner).toBe(CUSTODY);
    const skrSigner = await recoverTypedDataAddress({
      domain: DOMAIN, types: SKR_TYPES, primaryType: "SignedKeyRequest",
      message: { requestFid: BigInt(FID), key: bytesToHex(body.key), deadline: meta.deadline }, signature: meta.signature,
    });
    expect(skrSigner).toBe(CUSTODY);

    // 3) Envelope is signed by the NEW app key (proof of possession).
    expect(bytesToHex(msg.signer)).toBe(bytesToHex(appPub));
    expect(ed25519.verify(msg.signature, msg.hash, appPub)).toBe(true);

    // 4) The phrase never leaves: not in the output bytes, not logged.
    const asText = new TextDecoder("latin1").decode(res.bytes);
    expect(asText.includes("test test")).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("fails clearly when the phrase's address owns no FID (nothing is signed)", async () => {
    const { api } = fakeApi();
    api.idRegistryEventByAddress.mockResolvedValueOnce({ fid: 0 });
    await expect(buildKeyAdd({ mnemonic: TEST_MNEMONIC, appPrivateKey: ed25519.utils.randomPrivateKey(), api })).rejects.toThrow(/no FID/);
    expect(api.signersByFid).not.toHaveBeenCalled();
  });

  it("isKeyActive: true when /v1/signer returns the key, false on not_found", async () => {
    const key = "0x" + "11".repeat(32);
    expect(await isKeyActive({ signer: async () => ({ signer: { key, fid: 1, source: "SIGNER_SOURCE_OFFCHAIN" } }) }, 1, key)).toBe(true);
    expect(await isKeyActive({ signer: async () => { throw new NodeApiError("x", 400, "not_found"); } }, 1, key)).toBe(false);
  });
});
