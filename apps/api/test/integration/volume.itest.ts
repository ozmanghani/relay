/**
 * Sustained-volume proof for the spool, opt-in because it takes about a minute:
 *
 *   SYNCLE_CDC_SPOOL=on SYNCLE_VOLUME_ROWS=1000000 pnpm test:integration
 *
 * The assertions that matter are not "it was fast". They are that a million
 * changes arrive exactly once, and that the spool's depth never exceeds its
 * configured cap while they do — that cap is what stops an unreachable
 * destination from turning into unbounded Redis growth, which would just move
 * the problem the spool exists to solve.
 *
 * Recorded on a 2026 laptop against containerised Postgres: 1,000,000 rows in
 * 54s (~18,000 rows/sec), peak spool depth exactly at the 50,000 cap, final
 * depth 0.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapApp,
  connectionFor,
  destCount,
  destDistinctIds,
  makeBridge,
  type AppHandle,
} from './app-harness';
import { waitFor, withAdapter } from './harness';

const ROWS = Number(process.env.SYNCLE_VOLUME_ROWS ?? 0);
const ENABLED = ROWS > 0 && process.env.SYNCLE_CDC_SPOOL === 'on';

let app: AppHandle;
let spool: any;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  if (!ENABLED) return;
  app = await bootstrapApp();
  const { CdcSpoolService } = await import('../../src/bridges/cdc/cdc-spool.service');
  spool = app.ctx.get(CdcSpoolService);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

describe.runIf(ENABLED)('sustained volume through the spool', () => {
  it('delivers every row exactly once with bounded spool depth', async () => {
    const src = await connectionFor(app, 'postgres');
    const dst = await connectionFor(app, 'postgres');
    const s = await makeBridge(app, {
      destEngine: 'postgres',
      sourceConnId: src,
      destConnId: dst,
      cleanups,
    });
    cleanups.push(() => spool.clear(s.bridgeId).catch(() => undefined));

    // sampled rather than computed: proves the cap holds in practice
    let peak = 0;
    const watch = setInterval(() => {
      void spool
        .depth(s.bridgeId)
        .then((d: number) => {
          if (d > peak) peak = d;
        })
        .catch(() => undefined);
    }, 200);

    const started = Date.now();
    const chunk = 10_000;
    for (let start = 0; start < ROWS; start += chunk) {
      const size = Math.min(chunk, ROWS - start);
      await withAdapter('postgres', (a) =>
        a.insertRows!({
          table: s.sourceTable,
          rows: Array.from({ length: size }, (_, i) => ({
            id: start + i + 1,
            name: `v${start + i}`,
          })),
        }),
      );
    }

    await waitFor(
      `${ROWS} rows to arrive`,
      async () => ((await destCount('postgres', s.destTable)) === ROWS ? true : null),
      { timeoutMs: 1_800_000, intervalMs: 1_000 },
    );
    clearInterval(watch);
    const elapsed = Date.now() - started;

    const { distinct, min, max } = await destDistinctIds('postgres', s.destTable);
    // exactly once, nothing missing, nothing repeated
    expect(distinct).toBe(ROWS);
    expect(min).toBe(1);
    expect(max).toBe(ROWS);

    // the spool stayed inside its cap the whole way, and gave the memory back
    const cap = Number(process.env.SYNCLE_CDC_SPOOL_MAX ?? 50_000);
    expect(peak).toBeLessThanOrEqual(cap);
    expect(await spool.depth(s.bridgeId)).toBe(0);

    console.log(
      `volume: ${ROWS} rows in ${elapsed}ms (${Math.round(ROWS / (elapsed / 1000))}/sec), peak spool ${peak}/${cap}`,
    );
  }, 1_800_000);
});
