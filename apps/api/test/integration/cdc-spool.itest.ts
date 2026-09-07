/**
 * The durable spool, exercised with SYNCLE_CDC_SPOOL=on.
 *
 * The spool exists so a slow or unreachable destination cannot hold the
 * SOURCE's log open. These tests check that the source is checkpointed on
 * spooling, that the destination still receives everything exactly once, that
 * the spool is trimmed as it drains (so it does not grow without bound), and
 * that it holds up at volume.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  makeBridge,
  type AppHandle,
  type SyncSetup,
  destCount,
  destDistinctIds,
} from './app-harness';
import { waitFor, withAdapter } from './harness';

// the spool is opt-in, so this file only runs when it is enabled:
//   SYNCLE_CDC_SPOOL=on pnpm test:integration
// it must be set before the app module is evaluated, hence an env check rather
// than a runtime toggle
const ENABLED = process.env.SYNCLE_CDC_SPOOL === 'on';

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

async function freshBridge(): Promise<SyncSetup> {
  const src = await connectionFor(app, 'postgres');
  const dst = await connectionFor(app, 'postgres');
  const s = await makeBridge(app, {
    destEngine: 'postgres',
    sourceConnId: src,
    destConnId: dst,
    cleanups,
  });
  cleanups.push(() => spool.clear(s.bridgeId).catch(() => undefined));
  return s;
}

describe.runIf(ENABLED)('spooled delivery', () => {
  it('delivers through the spool and drains it', async () => {
    const s = await freshBridge();
    await withAdapter('postgres', (a) =>
      a.insertRows!({
        table: s.sourceTable,
        rows: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `n${i}` })),
      }),
    );

    const rows = await waitFor('rows via spool', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 100 ? r : null;
    });
    expect(new Set(rows.map((r) => Number(r.id))).size).toBe(100);

    // the spool is trimmed as it drains, so it does not grow without bound
    const depth = await waitFor('spool to drain', async () => {
      const d = await spool.depth(s.bridgeId);
      return d === 0 ? 'drained' : null;
    });
    expect(depth).toBe('drained');
  });

  it('checkpoints the source as soon as changes are spooled', async () => {
    // the entire point: the source may advance without waiting for the
    // destination, so a slow destination cannot pin the source's log
    const s = await freshBridge();
    await withAdapter('postgres', (a) =>
      a.insertRow({ table: s.sourceTable, values: { id: 1, name: 'x' } }),
    );
    const job = await waitFor('source cursor to advance', async () => {
      const j = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: s.bridgeId },
        orderBy: { startedAt: 'desc' },
      });
      return j?.cursorJson ? j : null;
    });
    expect(JSON.parse(job.cursorJson).cursor).toBeTruthy();
  });

  it('preserves ordering and operations through the spool', async () => {
    const s = await freshBridge();
    await withAdapter('postgres', async (a) => {
      for (const id of [1, 2, 3, 4]) {
        await a.insertRow({ table: s.sourceTable, values: { id, name: `n${id}` } });
      }
      await a.deleteRow({ table: s.sourceTable, identity: { id: 2 } });
      await a.updateRow({
        table: s.sourceTable,
        identity: { id: 3 },
        changes: { name: 'changed' },
      });
    });
    const rows = await waitFor('ops to settle', async () => {
      const r = await destRows('postgres', s.destTable);
      const ids = r.map((x) => Number(x.id));
      return ids.join(',') === '1,3,4' && r.find((x) => Number(x.id) === 3)?.name === 'changed'
        ? r
        : null;
    });
    expect(rows.map((r) => Number(r.id))).toEqual([1, 3, 4]);
  });

  it('repeated updates to one key survive the spool', async () => {
    const s = await freshBridge();
    await withAdapter('postgres', async (a) => {
      await a.insertRow({ table: s.sourceTable, values: { id: 1, name: 'v0' } });
      for (let i = 1; i <= 30; i++) {
        await a.updateRow({
          table: s.sourceTable,
          identity: { id: 1 },
          changes: { name: `v${i}` },
        });
      }
    });
    const rows = await waitFor('final value', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 && r[0]?.name === 'v30' ? r : null;
    });
    expect(rows[0]).toMatchObject({ id: 1, name: 'v30' });
  });

  it('handles a large volume without unbounded growth', async () => {
    const s = await freshBridge();
    const total = 20_000;
    const chunk = 2_000;
    for (let start = 0; start < total; start += chunk) {
      await withAdapter('postgres', (a) =>
        a.insertRows!({
          table: s.sourceTable,
          rows: Array.from({ length: chunk }, (_, i) => ({
            id: start + i + 1,
            name: `bulk-${start + i}`,
          })),
        }),
      );
    }

    // counted in the engine: browse() is capped well below this volume
    await waitFor(
      `${total} rows through the spool`,
      async () => ((await destCount('postgres', s.destTable)) === total ? true : null),
      { timeoutMs: 600_000, intervalMs: 250 },
    );
    // exactly once: complete, contiguous, no duplicates
    const { distinct, min, max } = await destDistinctIds('postgres', s.destTable);
    expect(distinct).toBe(total);
    expect(min).toBe(1);
    expect(max).toBe(total);

    // and the spool gave the memory back rather than accumulating tombstones
    await waitFor('spool fully trimmed', async () => {
      const d = await spool.depth(s.bridgeId);
      return d === 0 ? true : null;
    });
    expect(await spool.depth(s.bridgeId)).toBe(0);
  }, 600_000);
});
