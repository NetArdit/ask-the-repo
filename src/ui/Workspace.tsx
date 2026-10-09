"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import type { CitedEvidence } from "../answer/answer";
import { AnswerEntry } from "./AnswerEntry";
import { describeAnswer, describeFailure, type FailureContext } from "./answer-view";
import { askQuestion, fetchRepoSummary, ingestRepository, type ApiFailure, type RepoSummary } from "./api";
import { Button, EmptyState, Eyebrow, Notice, Panel, Shell, Tag, Working, fieldErrorClass, fieldHintClass, fieldLabelClass, linkClass, textareaClass } from "./primitives";
import { NO_CONTEXT, Sheet, SourceInspector, type SourceContext } from "./SourceInspector";
import { rememberRepo, threadStore, type Outcome } from "./store";

/** Same limit the server enforces. */
const MAX_QUESTION = 300;
/** Must match the `wide` breakpoint in globals.css: from here up the inspector is a column, below it a sheet. */
const WIDE = "(min-width: 68.75rem)";

type Status =
  | { phase: "loading" }
  | { phase: "ready"; summary: RepoSummary }
  | { phase: "missing" }
  | { phase: "indexing" }
  | { phase: "error"; failure: ApiFailure; context: FailureContext };

function subscribeWide(listener: () => void): () => void {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

export function Workspace({ owner, repo, sha }: { owner: string; repo: string; sha: string }) {
  const repoName = `${owner}/${repo}`;
  const store = useMemo(() => threadStore(owner, repo, sha), [owner, repo, sha]);
  const thread = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );

  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<{ entryId: string; evidence: CitedEvidence; context: SourceContext; quote?: string; focusRequest: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const focusSeq = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRepoSummary(repoName, sha, controller.signal).then((res) => {
      if (res.ok) {
        setStatus({ phase: "ready", summary: res.data });
        rememberRepo({ owner, repo, sha, files: res.data.files }, Date.now());
      } else if (res.kind === "not_indexed") setStatus({ phase: "missing" });
      else if (res.kind !== "aborted") setStatus({ phase: "error", failure: res, context: "status" });
    });
    return () => controller.abort();
  }, [repoName, owner, repo, sha, reload]);

  // Spoken updates: what just happened to the question that last changed, and what the source inspector now shows.
  const [live, setLive] = useState({ text: "", n: 0 });
  const say = (text: string) => setLive((l) => ({ text, n: l.n + 1 }));

  // Pressing "Index this commit" or "Try again" removes the button that was pressed. Focus goes to the area whose content
  // replaces it, so a keyboard user is not left with focus nowhere; once the workspace is ready it goes on to the question field.
  const statusAreaRef = useRef<HTMLDivElement>(null);
  const startedByUser = useRef(false);
  useEffect(() => {
    if (status.phase !== "ready" || !startedByUser.current) return;
    startedByUser.current = false;
    document.getElementById("question")?.focus();
  }, [status.phase]);

  function retryStatus() {
    setStatus({ phase: "loading" });
    setReload((n) => n + 1);
  }

  /** "Try again" repeats what failed: indexing if indexing failed, otherwise the check of whether the commit is indexed. */
  function retryFailed(context: FailureContext) {
    startedByUser.current = true;
    statusAreaRef.current?.focus();
    if (context === "ingest") void indexNow();
    else retryStatus();
  }

  async function indexNow() {
    startedByUser.current = true;
    statusAreaRef.current?.focus();
    setStatus({ phase: "indexing" });
    const res = await ingestRepository(repoName, sha);
    if (res.ok) retryStatus();
    else setStatus({ phase: "error", failure: res, context: "ingest" });
  }

  async function ask(question: string, replaceId?: string) {
    const id = replaceId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const pending: Outcome = { kind: "pending" };
    const before = store.getSnapshot();
    store.set(replaceId ? before.map((e) => (e.id === id ? { ...e, outcome: pending } : e)) : [{ id, question, outcome: pending }, ...before]);
    if (selected?.entryId === id) setSelected(null);
    say("Working on your question.");
    const res = await askQuestion(repoName, sha, question);
    const outcome: Outcome = res.ok
      ? { kind: "result", result: res.data, ...(res.retryAfterSeconds ? { retryAt: Date.now() + res.retryAfterSeconds * 1000 } : {}) }
      : { kind: "failure", failure: res };
    store.set(store.getSnapshot().map((e) => (e.id === id ? { ...e, outcome } : e)));
    say(`${res.ok ? describeAnswer(res.data).title : describeFailure(res, "answer").title}.`);
  }

  function inspect(entryId: string, evidence: CitedEvidence, trigger: HTMLElement, quote?: string) {
    triggerRef.current = trigger;
    focusSeq.current += 1;
    setSelected({ entryId, evidence, context: NO_CONTEXT, quote, focusRequest: focusSeq.current });
    say(`Showing lines ${evidence.startLine} to ${evidence.endLine} of ${evidence.path} in the source inspector.`);
  }

  function closeInspector() {
    setSelected(null);
    triggerRef.current?.focus();
  }

  const busy = thread.some((e) => e.outcome.kind === "pending");
  const inspectorKey = selected ? `${selected.entryId}:${selected.evidence.id}:${selected.quote ?? ""}` : "";
  const setContext = (context: SourceContext) => setSelected((s) => (s ? { ...s, context } : s));

  return (
    <Shell>
      <div className="grid gap-3 py-6">
        <Link href="/" data-back className={`inline-flex min-h-7 items-center justify-self-start text-sm text-ink-soft ${linkClass}`}>
          ← Index another repository
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h1 className="font-mono text-title font-semibold tracking-tight wrap-anywhere">{repoName}</h1>
          <a href={`https://github.com/${owner}/${repo}/tree/${sha}`} target="_blank" rel="noopener noreferrer" className={`font-mono text-sm text-ink-soft ${linkClass}`}>
            @ {sha.slice(0, 7)}
            <span className="sr-only"> on GitHub (opens in a new tab)</span>
          </a>
        </div>
        {status.phase === "ready" && <IndexFacts summary={status.summary} />}
      </div>

      <div ref={statusAreaRef} data-status-area tabIndex={-1}>
        {status.phase === "loading" && <Working>Checking the index for this commit…</Working>}

        {status.phase === "missing" && (
          <Panel className="grid max-w-[44rem] gap-3">
            <p className="font-semibold">This commit is not indexed on this server</p>
            <p className="text-ink-soft">Indexes are kept only while the server has them. Index this commit again to ask questions about it.</p>
            <div>
              <Button variant="primary" onClick={() => void indexNow()}>
                Index this commit
              </Button>
            </div>
          </Panel>
        )}

        {status.phase === "indexing" && <Working>Indexing this commit. Large repositories can take a minute or two…</Working>}

        {status.phase === "error" && <StatusError failure={status.failure} context={status.context} onRetry={() => retryFailed(status.context)} />}

        {status.phase === "ready" && status.summary.files === 0 && (
          <Notice tone="warn" title="Nothing here can be searched" data-empty-index className="max-w-[44rem]">
            <p>No JavaScript, TypeScript or Markdown files were found at this commit, so there is nothing to ask about. Other languages are not indexed yet.</p>
          </Notice>
        )}
      </div>

      {status.phase === "ready" && status.summary.files > 0 && (
        <div data-workspace className="grid items-start gap-6 pb-12 wide:grid-cols-[minmax(0,11fr)_minmax(0,12fr)]">
          <div className="grid min-w-0 gap-6">
            <AskForm busy={busy} onAsk={(q) => void ask(q)} />
            <p data-announce role="status" className="sr-only">
              {live.text}
              {live.n % 2 === 1 ? " " : ""}
            </p>
            <section data-thread aria-labelledby="thread-title" className="grid gap-6">
              <div className="flex items-center justify-between gap-3">
                <Eyebrow as="h2" id="thread-title">
                  Questions about this commit
                </Eyebrow>
                {thread.length > 0 && !busy && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => {
                      setSelected(null);
                      store.set([]);
                    }}
                  >
                    Clear history
                  </Button>
                )}
              </div>
              {thread.length === 0 ? (
                <EmptyState title="No questions yet">
                  <span>Ask about something you could confirm by reading code: where a function is implemented, what an option does, how a case is handled.</span>
                  <span>Questions about intent, quality or security get a weaker answer, because code rarely states those outright.</span>
                </EmptyState>
              ) : (
                thread.map((entry) => (
                  <AnswerEntry
                    key={entry.id}
                    entry={entry}
                    selectedEvidenceId={selected?.entryId === entry.id ? selected.evidence.id : null}
                    onInspect={(evidence, trigger, quote) => inspect(entry.id, evidence, trigger, quote)}
                    onRetry={() => void ask(entry.question, entry.id)}
                    busy={busy}
                  />
                ))
              )}
            </section>
          </div>

          <aside data-pane aria-label="Source inspector" className="hidden min-w-0 rounded-md border border-line bg-surface wide:sticky wide:top-4 wide:block wide:max-h-[calc(100dvh-2rem)] wide:overflow-auto">
            {selected && wide ? (
              <SourceInspector key={inspectorKey} owner={owner} repo={repo} sha={sha} evidence={selected.evidence} headingId="inspector-title" context={selected.context} onContextChange={setContext} quote={selected.quote} focusRequest={selected.focusRequest} onReturn={() => triggerRef.current?.focus()} />
            ) : (
              <EmptyState title="Source inspector" bare>
                <span>Select a citation such as E1, or a row of evidence, to read the exact lines at this commit.</span>
              </EmptyState>
            )}
          </aside>
        </div>
      )}

      {selected && !wide && (
        <Sheet labelledBy="inspector-title" onClose={closeInspector}>
          <SourceInspector key={inspectorKey} owner={owner} repo={repo} sha={sha} evidence={selected.evidence} headingId="inspector-title" context={selected.context} onContextChange={setContext} quote={selected.quote} inSheet />
        </Sheet>
      )}
    </Shell>
  );
}

