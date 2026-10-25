import { describe, expect, it } from "vitest";
import { answerQuestion } from "./answer";
import { isOverviewQuestion, isWideOverviewQuestion, overviewCandidates, structureNote } from "./overview";
import { parsePromptEvidence, SYSTEM_PROMPTS } from "./prompt";
import { ScriptedModel, buildFixture, deps } from "./test-helpers";

const REPO_FILES: Record<string, string> = {
  "README.md": ["# Inventory Desk", "", "Warehouse staff record stock arrivals and shipments here.", "The nightly job emails low stock lists.", ""].join("\n"),
  "app.py": ["from flask import Flask", "", "app = Flask(__name__)", "", "@app.route('/stock')", "def stock():", "    return load_stock()", ""].join("\n"),
  "templates/index.html": ["<html>", "<body>", '<button id="export-btn">Export stock list</button>', "</body>", "</html>", ""].join("\n"),
  "requirements.txt": "flask==3.0\n",
};

describe("isOverviewQuestion", () => {
  it.each([
    "What does this project do?",
    "what is this repo",
    "Explain this project to me",
    "explain the architecture",
    "Give me an overview of the codebase",
    "How does this app work?",
    "what is the tech stack",
    "Çfarë bën ky projekt?",
    "për çfarë shërben ky repo",
    "shpjego projektin",
    "Si funksionon ky projekt?",
    "Was macht dieses Projekt?",
    "¿Qué hace este proyecto?",
    "Çfarë does this project do?",
    "çfarë bën this repo",
    "Shpjego this project",
    "Cfare ben ky app",
  ])("recognises %j", (q) => expect(isOverviewQuestion(q)).toBe(true));

  it.each(["Ku është kodi i faqes së hyrjes (login) dhe si funksionon?", "Ku është butoni export dhe si funksionon the export button?", "Where is the export button handled?", "what does loadStock return", "how does the AI button call the model", "who imports parse.ts", "", "   "])("leaves %j to retrieval", (q) =>
    expect(isOverviewQuestion(q)).toBe(false),
  );
});

interface RoutingItem { repo: string; question: string; expected_route: "normal" | "overview" }
// The routing cases (authored questions, no repository text): the same 32 as the project benchmark file, inlined so this test needs no data file.
const ROUTING: RoutingItem[] = [
  {
    "repo": "express",
    "question": "What is res.json?",
    "expected_route": "normal"
  },
  {
    "repo": "express",
    "question": "What does app.listen do?",
    "expected_route": "normal"
  },
  {
    "repo": "ky",
    "question": "How does retry work?",
    "expected_route": "normal"
  },
  {
    "repo": "zustand",
    "question": "What is setState?",
    "expected_route": "normal"
  },
  {
    "repo": "hono",
    "question": "What is HTTPException?",
    "expected_route": "normal"
  },
  {
    "repo": "itsdangerous",
    "question": "What does Signer.unsign do?",
    "expected_route": "normal"
  },
  {
    "repo": "httprouter",
    "question": "What is RedirectTrailingSlash?",
    "expected_route": "normal"
  },
  {
    "repo": "slugify",
    "question": "What is the separator option?",
    "expected_route": "normal"
  },
  {
    "repo": "mux",
    "question": "What is Router.Match?",
    "expected_route": "normal"
  },
  {
    "repo": "ms",
    "question": "What is parseStrict?",
    "expected_route": "normal"
  },
  {
    "repo": "express",
    "question": "What is the best framework to run tests?",
    "expected_route": "normal"
  },
  {
    "repo": "p-map",
    "question": "How do I use the concurrency option?",
    "expected_route": "normal"
  },
  {
    "repo": "ky",
    "question": "How do I run a request with a custom timeout?",
    "expected_route": "normal"
  },
  {
    "repo": "markupsafe",
    "question": "What is escape_silent?",
    "expected_route": "normal"
  },
  {
    "repo": "express",
    "question": "How do I test a route handler in isolation?",
    "expected_route": "normal"
  },
  {
    "repo": "zustand",
    "question": "What is a store?",
    "expected_route": "normal"
  },
  {
    "repo": "hono",
    "question": "What is the default response when no route matches?",
    "expected_route": "normal"
  },
  {
    "repo": "express",
    "question": "What is Router?",
    "expected_route": "normal"
  },
  {
    "repo": "express",
    "question": "What is Express?",
    "expected_route": "overview"
  },
  {
    "repo": "zustand",
    "question": "what is zustand",
    "expected_route": "overview"
  },
  {
    "repo": "zustand",
    "question": "What is zustand??",
    "expected_route": "overview"
  },
  {
    "repo": "hono",
    "question": "  What is hono  ",
    "expected_route": "overview"
  },
  {
    "repo": "ky",
    "question": "What’s ky?",
    "expected_route": "overview"
  },
  {
    "repo": "express",
    "question": "How do I install this library?",
    "expected_route": "overview"
  },
  {
    "repo": "express",
    "question": "How do I run the tests?",
    "expected_route": "overview"
  },
  {
    "repo": "express",
    "question": "How do I run the test suite?",
    "expected_route": "overview"
  },
  {
    "repo": "hono",
    "question": "What command runs the unit tests?",
    "expected_route": "overview"
  },
  {
    "repo": "express",
    "question": "Getting started",
    "expected_route": "overview"
  },
  {
    "repo": "zustand",
    "question": "Quick start guide?",
    "expected_route": "overview"
  },
  {
    "repo": "httprouter",
    "question": "How is it organized?",
    "expected_route": "overview"
  },
  {
    "repo": "slugify",
    "question": "How do I build the project?",
    "expected_route": "overview"
  },
  {
    "repo": "mux",
    "question": "How do I install mux?",
    "expected_route": "overview"
  }
];
const routeOn = (i: RoutingItem): string => (isOverviewQuestion(i.question) || isWideOverviewQuestion(i.question, i.repo) ? "overview" : "normal");
const routeOff = (i: RoutingItem): string => (isOverviewQuestion(i.question) ? "overview" : "normal");

