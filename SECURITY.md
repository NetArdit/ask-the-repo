# Security model

AskTheRepo reads untrusted input from two directions: requests from anyone on the network, and the contents of any public repository a visitor names. This document states what the application defends against, how, and how far each defence has actually been tested.

Status words are used strictly:

- **VERIFIED** — an automated test or a recorded measurement in this repository shows it.
- **INFERRED** — follows from reading the code; not exercised directly.
- **NOT TESTED** — no evidence either way.

## Trust boundaries

| Source | Treated as |
|---|---|
| Request parameters and bodies | Hostile. Validated against strict shapes before use. |
| Repository files (code, comments, READMEs) | Data, never authority. They are indexed, quoted and shown; nothing in them is executed or obeyed by the application. |
| Model output | Untrusted. It is parsed against a schema and every citation is checked before anything is shown as an answer. |
| GitHub responses | Trusted for content at a commit, but size- and time-limited. |
| Environment variables | Trusted (set by the operator). |

## Repository content and prompt injection

A repository can contain text written to manipulate a language model ("ignore previous instructions…"). The design assumes it will.

| Defence | Status |
|---|---|
| Evidence is passed to the model inside delimiters built from a random marker chosen after the evidence is known, so repository text cannot forge the structure of the prompt. | VERIFIED (`src/answer/prompt.test.ts`) |
| The system instructions tell the model that evidence is untrusted data and must not be followed. | INFERRED to help; **NOT TESTED** against a real model |
| Evidence that reads like an instruction is flagged, and the interface warns when a claim rests only on such evidence. | VERIFIED for the flagging (`src/answer/evidence.test.ts`, `src/answer/answer.test.ts`); the flag is a keyword heuristic and its absence proves nothing |
| The model cannot supply locations: it cites evidence ids only; a path, repository, commit or line range it adds is checked against the evidence and rejected on any mismatch; links are built by the server. | VERIFIED (`src/answer/validate.test.ts`) |
| Forged ids, wrong repository or commit, fabricated paths, out-of-range or reversed line ranges are rejected. | VERIFIED (`src/answer/validate.test.ts`, including agreement with an independent oracle on 5,000 random citations; 25 of 25 scripted structural attacks blocked, `reports/phase3-report.md`) |
| Every citation carries its own quote, and the quote must occur as one continuous passage in the block that citation names. A real quote attributed to a different block, one quote offered for several citations, a citation with no quote, or a quote stitched from two places is rejected, and the whole answer is withheld. | VERIFIED (`src/answer/validate.test.ts`: wrong block, swapped quotes, stitched quote, twelve malformed shapes) |
| An answer that fails any check is withheld and labelled as such; its text is hidden unless the reader opens it. | VERIFIED (browser check) |
| A claim with a perfectly valid citation to lines that do not support it. | **NOT DEFENDED.** In the scripted test this reached the reader 10 times out of 10; the instruction-like warning fired on 8 (`reports/phase3-report.md`). The citation check cannot see meaning. |
| System-prompt extraction, instruction-following and persuasive but unsupported answers with a real model. | **PARTLY TESTED, one run.** A real model (`openai/gpt-oss-120b`, prompt variant A) was run once through the eight-case semantic-attack suite on a synthetic repository (`reports/phase4b-release-validation.md`). The four instruction-injection attacks did not succeed. The three misleading-evidence answers were read and were correct negations; the suite's own checks were negation-blind at the time and have since been fixed. This is one run of eight synthetic cases with an assistant's reading, not a human review, and says nothing about real repositories at scale. Variants B and C were not usable. |

What this adds up to: the application reliably refuses answers whose citations are not real. It does **not** establish that a cited passage supports the claim made about it, and it has not been shown to resist a repository crafted to mislead the model within valid citations. The interface says so next to every answer.

The checks also err in the other direction, deliberately: the validator prefers withholding a good answer to showing an unverifiable one. Under the first quote rule, a real answer whose claim was supported by its cited lines was withheld because it offered one quote made of a line from each of two blocks (a private journey record). The rule now asks for one quote per citation, so that case has a valid form; a reply that still stitches passages together is still withheld.

## Requests and resources

