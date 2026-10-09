# AskTheRepo static security/privacy review

Scope: src/app/**, src/server/**, src/github/**, src/ingest/**, src/answer/**, src/index/**, src/ui/** (rendering), next.config.ts, Dockerfile, .dockerignore, render.yaml, .env.example, SECURITY.md. Static read only; nothing was run except `npm audit --omit=dev` (result: 0 vulnerabilities). No tests, builds or model/API calls; .env.local not read.

Overall: no high or medium severity defect found. The main controls (host allowlist with manual redirects, path normalisation, streaming archive limits, schema-plus-quote citation validation, text-only rendering, fixed error messages) are implemented as SECURITY.md claims. The findings below are availability/abuse edges and hardening gaps.

## Findings

### S1 (low, availability) Global buckets and daily answer cap can be exhausted by one client
- File: src/server/guards.ts:20-23, 73-77, 85-103; render.yaml TRUST_PROXY=1, ANSWERS_PER_DAY=40.
- Evidence: without TRUST_PROXY there is no per-client limit (clientKey returns null), so a single caller can consume the whole `read` (600/min), `ingest` (24/10 min) and `answer` (20/min) global buckets. The daily answer counter (WindowCounter) is global; even with per-client limits (6/min) one address uses 40 answers in about 7 minutes and locks out everyone for the rest of the 24 h window. The daily counter is only refunded when the model was not called.
- VERIFIED by reading. It is a documented design trade-off (SECURITY.md "Known gaps": no authentication), so this is a residual risk, not a bug.
- Fix: add a per-client daily cap (for example 5-10 answers/day per address) in addition to the global ceiling; optionally a small CAPTCHA/shared-secret gate for the public demo.

### S2 (low, INFERRED) "Last X-Forwarded-For entry" may not be the client on Render
- File: src/server/guards.ts:73-76; render.yaml comment "Render's proxy appends the client address".
- Evidence: the code takes `.at(-1)`. That is correct only if exactly one trusted hop appends the real client address. If Render fronts the app with more than one proxy (e.g. a CDN edge then a router), the last entry is the previous proxy, so all users would share one or a few per-client buckets (self-inflicted lockouts) rather than being spoofable. I could not confirm Render's header layout from the repo; this was not checked against Render docs.
- Fix: verify against a deployed instance (send a request, log the header shape once), or make the number of trusted hops configurable (`TRUST_PROXY=<hops>`, pick entry `length - hops`). IPv6 clients can rotate within a /64; bucket by /64 prefix for IPv6.

### S3 (low) No Origin / Content-Type check on the state-changing POST routes
- File: src/app/api/ingest/route.ts:42-47, src/app/api/answer/route.ts:12-19, src/server/limits.ts:129-151.
- Evidence: readJsonBody ignores Content-Type and parses any body as JSON, so a third-party page can make a victim's browser send a "simple" cross-site POST (`text/plain` form or `fetch` with `no-cors`) to /api/ingest or /api/answer. No cookies or auth exist, so the only impact is spending the victim's per-client allowance or the global quota, which anyone can already do directly. CORS is not enabled (no Access-Control headers anywhere), so responses are unreadable cross-origin.
- VERIFIED by reading (grep found no origin/content-type handling).
- Fix: require `content-type: application/json` (forces a preflight cross-origin) and/or reject when `Origin` is present and not same-origin / `Sec-Fetch-Site: cross-site`.

### S4 (low) No limit on indexed artifact size or file count beyond tar entry/byte limits
- File: src/ingest/tarball.ts:16-22, src/index/from-tarball.ts:36-73, src/app/api/ingest/route.ts:22-40.
- Evidence: limits are 150 MB compressed, 600 MB uncompressed, 150,000 entries, 1 MB per file, 120 s (the 120 s covers download plus per-file parse; the timer is cleared before `builder.finish()` and `serializeIndex`, which are synchronous and unbounded). A repo of 150k small JS/TS/MD files is within limits and builds an in-memory index (the Dockerfile notes 0.11-0.37 GB peaks on a 512 MB instance). `fetchRepoInfo().sizeKb` is read but never used to refuse oversized repos up front. Also the first-seen artifact is written to the store whatever its size (BoundedStore keeps the newest even if over cap, bounded-store.ts:52).
- INFERRED for memory exhaustion (not measured with a hostile repo); the limits themselves are VERIFIED in the code.
- Fix: cap files delivered and total delivered bytes (for example 20k files / 60 MB of indexed text) and refuse on `sizeKb` over a threshold when the size is known; include finish/serialize in the time budget or run ingest in a worker with a memory ceiling.

### S5 (low, hardening) Index decompression has no output cap
- File: src/index/serialize.ts:27.
- Evidence: `brotliDecompressSync(bytes)` with no `maxOutputLength`. The input comes only from the operator-controlled store (LocalFsStore or INDEX_STORE_URL), which SECURITY.md treats as trusted, so a bomb needs store compromise or a malicious INDEX_STORE_URL target.
- INFERRED. Fix: pass `{ maxOutputLength: 512 * 1024 * 1024 }` and cap HttpIndexStore GET body size (http-store.ts:72).

### S6 (low, hardening) Browser-stored data is trusted for routing and results
- File: src/ui/store.ts:82-88, 112-124; src/ui/RecentRepos.tsx:17.
- Evidence: `parseRecents` checks the type of `owner`/`repo` but not the repo-name character rules, then builds a `Link href=/r/${owner}/${repo}/${sha}`. localStorage is same-origin and writable only by code already running on the origin, so this is not exploitable without prior XSS; the target page re-validates the segments (page.tsx:9-16). Stored thread results (sessionStorage) are rendered as text and links pass through `githubUrl`.
- VERIFIED by reading. Fix: run `parseRepoRef` on stored owner/repo in parseRecents.

### S7 (info) Rejected answers return the model's parsed claims and invalid citation ids to the client
- File: src/answer/answer.ts:164-179, src/answer/validate.ts (reasons built from model-supplied citation ids, up to 40 chars).
- Evidence: the raw reply is never returned (SECURITY.md claim is accurate: `onModelOutput` is the only sink, answer-handler.ts builds the response from the validated result). However, for status `rejected`, `claims` still carry the model's claim text (up to 600 chars each, 8 claims), `missing`/`unsupported` strings, and model-chosen citation ids inside `reasons`. These are rendered as text only. This is partial model output exposure, by design (UI hides it behind a disclosure), and could include system-prompt fragments if a repository manages to induce a leak.
- VERIFIED. Fix (optional): for rejected results, omit claim text from the HTTP body or truncate ids in `reasons`.

### S8 (info) Prompt-injection residuals (already documented)
- The nonce structure (prompt.ts:73-93) and "evidence is untrusted" system rule are sound; the nonce is drawn after evidence is known. Evidence lines are prefixed `L<n>| `. `INSTRUCTION_LIKE` (evidence.ts:197) is a narrow English keyword regex; absence proves nothing, as SECURITY.md states. The question is placed inside the user message with `Q| ` prefix (a visitor can only attack their own query). Semantically valid-but-misleading citations remain undefended, as documented. No new finding.

### S9 (info) Security headers
- File: next.config.ts:7-31.
- CSP is served on every route with `script-src 'self' 'unsafe-inline'` (needed without nonces; documented), `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `connect-src 'self'`, `form-action 'self'`. Missing but optional: `Strict-Transport-Security` (Render terminates TLS; set it at the platform or add it), `Cross-Origin-Opener-Policy`, `Cache-Control: no-store` on API responses (API routes are `force-dynamic`, so not cached by Next, but intermediaries are not told). Not checked against Next 16 docs for any header-override behaviour beyond the standard `headers()` API used here.

### S10 (info) 404 message reveals "private" status
- File: src/server/errors.ts:23, src/github/client.ts:120. A repo that exists but is private gives "Private repositories are not supported" while a missing one gives "repository or commit not found". The token is scopeless so GitHub itself returns 404 for private repos; this path only fires when `private` is true in a 200 response (should not occur for a scopeless token). Negligible.

### S11 (info) Dockerfile / deployment
- Dockerfile runs as `node` (non-root), multi-stage, standalone output only in the final image; `.dockerignore` excludes `.env*` (except .env.example), `reports`, `.git`. Image tag is not pinned by digest and the file is marked as never built; lockfile is used (`npm ci`). `console.error(error)` in app/error.tsx:8 logs the client-side error object in the browser only.

## Checked and found fine

- SSRF / URL validation: all visitor-driven outbound requests go through githubFetch (client.ts:62-89): https only, host in {api.github.com, codeload.github.com}, no port/credentials, `redirect: "manual"`, allowlist re-checked on every hop (max 3), token attached only when hostname is api.github.com (client.ts:56-57), so never sent to codeload or a redirect target. Owner/repo regexes (repo-ref.ts) block `/`, `..`, `.git`, non-ASCII; sha must be 40 lowercase hex; branch name is `encodeURIComponent`-ed; source path segments are `encodeURIComponent`-ed. Other outbound hosts: api.groq.com (fixed) and operator-set INDEX_STORE_URL.
- Archive extraction: no extraction to disk; paths are identifiers (tarball.ts); non-file entries (symlinks, hardlinks, dirs) skipped; `normalizeArchivePath` rejects empty, >400 chars, NUL, backslash, absolute, drive letter and `..` segments; compressed and decompressed byte counters sit in the pipeline with abort; entries, per-file (declared size) and total-time limits enforced; source stream destroyed in `finally`.
- Index and cache store keys: LocalFsStore.fileFor re-validates owner/repo/sha before `path.join`; HttpIndexStore.urlFor does the same; FsSourceCache names files by SHA-256 of the key (cannot be steered by repo content); source-cache keys re-validate and normalise paths; temp files are unique and removed on failure.
- Body handling: 4 KB cap enforced from Content-Length and while streaming (limits.ts:129-145); malformed/oversized requests refund their allowance; question limited to 300 chars; all query params parsed through strict validators (line numbers `^[1-9]\d{0,6}$`, max 400 lines per source request, line text cut at 2000 chars).
- /api/source cannot be used as a GitHub proxy: path must be in the index for that commit (repo-handler.ts:122-131, 153).
- Errors: `ingestErrorResponse` maps only known classes to fixed messages, everything else logs server-side and returns "internal error"; search/source/repo/answer routes do the same. ProviderError carries only a kind and status; rate-limit diagnostics are whitelisted and never reach the client.
- Secrets: GROQ_API_KEY read only in `selectProvider` and sent only in the Authorization header to Groq; GITHUB_TOKEN only to api.github.com; neither is logged (server logs are `name: message` of errors, whose messages carry URLs without credentials; GitHubHttpError uses only pathname). No `NEXT_PUBLIC_` variables. `.env*.local` gitignored; `git ls-files` shows only `.env.example` tracked; render.yaml marks secrets `sync: false`. Production `diagnostics()` returns no process info.
- Rate limiting: per-route global and optional per-client token buckets with bounded key maps (5000), concurrency gates, hard daily ceiling, correct refund paths (answer/route.ts finally block handles the busy-refusal path). XFF is ignored unless TRUST_PROXY=1 (aside from S2).
- XSS: grep found no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, or user-built `RegExp` in app code; external links use `rel="noopener noreferrer"` and pass through `githubUrl` (prefix `https://github.com/`); permalinks are server-built with encoded path segments; repo/sha route params are validated before render.
- Model output: schema-strict parsing, caps on claims, claim length, citations, quote length; citation ids, quotes and locations verified server-side; links built by the server; model cannot supply URLs.
- Dependencies: `npm audit --omit=dev` reports 0 vulnerabilities (next ^16.3.8, tar-stream ^3.2.1, web-tree-sitter 0.25.10).
- Container: non-root user, secrets not baked in, `.env*` and `reports` excluded from the build context.
