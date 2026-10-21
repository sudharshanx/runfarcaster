#!/usr/bin/env python3
"""Tiny local stand-in for the public snapshot bucket, for testing node.sh's repair-shard only.
Serves files under ROOT. If <dir>/latest.1.json exists it is served for the FIRST request of
<dir>/latest.json only (a snapshot that is replaced right after it was read). Every request path
is appended to ROOT/requests.log. Never contacts any real network."""
import http.server, sys, pathlib
root = pathlib.Path(sys.argv[2]).resolve()
seen = set()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        with open(root / "requests.log", "a") as f: f.write(self.path + "\n")
        p = (root / self.path.lstrip("/")).resolve()
        if p.name == "latest.json" and p not in seen and (p.parent / "latest.1.json").exists():
            seen.add(p); p = p.parent / "latest.1.json"
        if root not in p.parents or not p.is_file():
            self.send_response(404); self.end_headers(); self.wfile.write(b"Not Found"); return
        body = p.read_bytes()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
