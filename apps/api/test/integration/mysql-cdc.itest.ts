/**
 * MySQL binlog CDC against a real MySQL 8.0 with GTID mode on.
 *
 * Beyond propagation, this covers the server-identity guard. Binlog file and
 * position are only meaningful on the server that issued them, so a cursor
 * carries the server's uuid and a resume against a DIFFERENT server must fail
 * loudly rather than silently read the wrong offsets — which is what would
 * happen after a failover.
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

async function mysqlSourceBridge(): Promise<SyncSetup> {
  const src = await connectionFor(app, 'mysql');
  const dst = await connectionFor(app, 'postgres');
  return makeBridge(app, {
    sourceEngine: 'mysql',
    destEngine: 'postgres',
    sourceConnId: src,
    destConnId: dst,
    cleanups,
  });
}

/** the newest job row for a bridge, which carries the persisted cursor */
async function latestJob(bridgeId: string): Promise<any> {
  return app.prisma.bridgeJob.findFirst({
    where: { bridgeId },
    orderBy: { startedAt: 'desc' },
  });
}

describe('mysql binlog -> postgres', () => {
  let s: SyncSetup;

  beforeAll(async () => {
    s = await mysqlSourceBridge();
  }, 120_000);

  it('propagates insert, update and delete', async () => {
    await withAdapter('mysql', (a) =>
      a.insertRow({ table: s.sourceTable, values: { id: 1, name: 'alpha' } }),
    );
    await waitFor('insert', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 && r[0]?.name === 'alpha' ? r : null;
    });

    await withAdapter('mysql', (a) =>
      a.updateRow({
        table: s.sourceTable,
        identity: { id: 1 },
        changes: { name: 'beta' },
      }),
    );
    await waitFor('update', async () => {
      const r = await destRows('postgres', s.destTable);
      return r[0]?.name === 'beta' ? r : null;
    });

    await withAdapter('mysql', (a) =>
      a.deleteRow({ table: s.sourceTable, identity: { id: 1 } }),
    );
    await waitFor('delete', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 0 ? true : null;
    });
    expect(await destRows('postgres', s.destTable)).toHaveLength(0);
  });

  it('delivers a burst exactly once', async () => {
    const total = 300;
    await withAdapter('mysql', (a) =>
      a.insertRows!({
        table: s.sourceTable,
        rows: Array.from({ length: total }, (_, i) => ({
          id: i + 1000,
          name: `b${i}`,
        })),
      }),
    );
    const rows = await waitFor(
      `${total} rows`,
      async () => {
        const r = await destRows('postgres', s.destTable);
        return r.length === total ? r : null;
      },
      { timeoutMs: 120_000 },
    );
    expect(new Set(rows.map((r) => Number(r.id))).size).toBe(total);
  });

  it('records the server uuid and a real GTID on the cursor', async () => {
    const job = await latestJob(s.bridgeId);
    expect(job.cursorJson).toBeTruthy();
    const cursor = JSON.parse(job.cursorJson).cursor as string;
    // the identity-carrying form is JSON
    expect(cursor.startsWith('{')).toBe(true);
    const parsed = JSON.parse(cursor);
    expect(typeof parsed.u).toBe('string');
    expect(parsed.u.length).toBeGreaterThan(0);
    // matches what the server reports for itself
    const live = await withAdapter('mysql', (a) =>
      a.query('SELECT @@server_uuid AS uuid'),
    );
    expect(parsed.u).toBe((live.rows[0] as { uuid: string }).uuid);
    // GTID mode is on in the test server, so a GTID must have been captured
    expect(typeof parsed.g).toBe('string');
    expect(parsed.g).toMatch(/^[0-9a-f-]{36}:\d+$/);
  });
});

describe('server-identity guard', () => {
  it('refuses to resume when the cursor came from another server', async () => {
    const s = await mysqlSourceBridge();
    await withAdapter('mysql', (a) =>
      a.insertRow({ table: s.sourceTable, values: { id: 1, name: 'x' } }),
    );
    await waitFor('first row', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 ? r : null;
    });

    await app.cdc.stop(s.bridgeId);

    // rewrite the stored cursor as if it had been produced by a different
    // server — exactly the state a failover leaves behind
    const job = await latestJob(s.bridgeId);
    const cursor = JSON.parse(job.cursorJson).cursor as string;
    const tampered = JSON.stringify({
      ...JSON.parse(cursor),
      u: '00000000-1111-2222-3333-444444444444',
    });
    await app.prisma.bridgeJob.update({
      where: { id: job.id },
      data: { cursorJson: JSON.stringify({ cursor: tampered }) },
    });

    await expect(app.cdc.start(s.bridgeId)).rejects.toThrow(
      /came from MySQL server .* but the connection now reaches/i,
    );
  });

  it('resumes normally when the server is unchanged', async () => {
    const s = await mysqlSourceBridge();
    await withAdapter('mysql', (a) =>
      a.insertRow({ table: s.sourceTable, values: { id: 1, name: 'one' } }),
    );
    await waitFor('first row', async () => {
      const r = await destRows('postgres', s.destTable);
      return r.length === 1 ? r : null;
    });

    await app.cdc.stop(s.bridgeId);
    await withAdapter('mysql', (a) =>
      a.insertRow({ table: s.sourceTable, values: { id: 2, name: 'two' } }),
    );
    await app.cdc.start(s.bridgeId);

    const rows = await waitFor(
      'row written while stopped',
      async () => {
        const r = await destRows('postgres', s.destTable);
        return r.length === 2 ? r : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2]);
  });
});
