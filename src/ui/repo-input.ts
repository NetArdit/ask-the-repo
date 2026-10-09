import { parseRepoRef } from "../github/repo-ref";

export type RepoInput = { ok: true; owner: string; repo: string; note: string | null } | { ok: false; message: string };

const HOSTLIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Turns what a person pastes (owner/name, a github.com URL, a clone URL) into owner and name. The server accepts only
 * `owner/name`, so everything else is reduced to that here, and anything that is not a GitHub repository is refused with a
 * message that says what to type instead.
 */
export function parseRepoInput(raw: string): RepoInput {
  let text = raw.trim();
  if (text === "") return { ok: false, message: "Enter a repository, for example sindresorhus/ky." };
  if (text.length > 300) return { ok: false, message: "That is too long to be a repository. Use the form owner/name." };

  text = text.replace(/^git@github\.com:/i, "github.com/").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");
  text = text.split(/[?#]/)[0] ?? "";

  const segments = text.split("/").filter((s) => s !== "");
  const first = segments[0] ?? "";
  if (first.toLowerCase() === "github.com") segments.shift();
  else if (HOSTLIKE.test(first) && segments.length > 1) return { ok: false, message: "Only repositories on github.com are supported." };

  if (segments.length < 2) return { ok: false, message: "Use the form owner/name, for example sindresorhus/ky." };
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, "");
  try {
    parseRepoRef(`${owner}/${repo}`);
  } catch {
    return { ok: false, message: "That does not look like a GitHub repository. Use the form owner/name." };
  }
  const note = segments.length > 2 ? "Only the default branch is indexed, at its latest commit. The rest of that link was ignored." : null;
  return { ok: true, owner, repo, note };
}
