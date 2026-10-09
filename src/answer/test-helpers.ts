import { IndexBuilder } from "../index/build";
import { languageOf } from "../ingest/filter";
import { parseSource } from "../parse/extract";
import { BASELINE_CONFIG } from "../index/types";
import { DEFAULT_INDEX_CONFIG, DEFAULT_SEARCH_OPTIONS } from "../retrieve/defaults";
import { LoadedIndex } from "../retrieve/loaded-index";
import type { AnswerDeps } from "./answer";
import type { ModelProvider, ModelRequest } from "./provider";
import { MapSource } from "./source";
import type { RepoIdentity } from "./types";

export const TEST_REPO: RepoIdentity = { owner: "acme", repo: "shop", sha: "d".repeat(40) };

export async function buildFixture(files: Record<string, string>, repo: RepoIdentity = TEST_REPO): Promise<{ index: LoadedIndex; source: MapSource }> {
  const builder = new IndexBuilder({ owner: repo.owner, repo: repo.repo, sha: repo.sha }, { ...BASELINE_CONFIG, ...DEFAULT_INDEX_CONFIG, includeConfig: false, resolveWorkspaceAndAliases: false });
  for (const [path, text] of Object.entries(files)) {
    builder.addFile(await parseSource(path, languageOf(path), text), text, Buffer.byteLength(text));
  }
  return { index: new LoadedIndex(builder.finish()), source: new MapSource(new Map(Object.entries(files))) };
}

/** Returns canned text and records the request, so tests can inspect exactly what the model would have seen. */
export class ScriptedModel implements ModelProvider {
  readonly name = "scripted";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly reply: string | ((req: ModelRequest) => string | Promise<string>)) {}

  async complete(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    return typeof this.reply === "string" ? this.reply : this.reply(request);
  }
}

export const FILES: Record<string, string> = {
  "src/auth/login.ts": [
    'import { hashPassword } from "../util/crypto";',
    "",
    "export async function loginUser(email: string, password: string) {",
    "  const hash = hashPassword(password);",
    "  return createSession(email, hash);",
    "}",
    "",
    "export function createSession(email: string, token: string) {",
    "  return { email, token };",
    "}",
    "",
  ].join("\n"),
  "src/util/crypto.ts": ["export function hashPassword(input: string): string {", '  return input.split("").reverse().join("");', "}", ""].join("\n"),
  "src/payments/stripe.ts": ["export async function chargeCustomer(customerId: string, cents: number) {", '  return { customerId, cents, status: "charged" };', "}", ""].join("\n"),
};

export function deps(overrides: Partial<AnswerDeps> & Pick<AnswerDeps, "index" | "source" | "provider">): AnswerDeps {
  return {
    repo: TEST_REPO,
    searchOptions: DEFAULT_SEARCH_OPTIONS,
    policy: { insufficientBelow: 0.2, cautionBelow: 0.5 },
    ...overrides,
  };
}
