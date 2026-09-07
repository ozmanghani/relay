/**
 * Benchmark plumbing: timing, environment capture, and the JSON writer.
 *
 * Everything published on the website comes from this file's output. Nothing is
 * typed by hand, nothing is rounded up, and every record carries the row count
 * and elapsed time it was derived from so a reader can check the arithmetic.
 */
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { withAdapter } from '../test/integration/harness';

/** repo-root benchmarks/results.json — the file the website renders */
export const RESULTS_PATH = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../../benchmarks/results.json',
);

export interface BenchResult {
  /** what was measured, e.g. "upsert 100k rows (batched)" */
  scenario: string;
  /** rows processed end to end */
  rows: number;
  /** wall-clock milliseconds */
  ms: number;
  /** rows per second, derived — never entered by hand */
  rowsPerSec: number;
  /** optional extras: delivery counts, spool depth, comparison baselines */
  detail?: Record<string, string | number>;
}

export interface BenchSuite {
  id: string;
  name: string;
  /** what the suite measures and, where relevant, what it does not */
  description: string;
  results: BenchResult[];
}

export interface BenchReport {
  generatedAt: string;
  /** stated plainly on the page: what these numbers are and are not */
  disclaimer: string;
  environment: Record<string, string>;
  suites: BenchSuite[];
}

/**
 * Every database, Redis and Syncle itself run on ONE machine here, so there is
 * effectively no network between them. That flatters throughput compared with a
 * managed or remote database, where round-trip latency dominates — and it is
 * exactly the reason the batching work matters, so it would be dishonest to
 * publish the figures without saying so.
 */
export const DISCLAIMER =
  'Measured on a single local machine: Syncle, both databases and Redis all run ' +
  'on the same host, in containers, with no network between them. Real ' +
  'deployments put a network in that path, and against a managed or remote ' +
  'database latency — not the database — is usually what sets the pace, so ' +
  'expect lower absolute numbers there. These runs are useful for comparing ' +
  'code paths against each other, not for predicting your production ceiling. ' +
  'Every figure is measured; none is estimated, extrapolated or rounded up.';

/** time `fn`, returning its value and the elapsed wall clock */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - started) };
}

export function makeResult(
  scenario: string,
  rows: number,
  ms: number,
  detail?: Record<string, string | number>,
): BenchResult {
  return {
    scenario,
    rows,
    ms,
    // guard against a zero-millisecond measurement producing Infinity
    rowsPerSec: ms > 0 ? Math.round(rows / (ms / 1000)) : rows,
    ...(detail ? { detail } : {}),
  };
}

/** engine versions, read from the servers themselves rather than assumed */
async function engineVersions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const probes: Array<[string, () => Promise<string>]> = [
    [
      'PostgreSQL',
      () =>
        withAdapter('postgres', async (a) => {
          const r = await a.query('SHOW server_version');
          return String(Object.values(r.rows[0] ?? {})[0] ?? '').split(' ')[0] ?? '';
        }),
    ],
    [
      'MySQL',
      () =>
        withAdapter('mysql', async (a) => {
          const r = await a.query('SELECT VERSION() AS v');
          return String((r.rows[0] as { v?: unknown })?.v ?? '');
        }),
    ],
    [
      'Redis',
      () =>
        withAdapter('redis', async (a) => {
          const r = await a.query('INFO server');
          const text = JSON.stringify(r.rows);
          return /redis_version:([0-9.]+)/.exec(text)?.[1] ?? 'unknown';
        }),
    ],
  ];
  for (const [name, probe] of probes) {
    try {
      out[name] = await probe();
    } catch {
      out[name] = 'unavailable';
    }
  }
  return out;
}

export async function captureEnvironment(): Promise<Record<string, string>> {
  const cores = cpus();
  return {
    Platform: `${platform()} ${release()} (${arch()})`,
    CPU: cores[0]?.model?.trim() ?? 'unknown',
    Cores: String(cores.length),
    Memory: `${Math.round(totalmem() / 1024 ** 3)} GB`,
    Node: process.version,
    ...(await engineVersions()),
    Databases: 'containerised, same machine (docker-compose.test.yml)',
  };
}

/**
 * Merge a suite into the report on disk. Each bench file writes its own suite,
 * so a partial run updates only what it measured and leaves the rest intact.
 */
