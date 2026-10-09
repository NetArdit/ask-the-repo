import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

/**
 * The interface's building blocks. Each one owns its Tailwind classes, so a screen composes these instead of repeating
 * utility strings, and a change of treatment happens in one place. They hold no state and run on the server or the client.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** The page's content column. */
export function Shell({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("mx-auto w-full max-w-[77.5rem] px-4 sm:px-6", className)} {...props} />;
}

type ButtonVariant = "default" | "primary" | "quiet";
type ButtonSize = "md" | "sm";

const BUTTON_BASE =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border font-medium leading-tight disabled:cursor-not-allowed disabled:border-line disabled:bg-sunk disabled:text-muted";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: "border-line-strong bg-surface text-ink hover:border-ink",
  // Ink on the page colour rather than a brand colour: the primary action is the strongest neutral, and colour stays for meaning.
  primary: "border-ink bg-ink text-bg hover:border-ink-soft hover:bg-ink-soft",
  quiet: "border-transparent bg-transparent text-ink underline underline-offset-[3px] hover:decoration-2",
};

/** 44px tall on small screens, where a finger is the pointer; 40px from `sm` up. Small buttons stay above the 24px minimum. */
const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "min-h-11 px-4 text-sm sm:min-h-10",
  sm: "min-h-8 px-3 text-xs",
};

/** For a link that should look like a button. */
export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "md", className?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className);
}

export function Button({ variant = "default", size = "md", className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

/** A small label above a block, saying what kind of thing follows. */
export function Eyebrow({ as: Tag = "p", className, ...props }: HTMLAttributes<HTMLElement> & { as?: "p" | "h2" }) {
  return <Tag className={cx("font-mono text-xs tracking-[0.08em] text-muted uppercase", className)} {...props} />;
}

export function Tag({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("inline-flex items-center rounded-sm border border-line bg-sunk px-2 py-px font-mono text-xs whitespace-nowrap text-ink-soft", className)} {...props} />;
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-md border border-line bg-surface p-4 sm:p-6", className)} {...props} />;
}

export type NoticeTone = "neutral" | "warn" | "danger";

const NOTICE_TONE: Record<NoticeTone, string> = {
  neutral: "border-l-line-strong bg-surface",
  warn: "border-l-mark-edge bg-warn-soft text-warn",
  danger: "border-l-danger bg-danger-soft text-danger",
};

/** A message set apart from the flow. Its left edge and tint say how serious it is; the words still have to say what happened. */
export function Notice({ tone = "neutral", title, children, actions, className, ...props }: Omit<HTMLAttributes<HTMLDivElement>, "title"> & { tone?: NoticeTone; title: ReactNode; actions?: ReactNode }) {
  return (
    <div data-notice={tone} className={cx("grid gap-1 rounded-sm border border-l-[3px] border-line px-4 py-3 text-sm", NOTICE_TONE[tone], className)} {...props}>
      <strong className="text-base font-semibold">{title}</strong>
      {children}
      {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Indeterminate progress. With reduced motion it stops turning and becomes a dotted ring, so it still reads as "working". */
export function Spinner() {
  return <span aria-hidden="true" className="size-4 flex-none animate-spin rounded-full border-2 border-line-strong border-t-ink motion-reduce:animate-none motion-reduce:border-dotted motion-reduce:border-t-line-strong" />;
}

/** A line of status with a spinner, announced to assistive technology. */
export function Working({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cx("flex items-center gap-3 font-medium", className)}>
      <Spinner />
      {children}
    </p>
  );
}

export const fieldLabelClass = "text-sm font-semibold";
export const fieldHintClass = "text-sm text-muted";
/** Empty until there is an error, and then it takes no space until it has something to say. */
export const fieldErrorClass = "text-sm font-medium text-danger empty:hidden";

const CONTROL = "w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-ink placeholder:text-muted aria-invalid:border-danger aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)]";
export const inputClass = cx(CONTROL, "min-h-11 font-mono text-[0.9375rem] sm:min-h-10 disabled:bg-sunk disabled:text-muted");
export const textareaClass = cx(CONTROL, "min-h-19 resize-y leading-snug");

/**
 * The product's central affordance: an evidence id that can be pressed to read the lines it names. Green because the citation
 * passed its check; it takes the evidence-mark colour while its source is open.
 */
export const citeClass =
  "inline-flex min-h-8 min-w-10 cursor-pointer items-center justify-center rounded-sm border border-ok bg-ok-soft px-2 font-mono text-xs font-semibold text-ink hover:bg-surface aria-pressed:border-mark-edge aria-pressed:bg-mark sm:min-h-7 sm:min-w-9";
export const citeBrokenClass = "inline-flex min-h-7 min-w-9 items-center justify-center rounded-sm border border-danger bg-danger-soft px-2 font-mono text-xs font-semibold text-ink line-through";

export const linkClass = "underline decoration-1 underline-offset-[3px] hover:decoration-2";

/** A titled band of a long page, separated from the one above by a rule. */
export function PageSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid gap-6 border-t border-line py-12">
      <h2 id={`${id}-title`} className="text-title font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** What to show where content will be, before there is any. */
export function EmptyState({ title, children, bare = false }: { title: string; children: ReactNode; bare?: boolean }) {
  return (
    <div data-empty className={cx("grid gap-2 p-6 text-sm text-ink-soft", !bare && "rounded-md border border-dashed border-line-strong")}>
      <strong className="text-base font-semibold text-ink">{title}</strong>
      {children}
    </div>
  );
}
