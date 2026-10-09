"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CitedEvidence } from "../answer/answer";
import { describeFailure } from "./answer-view";
import { fetchSource, rememberedSource, type ApiResult, type SourceExcerpt } from "./api";
import { Button, Eyebrow, Notice, buttonClass, linkClass } from "./primitives";
import { quotedLines } from "./quote-lines";
import { githubUrl } from "./store";

const CONTEXT_STEP = 20;
/** Matches the server's limit on lines per request. */
const MAX_LINES = 400;

interface Props {
  owner: string;
  repo: string;
  sha: string;
  evidence: CitedEvidence;
  headingId: string;
  /** How many extra lines to show around the cited span. Owned by the caller so it survives the inspector moving between the pane and the sheet. */
  context: SourceContext;
  onContextChange(next: SourceContext): void;
  /** The passage a claim quoted from this evidence, when the inspector was opened from that claim. Its lines are pointed out. */
  quote?: string;
  /** True when the inspector sits inside the modal sheet, which it can then dismiss. */
  inSheet?: boolean;
  /** Changes each time a citation is activated. In the side pane, focus then moves to the heading; the sheet manages its own focus. */
  focusRequest?: number;
  /** In the side pane, sends focus back to the citation or evidence row that opened the inspector. */
  onReturn?: () => void;
}

export interface SourceContext {
  before: number;
  after: number;
}

export const NO_CONTEXT: SourceContext = { before: 0, after: 0 };

/**
 * Shows the exact lines an evidence id refers to, read from the pinned commit. The cited span is marked; lines around it can
 * be pulled in for context. Give this component a `key` per evidence item. It can be unmounted and mounted again (it lives
 * in a side pane on wide screens and in a sheet on narrow ones) without losing its place: the context is the caller's state,
 * and lines already fetched are shown at once.
 */
