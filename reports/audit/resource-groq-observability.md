# Resource envelope, Groq cap analysis, observability audit

Read-only audit, 2026-10-07. Labels: MEASURED (from reports/ data), READ (from code/config), INFERRED (reasoning, not observed). Only official docs were fetched (console.groq.com/docs/rate-limits, render.com/docs/free). No model or GitHub calls were made.

Priority: P0 fix before any public deploy, P1 before wider traffic, P2 soon, P3 nice, P4 note.

---
## PART 1 - Resource envelope

### 1.1 Table of limits

| Resource | Current / proposed limit | Basis | Protects against | False-positive risk | User impact | Cost impact | Complexity | Benchmark methodology? |
|---|---|---|---|---|---|---|---|---|
| GitHub API calls per ingest | 2 (repo info + commit sha, only when no sha given; 60 s `LatestCommitCache`) + 1 tarball download from codeload (0 REST quota) | READ ingest/route.ts, latest-commit.ts; MEASURED phase1-acquisition.json: tarball `restRequests 0, restCoreUsedDelta 0` | GitHub 60/h unauthenticated | none | none | none | n/a | No (benchmark uses cached tarballs) |
| GitHub API calls per answer | up to `maxEvidence` 8 contents-API calls (1 per distinct file), cached by commit+path (memory 32 MB, or disk 256 MB if SOURCE_CACHE_DIR) | READ answer.ts, source.ts, runtime.ts; MEASURED phase3-github-source-check: 3 questions = 9 requests, ~346 ms each; phase4: 8 files first answer 1.1 s | the unauthenticated 60 req/h is the real ceiling: ~7 uncached answers/hour/IP of the server | high if unauthenticated | `source_rate_limited` 503 after a few answers | none | n/a | No: benchmark reads cached tarball |
| GitHub rate limit: unauthenticated vs token | 60/h vs (token) 5,000/h per GitHub docs | READ source.ts comment; MEASURED `rateLimitBefore.limit 60`; 5,000 figure INFERRED from GitHub docs (not fetched here) | | | | | | |
| Compressed tarball | 150 MB | READ tarball.ts | bandwidth/time | low (largest benchmark repo ~10 MB gz, MEASURED phase1) | huge monorepos get 413 `limit: compressed-bytes` | none | n/a | No |
| Uncompressed bytes | 600 MB | READ | zip bomb | low | 413 | none | | No |
| Tar entries | 150,000 | READ | entry flood | low-medium (nixpkgs-class repos) | 413 | none | | No |
| Per-file bytes | 1 MB (file skipped) | READ | single huge file | low | file not searchable | none | | Possibly (skipped files affect recall) |
| Ingest time | 120 s (`maxTotalMs`, also aborts GitHub fetch) | READ; MEASURED react 49-55 s on a dev box, Phase 1 demo aborted DefinitelyTyped at 38.9 s | hang | MEDIUM: Render free is "a fraction of a CPU" (render.yaml comment, not measured); react-sized repo may exceed 120 s there. INFERRED | 413 `total-time` | none | | No |
| Files indexed / chunks | no explicit cap beyond entries and bytes (READ: no `maxFiles` found) | READ grep | memory growth | n/a | | | | |
| Serialized index (brotli) | no write cap; store capped 300 MB on Render (INDEX_STORE_MAX_MB), default 512 | READ; MEASURED 70 KB (ky) to 2.1 MB (react) (phase2-report) | disk fill | low | eviction -> rebuild | none | | No |
| Decoded index | 256 MB (`MAX_DECODED_INDEX_BYTES`, new) | READ serialize.ts; MEASURED largest ~9 MB (per comment; react JSON size not re-verified here) | brotli bomb from store | ~0 (28x headroom) | none | none | done | No |
| Memory, ingest | 512 MB host (render.yaml); `INGEST_CONCURRENCY=1`; `--liftoff-only` | MEASURED phase2: with default V8 full build peak 936-1,684 MB (ky 936, react 1,280, query 1,684); with `--liftoff-only` 108-359 MB (react 359) ; runtime `setFlagsFromString` did NOT help (1,477 MB) | OOM kill | The flag is only in Dockerfile CMD; `next dev`/other runners lose it. READ | crash = every in-flight request fails | n/a | n/a | No |
| Memory, serving | 2 indexes cached (react ~214 MB RSS after load) | MEASURED phase2 table; READ MAX_CACHED_INDEXES=2 | OOM | MEDIUM: two large indexes plus ingest build 359 MB can approach 512 MB. INFERRED | | | | |
| Concurrency | answer 2, ingest 1 (render.yaml; code default 2), reject immediately with 503 + Retry-After 5 | READ | pile-up | low | 503 "busy" | | | No |
| Request body | 4096 bytes | READ guards.ts | junk | ~0 | | | | No |
| Per-client rate (needs TRUST_PROXY=1) | answer 6/min, ingest 6/10 min, read 120/min | READ | one abuser | low | 429 | | | No |
| Global rate | answer 20/min, ingest 24/10 min, read 600/min | READ | total flood | see Part 2: answer 20/min is ~10x above Groq TPM | | | | No |
| Daily answers | code default 200, Render 40; counts only requests that reached the model | READ | upstream quota | see Part 2 | | | | No |
| Groq per answer | 1 request, in/out tokens below | MEASURED | | | | | | |

