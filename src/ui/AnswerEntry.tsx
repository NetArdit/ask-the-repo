"use client";

import type { ReactNode } from "react";
import type { CitedEvidence } from "../answer/answer";
import { describeAnswer, describeFailure, isShortQuote, type AnswerTone, type AnswerView, type ViewClaim } from "./answer-view";
import { Button, Eyebrow, Notice, Spinner, Tag, citeBrokenClass, citeClass, cx } from "./primitives";
import type { ThreadEntry } from "./store";

interface Props {
  entry: ThreadEntry;
  /** Id of the evidence item of this entry that the inspector is showing, if any. */
  selectedEvidenceId: string | null;
  /** `quote` is given when the inspector is opened from a claim's own piece of evidence, so it can point at the quoted lines. */
  onInspect(evidence: CitedEvidence, trigger: HTMLElement, quote?: string): void;
  onRetry(): void;
  /** A question is already being answered; another cannot start until it finishes. */
  busy: boolean;
}

type CardTone = AnswerTone | "pending" | "failure";

/** The top edge of a card says how it ended before a word is read: green answered, red withheld or failed, amber unavailable. */
const CARD_EDGE: Record<CardTone, string> = {
  answered: "border-t-ok",
  insufficient: "border-t-line-strong",
  withheld: "border-t-danger",
  failure: "border-t-danger",
  unavailable: "border-t-mark-edge",
  pending: "border-t-line-strong",
};

const DETAIL = "max-w-[44rem] text-ink-soft";

function Card({ tone, headingId, busy, question, children }: { tone: CardTone; headingId: string; busy?: boolean; question: string; children: ReactNode }) {
  return (
    <article data-entry={tone} aria-labelledby={headingId} aria-busy={busy || undefined} className={cx("grid min-w-0 gap-4 rounded-md border border-t-[3px] border-line bg-surface p-4 sm:p-6", CARD_EDGE[tone])}>
      <div>
        <Eyebrow>Question</Eyebrow>
        <h3 id={headingId} className="text-lg leading-snug font-semibold wrap-anywhere">
          {question}
        </h3>
      </div>
      {children}
    </article>
  );
}

