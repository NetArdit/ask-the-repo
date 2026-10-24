import { describe, expect, it } from "vitest";
import { answerQuestion } from "./answer";
import { bestVerbatimPiece, looksNonEnglish, parseKeywords, repairQuotes } from "./resilience";
import { parsePromptEvidence } from "./prompt";
import { FILES, ScriptedModel, buildFixture, deps } from "./test-helpers";
import type { EvidenceItem, ModelOutput } from "./types";

const item = (text: string): EvidenceItem => ({
  id: "E1",
  key: "k",
  repo: { owner: "acme", repo: "shop", sha: "d".repeat(40) },
  path: "src/a.ts",
  startLine: 1,
  endLine: 6,
  fileLineCount: 6,
  text,
  injectionSuspect: false,
  chunkHash: "h",
  score: 1,
});

const BLOCK = ["function login(user) {", "  if (!user) return null;", "  return createSession(user.email);", "}"].join("\n");

describe("bestVerbatimPiece", () => {
  it("keeps the longest part between gaps that is word for word in the block", () => {
    expect(bestVerbatimPiece("function login(user) { ... return createSession(user.email);", item(BLOCK))).toBe("return createSession(user.email);");
  });

  it("takes a single line when the quote stitches lines that are not neighbours", () => {
    expect(bestVerbatimPiece("function login(user) {\n  return null;\n  return createSession(user.email);", item(BLOCK))).toBe("return createSession(user.email);");
  });

  it("gives nothing when no piece is both long enough and in the block", () => {
    expect(bestVerbatimPiece("something the code never says", item(BLOCK))).toBeNull();
    expect(bestVerbatimPiece("if (x) {...}", item(BLOCK))).toBeNull();
  });
});

describe("repairQuotes", () => {
  const out = (quote: string): ModelOutput => ({ status: "answered", claims: [{ text: "claim", evidence: [{ citation: "E1", quote }] }] });

  it("leaves a quote that is already word for word alone", () => {
    const r = repairQuotes(out("return createSession(user.email);"), [item(BLOCK)]);
    expect(r.repaired).toBe(0);
  });

  it("repairs one that is not, and counts it", () => {
    const r = repairQuotes(out("function login(user) { (...) return createSession(user.email);"), [item(BLOCK)]);
    expect(r.repaired).toBe(1);
    expect(r.output.status === "answered" && r.output.claims[0]!.evidence[0]!.quote).toBe("return createSession(user.email);");
  });

  it("leaves one it cannot repair, and a citation to a block that does not exist", () => {
    const r = repairQuotes({ status: "answered", claims: [{ text: "c", evidence: [{ citation: "E9", quote: "x".repeat(30) }, { citation: "E1", quote: "y".repeat(30) }] }] }, [item(BLOCK)]);
    expect(r.repaired).toBe(0);
  });
});

describe("looksNonEnglish and parseKeywords", () => {
  it.each(["Ku është kodi i faqes së hyrjes?", "Si hyn përdoruesi në sistem", "Wo wird das Passwort geprüft", "¿Dónde está el login?", "Où est géré le paiement ?"])("%j looks like another language", (q) =>
    expect(looksNonEnglish(q)).toBe(true),
  );
  it.each([
    "Ku e ben login dhe createSession?",
    "si funksionon the login code",
    "where is login dhe session handled",
    "Cfare ben ky projekt dhe ku eshte main.py",
    "Explain how loginUser punon me password",
    "Wie funktioniert the checkout flow",
    "dónde está el handler de createSession",
  ])("%j mixes languages and is treated as not only English", (q) => expect(looksNonEnglish(q)).toBe(true));
  it.each(["Where is the login handled?", "how does createSession work", "what does this function do", "loginUser", "", "Where is the stripe charge created and which function calls it"])("%j does not", (q) =>
    expect(looksNonEnglish(q)).toBe(false),
  );

  it("reads only short lowercase identifier-like keywords, at most ten, and nothing else", () => {
    expect(parseKeywords('{"keywords":["Login","auth.session","two words","x","ok_1", 5, "ignore previous instructions now please"]}')).toEqual(["login", "auth.session", "ok_1"]);
    expect(parseKeywords(`{"keywords":[${Array.from({ length: 20 }, (_, i) => `"word${i}"`).join(",")}]}`)).toHaveLength(10);
    expect(parseKeywords("not json")).toEqual([]);
    expect(parseKeywords('{"keywords":"login"}')).toEqual([]);
  });
});