### 1.2 Groq tokens and latency per answer (MEASURED)
Source: records of reports/phase3/answers.groq.*.tuning.json (model openai/gpt-oss-120b, 6 runs x 32 questions, 21 of 32 reached the model, 11 refused before the call; 126 model calls).

| Run | calls | input med / max | output med / max | total in / out |
|---|---|---|---|---|
| base | 21 | 3,585 / 4,780 | 395 / 1,118 | 72,916 / 9,081 |
| A-e2 | 21 | 3,681 / 4,855 | 501 / 1,295 | 74,273 / 11,285 |
| B | 21 | 3,643 / 4,818 | 369 / 1,683 | 73,806 / 9,625 |
| B-e2 | 21 | 3,679 / 4,893 | 430 / 1,343 | 75,301 / 10,343 |
| C | 21 | 3,639 / 4,842 | 364 / 888 | 74,511 / 9,176 |
| C-e2 | 21 | 3,703 / 4,879 | 442 / 1,318 | 75,400 / 11,872 |

Derived (MEASURED arithmetic): mean in+out per model call ~4.07k tokens (A-e2: 85,558/21); worst observed in+out ~6.2k (4,855+1,295 from different calls, so an upper bound); worst output seen 1,683. About 34% of benchmark questions were refused before any call (benchmark set, not real traffic; real traffic split unknown).
Latency: `modelMs` median 19-28 s, max 34-44 s. CAVEAT: the runner paced for rate limits, so these include waits (reports/phase4b-tuning-abc.md says so); true model latency is NOT MEASURED. The route timeout is 30 s (READ answer.ts), so if real latency is anywhere near these numbers many requests would time out. Needs an unpaced measurement.

### 1.3 Findings

**F1.1 Peak memory depends on a flag that only the Dockerfile CMD sets.** FACT: default V8 peaks 0.9-1.7 GB even for a 94-file repo, `--liftoff-only` 0.11-0.36 GB. EVIDENCE: phase2-report lines 115-125 (MEASURED); Dockerfile CMD (READ); phase2 shows the runtime flag does not work. IMPACT: any other launcher (Vercel-style serverless, `npm start`, a Procfile) silently needs 1.1-1.7 GB; one ingest OOM-kills the shared process. P2: add a startup/ingest-time check (e.g. refuse ingest or log a warning when `process.execArgv` lacks `--liftoff-only` in production). The flag also had a Fatal Zone OOM crash in 1 of 1 default runs for react (MEASURED).

**F1.2 120 s ingest limit untested on the target host.** FACT: react takes ~50-55 s on a dev machine; Render free has a fraction of a CPU. EVIDENCE: phase2 numbers; render.yaml comment (not measured). IMPACT: INFERRED false-positive on mid-size repos, appearing as `total-time` 413. P2: measure once on the real instance before choosing; do not raise the limit blindly (it also bounds memory-time exposure).

**F1.3 No explicit file or chunk count cap; index size bounded only indirectly.** FACT: only entry (150k), byte and time limits exist. IMPACT: low (extrapolation 0.04 MB RSS/file, MEASURED, at 150k entries = ~6 GB is not reachable because 600 MB / 120 s hit first, but memory per file under Liftoff has only been measured to 6.6k files). P3: measure or cap indexed files (e.g. 20k) with the fixed message.