describe("isWideOverviewQuestion", () => {
  it("reads 32 authored questions", () => expect(ROUTING).toHaveLength(32));

  it("flag ON: every authored question routes as expected", () => {
    const wrong = ROUTING.filter((i) => routeOn(i) !== i.expected_route).map((i) => `${i.repo}: ${i.question}`);
    expect(wrong).toEqual([]);
  });

  it("flag OFF: routing is isOverviewQuestion alone, so overview questions the old patterns miss stay normal", () => {
    const missed = ROUTING.filter((i) => i.expected_route === "overview" && !isOverviewQuestion(i.question));
    expect(missed.length).toBeGreaterThan(0);
    for (const i of missed) expect(routeOff(i)).toBe("normal");
    for (const i of ROUTING.filter((x) => x.expected_route === "normal")) expect(routeOff(i)).toBe("normal");
  });

  it.each([
    ["What is Express?", "express", true],
    ["WHAT IS EXPRESS", "express", true],
    ["what   is\t express ???", "express", true],
    ["What’s ky?", "ky", true],
    ["what's it", "ky", true],
    ["What is this?", "ky", true],
    ["How do I RUN the Tests?", "express", true],
    ["how can we set up the project", "express", true],
    ["How should I get started", "express", true],
    ["How do I install p-map?", "p-map", true],
    ["What command starts the tests?", "express", true],
    ["Quick start guide", "express", true],
    ["Installation.", "express", true],
    ["How is it structured?", "express", true],
    ["What is res.json?", "express", false],
    ["What is Router?", "express", false],
    ["What is `express`?", "express", false],
    ["What is express()?", "express", false],
    ["What is setState?", "zustand", false],
    ["What is parse_strict?", "ms", false],
    ["How do I use the concurrency option?", "p-map", false],
    ["How do I run the tests with --watch?", "express", false],
    ["How do I install express middleware?", "express", false],
    ["What is the separator option?", "slugify", false],
    ["", "express", false],
    ["   ", "express", false],
    ["?", "express", false],
  ])("%j in %s -> %s", (q, repo, expected) => expect(isWideOverviewQuestion(q, repo)).toBe(expected));

  it("handles a very long question in linear time", () => {
    for (const q of ["a".repeat(100000), "what is " + "express ".repeat(12500), " ".repeat(50000) + "What is express" + " ".repeat(50000), "how do i " + "run ".repeat(25000), "?".repeat(100000), "(".repeat(100000)]) {
      const t0 = performance.now();
      expect(isWideOverviewQuestion(q, "express")).toBe(false);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
});

describe("overviewCandidates and structureNote", () => {
  it("offers the README, the manifest and an entry file, in that order, without duplicates", async () => {
    const { index } = await buildFixture(REPO_FILES);
    const candidates = overviewCandidates(index, { maxBlocks: 6 });
    expect(candidates.map((c) => c.path)).toEqual(["README.md", "requirements.txt", "app.py", "templates/index.html"]);
    expect(new Set(candidates.map((c) => c.chunkId)).size).toBe(candidates.length);
  });

  it("never offers more than asked", async () => {
    const { index } = await buildFixture(REPO_FILES);
    expect(overviewCandidates(index, { maxBlocks: 2 })).toHaveLength(2);
  });

  it("maps the repository in one line", async () => {
    const { index } = await buildFixture(REPO_FILES);
    const note = structureNote(index);
    expect(note).toContain("4 indexed files");
    expect(note).toContain("templates (1)");
    expect(note).toContain("(root) (3)");
    expect(note).not.toContain("\n");
  });
});

describe("answering a question about the whole repository", () => {
  const scripted = () =>
    new ScriptedModel((req) => {
      const block = parsePromptEvidence(req.user, req.nonce).blocks.find((b) => b.path === "README.md");
      return block
        ? JSON.stringify({
            status: "answered",
            claims: [{ text: "Warehouse staff record stock arrivals and shipments.", evidence: [{ citation: block.id, quote: "Warehouse staff record stock arrivals and shipments here." }] }],
          })
        : '{"status":"insufficient_evidence","missing":"README not shown"}';
    });

  it("without the overview path the question is refused for low word coverage, as before", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    const provider = scripted();
    const result = await answerQuestion(deps({ index, source, provider }), "What does this project do?");
    expect(result.status).toBe("insufficient_evidence");
    expect(provider.requests).toHaveLength(0);
  });

  it("with the overview path it reads the README, tells the model the layout, and accepts a quoted claim", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    const provider = scripted();
    const result = await answerQuestion(deps({ index, source, provider, overview: { maxBlocks: 6 }, promptVariant: "F" }), "What does this project do?");
    expect(result.status).toBe("answered");
    expect(result.policy.reason).toBe("question about the whole repository");
    expect(result.evidence.map((e) => e.path)).toContain("README.md");
    const req = provider.requests[0]!;
    expect(req.system).toBe(SYSTEM_PROMPTS.F);
    expect(req.user).toContain(" INDEX overview of 4 indexed files");
  });

  it("an ordinary question is untouched by the overview path", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    const provider = scripted();
    const result = await answerQuestion(deps({ index, source, provider, overview: { maxBlocks: 6 } }), "Where is the export button handled?");
    expect(result.policy.reason).not.toBe("question about the whole repository");
    expect(provider.requests.every((r) => !r.user.includes(" INDEX overview of"))).toBe(true);
  });

  it("overviewWide true with the repository name takes the overview path", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    const result = await answerQuestion(deps({ index, source, provider: scripted(), overview: { maxBlocks: 6 }, overviewWide: true, promptVariant: "F" }), "What is shop?");
    expect(result.policy.reason).toBe("question about the whole repository");
    expect(result.evidence.map((e) => e.path)).toContain("README.md");
  });

  it("overviewWide undefined or false keeps a wide-only question on the normal path", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    for (const extra of [{}, { overviewWide: false }]) {
      const provider = scripted();
      const result = await answerQuestion(deps({ index, source, provider, overview: { maxBlocks: 6 }, promptVariant: "F", ...extra }), "What is shop?");
      expect(result.policy.reason).not.toBe("question about the whole repository");
      expect(provider.requests.every((r) => !r.user.includes(" INDEX overview of"))).toBe(true);
    }
  });

  it("overviewWide true without overview options changes nothing", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    const result = await answerQuestion(deps({ index, source, provider: scripted(), overviewWide: true }), "What is shop?");
    expect(result.policy.reason).not.toBe("question about the whole repository");
  });

  it("finds code in HTML by its words", async () => {
    const { index, source } = await buildFixture(REPO_FILES);
    const provider = new ScriptedModel((req) => {
      const block = parsePromptEvidence(req.user, req.nonce).blocks.find((b) => b.path === "templates/index.html");
      return block
        ? JSON.stringify({ status: "answered", claims: [{ text: "The export button is in index.html.", evidence: [{ citation: block.id, quote: '<button id="export-btn">Export stock list</button>' }] }] })
        : '{"status":"insufficient_evidence","missing":"x"}';
    });
    const result = await answerQuestion(deps({ index, source, provider, overview: { maxBlocks: 6 }, promptVariant: "F" }), "Where is the export button?");
    expect(result.status).toBe("answered");
    expect(result.evidence.some((e) => e.path === "templates/index.html")).toBe(true);
  });
});
