#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Local fake Snapchain HTTP API for the browser E2E test. Never contacts any network.
Records every request (path, query, body) so the test can assert the seed phrase never
leaves the browser. Mimics: /v1/info, castsByFid, linksByFid, onChainIdRegistryEventByAddress,
signersByFid, signer, userDataByFid, submitMessage (octet-stream only), castById (found after a submit)."""
import http.server, json, sys, urllib.parse, threading

PORT = int(sys.argv[1]); LOG = sys.argv[2]
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
        if p in ("/v1/castsByFid", "/v1/linksByFid", "/v1/userDataByFid"):
            return self.send(200, {"messages": []})
        if p == "/v1/onChainIdRegistryEventByAddress":
            if q.get("address", "").lower() == CUSTODY: return self.send(200, {"fid": FID, "type": "EVENT_TYPE_ID_REGISTER"})
            return self.send(400, {"errCode": "not_found", "details": "no fid"})
        if p == "/v1/signersByFid":
            return self.send(200, {"signers": [], "currentUserNonce": 0, "gaslessSignerCount": 0, "gaslessSignerLimit": 1000})
        if p == "/v1/signer":
            if state["submits"] >= 1: return self.send(200, {"signer": {"source": "SIGNER_SOURCE_OFFCHAIN", "key": q.get("signer"), "fid": FID}})
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
            return self.send(200, {"hash": "0x00", "data": {"type": "ok"}})
        self.send(404, {})

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