**F1.4 Source fetches use the 60/h unauthenticated GitHub quota.** FACT: each uncached answer spends up to 8 contents-API calls. EVIDENCE: answer.ts, source.ts. IMPACT: ~7 cold answers per hour per server IP exhaust it, surfaced as 503 `source_rate_limited` (answer-handler.ts) with no Retry-After header; this will bite before Groq limits do. P1: set GITHUB_TOKEN on the deploy (render.yaml already lists it) and add Retry-After from `x-ratelimit-reset` to that 503. An alternative is to take evidence text from the index (source is already read in the tarball) but that changes the pinned-commit verification design; do not do this casually.

**F1.5 Daily/answer limits do not consider token cost.** See Part 2.

**F1.6 Per-client limits depend on proxy identity.** See Part 2.

---
## PART 2 - Groq cap analysis

### 2.1 Groq's actual published limits
Source: https://console.groq.com/docs/rate-limits (fetched 2026-10-07; figures as the fetch returned them): openai/gpt-oss-120b, Free plan: RPM 30, RPD 1K, TPM 8K, TPD 200K. "Rate limits apply at the organization level, not individual users." On exceeding: HTTP 429, `retry-after` header gives seconds. "Cached tokens do not count towards your rate limits." The page as fetched does not say whether `max_tokens` counts toward the limit estimate. (The summarizer returned this; re-verify the table directly before relying on it.)

The app's `ANSWERS_PER_DAY` (code 200, Render 40) is the app's own ceiling and is NOT Groq's quota. They are independent counters; the app cap only helps if it is lower in tokens than Groq's, which is not guaranteed (below).

### 2.2 Client identification (READ guards.ts)
- `clientKey` returns null unless `TRUST_PROXY=1`; then it takes the LAST `X-Forwarded-For` entry if it looks like an address.
- Behind a proxy that APPENDS the peer it saw (what render.yaml assumes): last entry is proxy-vouched; client-supplied earlier entries are ignored. Not spoofable.
- Behind a proxy that does NOT append (overwrites with one value): still correct. Behind one that passes the client header through unchanged with no append: the client chooses the last entry, so it is fully spoofable and per-client limits are void. TRUST_PROXY=1 without a proxy at all: same, spoofable.
- Behind more than one appending hop (CDN then router): the last entry is the previous hop, so all users share one bucket (self-lockout, not spoofing). Render's actual header layout is NOT VERIFIED (I could not find it in Render docs; the render.com/docs/http-request-headers URL returned 404). Claim "Render's proxy appends" in render.yaml is therefore unverified. P1: verify on a deployed instance.
- IPv6 clients can rotate within a /64 and get fresh buckets (INFERRED). `RateLimiter` keeps at most 5,000 keys; a rotating-key flood evicts real users' buckets (they simply get fresh full buckets: a limit bypass for them, not a lockout).
- Without TRUST_PROXY there is no per-client limit; the global limits then are the only protection.

### 2.3 Can one client exhaust the global and daily budget? (READ)
Yes. Per client 6/min; global 20/min; daily 40 (Render). One properly identified client reaches 40 answers in ~7 minutes (the 6/min bucket refills 1 per 10 s) and then nobody gets an answer for the rest of the 24 h window (the window opens at the first counted request, not at midnight). Without TRUST_PROXY or with spoofing, the 20/min global bucket does the same. Cost to attacker: trivial. This is an availability weakness, not a cost one, since Groq free plan has no bill. P1 (accepted trade-off for a demo; mitigate by a smaller per-client daily share, below).

