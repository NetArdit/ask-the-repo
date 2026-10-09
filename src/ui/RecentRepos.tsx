"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { PageSection } from "./primitives";
import { recentRepos } from "./store";

/** Repositories opened in this browser. Nothing here comes from the server; it is a convenience kept on the device. */
export function RecentRepos() {
  const recents = useSyncExternalStore(recentRepos.subscribe, recentRepos.getSnapshot, recentRepos.getServerSnapshot);
  if (recents.length === 0) return null;
  return (
    <PageSection id="recent" title="Recently opened on this device">
      <ul data-recent className="grid max-w-[40rem] gap-2">
        {recents.map((r) => (
          <li key={`${r.owner}/${r.repo}@${r.sha}`}>
            <Link href={`/r/${r.owner}/${r.repo}/${r.sha}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-4 py-3 hover:border-ink">
              <span className="font-mono font-semibold wrap-anywhere">{`${r.owner}/${r.repo}`}</span>
              <span className="font-mono text-sm text-ink-soft">@ {r.sha.slice(0, 7)}</span>
              <span className="text-sm text-muted">{r.files} files indexed</span>
            </Link>
          </li>
        ))}
      </ul>
    </PageSection>
  );
}
