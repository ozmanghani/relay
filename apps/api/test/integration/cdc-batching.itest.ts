/**
 * Micro-batching correctness.
 *
 * Batching a change stream introduces hazards that per-row delivery did not
 * have: a batch can mix operations, it can contain the same key twice (which a
 * multi-row upsert cannot express), and it moves the checkpoint from per-row to
 * per-batch. Each of those is exercised here against real databases.
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
} from './app-harness';
import { waitFor, withAdapter } from './harness';

let app: AppHandle;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

async function freshBridge(): Promise<SyncSetup> {
  const src = await connectionFor(app, 'postgres');
  const dst = await connectionFor(app, 'postgres');
  return makeBridge(app, {
    destEngine: 'postgres',
    sourceConnId: src,
    destConnId: dst,
    cleanups,
  });
}

describe('batching hazards', () => {
  it('survives repeated updates to the SAME key inside one batch window', async () => {
    // a multi-row upsert cannot touch one row twice — Postgres rejects
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" — so the
    // batcher must break the batch when a key repeats
    const s = await freshBridge();
    await withAdapter('postgres', async (a) => {
      await a.insertRow({ table: s.sourceTable, values: { id: 1, name: 'v0' } });
      for (let i = 1; i <= 25; i++) {
        await a.updateRow({
          table: s.sourceTable,
          identity: { id: 1 },
          changes: { name: `v${i}` },
        });
      }
    });

    const rows = await waitFor('final value of the repeatedly-updated row', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 && r[0]?.name === 'v25' ? r : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, name: 'v25' });
  });

  it('keeps ordering when operations alternate', async () => {
    // insert/update/delete route differently through the sink, so a change of
    // operation must close the current batch or rows would be misrouted
    const s = await freshBridge();
    await withAdapter('postgres', async (a) => {
      for (const id of [1, 2, 3, 4]) {
        await a.insertRow({ table: s.sourceTable, values: { id, name: `n${id}` } });
      }
      await a.deleteRow({ table: s.sourceTable, identity: { id: 2 } });
      await a.insertRow({ table: s.sourceTable, values: { id: 5, name: 'n5' } });
      await a.deleteRow({ table: s.sourceTable, identity: { id: 4 } });
    });

    const rows = await waitFor('alternating ops to settle', async () => {
      const r = await destRows('postgres', s.destTable);
      const ids = r.map((x) => Number(x.id));
      return ids.length === 3 && ids.join(',') === '1,3,5' ? r : null;
    });
    expect(rows.map((r) => Number(r.id))).toEqual([1, 3, 5]);
  });

  it('re-inserting a deleted key ends in the inserted state', async () => {
    const s = await freshBridge();
    await withAdapter('postgres', async (a) => {
      await a.insertRow({ table: s.sourceTable, values: { id: 9, name: 'first' } });
      await a.deleteRow({ table: s.sourceTable, identity: { id: 9 } });
      await a.insertRow({ table: s.sourceTable, values: { id: 9, name: 'second' } });
    });
    const rows = await waitFor('delete-then-insert to settle', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 && r[0]?.name === 'second' ? r : null;
    });
    expect(rows[0]).toMatchObject({ id: 9, name: 'second' });
  });

  it('a partial batch is flushed by the linger timer, not left waiting', async () => {
    // one row is far below the batch size; it must still arrive promptly
    const s = await freshBridge();
    const started = Date.now();
    await withAdapter('postgres', (a) =>
      a.insertRow({ table: s.sourceTable, values: { id: 42, name: 'lonely' } }),
    );
    await waitFor('single row to arrive', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 ? r : null;
    });
    // generous, but proves it is not stuck waiting for a full batch
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('delivers a large burst exactly once and records batched deliveries', async () => {
    const s = await freshBridge();
    const total = 500;
    await withAdapter('postgres', (a) =>
      a.insertRows!({
        table: s.sourceTable,
        rows: Array.from({ length: total }, (_, i) => ({ id: i + 1, name: `r${i}` })),
      }),
    );

    const rows = await waitFor(
      `${total} rows to arrive`,
      async () => {
        const r = await destRows('postgres', s.destTable);
        return r.length === total ? r : null;
      },
      { timeoutMs: 120_000 },
    );
    const ids = rows.map((r) => Number(r.id));
    expect(new Set(ids).size).toBe(total);

    // the point of batching: far fewer deliveries than rows
    const job = await app.prisma.bridgeJob.findFirst({
      where: { bridgeId: s.bridgeId },
      orderBy: { startedAt: 'desc' },
    });
    const deliveries = await app.prisma.bridgeDelivery.count({
      where: { jobId: job.id },
    });
    expect(deliveries).toBeLessThan(total);
    const summed = await app.prisma.bridgeDelivery.aggregate({
      where: { jobId: job.id },
      _sum: { rowCount: true },
    });
    // every row is accounted for across the batched deliveries
    expect(summed._sum.rowCount).toBe(total);
  });
});

describe('checkpointing across a restart', () => {
  it('resumes without losing or duplicating rows', async () => {
    const s = await freshBridge();

    await withAdapter('postgres', (a) =>
      a.insertRows!({
        table: s.sourceTable,
        rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `a${i}` })),
      }),
    );
    await waitFor('first batch delivered', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 50 ? r : null;
    });

    // stop the stream, write while it is down, then bring it back
    await app.cdc.stop(s.bridgeId);
    await withAdapter('postgres', (a) =>
      a.insertRows!({
        table: s.sourceTable,
        rows: Array.from({ length: 50 }, (_, i) => ({ id: i + 51, name: `b${i}` })),
      }),
    );
    await app.cdc.start(s.bridgeId);

    const rows = await waitFor(
      'rows written while stopped to be caught up',
      async () => {
        const r = await destRows('postgres', s.destTable);
        return r.length === 100 ? r : null;
      },
      { timeoutMs: 120_000 },
    );
    const ids = rows.map((r) => Number(r.id)).sort((x, y) => x - y);
    expect(new Set(ids).size).toBe(100); // no duplicates
    expect(ids[0]).toBe(1);
    expect(ids[99]).toBe(100); // nothing lost
  });
});
