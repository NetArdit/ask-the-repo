import Link from "next/link";
import { Eyebrow, Shell, buttonClass } from "../ui/primitives";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <Shell>
      <section className="grid max-w-[44rem] gap-6 py-18">
        <Eyebrow>404</Eyebrow>
        <h1 className="text-display leading-[1.08] font-semibold tracking-[-0.025em] text-balance">There is nothing at this address.</h1>
        <p className="text-lg text-ink-soft">A repository page needs an owner, a name and a full 40-character commit, like /r/owner/name/3b17b2e8…. Start from a repository instead.</p>
        <div>
          <Link href="/" data-button className={buttonClass("primary")}>
            Index a repository
          </Link>
        </div>
      </section>
    </Shell>
  );
}
