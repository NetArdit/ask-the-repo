import { type NextRequest } from "next/server";
import { checkRate, refusalResponse } from "../../../server/guards";
import { handleSource } from "../../../server/repo-handler";
import { getSharedSource, loadCachedIndex } from "../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lines of one indexed file at the pinned commit, for inspecting the evidence behind an answer. */
export async function GET(request: NextRequest): Promise<Response> {
  const limited = checkRate("read", request);
  if (limited) return refusalResponse(limited);
  const out = await handleSource({ loadIndex: async (key) => (await loadCachedIndex(key))?.index ?? null, source: getSharedSource() }, request.nextUrl.searchParams);
  return Response.json(out.body, { status: out.status });
}
