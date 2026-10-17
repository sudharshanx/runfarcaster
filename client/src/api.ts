// SPDX-License-Identifier: MIT
//
// Thin client for the Snapchain node HTTP API (default port 3381, see SOURCES.md).
// baseUrl "" means same origin: the app is served by Caddy, which proxies /v1/* to the node.
//
// Query-string notes verified against snapchain's parser (serde_qs 0.13, see DOCS_ISSUES.md):
//  - booleans must be "true"/"false" ("reverse=1" is rejected with HTTP 400)
//  - list params need "[]" suffix, e.g. requesterFids[]=1 (repeating a plain key is rejected)

export interface CastAddBodyJson {
  text?: string;
  embeds?: Array<{ url?: string; castId?: { fid: number; hash: string } }>;
  mentions?: number[];
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
}

export interface MessageJson {
  data: {
    type: string;
    fid: number;
    timestamp: number;
    network: string;
    castAddBody?: CastAddBodyJson;
    reactionBody?: { type: string; targetCastId?: { fid: number; hash: string } };
    linkBody?: { type: string; targetFid?: number };
    userDataBody?: { type: string; value: string };
  };
  hash: string;
  signer?: string;
}

export interface SignerJson {
  source: string;
  key: string;
  fid: number;
  scopes?: string[];
  ttl?: number;
  expiresAt?: number;
  nonce?: number;
}

export interface SignersByFidJson {
  signers: SignerJson[];
  currentUserNonce: number;
  gaslessSignerCount?: number;
  gaslessSignerLimit?: number;
  nextPageToken?: string;
}

export interface InfoJson {
  version?: string;
  numShards?: number;
  shardInfos?: Array<{ shardId: number; maxHeight: number; blockDelay: number }>;
}

export class NodeApiError extends Error {
  constructor(message: string, readonly status: number, readonly errCode?: string, readonly body?: string) {
    super(message);
  }
  get isNotFound(): boolean {
    return this.status === 404 || (this.errCode ?? "").startsWith("not_found");
  }
  get isDuplicate(): boolean {
    return (this.errCode ?? "").includes("duplicate") || /already (exists|merged)|duplicate/i.test(this.body ?? "");
  }
}

type Fetch = typeof fetch;

export class NodeApi {
  constructor(readonly baseUrl: string, private readonly fetchFn: Fetch = (...a) => fetch(...a)) {}

  private url(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${this.baseUrl.replace(/\/+$/, "")}${path}${qs ? `?${qs}` : ""}`;
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let errCode: string | undefined;
      let detail = text;
      try {
        const j = JSON.parse(text) as { errCode?: string; details?: string; detail?: string };
        errCode = j.errCode;
        detail = j.details ?? j.detail ?? text;
      } catch { /* plain-text error body */ }
      throw new NodeApiError(`node returned HTTP ${res.status}: ${detail.slice(0, 300)}`, res.status, errCode, text);
    }
    return JSON.parse(text) as T;
  }

  private async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.parse<T>(await this.fetchFn(this.url(path, params), { method: "GET" }));
  }

  info() { return this.get<InfoJson>("/v1/info"); }

  castsByFid(fid: number, pageSize = 25) {
    return this.get<{ messages: MessageJson[]; nextPageToken?: string }>("/v1/castsByFid", { fid, pageSize, reverse: true });
  }

  castById(fid: number, hash: string) { return this.get<MessageJson>("/v1/castById", { fid, hash }); }

  reactionById(fid: number, reactionType: "Like" | "Recast", targetFid: number, targetHash: string) {
    return this.get<MessageJson>("/v1/reactionById", { fid, reaction_type: reactionType, target_fid: targetFid, target_hash: targetHash });
  }

  linkById(fid: number, targetFid: number, linkType = "follow") {
    return this.get<MessageJson>("/v1/linkById", { fid, target_fid: targetFid, link_type: linkType });
  }

  linksByFid(fid: number, pageSize = 100) {
    return this.get<{ messages: MessageJson[]; nextPageToken?: string }>("/v1/linksByFid", { fid, link_type: "follow", pageSize, reverse: true });
  }

  userDataByFid(fid: number) { return this.get<{ messages: MessageJson[] }>("/v1/userDataByFid", { fid }); }

  /** Onchain + gasless signers in one list, plus currentUserNonce (next KEY_ADD nonce must be greater). */
  signersByFid(fid: number) { return this.get<SignersByFidJson>("/v1/signersByFid", { fid }); }

  /** One signer (onchain or gasless) of an FID; 4xx not_found if the key is not active. */
  signer(fid: number, keyHex: string) { return this.get<{ signer: SignerJson }>("/v1/signer", { fid, signer: keyHex }); }

  /** FID owned by a custody address, from its IdRegistry event. */
  idRegistryEventByAddress(address: string) {
    return this.get<{ fid: number; idRegisterEventBody?: { to?: string } }>("/v1/onChainIdRegistryEventByAddress", { address });
  }

  /**
   * POST /v1/submitMessage with the protobuf bytes (Content-Type must be application/octet-stream).
   * On a READ node, success only means "valid and accepted for relay over gossip" — read nodes have
   * no mempool. Callers must query the message back to confirm it was included in a block.
   */
  async submitMessage(bytes: Uint8Array): Promise<MessageJson> {
    const res = await this.fetchFn(this.url("/v1/submitMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    });
    return this.parse<MessageJson>(res);
  }
}
