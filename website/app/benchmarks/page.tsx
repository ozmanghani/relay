import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { GITHUB } from '@/lib/content';
import { MEASURE } from '@/lib/layout';
import {
  formatDuration,
  formatNumber,
  loadBenchmarks,
  type BenchResult,
} from '@/lib/benchmarks';

export const metadata: Metadata = {
  title: 'Benchmarks — Syncle',
  description:
    'Measured throughput for Syncle, run against real PostgreSQL, MySQL and MongoDB with millions of rows. Every figure comes from a recorded run, not an estimate.',
};

const RESULTS_SOURCE = `${GITHUB}/blob/main/benchmarks/results.json`;
const RUNNER_SOURCE = `${GITHUB}/blob/main/apps/api/bench`;

/** the extra readings a scenario carries, shown under its row */
function Detail({ detail }: { detail: BenchResult['detail'] }) {
  if (!detail || Object.keys(detail).length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {Object.entries(detail).map(([k, v]) => (
        <li key={k}>
          <span className="opacity-70">{k}:</span> {String(v)}
        </li>
      ))}
    </ul>
  );
}

export default function BenchmarksPage() {
  const report = loadBenchmarks();

  return (
    <>
      <SiteHeader current="benchmarks" />
      <main className={`mx-auto px-6 pb-16 ${MEASURE}`}>
        <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>

        {!report ? (
          <p className="mt-6 text-muted-foreground">
            No recorded run is checked in yet. Run <code>pnpm benchmark</code>{' '}
            against the test stack to produce one.
          </p>
        ) : (
          <>
            <p className="mt-4 max-w-[70ch] text-muted-foreground">
              Every number on this page comes from a recorded run of{' '}
              <a href={RUNNER_SOURCE} rel="noopener" className="link">
                the benchmark suite
              </a>{' '}
              against real databases. The results are committed as{' '}
              <a href={RESULTS_SOURCE} rel="noopener" className="link">
                <code>benchmarks/results.json</code>
              </a>{' '}
              and this page only renders that file — so anything shown here can
              be reproduced, and nothing here was typed by hand.
            </p>

            <div className="mt-8 rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
              <h2 className="text-sm font-semibold">
                Read this before quoting a number
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {report.disclaimer}
              </p>
            </div>

            <section className="mt-10">
              <h2 className="text-xl font-semibold tracking-tight">
                The configuration
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                The shipped defaults — these are not tuned for the benchmark.
                Read from the running configuration, so this cannot claim
                settings the run did not use.
              </p>
              <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                {Object.entries(report.configuration ?? {}).map(([k, v]) => (
                  <div key={k} className="flex gap-2 border-b py-2">
                    <dt className="w-40 shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="mt-10">
              <h2 className="text-xl font-semibold tracking-tight">
                The machine
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Syncle, the databases and Redis all ran here, together.
              </p>
              <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                {Object.entries(report.environment).map(([k, v]) => (
                  <div key={k} className="flex gap-2 border-b py-2">
                    <dt className="w-32 shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {report.suites.map((suite) => (
              <section key={suite.id} className="mt-12">
                <h2 className="text-xl font-semibold tracking-tight">
                  {suite.name}
                </h2>
                <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
                  {suite.description}
                </p>

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[40rem] border-collapse text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="py-2 pr-4 font-medium">Scenario</th>
                        <th className="py-2 pr-4 text-right font-medium">
                          Rows
                        </th>
                        <th className="py-2 pr-4 text-right font-medium">
                          Time
                        </th>
                        <th className="py-2 text-right font-medium">
                          Rows / sec
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {suite.results.map((r) => (
                        <tr key={r.scenario} className="border-b align-top">
                          <td className="py-3 pr-4">
                            {r.scenario}
                            <Detail detail={r.detail} />
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums">
                            {formatNumber(r.rows)}
                          </td>
                          <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                            {formatDuration(r.ms)}
                          </td>
                          <td className="py-3 text-right font-semibold tabular-nums">
                            {formatNumber(r.rowsPerSec)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}

            <section className="mt-12">
              <h2 className="text-xl font-semibold tracking-tight">
                Reproducing this
              </h2>
              <pre className="mt-4 overflow-x-auto rounded-lg border p-4 text-sm">
                <code>{`docker compose -f docker-compose.test.yml up -d
pnpm benchmark`}</code>
              </pre>
              <p className="mt-3 text-sm text-muted-foreground">
                The run resets replication slots, fixtures and the metadata
                store first, because leftovers from a previous run distort
                everything after them. Each figure is verified complete and
                duplicate-free before its time is recorded — a throughput number
                is worthless if the data is wrong.
              </p>
            </section>

            <p className="mt-10 text-xs text-muted-foreground">
              Recorded {new Date(report.generatedAt).toISOString().slice(0, 10)}.
            </p>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
