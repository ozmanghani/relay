/**
 * core adapter contract.
 *
 * every database engine Syncle supports (relational, document, key-value,
 * or anything added later) implements {@link DatabaseAdapter}. the rest of the
 * app (API routes, UI) depends ONLY on these types, never on a concrete driver.
 * so adding a new engine means: implement this interface and register it, that's it.
 *
 * this module is intentionally framework-agnostic: no Next.js, React, or Node
 * server imports. pure domain logic, unit-testable in isolation
 */

export type DatabaseEngine =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mongodb'
  | 'redis'
  | 'mssql';

/** the query dialect an engine exposes to the editor surface */
export type QueryLanguage = 'sql' | 'mongo' | 'redis' | 'none';

/**
 * declarative description of what an engine can do. the UI reads these to
 * enable/disable features (e.g. hide the ER diagram tab for Redis) instead of
 * branching on the engine name all over the place
 */
export interface AdapterCapabilities {
  /** supports arbitrary user-authored queries in the editor */
  query: boolean;
  /** the language the query editor should use */
  queryLanguage: QueryLanguage;
  /** has a schema/namespace layer above tables (e.g. Postgres schemas) */
  schemas: boolean;
  /** supports multiple databases/catalogs on one connection */
  multipleDatabases: boolean;
  /** exposes foreign-key relationships (drives the ER diagram) */
  foreignKeys: boolean;
  /** supports row-level insert/update/delete through the data grid */
  rowEditing: boolean;
  /** whether transactions are available for batched mutations */
  transactions: boolean;
  /** supports creating / dropping / truncating tables (or collections) */
  ddl: boolean;
  /** supports creating / dropping databases on this connection */
  manageDatabases: boolean;
  /** backup/restore formats this engine can produce/consume */
  backupFormats: BackupFormat[];
}

/* -------------------------------------------------------------------------- */
/* connection configuration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * optional SSH tunnel in front of a network engine: the server dials the SSH
 * host and port-forwards to the database, so the adapter connects to a local
 * loopback port instead of the (unreachable) database host directly. sqlite is
 * file-based and never tunnels. like `password`, the secret fields
 * (`password` / `privateKey` / `passphrase`) are encrypted at rest and only
 * ever decrypted inside the server process — this module carries the shape
 * only, the tunnel runtime lives in the API server
 */
export interface SshTunnelConfig {
  enabled: boolean;
  /** SSH server (jump host) to dial */
  host: string;
  /** SSH port, default 22 */
  port?: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  /** for authMethod "password" */
  password?: string;
  /** PEM-encoded private key, for authMethod "privateKey" */
  privateKey?: string;
  /** passphrase protecting the private key, if any */
  passphrase?: string;
}

/**
 * a saved connection. engine-specific validation happens in each adapter; the
 * shared shape keeps the store and UI uniform. `password` is only ever present
 * in decrypted form inside the server process, it's encrypted at rest
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  /** the workspace this connection belongs to */
  workspaceId: string;
  engine: DatabaseEngine;
  /** optional accent color for the UI (hex) */
  color?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** database name, or file path for SQLite */
  database?: string;
  /** use TLS. engine adapters interpret the specifics */
  ssl?: boolean;
  /** full connection URI; when present, takes precedence over discrete fields */
  connectionString?: string;
  /** free-form engine-specific options (e.g. Mongo authSource, Redis db index) */
  options?: Record<string, unknown>;
  /**
   * server-set restriction (never user input): when present, file-backed
   * engines (SQLite) may only open paths under this directory
   */
  fileBaseDir?: string;
  /** reach the database through an SSH tunnel (network engines only) */
  ssh?: SshTunnelConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * a connection without the assigned id / timestamps (creation payload).
 * workspaceId is optional here — the server falls back to the default workspace.
 */
export type ConnectionInput = Omit<
  ConnectionConfig,
  'id' | 'createdAt' | 'updatedAt' | 'workspaceId'
> & { workspaceId?: string };

/* -------------------------------------------------------------------------- */
/* schema introspection                                                       */
/* -------------------------------------------------------------------------- */