| Risk | Control | Status |
|---|---|---|
| Server-side request forgery | Requests driven by visitor input go only through the GitHub client: `api.github.com` and `codeload.github.com`, over HTTPS, with no port or credentials in the URL; redirects are followed by hand and re-checked on every hop. Repository names must match GitHub's own character rules. The server's other outbound calls are to fixed, operator-configured hosts: the model provider (`api.groq.com`) and, when set, `INDEX_STORE_URL`. | VERIFIED for the GitHub client (`src/github/client.test.ts`) |
| Using the server as a GitHub proxy | `/api/source` serves only files that are part of the index for that commit, at most 400 lines per request. | VERIFIED |
| Archive attacks (path traversal, bombs, symlinks) | Archive paths are identifiers only and never touch the disk. Limits: 150 MB compressed, 600 MB uncompressed, 150,000 entries, 1 MB per file, 120 s. Non-file entries are skipped. | VERIFIED (`src/ingest/*.test.ts`) |
| Oversized request bodies | 4 KB cap enforced while streaming; `413` beyond it. | VERIFIED |
| Flooding and quota exhaustion | Per-route global rate limits, per-client limits when a trusted proxy identifies clients, concurrency caps, and a hard daily ceiling on model calls, all in memory. Answers are sized to the model's free tier: one a minute for the server (two in a burst), one at a time, 25 a day by default; with a trusted proxy, one every two minutes and 8 a day per client. A call the model itself turns away is not counted, and after the model states a wait, answers are refused without calling it until then. Refusals carry `Retry-After`. Requests that could not have reached the model (malformed, oversized, commit not indexed, no model configured) do not use up the allowance of real ones. | VERIFIED for one process, with a stand-in for the model. They reset on restart and multiply across instances. A real rate-limit response from the provider, and the proxy's forwarding behaviour on a deployed host, are NOT VERIFIED. |
| Facts the application states itself | For "who imports X" and "what is the entry point" the application reads its own index and shows the result beside the model's claims, labelled "From the index, not from the model". File names in it are rendered as text. It goes to the model as a structure line that repository text cannot forge (it is forced onto one line and covered by the same per-request marker as the evidence). | VERIFIED by tests. The index can miss an import it could not resolve, so the note can be incomplete; it is not a claim and is not checked against a quote. |
| Over-long quotes | A quote over 400 characters is checked in full against the cited lines, then stored and shown cut to at most 400 characters and marked as shortened. Over 4,000 characters the reply is refused unread. | VERIFIED by tests, including a long quote that goes wrong after its 400th character. |
| Cached copies of answers and source excerpts | API responses carry `Cache-Control: no-store`. | VERIFIED locally. `Strict-Transport-Security` is not set by the application; whether the host adds it is NOT VERIFIED (not deployed). |
| Spoofed client address | `X-Forwarded-For` is ignored unless `TRUST_PROXY=1`. With it, the last entry is used (the one the proxy appended), so a client cannot choose its own identity by sending the header itself. | VERIFIED |
| Repeated or concurrent indexing | An existing index is reused; identical concurrent requests share one build; the latest-commit lookup is cached for 60 s. | VERIFIED |
| Disk growth | The local index folder is capped (`INDEX_STORE_MAX_MB`, default 512) and prunes oldest first. Temporary files are unique per write and removed on failure. | VERIFIED |
| Information leaks in errors | Unexpected failures return a fixed message; the detail is logged on the server. Provider errors never carry a response body, a prompt or a key. | VERIFIED |
| Cross-site scripting | Repository text and model text are rendered as text only (no `dangerouslySetInnerHTML` anywhere). Links are followed only to `https://github.com/`. A Content-Security-Policy restricts connections, objects and framing to this origin. | VERIFIED that output is rendered as text and that the policy is served. The policy allows inline scripts, and the interface has **not** been attack-tested with hostile content. |
| Clickjacking, MIME sniffing | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`. | VERIFIED |

## Evaluation records

Evaluation runs write two kinds of record. Public records (`reports/`) hold outcomes, evidence ids, file paths and line ranges, whether each check passed, structured rejection reasons and token counts. Private records (`reports/private/`, ignored by git) additionally hold the model's raw reply and the passages it quoted, because those can contain third-party source text; the human-review package built from them is private for the same reason. Neither kind contains credentials. The application never returns a model's raw reply to a client: the reply is handed only to an optional evaluation hook, and the HTTP response is built from the validated result (`src/server/answer-handler.test.ts`).

## Secrets

`GROQ_API_KEY` and `GITHUB_TOKEN` are read from the environment on the server. The model key is sent only in the `Authorization` header to Groq; the GitHub token only to `api.github.com`, never to a redirect target. Every `.env` file except the empty `.env.example` is ignored by git, and the standalone build contains no environment file.

## Privacy

There are no accounts and no analytics. Questions are sent to the configured model provider together with excerpts of the public repository; the provider's own retention rules then apply to them (Groq states it does not retain inference data by default but may keep logs for abuse and troubleshooting for up to 30 days). The index stores terms and locations, not source text. File contents fetched to show evidence are cached for up to 24 hours, in the server's memory by default or on its disk when `SOURCE_CACHE_DIR` is set. Question history and the list of recently opened repositories live in the visitor's own browser storage and are never sent to the server.

A public repository is not necessarily open source. The application shows excerpts of whatever repository a visitor names, with a permalink to the original, and sends excerpts to the model provider. An operator running a public instance is responsible for that use.

## Reporting a problem

Report a suspected vulnerability privately through the repository's "Report a vulnerability" page on GitHub (Security tab), not in a public issue. This is a personal project with no guaranteed response time.

## Known gaps

- No authentication. Anyone who can reach the server can use it, within the limits above.
- Limits are per process and in memory.
- Work a visitor started continues on the server after they leave or cancel: an index build runs to completion (and is then stored for the next visitor), and a model call already sent is not recalled.
- The Content-Security-Policy allows inline scripts, which Next.js requires without nonces.
- Semantic support of claims and real-model injection resistance are untested (see above).
- Only Chromium has been used for browser validation.
