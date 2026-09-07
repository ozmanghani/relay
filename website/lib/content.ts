/**
 * Single source for the strings that appear both on the page and in the
 * structured data. Search engines penalise a mismatch between what a page
 * says and what its JSON-LD claims, so they are defined once.
 */

export const SITE_URL = 'https://syncle.dev';
export const GITHUB = 'https://github.com/osmanahmadxai/SYNCLE';
export const AUTHOR_GITHUB = 'https://github.com/osmanahmadxai';
export const INSTALL_COMMAND =
  'curl -fsSL https://syncle.dev/install | sh -s -- up';

export const TITLE =
  'Syncle — keep any databases in sync, live, across engines';

/** ~155 chars, intent phrases front-loaded — this is the SERP snippet */
export const DESCRIPTION =
  'Open-source, self-hosted database sync with real-time CDC — PostgreSQL, MySQL, SQLite, MongoDB and Redis, any engine to any other. One command to install.';

/**
 * Doubles as the visible FAQ and the FAQPage structured data. Every claim
 * here is checked against the product repo — where the honest answer has an
 * edge case, the edge case is in the answer.
 */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Which databases can Syncle sync between?',
    a: 'PostgreSQL, MySQL and MariaDB, SQLite, MongoDB and Redis — in any combination. A relational source can write into a document or key-value store and back, with values translated to fit the target. HTTP endpoints work as a destination too, when you are feeding a service rather than a database.',
  },
  {
    q: 'Does it sync in real time, or on a schedule?',
    a: 'You choose per bridge. CDC reads the database change log directly — Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications — so changes arrive without polling. Watch polls a cursor instead, which works on every engine, including SQLite, which has no change log to read. The cursor can be an auto-increment id, a timestamp column, or a diff of the primary keys — so a table with no updated_at column can still be watched. Replay is a one-shot pass for the initial backfill.',
  },
  {
    q: 'Can it duplicate or lose rows?',
    a: 'Writes are idempotent upserts keyed by the columns you pick, so a replay, a retry or a redelivery rewrites the same row rather than adding another. Jobs record their cursor as they go, so an interrupted run resumes where it stopped instead of starting over. What each trigger sees differs: a CDC bridge propagates inserts, updates and deletes; a watch bridge polls, so it sees new rows (and updates, on a timestamp cursor) but never deletes. And Redis CDC rides keyspace notifications, which are not durable — if Syncle is down when a Redis key changes, that event is gone.',
  },
  {
    q: 'What do I need installed to run it?',
    a: 'Docker with Compose v2, and curl for the installer — that is what the install script actually checks before it will run. Node, PostgreSQL and Redis all run in containers, and the application image is pulled prebuilt, so nothing is compiled on your machine.',
  },
  {
    q: 'Is Syncle free, and is my data sent anywhere?',
    a: 'It is MIT licensed and entirely self-hosted. It runs on your own machine against your own databases; there is no account and no third-party service in the data path. Stored connection credentials are encrypted with AES-256-GCM under a key that never leaves your install.',
  },
  {
    q: 'How is it different from Airbyte or Debezium?',
    a: 'Scale of setup. Airbyte expects a platform deployment — Kubernetes, or Docker Compose at smaller scale — and a team to operate it; Debezium expects Kafka. Syncle is one command, four containers and a web interface, aimed at one operator who wants their databases kept in step without standing up a data platform first.',
  },
  {
    q: 'How much can it move?',
    a: 'Changes are delivered in batches, so a stream costs one delivery, one cursor write and one source acknowledgement per batch rather than per row. Measured on a laptop, against containerised PostgreSQL on the same machine: about 10,000 rows a second, and a million rows end to end in 54 seconds with the optional Redis spool enabled — each row arriving exactly once. Your numbers will differ; the figure that travels is the shape, which is that round trips rather than the database set the pace. There is no published benchmark against managed or remote databases yet, and network latency is what dominates there.',
  },
  {
    q: 'What happens if the destination goes down?',
    a: 'By default the reader stops advancing, which means the source keeps its change log until the destination is back — safe, but on PostgreSQL a long outage leaves WAL accumulating on the source. Turning on the optional spool changes that: changes are written to a durable Redis stream first and the source is acknowledged immediately, so its log advances at the speed of Redis rather than the destination. The spool is bounded, so a stalled destination throttles the reader instead of growing without limit. It is off by default, because while a change sits in the spool Redis is the only copy of it and that trade should be deliberate.',
  },
];

/** Real jobs people reach for a sync tool to do. `tag` names the trigger. */
export const USE_CASES: { title: string; body: string; tag: string }[] = [
  {
    title: 'Migrate to a different engine',
    tag: 'Replay + CDC',
    body: 'Backfill every row with a replay job, then leave a CDC bridge running so old and new stay identical while you cut traffic over. Nothing has to go offline for it.',
  },
  {
    title: 'Feed a read replica you actually control',
    tag: 'CDC',
    body: 'Keep a second database in step for reporting or exports without pointing analysts at production, and without the managed-service bill.',
  },
  {
    title: 'Warm a cache from the source of truth',
    tag: 'CDC',
    body: 'Project rows into Redis as they change, keyed however you like, so the cache is never the thing that went stale. Deletes remove the key rather than leaving it to expire.',
  },
  {
    title: 'Give search its own copy',
    tag: 'Watch',
    body: 'Sync the columns a search index needs into MongoDB, reshaped on the way across, without bolting write hooks onto the application.',
  },
  {
    title: 'Split a monolith database',
    tag: 'CDC',
    body: 'Carve a table out to a new service database and keep both in sync while callers move over one at a time, instead of coordinating a single risky switch.',
  },
  {
    title: 'Push rows to a service, not a database',
    tag: 'Any',
    body: 'Send each change to an HTTP endpoint with a payload you design, with retries and backoff, when the thing to feed is an API rather than another store.',
  },
];

/** What happens to credentials and data. */
export const SECURITY: { title: string; body: string }[] = [
  {
    title: 'Your data stays on your machines',
    body: 'Syncle runs where you install it and talks to your databases directly. There is no account and no third party in the path — rows go from your source to your destination and nowhere else.',
  },
  {
    title: 'Credentials are encrypted at rest',
    body: 'Saved connection details are sealed with AES-256-GCM under a key generated at install, which stays on the host. Losing the key costs you the stored secrets rather than exposing them.',
  },
  {
    title: 'One admin account, claimed with a server-side token',
    body: 'The admin account is created with a one-time token printed on the server, and login is rate limited. If you expose an instance beyond your own machine, finish that first-run setup before the port is reachable — the token is a guard, not a substitute for a firewall.',
  },
  {
    title: 'Reach private databases over SSH',
    body: 'Connect through a bastion to databases that never listen on a public interface, so nothing has to be exposed to make a bridge work.',
  },
];
