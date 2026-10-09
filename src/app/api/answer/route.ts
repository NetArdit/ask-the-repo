import { type NextRequest } from "next/server";
import { handleAnswer, selectProvider } from "../../../server/answer-handler";
import { BODY_TOO_LARGE } from "../../../server/errors";
import { MAX_BODY_BYTES, checkRate, requireJson, enter, isRefusal, refundDailyAnswer, refundRate, refusalResponse, startModelCooldown } from "../../../server/guards";
import { BodyTooLargeError, readJsonBody } from "../../../server/limits";
import { withEventLog } from "../../../server/log-event";
import { getSharedSource, loadCachedIndex } from "../../../server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest): Promise<Response> {
  const notJson = requireJson(request);
  if (notJson) return notJson;
  const limited = checkRate("answer", request);
  if (limited) return refusalResponse(limited);
  let modelCalled = false;
  try {
    let body: unknown;
    try {
      body = await readJsonBody(request, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        refundRate("answer", request);
        return Response.json(BODY_TOO_LARGE.body, { status: BODY_TOO_LARGE.status });
      }
      throw err;
    }
    const release = enter("answer");
    if (isRefusal(release)) return refusalResponse(release);
    try {
      const out = await handleAnswer(
        {
          provider: selectProvider(process.env),
          loadIndex: async (key) => (await loadCachedIndex(key))?.index ?? null,
          makeSource: getSharedSource,
        },
        body,
      );
      // A call the model turned away served no answer, so it does not count; and when the model said how long to wait, nothing
      // is sent to it until then.
      modelCalled = (out.body as { stats?: { modelCalled?: boolean } } | null)?.stats?.modelCalled === true && !out.modelRefused;
      if (out.modelRefused) startModelCooldown(out.modelRefused.retryAfterMs);
      // A request that could not have reached the model (malformed, commit not indexed here, no model configured) gives back
      // its place in the per-minute allowance too, so finding that out does not lock a visitor out of asking.
      const code = (out.body as { code?: unknown } | null)?.code;
      if (out.status === 400 || (out.status === 404 && code === "not_indexed") || (out.status === 503 && code === "no_provider")) refundRate("answer", request);
      return Response.json(out.body, { status: out.status, headers: out.headers });
    } finally {
      release();
    }
  } finally {
    // The daily allowance exists to protect the model's quota, so only requests the model accepted count against it.
    if (!modelCalled) refundDailyAnswer(request);
  }
}

export const POST = withEventLog("answer", handle);
