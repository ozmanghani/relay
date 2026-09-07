/**
 * event-based ("CDC") bridges, engine-agnostic orchestrator.
 *
 * each engine captures changes differently (Postgres logical replication, MySQL
 * binlog, MongoDB change streams, Redis keyspace notifications); that variation
 * lives behind the {@link CdcProvider} interface. this service is the shared
 * machinery around them: pick the provider for a connection's engine, manage the
 * job lifecycle (one resumable job per bridge), and runs the per-change pipeline
 * (dedupe replays, render, deliver, record, persist the cursor).
 *
 * a held streaming connection per active bridge lives in `streams`. durable
 * engines (pg/mysql/mongo) persist a cursor so a restart resumes exactly; Redis
 * is real-time only (see {@link RedisCdcProvider}).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  type CdcOperation,
  type CdcReadiness,
  type CdcReadinessDTO,
  type ConnectionConfig,
  type DatabaseEngine,
  type BridgeJob,
} from '@syncle/core';
import { randomUUID } from 'node:crypto';
import { AdapterPoolService } from '../connections/adapter-pool.service';
import { ConnectionStoreService } from '../connections/connection-store.service';
import { PrismaService } from '../common/prisma.service';
import { runtimeConfig } from '../common/runtime-config';
import { BridgeJobService } from './bridge-job.service';
import { BridgeStoreService } from './bridge-store.service';
import { BridgeSinkService } from './bridge-sink.service';
import type { ResolvedBridge } from './bridges.types';
import {
  CDC_PROVIDERS,
  type CdcChange,
  type CdcProvider,
  type CdcStreamHandle,
} from './cdc/cdc-provider';
import { rowMatchesFilters } from './cdc/filter-match';

/** live runtime state for one active CDC stream */
interface Stream {
  handle: CdcStreamHandle;
  provider: CdcProvider;
  jobId: string;
  seq: number;
  /** highest cursor already processed, guards against replay dupes on reconnect */
  watermark: string | null;
  /**
   * per-bridge serialization chain: providers may emit concurrently (Redis fires
   * events fire-and-forget), but changes for one bridge must process strictly in
   * order or concurrent handlers would reuse the same sequence number
   */
  pending: Promise<void>;
  /** the source's primary-key columns, so rowKeys stores keys, not every value */
  primaryKey: string[] | null;
  /** changes accepted but not yet delivered; flushed as ONE delivery */
  buffer: Buffered[];
  /** the operation every buffered change shares; a different op forces a flush */
  bufferOp: CdcOperation | null;
  /** key signatures already in the buffer, so one batch never repeats a key */
  bufferKeys: Set<string>;
  /** linger timer, so a partial batch still leaves promptly */
  timer: ReturnType<typeof setTimeout> | null;
  /** rows per delivery for this bridge */
  maxBatch: number;
  /** the resolved bridge, so a flush needs no extra arguments */
  bridge: ResolvedBridge;
}

/** one change held in the pending batch */
interface Buffered {
  change: CdcChange;
  row: Record<string, unknown>;
  /** identity of the row within this batch, or null when there is no key */
  keySig: string | null;
}

