# AskTheRepo

Ask a public GitHub repository how something works, and check the answer against its code.

AskTheRepo indexes one commit of a repository, retrieves the code relevant to a question, and returns an answer in which every claim carries its evidence: one or more citations, each with the passage quoted from it. Before the answer is shown, every citation is checked to point at real lines of that commit and every quote is checked to occur in the lines it cites; an answer that fails is withheld. The cited lines open beside the answer, with the quoted passage pointed out. When the evidence does not settle the question, the answer is "not enough evidence", not a guess.

**What is checked:** each citation points to real lines at the pinned commit, and each quote appears, word for word, in the lines it cites. **What is not checked:** whether those lines truly support the claim. That is a structural check, not a judgement of meaning. The interface says this next to every answer, and [SECURITY.md](SECURITY.md) says exactly how far each defence has been tested.

## How it works

```
repository URL
  → download one commit as a tarball (size, time and path limits enforced while streaming)
  → parse JavaScript / TypeScript with Tree-sitter into symbols, imports and chunks
  → build a compact BM25 index (terms and locations only; no source text is stored)
question
  → lexical retrieval over the index, expanded one hop along imports
  → re-read the matching spans from GitHub at that commit and compare fingerprints with the index
  → a language model is instructed to answer from those spans only; each claim lists {citation, quote} pairs
  → every citation is checked to exist and every quote to occur in the block it names; an answer that fails is withheld
  → the reader opens any citation to see the lines
```

## Stack

| Layer | What is used |
|---|---|
| Framework | Next.js 16 (App Router, route handlers, standalone output), React 19, TypeScript (strict) |
| Styling | Tailwind CSS v4 through `@tailwindcss/postcss`. Design tokens live in `src/app/globals.css` (`@theme`); the stock palette is switched off so only the semantic colours exist. Reusable components are in `src/ui/primitives.tsx`. |
| Code analysis | Tree-sitter (WebAssembly grammars) for JavaScript, TypeScript and TSX |
| Retrieval | BM25 over a purpose-built index, with identifier and path terms and import-aware expansion. No vector database, no embeddings. |
| Model | Groq through one small provider class, rate-limit aware. The model id is configuration; the evaluation used `openai/gpt-oss-120b`. |
| Tests | Vitest (unit and route tests) and a dependency-free browser check that drives Edge or Chrome over the DevTools Protocol |

There are no accounts and no database, and nothing that costs money: the model runs on Groq's free tier, within its limits.

## Project layout

```
src/app          pages and API routes
src/ui           client components, design-system primitives, and the UI's pure logic
src/server       request handling shared by routes: validation, limits, error mapping, stores
src/github       GitHub client with a host allowlist
src/ingest       streaming tarball reader and file filters
src/parse        Tree-sitter extraction
src/index        index build, serialisation and storage
src/retrieve     search
src/answer       evidence assembly, prompt, provider, citation validation
src/benchmark    evaluation harness (not part of the running app)
e2e              browser check and its fixtures generator
reports          evaluation results
```

## Setup

Requires Node.js 22 or newer.

```
npm install
cp .env.example .env.local   # then fill it in
npm run dev                  # http://localhost:3000
```

## Configuration (`.env.local`)

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | yes | Groq API key. Groq is the only model provider. |
| `GROQ_MODEL` | yes | Exact Groq model id. Without both Groq variables `/api/answer` returns 503; indexing and source inspection still work. |
| `INDEX_STORE_DIR` | yes (or `INDEX_STORE_URL`) | Local folder for built indexes. Relative paths resolve from the directory the server is started in. |
| `INDEX_STORE_MAX_MB` | no | Size limit for that folder (default 512). The oldest indexes are removed first; a removed index is simply rebuilt on request. |
| `GITHUB_TOKEN` | no | Read-only token without scopes. Unauthenticated, GitHub allows 60 API requests per hour per IP address, and each answer reads several files, so a busy server needs one. |
| `TRUST_PROXY` | no | Set to `1` only when a proxy you control appends the client address to `X-Forwarded-For`. Rate limits are then also counted per client, using the last entry of that header. Without it callers cannot be told apart and only the global limits apply. |
| `ANSWERS_PER_DAY` | no | Hard ceiling on answers per 24 hours for this process (default 25), to protect the model quota. Groq's free tier allowed roughly 50 answers a day in practice. A call the model itself turns away is not counted. The other answer limits are fixed in `src/server/guards.ts`: one question a minute for the whole server (two in a burst), one at a time; with `TRUST_PROXY=1`, one question every two minutes and at most 8 a day per client. After the model refuses for its own rate limit and states a wait, answers are paused until then. |
| `INGEST_CONCURRENCY` | no | How many repositories may be indexed at once (default 2). Indexing can use several hundred MB of memory; set `1` on a small host. |

`INDEX_STORE_URL` (with optional `INDEX_STORE_TOKEN`) can replace `INDEX_STORE_DIR` to use an HTTP object store. `SOURCE_CACHE_DIR` moves the file cache from memory to disk.

## Pages

- `/` — enter a repository; it is indexed at the latest commit of its default branch.
- `/r/<owner>/<name>/<commit>` — the workspace for one commit: ask questions, read answers, open any citation to see the lines. The address is the whole state, so it can be reloaded, bookmarked and shared.

## API

