"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { describeFailure, type FailureView } from "./answer-view";
import { ingestRepository } from "./api";
import { Button, Notice, Spinner, fieldErrorClass, fieldHintClass, fieldLabelClass, inputClass } from "./primitives";
import { parseRepoInput } from "./repo-input";
import { rememberRepo } from "./store";

const EXAMPLES = ["sindresorhus/ky", "pmndrs/zustand", "honojs/hono"];

type Phase = { name: "idle" } | { name: "working"; label: string; startedAt: number } | { name: "failed"; view: FailureView };

export function RepoForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [elapsed, setElapsed] = useState(0);

  const working = phase.name === "working";
  const startedAt = working ? phase.startedAt : null;

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // When indexing stops without leaving the page (cancelled or failed), put focus back in the field. It has to happen after
  // the render that re-enables the field: a disabled field cannot take focus, and cancelling removes the button that had it,
  // which would otherwise leave a keyboard user with focus nowhere.
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) inputRef.current?.focus();
    wasWorking.current = working;
  }, [working]);

  const preview = value.trim() === "" ? null : parseRepoInput(value);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    const parsed = parseRepoInput(value);
    if (!parsed.ok) {
      setError(parsed.message);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setElapsed(0);
    const label = `${parsed.owner}/${parsed.repo}`;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ name: "working", label, startedAt: Date.now() });
    const res = await ingestRepository(label, null, controller.signal);
    if (res.ok) {
      rememberRepo({ owner: parsed.owner, repo: parsed.repo, sha: res.data.sha, files: res.data.files }, Date.now());
      router.push(`/r/${parsed.owner}/${parsed.repo}/${res.data.sha}`);
      return;
    }
    setPhase(res.kind === "aborted" ? { name: "idle" } : { name: "failed", view: describeFailure(res, "ingest") });
  }

  return (
    <form onSubmit={submit} noValidate className="grid max-w-[40rem] gap-3">
      <div className="grid gap-2">
        <label htmlFor="repo-input" className={fieldLabelClass}>
          Public GitHub repository
        </label>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <input
            ref={inputRef}
            id="repo-input"
            className={inputClass}
            name="repo"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="owner/name or a github.com link"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
              // A failure belongs to what was submitted; once the field changes it no longer describes what is in it.
              if (phase.name === "failed") setPhase({ name: "idle" });
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby="repo-hint repo-error"
            disabled={working}
          />
          <Button variant="primary" type="submit" disabled={working}>
            {working ? "Indexing…" : "Index repository"}
          </Button>
        </div>
        <p id="repo-error" role="alert" className={fieldErrorClass}>
          {error}
        </p>
        <p id="repo-hint" className={fieldHintClass}>
          {preview?.ok ? (
            <>
              Will index <span className="font-mono">{`${preview.owner}/${preview.repo}`}</span> at the latest commit of its default branch.{preview.note ? ` ${preview.note}` : ""}
            </>
          ) : (
            "Indexes the default branch at its latest commit. JavaScript, TypeScript and Markdown files are read."
          )}
        </p>
      </div>

      {phase.name === "idle" && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>Try</span>
          {EXAMPLES.map((name) => (
            <Button
              key={name}
              size="sm"
              className="font-mono"
              onClick={() => {
                setValue(name);
                setError(null);
                inputRef.current?.focus();
              }}
            >
              {name}
            </Button>
          ))}
        </div>
      )}

      {/* Spoken once when indexing starts. The box below is not a live region: its seconds counter changes every second, and a
          screen reader would otherwise read it out for as long as indexing runs. */}
      <p data-announce role="status" className="sr-only">
        {phase.name === "working" ? `Indexing ${phase.label}. Large repositories can take a minute or two.` : ""}
      </p>
      {phase.name === "working" && (
        <div data-progress className="grid gap-2 rounded-md border border-line bg-surface p-4">
          <p className="flex items-center gap-3 font-medium">
            <Spinner />
            <span>
              Indexing <span className="font-mono">{phase.label}</span>
            </span>
            <span data-elapsed className="ml-auto font-mono text-sm font-normal text-muted">
              {elapsed} s<span className="sr-only"> elapsed</span>
            </span>
          </p>
          <p className={fieldHintClass}>Finding the latest commit, downloading the repository and parsing its files. Small repositories take a few seconds; large ones can take a minute or two.</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button size="sm" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
            <span data-cancel-note className={fieldHintClass}>
              Cancelling stops waiting here. The server may still finish indexing.
            </span>
          </div>
        </div>
      )}

      {phase.name === "failed" && (
        <Notice
          tone="danger"
          role="alert"
          title={phase.view.title}
          actions={
            phase.view.canRetry && (
              <Button size="sm" type="submit">
                Try again
              </Button>
            )
          }
        >
          <span>{phase.view.detail}</span>
        </Notice>
      )}
    </form>
  );
}