const META = "flex flex-wrap items-center gap-2 text-sm text-muted";

function IndexFacts({ summary }: { summary: RepoSummary }) {
  const languages = Object.entries(summary.languages).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <p data-repo-meta className={META}>
        <span>
          {summary.files} files and {summary.symbols} symbols indexed
        </span>
        {languages.map(([name, count]) => (
          <Tag key={name}>
            {name} {count}
          </Tag>
        ))}
      </p>
      {summary.entryPoints.length > 0 && (
        <p className={META}>
          <span>Declared entry points:</span>
          {summary.entryPoints.map((e) => (
            <Tag key={`${e.package}:${e.kind}:${e.path}`}>
              {e.path} ({e.kind})
            </Tag>
          ))}
        </p>
      )}
    </>
  );
}

function StatusError({ failure, context, onRetry }: { failure: ApiFailure; context: FailureContext; onRetry: () => void }) {
  const view = describeFailure(failure, context);
  return (
    <Notice
      tone="danger"
      role="alert"
      className="max-w-[44rem]"
      title={view.title}
      actions={
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      <span>{view.detail}</span>
    </Notice>
  );
}

function AskForm({ busy, onAsk }: { busy: boolean; onAsk: (question: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const over = text.length > MAX_QUESTION;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    const question = text.trim();
    if (question === "") return setError("Type a question first.");
    if (over) return setError(`Questions are limited to ${MAX_QUESTION} characters.`);
    setError(null);
    setText("");
    onAsk(question);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  }

  return (
    <form data-ask onSubmit={submit} noValidate className="grid gap-3 rounded-md border border-line bg-surface p-4 sm:p-6">
      <div className="grid gap-2">
        <label htmlFor="question" className={fieldLabelClass}>
          Ask about this repository
        </label>
        <textarea
          id="question"
          className={textareaClass}
          rows={2}
          value={text}
          placeholder="For example: where are request timeouts applied?"
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          aria-invalid={error || over ? true : undefined}
          aria-describedby="question-hint question-error"
        />
        <p id="question-error" role="alert" className={fieldErrorClass}>
          {error}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="question-hint" className={fieldHintClass}>
          Answered only from the code at this commit. Each question stands alone. Up to {MAX_QUESTION} characters. Press Enter to ask, Shift+Enter for a new line.
        </p>
        <span aria-hidden="true" data-over={over} className="font-mono text-xs text-muted data-[over=true]:font-semibold data-[over=true]:text-danger">
          {text.length}/{MAX_QUESTION}
        </span>
        <Button variant="primary" type="submit" disabled={busy} className="max-sm:w-full">
          {busy ? "Working…" : "Ask"}
        </Button>
      </div>
    </form>
  );
}
