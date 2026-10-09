// `next build` with output "standalone" leaves static assets outside the standalone folder. A server started from that folder
// needs them next to it, so this copies them in after every build. Run by `npm run build`.
import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) throw new Error("No standalone build found; run `next build` first.");

cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
console.log("Standalone server ready: node .next/standalone/server.js");
