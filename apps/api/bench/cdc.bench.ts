/**
 * End-to-end change data capture: a row committed on a source database, read
 * from that database's own change log, and written to a destination — measured
 * from the moment the writes begin until the last row has landed.
 *
 * The mode comes from BENCH_MODE, because the settings under test are read once
 * at import: the runner invokes this file several times with different
 * environments and each pass contributes its rows to the same suite.
 *
 *   per-row  SYNCLE_CDC_BATCH_SIZE=1   — the path before batching
 *   batched  (defaults)                — batching on, spool off
 *   spool    SYNCLE_CDC_SPOOL=on       — batching on, durable spool on
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  bootstrapApp,
  connectionFor,
  makeBridge,
  type AppHandle,
} from '../test/integration/app-harness';
import { TEST_CONNECTIONS, waitFor, withAdapter } from '../test/integration/harness';
import { bootstrapDrivers, createAdapter } from '@syncle/core/adapters';
import { MongoClient } from 'mongodb';
import {
  captureEnvironment,
  makeResult,
  publishSuite,
  resourceDetail,
  ResourceSampler,
  type BenchResult,
} from './harness';

type Engine = 'postgres' | 'mysql';
/** destinations use their own databases — see TEST_CONNECTIONS for why */
type Dest = 'postgres_dest' | 'mysql_dest' | 'mongodb';

const MODE = (process.env.BENCH_MODE ?? 'batched') as 'per-row' | 'batched' | 'spool';
/** the unbatched path is ~50x slower, so it is measured at a smaller volume */
const ROWS = Number(process.env.BENCH_ROWS ?? (MODE === 'per-row' ? 20_000 : 1_000_000));
const CHUNK = 25_000;

let app: AppHandle;
let mongo: MongoClient | null = null;
const results: BenchResult[] = [];

/**
 * Document count. `exact` runs countDocuments, which is a COLLECTION SCAN —
 * fine once at the end, ruinous as a progress check: polling it every 100ms
 * against a growing collection had MongoDB scanning hundreds of thousands of
 * documents continuously while it was being measured, which distorts the
 * result and contributed to an OOM. Progress uses the O(1) metadata estimate
 * instead, and the exact count is taken once, at the end.
 */
async function mongoCount(collection: string, exact = false): Promise<number> {
  const conn = TEST_CONNECTIONS.mongodb!;
  mongo ??= await new MongoClient(
    `mongodb://${conn.host}:${conn.port}/?directConnection=true`,
  ).connect();
  const c = mongo.db(conn.database).collection(collection);
  return exact ? c.countDocuments() : c.estimatedDocumentCount();
}
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
}, 300_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await mongo?.close().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  publishSuite(
    {
      id: 'cdc-throughput',
      name: 'Change data capture, end to end',
      description:
        'A row is committed on the source, picked up from that database’s own ' +
        'change log (Postgres logical replication, MySQL binlog) and written to ' +
        'the destination. Timing starts when the writes begin and stops when the ' +
        'last row has landed, so it includes reading the log, delivery and the ' +
        'destination write. Every run is verified complete and duplicate-free ' +
        'before its time is recorded.',
      results,
    },
    await captureEnvironment(),
  );
});