/** read the persisted resume cursor from a job's cursorJson (legacy `lsn` ok) */
function readCursor(cursorJson: string | null): string | null {
  if (!cursorJson) return null;
  try {
    const o = JSON.parse(cursorJson) as { cursor?: string; lsn?: string };
    return o.cursor ?? o.lsn ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class BridgeCdcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BridgeCdc');
  private readonly streams = new Map<string, Stream>();
  private readonly providers = new Map<DatabaseEngine, CdcProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BridgeStoreService,
    private readonly connStore: ConnectionStoreService,
    private readonly pool: AdapterPoolService,
    private readonly sink: BridgeSinkService,
    private readonly jobs: BridgeJobService,
    @Inject(CDC_PROVIDERS) providers: CdcProvider[],
  ) {
    for (const p of providers) this.providers.set(p.engine, p);
  }

  private providerFor(engine: DatabaseEngine): CdcProvider | null {
    return this.providers.get(engine) ?? null;
  }

  /* ----- readiness, drives the builder's setup panel ----- */

  async readiness(dto: CdcReadinessDTO): Promise<CdcReadiness> {
    const conn = await this.connStore.resolve(dto.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      return {
        engine: conn.engine,
        supported: false,
        ready: false,
        checks: [],
        instructions: [
          `Event-based (CDC) delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
        ],
      };
    }
    return provider.readiness(dto, conn);
  }

  /* ----- start / stop ----- */

  async start(bridgeId: string): Promise<BridgeJob> {
    const bridge = await this.store.resolve(bridgeId);
    if (bridge.trigger.kind !== 'cdc') {
      throw new BadRequestError('This bridge is not configured for event-based delivery.');
    }
    if (bridge.source.kind !== 'table') {
      throw new BadRequestError('Event-based bridges must read from a table.');
    }
    const conn = await this.connStore.resolve(bridge.source.connectionId);
    const provider = this.providerFor(conn.engine);
    if (!provider) {
      throw new BadRequestError(
        `Event-based delivery isn't available for ${conn.engine}. Use the polling trigger instead.`,
      );
    }

    const active = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['queued', 'running', 'canceling'] } },
    });
    if (active) throw new ConflictError('This bridge is already running. Stop it first.');

    const ready = await provider.readiness(
      {
        connectionId: bridge.source.connectionId,
        database: bridge.source.database,
        schema: bridge.source.schema,
        table: bridge.source.table,
      },
      conn,
    );
    if (!ready.ready) {
      throw new BadRequestError(
        `${conn.engine} isn't ready for event-based delivery. ${ready.instructions.join(' ')}`,
      );
    }

    await provider.provision(bridgeId, bridge, conn);

    // one job per bridge: resume the existing (paused) job in place rather than
    // spawning a new one. durable engines keep their cursor so it continues cleanly
    const latest = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId },
      orderBy: { startedAt: 'desc' },
    });
    const job = latest
      ? await this.prisma.bridgeJob.update({
          where: { id: latest.id },
          data: { status: 'running', error: null, finishedAt: null },
        })
      : await this.prisma.bridgeJob.create({
          data: {
            id: randomUUID(),
            bridgeId,
            status: 'running',
            configSnapshotJson: await this.store.snapshotJson(bridgeId),
            cursorOffset: 0,
            totalCount: null,
          },
        });

    await this.beginStream(bridgeId, bridge, conn, provider, job.id, job.cursorOffset, readCursor(job.cursorJson));
    this.logger.log(`Streaming changes for bridge ${bridgeId} (job ${job.id}, ${conn.engine})`);
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** pause: stop the live stream but keep durable state so a resume continues */
  async stop(bridgeId: string): Promise<BridgeJob | null> {
    await this.teardown(bridgeId);
    const job = await this.prisma.bridgeJob.findFirst({
      where: { bridgeId, status: { in: ['running', 'queued', 'canceling'] } },
      orderBy: { startedAt: 'desc' },
    });
    if (!job) return null;
    await this.jobs.finalize(job.id, 'paused');
    return this.jobs.getJob(bridgeId, job.id);
  }

  /** full teardown when a bridge is deleted: stop stream and drop provider state */
  async cleanup(bridgeId: string): Promise<void> {
    await this.teardown(bridgeId);
    try {
      const bridge = await this.store.resolve(bridgeId);
      if (bridge.source.kind !== 'table') return;
      const conn = await this.connStore.resolve(bridge.source.connectionId);
      const provider = this.providerFor(conn.engine);
      await provider?.deprovision(bridgeId, bridge, conn).catch(() => undefined);
    } catch {
      /* bridge/connection already gone, nothing to deprovision */
    }
  }

  /** close every streaming connection on shutdown, no zombie streamers */
  async onModuleDestroy(): Promise<void> {
    for (const bridgeId of [...this.streams.keys()]) {
      await this.teardown(bridgeId);
    }
  }

  private async teardown(bridgeId: string): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return;
    // let the in-flight chain settle so a half-built batch is not abandoned
    // mid-flush, then drop the entry so nothing new is accepted
    await stream.pending.catch(() => undefined);
    this.streams.delete(bridgeId);
    if (stream.timer) clearTimeout(stream.timer);
    // buffered-but-undelivered changes were never acked, so they would replay
    // on resume anyway; flushing here just avoids the needless repeat
    await this.flush(bridgeId, stream).catch(() => undefined);
    await stream.handle.stop().catch(() => undefined);
  }

  /* ----- the shared change pipeline ----- */

  private async beginStream(
    bridgeId: string,
    bridge: ResolvedBridge,
    conn: ConnectionConfig,
    provider: CdcProvider,
    jobId: string,
    startSeq: number,
    startCursor: string | null,
  ): Promise<void> {
    // two live streams for one bridge would double-deliver every change
    if (this.streams.has(bridgeId)) {
      throw new ConflictError('This bridge already has a live stream. Stop it first.');
    }
    const stream: Stream = {
      handle: { stop: async () => undefined },
      provider,
      jobId,
      seq: startSeq,
      watermark: startCursor,
      pending: Promise.resolve(),
      primaryKey: await this.resolvePrimaryKey(bridge),
      buffer: [],
      bufferOp: null,
      bufferKeys: new Set(),
      timer: null,
      // a database destination may batch freely: writes are idempotent upserts
      // keyed by column, so N-at-once is indistinguishable from N one-at-a-time.
      // an HTTP destination must keep delivery.batchSize, because there the
      // batch size IS the payload the receiver sees.
      maxBatch:
        bridge.destination.kind === 'database'
          ? Math.max(1, runtimeConfig.cdcBatchSize)
          : Math.max(1, bridge.delivery.batchSize),
      bridge,
    };
    this.streams.set(bridgeId, stream);

    let handle: CdcStreamHandle;
    try {
      handle = await provider.startStream({
        bridgeId,
        bridge,
        conn,
        fromCursor: startCursor,
        handlers: {
          onChange: (change) => this.handleChange(bridgeId, bridge, change),
          onError: (err) => this.logger.warn(`CDC stream error for ${bridgeId}: ${err.message}`),
        },
      });
    } catch (err) {
      // a failed start must not strand the job as 'running' behind a dead
      // placeholder (that would be a permanent ConflictError on retry)
      if (this.streams.get(bridgeId) === stream) this.streams.delete(bridgeId);
      await this.jobs.finalize(jobId, 'failed', (err as Error).message).catch(() => undefined);
      throw err;
    }
    // stop() may have raced us during startStream: it removed the entry and
    // "stopped" the placeholder, so close the real handle instead of leaking it
    if (this.streams.get(bridgeId) !== stream) {
      await handle.stop().catch(() => undefined);
      return;
    }
    // the provider may have already begun emitting, only replace the placeholder
    stream.handle = handle;
  }

  /** the source's primary-key columns (best-effort), cached on the stream */
  private async resolvePrimaryKey(bridge: ResolvedBridge): Promise<string[] | null> {
    if (bridge.source.kind !== 'table') return null;
    const src = bridge.source;
    try {
      const page = await this.pool.withAdapter(src.connectionId, src.database, (a) =>
        a.browse({ schema: src.schema, table: src.table, limit: 1, offset: 0 }),
      );
      return page.primaryKey.length ? page.primaryKey : null;
    } catch {
      return null; // unknown, deliveries fall back to null rowKeys
    }
  }

  /**
   * providers may emit concurrently (Redis resolves values out-of-band), so
   * changes for one bridge are queued onto the stream's promise chain and
   * processed strictly in order. returning the chain tail keeps backpressure
   * intact for providers that await onChange.
   */
  private handleChange(bridgeId: string, bridge: ResolvedBridge, change: CdcChange): Promise<void> {
    const stream = this.streams.get(bridgeId);
    if (!stream) return Promise.resolve();
    stream.pending = stream.pending
      .then(() => this.accept(bridgeId, bridge, stream, change))
      .catch((err) => {
        // accept() handles its own failures; this only guards the chain
        this.logger.error(`CDC change chain broke for ${bridgeId}: ${(err as Error).message}`);
      });
    return stream.pending;
  }

  /** identity of a row within a batch, or null when the source has no key */
  private keySignature(stream: Stream, row: Record<string, unknown>): string | null {
    if (!stream.primaryKey?.length) return null;
    try {
      return JSON.stringify(stream.primaryKey.map((c) => row[c]));
    } catch {
      return null;
    }
  }

  /**
   * take one change: drop replays, handle filtered rows, otherwise add it to
   * the pending batch and flush when the batch is complete.
   */
  private async accept(
    bridgeId: string,
    bridge: ResolvedBridge,
    stream: Stream,
    change: CdcChange,
  ): Promise<void> {
    // the stream may have been stopped/replaced while queued behind the chain
    if (this.streams.get(bridgeId) !== stream || bridge.source.kind !== 'table') return;
    // strict exactly-once: never re-process a position we've already done
    // (durable engines replay from the last acked cursor after a reconnect)
    if (!stream.provider.cursorAfter(change.cursor, stream.watermark)) return;

    const op = change.op as CdcOperation;

    // source filters: replay pushes them into SQL, but a CDC stream sees every
    // row of the table, so evaluate them in-process here. skipped rows still
    // advance the durable cursor (and the provider's server-side ack point) so
    // a filtered-out backlog never replays on resume or pins WAL on the source.
    // delete images may carry only the key columns, hence passMissingColumns
    if (
      !stream.provider.handlesSourceFilters &&
      !rowMatchesFilters(change.row, bridge.source.filters, {
        passMissingColumns: op === 'delete',
      })
    ) {
      // anything already buffered is ORDERED BEFORE this change, so it has to
      // be delivered first — otherwise advancing the cursor past it would drop
      // those rows on a crash
      await this.flush(bridgeId, stream);
      if (this.streams.get(bridgeId) !== stream) return;
      stream.watermark = change.cursor;
      try {
        await this.prisma.bridgeJob.update({
          where: { id: stream.jobId },
          data: { cursorJson: JSON.stringify({ cursor: change.cursor }) },
        });
        await stream.handle.ack?.(change.cursor);
      } catch {
        /* a replay after a restart just re-evaluates the filter and skips again */
      }
      return;
    }

    const keySig = this.keySignature(stream, change.row);

    // two reasons a change cannot join the current batch: a different operation
    // has no single route through the sink, and a repeated key would make one
    // multi-row upsert touch the same row twice, which Postgres rejects outright
    const conflicts =
      stream.buffer.length > 0 &&
      (stream.bufferOp !== op || (keySig !== null && stream.bufferKeys.has(keySig)));
    if (conflicts) {
      await this.flush(bridgeId, stream);
      if (this.streams.get(bridgeId) !== stream) return;
    }

    stream.buffer.push({ change, row: change.row, keySig });
    stream.bufferOp = op;
    if (keySig !== null) stream.bufferKeys.add(keySig);

    if (stream.buffer.length >= stream.maxBatch) {
      // a full batch is delivered before this returns, so a provider that
      // awaits onChange still feels backpressure and the buffer stays bounded
      await this.flush(bridgeId, stream);
      return;
    }
    this.scheduleFlush(bridgeId, stream);
  }

  /** flush a partial batch after a short linger, so a quiet stream is not stuck */
  private scheduleFlush(bridgeId: string, stream: Stream): void {
    if (stream.timer) return;
    const timer = setTimeout(() => {
      stream.timer = null;
      if (this.streams.get(bridgeId) !== stream) return;
      // queued on the same chain, so a timed flush can never interleave with
      // a change being accepted
      stream.pending = stream.pending
        .then(() => this.flush(bridgeId, stream))
        .catch((err) => {
          this.logger.error(`CDC timed flush failed for ${bridgeId}: ${(err as Error).message}`);
        });
    }, Math.max(0, runtimeConfig.cdcLingerMs));
    // a pending linger must not hold the process open
    timer.unref?.();
    stream.timer = timer;
  }

  /**
   * deliver the pending batch as ONE delivery, then checkpoint once and ack
   * once. per-row work here is what set the old throughput ceiling: a delivery,
   * a delivery record, a cursor write and a source ack for every single row.
   *
   * the cursor advances only after a successful delivery, so a crash mid-batch
   * replays that batch — absorbed by the watermark dedupe and by writes being
   * idempotent upserts.
   */
  private async flush(bridgeId: string, stream: Stream): Promise<void> {
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
    if (stream.buffer.length === 0) return;

    const items = stream.buffer;
    const op = stream.bufferOp ?? undefined;
    stream.buffer = [];
    stream.bufferKeys = new Set();
    stream.bufferOp = null;

    const bridge = stream.bridge;
    if (bridge.source.kind !== 'table') return;

    const rows = items.map((i) => i.row);
    const lastCursor = items[items.length - 1]!.change.cursor;
    const seq = stream.seq;
    const now = new Date().toISOString();
    const pk = stream.primaryKey;
    // one entry per row, matching rowCount — the same shape the batched replay
    // path records
    const rowKeys = pk?.length
      ? items.map((i) => (pk.length === 1 ? i.row[pk[0]!] : pk.map((c) => i.row[c])))
      : null;
    // key on the batch's last cursor (stable per batch) so an at-least-once
    // re-delivery after a reconnect carries the SAME Idempotency-Key
    const idem =
      bridge.destination.kind === 'http' && bridge.destination.idempotency
        ? `${stream.jobId}:${lastCursor}`
        : undefined;
    const signal = new AbortController().signal;

    try {
      // the operation drives both the {{$op}} token (HTTP) and insert/upsert vs
      // delete routing (database destinations)
      const { outcome } = await this.sink.deliver(
        bridge,
        rows,
        { table: bridge.source.table, now, startIndex: seq, op },
        signal,
        idem,
      );

      await this.jobs.recordDelivery(
        stream.jobId,
        { sequence: seq, rowIndex: seq, rowCount: rows.length, rowKeys },
        outcome,
      );
      if (outcome.status === 'failed' && bridge.delivery.onError === 'abort') {
        // stop-on-error: pause the job and stop the stream WITHOUT advancing
        // the watermark or acking, so this batch replays on the next start.
        // teardown happens outside the change chain — the provider's stop()
        // may wait for in-flight handlers (i.e. this very call)
        this.logger.warn(`CDC ${bridgeId}: pausing after a failed delivery (onError=abort)`);
        await this.jobs.finalize(
          stream.jobId,
          'paused',
          'Paused after a failed delivery (onError=abort).',
        );
        setImmediate(() => void this.teardown(bridgeId).catch(() => undefined));
        return;
      }
      stream.seq = seq + 1;
      stream.watermark = lastCursor;
      await this.prisma.bridgeJob.update({
        where: { id: stream.jobId },
        data: { cursorOffset: stream.seq, cursorJson: JSON.stringify({ cursor: lastCursor }) },
      });
      // the checkpoint is durable, so the provider may now advance its
      // server-side ack point (the Postgres slot's confirmed LSN). a missed
      // ack only widens the replay window the watermark dedupe absorbs
      try {
        await stream.handle.ack?.(lastCursor);
      } catch {
        /* best-effort by contract */
      }
    } catch (err) {
      // a transient pipeline error (Prisma/pool hiccup) must leave a trace: the
      // batch becomes a FAILED delivery row, visible in the timeline + retryable
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.jobs.recordDelivery(
          stream.jobId,
          { sequence: seq, rowIndex: seq, rowCount: rows.length, rowKeys },
          {
            status: 'failed',
            httpStatus: null,
            attempts: 1,
            error: message,
            requestBody: null,
            responseBody: null,
            durationMs: 0,
          },
        );
        stream.seq = seq + 1;
        stream.watermark = lastCursor;
        this.logger.warn(`CDC delivery for ${bridgeId} failed and was recorded: ${message}`);
      } catch {
        // can't even record the failure: stop instead of silently acking away
        this.logger.error(
          `CDC pipeline for ${bridgeId} is failing and the failure could not be recorded — stopping the stream: ${message}`,
        );
        await this.teardown(bridgeId).catch(() => undefined);
        await this.jobs.finalize(stream.jobId, 'failed', message).catch(() => undefined);
      }
    }
  }

  /* ----- boot recovery ----- */

  async onModuleInit(): Promise<void> {
    let jobs: { bridgeId: string; id: string; cursorOffset: number; cursorJson: string | null }[];
    try {
      jobs = await this.prisma.bridgeJob.findMany({
        where: { status: 'running' },
        select: { bridgeId: true, id: true, cursorOffset: true, cursorJson: true },
      });
    } catch {
      return;
    }
    for (const r of jobs) {
      try {
        const bridge = await this.store.resolve(r.bridgeId);
        if (bridge.trigger.kind !== 'cdc' || !bridge.enabled || bridge.source.kind !== 'table') continue;
        const conn = await this.connStore.resolve(bridge.source.connectionId);
        const provider = this.providerFor(conn.engine);
        if (!provider) continue;
        await provider.provision(r.bridgeId, bridge, conn).catch(() => undefined);
        await this.beginStream(r.bridgeId, bridge, conn, provider, r.id, r.cursorOffset, readCursor(r.cursorJson));
        this.logger.log(`Resumed CDC stream for bridge ${r.bridgeId} (${conn.engine})`);
      } catch (err) {
        this.logger.warn(`Could not resume CDC ${r.bridgeId}: ${(err as Error).message}`);
      }
    }
  }
}
