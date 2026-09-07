# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- MySQL CDC refuses to resume when the connection reaches a different server
  than the one that issued its stored binlog position. File and position are
  only meaningful on the issuing server, so after a failover the old cursor
  pointed somewhere unrelated and the stream read it anyway. Cursors now carry
  the server's `@@server_uuid`, and the transaction's GTID alongside it.
- A MySQL bridge no longer starts reporting itself as running before the binlog
  reader is positioned. On a fresh bridge that races the first writes, and rows
  written immediately after starting were lost.

### Changed

- Documentation no longer claims MariaDB support. Connections, replay and watch
  bridges work through `mysql2`, but CDC reads the binlog with a client that
  targets MySQL and has not been verified against MariaDB. The 1.0.0 notes
  below listed it; that was the claim being corrected here, not a regression.
- `binlog_transaction_compression` is documented as unsupported. MySQL 8.0.20+
  can wrap row events in a compressed payload event that the binlog reader
  cannot decode, so those rows are not seen.

## [1.2.0] - 2026-08-21

Setup no longer sends you to the container logs.

### Changed

- `syncle up` reads the first-run setup token off the server and opens the GUI
  with it already accepted, so creating the admin account is a username and a
  password rather than a hunt through `syncle logs api`. The token is mirrored
  to a `0600` file in the API's data directory, so reading it still requires
  container access on that host — which is exactly what the token attests.
  Anyone reaching the instance over the network still faces an empty token
  field. The token travels in the URL *fragment*, which browsers never send
  upstream, is stripped from the address bar on read, is deleted the moment
  setup succeeds, and is cleared at boot if an account already exists.

### Fixed

- `syncle up` works offline. A failed image pull aborted the whole start, so a
  machine with the images already cached could not run Syncle at all. The pull
  is now best-effort, and a genuinely missing image fails at `up` with a
  clearer message.
- The installer resolves the right image tag. It used the release tag verbatim
  (`v1.2.0`) where images publish without the prefix (`1.2.0`), so a fresh
  install died with `failed to resolve reference … not found`.

## [1.1.0] - 2026-08-21

One command to install, SSH tunnels, and hooks renamed to bridges.

### Added

- One-command Docker install (`install.sh`) and the `syncle` launcher CLI —
  `up`, `down`, `logs`, `update`, `uninstall`. The app image is pulled prebuilt
  from GHCR, so nothing is compiled locally and the repository is never cloned.
- **SSH tunnels**, for databases that only listen on a private network and have
  to be reached through a bastion host.
- Chinese (zh) localization for the web app, via `next-intl`. Thanks to
  @250shiwo.
- Delivered rows can be read as a table with columns derived from the payloads,
  or as a newest-first feed. The original cell grid remains as **Map**, where
  queued sequences can be skipped.
- A **setup token** guarding first-run account creation, so an exposed instance
  cannot be claimed by whoever reaches it first.
- Rate limiting on login and setup attempts, and an SSRF guard on outbound HTTP
  destinations.

### Changed

- **Breaking.** A *hook* is now a **bridge** and a *run* is now a **job**,
  throughout. `/api/hooks` is now `/api/bridges`; anything scripting against
  the API needs updating. The web UI is unaffected and the database migrates
  itself on upgrade.
- The bridge builder was split into sections backed by a single draft reducer.

### Fixed

- **CDC** — closed data-loss and ordering gaps in event-based bridges.
- **Watch triggers** — ordering, a livelock, lookback handling, filters and
  cancellation; the lookback dedupe now stays stable across truncated pages.
- **Delivery retries and database sinks** — integrity fixes so a retry or a
  write cannot double-apply or drop rows.
- **Lifecycle and resume** — one lifecycle owner, dialect hooks, abort signals
  actually honoured, and exact keyset resume.
- Master key and signing key hygiene.

## [1.0.0] - 2026-07-23

First stable release: visual hooks between any supported engines (PostgreSQL,
MySQL/MariaDB, SQLite, MongoDB, Redis) and HTTP endpoints, fired by one-shot
replay, cursor polling, or change-data-capture — with idempotent multi-target
delivery, a live timeline, and the database workbench.

### Added

- Database-to-database sync: rows move across engines directly, with HTTP
  endpoints as an extra destination rather than the only one.
- Workspaces, and a live workspace map.
- Event-based (CDC) delivery for **MySQL** (binlog), **MongoDB** (change
  streams), and **Redis** (keyspace notifications), alongside the existing
  PostgreSQL logical-replication support. Each engine sits behind a shared
  `CdcProvider` interface.
- A login system and a settings section.
- The `{{$op}}` payload token, exposing the change operation
  (`insert` / `update` / `delete`) for CDC and watch hooks.
- README visuals: animated banner, badges, diagrams, and a how-to guide.

### Changed

- Renamed the project to **Syncle** (formerly Data Bridge).
- The internal metadata store now runs on **PostgreSQL** instead of SQLite.
- The live delivery monitor fetches one final time when a run finishes, so the
  last cells settle correctly; added a LIVE indicator and auto-follow paging.

### Fixed

- Crash, data-loss, and injection paths across the API layer, the sync engine,
  and core adapters; multi-target writes are atomic and backup memory is
  bounded.
- Stale-state bugs in the studio, which now updates instantly.
- Delivery timeline now uses the run's snapshot `batchSize`, keeping cells
  aligned even after a hook is edited mid-run.
