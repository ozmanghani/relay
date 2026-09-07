/**
 * End-to-end change data capture: a row written to a real source database must
 * appear in a real destination database, through the actual application.
 *
 * This boots the real Nest DI container against the real metadata store and
 * drives the real services — no stubs anywhere. It is the test that gives the
 * CDC pipeline's correctness claims any weight, and the safety net for the
 * throughput work that restructures that pipeline.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { applyTestEnv } from './env';
import { TEST_CONNECTIONS, uniqueTable, waitFor, withAdapter } from './harness';

// env must be in place before the app module is evaluated: runtimeConfig reads
// process.env at import time, so a static import would bind the real .env
applyTestEnv();

let ctx: INestApplicationContext;
let connections: any;
let bridges: any;
let cdc: any;

/** ids of things to tear down, newest first */
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { ConnectionStoreService } = await import(
    '../../src/connections/connection-store.service'
  );
  const { BridgeStoreService } = await import(
    '../../src/bridges/bridge-store.service'
  );
  const { BridgeCdcService } = await import(
    '../../src/bridges/bridge-cdc.service'
  );

  ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  connections = ctx.get(ConnectionStoreService);
  bridges = ctx.get(BridgeStoreService);
  cdc = ctx.get(BridgeCdcService);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await ctx?.close().catch(() => undefined);
});

/** register a source connection in the app for one of the test engines */
async function connectionFor(engine: 'postgres' | 'mysql'): Promise<string> {
  const t = TEST_CONNECTIONS[engine]!;
  const conn = await connections.create({
    name: `it-${engine}-${Date.now()}`,
    engine,
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.database,
  });
  return conn.id;
}

interface SyncSetup {
  bridgeId: string;
  sourceTable: string;
  destTable: string;
}

/**
 * Build a live CDC bridge from a fresh Postgres table into a destination table
 * on `destEngine`, and start it. Returns once the stream is running.
 */
async function startBridge(
  destEngine: 'postgres' | 'mysql',
  sourceConnId: string,
  destConnId: string,
): Promise<SyncSetup> {
  const sourceTable = uniqueTable('src');
  const destTable = uniqueTable('dst');

  await withAdapter('postgres', async (a) => {
    await a.createTable({
      table: sourceTable,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: true },
      ],
    });
  });
  cleanups.push(async () => {
    await withAdapter('postgres', (a) => a.dropTable(sourceTable)).catch(
      () => undefined,
    );
  });
  cleanups.push(async () => {
    await withAdapter(destEngine, (a) => a.dropTable(destTable)).catch(
      () => undefined,
    );
  });

  // parse through the real schema so defaults (delivery, transform, write
  // modes) are applied exactly as the HTTP layer applies them
  const { bridgeInputSchema } = await import('@syncle/core');
  const input = bridgeInputSchema.parse({
    name: `it-bridge-${sourceTable}`,
    source: { kind: 'table', connectionId: sourceConnId, table: sourceTable },
    destination: {
      kind: 'database',
      targets: [
        {
          connectionId: destConnId,
          table: destTable,
          writeMode: 'upsert',
          keyColumns: ['id'],
          createMissingTable: true,
        },
      ],
    },
    transform: { template: '{{$row}}' },
    trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
  });
  const bridge = await bridges.create(input);

  await cdc.start(bridge.id);
  cleanups.push(async () => {
    await cdc.stop(bridge.id).catch(() => undefined);
    await cdc.cleanup(bridge.id).catch(() => undefined);
  });

  return { bridgeId: bridge.id, sourceTable, destTable };
}

/** rows currently in the destination table, sorted by id */
async function destRows(
  engine: 'postgres' | 'mysql',
  table: string,
): Promise<Array<Record<string, unknown>>> {
  return withAdapter(engine, async (a) => {
    try {
      const res = await a.browse({ table, limit: 1000, offset: 0 });
      return [...res.rows].sort((x, y) => Number(x.id) - Number(y.id));
    } catch {
      return []; // table not created yet — the sink creates it on first write
    }
  });
}

describe('postgres -> postgres CDC', () => {
  let setup: SyncSetup;

  beforeAll(async () => {
    const src = await connectionFor('postgres');
    const dst = await connectionFor('postgres');
    setup = await startBridge('postgres', src, dst);
  }, 120_000);

  it('propagates an insert', async () => {
    await withAdapter('postgres', (a) =>
      a.insertRow({ table: setup.sourceTable, values: { id: 1, name: 'alpha' } }),
    );
    const rows = await waitFor('insert to arrive', async () => {
      const r = await destRows('postgres', setup.destTable);
      return r.length === 1 ? r : null;
    });
    expect(rows[0]).toMatchObject({ id: 1, name: 'alpha' });
  });

  it('propagates an update', async () => {
    await withAdapter('postgres', (a) =>
      a.updateRow({
        table: setup.sourceTable,
        identity: { id: 1 },
        changes: { name: 'alpha-updated' },
      }),
    );
    const rows = await waitFor('update to arrive', async () => {
      const r = await destRows('postgres', setup.destTable);
      return r[0]?.name === 'alpha-updated' ? r : null;
    });
    expect(rows).toHaveLength(1);
  });

  it('propagates a delete', async () => {
    await withAdapter('postgres', (a) =>
      a.deleteRow({ table: setup.sourceTable, identity: { id: 1 } }),
    );
    await waitFor('delete to arrive', async () => {
      const r = await destRows('postgres', setup.destTable);
      return r.length === 0 ? true : null;
    });
    expect(await destRows('postgres', setup.destTable)).toHaveLength(0);
  });

  it('propagates a burst of rows, exactly once each', async () => {
    const total = 200;
    await withAdapter('postgres', async (a) => {
      await a.insertRows?.({
        table: setup.sourceTable,
        rows: Array.from({ length: total }, (_, i) => ({
          id: i + 100,
          name: `burst-${i}`,
        })),
      });
    });
    const rows = await waitFor(
      `all ${total} burst rows`,
      async () => {
        const r = await destRows('postgres', setup.destTable);
        return r.length === total ? r : null;
      },
      { timeoutMs: 90_000 },
    );
    // no duplicates: ids must be unique and complete
    const ids = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    expect(new Set(ids).size).toBe(total);
    expect(ids[0]).toBe(100);
    expect(ids[total - 1]).toBe(100 + total - 1);
  });
});

describe('postgres -> mysql CDC (cross engine)', () => {
  let setup: SyncSetup;

  beforeAll(async () => {
    const src = await connectionFor('postgres');
    const dst = await connectionFor('mysql');
    setup = await startBridge('mysql', src, dst);
  }, 120_000);

  it('moves rows across engines', async () => {
    await withAdapter('postgres', (a) =>
      a.insertRow({ table: setup.sourceTable, values: { id: 7, name: 'cross' } }),
    );
    const rows = await waitFor('cross-engine row', async () => {
      const r = await destRows('mysql', setup.destTable);
      return r.length === 1 ? r : null;
    });
    expect(rows[0]).toMatchObject({ id: 7, name: 'cross' });
  });
});
