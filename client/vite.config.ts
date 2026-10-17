// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

// In development the browser talks to the Vite dev server only; /v1/* is proxied to the node.
// This mirrors production (Caddy serves the app and proxies /v1/* on the same origin), so the
// browser never makes a cross-origin request. That matters: Snapchain's HTTP server has no
// OPTIONS route, so the CORS preflight that POST /v1/submitMessage (Content-Type:
// application/octet-stream) triggers would fail cross-origin. See SOURCES.md.
const nodeUrl = process.env.SNAPCHAIN_NODE_URL ?? "http://127.0.0.1:3381";

export default defineConfig({
  server: { proxy: { "/v1": { target: nodeUrl, changeOrigin: true } } },
  build: { target: "es2022", sourcemap: false },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
