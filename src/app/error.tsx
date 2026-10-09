"use client";

import { useEffect } from "react";
import { Button, Eyebrow, Shell } from "../ui/primitives";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Shell>
      <section className="grid max-w-[44rem] gap-6 py-18">
        <Eyebrow>Something broke</Eyebrow>
        <h1 className="text-display leading-[1.08] font-semibold tracking-[-0.025em] text-balance">This page hit an error it did not expect.</h1>
        <p className="text-lg text-ink-soft">Nothing you asked was lost on the server. Try again; if it happens again, reload the page.</p>
        <div>
          <Button variant="primary" onClick={() => retry()}>
            Try again
          </Button>
        </div>
      </section>
    </Shell>
  );
}
