/**
 * Benchmark setup: the integration setup, plus a hard reset of everything a
 * previous run could have left behind.
 *
 * This is not tidiness, it is measurement validity. A leftover Postgres
 * replication slot stays ACTIVE and keeps retaining WAL, and every slot's
 * decoder has to walk that backlog before it reaches current changes. Five
 * abandoned slots holding 414 MB each turned a sub-second sync into sixty
 * seconds — the run was measuring the debris of earlier runs, not the code.
 */
import { Client } from 'pg';
import { setup as integrationSetup } from '../test/integration/global-setup';

async function pg<T>(fn: (c: Client) => Promise<T>, database = 'syncle_test'): Promise<T | null> {
  const client = new Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database,
  });
  try {
    await client.connect();
    return await fn(client);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function resetPostgres(): Promise<void> {
  await pg(async (c) => {
    // an active slot cannot be dropped, so disconnect its reader first
    await c.query(
      `select pg_terminate_backend(active_pid) from pg_replication_slots
       where slot_name like 'syncle_slot_%' and active_pid is not null`,
    );
    await c.query(
      `select pg_drop_replication_slot(slot_name) from pg_replication_slots
       where slot_name like 'syncle_slot_%'`,
    );
    const pubs = await c.query<{ pubname: string }>(
      `select pubname from pg_publication where pubname like 'syncle_%'`,
    );
    for (const row of pubs.rows) {
      await c.query(`drop publication if exists "${row.pubname}"`);
    }
    // benchmark and integration fixtures, identifiable by their prefixes
    const tables = await c.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'
         and (tablename like 'src\\_%' or tablename like 'dst\\_%'
              or tablename like 'b%\\_%' or tablename like 'it\\_%')`,
    );
    for (const row of tables.rows) {
      await c.query(`drop table if exists "${row.tablename}" cascade`);
    }
    return null;
  });

  // destination fixtures live in their own database
  await pg(async (c) => {
    const tables = await c.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    for (const row of tables.rows) {
      await c.query(`drop table if exists "${row.tablename}" cascade`);
    }
    return null;
  }, 'syncle_dest');
}

/**
 * Clear the app's own metadata store.
 *
 * This is the important one. A job left with status 'running' — which is what a
 * killed run leaves behind — is RESUMED on the next boot by
 * BridgeCdcService.onModuleInit. Its replication slot is long gone, so the
 * stream fails with "replication slot does not exist" and retries on a backoff
 * loop, forever. A handful of those from previous runs is enough to keep the
 * server busy answering doomed START_REPLICATION attempts while the run being
 * measured waits its turn.
 */
async function resetMetadata(): Promise<void> {
  const client = new Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_meta',
  });
  try {
    await client.connect();
    // order matters: deliveries reference jobs, jobs reference bridges
    await client.query('delete from bridge_deliveries');
    await client.query('delete from bridge_jobs');
    await client.query('delete from bridges');
    await client.query('delete from connections');
  } catch {
    /* a fresh stack has no metadata database yet, which is fine */
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function setup(): Promise<void> {
  await integrationSetup();
  // metadata first: it is what stops dead bridges being resurrected
  await resetMetadata();
  await resetPostgres();
}
