import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoreServerOptions {
  dir: string;
  /** Added before the first response byte, to emulate a remote store's time-to-first-byte. */
  latencyMs?: number;
  /** Throttles GET bodies to this many bytes per second (0 = unthrottled). */
  bytesPerSecond?: number;
  token?: string;
  /** Truncate every GET body to this fraction, to test failure handling. */
  truncateTo?: number;
}

/**
 * A local HTTP object store for the storage spike and tests. It measures nothing about a real provider:
 * latency and bandwidth are whatever the options say, not what any vendor delivers.
 */
export function startStoreServer(options: StoreServerOptions): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    try {
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401).end();
        return;
      }
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, "");
      if (rel.split("/").includes("..") || rel === "") {
        res.writeHead(400).end();
        return;
      }
      const file = path.join(options.dir, rel);
      if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.concat(chunks));
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        let data: Buffer;
        try {
          data = await readFile(file);
        } catch {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "Content-Length": data.length });
        const body = options.truncateTo ? data.subarray(0, Math.floor(data.length * options.truncateTo)) : data;
        if (!options.bytesPerSecond) {
          res.end(body);
          if (options.truncateTo) res.destroy();
          return;
        }
        const step = Math.max(1, Math.floor(options.bytesPerSecond / 20));
        for (let i = 0; i < body.length; i += step) {
          res.write(body.subarray(i, i + step));
          await new Promise((r) => setTimeout(r, 50));
        }
        res.end();
      } else res.writeHead(405).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` });
    });
  });
}
