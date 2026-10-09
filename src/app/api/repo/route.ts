import { type NextRequest } from "next/server";
import { checkRate, refusalResponse } from "../../../server/guards";
import { handleRepoStatus } from "../../../server/repo-handler";
import { loadCachedIndex } from "../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether a commit is indexed on this server, and a summary of the index when it is. Never triggers indexing. */
export async function GET(request: NextRequest): Promise<Response> {
  const limited = checkRate("read", request);
  if (limited) return refusalResponse(limited);
  const out = await handleRepoStatus(async (key) => (await loadCachedIndex(key))?.index ?? null, request.nextUrl.searchParams);
  return Response.json(out.body, { status: out.status });
}
