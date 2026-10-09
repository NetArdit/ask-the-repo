# Product / UX / accessibility release-impact review

Scope: read-only code review of src/app/**, src/ui/**, globals.css/Tailwind tokens, e2e/browser-check.mjs, and the backend code whose behaviour the copy describes (answer.ts, guards.ts, errors.ts, ingest route, validate.ts). Nothing was built or run. VERIFIED = read directly in code. INFERRED = follows from the code but needs a browser/screen reader to confirm.

Verdict: no release-blockers found. Eight should-fix items (UX-01 to UX-03 matter most), five nice-to-have.

## Should-fix

### UX-01 Source inspector gives no keyboard or screen-reader feedback at 1100 px and wider (should-fix)
- Where: src/ui/Workspace.tsx:81-84 (inspect), :176-184 (aside placed after the thread in DOM order); src/ui/AnswerEntry.tsx:87-99.
- User experience: pressing a citation such as E1 changes aria-pressed and renders the lines in a side pane, but focus stays on the button and nothing is announced. A screen-reader user hears nothing happen. A keyboard user must Tab through every remaining citation, evidence row and answer card to reach the pane. The narrow-screen sheet does manage focus (showModal), so behaviour differs by width. The central action (read the cited lines) is the least accessible one on desktop.
- VERIFIED (code path); announcement behaviour INFERRED.
- Minimal fix: on open in pane mode, announce via the existing data-announce live region ("Showing lines X to Y of path in the source inspector"), or move focus to the pane heading (tabIndex -1) and return it on close. e2e has no check for this.

### UX-02 Screen-reader announcement is wrong or silent in two cases (should-fix)
- Where: src/ui/Workspace.tsx:92-93.
- User experience: (a) every non-failure outcome is announced as "A result is ready.", including withheld, not-enough-evidence and model-rate-limited, so a listener cannot tell an answer from a refusal. (b) The text follows thread[0] only. "Ask again" on an older card changes that card but not thread[0], so the live text does not change and nothing is announced.
- VERIFIED.
- Minimal fix: derive the text from the entry that last changed and from describeAnswer(...).title (for example "Answer withheld", "The model is rate limited right now").

### UX-03 Indexing progress is chatty for screen readers (should-fix)
- Where: src/ui/RepoForm.tsx:136-153; the elapsed counter is at :144.
- User experience: the whole progress box, including the "N s" counter that changes every second, sits inside role="status" aria-live="polite". During a one-to-two-minute index a screen reader can keep reading out the changing seconds.
- VERIFIED (structure); chatter INFERRED.
- Minimal fix: mark the counter aria-hidden, or keep only "Indexing owner/name" inside the live region.

### UX-04 "Try again" after a failed in-workspace indexing does not retry indexing (should-fix)
- Where: src/ui/Workspace.tsx:63-67, :129 (StatusError onRetry is retryStatus), :236.
- User experience: "Index this commit" fails with a retryable error (busy, network, GitHub rate limit, server error). "Try again" only re-checks status, the server still says not indexed, and the user lands back on the "not indexed" panel and must press "Index this commit" again. The error vanishes, so it looks as if nothing happened. Focus is dropped because the pressed button is removed.
- VERIFIED.
- Minimal fix: when context is "ingest", pass indexNow as onRetry.

### UX-05 A repository with no JS/TS/Markdown files indexes "successfully" with no explanation (should-fix)
- Where: src/index/from-tarball.ts:65 (no zero-file guard; /api/ingest returns 200 with files: 0); src/ui/Workspace.tsx:205 ("0 files and 0 symbols indexed"); src/ui/RepoForm.tsx:111 (the hint is the only warning).
- User experience: a Python, Go or Rust repo passes the form, shows progress, then opens a normal workspace with an Ask box. Every question ends in "Not enough evidence to answer ... Try naming a function, file or option that appears in the code", which is wrong advice when nothing is indexed. A likely first-run path.
- INFERRED. The missing guard is VERIFIED; I did not run it against a non-JS repo.
- Minimal fix: in IndexFacts, when summary.files === 0, show a Notice ("No JavaScript, TypeScript or Markdown files were found, so there is nothing to ask about") and hide or disable the Ask form. Alternatively have ingest return 422.

### UX-06 Landing copy slightly overstates grounding (should-fix, honesty)
- Where: src/app/page.tsx:43 ("links to the exact lines it rests on"); src/app/page.tsx:16 ("A language model answers from those spans only").
- User experience: "rests on" says the cited lines support the claim, which is the thing the same page says is not checked (page.tsx:23, AnswerEntry.tsx:186). "Answers from those spans only" is an instruction to the model, not something the validator enforces; validate.ts:149-150 checks only that ids exist and quotes occur verbatim.
- VERIFIED.
- Minimal fix: "links to the lines it cites" and "is told to answer from those spans only; each claim must cite one, and each citation is checked to exist". The answer card, footer and limits list are accurate.

### UX-07 Daily-limit message promises something the UI cannot deliver (should-fix, copy accuracy)
- Where: src/ui/answer-view.ts:151.
- User experience: "Retrieval still works; answers will return later." On a daily-limit 429 the answer route returns no evidence (guards.ts:96-101), and no screen uses /api/search. The user finds no retrieval, no retry (canRetry false) and no time (retryAfterSeconds is sent but unused).
- VERIFIED.
- Minimal fix: "This server has used its allowance of answers for today. Try again later." Optionally append wait(f.retryAfterSeconds).

### UX-08 Question limit is invisible until a failed submit (should-fix, low effort)
- Where: src/ui/Workspace.tsx:292 (hint omits the limit), :294 (counter is aria-hidden), :256.
- User experience: the 300-character limit is only a visual counter. A screen-reader user learns of it after pressing Enter and getting an alert. On mobile, Enter submits and there is no Shift key, so multi-line input is impossible; the hint's "Shift+Enter for a new line" does not apply to touch.
- VERIFIED.
- Minimal fix: add "Up to 300 characters." to the hint (already in aria-describedby).

## Nice-to-have

- UX-09: green is the "verified" colour for the answered card edge (AnswerEntry.tsx:23-30) and citation chips (primitives.tsx:101-106). Green can read as "correct". The "Checked / Not checked" paragraph (AnswerEntry.tsx:183-187) is honest but sits below the claims. INFERRED. Fix: neutral card edge, or move the scope sentence under the "Answer" title.
- UX-10: aria-pressed on citations and evidence rows implies a toggle, but pressing the selected one again does nothing (Workspace.tsx:81-84); on wide screens the inspector cannot be dismissed. Fix: use aria-current, or let a second press clear it.
- UX-11: after a failed in-form index, the example buttons disappear (RepoForm.tsx:116) and the error stays while the user edits the field (RepoForm.tsx:90-93 clears only the validation error). Fix: clear the failure on change.
- UX-12: Cancel (RepoForm.tsx:148) aborts only the browser request. The ingest route does not read request.signal (route.ts:50-60), so the server keeps working and holds an ingest slot. Resubmitting the same repo shares the in-flight build, so it is mostly harmless, but repeated cancel/retry can hit "server is busy" with no hint why. Fix: say "Cancelling stops waiting; the server may finish indexing".
- UX-13: focus is lost on state swaps that remove the pressed control: "Index this commit" (Workspace.tsx:120-127) and StatusError "Try again". Fix: focus the replacing status element (tabIndex -1).

## Checked and found good

- First run: one clear H1 and promise, example repos, URL preview ("Will index owner/name at the latest commit"), plain "what it does not do" list including that semantic support is not judged and that prompt-injection defence is unproven. Apart from UX-06 the landing statements match the backend: the index holds terms and locations only (index/types.ts:42), and evidence is re-hashed at the commit before use (answer/evidence.ts:80).
- URL input: parseRepoInput handles owner/name, https, ssh and .git forms, non-GitHub hosts, over-long input and extra path segments (with a note that they were ignored). Errors are specific, announced via role="alert", and focus returns to the field. Cancel restores focus and the typed value (e2e covers it).
- Failure mapping (answer-view.ts describeFailure) matches ingestErrorResponse and guards: not found, private, too large, empty repo, rate limited with retry-after, daily limit, busy, GitHub rate limit, no provider, network, server error. Server text is passed through only for 400s; no internals leak.
- Answer states: answered, insufficient (model asked or not asked, worded accurately for each), no_evidence, withheld (reasons built from codes; the withheld reply is behind a disclosure with "do not treat it as an answer"), provider error (rate limit, timeout, blocked, generic) with retrieved evidence kept and a retry. Copy never says a citation proves a claim. Per-claim check text and the "Checked / Not checked" paragraph are accurate against validate.ts. Instruction-like evidence is flagged on both the answer and the inspector.
- Citations: each citation button has a descriptive aria-label (id, path, lines). The quote is shown beside it; a quote that is not found is red, struck through and has sr-only text. The inspector marks cited and quoted lines, links to a GitHub permalink restricted to https://github.com/, and offers a fallback link on source errors. The source region is a labelled, focusable pre; the gutter is aria-hidden and select-none.
- Narrow screens: the native dialog sheet gives a focus trap, Escape, inert background, a labelled heading and focus return. Context state survives moving between pane and sheet.
- Page structure: skip link targets main#main (tabIndex -1). html lang, nav label, title template and heading order are correct. Labels are tied to inputs with aria-describedby. Global focus-visible outline, reduced-motion spinner fallback, 44 px touch and 24 px minimum targets. Contrast is token-driven for dark and light, and e2e measures it on rendered pairs.
- Responsive: 1440, 1024, 820, 390 and 320 px checked for sideways scroll; the JS breakpoint constant matches the CSS breakpoint.
- Empty and error pages: not-found and error pages have a way forward; a malformed commit gives a real 404; an unindexed commit offers an explicit re-index; the thread persists per tab in sessionStorage without saving pending entries; storage failures degrade to empty.
- Browser checks: 57 record() call sites (85 results with per-viewport loops) cover the headline flows. I did not run them.

## What the browser checks do not cover (informational)

e2e/browser-check.mjs stubs only five answer fixtures (answered, insufficient search and model, rejected, provider-rate-limited). Not covered:
- 429 and daily-limit answer failures, the network failure, and "Ask again" on a failure card.
- A no_evidence result, a broken or unknown citation chip, a quote-mismatch display, and instruction-like evidence warnings in the UI.
- A source-inspector failure (/api/source error and its fallback link), and "Clear history".
- A question over 300 characters.
- A repository with zero indexable files (UX-05).
- Live-region content (UX-02, UX-03), focus behaviour in the wide-screen pane (UX-01), and the in-workspace ingest-failure retry (UX-04); the existing check asserts only that "Try again" exists.
