import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Integration suite: runs against the REAL databases in docker-compose.test.yml.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   pnpm test:integration
 *
 * Kept in its own config, and behind an `.itest.ts` suffix, so `pnpm test`
 * (which has no config and uses vitest's default `*.test.ts` glob) never picks
 * these up and never needs Docker.
 *
 * Compiled with SWC rather than vitest's default esbuild: Nest resolves
 * constructor dependencies from `emitDecoratorMetadata`, which esbuild does
 * not emit. Without this every injected dependency arrives as undefined.
 *
 * Single-threaded and serial: these tests create replication slots, hold binlog
 * readers open and write to shared tables, so parallel files would interfere.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/integration/**/*.itest.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    // CDC is inherently timing-bound: a change has to travel source -> log ->
    // reader -> destination. Generous per-test time, still bounded.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