### 2.4 Worst-case volume vs Groq (computed from MEASURED tokens and READ limits)
- Per-minute global bucket: 20 answers/min x ~4.07k mean tokens = ~81k tokens/min versus Groq TPM 8K: about 10x over. Requests: 20/min vs RPM 30 is fine. Real throughput is also bounded by concurrency 2 and latency: 2 / latency; with latency L seconds, requests/min = 120/L. At L=10 s: 12/min = ~49k tokens/min, still 6x TPM. At L=26 s (measured, includes pacing waits): ~4.6/min = ~19k TPM, still over. So a handful of requests in one minute will trigger Groq TPM 429s (INFERRED but arithmetic is solid: 8,000 / 4,070 = ~2 answers/min).
- If Groq's TPM estimate counts `max_tokens` (the code sends max_tokens >= 4096, GROQ_MIN_OUTPUT_TOKENS), each request requests ~3.6k+4.1k = ~7.7k of the 8K bucket, i.e. ONE answer per minute, and the worst measured input (4,855) + 4,096 = ~8.95k would exceed 8K and always fail. UNKNOWN: the docs fetched do not say; observe via `limitFragment` ("Limit/Used/Requested") that the code already captures on 429. P1: test one real 429 and read the "Requested" figure. If it counts max_tokens, lower the floor (e.g. 1,536; measured max output 1,683 including reasoning, so test).
- Daily: TPD 200K / 4.07k mean = ~49 answers; at the measured worst (~6.2k) = ~32. Render's `ANSWERS_PER_DAY=40` therefore is about at the quota edge (40 x 4.07k = 163k, 81%), and the quota is shared by organization: any benchmark/judge run on the same key (the 6 benchmark runs above each used ~85k tokens: two runs exhaust a day) competes with production. Phase 4b records show exactly this blocking ("rate_limited" at zustand-4, koa-3). P1: use a separate key/org for the deployed app, or keep benchmark off while the demo is live.
- RPD 1K is never the binding limit (40 << 1,000).

### 2.5 What the user sees on Groq 429 (READ provider.ts, answer.ts, answer-handler.ts)
In the web route the provider is not "paced": no retry. GroqProvider throws `ProviderError("rate_limited", 429, retryAfterMs, observation)`; `answerQuestion` converts every provider error to `status: "provider_error"`, reasons `["model provider failed: rate_limited"]`, rejections `[{code:"provider-error", detail:"rate_limited"}]`; the handler maps `provider_error` to HTTP 502 (not 429, not 503) and the route returns it as JSON WITHOUT a Retry-After header, even though `retryAfterMs` was captured. The user sees a generic "provider failed" (the UI may phrase it differently; not checked). The daily counter is NOT refunded (modelCalled true), so a Groq 429 still burns app allowance. Also timeouts (30 s) and network errors map to the same 502.
- Can the app exhaust upstream quota? Yes, easily, per 2.4 (TPM within a minute, TPD within a day), and nothing in the app learns from 429s: it keeps sending.

### 2.6 Recommended conservative policy (proposal only; numbers are reasoning, not measured)
Design target: stay at or below ~60% of Groq limits, so the org's other use and variance fit.
1. `answer` global: 1 request/min sustained, burst capacity 2 (token bucket `[2, 2 min]`). 60% of 8K TPM = 4.8k tokens/min = ~1.2 answers/min at the 4.07k mean. Per-client `[1, 2 min]` burst 1 (so one user cannot take both burst slots all day).
2. Concurrency: answer 1 on Render free (keeps TPM from spiking; latency per answer is unmeasured, so this is the safe default). Revisit after an unpaced latency measurement.
3. Daily: `ANSWERS_PER_DAY=25` (25 x 4.07k = ~102k = ~51% of 200K; at the measured worst 6.2k it is 155k = 78%, still inside). Keep Render's 40 only if the token floor change below is made and a second org handles benchmarks. Add a per-client daily share (e.g. 8) so one client cannot lock out everyone (needs a keyed counter; modest code, P2).
4. Refund policy: do not count a Groq 429 or 5xx against the daily budget (modelCalled but not served) or count it separately; instead honour `retryAfterMs`.
5. On Groq 429: respond HTTP 503 (or 429) with `Retry-After` = captured `retryAfterMs` (rounded up to s) and a fixed message; set a process-wide "Groq cooldown" until then so the next requests are refused without calling upstream (stops hammering). P1, small change.
6. Trim the prompt cost: input is ~3.5k of ~4.1k tokens; evidence budget 24,000 chars x 8 items drives it. Reducing it changes retrieval/answer quality, so it would affect benchmark methodology: do not do it without re-running the evaluation. P3.
7. `max_tokens` floor 4,096: keep until the 429 "Requested" figure shows how Groq counts it (see 2.4).

---
## PART 3 - Observability

