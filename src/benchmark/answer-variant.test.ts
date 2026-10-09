import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError, type ModelProvider, type ModelRequest } from "../answer/provider";
import { SYSTEM_PROMPTS, parsePromptVariant, type PromptVariant } from "../answer/prompt";
import { CACHE_ROOT } from "./cache";
import { V3_EVIDENCE, evidenceVersionFromArgs, runAnswers, tuningRunNames, variantFromArgs, type EvidenceVersion, type PolicyVariant } from "./answer-eval";

describe("prompt variant selection (no model is called)", () => {
  it("defaults to A and accepts exactly A, B, C, D or E", () => {
    expect(parsePromptVariant(undefined)).toBe("A");
    expect(parsePromptVariant("B")).toBe("B");
    expect(parsePromptVariant("C")).toBe("C");
    expect(parsePromptVariant("D")).toBe("D");
    expect(variantFromArgs(["tuning", "--variant=D"])).toBe("D");
    expect(parsePromptVariant("E")).toBe("E");
    expect(variantFromArgs([])).toBe("A");
    expect(variantFromArgs(["tuning", "0.3", "0.5"])).toBe("A");
    expect(variantFromArgs(["tuning", "--variant=B"])).toBe("B");
    expect(variantFromArgs(["--variant=C", "tuning"])).toBe("C");
  });

  it.each(["", "a", "d", "e", "F", "AB", " B", "B ", "A;B", "gsk_not_a_real_secret_but_secret_shaped"])("fails closed on %j without echoing the value", (raw) => {
    expect(() => parsePromptVariant(raw)).toThrow(/expected exactly A, B, C, D or E/);
    try {
      parsePromptVariant(raw);
    } catch (e) {
      if (raw.length > 3) expect(String(e)).not.toContain(raw);
    }
  });

  it("fails closed on a bare, unknown or repeated --variant flag", () => {
    expect(() => variantFromArgs(["--variant"])).toThrow();
    expect(() => variantFromArgs(["--variant="])).toThrow();
    expect(() => variantFromArgs(["--variant=X"])).toThrow();
    expect(() => variantFromArgs(["--variant=A", "--variant=B"])).toThrow(/more than once/);
  });
});

