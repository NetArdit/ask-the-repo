import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { assertCommitSha, parseRepoRef } from "../../../../../github/repo-ref";
import { Workspace } from "../../../../../ui/Workspace";

type Params = Promise<{ owner: string; repo: string; sha: string }>;

/** The address is the state: owner, name and the exact commit. Anything that is not one of those is not a page. */
function validate(p: { owner: string; repo: string; sha: string }): { owner: string; repo: string; sha: string } | null {
  try {
    const ref = parseRepoRef(`${p.owner}/${p.repo}`);
    return { ...ref, sha: assertCommitSha(p.sha) };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const key = validate(await params);
  return key ? { title: `${key.owner}/${key.repo} @ ${key.sha.slice(0, 7)}`, robots: { index: false } } : { title: "Not found" };
}

export default async function WorkspacePage({ params }: { params: Params }) {
  const key = validate(await params);
  if (!key) notFound();
  return <Workspace owner={key.owner} repo={key.repo} sha={key.sha} />;
}
