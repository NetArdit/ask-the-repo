import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCommitSha, parseRepoRef } from "../github/repo-ref";
import type { IndexKey } from "./types";

/** Where serialized indexes live. Production object storage will implement the same interface. */
export interface IndexStore {
  put(key: IndexKey, data: Buffer): Promise<void>;
  get(key: IndexKey): Promise<Buffer | null>;
}

export function formatKey(key: IndexKey): string {
  return `${key.owner}/${key.repo}@${key.sha}`;
}

export function parseKey(text: string): IndexKey {
  const at = text.lastIndexOf("@");
  if (at === -1) throw new Error("Expected owner/repo@sha");
  const { owner, repo } = parseRepoRef(text.slice(0, at));
  return { owner, repo, sha: assertCommitSha(text.slice(at + 1)) };
}

/** On Windows a virus scanner or sync client can briefly hold a freshly written file, making rename fail with EPERM/EBUSY. */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * i));
    }
  }
}

export class LocalFsStore implements IndexStore {
  constructor(private readonly root: string) {}

  private fileFor(key: IndexKey): string {
    // Every component is re-validated, so a key can never address anything outside `root`.
    const { owner, repo } = parseRepoRef(`${key.owner}/${key.repo}`);
    const sha = assertCommitSha(key.sha);
    return path.join(this.root, owner, `${repo}@${sha}.idx.br`);
  }

  async put(key: IndexKey, data: Buffer): Promise<void> {
    const file = this.fileFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    // Unique per write, so concurrent writers of one key never share a temp file; a failed write leaves nothing behind.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, data);
      await renameWithRetry(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async get(key: IndexKey): Promise<Buffer | null> {
    try {
      return await readFile(this.fileFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
