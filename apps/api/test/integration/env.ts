/**
 * Environment for the end-to-end tests.
 *
 * `runtimeConfig` reads process.env at module-evaluation time, so these must be
 * set BEFORE anything imports the app. Test files therefore call
 * `applyTestEnv()` and only then `await import()` the Nest module — a static
 * import would be hoisted above the assignment and pick up the real .env.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** metadata store for the app under test — separate from the synced databases */
export const META_DB_URL =
  'postgresql://syncle:syncle@127.0.0.1:55432/syncle_meta?schema=public';

export const TEST_REDIS_URL = 'redis://127.0.0.1:56379';

export function applyTestEnv(): void {
  process.env.DATABASE_URL = META_DB_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.SYNCLE_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'syncle-data-'));
  // a fixed, base64-encoded 32-byte key: deterministic so encrypted
  // connection secrets round-trip within a run. Test-only value.
  process.env.SYNCLE_MASTER_KEY ??= 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
  process.env.NODE_ENV = 'test';
}
