#!/usr/bin/env node
/**
 * Runs the whole benchmark suite and refreshes benchmarks/results.json.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   pnpm benchmark
 *
 * Several passes are needed because the settings under test (batch size, the
 * spool) are read once when the app module is evaluated — so each configuration
 * gets its own process, and each contributes its rows to the shared report.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api');
const vitest = ['exec', 'vitest', 'run', '--config', 'vitest.bench.config.ts'];

/** each pass: a label, the file to run, and the environment it needs */
const passes = [
  {
    label: 'Destination write ceiling (1,000,000 rows per engine)',
    file: 'bench/sink-writes.bench.ts',
    env: {},
  },
  {
    label: 'CDC — one delivery per row (the path before batching)',
    file: 'bench/cdc.bench.ts',
    env: { BENCH_MODE: 'per-row', SYNCLE_CDC_BATCH_SIZE: '1' },
  },
  {
    label: 'CDC — batched, across four engine pairs',
    file: 'bench/cdc.bench.ts',
    env: { BENCH_MODE: 'batched' },
  },
  {
    label: 'CDC — batched with the durable spool',
    file: 'bench/cdc.bench.ts',
    env: { BENCH_MODE: 'spool', SYNCLE_CDC_SPOOL: 'on' },
  },
];

let failed = false;
for (const pass of passes) {
  console.log(`\n=== ${pass.label} ===`);
  const res = spawnSync('pnpm', [...vitest, pass.file], {
    cwd: api,
    stdio: 'inherit',
    env: { ...process.env, ...pass.env },
  });
  if (res.status !== 0) {
    failed = true;
    console.error(`!! pass failed: ${pass.label}`);
  }
}

console.log(
  failed
    ? '\nBenchmark run finished with failures — results.json holds only what completed.'
    : '\nBenchmark run complete. benchmarks/results.json refreshed.',
);
process.exit(failed ? 1 : 0);