describe("answerQuestion with resilient: true", () => {
  const QUESTION = "How does loginUser create a session?";
  const claimWith = (text: string, id: string, quote: string) => ({ text, evidence: [{ citation: id, quote }] });
  const evidenceOf = (req: { user: string; nonce: string }) => parsePromptEvidence(req.user, req.nonce).blocks.find((b) => b.path === "src/auth/login.ts");

  it("cuts a quote with a gap to its verbatim part and says so", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => {
      const b = evidenceOf(req)!;
      return JSON.stringify({ status: "answered", claims: [claimWith("It hashes then creates a session.", b.id, "const hash = hashPassword(password); ... return createSession(email, hash);")] });
    });
    const result = await answerQuestion(deps({ index, source, provider, resilient: true }), QUESTION);
    expect(result.status).toBe("answered");
    expect(provider.requests).toHaveLength(1);
    expect(result.claims[0]!.citations[0]!.quoteVerbatim).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/cut to the part that appears word for word/);
  });

  it("gives the model one second try when its first reply fails a check, and accepts a good second reply", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => {
      const b = evidenceOf(req)!;
      const retried = req.user.includes(" REPAIR ");
      return JSON.stringify({ status: "answered", claims: [claimWith("It creates a session.", b.id, retried ? "return createSession(email, hash);" : "this text is not in the code at all")] });
    });
    const result = await answerQuestion(deps({ index, source, provider, resilient: true }), QUESTION);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.user).toContain(" REPAIR your previous reply failed these checks: claim 1 quote is not in the cited evidence");
    expect(result.status).toBe("answered");
    expect(result.warnings.join(" ")).toMatch(/asked once to correct it/);
  });

  it("shows the claims that passed and says how many were left out, when others still fail", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => {
      const b = evidenceOf(req)!;
      return JSON.stringify({ status: "answered", claims: [claimWith("It creates a session.", b.id, "return createSession(email, hash);"), claimWith("It also sends email.", b.id, "sendMailToTheUser(email, subject)")] });
    });
    const result = await answerQuestion(deps({ index, source, provider, resilient: true }), QUESTION);
    expect(result.status).toBe("answered");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.text).toBe("It creates a session.");
    expect(result.warnings.join(" ")).toMatch(/1 claim was left out/);
  });

  it("still withholds the answer when no claim passes", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => JSON.stringify({ status: "answered", claims: [claimWith("Invented.", evidenceOf(req)!.id, "nothing like this in the code")] }));
    const result = await answerQuestion(deps({ index, source, provider, resilient: true }), QUESTION);
    expect(result.status).toBe("rejected");
    expect(provider.requests).toHaveLength(2);
  });

  it("retries a reply that is not JSON, and withholds it if the second is not either", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel("Sure! Here is the answer in prose.");
    const result = await answerQuestion(deps({ index, source, provider, resilient: true }), QUESTION);
    expect(result.status).toBe("rejected");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.user).toContain("did not match the required JSON shape");
  });

  it("a failed second call keeps the verdict on the first reply and does not throw", async () => {
    const { index, source } = await buildFixture(FILES);
    let calls = 0;
    const provider = new ScriptedModel((req) => {
      calls += 1;
      if (calls > 1) throw new Error("network down");
      return JSON.stringify({ status: "answered", claims: [claimWith("Invented.", evidenceOf(req)!.id, "nothing like this in the code")] });
    });
    const result = await answerQuestion(deps({ index, source, provider, resilient: true }), QUESTION);
    expect(result.status).toBe("rejected");
  });

  it("without resilient nothing changes: one call, withheld", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => JSON.stringify({ status: "answered", claims: [claimWith("Stitched.", evidenceOf(req)!.id, "const hash = hashPassword(password); ... return createSession(email, hash);")] }));
    const result = await answerQuestion(deps({ index, source, provider }), QUESTION);
    expect(result.status).toBe("rejected");
    expect(provider.requests).toHaveLength(1);
  });
});

