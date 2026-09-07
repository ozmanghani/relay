/** server runtime config, resolved once from the environment */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveDataDir(): string {
  const dir = process.env.SYNCLE_DATA_DIR
    ? resolve(process.env.SYNCLE_DATA_DIR)
    : resolve(process.cwd(), '.syncle');
  // 0o700: the dir holds the master key, keep it out of reach of other users
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const dataDir = resolveDataDir();

export const runtimeConfig = {
  dataDir,
  storeFile: resolve(dataDir, 'syncle.db'),
  keyFile: resolve(dataDir, 'master.key'),
  /**
   * first-run setup token, mirrored to disk so the launcher can hand it to the
   * browser instead of making the operator dig it out of the container logs.
   * exists only while the instance has no account.
   */
  setupTokenFile: resolve(dataDir, 'setup-token'),
  masterKey: process.env.SYNCLE_MASTER_KEY ?? null,
  maxQueryRows: Number(process.env.SYNCLE_MAX_QUERY_ROWS ?? 5000),
  poolIdleMs: Number(process.env.SYNCLE_POOL_IDLE_MS ?? 300_000),
  port: Number(process.env.PORT ?? 4000),
  // never fall back to reflecting arbitrary origins: with credentialed CORS
  // that would let any web page the operator visits call this API
  webOrigin: process.env.WEB_ORIGIN
    ? process.env.WEB_ORIGIN.split(',').map((o) => o.trim())
    : `http://localhost:${process.env.WEB_PORT ?? '3002'}`,
  /** Redis URL backing the BullMQ bridge-job queue */
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /**
   * worker concurrency: how many bridge jobs may run in parallel.
   * SYNCLE_HOOK_CONCURRENCY is the legacy name (transition) — still honored
   * so existing deployments keep their setting across the rename.
   */
  jobConcurrency: Number(
    process.env.SYNCLE_JOB_CONCURRENCY ?? process.env.SYNCLE_HOOK_CONCURRENCY ?? 5,
  ),
  /**
   * CDC micro-batching. A change stream delivered one row at a time pays a
   * delivery, a delivery record, a cursor write and a source ack per row, so
   * round trips — not the database — set the ceiling. Consecutive changes are
   * grouped into one delivery instead.
   *
   * This applies to DATABASE destinations only, where a batch is invisible:
   * writes are idempotent upserts keyed by column, so the result is identical.
   * HTTP destinations keep honouring `delivery.batchSize`, because there the
   * batch size is the payload shape and changing it would change what
   * receivers see.
   *
   * Batching widens the at-least-once replay window to at most one batch: a
   * crash mid-batch replays that batch, which the watermark dedupe and
   * idempotent writes absorb. That is the cost of a large batch, and the reason
   * the default is not larger still.
   *
   * 100,000 is measured, not guessed, and one value serves every engine tested.
   * Median rows/sec over FIVE runs of 1,000,000 rows each:
   *
   *              100,000    200,000    300,000
   *   Postgres    83,759     82,604     49,761
   *   MySQL      106,564    100,341          -
   *
   * Two findings worth keeping. 300,000 falls off a cliff — all five runs came
   * in around 50k, and an earlier three-run sample had put it at 78k, so the
   * repetition mattered. And 20,000 (a previous default) measured 54,345 on
   * Postgres: too small hurts far more than too large.
   *
   * It also holds up on a small machine. Under a 512MB heap the curve stays
   * flat (68,776 at 20,000, 73,910 at 100,000, 74,608 at 300,000) with no
   * failures, because what actually bounds memory here is the byte budget
   * below, not the row count.
   */
  cdcBatchSize: Number(process.env.SYNCLE_CDC_BATCH_SIZE ?? 100_000),
  /**
   * Ceiling on the bytes held in one batch. A row cap alone is unsafe: 20,000
   * narrow rows is a few megabytes, but 20,000 wide ones could be gigabytes.
   * The row size is estimated once per batch from its first row — a change
   * stream carries one table's shape, so the rows are homogeneous — and the
   * batch is capped at whichever limit binds first.
   */
  cdcBatchBytes: Number(process.env.SYNCLE_CDC_BATCH_BYTES ?? 64 * 1024 * 1024),
  /** how long a partial batch waits for more changes before being flushed */
  cdcLingerMs: Number(process.env.SYNCLE_CDC_LINGER_MS ?? 50),
  /**
   * Put a durable spool (a Redis Stream) between the change reader and the
   * destination writer. With it on, the source is acknowledged as soon as a
   * change is spooled, so a slow or unreachable destination no longer holds the
   * source's log open — the failure mode where a Postgres slot stops advancing
   * and WAL fills the production database's disk.
   *
   * OFF by default, and deliberately so: while a change sits in the spool it
   * exists ONLY in Redis, so this is safe only where Redis has persistence
   * (appendonly) enabled. That is a durability trade nobody should make by
   * accident.
   */
  cdcSpool: (process.env.SYNCLE_CDC_SPOOL ?? '') === 'on',
  /** cap on unwritten changes held in the spool before the reader is throttled */
  cdcSpoolMax: Number(process.env.SYNCLE_CDC_SPOOL_MAX ?? 50_000),
  /**
   * when true, HTTP destinations may not resolve to loopback/private/link-local
   * addresses (SSRF guard for network-exposed deployments). off by default —
   * Syncle is local-first and posting to localhost services is a primary use.
   * cloud metadata endpoints are blocked regardless of this flag.
   */
  blockPrivateDestinations:
    (process.env.SYNCLE_BLOCK_PRIVATE_DESTINATIONS ?? '') === 'true',
  /** when set, SQLite connections may only open files under this directory */
  sqliteBaseDir: process.env.SYNCLE_SQLITE_DIR
    ? resolve(process.env.SYNCLE_SQLITE_DIR)
    : null,
} as const;

/**
 * parse {@link runtimeConfig.redisUrl} into ioredis connection options for
 * BullMQ. `maxRetriesPerRequest: null` is required by BullMQ's blocking
 * connections. ioredis still reconnects in the background, so a missing Redis
 * never crashes bootstrap, only enqueuing a run fails (with a clear message)
 */
export function redisConnectionOptions(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  maxRetriesPerRequest: null;
} {
  const u = new URL(runtimeConfig.redisUrl);
  const db = u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  return {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null,
  };
}