### 3.1 What is logged (READ)
Only two `console.error` call sites in src exist outside benchmarks: `logServerError` (src/server/errors.ts, one line `[route] Name: message`) and `src/app/error.tsx` (client render error). `answerQuestion` states "Nothing in here logs". No request logs, no per-answer stats log, no structured shape. `diagnostics()` returns process info only in non-production and only in ingest responses, nothing in production. Answer `stats` (timings, tokens, modelCalled) are returned to the client in the response body but never recorded server-side, so after the fact nothing is retrievable.

### 3.2 Distinguishability table

| Failure | Response to client | Server log | Distinguishable? |
|---|---|---|---|
| GitHub failure (non-rate, e.g. 500, timeout, network) at ingest | falls to `INTERNAL_ERROR` 500 "internal error" (only 404/403/429/409 mapped) | `[ingest] GitHubHttpError: GitHub responded 502 for /path` (or TimeoutError/TypeError) | In log yes; not by client. OK |
| GitHub rate limit at ingest | 503 `code: github_rate_limited` | NOT logged (returns before `logServerError`) | Client yes; server log no. P2 |
| GitHub rate limit at answer (source fetch) | 503 `source_rate_limited` | NOT logged | same, P1 because it is the likely first failure |
| 403 from GitHub that is not a rate limit (abuse/forbidden, repo blocked) | same as rate limit (403 and 429 both mapped) | none | NOT distinguishable. P3 (use `x-ratelimit-remaining: 0` already stored in the error) |
| Ingestion failure (generic) | 500 | logged | yes in log |
| Resource limit hit | 413 with `limit` kind (compressed-bytes, entries, ...) | NOT logged | client yes; operator only if they see responses. P2 |
| Parser failure | never an error: file falls back to text; counted in ingest response `parse` stats and `parseFallbackReasons` only inside BuiltIndex (the route returns `parse: parseStatus`, not reasons) | none | partially (counts per language/status in the one response; no history). P3 |
| Index failure (store get/put, bad version, decode error incl. new 256 MB cap) | ingest: 500; answer: `loadIndex` errors -> 500 | logged with message (e.g. "Unsupported index version", brotli "Cannot create a Buffer larger than ...") | yes in log |
| Index not found | 404 `not_indexed` | none (normal) | yes |
| Groq rate limit | 502 `provider_error`, reasons "model provider failed: rate_limited" | NOT logged; the captured `RateLimitObservation` (limit type, Used/Requested) is thrown away at `answerQuestion` | client can tell kind; server cannot, and the quota detail is lost. P1 |
| Groq provider error (5xx, 401 bad key, timeout) | 502, reasons "provider failed: http" / timeout / network; status number dropped (rejections detail only the kind) | NOT logged | A revoked key (401) looks identical to a 500. P1 |
| No provider configured | 503 `no_provider` | none | yes by response |
| Malformed model output | 200 with `status: rejected`, rejection code `malformed-output` etc. | NOT logged | response yes; no history. P2 |
| Citation validation failure | 200 `rejected` + per-claim verdicts and `rejections` | NOT logged | response yes |
| Abstention | `insufficient_evidence` (before model: policy, modelCalled false) or model-declared; `no_evidence` | NOT logged | response yes; no aggregate. P2 |
| Rate-limit/busy refusals | 429/503 with code and Retry-After | NOT logged | response yes |

Summary: failures of unknown kind (500) are logged; every failure that has a specific mapping is silent. With no logs of outcomes, "why did answers fail yesterday" is answerable only from user reports.

### 3.3 Sensitive-data audit (READ)
- API key: used only in the Authorization header (provider.ts); ProviderError messages carry only kind and status; `observeRateLimit` whitelists headers (no Authorization) and strings matching SAFE_VALUE. GITHUB_TOKEN sent only to api.github.com. No logging of either. OK.
- Prompts / source content / full questions: not logged anywhere in src outside benchmarks. `logServerError` logs `err.message`; messages seen: GitHubHttpError (path only, no query/token), ProviderError (safe), LimitExceededError (numbers), BadRequestError (returned, not logged). RISK: a message from an unexpected library error (e.g. JSON.parse of the index "Unexpected token ... in JSON at position" can include a snippet of text, tree-sitter/tar errors) could embed content; low likelihood, INFERRED. The GitHub path includes owner/repo/file path of the user's request (public data, not a secret). `INDEX_STORE_URL` fetch errors could include the URL host; token is not in URL (READ http-store.ts not examined in detail: P4 check that `INDEX_STORE_TOKEN` is header-only).
- `src/app/error.tsx` `console.error(error)` runs in the browser; harmless to server logs.
- `onModelOutput` is benchmark-only (raw model replies go to private diagnostics; confirm reports/private is gitignored; not checked here).