export function SourceInspector({ owner, repo, sha, evidence, headingId, context, onContextChange, quote, inSheet, focusRequest, onReturn }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!inSheet) headingRef.current?.focus();
  }, [inSheet, focusRequest]);

  const start = Math.max(1, evidence.startLine - context.before);
  const end = evidence.endLine + context.after;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; result: ApiResult<SourceExcerpt> } | null>(null);
  const [shown, setShown] = useState<SourceExcerpt | null>(() => rememberedSource(`${owner}/${repo}`, sha, evidence.path, start, end));
  const requestKey = `${start}-${end}#${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    void fetchSource(`${owner}/${repo}`, sha, evidence.path, start, end, controller.signal).then((result) => {
      if (!result.ok && result.kind === "aborted") return;
      setLoaded({ key: requestKey, result });
      if (result.ok) setShown(result.data);
    });
    return () => controller.abort();
  }, [owner, repo, sha, evidence.path, start, end, requestKey]);

  const busy = loaded?.key !== requestKey;
  const failure = !busy && loaded && !loaded.result.ok ? describeFailure(loaded.result, "source") : null;
  const link = githubUrl(evidence.url);
  const span = end - start + 1;
  const canGrow = span + CONTEXT_STEP <= MAX_LINES && !busy;
  const atTop = start <= 1;
  const atBottom = shown !== null && shown.endLine >= shown.lineCount;

  return (
    <div data-inspector className="grid min-h-0">
      <div className="sticky top-0 z-1 grid gap-2 border-b border-line bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Eyebrow>Evidence {evidence.id}</Eyebrow>
            <h2 ref={headingRef} id={headingId} tabIndex={inSheet ? undefined : -1} className="font-mono text-sm font-semibold wrap-anywhere">
              {evidence.path}
            </h2>
          </div>
          {!inSheet && onReturn && (
            <Button size="sm" data-return onClick={onReturn}>
              Back to answer
            </Button>
          )}
          {inSheet && (
            // A dialog-method form closes the enclosing dialog natively, so the sheet's own close event does the rest.
            <form method="dialog">
              <Button size="sm" type="submit">
                Close
              </Button>
            </form>
          )}
        </div>
        <p data-inspector-meta className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <span>
            Lines {evidence.startLine}–{evidence.endLine}
          </span>
          <span className="font-mono">@ {sha.slice(0, 7)}</span>
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className={linkClass}>
              Open on GitHub<span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </p>
      </div>

      <div className="grid min-w-0 gap-3 p-4">
        {evidence.injectionSuspect && (
          <Notice tone="warn" title="This excerpt contains text that reads like instructions to an AI.">
            <span>It was passed to the model as data. Read the lines yourself before trusting a claim that cites them.</span>
          </Notice>
        )}

        {failure && (
          <Notice
            tone="danger"
            role="alert"
            title={failure.title}
            actions={
              <>
                {failure.canRetry && (
                  <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                )}
                {link && (
                  <a href={link} target="_blank" rel="noopener noreferrer" data-button className={buttonClass("default", "sm")}>
                    Read it on GitHub instead
                  </a>
                )}
              </>
            }
          >
            <span>{failure.detail}</span>
          </Notice>
        )}

        {shown === null && busy && (
          <div role="status" className="grid gap-2 rounded-sm border border-line bg-sunk p-4">
            <span className="sr-only">Loading source lines</span>
            {["w-[72%]", "w-[88%]", "w-[54%]", "w-[80%]", "w-[63%]", "w-[40%]"].map((w) => (
              <span key={w} aria-hidden="true" className={`h-3 rounded-xs bg-line ${w}`} />
            ))}
          </div>
        )}

        {shown !== null && (
          <>
            <div data-more className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={atTop || !canGrow} onClick={() => onContextChange({ ...context, before: context.before + CONTEXT_STEP })}>
                Show {CONTEXT_STEP} lines above
              </Button>
              <Button size="sm" disabled={atBottom || !canGrow} onClick={() => onContextChange({ ...context, after: context.after + CONTEXT_STEP })}>
                Show {CONTEXT_STEP} lines below
              </Button>
              <span role="status" className="text-sm text-muted">
                {busy ? "Loading more lines…" : ""}
              </span>
            </div>
            <CodeLines excerpt={shown} markFrom={evidence.startLine} markTo={evidence.endLine} quote={quote} />
            {shown.truncatedLines > 0 && <p className="text-sm text-muted">Very long lines are cut short here. The GitHub link shows them in full.</p>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A source listing: line numbers in a gutter that cannot be selected, the cited lines marked along their left edge, and,
 * within them, the lines a claim actually quoted picked out in the "check passed" colour.
 */
function CodeLines({ excerpt, markFrom, markTo, quote }: { excerpt: SourceExcerpt; markFrom: number; markTo: number; quote?: string }) {
  const quoted = quote ? quotedLines(excerpt.lines, excerpt.startLine, quote) : null;
  return (
    <pre
      data-code
      tabIndex={0}
      role="region"
      aria-label={`${excerpt.path}, lines ${excerpt.startLine} to ${excerpt.endLine}. Cited lines are ${markFrom} to ${markTo}.${quoted ? ` The quoted passage is on lines ${quoted.from} to ${quoted.to}.` : ""}`}
      className="overflow-x-auto rounded-sm border border-line bg-sunk py-2 font-mono text-code leading-[1.6] [tab-size:2]"
    >
      {excerpt.lines.map((text, i) => {
        const n = excerpt.startLine + i;
        const cited = n >= markFrom && n <= markTo;
        const isQuoted = quoted !== null && n >= quoted.from && n <= quoted.to;
        return (
          <span
            key={n}
            data-line
            data-cited={cited}
            data-quoted={isQuoted}
            className="group grid min-w-max grid-cols-[4.5ch_max-content] gap-3 border-l-[3px] border-transparent px-3 data-[cited=true]:border-mark-edge data-[cited=true]:bg-mark data-[quoted=true]:border-ok data-[quoted=true]:bg-ok-soft"
          >
            <span data-line-no aria-hidden="true" className="text-right text-muted select-none group-data-[cited=true]:text-ink group-data-[quoted=true]:font-semibold">
              {n}
            </span>
            <span className="whitespace-pre">{`${text}\n`}</span>
          </span>
        );
      })}
    </pre>
  );
}

/**
 * The inspector as a modal sheet. The browser's own dialog supplies the focus trap, Escape to close, and the inert page behind
 * it. `onClose` fires once, however it was dismissed: Escape, the backdrop, or a dialog-method form inside it.
 * It is a centred sheet on a tablet and takes the whole screen on a phone.
 */
export function Sheet({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      data-sheet
      aria-labelledby={labelledBy}
      onClose={() => {
        // In development React mounts, unmounts and mounts again. The unmount closes the dialog, and that close event arrives
        // after the dialog has been reopened; only a close that leaves the dialog closed is a real dismissal.
        if (!ref.current?.open) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      className="m-auto max-h-[calc(100dvh-3rem)] w-[min(46rem,calc(100vw-3rem))] overflow-auto rounded-md border border-line-strong bg-surface p-0 text-ink shadow-sheet backdrop:bg-scrim max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
    >
      {children}
    </dialog>
  );
}
