import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// No nonces: every page would have to render dynamically for them. The app loads no third-party script, style, font or image,
// so 'self' covers everything; 'unsafe-inline' is what Next.js needs for its own bootstrap, and 'unsafe-eval' only in development.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Pin the workspace root to this folder so a lockfile higher up the disk is never mistaken for it.
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  // Loaded from node_modules at runtime rather than bundled: the WASM runtime locates its own binary.
  serverExternalPackages: ["web-tree-sitter", "tree-sitter-wasms"],
  // Grammars are resolved by a computed path, which file tracing cannot see, so they are listed explicitly.
  outputFileTracingIncludes: {
    "/api/ingest": ["./node_modules/tree-sitter-wasms/package.json", "./node_modules/tree-sitter-wasms/out/tree-sitter-{javascript,typescript,tsx}.wasm"],
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // API responses hold answers, repository excerpts and rate-limit refusals: nothing in between should keep a copy.
      { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default config;
