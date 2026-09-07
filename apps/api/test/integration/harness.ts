/**
 * Shared plumbing for the integration suite: connection configs pointing at the
 * throwaway engines in docker-compose.test.yml, plus helpers for driving a real
 * adapter and waiting on asynchronous propagation.
 *
 * Ports here intentionally differ from every default so the suite can never
 * touch a developer's real database, the dev stack, or an installed app stack.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapDrivers, createAdapter } from '@syncle/core/adapters';
import type { ConnectionConfig, DatabaseAdapter, DatabaseEngine } from '@syncle/core';

bootstrapDrivers();

const now = new Date().toISOString();

function base(engine: DatabaseEngine, extra: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: `it-${engine}`,
    name: `integration ${engine}`,
    workspaceId: 'it',
    engine,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

export const TEST_CONNECTIONS: Record<string, ConnectionConfig> = {
  postgres: base('postgres', {
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_test',
  }),
  mysql: base('mysql', {
    host: '127.0.0.1',
    port: 53306,
    user: 'root',
    password: 'syncle',
    database: 'syncle_test',
  }),
  mongodb: base('mongodb', {
    host: '127.0.0.1',
    port: 57017,
    database: 'syncle_test',
  }),
  redis: base('redis', { host: '127.0.0.1', port: 56379 }),
  // Destinations live in their OWN databases, which is both realistic and
  // necessary for measurement: a Postgres logical slot is database-scoped, so
  // writing the destination into the source's database makes the source's
  // decoder chew through the destination's WAL as well — a feedback loop that
  // gets worse the more rows you sync.
  postgres_dest: base('postgres', {
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_dest',
  }),
  mysql_dest: base('mysql', {
    host: '127.0.0.1',
    port: 53306,
    user: 'root',
    password: 'syncle',
    database: 'syncle_dest',
  }),
  // file-backed, so it needs no container; a fresh temp file per run
  sqlite: base('sqlite', {
    database: join(mkdtempSync(join(tmpdir(), 'syncle-it-')), 'test.db'),
  }),
};

/** open a real adapter, run `fn`, always disconnect */
export async function withAdapter<T>(
  engine: keyof typeof TEST_CONNECTIONS,
  fn: (a: DatabaseAdapter) => Promise<T>,
): Promise<T> {
  const conn = TEST_CONNECTIONS[engine];
  if (!conn) throw new Error(`no test connection for ${engine}`);
  const adapter = createAdapter(conn);
  await adapter.connect();
  try {
    return await fn(adapter);
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

/** a collision-proof table name, so parallel or repeated runs never clash */
export function uniqueTable(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Poll `check` until it returns a truthy value or the deadline passes. CDC is
 * asynchronous end to end, so assertions have to wait for propagation rather
 * than assume it. Returns the value; throws with `label` on timeout.
 */
export async function waitFor<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
      last = v;
    } catch (err) {
      last = (err as Error).message;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
