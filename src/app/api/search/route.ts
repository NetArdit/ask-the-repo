import { type NextRequest } from "next/server";
import { DEFAULT_SEARCH_OPTIONS } from "../../../retrieve/defaults";
import { search } from "../../../retrieve/search";
import { INTERNAL_ERROR, logServerError } from "../../../server/errors";
import { checkRate, refusalResponse } from "../../../server/guards";
import { diagnostics, loadCachedIndex } from "../../../server/runtime";
import { BadRequestError, parseSearchParams } from "../../../server/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const limited = checkRate("read", request);
  if (limited) return refusalResponse(limited);
  const started = performance.now();
  try {
    const { ref, sha, question } = parseSearchParams(request.nextUrl.searchParams);
    const loaded = await loadCachedIndex({ ...ref, sha });
    if (!loaded) return Response.json({ error: "index not found for this commit", code: "not_indexed" }, { status: 404 });
    const result = search(loaded.index, question, { ...DEFAULT_SEARCH_OPTIONS, k: 10 });
    return Response.json({
      evidence: result.evidence.map((e) => ({ path: e.path, startLine: e.startLine, endLine: e.endLine, score: e.score })),
      timings: { ...loaded.timings, searchMs: result.latencyMs, totalMs: performance.now() - started },
      ...diagnostics(),
    });
  } catch (err) {
    if (err instanceof BadRequestError) return Response.json({ error: err.message }, { status: 400 });
    logServerError("search", err);
    return Response.json(INTERNAL_ERROR.body, { status: INTERNAL_ERROR.status });
  }
}
