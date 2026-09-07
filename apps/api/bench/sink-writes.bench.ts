/**
 * Write-path throughput at the adapter level: what it costs to land rows in a
 * destination, per engine, batched versus one statement per row.
 *
 * The comparison pair runs at the SAME row count on the same table shape, so
 * the two rates are directly comparable. The large runs then show the batched
 * path at a volume nobody would attempt row-at-a-time.
 */
import 'reflect-metadata';
import { afterAll, describe, it } from 'vitest';
import type { DatabaseAdapter } from '@syncle/core';
import { uniqueTable, withAdapter } from '../test/integration/harness';
import {
  captureEnvironment,
  makeResult,
  publishSuite,
  resourceDetail,
  ResourceSampler,
  timed,
  type BenchResult,
} from './harness';

/** time a block while sampling what it costs in CPU and memory */
async function measured<T>(
  engine: Engine,
  fn: () => Promise<T>,
): Promise<{ ms: number; detail: Record<string, string | number> }> {
  const sampler = new ResourceSampler();
  sampler.start();
  const { ms } = await timed(fn);
  return { ms, detail: resourceDetail(sampler.stop(), [engine]) };
}

type Engine = 'postgres' | 'mysql' | 'sqlite';
const TYPES: Record<Engine, { int: string; text: string }> = {
  postgres: { int: 'integer', text: 'text' },
  mysql: { int: 'int', text: 'varchar(255)' },
  sqlite: { int: 'INTEGER', text: 'TEXT' },
};

/** same row count for both sides of every comparison */
const COMPARE_ROWS = 50_000;
/** the batched path at real volume */
const LARGE_ROWS = 1_000_000;

const results: BenchResult[] = [];
const tables: Array<{ engine: Engine; table: string }> = [];

async function makeTable(a: DatabaseAdapter, engine: Engine, table: string): Promise<void> {
  const t = TYPES[engine];
  await a.createTable({
    table,
    columns: [
      { name: 'id', type: t.int, nullable: false, primaryKey: true },
      { name: 'name', type: t.text, nullable: true },
      { name: 'note', type: t.text, nullable: true },
    ],
  });
  tables.push({ engine, table });
}

const rowsFor = (n: number, offset = 0): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({
    id: offset + i + 1,
    name: `name-${offset + i}`,
    note: `note-${offset + i}`,
  }));

afterAll(async () => {
  for (const t of tables) {
    await withAdapter(t.engine, (a) => a.dropTable(t.table)).catch(() => undefined);
  }
  publishSuite(
    {
      id: 'sink-writes',
      name: 'Destination writes',
      description:
        'Rows written into a destination table through the real adapters. ' +
        'The per-row rows are the old path — one statement per row; the batched ' +
        'rows are one multi-row statement per chunk. Both sides of each pair run ' +
        `at ${COMPARE_ROWS.toLocaleString()} rows on the same table, so the rates compare directly.`,
      results,
    },
    await captureEnvironment(),
  );
});

describe('destination write throughput', () => {
  for (const engine of ['postgres', 'mysql', 'sqlite'] as Engine[]) {
    it(`${engine}: insert, per-row vs batched`, async () => {
      const rows = rowsFor(COMPARE_ROWS);
      await withAdapter(engine, async (a) => {
        const loopTable = uniqueTable('bw_loop');
        await makeTable(a, engine, loopTable);
        const loop = await measured(engine, async () => {
          for (const values of rows) await a.insertRow({ table: loopTable, values });
        });
        results.push(
          makeResult(
            `${engine} · insert · one statement per row`,
            COMPARE_ROWS,
            loop.ms,
            loop.detail,
          ),
        );

        const batchTable = uniqueTable('bw_batch');
        await makeTable(a, engine, batchTable);
        const batched = await measured(engine, () => a.insertRows!({ table: batchTable, rows }));
        results.push(
          makeResult(`${engine} · insert · batched`, COMPARE_ROWS, batched.ms, {
            'speed-up': `${(loop.ms / Math.max(1, batched.ms)).toFixed(1)}×`,
            ...batched.detail,
          }),
        );
      });
    });

    it(`${engine}: upsert, per-row vs batched`, async () => {
      const rows = rowsFor(COMPARE_ROWS);
      await withAdapter(engine, async (a) => {
        const loopTable = uniqueTable('bu_loop');
        await makeTable(a, engine, loopTable);
        const loop = await measured(engine, async () => {
          for (const values of rows) {
            await a.upsertRow({ table: loopTable, values, keyColumns: ['id'] });
          }
        });
        results.push(
          makeResult(
            `${engine} · upsert · one statement per row`,
            COMPARE_ROWS,
            loop.ms,
            loop.detail,
          ),
        );

        const batchTable = uniqueTable('bu_batch');
        await makeTable(a, engine, batchTable);
        const batched = await measured(engine, () =>
          a.upsertRows!({ table: batchTable, rows, keyColumns: ['id'] }),
        );
        results.push(
          makeResult(`${engine} · upsert · batched`, COMPARE_ROWS, batched.ms, {
            'speed-up': `${(loop.ms / Math.max(1, batched.ms)).toFixed(1)}×`,
            ...batched.detail,
          }),
        );
      });
    });

    it(`${engine}: delete, per-row vs batched`, async () => {
      const rows = rowsFor(COMPARE_ROWS);
      const identities = rows.map((r) => ({ id: r.id }));
      await withAdapter(engine, async (a) => {
        const loopTable = uniqueTable('bd_loop');
        await makeTable(a, engine, loopTable);
        await a.insertRows!({ table: loopTable, rows });
        const loop = await measured(engine, async () => {
          for (const identity of identities) await a.deleteRow({ table: loopTable, identity });
        });
        results.push(
          makeResult(
            `${engine} · delete · one statement per row`,
            COMPARE_ROWS,
            loop.ms,
            loop.detail,
          ),
        );

        const batchTable = uniqueTable('bd_batch');
        await makeTable(a, engine, batchTable);
        await a.insertRows!({ table: batchTable, rows });
        const batched = await measured(engine, () => a.deleteRows!({ table: batchTable, identities }));
        results.push(
          makeResult(`${engine} · delete · batched`, COMPARE_ROWS, batched.ms, {
            'speed-up': `${(loop.ms / Math.max(1, batched.ms)).toFixed(1)}×`,
            ...batched.detail,
          }),
        );
      });
    });
  }

  it('one million rows, batched upsert', async () => {
    for (const engine of ['postgres', 'mysql'] as Engine[]) {
      await withAdapter(engine, async (a) => {
        const table = uniqueTable('bm');
        await makeTable(a, engine, table);
        const chunk = 50_000;
        const run = await measured(engine, async () => {
          for (let start = 0; start < LARGE_ROWS; start += chunk) {
            await a.upsertRows!({
              table,
              rows: rowsFor(Math.min(chunk, LARGE_ROWS - start), start),
              keyColumns: ['id'],
            });
          }
        });
        results.push(
          makeResult(
            `${engine} · upsert · batched · 1,000,000 rows`,
            LARGE_ROWS,
            run.ms,
            run.detail,
          ),
        );
      });
    }
  });
});
