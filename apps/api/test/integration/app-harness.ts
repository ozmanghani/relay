/**
 * Boots the real application container and builds real bridges against it.
 * Shared by every end-to-end test so they all exercise the same wiring the
 * server uses in production.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { applyTestEnv } from './env';
import { TEST_CONNECTIONS, uniqueTable, withAdapter } from './harness';

applyTestEnv();

export interface AppHandle {
  ctx: INestApplicationContext;
  connections: any;
  bridges: any;
  cdc: any;
  prisma: any;
}

export async function bootstrapApp(): Promise<AppHandle> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { ConnectionStoreService } = await import(
    '../../src/connections/connection-store.service'
  );
  const { BridgeStoreService } = await import('../../src/bridges/bridge-store.service');
  const { BridgeCdcService } = await import('../../src/bridges/bridge-cdc.service');
  const { PrismaService } = await import('../../src/common/prisma.service');

  const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  return {
    ctx,
    connections: ctx.get(ConnectionStoreService),
    bridges: ctx.get(BridgeStoreService),
    cdc: ctx.get(BridgeCdcService),
    prisma: ctx.get(PrismaService),
  };
}

/** a key into TEST_CONNECTIONS; `*_dest` variants point at a separate database */
export type ConnKey = 'postgres' | 'mysql' | 'mongodb' | 'postgres_dest' | 'mysql_dest';

export async function connectionFor(app: AppHandle, key: ConnKey): Promise<string> {
  const t = TEST_CONNECTIONS[key]!;
  const conn = await app.connections.create({
    name: `it-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    engine: t.engine,
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.database,
  });
  return conn.id;
}

export interface SyncSetup {
  bridgeId: string;
  sourceTable: string;
  destTable: string;
}

/**
 * Create a Postgres source table and a CDC bridge writing into `destEngine`.
 * `start: false` leaves the bridge stopped, for tests that drive start/stop.
 */
export async function makeBridge(
  app: AppHandle,
  opts: {
    destEngine: ConnKey;
    sourceConnId: string;
    destConnId: string;
    cleanups: Array<() => Promise<void>>;
    start?: boolean;
    /** engine the source table lives on; defaults to postgres */
    sourceEngine?: ConnKey;
  },
): Promise<SyncSetup> {
  const { destEngine, sourceConnId, destConnId, cleanups } = opts;
  const sourceEngine = opts.sourceEngine ?? 'postgres';
  const sourceTable = uniqueTable('src');
  const destTable = uniqueTable('dst');

  const srcTypes =
    sourceEngine === 'mysql'
      ? { int: 'int', text: 'varchar(255)' }
      : { int: 'integer', text: 'text' };
  await withAdapter(sourceEngine, (a) =>
    a.createTable({
      table: sourceTable,
      columns: [
        { name: 'id', type: srcTypes.int, nullable: false, primaryKey: true },
        { name: 'name', type: srcTypes.text, nullable: true },
      ],
    }),
  );
  cleanups.push(() =>
    withAdapter(sourceEngine, (a) => a.dropTable(sourceTable)).catch(() => undefined),
  );
  cleanups.push(() =>
    withAdapter(destEngine, (a) => a.dropTable(destTable)).catch(() => undefined),
  );

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
  const bridge = await app.bridges.create(input);

  cleanups.push(async () => {
    await app.cdc.stop(bridge.id).catch(() => undefined);
    await app.cdc.cleanup(bridge.id).catch(() => undefined);
  });

  if (opts.start !== false) await app.cdc.start(bridge.id);
  return { bridgeId: bridge.id, sourceTable, destTable };
}

/** rows in the destination table, sorted by id; [] before the sink creates it */
export async function destRows(
  engine: ConnKey,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  return withAdapter(engine, async (a) => {
    try {
      const res = await a.browse({ table, limit: 5000, offset: 0 });
      return [...res.rows].sort((x, y) => Number(x.id) - Number(y.id));
    } catch {
      return [];
    }
  });
}

/**
 * Row count in the destination. `destRows` pages through `browse`, which is
 * capped (5000 by default), so anything larger must be counted in the engine.
 */
export async function destCount(engine: ConnKey, table: string): Promise<number> {
  return withAdapter(engine, async (a) => {
    try {
      // MongoDB has no COUNT statement here, and its browse total is exact.
      // For SQL engines the total is NOT safe to compare against an expected
      // row count: MySQL derives it from information_schema.table_rows, which
      // is an estimate (the adapter flags it as such), so an equality check
      // against it never becomes true.
      if (engine === 'mongodb') {
        const res = await a.browse({ table, limit: 1, offset: 0 });
        return Number(res.total ?? 0);
      }
      const q = engine.startsWith('mysql') ? '`' : '"';
      const res = await a.query(`SELECT COUNT(*) AS c FROM ${q}${table}${q}`);
      return Number(Object.values(res.rows[0] ?? {})[0] ?? 0);
    } catch {
      return 0; // the sink creates the target on first write
    }
  });
}

/** distinct ids in the destination, to prove exactly-once at volume */
export async function destDistinctIds(
  engine: ConnKey,
  table: string,
): Promise<{ distinct: number; min: number; max: number }> {
  return withAdapter(engine, async (a) => {
    const q = engine.startsWith('mysql') ? '`' : '"';
    const res = await a.query(
      `SELECT COUNT(DISTINCT id) AS d, MIN(id) AS lo, MAX(id) AS hi FROM ${q}${table}${q}`,
    );
    const row = res.rows[0] as { d?: unknown; lo?: unknown; hi?: unknown };
    return {
      distinct: Number(row?.d ?? 0),
      min: Number(row?.lo ?? 0),
      max: Number(row?.hi ?? 0),
    };
  });
}
