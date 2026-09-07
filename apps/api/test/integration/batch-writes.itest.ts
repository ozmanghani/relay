/**
 * Set-based writes against real engines.
 *
 * The governing rule for every test here: a batched write must be
 * INDISTINGUISHABLE from the per-row loop it replaces. So most cases assert the
 * resulting table contents, not just that the call succeeded, and several run
 * the same data through both paths and compare.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@syncle/core';
import { TEST_CONNECTIONS, uniqueTable, withAdapter } from './harness';

type Engine = 'postgres' | 'mysql' | 'sqlite';
const ENGINES: Engine[] = ['postgres', 'mysql', 'sqlite'];

/** per-engine column types for the small fixture table */
const TYPES: Record<Engine, { int: string; text: string }> = {
  postgres: { int: 'integer', text: 'text' },
  mysql: { int: 'int', text: 'varchar(255)' },
  sqlite: { int: 'INTEGER', text: 'TEXT' },
};

const created: Array<{ engine: Engine; table: string }> = [];

async function makeTable(
  a: DatabaseAdapter,
  engine: Engine,
  table: string,
  extra: string[] = [],
): Promise<void> {
  const t = TYPES[engine];
  await a.createTable({
    table,
    columns: [
      { name: 'id', type: t.int, nullable: false, primaryKey: true },
      { name: 'name', type: t.text, nullable: true },
      { name: 'note', type: t.text, nullable: true },
      ...extra.map((c) => ({ name: c, type: t.text, nullable: true })),
    ],
  });
  created.push({ engine, table });
}

async function rowsOf(
  a: DatabaseAdapter,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await a.browse({ table, limit: 10_000, offset: 0 });
  return [...res.rows].sort((x, y) => Number(x.id) - Number(y.id));
}

afterEach(async () => {
  while (created.length) {
    const item = created.pop();
    if (!item) break;
    await withAdapter(item.engine, (a) => a.dropTable(item.table)).catch(
      () => undefined,
    );
  }
});

