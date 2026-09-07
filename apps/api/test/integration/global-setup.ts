/**
 * Brings the test engines to a usable state before the suite runs.
 *
 * Compose can start MongoDB but cannot initiate a replica set, and change
 * streams do not exist without one — so that happens here, idempotently. Also
 * waits for every engine to accept connections, so a slow container start
 * surfaces as a clear message instead of a pile of connection-refused failures.
 */
import { MongoClient } from 'mongodb';
import { bootstrapDrivers, createAdapter } from '@syncle/core/adapters';
import { TEST_CONNECTIONS } from './harness';

const MONGO_DIRECT = 'mongodb://127.0.0.1:57017/?directConnection=true';

async function initReplicaSet(): Promise<void> {
  const client = new MongoClient(MONGO_DIRECT, {
    serverSelectionTimeoutMS: 3_000,
  });
  await client.connect();
  try {
    const admin = client.db('admin');
    try {
      await admin.command({ replSetGetStatus: 1 });
      return; // already initiated
    } catch {
      await admin.command({
        replSetInitiate: {
          _id: 'rs0',
          members: [{ _id: 0, host: '127.0.0.1:57017' }],
        },
      });
    }
    // wait for this node to actually become primary before tests open streams
    for (let i = 0; i < 60; i++) {
      try {
        const st = (await admin.command({ replSetGetStatus: 1 })) as {
          myState?: number;
        };
        if (st.myState === 1) return;
      } catch {
        /* still electing */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('mongo replica set did not reach PRIMARY');
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForEngine(name: string): Promise<void> {
  const conn = TEST_CONNECTIONS[name];
  if (!conn) throw new Error(`unknown engine ${name}`);
  let lastErr: unknown;
  for (let i = 0; i < 60; i++) {
    const adapter = createAdapter(conn);
    try {
      await adapter.connect();
      await adapter.ping();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }
  throw new Error(
    `engine "${name}" never became reachable — is docker-compose.test.yml up? ` +
      `last error: ${(lastErr as Error)?.message}`,
  );
}

export async function setup(): Promise<void> {
  bootstrapDrivers();
  await initReplicaSet();
  for (const name of Object.keys(TEST_CONNECTIONS)) await waitForEngine(name);
}