### 3.4 Smallest structured-diagnostics change (proposal; not applied; no dependencies)
One helper `logEvent(fields)` writing a single JSON line to stdout (`console.log`/`console.info`), called once per request at each route's single exit, with a fixed allowlist of fields and no free text from users:

```
{"t":1790000000000,"route":"answer","status":502,"outcome":"provider_error","cause":"rate_limited","provider":"groq","providerStatus":429,"retryAfterMs":42000,"limitType":"TPM","modelCalled":true,"inTok":3700,"outTok":0,"ms":{"retrieval":12,"source":900,"model":2300,"validate":0},"evidence":8,"abstain":null,"repo":"owner/name","sha7":"0d59458","client":"h:3fa2"}
```
Rules: `outcome` is one of a fixed enum (ok, abstained, rejected, provider_error, source_rate_limited, github_rate_limited, limit_exceeded:<kind>, index_error, rate_limited, daily_limit, busy, bad_request, internal); `cause` is the ProviderError kind or limit kind or rejection code; `client` is a short salted hash (or omitted) rather than the raw IP; no question text, no prompt, no source, no key. Needed code: expose `err.rateLimit` and `status` from the `provider_error` result (currently dropped: add optional fields to `AnswerResult.stats` or a non-serialised side channel), and call `logEvent` in answer/ingest routes. About 30-40 lines. Justified (P1) because Part 3.2 shows nearly every operationally important failure is currently invisible. Repo name is public-repo data; keep it out if privacy of what users ask about matters (it identifies interest, not content).

---
## Consolidated findings

| ID | Finding (FACT -> EVIDENCE -> IMPACT) | Rec | Pri | Label |
|---|---|---|---|---|
| R1 | Groq free TPM 8K and TPD 200K vs ~4.07k tokens/answer: ~2 answers/min, ~49/day; app global 20/min allows ~10x TPM | Policy in 2.6 | P1 | MEASURED+READ docs |
| R2 | Groq 429 returns HTTP 502 without Retry-After, burns daily allowance, nothing remembered | Map to 503/429 + Retry-After, cooldown, refund | P1 | READ |
| R3 | `max_tokens` floor 4,096 may count toward TPM, making one answer fill the minute bucket | Test one 429; read "Requested" | P1 | INFERRED |
| R4 | Org-level quota shared with benchmark runs (6 runs ~85k tokens each) | separate key/org | P1 | MEASURED |
| R5 | One client can use the whole daily budget in ~7 min | per-client daily share | P2 | READ |
| R6 | XFF layout on Render unverified; multi-hop => shared bucket, no-append => spoofable; IPv6 /64 rotation | verify deployed; configurable hops; /64 bucketing | P1 | INFERRED |
| R7 | Source fetch uses 60/h unauthenticated GitHub quota (~7 cold answers/h) | GITHUB_TOKEN; Retry-After | P1 | READ+MEASURED |
| R8 | Memory 0.9-1.7 GB without `--liftoff-only`, set only in Dockerfile CMD | startup guard | P2 | MEASURED |
| R9 | 120 s ingest limit untested on target CPU | measure on deploy | P2 | INFERRED |
| R10 | Latency measurements include pacing waits; route timeout is 30 s | unpaced run | P2 | MEASURED caveat |
| O1 | Specific failures silent in logs; provider error detail discarded | one-line structured log | P1 | READ |
| O2 | GitHub 403 non-rate-limit indistinguishable from rate limit | check remaining header | P3 | READ |
| O3 | No secrets/prompts/source/questions logged | none | P4 | READ |
| R11 | Decode cap 256 MB vs 9 MB largest: fine | none | P4 | READ+MEASURED |

Benchmark methodology: only R4/R10 and the evidence-budget trim (2.6 item 6) touch it; every policy/limit above runs in the web route and does not change retrieval or scoring. The paced provider (`rateLimit` option) is already separate from the web path.
