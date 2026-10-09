import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Shell, linkClass } from "../ui/primitives";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AskTheRepo", template: "%s · AskTheRepo" },
  description: "Ask questions about a public GitHub repository and check every claim against the cited lines at a pinned commit.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f1113" },
    { media: "(prefers-color-scheme: light)", color: "#f5f4ef" },
  ],
};

const navLink = `inline-flex min-h-8 items-center text-ink-soft ${linkClass}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="absolute -top-24 left-4 z-10 rounded-sm bg-ink px-4 py-2 text-bg focus:top-3">
          Skip to content
        </a>
        <header className="border-b border-line">
          <Shell className="flex min-h-14 items-center justify-between gap-4">
            <Link href="/" aria-label="AskTheRepo home" className="py-2 font-mono font-semibold tracking-tight">
              ask
              <span aria-hidden="true" className="px-px text-ok">
                /
              </span>
              the
              <span aria-hidden="true" className="px-px text-ok">
                /
              </span>
              repo
            </Link>
            <nav aria-label="Site" className="flex gap-6 text-sm">
              <Link href="/#how-it-works" className={navLink}>
                How it works
              </Link>
              <Link href="/#limits" className={navLink}>
                Limits
              </Link>
            </nav>
          </Shell>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <footer className="mt-18 border-t border-line py-6 text-sm text-muted">
          <Shell>
            Answers are written by a language model from repository code. Each citation is checked to exist at the pinned commit. Whether the cited lines support a claim is for you to
            judge, which is why the lines are always one click away.
          </Shell>
        </footer>
      </body>
    </html>
  );
}
