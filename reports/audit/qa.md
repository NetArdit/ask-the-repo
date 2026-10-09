# QA audit

## Command results
| Command | Result | Duration |
|---|---|---|
| `npx vitest run` #1 | 41 files, 492 tests passed | 35.4 s |
| `npx vitest run` #2 | 41 files, 492 tests passed | 22.3 s |
| `npx vitest run` #3 | 41 files, 492 tests passed | 21.5 s |
| `npx tsc --noEmit` | clean, no output | ~9 s |
| `npx eslint --max-warnings 0 src scripts` | clean, no output | ~20 s |

Run 1 was slower (cold cache / worker spawn ~900 ms per file). Concurrent-run stress was skipped (4 GB RAM).

## Flake analysis: UNCHARACTERISED (no reproduction in 3 runs)
The earlier 2-test failure right after a model run was not reproduced. Static evidence on what could cause it:
- No test uses a fixed port, real network, or real Groq/GitHub calls (GitHub client is mocked via vi.mock; `app.listen(3000)` in index.test.ts is a fixture string inside test source, not executed).
- Temp dirs are all unique `mkdtemp` per test; no shared fixed temp paths.
- Fake timers / timing: tarball total-time limit and RateLimiter use real timers/Date; under heavy CPU load (a model run in parallel, 4 GB box swapping) a time-based limit test (src/ingest/tarball.test.ts total-time, src/server/limits.test.ts refill) is the most plausible timing flake. Default vitest timeout is 5 s; run 1 at 35 s total with ~900 ms per-file spawn shows the box is near the edge when busy. Most likely explanation: timeouts or timing assertions under load; unproven.
- Cache-state: `answer-records`, `answer-resume`, `answer-variant` use `describe.skipIf(!HAVE_CACHE)` on the git-ignored `.cache` (index + tarballs). With the cache absent they are skipped (fewer tests), not failed. With a cache present they run against it, so a half-written/in-use cache during a concurrent model run is a plausible source of a 2-test failure (these files are the ones that read the shared `.cache`, and a model/bench run writes it). Moderately likely.
- Groq key: `selectProvider` tests pass explicit env objects; routes.test.ts uses `vi.stubEnv` + `unstubAllEnvs`. No test reads the real GROQ_* env, so a differing/absent key cannot change results. Ambient env vars that CAN affect tests if set in the shell: `ANSWERS_PER_DAY`, `INGEST_CONCURRENCY`, `SOURCE_CACHE_DIR`, `INDEX_STORE_MAX_MB`, `GITHUB_TOKEN`, `TRUST_PROXY` (guards.ts/runtime.ts read process.env; routes-guards stubs only INDEX_STORE_*/TRUST_PROXY). Low risk unless set.
- Nothing reads reports/private or benchmark checkpoints in tests (checkpoint tests write to mkdtemp dirs).
Recommendation: if it recurs, capture which files failed; check whether they are the three cache-gated benchmark files, and rerun not concurrent with a model run.

## Coverage gaps (ranked; none critical enough to add a test)
1. /api/answer route level: only one route test (500 sanitising). Input validation, 503 no-provider and daily-limit mapping are covered at handler/limits level (answer-handler.test, limits.test, routes-guards limits) but not asserted through the route with real status+headers (Retry-After). Medium.
2. Deploy config: deploy-config.test.ts has 2 tests (--liftoff-only, no committed secrets). No check of required env/health-check path, or that INDEX_STORE_* / ANSWERS_PER_DAY are set in the blueprint. Medium.
3. Ingest limits: tarball.test.ts (11 tests) covers the limit kinds; route-level mapping of LimitExceededError to 413 is in routes.test ("error mapping"). Entries/total-time under real load not stress-tested. Low.
4. Source viewing: routes-guards covers happy path, `.env` outside-index, `../` and non-sha 400. No test for end<start, huge ranges, or very large line counts at the route. Low-medium.
5. UI state mapping (answer-view.ts): describeAnswer/describeFailure covered in ui-logic.test.ts but with few cases (3 describeAnswer tests: answered, rejected, insufficient x2); `no_evidence`, `provider_error` tones and each failure kind are only checked loosely in one "words each failure" test. Low.
6. validate.test.ts has only 2 tests (server/validate.ts) - thin but paired with parseAnswerBody and repo-input tests. Low.
7. Cache-gated tests silently skip without `.cache`; CI/fresh clone gets lower coverage with no signal. Low.

## Added
Nothing. No existing tests or sources modified.