/** run one source → destination pass and record it */
async function measure(source: Engine, dest: Dest, label: string): Promise<void> {
  console.log(`  → ${label}: preparing bridge…`);
  const srcConn = await connectionFor(app, source);
  const dstConn = await connectionFor(app, dest);
  const s = await makeBridge(app, {
    sourceEngine: source,
    destEngine: dest,
    sourceConnId: srcConn,
    destConnId: dstConn,
    cleanups,
  });

  let peakSpool = 0;
  let spool: any = null;
  if (MODE === 'spool') {
    const { CdcSpoolService } = await import('../src/bridges/cdc/cdc-spool.service');
    spool = app.ctx.get(CdcSpoolService);
    cleanups.push(() => spool.clear(s.bridgeId).catch(() => undefined));
  }
  const watch = spool
    ? setInterval(() => {
        void spool
          .depth(s.bridgeId)
          .then((d: number) => {
            if (d > peakSpool) peakSpool = d;
          })
          .catch(() => undefined);
      }, 200)
    : null;

  const sampler = new ResourceSampler();
  sampler.start();
  // ONE long-lived connection for polling. Opening a fresh adapter per poll
  // (which withAdapter does) costs a connect and a close every time — on
  // Postgres that dominated the measurement and made a 0.2s sync look like 60s.
  bootstrapDrivers();
  const probe = createAdapter(TEST_CONNECTIONS[dest]!);
  await probe.connect();
  // An EXACT count. browse()'s total is an estimate on MySQL — it reads
  // information_schema.table_rows, which the adapter honestly flags as
  // estimated — so waiting for it to equal the row count never succeeds.
  const landedCount = async (): Promise<number> => {
    try {
      if (dest === 'mongodb') return await mongoCount(s.destTable);
      const q = dest.startsWith('mysql') ? '`' : '"';
      const res = await probe.query(`SELECT COUNT(*) AS c FROM ${q}${s.destTable}${q}`);
      return Number(Object.values(res.rows[0] ?? {})[0] ?? 0);
    } catch {
      return 0; // the sink creates the target on first write
    }
  };

  console.log(`  → ${label}: writing ${ROWS} rows…`);
  const started = performance.now();
  for (let start = 0; start < ROWS; start += CHUNK) {
    const size = Math.min(CHUNK, ROWS - start);
    await withAdapter(source, (a) =>
      a.insertRows!({
        table: s.sourceTable,
        rows: Array.from({ length: size }, (_, i) => ({
          id: start + i + 1,
          name: `row-${start + i}`,
        })),
      }),
    );
  }
  await waitFor(
    `${ROWS} rows to reach ${dest}`,
    async () => ((await landedCount()) === ROWS ? true : null),
    // Mongo's estimate updates lazily, and every poll is a round trip; a
    // slower cadence measures the pipeline rather than the polling
    { timeoutMs: 3_000_000, intervalMs: dest === 'mongodb' ? 1_000 : 100 },
  );
  const ms = Math.round(performance.now() - started);
  const usage = sampler.stop();
  if (watch) clearInterval(watch);

  // a throughput number is worthless if the data is wrong, so verify first
  const landed =
    dest === 'mongodb' ? await mongoCount(s.destTable, true) : await landedCount();
  await probe.close().catch(() => undefined);
  if (landed !== ROWS) throw new Error(`expected ${ROWS} rows, found ${landed}`);

  const detail: Record<string, string | number> = {
    verified: `${landed} rows, exactly once`,
    ...resourceDetail(usage, [source, dest]),
  };
  if (spool) detail['peak spool depth'] = peakSpool;
  results.push(makeResult(label, ROWS, ms, detail));
  console.log(`  ✓ ${label}: ${ROWS} rows in ${ms}ms (${Math.round(ROWS / (ms / 1000))}/s)`);

  // Stop this bridge before the next scenario starts. A stream left running
  // keeps decoding its source's log, so without this each scenario competes
  // with every scenario before it and the later numbers measure contention
  // rather than throughput.
  await app.cdc.stop(s.bridgeId).catch(() => undefined);
  await app.cdc.cleanup(s.bridgeId).catch(() => undefined);
}

describe(`cdc throughput — ${MODE}`, () => {
  if (MODE === 'per-row') {
    it('postgres to postgres, one delivery per row', async () => {
      await measure('postgres', 'postgres_dest', 'PostgreSQL → PostgreSQL · one delivery per row');
    });
    return;
  }

  if (MODE === 'spool') {
    it('postgres to postgres through the durable spool', async () => {
      await measure('postgres', 'postgres_dest', 'PostgreSQL → PostgreSQL · batched + durable spool');
    });
    return;
  }

  it('postgres to postgres', async () => {
    await measure('postgres', 'postgres_dest', 'PostgreSQL → PostgreSQL · batched');
  });

  it('postgres to mysql', async () => {
    await measure('postgres', 'mysql_dest', 'PostgreSQL → MySQL · batched');
  });

  it('mysql to postgres', async () => {
    await measure('mysql', 'postgres_dest', 'MySQL → PostgreSQL · batched');
  });

  it('postgres to mongodb', async () => {
    await measure('postgres', 'mongodb', 'PostgreSQL → MongoDB · batched');
  });
});
