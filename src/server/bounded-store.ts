import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { IndexStore } from "../index/store";
import type { IndexKey } from "../index/types";
import { logServerError } from "./errors";

/**
 * Keeps a local index folder under a size limit. After each write, the oldest indexes are removed until the folder fits.
 * An index that was removed is simply "not indexed" again: the workspace says so and offers to rebuild it, so eviction costs
 * a re-index and never a wrong answer. Remote object stores manage their own lifecycle and are not wrapped.
 */
export class BoundedStore implements IndexStore {
  private pruning: Promise<void> | null = null;

  constructor(
    private readonly inner: IndexStore,
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  get(key: IndexKey): Promise<Buffer | null> {
    return this.inner.get(key);
  }

  async put(key: IndexKey, data: Buffer): Promise<void> {
    await this.inner.put(key, data);
    // One sweep at a time; a write never waits for it and never fails because of it.
    this.pruning ??= this.prune()
      .catch((err) => logServerError("index-store", err))
      .finally(() => {
        this.pruning = null;
      });
  }

  /** Resolves when the sweep started by the latest write has finished. For tests and orderly shutdown. */
  async settled(): Promise<void> {
    await this.pruning;
  }

  private async prune(): Promise<void> {
    const files: { file: string; bytes: number; mtime: number }[] = [];
    for (const owner of await readdir(this.dir).catch(() => [] as string[])) {
      const sub = path.join(this.dir, owner);
      for (const name of await readdir(sub).catch(() => [] as string[])) {
        if (!name.endsWith(".idx.br")) continue;
        const s = await stat(path.join(sub, name)).catch(() => null);
        if (s?.isFile()) files.push({ file: path.join(sub, name), bytes: s.size, mtime: s.mtimeMs });
      }
    }
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    files.sort((a, b) => a.mtime - b.mtime);
    // The newest index always stays, even when it alone is over the limit: it was just asked for.
    for (const f of files.slice(0, -1)) {
      if (total <= this.maxBytes) break;
      await rm(f.file, { force: true });
      total -= f.bytes;
    }
  }
}
