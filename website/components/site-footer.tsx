import { Logo } from '@/components/logo';
import { AUTHOR_GITHUB, GITHUB } from '@/lib/content';
import { MEASURE, WIDE_MEASURE } from '@/lib/layout';

/**
 * The footer: a rule, the lockup, one row of links, one line of credit.
 * Hrefs are root-relative so the same markup works from any route, and
 * `wide` matches the docs measure the way the header does.
 */
export function SiteFooter({ wide = false }: { wide?: boolean }) {
  const links: [string, string][] = [
    ['/docs', 'Documentation'],
    ['/benchmarks', 'Benchmarks'],
    [GITHUB, 'Source'],
    [`${GITHUB}/discussions`, 'Discussions'],
    [`${GITHUB}/releases/latest`, 'Releases'],
    [`${GITHUB}/issues`, 'Report an issue'],
    [`${GITHUB}/blob/main/LICENSE`, 'MIT licence'],
  ];

  return (
    <footer
      className={`mx-auto px-6 pb-16 ${wide ? WIDE_MEASURE : MEASURE}`}
    >
      <div className="flex flex-wrap items-start gap-x-8 gap-y-5 border-t pt-8 text-sm text-muted-foreground">
        <a href="/" aria-label="Syncle — home" className="shrink-0">
          <Logo className="h-10 w-auto" />
        </a>
        <div className="min-w-0">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {links.map(([href, label]) => (
              <li key={href}>
                <a href={href} rel="noopener" className="link">
                  {label}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3">
            Syncle is MIT licensed and built by{' '}
            <a href={AUTHOR_GITHUB} rel="noopener" className="link">
              Osman Ahmadzai
            </a>
            .
          </p>
        </div>
      </div>
    </footer>
  );
}