describe.each(ENGINES)('batched writes — %s', (engine) => {
  it('exposes the optional batch methods', async () => {
    await withAdapter(engine, async (a) => {
      expect(typeof a.insertRows).toBe('function');
      expect(typeof a.upsertRows).toBe('function');
      expect(typeof a.deleteRows).toBe('function');
    });
  });

  it('insertRows writes every row', async () => {
    const table = uniqueTable('b_ins');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      const res = await a.insertRows?.({
        table,
        rows: [
          { id: 1, name: 'a', note: 'x' },
          { id: 2, name: 'b', note: 'y' },
          { id: 3, name: 'c', note: 'z' },
        ],
      });
      expect(res?.affectedRows).toBe(3);
      const rows = await rowsOf(a, table);
      expect(rows.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    });
  });

  it('insertRows handles sparse rows with different column sets', async () => {
    const table = uniqueTable('b_sparse');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      // three distinct shapes in one call — these cannot share one statement
      await a.insertRows?.({
        table,
        rows: [
          { id: 1, name: 'a', note: 'n1' },
          { id: 2, name: 'b' },
          { id: 3, note: 'n3' },
        ],
      });
      const rows = await rowsOf(a, table);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ id: 1, name: 'a', note: 'n1' });
      expect(rows[1]).toMatchObject({ id: 2, name: 'b' });
      expect(rows[1]?.note ?? null).toBeNull();
      expect(rows[2]?.name ?? null).toBeNull();
      expect(rows[2]).toMatchObject({ id: 3, note: 'n3' });
    });
  });

  it('insertRows on an empty list is a no-op', async () => {
    const table = uniqueTable('b_empty');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      const res = await a.insertRows?.({ table, rows: [] });
      expect(res?.affectedRows).toBe(0);
      expect(await rowsOf(a, table)).toHaveLength(0);
    });
  });

  it('upsertRows inserts new rows and updates existing ones', async () => {
    const table = uniqueTable('b_up');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      await a.insertRows?.({
        table,
        rows: [
          { id: 1, name: 'old', note: 'keep' },
          { id: 2, name: 'old2', note: 'keep2' },
        ],
      });
      await a.upsertRows?.({
        table,
        keyColumns: ['id'],
        rows: [
          { id: 1, name: 'new', note: 'updated' }, // update
          { id: 3, name: 'fresh', note: 'inserted' }, // insert
        ],
      });
      const rows = await rowsOf(a, table);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ id: 1, name: 'new', note: 'updated' });
      expect(rows[1]).toMatchObject({ id: 2, name: 'old2' });
      expect(rows[2]).toMatchObject({ id: 3, name: 'fresh' });
    });
  });

  it('upsertRows is idempotent when replayed', async () => {
    const table = uniqueTable('b_idem');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      const rows = [
        { id: 1, name: 'a', note: 'n' },
        { id: 2, name: 'b', note: 'm' },
      ];
      await a.upsertRows?.({ table, keyColumns: ['id'], rows });
      await a.upsertRows?.({ table, keyColumns: ['id'], rows });
      await a.upsertRows?.({ table, keyColumns: ['id'], rows });
      // at-least-once redelivery must not duplicate
      expect(await rowsOf(a, table)).toHaveLength(2);
    });
  });

  it('upsertRows rejects an empty key list', async () => {
    const table = uniqueTable('b_nokey');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      await expect(
        a.upsertRows?.({ table, keyColumns: [], rows: [{ id: 1 }] }),
      ).rejects.toThrow(/key columns/i);
    });
  });

  it('deleteRows removes exactly the named identities', async () => {
    const table = uniqueTable('b_del');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      await a.insertRows?.({
        table,
        rows: [1, 2, 3, 4].map((id) => ({ id, name: `n${id}`, note: null })),
      });
      const res = await a.deleteRows?.({
        table,
        identities: [{ id: 2 }, { id: 4 }],
      });
      expect(res?.affectedRows).toBe(2);
      const rows = await rowsOf(a, table);
      expect(rows.map((r) => Number(r.id))).toEqual([1, 3]);
    });
  });

  it('deleteRows tolerates identities that match nothing', async () => {
    const table = uniqueTable('b_delmiss');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      await a.insertRows?.({ table, rows: [{ id: 1, name: 'a' }] });
      const res = await a.deleteRows?.({
        table,
        identities: [{ id: 99 }, { id: 1 }],
      });
      expect(res?.affectedRows).toBe(1);
      expect(await rowsOf(a, table)).toHaveLength(0);
    });
  });

  it('deleteRows on an empty list is a no-op', async () => {
    const table = uniqueTable('b_delempty');
    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, table);
      await a.insertRows?.({ table, rows: [{ id: 1 }] });
      const res = await a.deleteRows?.({ table, identities: [] });
      expect(res?.affectedRows).toBe(0);
      expect(await rowsOf(a, table)).toHaveLength(1);
    });
  });

  it('batched and per-row paths produce identical tables', async () => {
    const viaLoop = uniqueTable('b_loop');
    const viaBatch = uniqueTable('b_batch');
    const data = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `name-${i}`,
      note: i % 3 === 0 ? null : `note-${i}`,
    }));

    await withAdapter(engine, async (a) => {
      await makeTable(a, engine, viaLoop);
      await makeTable(a, engine, viaBatch);

      for (const row of data) {
        await a.upsertRow({ table: viaLoop, values: row, keyColumns: ['id'] });
      }
      await a.upsertRows?.({ table: viaBatch, keyColumns: ['id'], rows: data });

      expect(await rowsOf(a, viaBatch)).toEqual(await rowsOf(a, viaLoop));
    });
  });
});