export interface ColumnSchema {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  defaultValue: string | null;
  comment: string | null;
  /** outbound foreign-key target, if this column references another table */
  references: {
    schema?: string;
    table: string;
    column: string;
  } | null;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeySchema {
  name: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
}

export type RelationKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'collection'
  | 'keyspace';

export interface TableSchema {
  name: string;
  schema?: string;
  kind: RelationKind;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  primaryKey: string[];
  estimatedRows: number | null;
  comment: string | null;
}

export interface SchemaNamespace {
  /** schema/namespace name. empty string for engines without a schema layer */
  name: string;
  tables: TableSchema[];
}

export interface DatabaseSchema {
  database: string;
  namespaces: SchemaNamespace[];
}

/* -------------------------------------------------------------------------- */
/* query + browse                                                             */
/* -------------------------------------------------------------------------- */

export interface QueryColumn {
  name: string;
  dataType?: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
  /** rows returned for reads; affected rows for writes */
  rowCount: number;
  affectedRows?: number;
  executionMs: number;
  /** true when the result was capped by the configured row limit */
  truncated?: boolean;
  /** statement kind / operation name, e.g. "SELECT" or "find" */
  command?: string;
  /** informational message from the engine (notices, warnings) */
  notice?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'notNull'
  | 'in';

export interface FilterSpec {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface BrowseParams {
  schema?: string;
  table: string;
  limit: number;
  offset: number;
  sort?: SortSpec[];
  filters?: FilterSpec[];
}

export interface BrowseResult extends QueryResult {
  /** total rows matching the filter, or null when too expensive to compute */
  total: number | null;
  /** true when `total` is an approximate catalog estimate, not an exact count */
  estimated?: boolean;
  /** true when more rows exist beyond this page (from a `limit + 1` probe) */
  hasMore: boolean;
  primaryKey: string[];
}

/* -------------------------------------------------------------------------- */
/* mutations                                                                  */
/* -------------------------------------------------------------------------- */

/** column → value map identifying a single row (its primary key) */
export type RowIdentity = Record<string, unknown>;

export interface InsertRowParams {
  schema?: string;
  table: string;
  values: Record<string, unknown>;
}

export interface UpdateRowParams {
  schema?: string;
  table: string;
  identity: RowIdentity;
  changes: Record<string, unknown>;
}

export interface DeleteRowParams {
  schema?: string;
  table: string;
  identity: RowIdentity;
}

/**
 * insert-or-update a row keyed by `keyColumns`. used by database-to-database
 * bridges so a re-delivered row never duplicates: each engine performs this
 * atomically in its native dialect (Postgres/SQLite `ON CONFLICT`, MySQL
 * `ON DUPLICATE KEY`, Mongo `updateOne({upsert:true})`).
 */
export interface UpsertRowParams {
  schema?: string;
  table: string;
  values: Record<string, unknown>;
  /** columns that uniquely identify the row (must be a unique/primary key) */
  keyColumns: string[];
}

/* -------------------------------------------------------------------------- */
/* batched writes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Batched variants of the single-row writes. A sink handling a stream of
 * changes would otherwise pay a full round trip per row, which dominates
 * throughput once the database is anywhere but localhost.
 *
 * These are OPTIONAL on {@link DatabaseAdapter}: an engine that cannot express
 * a set-based write simply omits them and callers fall back to looping the
 * single-row methods. Callers MUST therefore guard with
 * `adapter.upsertRows?.(...)` rather than assuming availability.
 *
 * Rows are NOT required to share a column set — implementations group by the
 * columns actually present, since a change stream can emit sparse rows.
 */
export interface InsertRowsParams {
  schema?: string;
  table: string;
  rows: Array<Record<string, unknown>>;
}

export interface UpsertRowsParams {
  schema?: string;
  table: string;
  rows: Array<Record<string, unknown>>;
  /** columns that uniquely identify a row (must be a unique/primary key) */
  keyColumns: string[];
}

export interface DeleteRowsParams {
  schema?: string;
  table: string;
  /** one identity per row to remove; all must use the same key columns */
  identities: RowIdentity[];
}

/* -------------------------------------------------------------------------- */
/* schema management (DDL)                                                     */
/* -------------------------------------------------------------------------- */

export interface ColumnDefinition {
  name: string;
  /** raw column type for the engine, e.g. "varchar(255)", "int", "text" */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique?: boolean;
  /** raw default expression, e.g. "0", "now()", "'pending'" */
  defaultValue?: string;
}

export interface CreateTableSpec {
  schema?: string;
  table: string;
  columns: ColumnDefinition[];
}

/* -------------------------------------------------------------------------- */
/* backup & restore                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `json`: portable, engine-agnostic dump (schema + data) that any engine can
 * read back, with parameterized inserts on restore.
 * `sql`: a `.sql` script of DDL + INSERT statements (relational engines only)
 */
export type BackupFormat = 'json' | 'sql';

export interface BackupOptions {
  format: BackupFormat;
  /** restrict to these relations; defaults to every table in the database */
  tables?: string[];
  schema?: string;
}

/** the portable JSON backup shape (also embedded inside `json` dumps) */
export interface BackupDocument {
  syncle: 'backup';
  version: 1;
  engine: DatabaseEngine;
  database: string;
  createdAt: string;
  tables: Array<{
    name: string;
    schema?: string;
    primaryKey: string[];
    columns: string[];
    rows: Array<Record<string, unknown>>;
  }>;
}

export interface RestoreResult {
  tables: number;
  rows: number;
}

/* -------------------------------------------------------------------------- */
/* the adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface DatabaseAdapter {
  readonly engine: DatabaseEngine;
  readonly capabilities: AdapterCapabilities;

  /** establish the underlying connection/pool. idempotent */
  connect(): Promise<void>;
  /** lightweight liveness check */
  ping(): Promise<void>;
  /** release all resources */
  close(): Promise<void>;

