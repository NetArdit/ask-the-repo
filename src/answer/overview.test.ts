import { describe, expect, it } from "vitest";
import { answerQuestion } from "./answer";
import { isOverviewQuestion, overviewCandidates, structureNote } from "./overview";
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
