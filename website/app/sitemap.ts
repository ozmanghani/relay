import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/content';
import { DOC_PAGES, docHref } from '@/lib/docs';

// emitted as a static /sitemap.xml at build time
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  // the build date: honest for a static site rebuilt on content change
  const lastModified = new Date();

  return [
    { url: SITE_URL, lastModified },
    { url: `${SITE_URL}/benchmarks`, lastModified },
    ...DOC_PAGES.map((page) => ({
      url: `${SITE_URL}${docHref(page)}`,
      lastModified,
    })),
  ];
}
