import type { Metadata } from 'next';
import { CopyCommand } from '@/components/copy-command';
import { CodeBlock } from '@/components/docs/code-block';
import { formatReleaseDate, latestRelease } from '@/lib/release';
import { InstallTranscript } from '@/components/install-transcript';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { DemoVideo, Shot } from '@/components/shot';
import { FAQ, GITHUB, INSTALL_COMMAND, SECURITY, USE_CASES } from '@/lib/content';
import { DOC_PAGES, docHref } from '@/lib/docs';
import { MEASURE } from '@/lib/layout';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const TRIGGERS = [
  {
    name: 'Replay',
    body: 'A one-shot pass: stream all — or a filtered slice — of the source once, then finish. The right tool for an initial backfill or a migration.',
  },
  {
    name: 'Watch',
    body: 'Polling on a cursor: an auto-increment id, an updated_at column, or a primary-key diff. New rows sync as they appear. Works on every engine, including SQLite.',
  },
  {
    name: 'CDC',
    body: 'Change data capture: read the change log itself — Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications. Changes arrive as they happen, no polling.',
  },
];

const GUARANTEES = [
  {
    title: 'No duplicates.',
    body: 'Writes are idempotent upserts keyed by the columns you choose, so replays, retries and redeliveries rewrite the same row instead of adding another.',
  },
  {
    title: 'Deletes propagate — on CDC bridges.',
    body: 'With a CDC trigger, inserts, updates and deletes all cross the bridge, each tagged with its operation. A watch bridge polls, so it sees new rows (and updates, on a timestamp cursor) but cannot see deletes.',
  },
  {
    title: 'Missing tables are created.',
    body: "If the destination table doesn't exist, Syncle builds it from the source's shape, translating types across engines.",
  },
  {
    title: 'Interrupted jobs resume.',
    body: 'Jobs checkpoint their cursor as they go. A crash or restart picks up where it stopped instead of starting over.',
  },
  {
    title: 'Columns can be mapped and renamed.',
    body: 'Write this column into that column over there — or design a JSON payload and POST each row to an HTTP endpoint instead.',
  },
];

const STEPS = [
  {
    t: 'Run the command.',
    b: 'It checks for Docker and Compose v2, pulls the prebuilt image, starts four containers, and opens the interface at localhost:3002.',
  },
  {
    t: 'Create your admin account.',
    b: 'The setup form opens with a one-time token already filled in — read from the server’s own data directory, and printed in the logs too — proving you operate the machine.',
  },
  {
    t: 'Draw your first bridge.',
    b: 'Pick a source table and its destinations, then start it. Backfill first, then leave it listening.',
  },
];

const DAY_TO_DAY: [string, string][] = [
  ['syncle up', 'start it, and open the interface'],
  ['syncle down', 'stop, keeping your data'],
  ['syncle logs', 'follow what the bridges are doing'],
  ['syncle update', 'move to the newest release'],
  ['syncle uninstall', 'remove everything, data included'],
];

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-16 scroll-mt-8">
      <h2 className="text-[1.35rem]">{title}</h2>
      {children}
    </section>
  );
}