export function publishSuite(suite: BenchSuite, environment: Record<string, string>): void {
  let report: BenchReport = {
    generatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    environment,
    suites: [],
  };
  try {
    report = JSON.parse(readFileSync(RESULTS_PATH, 'utf8')) as BenchReport;
  } catch {
    /* first run */
  }
  report.generatedAt = new Date().toISOString();
  report.disclaimer = DISCLAIMER;
  report.environment = environment;

  // a suite can be filled in by several runs (each needs different env, since
  // the runtime config is read once at import), so merge by scenario name and
  // let the newest measurement win rather than replacing the whole suite
  const existing = report.suites.find((s) => s.id === suite.id);
  const merged: BenchSuite = existing
    ? {
        ...suite,
        results: [
          ...existing.results.filter(
            (r) => !suite.results.some((n) => n.scenario === r.scenario),
          ),
          ...suite.results,
        ],
      }
    : suite;
  report.suites = [...report.suites.filter((s) => s.id !== suite.id), merged].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`);

  // also to stdout, so a CI log shows what was measured
  console.log(`\n── ${suite.name} ──`);
  for (const r of suite.results) {
    console.log(
      `  ${r.scenario.padEnd(52)} ${String(r.rows).padStart(9)} rows  ${String(r.ms).padStart(7)} ms  ${String(r.rowsPerSec).padStart(8)}/s`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* resource sampling                                                          */
/* -------------------------------------------------------------------------- */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface ResourceUsage {
  /** peak CPU of the Syncle process, as a percentage of ONE core */
  peakProcessCpuPercent: number;
  /** mean CPU of the Syncle process over the run */
  avgProcessCpuPercent: number;
  /** peak resident memory of the Syncle process, MB */
  peakProcessRssMb: number;
  /** peak CPU and memory per database container, from docker stats */
  containers: Record<string, { cpuPercent: number; memoryMb: number }>;
}

/**
 * Samples what a run actually costs, not just how fast it was. Throughput
 * without a resource figure is half a number: a rate bought by pinning every
 * core is a different result from the same rate while mostly idle.
 *
 * The Syncle process is sampled from process.cpuUsage(), which is exact. The
 * databases run in containers, so those come from `docker stats` — sampled at a
 * low frequency because each call costs about a second.
 */
export class ResourceSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dockerTimer: ReturnType<typeof setInterval> | null = null;
  private lastCpu = process.cpuUsage();
  private lastAt = performance.now();
  private samples: number[] = [];
  private peakRss = 0;
  private containers: Record<string, { cpuPercent: number; memoryMb: number }> = {};
  private busy = false;

  start(): void {
    this.lastCpu = process.cpuUsage();
    this.lastAt = performance.now();
    this.samples = [];
    this.peakRss = 0;
    this.containers = {};

    this.timer = setInterval(() => {
      const now = performance.now();
      const delta = process.cpuUsage(this.lastCpu);
      const elapsedMs = now - this.lastAt;
      if (elapsedMs > 0) {
        // cpuUsage is microseconds of CPU time; 100% == one core saturated
        const percent = ((delta.user + delta.system) / 1000 / elapsedMs) * 100;
        this.samples.push(percent);
      }
      this.lastCpu = process.cpuUsage();
      this.lastAt = now;
      const rss = process.memoryUsage().rss / 1024 ** 2;
      if (rss > this.peakRss) this.peakRss = rss;
    }, 50);
    this.timer.unref?.();

    this.dockerTimer = setInterval(() => void this.sampleDocker(), 2_000);
    this.dockerTimer.unref?.();
  }

  /** peak-per-container from `docker stats`; failures are simply not recorded */
  private async sampleDocker(): Promise<void> {
    if (this.busy) return; // a slow call must not queue up behind itself
    this.busy = true;
    try {
      const { stdout } = await exec('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
      ]);
      for (const line of stdout.trim().split('\n')) {
        const [name, cpu, mem] = line.split('\t');
        if (!name?.startsWith('syncle-test-')) continue;
        const cpuPercent = Number((cpu ?? '').replace('%', '')) || 0;
        const memoryMb = parseMemory(mem ?? '');
        const engine = name.replace('syncle-test-', '').replace(/-\d+$/, '');
        const prev = this.containers[engine];
        this.containers[engine] = {
          cpuPercent: Math.max(prev?.cpuPercent ?? 0, Math.round(cpuPercent)),
          memoryMb: Math.max(prev?.memoryMb ?? 0, Math.round(memoryMb)),
        };
      }
    } catch {
      /* docker unavailable — container figures are simply omitted */
    } finally {
      this.busy = false;
    }
  }

  stop(): ResourceUsage {
    if (this.timer) clearInterval(this.timer);
    if (this.dockerTimer) clearInterval(this.dockerTimer);
    this.timer = null;
    this.dockerTimer = null;
    const peak = this.samples.length ? Math.max(...this.samples) : 0;
    const avg = this.samples.length
      ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length
      : 0;
    return {
      peakProcessCpuPercent: Math.round(peak),
      avgProcessCpuPercent: Math.round(avg),
      peakProcessRssMb: Math.round(this.peakRss),
      containers: this.containers,
    };
  }
}

/** "1.234GiB / 7.66GiB" -> megabytes of the first figure */
function parseMemory(text: string): number {
  const m = /^([\d.]+)\s*([KMG])i?B/i.exec(text.trim());
  if (!m) return 0;
  const value = Number(m[1]);
  const unit = (m[2] ?? 'M').toUpperCase();
  if (unit === 'G') return value * 1024;
  if (unit === 'K') return value / 1024;
  return value;
}

/**
 * Fold a resource reading into a result's detail map.
 *
 * `engines` names the containers this scenario actually used. Every container
 * in the stack is sampled, but reporting MongoDB's idle CPU next to a
 * Postgres-only measurement reads as though it took part — so only the ones
 * involved are published.
 */
export function resourceDetail(
  usage: ResourceUsage,
  engines: string[] = [],
): Record<string, string | number> {
  // A run shorter than the sampling interval yields no samples. Reporting the
  // resulting zeroes would read as "used no CPU and no memory", which is worse
  // than saying nothing — so a scenario too brief to sample publishes no
  // resource figures at all.
  if (usage.peakProcessRssMb === 0 && usage.peakProcessCpuPercent === 0) return {};

  const detail: Record<string, string | number> = {
    'syncle cpu (peak / avg)': `${usage.peakProcessCpuPercent}% / ${usage.avgProcessCpuPercent}%`,
    'syncle memory (peak)': `${usage.peakProcessRssMb} MB`,
  };
  const wanted = new Set(engines.map((e) => e.replace(/_dest$/, '').replace('postgres', 'pg')));
  for (const [engine, c] of Object.entries(usage.containers)) {
    if (wanted.size > 0 && !wanted.has(engine)) continue;
    detail[`${engine} cpu / memory (peak)`] = `${c.cpuPercent}% / ${c.memoryMb} MB`;
  }
  return detail;
}
