import { Readable } from "node:stream";
import { type NextRequest } from "next/server";
import { GITHUB_API_TIMEOUT_MS, fetchRepoInfo, githubFetch, resolveCommitSha, tarballUrl } from "../../../github/client";
import type { RepoRef } from "../../../github/repo-ref";
import { buildIndexFromTarball } from "../../../index/from-tarball";
import { formatKey } from "../../../index/store";
import { DEFAULT_LIMITS } from "../../../ingest/tarball";
import { DEFAULT_INDEX_CONFIG } from "../../../retrieve/defaults";
import { ingestErrorResponse } from "../../../server/errors";
import { MAX_BODY_BYTES, checkRate, requireJson, enter, isRefusal, refundRate, refusalResponse } from "../../../server/guards";
import { readJsonBody } from "../../../server/limits";
import { withEventLog } from "../../../server/log-event";
import { diagnostics, getStore, latestCommits, loadCachedIndex } from "../../../server/runtime";
import { parseIngestBody } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Builds in progress, by repository and commit, so identical requests share one download and one parse. */
const building = new Map<string, Promise<Record<string, unknown>>>();

async function buildAndStore(ref: RepoRef, sha: string, started: number): Promise<Record<string, unknown>> {
  // The whole download shares the ingestion time limit, so a stalled GitHub response cannot hang the request.
  const res = await githubFetch(tarballUrl(ref, sha), { accept: "application/x-gzip", signal: AbortSignal.timeout(DEFAULT_LIMITS.maxTotalMs) });
  if (!res.body) throw new Error("empty response body");
  const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  const built = await buildIndexFromTarball(source, { ...ref, sha }, DEFAULT_INDEX_CONFIG);
  const t0 = performance.now();
  await getStore().put({ ...ref, sha }, built.bytes);
  return {
    sha,
    files: built.files,
    chunks: built.chunks,
    cached: false,
    artifactBytes: built.bytes.length,
    compressedBytes: built.ingest.compressedBytes,
    parse: built.parseStatus,
    timings: { ...built.timings, uploadMs: performance.now() - t0, totalMs: performance.now() - started },
  };
}

async function handle(request: NextRequest): Promise<Response> {
  const notJson = requireJson(request);
  if (notJson) return notJson;
  const limited = checkRate("ingest", request);
  if (limited) return refusalResponse(limited);
  const started = performance.now();
  try {
    const { ref, sha: requested } = parseIngestBody(await readJsonBody(request, MAX_BODY_BYTES));
    const apiSignal = () => AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
    const sha =
      requested ??
      (await latestCommits.get(ref.owner, ref.repo, async () => resolveCommitSha(ref, (await fetchRepoInfo(ref, undefined, apiSignal())).defaultBranch, undefined, apiSignal())));
    const key = { ...ref, sha };

    // A commit never changes, so an index that already exists is the answer: no download, no parse.
    const existing = await loadCachedIndex(key);
    if (existing) return Response.json({ sha, files: existing.index.fileCount, chunks: existing.index.chunkCount, cached: true, ...diagnostics() });

    const id = formatKey(key);
    let build = building.get(id);
    if (!build) {
      const release = enter("ingest");
      if (isRefusal(release)) return refusalResponse(release);
      build = buildAndStore(ref, sha, started).finally(() => {
        release();
        building.delete(id);
      });
      building.set(id, build);
    }
    return Response.json({ ...(await build), ...diagnostics() });
  } catch (err) {
    const out = ingestErrorResponse(err);
    if (out.status === 400 || (out.status === 413 && !("limit" in out.body))) refundRate("ingest", request);
    return Response.json(out.body, { status: out.status });
  }
}

export const POST = withEventLog("ingest", handle);