export default function Home() {
  const release = latestRelease();

  return (
    <>
      <SiteHeader />

      <main className={`mx-auto px-6 text-[18px] leading-[1.75] ${MEASURE}`}>
        {/* ── intro ───────────────────────────────────────────────────── */}
        <section className="pt-10 sm:pt-14">
          <h1 className="max-w-[15ch] text-[2.4rem] leading-[1.1] sm:text-[2.9rem]">
            Keep any databases in sync, live, across engines
          </h1>

          <p className="mt-7 max-w-[62ch] text-pretty text-[19px] leading-[1.65]">
            Syncle is a small, self-hosted sync tool. You draw a bridge from a
            source database to one or more destinations, and rows are written
            across it — as a one-off backfill, on a polling cursor, or the
            moment they change, straight from the database&apos;s own change
            log.
          </p>

          <p className="mt-4 max-w-[70ch]">
            It speaks PostgreSQL, MySQL, SQLite, MongoDB and Redis,
            and any of them can sit on either end. An HTTP endpoint works as a
            destination too, when the thing that needs the rows is a service
            rather than a database.
          </p>

          <div className="mt-8">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>

          <p className="mt-4 max-w-[70ch] text-[15px] leading-relaxed text-muted-foreground">
            Docker with Compose v2 and curl are the only requirements — the
            script checks for exactly those before it runs, and everything else
            lives in containers. Open source under the MIT licence.
          </p>

          <p className="mt-6">
            <a href="/docs" className="link">
              Read the documentation
            </a>
            <span className="mx-3 text-muted-foreground">·</span>
            <a href={GITHUB} rel="noopener" className="link">
              Source on GitHub
            </a>
          </p>

          <Shot
            eager
            src="/media/04-workspace-map.webp"
            alt="The Syncle workspace map: one PostgreSQL source feeding four bridges — on-demand, CDC and watch — into MySQL, MongoDB and Redis destinations"
            caption="One source, four bridges, four destinations — the whole workspace on one canvas."
          />
        </section>

        {/* ── the walkthrough ─────────────────────────────────────────── */}
        <Section id="demo" title="One bridge, built and running">
          <p className="mt-4">
            Fifty-eight seconds, no cuts: an empty workspace, then a bridge
            from a Postgres <code className="code">orders</code> table into
            MongoDB — naming it, picking the source, choosing change data
            capture, pointing it at the destination. It is started, rows are
            inserted into Postgres from outside the browser, and they arrive.
          </p>
          <DemoVideo
            caption={
              <>
                Recorded against a running instance. The counter climbing is
                the bridge doing the work, and the collection at the end did
                not exist when the recording started.
              </>
            }
          />
        </Section>

        {/* ── why ─────────────────────────────────────────────────────── */}
        <Section title="Why it exists">
          <p className="mt-4">
            I kept writing the same one-off sync scripts — a cron job here, a
            copy-paste ETL there — and none of them handled deletes, retries,
            or the day the schema changed. I wanted one small thing I could run
            on my own box, point at two databases, and trust. That is all
            Syncle is meant to be.
          </p>
        </Section>

        {/* ── how it works ────────────────────────────────────────────── */}
        <Section id="how-it-works" title="How a bridge fires">
          <p className="mt-4">
            A bridge is a saved sync path: a source table or query, the columns
            and mapping, the destinations, and a trigger. The trigger is how it
            notices that something changed — there are three, and you pick per
            bridge. The rest of the pipeline is identical. The destination table
            does not have to exist first: unless you turn it off, Syncle creates
            it from the source schema on the first write, with the types
            translated for whichever engine is receiving them.
          </p>
          <div className="mt-5 space-y-4">
            {TRIGGERS.map((t) => (
              <p key={t.name}>
                <span className="font-semibold">{t.name}.</span> {t.body}
              </p>
            ))}
          </div>
          <Shot
            src="/media/05-bridge-builder.webp"
            alt="The Syncle bridge builder: source table with selectable columns, a live preview of real rows, trigger configuration, the inferred schema and a sample payload"
            caption="Picking the trigger in the builder, with a live preview of what will be sent."
          />

          <p className="mt-5">
            Choosing CDC checks the source before it lets you continue: whether
            logical replication is on for Postgres, the binlog is set to row
            format for MySQL, the Mongo deployment is a replica set, or Redis
            has keyspace notifications enabled — and when something is missing,
            it says which setting and what to change it to. You find out at the
            builder rather than from a bridge that silently never fires.
          </p>

          <p className="mt-5 text-[15px] text-muted-foreground">
            The honest edges: SQLite has no change log, so it syncs by watch
            rather than CDC; and Redis keyspace notifications are not durable,
            so a Redis CDC bridge misses events that happen while Syncle is
            down. Details in{' '}
            <a href="/docs/cdc" className="link">
              the CDC documentation
            </a>
            .
          </p>
        </Section>

        {/* ── guarantees ──────────────────────────────────────────────── */}
        <Section title="What it promises about your rows">
          <p className="mt-4">
            Moving data is the easy half. The hard half is moving it exactly
            once, in the right shape, and noticing when a row disappears.
          </p>
          <div className="mt-5 space-y-4">
            {GUARANTEES.map((g) => (
              <p key={g.title}>
                <span className="font-semibold">{g.title}</span> {g.body}
              </p>
            ))}
          </div>
        </Section>

        {/* ── the interface ───────────────────────────────────────────── */}
        <Section title="What you see while it runs">
          <p className="mt-4">
            Every delivery lands on a live timeline — synced, failed, skipped
            or queued — and clicking one shows the exact row that was written,
            how long it took, and any error. Failed rows can be retried in
            place, without rerunning the job.
          </p>

          <Shot
            src="/media/01-bridge-live-cdc.webp"
            alt="A live CDC bridge in Syncle: running, 2,580 delivered, 0 failed, 0 skipped, 100% success, and the customer rows that crossed it with the time each took"
            caption="A CDC bridge mid-flight, and every row that crossed it."
          />

          <p className="mt-8">
            Connecting a database for syncing also makes it browsable, so the
            same interface doubles as a small database workbench, for every
            connected engine and not just the ones in a bridge: browse, filter,
            sort and edit rows, with CSV and JSON export; a query editor — SQL
            for the relational engines, command documents for MongoDB, plain
            commands for Redis; schema views and an interactive ER diagram;
            create and drop tables and databases; and backup and restore, as
            portable JSON for any engine or a .sql script for the relational
            ones.
          </p>
          <Shot
            src="/media/06-workbench-data.webp"
            alt="The Syncle workbench browsing a customers table: the connection list, a schema tree with row counts, and a paginated grid of 5,060 rows"
            caption="Browsing a source table, with the schema tree beside it."
          />

          <p className="mt-8">
            <a href="/docs/workbench" className="link">
              The query editor and the ER diagram
            </a>
          </p>
        </Section>

        {/* ── install ─────────────────────────────────────────────────── */}
        <Section id="install" title="Installing it">
          <div className="mt-5">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
          <div className="mt-3">
            <InstallTranscript />
          </div>
          <p className="mt-3 text-[15px] text-muted-foreground">
            What a first run prints, start to finish — the script&apos;s actual
            output, not a mock-up.
          </p>

          <ol className="mt-6 list-decimal space-y-3 pl-5">
            {STEPS.map((s) => (
              <li key={s.t} className="pl-1">
                <span className="font-semibold">{s.t}</span> {s.b}
              </li>
            ))}
          </ol>

          <p className="mt-6">After that, a small launcher does the day-to-day:</p>
          <ul className="mt-4 space-y-2">
            {DAY_TO_DAY.map(([cmd, what]) => (
              <li key={cmd} className="text-[15px]">
                <code className="code">{cmd}</code>
                <span className="text-muted-foreground"> — {what}</span>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-[15px] text-muted-foreground">
            Prefer to see what you are piping to sh first? The script is{' '}
            <a
              href={`${GITHUB}/blob/main/install.sh`}
              rel="noopener"
              className="link"
            >
              install.sh in the repository
            </a>
            , and the{' '}
            <a href="/docs/install" className="link">
              installation page
            </a>{' '}
            covers the manual Docker Compose route, ports, and where your data
            lives.
          </p>
        </Section>

        {/* ── use cases ───────────────────────────────────────────────── */}
        <Section id="use-cases" title="What people point it at">
          <p className="mt-4">
            Every one of these is the same primitive — a source, some
            destinations, and a trigger — aimed at a different problem.
          </p>
          <div className="mt-5 space-y-4">
            {USE_CASES.map((u) => (
              <p key={u.title}>
                <span className="font-semibold">{u.title}</span>{' '}
                <span className="text-muted-foreground">({u.tag}).</span>{' '}
                {u.body}
              </p>
            ))}
          </div>
        </Section>

        {/* ── http destinations ───────────────────────────────────────── */}
        <Section title="When the destination is an API">
          <p className="mt-4">
            Sometimes the thing that needs the rows is a service, not another
            database. A bridge can POST each change to a URL instead, with a
            JSON body you shape yourself:
          </p>
          <CodeBlock title="Payload template">{`{
  "event": "row.changed",
  "op": "{{$op}}",
  "row": "{{$row}}",
  "sent_at": "{{$now}}"
}`}</CodeBlock>
          <p className="mt-4">
            Tokens fill in per row — any column by name, the whole row, the
            operation that produced it. Substitution happens on the parsed
            JSON, never by pasting strings together, so a value full of quotes
            cannot break the body and nothing in a row is ever executed. Failed
            requests retry with backoff. The details live in{' '}
            <a href="/docs/bridges" className="link">
              How bridges work
            </a>
            .
          </p>
        </Section>

        {/* ── what it isn't ───────────────────────────────────────────── */}
        <Section id="compare" title="What it isn’t">
          <p className="mt-4">
            Knowing what a tool refuses to be tells you as much as its feature
            list, so, plainly:
          </p>
          <div className="mt-5 space-y-4">
            <p>
              <span className="font-semibold">Not a data platform.</span> No
              Kafka, no connector marketplace, no scheduling DAGs. Airbyte
              expects a platform deployment and a team to operate it, and
              Debezium expects Kafka; both are built for teams running
              pipelines as a discipline. If that is you, they will serve you
              better — genuinely. Syncle is for one person who wants their
              databases to agree.
            </p>
            <p>
              <span className="font-semibold">Not a cloud service.</span>{' '}
              Nothing is hosted and there is no account. You run it, it is
              yours, and backing it up is your job too — the{' '}
              <a href="/docs/self-hosting" className="link">
                self-hosting page
              </a>{' '}
              says exactly what to back up.
            </p>
            <p>
              <span className="font-semibold">Not multi-user.</span> One admin
              account, on purpose. It is a tool for the person who operates the
              machine, not a workspace for a department.
            </p>
            <p>
              <span className="font-semibold">Not magic.</span> CDC has
              per-engine prerequisites, SQLite has no change log to read, and
              Redis change events are not durable. The documentation writes
              every limitation next to the feature it limits.
            </p>
          </div>
        </Section>

        {/* ── security ────────────────────────────────────────────────── */}
        <Section id="security" title="Your data, your machines">
          <p className="mt-4">
            A sync tool sees every row it moves and holds the credentials to
            both ends. That earns some scrutiny, so here is exactly where
            things stand:
          </p>
          <div className="mt-5 space-y-4">
            {SECURITY.map((item) => (
              <p key={item.title}>
                <span className="font-semibold">{item.title}.</span> {item.body}
              </p>
            ))}
          </div>
        </Section>

        {/* ── under the hood ──────────────────────────────────────────── */}
        <Section title="Under the hood">
          <p className="mt-4">
            The first stable release, 1.0.0, shipped on 23 July 2026, after
            the project grew up under its working name, Data Bridge.{' '}
            {/* the sentence already names 1.0.0; only add the clause once
                the changelog has something newer to report */}
            {release && release.version !== '1.0.0' ? (
              <>
                The current release is {release.version}, from{' '}
                {formatReleaseDate(release.date)}.
              </>
            ) : (
              <>The link below always points at the current release.</>
            )}{' '}
            It is TypeScript throughout: a NestJS API and a Next.js
            interface, running as four containers behind one published port,
            keeping their own state in a bundled PostgreSQL and Redis. The
            interface speaks English and Chinese, and the whole thing is MIT
            licensed.
          </p>
          <p className="mt-4">
            The changelog follows Keep a Changelog and releases aim at semantic
            versioning, so a version number tells you whether an update is a
            fix or a change. <code className="code">syncle update</code> moves a
            running install to the newest release whenever you decide to.
          </p>
          <p className="mt-4">
            <a href={`${GITHUB}/releases/latest`} rel="noopener" className="link">
              Releases
            </a>
            <span className="mx-3 text-muted-foreground">·</span>
            <a
              href={`${GITHUB}/blob/main/CHANGELOG.md`}
              rel="noopener"
              className="link"
            >
              Changelog
            </a>
          </p>
        </Section>

        {/* ── documentation ───────────────────────────────────────────── */}
        <Section id="docs" title="The documentation">
          <p className="mt-4">
            Nine short pages cover the whole tool. Every command, default and
            endpoint in them was taken from the source code rather than from
            memory, and where something has a limit, the limit is written next
            to it.
          </p>
          <ul className="mt-5 space-y-3 text-[15px]">
            {DOC_PAGES.map((page) => (
              <li key={page.slug}>
                <a href={docHref(page)} className="link">
                  {page.title}
                </a>{' '}
                <span className="text-muted-foreground">
                  — {page.description}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        {/* ── faq ─────────────────────────────────────────────────────── */}
        <Section id="faq" title="Questions people ask first">
          <div className="mt-5 space-y-6">
            {FAQ.map((item) => (
              <div key={item.q}>
                <h3 className="text-[1.05rem]">{item.q}</h3>
                <p className="mt-2">{item.a}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* ── closing ─────────────────────────────────────────────────── */}
        <Section title="Try it against two databases you already have">
          <p className="mt-4">
            One command, about a minute, and nothing to clean up afterwards if
            it is not for you — <code className="code">syncle uninstall</code>{' '}
            removes every trace.
          </p>
          <div className="mt-5">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
          <p className="mt-5">
            <a href="/docs/quickstart" className="link">
              Follow the quickstart
            </a>
          </p>
          <p className="mt-10">
            Questions and setup help go in{' '}
            <a href={`${GITHUB}/discussions`} rel="noopener" className="link">
              Discussions
            </a>
            , where the answer stays readable for whoever asks the same thing
            next month. Bug reports and rough edges go in{' '}
            <a href={`${GITHUB}/issues`} rel="noopener" className="link">
              the issue tracker
            </a>{' '}
            — including places where the documentation and the software
            disagree, which counts as a bug here. I read all of them. Code
            contributions are welcome too; the{' '}
            <a
              href={`${GITHUB}/blob/main/CONTRIBUTING.md`}
              rel="noopener"
              className="link"
            >
              contributing guide
            </a>{' '}
            covers the setup, which is three commands once you have Node 22,
            pnpm 10 and Docker. Security problems go by email rather than into
            a public issue — the{' '}
            <a href="/docs/self-hosting#reporting" className="link">
              self-hosting page
            </a>{' '}
            explains how.
          </p>
          <p className="mb-16 mt-5">— Osman Ahmadzai</p>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
