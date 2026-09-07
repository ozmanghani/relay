/**
 * Baseline: every engine in the test stack is reachable through its real
 * adapter and can round-trip a row. If this fails, nothing else in the suite
 * means anything, so it runs first and fails loudly.
 */
import 'reflect-metadata';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_CONNECTIONS, uniqueTable, withAdapter } from './harness';

describe('engine connectivity', () => {
  it('pings every engine', async () => {
    // ping() resolves with no value; throwing is the failure signal
    for (const engine of Object.keys(TEST_CONNECTIONS)) {
      await expect(
        withAdapter(engine, (a) => a.ping()),
        `${engine} ping`,
      ).resolves.not.toThrow();
    }
  });
});

describe('postgres round-trip', () => {
  const table = uniqueTable('it_pg');

  afterAll(async () => {
    await withAdapter('postgres', (a) => a.dropTable(table)).catch(() => undefined);
  });

  it('creates, inserts and reads back', async () => {
    await withAdapter('postgres', async (a) => {
      await a.createTable({
        table,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'name', type: 'text', nullable: true },
        ],
      });
      await a.insertRow({ table, values: { id: 1, name: 'alpha' } });
      const res = await a.browse({ table, limit: 10, offset: 0 });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ id: 1, name: 'alpha' });
    });
  });
});

describe('mysql round-trip', () => {
  const table = uniqueTable('it_my');

  afterAll(async () => {
    await withAdapter('mysql', (a) => a.dropTable(table)).catch(() => undefined);
  });

  it('creates, inserts and reads back', async () => {
    await withAdapter('mysql', async (a) => {
      await a.createTable({
        table,
        columns: [
          { name: 'id', type: 'int', nullable: false, primaryKey: true },
          { name: 'name', type: 'varchar(255)', nullable: true },
        ],
      });
      await a.insertRow({ table, values: { id: 1, name: 'alpha' } });
      const res = await a.browse({ table, limit: 10, offset: 0 });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ id: 1, name: 'alpha' });
    });
  });
});

describe('mongodb round-trip', () => {
  const table = uniqueTable('it_mg');

  afterAll(async () => {
    await withAdapter('mongodb', (a) => a.dropTable(table)).catch(() => undefined);
  });

  it('inserts and reads back a document', async () => {
    await withAdapter('mongodb', async (a) => {
      await a.insertRow({ table, values: { _id: 'a1', name: 'alpha' } });
      const res = await a.browse({ table, limit: 10, offset: 0 });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ name: 'alpha' });
    });
  });
});
