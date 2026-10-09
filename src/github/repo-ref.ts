export interface RepoRef {
  owner: string;
  repo: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class InvalidRepoRefError extends Error {
  constructor(input: string) {
    super(`Not a valid repository reference: ${JSON.stringify(input.slice(0, 120))}`);
    this.name = "InvalidRepoRefError";
  }
}

/** Accepts only `owner/repo` or `github.com/owner/repo`. Anything else is rejected. */
export function parseRepoRef(input: string): RepoRef {
  const raw = input.trim();
  const rest = raw.startsWith("github.com/") ? raw.slice("github.com/".length) : raw;
  const parts = rest.split("/");
  if (parts.length !== 2) throw new InvalidRepoRefError(input);
  const [owner, repo] = parts as [string, string];
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) throw new InvalidRepoRefError(input);
  if (repo === "." || repo === ".." || repo.endsWith(".git")) throw new InvalidRepoRefError(input);
  return { owner, repo };
}

const SHA_RE = /^[0-9a-f]{40}$/;

export function assertCommitSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error("Commit SHA must be 40 lowercase hex characters");
  return sha;
}