describe("tuning run names cannot mix variants", () => {
  const names = (v: PromptVariant, split: "tuning" | "holdout" = "tuning") => tuningRunNames(split, 0.3, 0.5, "openai/gpt-oss-120b", v);

  it("names every run by its variant and by the evidence contract it was validated under", () => {
    expect(names("A")).toEqual({
      variantName: "run-0.3-0.5-A-e3",
      checkpointName: "answer-tuning-0.3-0.5-openai_gpt-oss-120b-A-e3.jsonl",
      privateName: "answer-tuning-0.3-0.5-openai_gpt-oss-120b-A-e3.raw.jsonl",
    });
    expect(names("B").checkpointName).toBe("answer-tuning-0.3-0.5-openai_gpt-oss-120b-B-e3.jsonl");
    expect(names("C").variantName).toBe("run-0.3-0.5-C-e3");
  });

  it("can never write into the files of the runs recorded under contract 2", () => {
    // Every run made so far, on either evidence version, has "-e2" in its names. New runs are named by the current contract.
    const recorded = ["A", "B", "C", "D"].flatMap((v) => [`run-0.3-0.5-${v}-e2`, `answer-tuning-0.3-0.5-openai_gpt-oss-120b-${v}-e2.jsonl`, `answer-tuning-0.3-0.5-openai_gpt-oss-120b-${v}-e2.raw.jsonl`]);
    recorded.push("run-0.3-0.5-E-e2-v3", "answer-tuning-0.3-0.5-openai_gpt-oss-120b-E-e2-v3.jsonl", "answer-tuning-0.3-0.5-openai_gpt-oss-120b-E-e2-v3.raw.jsonl");
    for (const v of ["A", "B", "C", "D", "E"] as const) {
      for (const version of [2, 3] as const) {
        for (const split of ["tuning", "holdout"] as const) {
          for (const name of Object.values(tuningRunNames(split, 0.3, 0.5, "openai/gpt-oss-120b", v, version))) {
            expect(recorded, name).not.toContain(name);
            expect(name).not.toMatch(/-e2(?:[-.]|$)/);
          }
        }
      }
    }
  });

  it("can never write into the files of the runs made under the first contract", () => {
    const historical = [
      "answer-tuning-0.3-0.5-openai_gpt-oss-120b.jsonl",
      "answer-tuning-0.3-0.5-openai_gpt-oss-120b-B.jsonl",
      "answer-tuning-0.3-0.5-openai_gpt-oss-120b-C.jsonl",
      "run-0.3-0.5",
      "run-0.3-0.5-B",
      "run-0.3-0.5-C",
    ];
    for (const v of ["A", "B", "C", "D", "E"] as const) {
      const n = names(v);
      for (const name of [n.checkpointName, n.variantName, n.privateName]) expect(historical).not.toContain(name);
    }
  });

  it("gives every variant and split a distinct checkpoint and result name", () => {
    const all = (["A", "B", "C", "D"] as const).flatMap((v) => [names(v), names(v, "holdout")]);
    expect(new Set(all.map((n) => n.checkpointName)).size).toBe(all.length);
    expect(new Set(all.map((n) => n.variantName)).size).toBe(4); // variantName omits the split; the result file name adds it
  });

  it("names a run on version 3 evidence apart from every version 2 run, and leaves version 2 names as they were", () => {
    const VARIANTS = ["A", "B", "C", "D", "E"] as const;
    const v3 = (v: PromptVariant, split: "tuning" | "holdout" = "tuning") => tuningRunNames(split, 0.3, 0.5, "openai/gpt-oss-120b", v, 3);
    expect(v3("E")).toEqual({
      variantName: "run-0.3-0.5-E-e3-v3",
      checkpointName: "answer-tuning-0.3-0.5-openai_gpt-oss-120b-E-e3-v3.jsonl",
      privateName: "answer-tuning-0.3-0.5-openai_gpt-oss-120b-E-e3-v3.raw.jsonl",
    });
    // Asking for version 2 explicitly gives exactly the names the recorded runs have.
    for (const v of VARIANTS) expect(tuningRunNames("tuning", 0.3, 0.5, "openai/gpt-oss-120b", v, 2)).toEqual(names(v));
    const v2Names = new Set(VARIANTS.flatMap((v) => [names(v), names(v, "holdout")]).flatMap((n) => [n.variantName, n.checkpointName, n.privateName]));
    for (const v of VARIANTS) for (const split of ["tuning", "holdout"] as const) for (const name of Object.values(v3(v, split))) expect(v2Names.has(name), name).toBe(false);
  });
});

describe("evidence version selection (no model is called)", () => {
  it("defaults to version 2, accepts exactly --evidence=v2 or --evidence=v3, and fails closed on anything else", () => {
    expect(evidenceVersionFromArgs([])).toBe(2);
    expect(evidenceVersionFromArgs(["tuning", "0.3", "0.5", "--variant=E"])).toBe(2);
    expect(evidenceVersionFromArgs(["tuning", "--evidence=v2"])).toBe(2);
    expect(evidenceVersionFromArgs(["--evidence=v3", "tuning"])).toBe(3);
    for (const bad of [["--evidence"], ["--evidence="], ["--evidence=3"], ["--evidence=V3"], ["--evidence=v4"], ["--evidence=v3 "]]) expect(() => evidenceVersionFromArgs(bad), bad[0]).toThrow(/expected exactly/);
    expect(() => evidenceVersionFromArgs(["--evidence=v3", "--evidence=v2"])).toThrow(/more than once/);
  });

  it("version 3 evidence is changes 2 and 3 only, with their block limits", () => {
    expect(V3_EVIDENCE).toEqual({ importerEvidence: { maxBlocks: 4 }, entryEvidence: { maxBlocks: 2 } });
    expect(V3_EVIDENCE).not.toHaveProperty("definitionEvidence");
  });
});

