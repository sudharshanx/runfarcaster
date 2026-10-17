#!/usr/bin/env python3
"""Tiny local stand-in for a Snapchain node's /v1/info, for testing node.sh only.
Serves the fixture files in order given on the command line, one per request
(the last one repeats). Never contacts any real network."""
import http.server, sys, json, pathlib
files = sys.argv[2:]
state = {"i": 0}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/v1/info"):
            f = files[min(state["i"], len(files) - 1)]; state["i"] += 1
            body = pathlib.Path(f).read_bytes(); code = 200
        elif self.path.startswith("/v1/castsByFid"):
            body = json.dumps({"messages": []}).encode(); code = 200
        else:
            body = b"Not Found"; code = 404
        self.send_response(code); self.send_header("content-type", "application/json")
        self.end_headers(); self.wfile.write(body)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