describe('composite keys and chunking', () => {
  it('upsertRows and deleteRows handle composite keys (postgres)', async () => {
    const table = uniqueTable('b_comp');
    await withAdapter('postgres', async (a) => {
      await a.createTable({
        table,
        columns: [
          { name: 'tenant', type: 'text', nullable: false, primaryKey: true },
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'name', type: 'text', nullable: true },
        ],
      });
      created.push({ engine: 'postgres', table });

      await a.upsertRows?.({
        table,
        keyColumns: ['tenant', 'id'],
        rows: [
          { tenant: 't1', id: 1, name: 'a' },
          { tenant: 't2', id: 1, name: 'b' },
        ],
      });
      // same id, different tenant → both survive
      let res = await a.browse({ table, limit: 100, offset: 0 });
      expect(res.rows).toHaveLength(2);

      // updating one composite key must not touch the other
      await a.upsertRows?.({
        table,
        keyColumns: ['tenant', 'id'],
        rows: [{ tenant: 't1', id: 1, name: 'changed' }],
      });
      res = await a.browse({ table, limit: 100, offset: 0 });
      expect(res.rows).toHaveLength(2);
      expect(res.rows.find((r) => r.tenant === 't1')?.name).toBe('changed');
      expect(res.rows.find((r) => r.tenant === 't2')?.name).toBe('b');

      await a.deleteRows?.({ table, identities: [{ tenant: 't2', id: 1 }] });
      res = await a.browse({ table, limit: 100, offset: 0 });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]?.tenant).toBe('t1');
    });
  });

  it('splits a batch that exceeds the driver bind-parameter cap', async () => {
    // SQLite caps binds at 32766. 40 columns => ~819 rows per statement, so
    // 2500 rows must span multiple statements and still land exactly once.
    const table = uniqueTable('b_chunk');
    const extra = Array.from({ length: 37 }, (_, i) => `c${i}`);
    const total = 2500;

    await withAdapter('sqlite', async (a) => {
      await makeTable(a, 'sqlite', table, extra);
      const rows = Array.from({ length: total }, (_, i) => {
        const row: Record<string, unknown> = {
          id: i + 1,
          name: `n${i}`,
          note: `x${i}`,
        };
        for (const c of extra) row[c] = `${c}-${i}`;
        return row;
      });
      const res = await a.insertRows?.({ table, rows });
      expect(res?.affectedRows).toBe(total);

      const all = await a.browse({ table, limit: 10_000, offset: 0 });
      expect(all.rows).toHaveLength(total);

      // and the same again through upsert, which must not duplicate
      await a.upsertRows?.({ table, keyColumns: ['id'], rows });
      const after = await a.browse({ table, limit: 10_000, offset: 0 });
      expect(after.rows).toHaveLength(total);
    });
  });

  it('deleteRows splits large identity lists too', async () => {
    const table = uniqueTable('b_delchunk');
    await withAdapter('sqlite', async (a) => {
      await makeTable(a, 'sqlite', table);
      const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1 }));
      await a.insertRows?.({ table, rows });
      const res = await a.deleteRows?.({ table, identities: rows });
      expect(res?.affectedRows).toBe(5000);
      const all = await a.browse({ table, limit: 10, offset: 0 });
      expect(all.rows).toHaveLength(0);
    });
  });
  it('splits large COMPOSITE-key deletes without blowing expression depth', async () => {
    // the OR-of-ANDs form is a deep expression tree; SQLite rejects past depth
    // 1000, so this must be chunked by clause count, not just by bind count
    const table = uniqueTable('b_delcomp');
    await withAdapter('sqlite', async (a) => {
      await a.createTable({
        table,
        columns: [
          { name: 'tenant', type: 'TEXT', nullable: false, primaryKey: true },
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        ],
      });
      created.push({ engine: 'sqlite', table });

      const rows = Array.from({ length: 1500 }, (_, i) => ({
        tenant: `t${i % 3}`,
        id: i + 1,
      }));
      await a.insertRows?.({ table, rows });
      const res = await a.deleteRows?.({ table, identities: rows });
      expect(res?.affectedRows).toBe(1500);
      const all = await a.browse({ table, limit: 10, offset: 0 });
      expect(all.rows).toHaveLength(0);
    });
  });
});

describe('test connections cover every batched engine', () => {
  it('has a connection for each engine under test', () => {
    for (const e of ENGINES) expect(TEST_CONNECTIONS[e]).toBeTruthy();
  });
});