export function AnswerEntry({ entry, selectedEvidenceId, onInspect, onRetry, busy }: Props) {
  const headingId = `q-${entry.id}`;
  const { outcome } = entry;

  if (outcome.kind === "pending") {
    return (
      <Card tone="pending" headingId={headingId} question={entry.question} busy>
        <p data-status className="flex items-center gap-3 font-semibold">
          <Spinner />
          Retrieving evidence, then asking the model…
        </p>
      </Card>
    );
  }

  if (outcome.kind === "failure") {
    const view = describeFailure(outcome.failure, "answer");
    return (
      <Card tone="failure" headingId={headingId} question={entry.question}>
        <Notice
          tone="danger"
          title={view.title}
          actions={
            view.canRetry && (
              <Button size="sm" onClick={onRetry} disabled={busy}>
                Ask again
              </Button>
            )
          }
        >
          <span>{view.detail}</span>
        </Notice>
      </Card>
    );
  }

  const view = describeAnswer(outcome.result, typeof outcome.retryAt === "number" ? outcome.retryAt : undefined);

  // One piece of evidence: the id, pressable to read its lines, and beside it the passage the model quoted from it.
  const citation = (c: ViewClaim["citations"][number], i: number) => (
    <li key={`${c.id}-${i}`} data-evidence-entry className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2">
      {c.evidence ? (
        <button
          type="button"
          data-cite
          className={citeClass}
          aria-pressed={selectedEvidenceId === c.id}
          aria-label={`Evidence ${c.id}: ${c.evidence.path}, lines ${c.evidence.startLine} to ${c.evidence.endLine}. Show source.`}
          onClick={(e) => onInspect(c.evidence!, e.currentTarget, c.quoteVerbatim ? c.quote : undefined)}
        >
          {c.id}
        </button>
      ) : (
        <span data-cite-broken className={citeBrokenClass} title="This id was not among the evidence provided.">
          {c.id}
        </span>
      )}
      {c.quote !== "" && (
        <p className="min-w-0 pt-1 text-sm">
          <span className="sr-only">{c.quoteVerbatim ? "Quoted from it: " : "Quote not found in it: "}</span>
          <q data-quote data-found={c.quoteVerbatim} className="line-clamp-3 font-mono text-code wrap-anywhere text-ink-soft data-[found=false]:text-danger data-[found=false]:line-through">
            {c.quote}
          </q>
          {c.quoteTrimmed && (
            <span data-quote-trimmed className="ml-2 text-xs text-muted">
              Shortened here; the whole quote was checked against the cited lines.
            </span>
          )}
          {c.quoteVerbatim && isShortQuote(c.quote) && (
            <span data-short-quote className="ml-2 text-xs text-muted">
              Short quote: it would match many places, so it says little about this claim.
            </span>
          )}
        </p>
      )}
    </li>
  );

  const claimList = (claims: ViewClaim[]) => (
    <ol className="grid gap-4">
      {claims.map((c, i) => (
        <li key={i} data-claim className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
          <span aria-hidden="true" className="min-w-5 pt-0.5 font-mono text-sm text-muted">
            {i + 1}
          </span>
          <div className="grid gap-1">
            <p className="wrap-anywhere">{c.text}</p>
            {c.citations.length > 0 && <ul className="mt-1 grid gap-2">{c.citations.map(citation)}</ul>}
            <p data-check data-passed={c.passed} className="text-sm text-muted data-[passed=false]:font-medium data-[passed=false]:text-danger">
              {c.check}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );

  return (
    <Card tone={view.tone} headingId={headingId} question={entry.question}>
      <p data-status className="font-semibold">
        {view.title}
      </p>
      {view.detail && (
        <p data-detail className={DETAIL}>
          {view.detail}
        </p>
      )}

      {view.tone === "answered" && claimList(view.claims)}

      {view.missing && (
        <p data-detail className={DETAIL}>
          <strong className="font-semibold text-ink">What is missing: </strong>
          {view.missing}
        </p>
      )}

      {view.facts.length > 0 && (
        // What the application read from its own index. Set apart from the claims: the model did not say it and no quote backs it.
        <div data-index-facts className="grid max-w-[44rem] gap-1 rounded-sm border border-line bg-sunk px-4 py-3 text-sm">
          <p className="font-semibold">From the index, not from the model</p>
          <ul className="grid gap-1">
            {view.facts.map((f) => (
              <li key={f} className="wrap-anywhere">
                {f}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Read by this application from its index of the commit, not checked against a quote. The index can miss an import or an entry it could not resolve.</p>
        </div>
      )}

      {view.warnings.length > 0 && (
        <Notice tone="warn" title="Read the evidence before relying on this">
          <ul className="grid list-disc gap-1 pl-5">
            {view.warnings.map((w) => (
              <li key={w}>{w.charAt(0).toUpperCase() + w.slice(1)}.</li>
            ))}
          </ul>
        </Notice>
      )}

      {view.tone === "withheld" && (
        <>
          {view.reasons.length > 0 && (
            <ul data-reasons className="grid list-disc gap-1 pl-5 text-sm">
              {view.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {view.claims.length > 0 && (
            <Disclosure summary="Show the withheld reply" name="withheld">
              <p className={cx(DETAIL, "mb-3")}>This is what the model wrote. It failed the checks marked below, so do not treat it as an answer.</p>
              {claimList(view.claims)}
            </Disclosure>
          )}
        </>
      )}

      {view.tone === "answered" && (
        <p data-scope className="max-w-[44rem] border-t border-dashed border-line-strong pt-3 text-sm text-ink-soft">
          <strong className="font-semibold text-ink">Checked:</strong> every citation points to lines that exist at this commit, and each quote appears word for word in the lines it cites.{" "}
          <strong className="font-semibold text-ink">Not checked:</strong> whether those lines support the claim. Open a citation and read them.
        </p>
      )}

      <EvidenceList view={view} selectedEvidenceId={selectedEvidenceId} onInspect={onInspect} />

      {view.canRetry && (
        <div>
          <Button size="sm" onClick={onRetry} disabled={busy}>
            Ask again
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Native disclosure: it works without script, is keyboard operable, and announces its own state. */
function Disclosure({ summary, name, open, children }: { summary: ReactNode; name: string; open?: boolean; children: ReactNode }) {
  return (
    <details data-disclosure={name} open={open} className="group">
      <summary className="w-fit cursor-pointer py-2 text-sm font-semibold group-open:mb-3">{summary}</summary>
      {children}
    </details>
  );
}

function EvidenceList({ view, selectedEvidenceId, onInspect }: { view: AnswerView; selectedEvidenceId: string | null; onInspect: Props["onInspect"] }) {
  if (view.evidence.length === 0) return null;
  const cited = new Set(view.citedIds);
  const label = view.tone === "unavailable" ? "Evidence retrieved" : "Evidence given to the model";
  return (
    // Open only when the evidence is all there is to show; otherwise it is one press away and the page stays short.
    <Disclosure name="evidence" open={view.tone === "unavailable"} summary={`${label} (${view.evidence.length})`}>
      <ul className="grid gap-1">
        {view.evidence.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              data-evidence-row
              aria-pressed={selectedEvidenceId === e.id}
              aria-label={`Evidence ${e.id}: ${e.path}, lines ${e.startLine} to ${e.endLine}${cited.has(e.id) ? ", cited in the answer" : ""}. Show source.`}
              onClick={(ev) => onInspect(e, ev.currentTarget)}
              className="grid min-h-11 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-sm border border-transparent px-2 py-1 text-left text-sm hover:border-line-strong aria-pressed:border-mark-edge aria-pressed:bg-mark sm:min-h-9"
            >
              <span className="min-w-8 font-mono font-semibold">{e.id}</span>
              <span className="font-mono wrap-anywhere">{e.path}</span>
              <span className="flex items-center gap-2 font-mono text-xs whitespace-nowrap text-muted">
                {cited.has(e.id) && <Tag>cited</Tag>}
                {e.injectionSuspect && <Tag>instruction-like</Tag>}
                L{e.startLine}–{e.endLine}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
