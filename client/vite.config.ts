// SPDX-License-Identifier: MIT
import { defineConfig, type Plugin } from "vitest/config";

// In development the browser talks to the Vite dev server only; /v1/* is proxied to the node.
// This mirrors production (Caddy serves the app and proxies /v1/* on the same origin), so the
// browser never makes a cross-origin request. That matters: Snapchain's HTTP server has no
// OPTIONS route, so the CORS preflight that POST /v1/submitMessage (Content-Type:
// application/octet-stream) triggers would fail cross-origin. See SOURCES.md.
const nodeUrl = process.env.SNAPCHAIN_NODE_URL ?? "http://127.0.0.1:3381";

// A port only this app uses, so its localStorage (where the app key lives) is not shared with
// other Vite apps on the default 5173. strictPort: fail instead of silently moving to another port
// (another port is another origin, with its own storage).
export const DEV_PORT = 5317;

// Content-Security-Policy as a <meta> tag. The production build gets the same policy as the Caddy
// header (minus frame-ancestors, which a meta tag cannot set). The dev server needs inline styles
// (Vite injects CSS from JS) and its HMR WebSocket.
const PROD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const DEV_CSP =
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
  `connect-src 'self' ws://localhost:${DEV_PORT} ws://127.0.0.1:${DEV_PORT}; base-uri 'none'; form-action 'none'`;

function cspMeta(): Plugin {
  let csp = PROD_CSP;
  return {
    name: "csp-meta",
    configResolved(c) { csp = c.command === "serve" ? DEV_CSP : PROD_CSP; },
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" }];
    },
  };
}

export default defineConfig({
  plugins: [cspMeta()],
  server: { port: DEV_PORT, strictPort: true, proxy: { "/v1": { target: nodeUrl, changeOrigin: true } } },
  preview: { port: DEV_PORT, strictPort: true },
  build: { target: "es2022", sourcemap: false },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
