# AskTheRepo deployment-readiness review (static)

Scope: read-only review of Dockerfile, render.yaml, .env.example, package.json, next.config.ts, scripts/prepare-standalone.mjs, src/server/**, src/app/api/**. Nothing was built, run or deployed. Labels: VERIFIED (read in repo or official doc), INFERRED, NOT TESTED. Render facts come from render.com/docs pages fetched 2026-10-07.

## Headline
1. The Dockerfile is plausible and consistent with the locally verified standalone layout, but has NEVER been built (Dockerfile:2-3, render.yaml:1). NOT TESTED.
2. There is no dedicated health endpoint. render.yaml uses `healthCheckPath: /` (render.yaml:9), a static-ish page; acceptable but it checks nothing about the app.
3. Biggest risk on the free tier is CPU, not RAM: indexing React took about 50 s on a dev PC; at about 0.1 CPU it would very likely exceed the 120 s ingest limit. Small repos (ky, zod) should be fine (INFERRED).
4. Index store and source cache are ephemeral: every spin-down (15 min idle) wipes indexes, so visitors must re-ingest.
5. `maxDuration = 300` / 60 (src/app/api/ingest/route.ts:17, answer/route.ts:11) are Vercel-style hints; on a long-lived Node process on Render they are INFERRED to have no effect. Only the in-code 120 s timer bounds ingest.

## (a) Will the Docker image build and start?
- Base `node:22-bookworm-slim` in both stages (Dockerfile:5,13); package.json engines `node >=22` (package.json:7-9). VERIFIED consistent.
- Build stage: `COPY package.json package-lock.json`, `npm ci`, `COPY . .`, `npm run build` (Dockerfile:7-11). `npm run build` = `next build && node scripts/prepare-standalone.mjs` (package.json:12). VERIFIED. `npm ci` on Linux pulls linux-x64 optional binaries (@swc, @img): INFERRED OK. Free-tier build RAM/time: NOT CHECKED (the Render page fetched did not list it); a Next 16 build can need about 1 GB (INFERRED).
- .dockerignore excludes node_modules, .next, .git, .env*, .index-store, .cache, reports, e2e artifacts; keeps .env.example. VERIFIED. No `public/` dir exists; prepare-standalone guards with existsSync (scripts/prepare-standalone.mjs:12). VERIFIED.
- Standalone: `output: "standalone"` (next.config.ts:112). prepare-standalone copies `.next/static` into `.next/standalone/.next/static` (script:11). Run stage copies `/app/.next/standalone` to `./` so server.js is /app/server.js; CMD `node --liftoff-only server.js` (Dockerfile:19,26) matches. VERIFIED.
- WASM grammars: `serverExternalPackages` for web-tree-sitter/tree-sitter-wasms and `outputFileTracingIncludes` for /api/ingest listing package.json and the javascript/typescript/tsx wasm (next.config.ts:117-121). The existing local `.next/standalone` contains node_modules/tree-sitter-wasms/out/tree-sitter-{javascript,tsx,typescript}.wasm and web-tree-sitter (listed directly). VERIFIED for that Windows build; INFERRED identical on Linux. Runtime resolution via require.resolve (src/parse/languages.ts:29). The include is keyed to /api/ingest only; whether other routes parse was not checked, but all share one node_modules tree so risk is low.
- Oddity: the local standalone also contains `src/`, `reports/`, `e2e/` (traced in). In Docker, reports and e2e/artifacts are excluded by .dockerignore. Harmless, slightly larger image. INFERRED cause.
- Non-root: `USER node` after chowning standalone files and /app/data (Dockerfile:19-22). /app itself stays root-owned, so a runtime write to /app/.next/cache would fail; the static home page and force-dynamic API routes should not need it (INFERRED).
- Binding: `HOSTNAME=0.0.0.0`, `PORT=10000` (Dockerfile:15-17); Render requires binding 0.0.0.0, default PORT 10000 (https://render.com/docs/web-services). VERIFIED. INFERRED caveat: if the platform injects its own HOSTNAME at runtime it would override the ENV; confirm the start log shows 0.0.0.0:10000.
- `--liftoff-only` is a node argument in CMD (Dockerfile:26) and in `npm start` (package.json:13); a unit test asserts both (src/server/deploy-config.test.ts:8-12). VERIFIED. Setting it at runtime does not work (reports show liftoff-runtime peaks of 1.1-1.5 GB), so the CLI-arg form is required. VERIFIED (JSON).
- No Dockerfile HEALTHCHECK (Render ignores it). Node runs as PID 1 without an init: fine for a stateless demo (INFERRED).
- Verdict: plausible; unknowns are first-ever-build issues. NOT TESTED.

## (b) Health check
- API routes: answer, ingest, repo, search, source. No /health route. VERIFIED by file listing. `/api/repo` needs query params and consumes rate-limit tokens, so unsuitable.
- render.yaml sets `healthCheckPath: /` (render.yaml:9). The home page (src/app/page.tsx) uses no dynamic APIs so it is INFERRED prerendered static: returns 200, cheap, not rate limited.
- Render facts (https://render.com/docs/health-checks): 2xx/3xx healthy, 4xx/5xx failing; 5 s timeout; new deploy must pass within 15 min or is cancelled; 15 s consecutive failure stops routing; 60 s consecutive failure restarts instance. VERIFIED (doc). INFERRED risk: on a throttled CPU, event-loop stalls during parse could miss the 5 s limit and, after 60 s, restart the instance mid-ingest.
- Optional improvement (not made here): add a tiny `/api/health` route (`force-dynamic`, returns `{ok:true}`) so a dead server is not masked by a cached page. Low priority.

## (c) Ephemeral filesystem, 512 MB RAM, 0.1 CPU
Render facts (https://render.com/docs/free): ephemeral filesystem lost on redeploy/restart/spin-down; no persistent disk on free; spins down after 15 min without inbound traffic, spin-up about 1 minute; 750 free instance hours per workspace per month; single instance only. VERIFIED (doc). The 512 MB / 0.1 CPU figures were given by the caller; the fetched page did not state RAM/CPU, so I did NOT confirm them.

- Index store (src/server/runtime.ts:28-42): `INDEX_STORE_URL` selects HttpIndexStore (optional INDEX_STORE_TOKEN); else `INDEX_STORE_DIR` selects BoundedStore over LocalFsStore capped by INDEX_STORE_MAX_MB (default 512, runtime.ts:45); else throws "Set INDEX_STORE_URL or INDEX_STORE_DIR". Dockerfile sets /app/data, render.yaml caps 300. VERIFIED. Effect: indexes vanish on each spin-down/redeploy; `/api/repo` reports not indexed and answering an old commit fails until re-ingest; `/r/owner/repo/sha` links need re-ingest (INFERRED from loadIndex returning null). Free disk size: NOT STATED in docs fetched.
- In-memory index cache holds up to 2 LoadedIndex objects (runtime.ts:22,87); adds to RSS.
- Source cache: SOURCE_CACHE_DIR unset in render.yaml so a 32 MB MemorySourceCache (runtime.ts:15-18), TTL 24 h (source-cache.ts:144). Lost on restart: only means more GitHub requests. VERIFIED.
- Ingest limits (src/ingest/tarball.ts:17-21): total time 120 s, compressed 150 MB, uncompressed 600 MB, 150k entries, 1 MB per file. The 120 s timer wraps the tar stream, and per-file parse runs inside the stream callback (tarball.ts:106; src/index/from-tarball.ts:50), so parse time counts. INFERRED from reading; NOT TESTED. The route also applies AbortSignal.timeout(120 s) to the download (ingest/route.ts:24).
- Timing evidence (dev PC, liftoff-flag; reports/phase2-memory-react.json, phase2-memory-others.json): react full 55.3 s (parse stage 49.8 s), vite 4.9 s, zod 6.0 s, excalidraw 9.0 s, TanStack/query 11.6 s, ky 2.5 s. VERIFIED (JSON). INFERRED: at about 0.1 vCPU the slowdown could be roughly 5-10x, putting React at 250-500 s (fails with total-time limit) and vite/excalidraw/TanStack at about 50-120 s (borderline); ky/zod-size probably pass. NOT TESTED on Render.
- Memory evidence: with --liftoff-only max RSS 108-359 MB (ky 108, vite 178, zod 172, excalidraw 250, TanStack 258, react full 359); without it 936-1684 MB, and react parse default died with V8 "Fatal process out of memory: Zone". VERIFIED (JSON). These are harness numbers, not the Next server: add Next baseline (INFERRED about 100-200 MB), cached indexes and concurrent answers. INFERRED: React-scale ingest likely exceeds 512 MB (OOM kill); mid-size repos borderline.
- Concurrency: INGEST_CONCURRENCY=1 (render.yaml:25), answers 2 concurrent (guards.ts:20); full gate returns 503 "busy" (guards.ts:107-109). VERIFIED. A running ingest also starves answers on the single throttled CPU (INFERRED).
- Rate-limit and daily counters live in process memory (limits.ts header) so they reset on every spin-down/restart: ANSWERS_PER_DAY=40 is not a hard budget across restarts; Groq's own free quota is the real ceiling. INFERRED.
- Cold start: first visit after idle waits about 1 min (doc), then needs re-ingest.
- 750 h/month covers one always-on service (744 h) only if no other free services share the workspace (INFERRED).

## (d) Environment variables
| Var | Required | Secret | Where set | Source |
|---|---|---|---|---|
| GROQ_API_KEY | yes (answers) | YES | dashboard (sync:false) | render.yaml:12-13 |
| GROQ_MODEL | yes, exact id (code never guesses) | no | dashboard (sync:false) | render.yaml:14-15 |
| GITHUB_TOKEN | optional, strongly advised (60 req/h unauthenticated) | YES (read-only, no scopes) | dashboard | render.yaml:16-17; src/github/client.ts:55 |
| INDEX_STORE_DIR | yes unless INDEX_STORE_URL | no | Dockerfile ENV /app/data | runtime.ts:31 |
| INDEX_STORE_URL, INDEX_STORE_TOKEN | optional alternative store | token YES | not set | runtime.ts:29-30 |
| TRUST_PROXY=1 | optional | no | render.yaml | guards.ts:73 |
| INGEST_CONCURRENCY=1 | optional | no | render.yaml | guards.ts:35-38 |
| INDEX_STORE_MAX_MB=300 | optional | no | render.yaml | runtime.ts:33 |
| ANSWERS_PER_DAY=40 | optional | no | render.yaml | guards.ts:40 |
| SOURCE_CACHE_DIR | optional | no | unset | runtime.ts:17 |
| PORT, HOSTNAME, NODE_ENV | set in Dockerfile | no | Dockerfile:15-18 | |

Exhaustive per grep of process.env in non-test, non-benchmark src. `.env.example` omits INDEX_STORE_URL/INDEX_STORE_TOKEN/SOURCE_CACHE_DIR (documented only in README.md:77). A unit test forbids committed secrets (deploy-config.test.ts:14-18). `sync: false` prompts for values at Blueprint creation (INFERRED standard Render behavior).
TRUST_PROXY=1 uses the LAST X-Forwarded-For entry (guards.ts:74). That Render appends the client address last is only asserted in a render.yaml comment; NOT verified from Render docs. If wrong, per-client limits are skipped or mis-keyed (global limits still apply). Check after deploy.

## (e) Deployment checklist (human)
1. Pre-check: git clean, on main, pushed to GitHub. Locally run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, then `npm start` and load http://localhost:3000 (the same standalone artefact Docker produces).
2. Collect secrets: Groq key (https://console.groq.com/keys, free plan, no card), exact GROQ_MODEL id, a no-scope GitHub token.
3. Render dashboard: New > Blueprint, connect the repo, pick render.yaml. Confirm service asktherepo, runtime docker, plan free, region frankfurt. Add no disk, no card-backed upgrades.
4. Enter GROQ_API_KEY, GROQ_MODEL, GITHUB_TOKEN when prompted.
5. Watch the build log (`npm ci`, `next build`, "Standalone server ready") and the start log (0.0.0.0:10000). If the free builder runs out of memory, fallback is to build the image elsewhere (for example GitHub Actions to ghcr.io) and deploy the prebuilt image, which loses auto-deploys (https://render.com/docs/web-services).
6. The deploy goes live only when `/` returns 2xx/3xx (health doc, 15 min window).
7. Smoke test on the onrender.com URL: load /, ingest a small repo (sindresorhus/ky), check totalMs under 120 s, ask one question, confirm citations, confirm security headers.
8. Resilience test: ingest vite while watching Render memory metrics; avoid React-size repos on the free tier.
9. Idle test: wait 15+ min, reload; expect about 1 min wake and re-ingest. Tell demo audiences, or pre-warm before presenting.
10. Cost guard: confirm Groq stays on the free plan, keep ANSWERS_PER_DAY low, watch Render hours/bandwidth.
11. Record the URL and deployed commit SHA.

Rollback: Render advertises zero-downtime deploys and instant rollbacks (https://render.com/docs/web-services); use the service's Deploys list to roll back to the previous successful deploy (exact UI path NOT verified). Alternatives: `git revert` and push, or manual deploy of a specific commit. To stop entirely: suspend or delete the service. Key leak: rotate in Groq/GitHub, update dashboard env, redeploy. No state needs restoring since all state is ephemeral.

## Risks ranked
1. CPU throttle breaks the 120 s ingest limit for mid/large repos (INFERRED, high likelihood).
2. 512 MB OOM on large repos (INFERRED, medium).
3. Ephemeral index store creates re-ingest friction after idle (VERIFIED behavior).
4. Dockerfile never built (NOT TESTED).
5. Health check hits a page, not an app endpoint; event-loop stalls could cause restarts (INFERRED, low-medium).
6. TRUST_PROXY assumption unverified; counters reset on restart (INFERRED).
7. Platform-injected HOSTNAME could break binding (INFERRED, low).
