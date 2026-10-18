#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Local fake Snapchain HTTP API for the browser E2E test. Never contacts any network.
Records every request (path, query, body) so the test can assert the seed phrase never
leaves the browser. Mimics: /v1/info, castsByFid, linksByFid, onChainIdRegistryEventByAddress,
signersByFid, signer, userDataByFid, submitMessage (octet-stream only), castById (found after a submit),
userNameProofByName. A small made-up social graph exercises the Following timeline:
  4242 @alice follows 10 @bob and 11 @carol; bob has 25 casts (paged), one a reply to 99 @dave
  (someone alice doesn't follow); carol replies to bob; 13 @erin follows only alice (no casts).
Optional argv[3], comma separated: "slow-signer" (the new key never shows as active),
"reject-casts" (submits after the KEY_ADD are rejected). Used for screenshots of those states."""
import http.server, json, sys, urllib.parse, threading, time

PORT = int(sys.argv[1]); LOG = sys.argv[2]
FLAGS = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else set()
FC_EPOCH = 1609459200
NOW = int(time.time()) - FC_EPOCH
NAMES = {"alice": 4242, "bob": 10, "carol": 11, "dave": 99, "erin": 13, "castapp": 500, "otherapp": 600}
# "Posted with": bob's key was requested by app FID 500, carol's by 600; one of bob's casts is
# signed with a key the node no longer lists (unknown app).
KEY_A, KEY_B, KEY_GONE = "0x" + "a1" * 32, "0x" + "b2" * 32, "0x" + "c3" * 32
def meta(app_fid):  # ABI-encoded SignedKeyRequestMetadata, base64 like the real node
    import base64
    w = lambda n: n.to_bytes(32, "big")
    return base64.b64encode(w(32) + w(app_fid) + w(0) + w(128) + w(0) + w(0)).decode()
SIGNERS = {10: [(KEY_A, 500)], 11: [(KEY_B, 600)]}
FOLLOWS = {4242: [10, 11], 13: [4242]}
def cast(fid, i, ts, text, parent=None, signer=None):
    body = {"text": text, "embeds": [], "mentions": [], "mentionsPositions": []}
    if parent: body["parentCastId"] = {"fid": parent, "hash": "0x" + "ab" * 20}
    return {"data": {"type": "MESSAGE_TYPE_CAST_ADD", "fid": fid, "timestamp": ts, "network": "FARCASTER_NETWORK_MAINNET", "castAddBody": body},
            "hash": "0x%04x%036x" % (fid, i), "signer": signer or {10: KEY_A, 11: KEY_B}.get(fid, KEY_A)}
CASTS = {
    10: [cast(10, i, NOW - 600 * (i + 1), f"Bob's cast number {25 - i}", 99 if i == 1 else None) for i in range(25)],
    11: [cast(11, 0, NOW - 900, "Carol agrees with Bob", 10)],
}
CASTS[10][1]["data"]["castAddBody"]["text"] = "Bob replying to Dave"
CASTS[10][3]["signer"] = KEY_GONE
CUSTODY = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"  # public Hardhat test account #0
FID = 4242
state = {"submits": 0, "keys": set()}
lock = threading.Lock()

def log(entry):
    with lock, open(LOG, "a") as f: f.write(json.dumps(entry) + "\n")

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self):  # like snapchain: no OPTIONS route
        log({"method": "OPTIONS", "path": self.path}); self.send_response(404); self.end_headers()
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query))
        log({"method": "GET", "path": u.path, "query": u.query})
        p = u.path
        if p == "/v1/info":
            return self.send(200, {"version": "mock", "numShards": 2, "shardInfos": [{"shardId": i, "maxHeight": 100, "blockDelay": 1} for i in (0, 1, 2)]})
        if p == "/v1/castsByFid":
            fid = int(q.get("fid", 0)); size = int(q.get("pageSize", 25)); start = int(q.get("pageToken") or 0)
            allc = CASTS.get(fid, [])  # newest first, like reverse=true
            out = {"messages": allc[start:start + size]}
            if start + size < len(allc): out["nextPageToken"] = str(start + size)
            return self.send(200, out)
        if p == "/v1/linksByFid":
            fid = int(q.get("fid", 0))
            return self.send(200, {"messages": [{"data": {"type": "MESSAGE_TYPE_LINK_ADD", "fid": fid, "timestamp": NOW - 86400, "linkBody": {"type": "follow", "targetFid": t}}, "hash": "0x%040x" % t} for t in FOLLOWS.get(fid, [])]})
        if p == "/v1/userDataByFid":
            fid = int(q.get("fid", 0)); name = next((n for n, f in NAMES.items() if f == fid), None)
            if not name: return self.send(200, {"messages": []})
            return self.send(200, {"messages": [{"data": {"type": "MESSAGE_TYPE_USER_DATA_ADD", "fid": fid, "timestamp": NOW - 86400, "userDataBody": {"type": t, "value": v}}, "hash": "0x00"}
                                                for t, v in (("USER_DATA_TYPE_USERNAME", name), ("USER_DATA_TYPE_DISPLAY", name.capitalize()))
                                                + ((("USER_DATA_TYPE_PFP", "https://imagedelivery.net/mock/bob/original"),) if fid == 10 else ())]})
        if p == "/v1/userNameProofByName":
            n = q.get("name", "").lower()
            if n in NAMES: return self.send(200, {"timestamp": 1, "name": n, "owner": "0x00", "signature": "", "fid": NAMES[n], "type": "USERNAME_TYPE_FNAME"})
            return self.send(400, {"error": "Failed to get username proof", "error_detail": "NotFound"})
        if p == "/v1/onChainIdRegistryEventByAddress":
            if q.get("address", "").lower() == CUSTODY: return self.send(200, {"fid": FID, "type": "EVENT_TYPE_ID_REGISTER"})
            return self.send(400, {"errCode": "not_found", "details": "no fid"})
        if p == "/v1/signersByFid" and int(q.get("fid", 0)) in SIGNERS:
            fid = int(q["fid"])
            return self.send(200, {"signers": [{"source": "SIGNER_SOURCE_ONCHAIN", "key": k, "keyType": 1, "fid": fid, "onChainEvent": {"type": "EVENT_TYPE_SIGNER", "fid": fid,
                "signerEventBody": {"key": k, "keyType": 1, "eventType": "SIGNER_EVENT_TYPE_ADD", "metadata": meta(app), "metadataType": 1}}} for k, app in SIGNERS[fid]],
                "currentUserNonce": 0, "gaslessSignerCount": 0, "gaslessSignerLimit": 1000})
        if p == "/v1/signersByFid":
            return self.send(200, {"signers": [], "currentUserNonce": 0, "gaslessSignerCount": 0, "gaslessSignerLimit": 1000})
        if p == "/v1/signer":
            if state["submits"] >= 1 and "slow-signer" not in FLAGS: return self.send(200, {"signer": {"source": "SIGNER_SOURCE_OFFCHAIN", "key": q.get("signer"), "fid": FID}})
            return self.send(400, {"errCode": "not_found", "details": "Active signer not found"})
        if p == "/v1/castById":
            if state["submits"] >= 2:
                return self.send(200, {"data": {"type": "MESSAGE_TYPE_CAST_ADD", "fid": int(q["fid"]), "timestamp": 1, "network": "FARCASTER_NETWORK_MAINNET", "castAddBody": {"text": "x"}}, "hash": q["hash"]})
            return self.send(400, {"errCode": "not_found", "details": "cast not found"})
        self.send(404, {"errCode": "not_found"})
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        log({"method": "POST", "path": u.path, "ctype": self.headers.get("content-type"), "body_hex": body.hex(), "body_latin1": body.decode("latin1")})
        if u.path == "/v1/submitMessage":
            if self.headers.get("content-type") != "application/octet-stream":
                self.send_response(400); self.end_headers(); return
            state["submits"] += 1
            if state["submits"] > 1 and "reject-casts" in FLAGS:
                return self.send(400, {"errCode": "bad_request.validation_failure", "presentable": False, "name": "ValidationError", "code": 3, "details": "invalid signer"})
            return self.send(200, {"hash": "0x00", "data": {"type": "ok"}})
        self.send(404, {})

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
