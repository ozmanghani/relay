import { Logo } from '@/components/logo';
import { GITHUB } from '@/lib/content';
import { MEASURE, WIDE_MEASURE } from '@/lib/layout';

/**
 * The header, shared by the homepage and the docs. The lockup and three text
 * links — no buttons, no rule under it, nothing sticky. The page scrolls past
 * it the way a document does.
 *
 * `wide` switches to the docs measure, so the lockup always sits on the same
 * left edge as the text below it.
 */
export function SiteHeader({
  current,
  wide = false,
}: {
  current?: 'docs' | 'benchmarks';
  wide?: boolean;
}) {
  return (
    <header
      className={`mx-auto flex items-center justify-between gap-6 px-6 py-7 ${
        wide ? WIDE_MEASURE : MEASURE
      }`}
    >
      <a href="/" aria-label="Syncle — home">
        <Logo className="h-10 w-auto" priority />
      </a>
      <nav className="flex items-center gap-5 text-sm sm:gap-6">
        <a
          href="/docs"
          aria-current={current === 'docs' ? 'page' : undefined}
          className={current === 'docs' ? 'font-semibold' : 'link'}
        >
          Docs
        </a>
        <a
          href="/benchmarks"
          aria-current={current === 'benchmarks' ? 'page' : undefined}
          className={current === 'benchmarks' ? 'font-semibold' : 'link'}
        >
          Benchmarks
        </a>
        <a href="/#install" className="link">
          Install
        </a>
        <a href={GITHUB} rel="noopener" className="link">
          GitHub
        </a>
      </nav>
    </header>
  );
}
