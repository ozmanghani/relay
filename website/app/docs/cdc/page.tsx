import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('cdc');

export default function Page() {
  return (
    <DocArticle slug="cdc">
      <p>
        A bridge with the CDC trigger streams changes out of the source
        database&apos;s own change log the moment they commit — no polling.
        Each engine captures changes a different way and each has
        prerequisites Syncle cannot always set up for you. This page lists
        them per engine, shows what Syncle provisions itself, and states the
        limits plainly.
      </p>

      <p>
        The alternative for live syncing is a <strong>watch</strong> bridge,
        which polls the source on a cursor and works on every engine —
        including the two cases where CDC falls short: SQLite has no change
        log at all, and the Redis change feed is not durable. The trigger
        modes are compared on <a href="/docs/bridges">How bridges work</a>.
      </p>

      <h2 id="per-engine">Per-engine prerequisites</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Engine</th>
              <th>Mechanism</th>
              <th>You configure</th>
              <th>Syncle provisions</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>PostgreSQL</td>
              <td>Logical replication (pgoutput)</td>
              <td>
                <code>wal_level=logical</code>, a role with{' '}
                <code>REPLICATION</code>
              </td>
              <td>Publication and replication slot, per bridge</td>
            </tr>
            <tr>
              <td>MySQL</td>
              <td>Row-based binlog</td>
              <td>
                <code>log_bin=ON</code>, <code>binlog_format=ROW</code>,{' '}
                <code>binlog_row_image=FULL</code>, replication grants
              </td>
              <td>Nothing — the binlog already exists</td>
            </tr>
            <tr>
              <td>MongoDB</td>
              <td>Change streams</td>
              <td>A replica set (single-node is fine)</td>
              <td>Pre-images on the source collection</td>
            </tr>
            <tr>
              <td>Redis</td>
              <td>Keyspace notifications</td>
              <td>
                <code>notify-keyspace-events</code>
              </td>
              <td>Enables notifications itself when it can</td>
            </tr>
            <tr>
              <td>SQLite</td>
              <td>Not available — use a watch bridge</td>
              <td>—</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="postgres">PostgreSQL</h3>
      <p>
        Syncle uses logical replication with the built-in{' '}
        <code>pgoutput</code> plugin, so there is no server extension to
        install. Two things must be true on the server:{' '}
        <code>wal_level=logical</code>, and the connection&apos;s role has{' '}
        <code>REPLICATION</code> (superusers pass too). Changing{' '}
        <code>wal_level</code> needs a server restart, which is the one step
        Syncle cannot automate — on managed Postgres, set it in your
        provider&apos;s parameter group and reboot.
      </p>
      <CodeBlock title="postgresql.conf — needs a restart">{`wal_level = logical`}</CodeBlock>
      <p>
        Grant replication with{' '}
        <code>ALTER ROLE your_user REPLICATION;</code>. The rest is
        provisioned for you: each CDC bridge gets a publication scoped to its
        source table and a logical replication slot, named{' '}
        <code>{'syncle_pub_<id>'}</code> and <code>{'syncle_slot_<id>'}</code>{' '}
        (the bridge id with dashes removed). If you later point the bridge at
        a different table, the publication is updated to match. The slot
        stores the confirmed position and is only advanced after Syncle has
        persisted its own cursor, so a restart resumes exactly where it left
        off without skipping changes.
      </p>

      <h3 id="mysql">MySQL</h3>
      <p>
        Syncle connects as a replication client and decodes row events from
        the binary log. Four server settings matter, and on managed MySQL
        they usually mean a parameter-group change plus a reboot:
      </p>
      <CodeBlock title="my.cnf — needs a restart">{`log_bin          = ON
binlog_format    = ROW
binlog_row_image = FULL
server_id        = 1   # any unique id`}</CodeBlock>
      <p>
        The connecting user needs replication grants (a user with{' '}
        <code>ALL PRIVILEGES</code> also passes):
      </p>
      <CodeBlock>{`GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO CURRENT_USER;`}</CodeBlock>
      <p>
        There is nothing to provision — the binlog already exists. The cursor
        is the binlog file and position, so MySQL CDC is durable and resumes
        exactly after a restart, even in the middle of a multi-row statement.
      </p>
      <p>
        Three limits are worth knowing before you point a bridge at MySQL.
      </p>
      <p>
        <strong>
          <code>binlog_transaction_compression</code> is not supported.
        </strong>{' '}
        MySQL 8.0.20 and later can wrap a transaction&apos;s row events inside a
        compressed payload event, and the binlog reader has no decoder for it —
        the rows inside are not seen. Leave it <code>OFF</code> on a source you
        stream from.
      </p>
      <p>
        <strong>MariaDB is untested.</strong> Connections, replay and watch
        bridges go through <code>mysql2</code> and work, but CDC reads the
        binlog with a client that targets MySQL and that path has not been
        verified against MariaDB. Treat MariaDB CDC as unsupported until it has
        been.
      </p>
      <p>
        <strong>Binlog positions belong to one server.</strong> A cursor records
        the server&apos;s <code>@@server_uuid</code> (and the GTID of the
        transaction it sits at). If the connection later reaches a different
        server — after a failover, say — the bridge refuses to resume rather
        than reading unrelated offsets, and says so. Reset it to start from the
        current position.
      </p>

      <h3 id="mongodb">MongoDB</h3>
      <p>
        Syncle opens a change stream on the source collection. Change streams
        require a replica set or a sharded cluster — they are not available
        on a standalone <code>mongod</code>. A single-node replica set is
        fine for development: start the server with{' '}
        <code>--replSet rs0</code> and run <code>rs.initiate()</code> once.
        Managed MongoDB (Atlas) already satisfies this.
      </p>
      <p>
        On MongoDB 6.0 and newer, Syncle enables change-stream{' '}
        <strong>pre-images</strong> on the source collection so a delete
        event carries the full prior document — without them a delete event
        contains only <code>_id</code>, and a bridge keyed on a business
        column could not find the row to remove downstream. On older servers
        this is a best-effort no-op and deletes carry only <code>_id</code>.
        The resume token is durable as long as it stays inside the oplog
        window; if the bridge is paused long enough for the oplog to roll
        past it, Syncle logs a warning and restarts from now instead of
        failing.
      </p>

      <h3 id="redis">Redis</h3>
      <p>
        Syncle subscribes to keyspace notifications — pub/sub on the{' '}
        <code>{'__keyevent@<db>__'}</code> channels of the connection&apos;s
        database index. The server must have{' '}
        <code>notify-keyspace-events</code> enabled with the <code>E</code>{' '}
        flag plus event classes. Syncle attempts{' '}
        <code>CONFIG SET notify-keyspace-events EA</code> itself when a
        bridge goes live; managed Redis may require enabling it in the
        provider console, and the readiness check tells you where you stand.
      </p>
      <p>
        A notification carries only the key, so Syncle reads the current
        value afterwards, best-effort, and delivers rows shaped like{' '}
        <code>{'{ key, event, type, value }'}</code> — deletes carry only{' '}
        <code>key</code> and <code>event</code>, because the value is already
        gone. Redis cannot tell a create from an overwrite, so every write is
        delivered as an <strong>update</strong>; <code>del</code>,{' '}
        <code>unlink</code>, <code>expired</code> and <code>evicted</code>{' '}
        arrive as deletes. Setting a TTL is not a delete — only the TTL
        actually firing is. A filter on the <code>key</code> column acts as a
        Redis-style glob (<code>user:*</code>) applied at the subscription.
      </p>
      <Note>
        Redis keyspace notifications are fire-and-forget pub/sub with no
        backlog: any change that happens while Syncle is disconnected — a
        restart, a network blip — is gone for good, and there is no resume
        cursor. When every change matters, use a watch bridge on Redis
        instead.
      </Note>

      <h3 id="sqlite">SQLite</h3>
      <p>
        SQLite has no change log an external reader can tail: the update hook
        only fires for writes made through the same in-process connection,
        and Syncle opens a file that other processes write to. CDC is
        therefore not supported — the readiness check reports it as such —
        and the right tool is a <a href="/docs/bridges">watch bridge</a>,
        which polls and works reliably on SQLite.
      </p>

      <h2 id="readiness">The readiness check</h2>
      <p>
        The bridge builder runs a readiness check when you choose the CDC
        trigger and lists anything missing, with the instruction to fix it.
        The same probe is available as{' '}
        <code>POST /api/bridges/cdc/readiness</code> with a body of{' '}
        <code>{'{ connectionId, database?, schema?, table }'}</code>. The
        response says whether the engine supports CDC at all, whether this
        connection is ready right now, the individual checks, and the manual
        steps left:
      </p>
      <CodeBlock title="POST /api/bridges/cdc/readiness">{`// request
{ "connectionId": "b6f4…", "database": "shop", "table": "orders" }

// response
{
  "data": {
    "engine": "postgres",
    "supported": true,
    "ready": false,
    "checks": [
      { "label": "wal_level = logical", "ok": false, "detail": "currently \\"replica\\"" },
      { "label": "role can replicate", "ok": true }
    ],
    "instructions": [
      "Set wal_level=logical on the server (postgresql.conf or your provider’s parameter group) and restart it. This is the one step we can’t automate — it needs a server restart."
    ]
  }
}`}</CodeBlock>

      <h2 id="operations">Operations and the op token</h2>
      <p>
        A CDC trigger carries the set of operations to deliver — any subset
        of <code>insert</code>, <code>update</code> and <code>delete</code>,
        all three by default. On a database
        destination a delete routes to a keyed delete on the target; on an
        HTTP destination the payload template can expose the operation
        through the <code>{'{{$op}}'}</code> token, which resolves to{' '}
        <code>insert</code>, <code>update</code> or <code>delete</code>. The
        token is populated on CDC deliveries only — a watch bridge sees rows,
        not operations; the other template tokens are covered in{' '}
        <a href="/docs/bridges">How bridges work</a>.
      </p>

      <h2 id="lifecycle">Going live, stopping, and deleting</h2>
      <p>
        A CDC bridge does not run one-shot jobs — asking it to replay returns
        an error pointing you at live listening instead. Going live opens one
        long-running job, and every captured change is recorded in it as a
        delivery, which is what the live timeline shows. Watch bridges share
        exactly the same lifecycle and the same endpoints:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>POST /api/bridges/cdc/readiness</code>
              </td>
              <td>Probe a connection and table for CDC readiness</td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/start</code>
              </td>
              <td>
                Start live listening — routes to CDC or the polling watch by
                the bridge&apos;s trigger kind
              </td>
            </tr>
            <tr>
              <td>
                <code>POST /api/bridges/:id/watch/stop</code>
              </td>
              <td>
                Stop both mechanisms (CDC first) and return the finalized job
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Canceling the running job stops the listener too — the job pauses and
        keeps its cursor, so it can resume in place. Updating a live bridge
        stops the listener first and restarts it on the new configuration.
        When you go live again, each engine resumes from its persisted
        cursor: Postgres from the slot&apos;s confirmed position, MySQL from
        the binlog position, MongoDB from the resume token — and Redis always
        starts from now. Authentication and the response envelope are covered
        on the <a href="/docs/api">HTTP API</a> page.
      </p>
      <p>
        Deleting a CDC bridge deprovisions what was created for it. On
        Postgres the replication slot and publication are dropped — this
        matters, because a slot nothing reads pins WAL on the source and
        eventually fills its disk. On Redis, notifications are left enabled,
        since other consumers may rely on them; MySQL has nothing to remove,
        and MongoDB pre-images stay enabled. Deleting a workspace does the
        same teardown for every bridge in it.
      </p>
    </DocArticle>
  );
}