| Route | Purpose |
|---|---|
| `POST /api/ingest` `{"repo":"owner/name"}` (optional `"sha"`) | Builds and stores the index, or returns the existing one (`"cached": true`). |
| `GET /api/repo?repo=&sha=` | Whether a commit is indexed, with file, symbol and language counts. Never triggers indexing. |
| `POST /api/answer` `{"repo","sha","question"}` | The answer. `status` is `answered`, `insufficient_evidence`, `no_evidence`, `rejected` (failed citation checks) or `provider_error` (evidence still included; HTTP 429 with the model's `Retry-After` when the model's own rate limit refused the question, otherwise 502). Question limit: 300 characters. |
| `GET /api/source?repo=&sha=&path=&start=&end=` | Up to 400 lines of an indexed file at that commit. Files outside the index are refused. |
| `GET /api/search?repo=&sha=&q=` | Retrieval only, no model call. |

Errors are JSON `{ "error": "..." }`, sometimes with a `code`. Server-side details are logged, not returned. Limits answer `429` (or `503` when busy) with `Retry-After`; request bodies over 4 KB answer `413`. After the model's rate limit refuses a question and states a wait, `/api/answer` answers `503` with code `model_cooldown` until then, without calling the model. API responses carry `Cache-Control: no-store`. These limits are verified by tests with a stand-in for the model; a real rate-limit response from Groq has not been exercised.

## Checks

```
npm test            # unit and route tests
npm run typecheck
npm run lint
npm run build       # production build, prepared to run standalone
npm run e2e -- http://127.0.0.1:3100   # real browser, against a running server
```

`node e2e/real-model-journey.mjs` asks one question through the interface with the real model and writes down each claim next to the lines it cites. `npx tsx scripts/review-package.ts` builds the human-review package from private evaluation records.

The browser check drives Edge or Chrome through the product at desktop, tablet and phone sizes and writes screenshots and `report.json` to `e2e/artifacts/`. It indexes one small repository and reads source for real. It does not call a language model: answer states are exercised with responses produced by `e2e/make-answer-fixtures.ts`, which runs the real pipeline with the model step replaced by a stand-in.

## Running the production build

```
npm run build
PORT=3000 INDEX_STORE_DIR=/var/lib/asktherepo GROQ_API_KEY=... GROQ_MODEL=... npm start
```

`npm start` runs the self-contained server in `.next/standalone`. It needs a host that keeps one Node.js process running: the request limits and the file cache live in that process's memory, and the index folder must be writable. This has been exercised locally only; the project has not been deployed to a public host.

A `Dockerfile` and a Render blueprint (`render.yaml`) are included for a free demo instance. They follow the procedure above but have not been built or deployed yet. Storage on such a host is temporary: indexes are caches and are rebuilt on request after a restart.

## Status

A working application with an evaluation harness, not a finished product. Known limits: only JavaScript, TypeScript and Markdown are indexed; there is no authentication; request limits are per process; the model's resistance to adversarial repositories has been tried only once, on eight synthetic cases (`reports/phase4b-release-validation.md`). See [SECURITY.md](SECURITY.md).

Evaluation so far (see `reports/README.md`): three prompt variants were each run with a real model on the 32 tuning questions under the final evidence rule (one citation, one verbatim quote of at most 400 characters). All three runs are complete; no variant is established as better. Variant A's figures come from preserved model output re-validated after a classification correction, not from a fresh run. The reference labels are owner-supplied, not independent ground truth. The human review of the model's claims (Gate 5) has started and has not passed: the owner read part of variant A's claims and found partial and unsupported ones, without yet recording a verdict per claim. An assistant reading of all 65 claims traces 27 of them to missing evidence (`reports/gate5-evidence-gap-audit.md`). Two further single runs followed on the same tuning questions. A stricter prompt (variant D) was not better than C overall (`reports/phase4b-tuning-D.md`). Then "version 3 evidence", in which the application reads who imports something and a package's entry points from the index, states them itself and shows the model the declaring lines: that run answered 17 of the 24 answerable questions and refused all 8 unanswerable ones, the first run to do both, with every importer question answered completely, and with two answers lost to quotes over the length limit (`reports/phase4b-tuning-E-v3.md`). It is one run on questions the change was designed against, so it is a reason to continue, not a result to rely on. Separately, the rule on quote length was changed (evidence contract 3): a quote over 400 characters is now checked in full and shown shortened, where before it made the whole reply malformed; the five stored runs were validated again under it with no model call (`reports/phase4b-contract3-revalidation.md`).

**What the application runs.** The web application runs that last configuration: version 3 evidence, prompt E and evidence contract 3 (`APP_ANSWER_SETTINGS` in `src/answer/defaults.ts`). That is the owner's choice for the demonstration, made on one tuning run on questions the changes were designed against. It is not a variant selected by the evaluation method, and nothing has been confirmed on unseen questions. Beside the model's claims an answer may show a note "From the index, not from the model": a fact the application read from its own index (who imports something, or a package's entry points). Such a note is not a claim, is not backed by a quote, and can be incomplete where the index could not resolve an import. The holdout split has not been run with a real model. Earlier runs under the first quote rule are not comparable.

## Licence and third-party material

No licence has been chosen for this project yet; until one is added, all rights are reserved. Notices for the compiled grammar files a build redistributes are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The benchmark repositories and their licences are listed in [reports/README.md](reports/README.md); none of their source code is included here.
