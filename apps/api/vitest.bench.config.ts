import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Benchmark runner. Same real-database stack as the integration suite, but the
 * files here MEASURE rather than assert, and they write their findings to
 * benchmarks/results.json — the file the website renders.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   pnpm benchmark
 *
 * Serial and single-forked on purpose: parallel work would contend for the same
 * databases and the numbers would mean nothing.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['bench/**/*.bench.ts'],
    // resets replication slots and fixtures first: leftovers from a previous
    // run distort every number that follows
    globalSetup: ['bench/global-setup.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { concurrent: false },
    // a benchmark run is one long report; keep the output readable
    reporters: ['default'],
  },
});