  /** list databases/catalogs reachable on this connection */
  listDatabases(): Promise<string[]>;
  /** introspect the full schema of the active (or given) database */
  getSchema(database?: string): Promise<DatabaseSchema>;

  /** paginated, filtered, sorted read of a single relation */
  browse(params: BrowseParams): Promise<BrowseResult>;
  /** run a user-authored statement in the engine's query language */
  query(statement: string, params?: unknown[]): Promise<QueryResult>;

  insertRow(params: InsertRowParams): Promise<QueryResult>;
  updateRow(params: UpdateRowParams): Promise<QueryResult>;
  deleteRow(params: DeleteRowParams): Promise<QueryResult>;
  /** insert-or-update keyed by `keyColumns`, atomic in the engine's dialect */
  upsertRow(params: UpsertRowParams): Promise<QueryResult>;

  /* ----- optional set-based writes; see InsertRowsParams for the contract ----- */
  insertRows?(params: InsertRowsParams): Promise<QueryResult>;
  upsertRows?(params: UpsertRowsParams): Promise<QueryResult>;
  deleteRows?(params: DeleteRowsParams): Promise<QueryResult>;

  /* schema management, guarded by `capabilities.ddl` / `manageDatabases` */
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  createTable(spec: CreateTableSpec): Promise<void>;
  dropTable(table: string, schema?: string): Promise<void>;
  truncateTable(table: string, schema?: string): Promise<void>;

  /* backup & restore, guarded by `capabilities.backupFormats` */
  backup(options: BackupOptions): Promise<string>;
  restore(content: string, format: BackupFormat): Promise<RestoreResult>;

  /**
   * run `fn` inside a single-connection transaction: every adapter mutation
   * issued from within `fn` runs on one dedicated connection, and the whole set
   * commits atomically (or rolls back if `fn` throws). used by the database
   * sink so a batch of rows to one target is all-or-nothing, keeping a retry of
   * a failed batch from double-applying rows that already committed.
   *
   * optional and capability-gated: engines with `capabilities.transactions`
   * (Postgres/MySQL/SQLite) provide real BEGIN/COMMIT/ROLLBACK. engines without
   * multi-statement ACID (Mongo/Redis) run `fn` as a plain pass-through — no
   * atomicity is implied; their retry-safety comes from idempotent upsert/delete
   * per row instead. callers MUST treat this as optional (`adapter.withTransaction?.(...)`)
   * and fall back to running the work directly when it is absent.
   */
  withTransaction?<T>(fn: () => Promise<T>): Promise<T>;
}
