import { PageSection, Shell } from "../ui/primitives";
import { RecentRepos } from "../ui/RecentRepos";
import { RepoForm } from "../ui/RepoForm";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Index one commit",
    body: "The repository is downloaded at its latest commit and its JavaScript, TypeScript and Markdown files are parsed into a search index. The index stores terms and locations, not your source.",
  },
  {
    title: "Retrieve evidence",
    body: "Your question is matched against the index. The best-matching spans are re-read from GitHub at that exact commit and compared with what was indexed before they are used.",
  },
  {
    title: "Answer with checked citations",
    body: "A language model is shown only those spans. Each claim must cite one and quote it, and the quote is checked to appear in the cited lines. That check cannot tell whether the lines support the claim, so read them. An answer that fails a check is withheld, not shown.",
  },
];

const LIMITS: { term: string; detail: string }[] = [
  {
    term: "Judge its own answers",
    detail: "A citation is checked to point at real lines, and quoted text is checked to appear in them. Whether those lines truly support the claim is not checked. Read them.",
  },
  { term: "Read every file", detail: "Only JavaScript, TypeScript and Markdown are indexed. Vendored, generated, minified and binary files are skipped, and so are very large repositories." },
  { term: "Private repositories", detail: "Public GitHub repositories only. There are no accounts and nothing to sign in to." },
  { term: "Remember a conversation", detail: "Each question is answered on its own from the code. Earlier questions are not sent along with it." },
  {
    term: "Follow instructions in code",
    detail:
      "Repository content is given to the model as data, with a standing rule not to follow it, and text that reads like an instruction to an AI is flagged. That defence has not been proven against a determined attacker, so treat an answer about an untrusted repository with care.",
  },
];

export default function Home() {
  return (
    <Shell>
      <section aria-labelledby="hero-title" className="grid max-w-[44rem] gap-6 pt-12 pb-10 sm:pt-18 sm:pb-12">
        <h1 id="hero-title" className="text-display leading-[1.08] font-semibold tracking-[-0.025em] text-balance">
          Ask a repository. Check the answer against its code.
        </h1>
        <p className="max-w-[38rem] text-lg text-ink-soft">
          Point it at a public GitHub repository and ask how something works. Every claim in the answer links to the lines it cites, at a pinned commit. When the code does not
          settle the question, it is built to say so rather than guess.
        </p>
        <RepoForm />
      </section>

      <RecentRepos />

      <PageSection id="how-it-works" title="How it works">
        <ol className="grid gap-6 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="grid content-start gap-2 border-t-2 border-ink pt-3">
              <span aria-hidden="true" className="font-mono text-xs text-muted">
                0{i + 1}
              </span>
              <h3 className="font-semibold">{step.title}</h3>
              <p className="text-sm text-ink-soft">{step.body}</p>
            </li>
          ))}
        </ol>
      </PageSection>

      <PageSection id="limits" title="What it does not do">
        <dl className="grid max-w-[52rem] gap-x-6 text-sm md:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)] md:gap-y-3">
          {LIMITS.map((item) => (
            <div key={item.term} className="contents">
              <dt className="font-semibold">{item.term}</dt>
              <dd className="mb-3 text-ink-soft md:mb-0">{item.detail}</dd>
            </div>
          ))}
        </dl>
      </PageSection>
    </Shell>
  );
}
