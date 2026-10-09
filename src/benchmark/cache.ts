import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { githubFetch, tarballUrl } from "../github/client";
import type { RepoRef } from "../github/repo-ref";

/**
 * Benchmark-only cache so experiments can re-index a pinned commit without re-downloading it. It lives in the user's home
 * directory, outside the project folder (which may be synced) and outside the system's temporary folder (which is cleaned
 * without notice: the cache was lost that way once). ASK_THE_REPO_CACHE names another place. It holds only what can be
 * rebuilt: pinned tarballs from GitHub and the indexes built from them.
 */
export const CACHE_ROOT = process.env.ASK_THE_REPO_CACHE ? path.resolve(process.env.ASK_THE_REPO_CACHE) : path.join(homedir(), ".cache", "ask-the-repo");

export function tarballCachePath(ref: RepoRef, sha: string): string {
  return path.join(CACHE_ROOT, "tarballs", `${ref.owner}__${ref.repo}@${sha}.tgz`);
}

export async function ensureTarball(ref: RepoRef, sha: string): Promise<string> {
  const file = tarballCachePath(ref, sha);
  try {
    await stat(file);
    return file;
  } catch {
    // not cached yet
  }
  await mkdir(path.dirname(file), { recursive: true });
  const res = await githubFetch(tarballUrl(ref, sha), { accept: "application/x-gzip" });
  if (!res.body) throw new Error("Empty response body");
  const tmp = `${file}.${process.pid}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(tmp));
  await rename(tmp, file);
  return file;
}

export function openCachedTarball(file: string): Readable {
  return createReadStream(file);
}