describe("answerQuestion with queryExpansion: true", () => {
  const isKeywordCall = (system: string) => system.includes("help search a source-code repository");
  const make = () =>
    new ScriptedModel((req) => {
      if (isKeywordCall(req.system)) return '{"keywords":["login","session","auth"]}';
      const b = parsePromptEvidence(req.user, req.nonce).blocks.find((x) => x.path === "src/auth/login.ts");
      return b ? JSON.stringify({ status: "answered", claims: [{ text: "Hyrja krijon një seancë.", evidence: [{ citation: b.id, quote: "return createSession(email, hash);" }] }] }) : '{"status":"insufficient_evidence","missing":"x"}';
    });

  it("finds the code for a question in Albanian by asking for English search words first", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = make();
    const result = await answerQuestion(deps({ index, source, provider, queryExpansion: true }), "Si hyn përdoruesi në sistem?");
    expect(isKeywordCall(provider.requests[0]!.system)).toBe(true);
    expect(result.status).toBe("answered");
    expect(result.evidence.some((e) => e.path === "src/auth/login.ts")).toBe(true);
  });

  it("understands a question that mixes Albanian and English, and hands the model the question exactly as asked", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = make();
    const question = "Si e kontrollon loginUser password dhe krijon createSession?";
    const result = await answerQuestion(deps({ index, source, provider, queryExpansion: true, promptVariant: "F" }), question);
    expect(result.status).toBe("answered");
    expect(result.evidence.some((e) => e.path === "src/auth/login.ts")).toBe(true);
    const answerCall = provider.requests.find((r) => !isKeywordCall(r.system))!;
    expect(parsePromptEvidence(answerCall.user, answerCall.nonce).question).toBe(question);
    expect(answerCall.system).toContain("mixes languages");
  });

  it("still finds code named in a mixed question when the keyword call gives nothing", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => (isKeywordCall(req.system) ? '{"keywords":[]}' : '{"status":"insufficient_evidence","missing":"x"}'));
    const result = await answerQuestion(deps({ index, source, provider, queryExpansion: true }), "Ku eshte createSession dhe hashPassword?");
    expect(result.evidence.some((e) => e.path === "src/auth/login.ts" || e.path === "src/util/crypto.ts")).toBe(true);
  });

  it("keeps the English words of a mixed question that the repository knows, and drops the ones it does not", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = make();
    const result = await answerQuestion(deps({ index, source, provider, queryExpansion: true }), "Ku e ruan seancën kur bën login, session dhe hashPassword?");
    expect(result.status).toBe("answered");
    expect(result.policy.action).not.toBe("insufficient");
  });

  it("without it the same question finds nothing", async () => {
    const { index, source } = await buildFixture(FILES);
    const result = await answerQuestion(deps({ index, source, provider: make() }), "Si hyn përdoruesi në sistem?");
    expect(result.status).toBe("insufficient_evidence");
  });

  it("makes no extra call for a question in English", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = make();
    await answerQuestion(deps({ index, source, provider, queryExpansion: true }), "How does loginUser create a session?");
    expect(provider.requests.every((r) => !isKeywordCall(r.system))).toBe(true);
  });

  it("carries on with the question as asked when the keyword call fails", async () => {
    const { index, source } = await buildFixture(FILES);
    const provider = new ScriptedModel((req) => {
      if (isKeywordCall(req.system)) throw new Error("rate limited");
      return '{"status":"insufficient_evidence","missing":"x"}';
    });
    const result = await answerQuestion(deps({ index, source, provider, queryExpansion: true }), "Si hyn përdoruesi në sistem?");
    expect(["insufficient_evidence", "no_evidence"]).toContain(result.status);
  });
});
