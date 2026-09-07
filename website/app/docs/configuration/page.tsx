import { CodeBlock } from '@/components/docs/code-block';
import { DocArticle, docMetadata } from '@/components/docs/doc-article';
import { Note } from '@/components/docs/note';

export const metadata = docMetadata('configuration');

export default function Page() {
  return (
    <DocArticle slug="configuration">
      <p>
        Syncle is configured through environment variables, plus a small set of
        runtime settings edited in the web interface and stored in its metadata
        database. This page lists every variable with its shipped default,
        where each configuration file lives, and how the in-app settings layer
        over the env values.
      </p>

      <h2 id="where-configuration-lives">Where configuration lives</h2>
      <p>
        Which file matters depends on how you run Syncle. There is no dotfile
        config — no <code>.synclerc</code>, no <code>syncle.config.js</code>;
        configuration is exclusively environment variables plus the in-app
        settings described at the end of this page.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Applies to</th>
              <th>How it gets there</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>$SYNCLE_HOME/.env</code> (default{' '}
                <code>~/.syncle/.env</code>)
              </td>
              <td>Docker install</td>
              <td>
                Written by <code>install.sh</code> with mode 600; passed to
                Docker Compose as the env file. Holds{' '}
                <code>SYNCLE_MASTER_KEY</code> and the pinned{' '}
                <code>SYNCLE_IMAGE</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>apps/api/.env</code>
              </td>
              <td>API, source checkout</td>
              <td>
                Copied from <code>apps/api/.env.example</code> by{' '}
                <code>scripts/setup-env.mjs</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>apps/web/.env.local</code>
              </td>
              <td>Web app, source checkout</td>
              <td>
                Copied from <code>apps/web/.env.example</code> by the same
                script.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <code>scripts/setup-env.mjs</code> runs before <code>pnpm dev</code>{' '}
        and <code>pnpm start</code> — not on <code>pnpm install</code> — and
        never overwrites a file that already exists, so your edits survive
        every run.
      </p>
      <p>
        In the Docker install the container environment is fixed inside{' '}
        <code>docker-compose.app.yml</code> (<code>PORT=4002</code>, a{' '}
        <code>DATABASE_URL</code> pointing at the bundled Postgres, and so on);
        only <code>SYNCLE_MASTER_KEY</code> and <code>SYNCLE_IMAGE</code> flow
        in from <code>$SYNCLE_HOME/.env</code>. The <code>syncle</code>{' '}
        launcher itself reads <code>SYNCLE_PORT</code> and{' '}
        <code>SYNCLE_HOME</code> from your shell — the{' '}
        <a href="/docs/install">installation page</a> covers those.
      </p>

      <h2 id="api-environment-variables">API environment variables</h2>
      <p>
        Read from <code>apps/api/.env</code> (or the container environment) at
        boot. Defaults below are the shipped{' '}
        <code>apps/api/.env.example</code> values or, where that file has no
        line, the code defaults.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>PORT</code>
              </td>
              <td>
                <code>4002</code>
              </td>
              <td>
                Port the API listens on. Must match the web app&apos;s{' '}
                <code>SYNCLE_API_ORIGIN</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>DATABASE_URL</code>
              </td>
              <td>
                <code>
                  postgresql://postgres:postgres@localhost:5433/syncle?schema=public
                </code>
              </td>
              <td>
                PostgreSQL URL for Syncle&apos;s own metadata store
                (connections, bridges, jobs) — not a database you sync. No
                code fallback: the API cannot start without it.
              </td>
            </tr>
            <tr>
              <td>
                <code>REDIS_URL</code>
              </td>
              <td>
                <code>redis://localhost:6379</code>
              </td>
              <td>
                Redis behind the job queue. Only running bridge jobs needs it;
                the API boots fine with Redis down.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_MASTER_KEY</code>
              </td>
              <td>unset (auto-generated)</td>
              <td>
                Base64 32-byte key that encrypts stored credentials and signs
                session cookies. See{' '}
                <a href="#the-master-key">the master key</a>.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_DATA_DIR</code>
              </td>
              <td>
                <code>apps/api/.syncle</code>
              </td>
              <td>
                Directory for local state — the auto-generated{' '}
                <code>master.key</code>, the first-run setup token, and{' '}
                <code>syncle.db</code>. Created with mode 700.
              </td>
            </tr>
            <tr>
              <td>
                <code>WEB_ORIGIN</code>
              </td>
              <td>
                <code>http://localhost:3002</code>
              </td>
              <td>
                Browser origins allowed by credentialed CORS, comma-separated.
                Only matters when the browser calls the API directly via{' '}
                <code>NEXT_PUBLIC_API_URL</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>WEB_PORT</code>
              </td>
              <td>
                <code>3002</code>
              </td>
              <td>
                The web app&apos;s port; sets the default CORS origin and the
                address in the ready banner.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_JOB_CONCURRENCY</code>
              </td>
              <td>
                <code>5</code>
              </td>
              <td>How many bridge jobs may execute concurrently.</td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_BATCH_SIZE</code>
              </td>
              <td>
                <code>100000</code>
              </td>
              <td>
                Rows per CDC delivery to a database destination. Database
                destinations only — HTTP keeps the bridge&apos;s own batch
                size. The default is the measured peak; a larger batch buys
                nothing and lengthens what a crash has to replay.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_BATCH_BYTES</code>
              </td>
              <td>
                <code>67108864</code>
              </td>
              <td>
                Byte ceiling for one batch. A row cap alone is unsafe, since
                100,000 wide rows could be gigabytes — the row size is
                estimated once per batch and whichever limit binds first wins.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_LINGER_MS</code>
              </td>
              <td>
                <code>50</code>
              </td>
              <td>
                How long a partial CDC batch waits for more changes before it
                is sent anyway.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_SPOOL</code>
              </td>
              <td>
                <em>off</em>
              </td>
              <td>
                <code>on</code> spools changes through Redis before writing, so
                the source is acknowledged without waiting for the destination.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_CDC_SPOOL_MAX</code>
              </td>
              <td>
                <code>50000</code>
              </td>
              <td>
                Unwritten changes held in the spool before the reader is
                throttled.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_MAX_QUERY_ROWS</code>
              </td>
              <td>
                <code>5000</code>
              </td>
              <td>
                Reported as the settings default. The working ad-hoc query cap
                is the built-in 5000, or a per-connection{' '}
                <code>maxQueryRows</code> option.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_POOL_IDLE_MS</code>
              </td>
              <td>
                <code>300000</code>
              </td>
              <td>
                Idle milliseconds before a pooled database connection is
                closed.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SECURE_COOKIES</code>
              </td>
              <td>unset (auto-detect)</td>
              <td>
                <code>true</code> forces the Secure attribute on session
                cookies, <code>false</code> forces it off; unset detects HTTPS
                from the request.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_BLOCK_PRIVATE_DESTINATIONS</code>
              </td>
              <td>unset (off)</td>
              <td>
                <code>true</code> refuses HTTP destinations that resolve to
                loopback, private, or link-local addresses.
              </td>
            </tr>
            <tr>
              <td>
                <code>SYNCLE_SQLITE_DIR</code>
              </td>
              <td>unset (no restriction)</td>
              <td>
                When set, SQLite connections may only open files under this
                directory.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Note>
        The code default for <code>PORT</code> is 4000, but every shipped
        configuration — <code>.env.example</code>,{' '}
        <code>docker-compose.app.yml</code>, and the web proxy&apos;s fallback
        — uses 4002. Delete the <code>PORT</code> line from{' '}
        <code>apps/api/.env</code> and the API comes up on 4000 where the
        proxy, still expecting 4002, cannot reach it. Keep the line, or change
        both sides together.
      </Note>
      <p>
        Three details worth knowing. <code>SYNCLE_HOOK_CONCURRENCY</code> is
        the legacy name for <code>SYNCLE_JOB_CONCURRENCY</code> and is still
        honored as a fallback; prefer the new name.{' '}
        <code>SYNCLE_BLOCK_PRIVATE_DESTINATIONS</code> is compared to the
        literal string <code>true</code> — <code>1</code> or <code>TRUE</code>{' '}
        leaves the guard off (cloud metadata endpoints are blocked regardless
        of this flag). And Secure-cookie detection follows the request&apos;s{' '}
        <code>X-Forwarded-Proto</code> header via Express trust-proxy —{' '}
        <code>NODE_ENV</code> plays no part in it, despite a stale comment in
        the env example.
      </p>

      <h2 id="the-master-key">The master key</h2>
      <p>
        <code>SYNCLE_MASTER_KEY</code> is a base64-encoded 32-byte key with
        two jobs: it encrypts stored connection credentials with AES-256-GCM,
        and an HKDF-derived sub-key signs login session cookies. Generate one
        with either of:
      </p>
      <CodeBlock>{`openssl rand -base64 32
# or, without openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`}</CodeBlock>
      <p>
        Left unset, the API generates a random key on first run and writes it
        to <code>master.key</code> in the data directory with mode 600,
        logging a warning to set the variable in production. That
        auto-generated key sits beside the data it protects: a data-directory
        backup carries both, and losing the volume loses the key. The
        installer avoids this by generating a key into{' '}
        <code>$SYNCLE_HOME/.env</code> and preserving it on every re-run. A
        key of the wrong length is rejected at boot with{' '}
        <code>SYNCLE_MASTER_KEY must be a base64-encoded 32-byte value</code>.
      </p>
      <Note>
        Never regenerate the key once Syncle holds data. A new key makes every
        stored credential undecryptable and logs everyone out.
      </Note>

      <h2 id="web-environment-variables">Web app environment variables</h2>
      <p>
        Read from <code>apps/web/.env.local</code> (or the container
        environment). The browser normally calls a relative <code>/api</code>{' '}
        on the web app&apos;s own origin, and the web server proxies that to
        the API — so the API&apos;s address is never baked into the browser
        bundle.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SYNCLE_API_ORIGIN</code>
              </td>
              <td>
                <code>http://127.0.0.1:4002</code>
              </td>
              <td>
                Where the <code>/api</code> proxy forwards requests; must
                match the API&apos;s <code>PORT</code>. Read at request time,
                not build time.
              </td>
            </tr>
            <tr>
              <td>
                <code>WEB_PORT</code>
              </td>
              <td>
                <code>3002</code>
              </td>
              <td>Port the web app runs on.</td>
            </tr>
            <tr>
              <td>
                <code>API_PORT</code>
              </td>
              <td>
                <code>4002</code>
              </td>
              <td>
                Fallback port for the proxy&apos;s default origin when{' '}
                <code>SYNCLE_API_ORIGIN</code> is unset.
              </td>
            </tr>
            <tr>
              <td>
                <code>NEXT_PUBLIC_API_URL</code>
              </td>
              <td>unset</td>
              <td>
                Optional absolute API URL (e.g.{' '}
                <code>https://api.example.com/api</code>) that makes the
                browser call the API directly, skipping the proxy.
              </td>
            </tr>
            <tr>
              <td>
                <code>NEXT_OUTPUT</code>
              </td>
              <td>unset</td>
              <td>
                Set to <code>standalone</code> to build the self-contained
                server the Docker image runs.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <code>NEXT_PUBLIC_API_URL</code> is inlined into the browser bundle at
        build time. Setting it turns on cross-origin requests, so the
        API&apos;s <code>WEB_ORIGIN</code> must then list the web app&apos;s
        origin. Leave it unset for the default same-origin proxy — the{' '}
        <a href="/docs/self-hosting">self-hosting page</a> discusses when the
        direct route is worth it.
      </p>

      <h2 id="in-app-settings">In-app settings</h2>
      <p>
        The Settings dialog (in the user menu) edits a handful of server-wide
        values at runtime. They persist as a single row in the metadata
        database and layer over the env values — the env vars act as defaults,
        not ceilings. The same values are readable and writable over HTTP via{' '}
        <code>GET /api/settings</code> and <code>PUT /api/settings</code>,
        covered on the <a href="/docs/api">API page</a>.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Default</th>
              <th>Range</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>defaultPollIntervalMs</code>
              </td>
              <td>
                <code>5000</code>
              </td>
              <td>1000 – 3,600,000</td>
              <td>Default poll cadence (ms) for polling bridges.</td>
            </tr>
            <tr>
              <td>
                <code>defaultMaxPerPoll</code>
              </td>
              <td>
                <code>500</code>
              </td>
              <td>1 – 5000</td>
              <td>Default rows fetched per poll.</td>
            </tr>
            <tr>
              <td>
                <code>defaultCdcOperations</code>
              </td>
              <td>insert, update, delete</td>
              <td>non-empty subset of the three</td>
              <td>Default operation set for CDC bridges.</td>
            </tr>
            <tr>
              <td>
                <code>maxQueryRows</code>
              </td>
              <td>
                <code>SYNCLE_MAX_QUERY_ROWS</code>, else 5000
              </td>
              <td>1 – 1,000,000</td>
              <td>Cap on rows from one ad-hoc query.</td>
            </tr>
            <tr>
              <td>
                <code>poolIdleMs</code>
              </td>
              <td>
                <code>SYNCLE_POOL_IDLE_MS</code>, else 300,000
              </td>
              <td>10,000 – 86,400,000</td>
              <td>Idle ms before a pooled connection closes.</td>
            </tr>
            <tr>
              <td>
                <code>jobConcurrency</code>
              </td>
              <td>
                <code>SYNCLE_JOB_CONCURRENCY</code>, else 5
              </td>
              <td>1 – 100</td>
              <td>Concurrent bridge jobs.</td>
            </tr>
            <tr>
              <td>
                <code>sessionTtlMinutes</code>
              </td>
              <td>
                <code>10080</code> (one week)
              </td>
              <td>15 – 43,200</td>
              <td>Minutes before a login session expires.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        A candid note on what is wired up in 1.0.{' '}
        <code>sessionTtlMinutes</code> takes effect immediately and has no
        env var — it is edited only here, under Settings › Security. The
        others are stored and reported back by the API, but do not yet steer
        the engine: the bridge builder hard-codes a 5&nbsp;second poll, 500
        rows per poll and all three CDC operations regardless of the{' '}
        <code>default*</code> values; the working query cap is the built-in
        5000 or the per-connection <code>maxQueryRows</code> option; and
        worker concurrency comes solely from{' '}
        <code>SYNCLE_JOB_CONCURRENCY</code> at boot. Treat those dialog
        values as declarations of intent until a release wires them through.
        A settings row persisted before the bridges rename under the old{' '}
        <code>hookConcurrency</code> key is migrated to{' '}
        <code>jobConcurrency</code> automatically.
      </p>
    </DocArticle>
  );
}
