/** PostgreSQL adapter backed by `pg` with a per-connection pool */
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult as PgResult,
} from 'pg';
import type {
  InsertRowsParams,
  UpsertRowsParams,
  AdapterCapabilities,
  ColumnSchema,
  ConnectionConfig,
  DatabaseSchema,
  ForeignKeySchema,
  IndexSchema,
  QueryResult,
  SchemaNamespace,
  TableSchema,
} from '../types';
import { ConnectionError, QueryError } from '../../errors';
import { quoteIdent } from '../../sql';
import {
  BaseSqlAdapter,
  type SqlTransactionConnection,
} from './base-sql-adapter';

export const POSTGRES_CAPABILITIES: AdapterCapabilities = {
  query: true,
  queryLanguage: 'sql',
  schemas: true,
  multipleDatabases: true,
  foreignKeys: true,
  rowEditing: true,
  transactions: true,
  ddl: true,
  manageDatabases: true,
  backupFormats: ['json', 'sql'],
};

export class PostgresAdapter extends BaseSqlAdapter {
  readonly engine = 'postgres' as const;
  readonly capabilities = POSTGRES_CAPABILITIES;

  private pool: Pool | null = null;
  /** last error emitted by an idle pooled client (kept for diagnostics) */
  private lastPoolError: Error | null = null;

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const cfg: PoolConfig = this.config.connectionString
      ? { connectionString: this.config.connectionString }
      : {
          host: this.config.host,
          port: this.config.port ?? 5432,
          user: this.config.user,
          password: this.config.password,
          database: this.config.database,
        };
    cfg.max = 5;
    cfg.idleTimeoutMillis = 30_000;
    cfg.connectionTimeoutMillis = 10_000;
    // self-signed certs are the norm for dev databases, so verification is
    // opt-in: set options.sslVerify to true to enforce a trusted CA chain
    if (this.config.ssl) {
      cfg.ssl = { rejectUnauthorized: this.config.options?.sslVerify === true };
    }
    this.pool = new Pool(cfg);
    // an idle client losing its connection emits 'error' on the pool; with no
    // listener Node treats it as an unhandled 'error' event and crashes the
    // process. core has no logger, so just remember it — the next query will
    // surface the failure to the caller anyway
    this.pool.on('error', (err) => {
      this.lastPoolError = err;
    });
    return this.pool;
  }

  async connect(): Promise<void> {
    await this.ping();
  }

  async ping(): Promise<void> {
    try {
      const client = await this.getPool().connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    } catch (err) {
      throw new ConnectionError(
        `Could not connect to PostgreSQL: ${(err as Error).message}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Bulk writes that carry the rows as ONE json parameter instead of one
   * parameter per value.
   *
   * A multi-row INSERT binds `rows × columns` parameters, and the wire protocol
   * caps that at 65,535 — so a large batch has to be split into several
   * statements no matter how much the caller batched, and each split pays a
   * parse and a round trip. `json_populate_recordset(null::table, $1)` binds a
   * single value however many rows it carries, and takes its column types from
   * the target table itself, so no introspection is needed.
   *
   * Only used when it is safe: values must survive JSON. A Buffer would not
   * (bytea has no JSON representation here), so those fall back to the
   * parameterised path in the base class, which stays correct if slower.
   */
  private jsonSafe(rows: Array<Record<string, unknown>>): boolean {
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (v instanceof Uint8Array || typeof v === 'bigint') return false;
      }
    }
    return true;
  }

  /** rows below this are cheaper as a plain multi-row INSERT */
  private static readonly JSON_BULK_MIN = 250;

  override async insertRows(p: InsertRowsParams): Promise<QueryResult> {
    if (p.rows.length < PostgresAdapter.JSON_BULK_MIN || !this.jsonSafe(p.rows)) {
      return super.insertRows(p);
    }
    return this.jsonBulk(p.table, p.schema, p.rows, '');
  }

  override async upsertRows(p: UpsertRowsParams): Promise<QueryResult> {
    if (
      p.rows.length < PostgresAdapter.JSON_BULK_MIN ||
      p.keyColumns.length === 0 ||
      !this.jsonSafe(p.rows)
    ) {
      return super.upsertRows(p);
    }
    // grouped by column set, because the tail names the columns to update
    let affected = 0;
    for (const [, group] of this.groupRows(p.rows)) {
      const tail = this.upsertClause(p.keyColumns, Object.keys(group[0] ?? {}));
      const res = await this.jsonBulk(p.table, p.schema, group, tail);
      affected += res.affectedRows ?? group.length;
    }
    return {
      affectedRows: affected,
      rowCount: affected,
      rows: [],
      columns: [],
      executionMs: 0,
    };
  }

  /** group rows by their exact column set; sparse streams need this */
  private groupRows(
    rows: Array<Record<string, unknown>>,
  ): Map<string, Array<Record<string, unknown>>> {
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = JSON.stringify(Object.keys(row).sort());
      const existing = groups.get(key);
      if (existing) existing.push(row);
      else groups.set(key, [row]);
    }
    return groups;
  }

  /** one statement, one parameter, however many rows */
  private async jsonBulk(
    table: string,
    schema: string | undefined,
    rows: Array<Record<string, unknown>>,
    tail: string,
  ): Promise<QueryResult> {
    const target = this.qualify(table, schema);
    const columns = Object.keys(rows[0] ?? {});
    if (columns.length === 0) {
      return { affectedRows: 0, rowCount: 0, rows: [], columns: [], executionMs: 0 };
    }
    const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
    const sql =
      `INSERT INTO ${target} (${colSql}) ` +
      `SELECT ${colSql} FROM json_populate_recordset(null::${target}, $1::json) ` +
      tail;
    const res = await this.runSql(sql.trim(), [JSON.stringify(rows)]);
    return {
      affectedRows: res.affectedRows ?? rows.length,
      rowCount: res.affectedRows ?? rows.length,
      rows: [],
      columns: [],
      executionMs: res.executionMs ?? 0,
    };
  }

  protected override quoteIdent(identifier: string): string {
    return quoteIdent('postgres', identifier);
  }

  protected override placeholder(index: number): string {
    return `$${index}`;
  }

  protected override likeKeyword(): string {
    return 'ILIKE';
  }

  protected override serialType(): string {
    return 'SERIAL';
  }

  protected override booleanLiteral(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
  }

  protected override hexLiteral(buf: Buffer): string {
    return `'\\x${buf.toString('hex')}'`;
  }

  protected override async execPooled(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    const started = performance.now();
    try {
      const raw = (await this.getPool().query(sql, params)) as
        | PgResult
        | PgResult[];
      return normalizePgResult(raw, started);
    } catch (err) {
      throw new QueryError((err as Error).message, { sql });
    }
  }

  /** borrow a single pooled client and drive BEGIN/COMMIT/ROLLBACK on it */
  protected override async acquireTransactionConnection(): Promise<SqlTransactionConnection> {
    const client: PoolClient = await this.getPool().connect();
    return {
      run: async (sql, params) => {
        const started = performance.now();
        try {
          const raw = (await client.query(sql, params)) as
            | PgResult
            | PgResult[];
          return normalizePgResult(raw, started);
        } catch (err) {
          throw new QueryError((err as Error).message, { sql });
        }
      },
      begin: async () => {
        await client.query('BEGIN');
      },
      commit: async () => {
        await client.query('COMMIT');
      },
      rollback: async () => {
        await client.query('ROLLBACK');
      },
      release: () => client.release(),
    };
  }

  protected override async countRows(args: {
    table: string;
    schema?: string;
    hasFilters: boolean;
  }): Promise<{ total: number | null; estimated: boolean }> {
    // exact COUNT(*) on a large filtered view is expensive, skip it
    if (args.hasFilters) return { total: null, estimated: false };
    // use the planner's row estimate, instant, no table scan
    const target = this.qualify(args.table, args.schema);
    const res = await this.runSql(
      `SELECT reltuples::bigint AS count FROM pg_class WHERE oid = $1::regclass`,
      [target],
    ).catch(() => null);
    const n = res?.rows[0] ? Number(res.rows[0].count) : null;
    // reltuples is -1 (PG14+) / 0 for never-analyzed tables, report unknown
    if (n == null || n < 1) return { total: null, estimated: false };
    return { total: n, estimated: true };
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.runSql(
      `SELECT datname FROM pg_database
       WHERE datistemplate = false ORDER BY datname`,
      [],
    );
    return res.rows.map((r) => String(r.datname));
  }

  async getSchema(): Promise<DatabaseSchema> {
    const database =
      this.config.database ??
      (await this.runSql('SELECT current_database() AS db', [])).rows[0]?.db;

    // columns across all user schemas in one pass
    const cols = await this.runSql(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
              c.is_nullable, c.column_default, c.ordinal_position
       FROM information_schema.columns c
       WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      [],
    );

    const relkind = await this.runSql(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','v','m')
         AND n.nspname NOT IN ('pg_catalog','information_schema')`,
      [],
    );

    const pks = await this.runSql(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'`,
      [],
    );

    const fks = await this.runSql(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table,
              ccu.column_name AS ref_column, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'`,
      [],
    );

    const indexes = await this.runSql(
      `SELECT schemaname AS schema, tablename AS table, indexname AS name,
              indexdef
       FROM pg_indexes
       WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      [],
    );

    return buildSchema(String(database ?? ''), {
      cols: cols.rows,
      relkind: relkind.rows,
      pks: pks.rows,
      fks: fks.rows,
      indexes: indexes.rows,
    });
  }
}

type Row = Record<string, unknown>;

/** shape a raw `pg` result (or multi-statement array) into a QueryResult */
function normalizePgResult(
  raw: PgResult | PgResult[],
  started: number,
): QueryResult {
  const executionMs = Math.round(performance.now() - started);
  // a multi-statement query makes `pg` return an ARRAY of results, one per
  // statement — report the last one (matches psql's behavior)
  const res = Array.isArray(raw) ? raw[raw.length - 1]! : raw;
  return {
    columns: (res.fields ?? []).map((f) => ({
      name: f.name,
      dataType: String(f.dataTypeID),
    })),
    rows: res.rows as Array<Record<string, unknown>>,
    rowCount: res.rowCount ?? res.rows.length,
    affectedRows: /^(INSERT|UPDATE|DELETE)/i.test(res.command)
      ? (res.rowCount ?? 0)
      : undefined,
    executionMs,
    command: res.command,
  };
}

function buildSchema(
  database: string,
  data: {
    cols: Row[];
    relkind: Row[];
    pks: Row[];
    fks: Row[];
    indexes: Row[];
  },
): DatabaseSchema {
  const kindMap = new Map<string, string>();
  for (const r of data.relkind) {
    kindMap.set(`${r.schema}.${r.name}`, String(r.relkind));
  }

  const pkSet = new Set<string>();
  for (const r of data.pks) {
    pkSet.add(`${r.table_schema}.${r.table_name}.${r.column_name}`);
  }

  const fkByTable = new Map<string, ForeignKeySchema[]>();
  const fkColTarget = new Map<string, { table: string; column: string; schema?: string }>();
  for (const r of data.fks) {
    const key = `${r.table_schema}.${r.table_name}`;
    const list = fkByTable.get(key) ?? [];
    list.push({
      name: String(r.constraint_name),
      columns: [String(r.column_name)],
      referencedSchema: String(r.ref_schema),
      referencedTable: String(r.ref_table),
      referencedColumns: [String(r.ref_column)],
    });
    fkByTable.set(key, list);
    fkColTarget.set(`${key}.${r.column_name}`, {
      schema: String(r.ref_schema),
      table: String(r.ref_table),
      column: String(r.ref_column),
    });
  }

  const idxByTable = new Map<string, IndexSchema[]>();
  for (const r of data.indexes) {
    const key = `${r.schema}.${r.table}`;
    const def = String(r.indexdef);
    const colMatch = def.match(/\(([^)]+)\)/);
    const columns = colMatch
      ? colMatch[1]!.split(',').map((c) => c.trim().replace(/"/g, ''))
      : [];
    const list = idxByTable.get(key) ?? [];
    list.push({
      name: String(r.name),
      columns,
      unique: /UNIQUE/i.test(def),
      primary: false,
    });
    idxByTable.set(key, list);
  }

  const tableMap = new Map<string, TableSchema>();
  for (const r of data.cols) {
    const schema = String(r.table_schema);
    const name = String(r.table_name);
    const key = `${schema}.${name}`;
    let table = tableMap.get(key);
    if (!table) {
      const relkind = kindMap.get(key);
      table = {
        name,
        schema,
        kind:
          relkind === 'v'
            ? 'view'
            : relkind === 'm'
              ? 'materialized_view'
              : 'table',
        columns: [],
        indexes: idxByTable.get(key) ?? [],
        foreignKeys: fkByTable.get(key) ?? [],
        primaryKey: [],
        estimatedRows: null,
        comment: null,
      };
      tableMap.set(key, table);
    }
    const isPk = pkSet.has(`${key}.${r.column_name}`);
    const column: ColumnSchema = {
      name: String(r.column_name),
      dataType: String(r.data_type),
      nullable: r.is_nullable === 'YES',
      isPrimaryKey: isPk,
      isUnique: false,
      isAutoIncrement: /nextval/.test(String(r.column_default ?? '')),
      defaultValue: r.column_default != null ? String(r.column_default) : null,
      comment: null,
      references: fkColTarget.get(`${key}.${r.column_name}`) ?? null,
    };
    table.columns.push(column);
    if (isPk) table.primaryKey.push(column.name);
  }

  const namespaces = new Map<string, SchemaNamespace>();
  for (const table of tableMap.values()) {
    const ns = table.schema ?? 'public';
    const bucket = namespaces.get(ns) ?? { name: ns, tables: [] };
    bucket.tables.push(table);
    namespaces.set(ns, bucket);
  }

  return {
    database: String(database),
    namespaces: [...namespaces.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}