// Uses the real tuning split and the locally cached indexes; a stub provider stands in for the model and the first call halts the run.
const HAVE_CACHE = existsSync(path.join(CACHE_ROOT, "index")) && existsSync(path.join(CACHE_ROOT, "tarballs"));
const POLICY: PolicyVariant = { name: "variant-test", policy: { insufficientBelow: 0, cautionBelow: 0 }, captionDeclines: false };

async function firstRequest(promptVariant?: PromptVariant): Promise<{ request: ModelRequest; promptVariant: PromptVariant | undefined; tmpFiles: string[] }> {
  let captured: ModelRequest | undefined;
  const provider: ModelProvider = {
    name: "stub",
    async complete(request) {
      captured = request;
      throw new ProviderError("rate_limited", 429);
    },
  };
  const dir = mkdtempSync(path.join(tmpdir(), "answer-variant-"));
  const run = await runAnswers("tuning", POLICY, () => provider, { checkpointFile: path.join(dir, "c.jsonl"), ...(promptVariant ? { promptVariant } : {}) });
  return { request: captured!, promptVariant: run.promptVariant, tmpFiles: readdirSync(dir) };
}

describe.skipIf(!HAVE_CACHE)("runAnswers variant wiring", () => {
  it("uses A by default and the selected instructions for B and C, with identical evidence input", async () => {
    const a = await firstRequest();
    const b = await firstRequest("B");
    const c = await firstRequest("C");
    expect(a.request.system).toBe(SYSTEM_PROMPTS.A);
    expect(b.request.system).toBe(SYSTEM_PROMPTS.B);
    expect(c.request.system).toBe(SYSTEM_PROMPTS.C);
    expect(a.promptVariant).toBeUndefined();
    expect([b.promptVariant, c.promptVariant]).toEqual(["B", "C"]);
    const norm = (r: ModelRequest) => r.user.replaceAll(r.nonce, "N");
    expect(norm(b.request)).toBe(norm(a.request));
    expect(norm(c.request)).toBe(norm(a.request));
    expect(b.request.maxTokens).toBe(a.request.maxTokens);
  }, 240_000);

  it("version 3 evidence leaves a question it has no fact for untouched, and adds the application's note where it has one", async () => {
    // The requests for the first two tuning cases, ky-1 (where is something calculated) and ky-6 (which modules import something).
    async function firstTwo(evidenceVersion?: EvidenceVersion): Promise<{ requests: ModelRequest[]; evidenceVersion: number | undefined }> {
      const requests: ModelRequest[] = [];
      const provider: ModelProvider = {
        name: "stub",
        async complete(request) {
          requests.push(request);
          if (requests.length === 2) throw new ProviderError("rate_limited", 429);
          return '{"status":"insufficient_evidence","missing":"x"}';
        },
      };
      const dir = mkdtempSync(path.join(tmpdir(), "answer-evidence-"));
      const run = await runAnswers("tuning", POLICY, () => provider, { checkpointFile: path.join(dir, "c.jsonl"), promptVariant: "E", ...(evidenceVersion ? { evidenceVersion } : {}) });
      return { requests, evidenceVersion: run.evidenceVersion };
    }
    const v2 = await firstTwo();
    const v3 = await firstTwo(3);
    expect(v2.evidenceVersion).toBeUndefined();
    expect(v3.evidenceVersion).toBe(3);
    const norm = (r: ModelRequest) => r.user.replaceAll(r.nonce, "N");
    for (const r of [...v2.requests, ...v3.requests]) expect(r.system).toBe(SYSTEM_PROMPTS.E);
    expect(norm(v3.requests[0]!)).toBe(norm(v2.requests[0]!));
    expect(v2.requests[1]!.user).not.toContain(" INDEX ");
    const note = v3.requests[1]!.user.split("\n").filter((l) => l.includes(" INDEX "));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("importers of HTTPError: the index lists 14 importing file(s), 3 in source and 11 in tests, examples or docs.");
    // Everything version 2 gave the model for that question is still there, in the same order.
    const blocks = (r: ModelRequest) => norm(r).split("\n").filter((l) => l.startsWith("@@N EVIDENCE "));
    expect(blocks(v3.requests[1]!).slice(0, blocks(v2.requests[1]!).length)).toEqual(blocks(v2.requests[1]!));
  }, 240_000);
});
