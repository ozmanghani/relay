/**
 * shared implementation for relational engines.
 *
 * concrete SQL adapters (Postgres, MySQL, SQLite, ...) only implement the
 * connection lifecycle, schema introspection, three small dialect primitives
 * (`quoteIdent`, `placeholder`, `execPooled`) and, where their dialect
 * deviates, the overridable hooks (`likeKeyword`, `upsertClause`,
 * `booleanLiteral`, `hexLiteral`, `escapeStringLiteral`, ...). everything
 * user-facing (browse, raw query, row mutations) is built here ONCE, with
 * strict parameterization so no user value is ever concatenated into SQL
 */
import type {
  AdapterCapabilities,
  BackupDocument,
  BackupFormat,
  BackupOptions,
  BrowseParams,
  BrowseResult,
  ColumnDefinition,
  ConnectionConfig,
  CreateTableSpec,
  DatabaseAdapter,
  DatabaseEngine,
  DatabaseSchema,
  DeleteRowParams,
  DeleteRowsParams,
  FilterSpec,
  InsertRowParams,
  InsertRowsParams,
  QueryResult,
  RestoreResult,
  TableSchema,
  UpdateRowParams,
  UpsertRowParams,
  UpsertRowsParams,
} from '../types';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestError } from '../../errors';

/**
 * a single database connection borrowed from the driver pool for the lifetime
 * of a transaction. `run` executes one parameterized statement on THIS
 * connection (so every mutation inside a transaction shares it); the lifecycle
 * hooks issue the transaction control statements and hand the connection back.
 */
export interface SqlTransactionConnection {
  run(sql: string, params: unknown[]): Promise<QueryResult>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

const RESTORE_BATCH = 500;

/**
 * rows fetched per round-trip when streaming a table out for backup. keeps the
 * working set bounded (this many rows in memory at once) instead of loading a
 * whole table via one `SELECT *`, which OOMs on multi-GB tables.
 */
const BACKUP_FETCH_BATCH = 1000;

/** reject identifiers that aren't safe to embed in DDL (which can't be bound) */
export function assertSafeIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new BadRequestError(
      `Invalid identifier "${name}". Use letters, digits and underscores.`,
    );
  }
  return name;
}

/** keyword/function DEFAULT expressions accepted verbatim (case-insensitive) */
const DEFAULT_EXPR_ALLOWLIST = new Set([
  'current_timestamp',
  'current_date',
  'current_time',
  'now()',
  'null',
  'true',
  'false',
  'gen_random_uuid()',
  'uuid()',
]);

/**
 * a DEFAULT expression can't be a bound parameter, so validate it against a
 * conservative grammar before it is interpolated into DDL: a numeric literal,
 * a single-quoted string (with only `''` escapes), or an allowlisted
 * keyword/function. everything else is rejected — this is the injection gate
 * for create-table.
 */
export function assertSafeDefaultValue(value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^'(?:[^'\\]|'')*'$/.test(v)) return v;
  if (DEFAULT_EXPR_ALLOWLIST.has(v.toLowerCase())) return v;
  throw new BadRequestError(
    `Invalid DEFAULT value ${JSON.stringify(value)}. ` +
      `Use a number, a single-quoted string, or one of ` +
      `CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME, now(), NULL, TRUE, ` +
      `FALSE, gen_random_uuid(), uuid().`,
  );
}

/** coerce a limit/offset to a safe non-negative integer for interpolation */
function assertPageBound(value: number, label: string): number {
  const n = Math.trunc(Number(value));
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError(
      `Invalid ${label}: expected a non-negative integer`,
    );
  }
  return n;
}

const DEFAULT_MAX_ROWS = 5000;

export abstract class BaseSqlAdapter implements DatabaseAdapter {
  abstract readonly engine: DatabaseEngine;
  abstract readonly capabilities: AdapterCapabilities;

  protected readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  protected get maxRows(): number {
    const fromOpts = Number(this.config.options?.maxQueryRows);
    return Number.isFinite(fromOpts) && fromOpts > 0
      ? fromOpts
      : DEFAULT_MAX_ROWS;
  }

  /* ----- lifecycle / introspection: concrete adapters implement these ----- */
  abstract connect(): Promise<void>;
  abstract ping(): Promise<void>;
  abstract close(): Promise<void>;
  abstract listDatabases(): Promise<string[]>;
  abstract getSchema(database?: string): Promise<DatabaseSchema>;

  /* ----- dialect primitives ----- */

  /** quote an identifier (table/column) safely for this dialect */
  protected abstract quoteIdent(identifier: string): string;

  /**
   * render a positional placeholder for the n-th (1-based) parameter.
   * Postgres → `$1`, MySQL/SQLite → `?`
   */
  protected abstract placeholder(index: number): string;

  /**
   * run a parameterized statement on the driver pool and return a normalized
   * result. subclasses implement ONLY this pooled path; the transaction-aware
   * routing lives in {@link runSql}.
   */
  protected abstract execPooled(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult>;

  /**
   * borrow one connection from the driver pool for a transaction. optional:
   * an engine that leaves it undefined simply doesn't support
   * {@link withTransaction} (and its {@link AdapterCapabilities.transactions}
   * must be false). the returned connection must issue every statement on the
   * SAME underlying socket so BEGIN/…/COMMIT are one transaction.
   */
  protected acquireTransactionConnection?(): Promise<SqlTransactionConnection>;

  /**
   * the connection bound to the currently-running transaction, if any.
   * scoped per async call-tree (NOT per instance) so concurrent deliveries
   * sharing one pooled adapter never cross-wire onto each other's transaction.
   */
  private readonly txStore =
    new AsyncLocalStorage<SqlTransactionConnection>();

  /**
   * run a parameterized statement. when called inside {@link withTransaction}
   * it routes to that transaction's dedicated connection; otherwise it goes to
   * the pool. every shared mutation helper (insertRow/upsertRow/deleteRow/…)
   * funnels through here, so wrapping a batch in `withTransaction` makes the
   * whole batch atomic with no changes to those helpers.
   */
  protected async runSql(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    const tx = this.txStore.getStore();
    return tx ? tx.run(sql, params) : this.execPooled(sql, params);
  }

  /**
   * run `fn` inside a real BEGIN/COMMIT/ROLLBACK on a single pooled connection.
   * inner adapter calls (which route through {@link runSql}) automatically use
   * that same connection via async-local scoping, so the batch is atomic: a
   * failure rolls the whole batch back, so a retry can't double-apply rows that
   * already committed. only available when the engine can lend a dedicated
   * connection ({@link acquireTransactionConnection}); callers gate on
   * `capabilities.transactions`.
   */
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.acquireTransactionConnection) {
      // no dedicated-connection support: run inline (no atomicity guarantee)
      return fn();
    }
    // a nested withTransaction reuses the outer transaction's connection rather
    // than opening a second one that would deadlock or commit independently
    const existing = this.txStore.getStore();
    if (existing) return fn();

    const conn = await this.acquireTransactionConnection();
    try {
      await conn.begin();
      const result = await this.txStore.run(conn, fn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  /** LIKE keyword for case-insensitive matching (Postgres → ILIKE) */
  protected likeKeyword(): string {
    return 'LIKE';
  }

  /* ----- shared SQL building ----- */

  protected qualify(table: string, schema?: string): string {
    return schema
      ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}`
      : this.quoteIdent(table);
  }

  /**
   * build a parameterized WHERE clause from filters.
   * returns the SQL fragment (without leading WHERE) and the bound params
   */
  private buildWhere(
    filters: FilterSpec[] | undefined,
    startIndex: number,
  ): { clause: string; params: unknown[] } {
    if (!filters || filters.length === 0) return { clause: '', params: [] };

    const params: unknown[] = [];
    let idx = startIndex;
    const parts = filters.map((f) => {
      const col = this.quoteIdent(f.column);
      switch (f.operator) {
        case 'isNull':
          return `${col} IS NULL`;
        case 'notNull':
          return `${col} IS NOT NULL`;
        case 'eq':
          params.push(f.value);
          return `${col} = ${this.placeholder(idx++)}`;
        case 'neq':
          params.push(f.value);
          return `${col} <> ${this.placeholder(idx++)}`;
        case 'lt':
          params.push(f.value);
          return `${col} < ${this.placeholder(idx++)}`;
        case 'lte':
          params.push(f.value);
          return `${col} <= ${this.placeholder(idx++)}`;
        case 'gt':
          params.push(f.value);
          return `${col} > ${this.placeholder(idx++)}`;
        case 'gte':
          params.push(f.value);
          return `${col} >= ${this.placeholder(idx++)}`;
        case 'contains':
          params.push(`%${String(f.value ?? '')}%`);
          return `${col} ${this.likeKeyword()} ${this.placeholder(idx++)}`;
        case 'startsWith':
          params.push(`${String(f.value ?? '')}%`);
          return `${col} ${this.likeKeyword()} ${this.placeholder(idx++)}`;
        case 'endsWith':
          params.push(`%${String(f.value ?? '')}`);
          return `${col} ${this.likeKeyword()} ${this.placeholder(idx++)}`;
        case 'in': {
          const values = Array.isArray(f.value) ? f.value : [];
          if (values.length === 0) return '1 = 0'; // matches nothing
          const placeholders = values.map((v) => {
            params.push(v);
            return this.placeholder(idx++);
          });
          return `${col} IN (${placeholders.join(', ')})`;
        }
        default:
          throw new BadRequestError(
            `Unsupported filter operator: ${String(f.operator)}`,
          );
      }
    });

    return { clause: parts.join(' AND '), params };
  }

  async browse(params: BrowseParams): Promise<BrowseResult> {
    // limit/offset are interpolated (not bindable everywhere), so they must be
    // proven integers — a NaN would otherwise flow straight into the SQL
    const limit = Math.min(
      Math.max(assertPageBound(params.limit, 'limit'), 1),
      this.maxRows,
    );
    const offset = assertPageBound(params.offset, 'offset');
    const target = this.qualify(params.table, params.schema);

    const where = this.buildWhere(params.filters, 1);
    const whereSql = where.clause ? ` WHERE ${where.clause}` : '';

    let orderSql = '';
    if (params.sort && params.sort.length > 0) {
      orderSql =
        ' ORDER BY ' +
        params.sort
          .map(
            (s) =>
              `${this.quoteIdent(s.column)} ${
                s.direction === 'desc' ? 'DESC' : 'ASC'
              }`,
          )
          .join(', ');
    }

    // fetch one extra row to learn whether a next page exists, way cheaper
    // than a COUNT(*) on every page for large tables
    const probe = limit + 1;
    const sql =
      `SELECT * FROM ${target}${whereSql}${orderSql} ` +
      `LIMIT ${probe} OFFSET ${offset}`;

    const hasFilters = !!params.filters && params.filters.length > 0;
    const [data, count, pk] = await Promise.all([
      this.runSql(sql, where.params),
      this.countRows({
        table: params.table,
        schema: params.schema,
        whereSql,
        whereParams: where.params,
        hasFilters,
      }).catch(() => ({ total: null, estimated: false })),
      this.primaryKeyColumns(params.table, params.schema),
    ]);

    const hasMore = data.rows.length > limit;
    const rows = hasMore ? data.rows.slice(0, limit) : data.rows;

    return {
      ...data,
      rows,
      rowCount: rows.length,
      total: count.total,
      estimated: count.estimated,
      hasMore,
      primaryKey: pk,
    };
  }

  /**
   * row total for the browse footer. the default runs an exact `COUNT(*)`,
   * which is fine for local engines (SQLite). server engines override this to
   * use cheap catalog estimates and to skip counting filtered views entirely
   */
  protected async countRows(args: {
    table: string;
    schema?: string;
    whereSql: string;
    whereParams: unknown[];
    hasFilters: boolean;
  }): Promise<{ total: number | null; estimated: boolean }> {
    const target = this.qualify(args.table, args.schema);
    const res = await this.runSql(
      `SELECT COUNT(*) AS count FROM ${target}${args.whereSql}`,
      args.whereParams,
    );
    const total = res.rows[0] ? Number(res.rows[0].count) : null;
    return { total: Number.isFinite(total) ? total : null, estimated: false };
  }

  async query(statement: string, params?: unknown[]): Promise<QueryResult> {
    const result = await this.runSql(statement, params ?? []);
    if (result.rows.length > this.maxRows) {
      return {
        ...result,
        rows: result.rows.slice(0, this.maxRows),
        rowCount: this.maxRows,
        truncated: true,
      };
    }
    return result;
  }

  async insertRow(p: InsertRowParams): Promise<QueryResult> {
    const cols = Object.keys(p.values);
    if (cols.length === 0) {
      throw new BadRequestError('Cannot insert a row with no values');
    }
    const target = this.qualify(p.table, p.schema);
    const placeholders = cols.map((_, i) => this.placeholder(i + 1));
    const sql =
      `INSERT INTO ${target} (${cols.map((c) => this.quoteIdent(c)).join(', ')}) ` +
      `VALUES (${placeholders.join(', ')})`;
    return this.runSql(
      sql,
      cols.map((c) => p.values[c]),
    );
  }

  async updateRow(p: UpdateRowParams): Promise<QueryResult> {
    const changeCols = Object.keys(p.changes);
    const idCols = Object.keys(p.identity);
    if (changeCols.length === 0) {
      throw new BadRequestError('No changes provided');
    }
    if (idCols.length === 0) {
      throw new BadRequestError(
        'Cannot update a row without a primary key identity',
      );
    }
    const target = this.qualify(p.table, p.schema);
    const params: unknown[] = [];
    let idx = 1;

    const setSql = changeCols
      .map((c) => {
        params.push(p.changes[c]);
        return `${this.quoteIdent(c)} = ${this.placeholder(idx++)}`;
      })
      .join(', ');

    const whereSql = idCols
      .map((c) => {
        params.push(p.identity[c]);
        return `${this.quoteIdent(c)} = ${this.placeholder(idx++)}`;
      })
      .join(' AND ');

    return this.runSql(
      `UPDATE ${target} SET ${setSql} WHERE ${whereSql}`,
      params,
    );
  }

  async deleteRow(p: DeleteRowParams): Promise<QueryResult> {
    const idCols = Object.keys(p.identity);
    if (idCols.length === 0) {
      throw new BadRequestError(
        'Cannot delete a row without a primary key identity',
      );
    }
    const target = this.qualify(p.table, p.schema);
    const params: unknown[] = [];
    const whereSql = idCols
      .map((c, i) => {
        params.push(p.identity[c]);
        return `${this.quoteIdent(c)} = ${this.placeholder(i + 1)}`;
      })
      .join(' AND ');

    return this.runSql(`DELETE FROM ${target} WHERE ${whereSql}`, params);
  }

  /**
   * dialect-specific "upsert" tail appended to an `INSERT ... VALUES (...)`.
   * given the conflict key columns and the full column list, return the
   * `ON CONFLICT ...` / `ON DUPLICATE KEY UPDATE ...` clause. Postgres & SQLite
   * share the standard form, MySQL overrides.
   */
  protected upsertClause(keyColumns: string[], allColumns: string[]): string {
    const updates = allColumns
      .filter((c) => !keyColumns.includes(c))
      .map((c) => `${this.quoteIdent(c)} = EXCLUDED.${this.quoteIdent(c)}`);
    const keys = keyColumns.map((c) => this.quoteIdent(c)).join(', ');
    // no non-key columns to update → just ignore the duplicate
    if (updates.length === 0) return `ON CONFLICT (${keys}) DO NOTHING`;
    return `ON CONFLICT (${keys}) DO UPDATE SET ${updates.join(', ')}`;
  }

  async upsertRow(p: UpsertRowParams): Promise<QueryResult> {
    const cols = Object.keys(p.values);
    if (cols.length === 0) {
      throw new BadRequestError('Cannot upsert a row with no values');
    }
    if (p.keyColumns.length === 0) {
      throw new BadRequestError(
        'Cannot upsert without key columns to match on',
      );
    }
    const target = this.qualify(p.table, p.schema);
    const placeholders = cols.map((_, i) => this.placeholder(i + 1));
    const sql =
      `INSERT INTO ${target} (${cols.map((c) => this.quoteIdent(c)).join(', ')}) ` +
      `VALUES (${placeholders.join(', ')}) ` +
      this.upsertClause(p.keyColumns, cols);
    return this.runSql(
      sql,
      cols.map((c) => p.values[c]),
    );
  }

  /* ----- set-based writes ----------------------------------------------- */

  /**
   * Group rows by the exact set of columns they carry. A change stream can emit
   * sparse rows, and one multi-row INSERT needs a single uniform column list,
   * so rows with different shapes go into separate statements. Insertion order
   * is preserved within each group.
   */
  private groupByColumns(
    rows: Array<Record<string, unknown>>,
  ): Array<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
    const groups = new Map<
      string,
      { columns: string[]; rows: Array<Record<string, unknown>> }
    >();
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      // the signature must not collide across different column sets, so it is
      // built from the sorted names; the emitted column order stays as-written
      const key = JSON.stringify([...columns].sort());
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { columns, rows: [row] });
    }
    return [...groups.values()];
  }

  /** rows per statement so `rows × columns` stays under the driver's bind cap */
  private chunkSize(columnCount: number): number {
    return Math.max(1, Math.floor(this.maxBindParams() / Math.max(1, columnCount)));
  }

  /**
   * One INSERT per column-shape and bind-limit chunk. `tail` appends the
   * dialect's upsert clause when this is an upsert.
   *
   * Values are bound exactly as {@link insertRow} binds them, so a batched
   * write and the per-row loop it replaces are indistinguishable to the engine.
   */
  private async insertGrouped(
    table: string,
    schema: string | undefined,
    rows: Array<Record<string, unknown>>,
    tail: (columns: string[]) => string,
  ): Promise<QueryResult> {
    const target = this.qualify(table, schema);
    let affected = 0;
    for (const group of this.groupByColumns(rows)) {
      const { columns } = group;
      const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
      const size = this.chunkSize(columns.length);
      for (let i = 0; i < group.rows.length; i += size) {
        const chunk = group.rows.slice(i, i + size);
        const params: unknown[] = [];
        let ph = 1;
        const tuples = chunk.map((row) => {
          const placeholders = columns.map((c) => {
            params.push(row[c]);
            return this.placeholder(ph++);
          });
          return `(${placeholders.join(', ')})`;
        });
        const res = await this.runSql(
          `INSERT INTO ${target} (${colSql}) VALUES ${tuples.join(', ')} ${tail(columns)}`.trim(),
          params,
        );
        // engines report affected rows inconsistently for multi-row upserts
        // (MySQL counts an update as 2); fall back to the rows we sent
        affected += res.affectedRows ?? chunk.length;
      }
    }
    return { affectedRows: affected, rowCount: affected, rows: [], columns: [], executionMs: 0 };
  }

  async insertRows(p: InsertRowsParams): Promise<QueryResult> {
    if (p.rows.length === 0) {
      return { affectedRows: 0, rowCount: 0, rows: [], columns: [], executionMs: 0 };
    }
    return this.insertGrouped(p.table, p.schema, p.rows, () => '');
  }

  async upsertRows(p: UpsertRowsParams): Promise<QueryResult> {
    if (p.rows.length === 0) {
      return { affectedRows: 0, rowCount: 0, rows: [], columns: [], executionMs: 0 };
    }
    if (p.keyColumns.length === 0) {
      throw new BadRequestError('Cannot upsert without key columns to match on');
    }
    return this.insertGrouped(p.table, p.schema, p.rows, (columns) =>
      this.upsertClause(p.keyColumns, columns),
    );
  }

  /**
   * Upper bound on OR-ed clauses in one DELETE. Staying under the bind cap is
   * not sufficient: SQLite also limits expression-tree DEPTH (1000 by default),
   * and a long chain of ORs is a deep tree, so a batch well within the bind
   * budget can still be rejected. Single-column keys avoid the issue entirely
   * by using a flat IN list; this cap covers the composite-key form.
   */
  protected maxOrClauses(): number {
    return 200;
  }

  /**
   * Deletes many identities. A single key column becomes `k IN (?, ?, …)`,
   * which is flat and cheap; composite keys fall back to
   * `(a = ? AND b = ?) OR (…)`, since an IN over tuples is not portable.
   */
  async deleteRows(p: DeleteRowsParams): Promise<QueryResult> {
    if (p.identities.length === 0) {
      return { affectedRows: 0, rowCount: 0, rows: [], columns: [], executionMs: 0 };
    }
    const target = this.qualify(p.table, p.schema);
    let affected = 0;
    for (const group of this.groupByColumns(p.identities)) {
      const { columns } = group;
      const single = columns.length === 1 ? columns[0] : undefined;
      // a flat IN list has no depth problem, so it is only bind-capped
      const size =
        single !== undefined
          ? this.chunkSize(1)
          : Math.min(this.chunkSize(columns.length), this.maxOrClauses());

      for (let i = 0; i < group.rows.length; i += size) {
        const chunk = group.rows.slice(i, i + size);
        const params: unknown[] = [];
        let ph = 1;
        let where: string;

        if (single !== undefined) {
          const list = chunk.map((identity) => {
            params.push(identity[single]);
            return this.placeholder(ph++);
          });
          where = `${this.quoteIdent(single)} IN (${list.join(', ')})`;
        } else {
          const clauses = chunk.map((identity) => {
            const conds = columns.map((c) => {
              params.push(identity[c]);
              return `${this.quoteIdent(c)} = ${this.placeholder(ph++)}`;
            });
            return `(${conds.join(' AND ')})`;
          });
          where = clauses.join(' OR ');
        }

        const res = await this.runSql(
          `DELETE FROM ${target} WHERE ${where}`,
          params,
        );
        affected += res.affectedRows ?? 0;
      }
    }
    return { affectedRows: affected, rowCount: affected, rows: [], columns: [], executionMs: 0 };
  }

  /* ----- schema management (DDL) ----- */

  /** auto-increment keyword appended after the type (MySQL → AUTO_INCREMENT) */
  protected autoIncrementKeyword(): string | null {
    return null;
  }

  /** serial pseudo-type that replaces the column type (Postgres → SERIAL) */
  protected serialType(): string | null {
    return null;
  }

  /** validate a raw column type string (it can't be a bound parameter) */
  protected validateType(type: string): string {
    const t = type.trim();
    if (!/^[A-Za-z0-9_ (),]+$/.test(t)) {
      throw new BadRequestError(`Invalid column type: "${type}"`);
    }
    return t;
  }

  protected columnSql(col: ColumnDefinition): string {
    const name = this.quoteIdent(assertSafeIdentifier(col.name));
    let typeSql = this.validateType(col.type);
    if (col.autoIncrement && this.serialType()) typeSql = this.serialType()!;
    let sql = `${name} ${typeSql}`;
    if (col.autoIncrement && this.autoIncrementKeyword()) {
      sql += ` ${this.autoIncrementKeyword()}`;
    }
    if (!col.nullable) sql += ' NOT NULL';
    if (col.unique && !col.primaryKey) sql += ' UNIQUE';
    if (col.defaultValue && col.defaultValue.trim()) {
      sql += ` DEFAULT ${assertSafeDefaultValue(col.defaultValue)}`;
    }
    return sql;
  }

  async createTable(spec: CreateTableSpec): Promise<void> {
    if (!spec.columns.length) {
      throw new BadRequestError('A table needs at least one column');
    }
    const target = this.qualify(
      assertSafeIdentifier(spec.table),
      spec.schema ? assertSafeIdentifier(spec.schema) : undefined,
    );
    const parts = spec.columns.map((c) => this.columnSql(c));
    const pk = spec.columns
      .filter((c) => c.primaryKey)
      .map((c) => this.quoteIdent(c.name));
    if (pk.length) parts.push(`PRIMARY KEY (${pk.join(', ')})`);
    await this.runSql(`CREATE TABLE ${target} (${parts.join(', ')})`, []);
  }

  async dropTable(table: string, schema?: string): Promise<void> {
    await this.runSql(`DROP TABLE ${this.qualify(table, schema)}`, []);
  }

  async truncateTable(table: string, schema?: string): Promise<void> {
    await this.runSql(`TRUNCATE TABLE ${this.qualify(table, schema)}`, []);
  }

  async createDatabase(name: string): Promise<void> {
    await this.runSql(
      `CREATE DATABASE ${this.quoteIdent(assertSafeIdentifier(name))}`,
      [],
    );
  }

  async dropDatabase(name: string): Promise<void> {
    await this.runSql(
      `DROP DATABASE ${this.quoteIdent(assertSafeIdentifier(name))}`,
      [],
    );
  }

  /* ----- backup & restore ----- */

  /** boolean literal for SQL dumps (Postgres → TRUE/FALSE, others → 1/0) */
  protected booleanLiteral(value: boolean): string {
    return value ? '1' : '0';
  }

  private async targetTables(opts: BackupOptions): Promise<TableSchema[]> {
    const schema = await this.getSchema();
    let tables = schema.namespaces.flatMap((ns) => ns.tables);
    tables = tables.filter((t) => t.kind === 'table');
    if (opts.schema)
      tables = tables.filter((t) => (t.schema ?? '') === opts.schema);
    if (opts.tables?.length) {
      const wanted = new Set(opts.tables);
      tables = tables.filter((t) => wanted.has(t.name));
    }
    return tables;
  }

  /**
   * page through a table in fixed-size batches, invoking `onBatch` per page and
   * freeing each page before fetching the next. memory stays bounded to
   * {@link BACKUP_FETCH_BATCH} rows rather than the whole table. paging is by
   * `LIMIT/OFFSET` (bounds proven-integer, so safe to interpolate), ordered by
   * the primary key when one exists to keep the window stable across pages.
   */
  private async forEachRowBatch(
    table: TableSchema,
    onBatch: (rows: Array<Record<string, unknown>>) => void,
  ): Promise<void> {
    const target = this.qualify(table.name, table.schema);
    const orderSql = table.primaryKey.length
      ? ` ORDER BY ${table.primaryKey.map((c) => this.quoteIdent(c)).join(', ')}`
      : '';
    let offset = 0;
    for (;;) {
      const res = await this.runSql(
        `SELECT * FROM ${target}${orderSql} ` +
          `LIMIT ${BACKUP_FETCH_BATCH} OFFSET ${offset}`,
        [],
      );
      onBatch(res.rows);
      if (res.rows.length < BACKUP_FETCH_BATCH) break;
      offset += res.rows.length;
    }
  }

  /**
   * dump the database to a portable JSON document or a `.sql` script.
   *
   * memory is bounded to {@link BACKUP_FETCH_BATCH} rows: each table is streamed
   * out in fixed-size pages rather than loaded whole via one `SELECT *`, so a
   * multi-GB table no longer OOMs the process (and takes down live bridges).
   * for the JSON format the assembled document still holds every row before it
   * is stringified — the residual ceiling is the total row set, not two copies
   * of it, because rows are appended incrementally and each fetched page is
   * freed after being encoded. the `sql` format is fully bounded (each page is
   * serialized to text and the rows dropped). the OUTPUT is unchanged from the
   * previous single-`SELECT *` implementation, so existing restores still work.
   */
  async backup(opts: BackupOptions): Promise<string> {
    const { database } = await this.getSchema();
    const tables = await this.targetTables(opts);

    if (opts.format === 'json') {
      const doc: BackupDocument = {
        syncle: 'backup',
        version: 1,
        engine: this.engine,
        database,
        createdAt: new Date().toISOString(),
        tables: [],
      };
      for (const t of tables) {
        const rows: Array<Record<string, unknown>> = [];
        await this.forEachRowBatch(t, (batch) => {
          for (const row of batch) rows.push(encodeRowForBackup(row));
        });
        doc.tables.push({
          name: t.name,
          schema: t.schema,
          primaryKey: t.primaryKey,
          columns: t.columns.map((c) => c.name),
          rows,
        });
      }
      return JSON.stringify(doc, null, 2);
    }

    // SQL dump: DDL + INSERT statements
    const out: string[] = [
      `-- Syncle SQL backup`,
      `-- engine: ${this.engine}`,
      `-- database: ${database}`,
      ``,
    ];
    for (const t of tables) {
      out.push(this.createTableDump(t), ``);
      const cols = t.columns.map((c) => c.name);
      const colSql = cols.map((c) => this.quoteIdent(c)).join(', ');
      const target = this.qualify(t.name, t.schema);
      let wrote = false;
      await this.forEachRowBatch(t, (batch) => {
        for (const row of batch) {
          const values = cols.map((c) => this.sqlLiteral(row[c])).join(', ');
          out.push(`INSERT INTO ${target} (${colSql}) VALUES (${values});`);
          wrote = true;
        }
      });
      if (wrote) out.push(``);
    }
    return out.join('\n');
  }

  private createTableDump(t: TableSchema): string {
    const defs = t.columns.map((c) => {
      let s = `  ${this.quoteIdent(c.name)} ${c.dataType}`;
      if (!c.nullable) s += ' NOT NULL';
      // skip sequence-backed defaults, they aren't portable in a logical dump
      if (c.defaultValue && !/nextval|auto_increment/i.test(c.defaultValue)) {
        s += ` DEFAULT ${c.defaultValue}`;
      }
      return s;
    });
    if (t.primaryKey.length) {
      defs.push(
        `  PRIMARY KEY (${t.primaryKey.map((c) => this.quoteIdent(c)).join(', ')})`,
      );
    }
    return `CREATE TABLE IF NOT EXISTS ${this.qualify(t.name, t.schema)} (\n${defs.join(',\n')}\n);`;
  }

  /** binary literal for SQL dumps: `X'..'` (Postgres overrides with `'\x..'`) */
  protected hexLiteral(buf: Buffer): string {
    return `X'${buf.toString('hex')}'`;
  }

  /**
   * escape a string for embedding in a single-quoted SQL literal. the default
   * doubles quotes per the SQL standard; dialects with extra escape characters
   * override (MySQL also doubles backslashes).
   */
  protected escapeStringLiteral(text: string): string {
    return text.replace(/'/g, "''");
  }

  private sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return this.booleanLiteral(value);
    if (value instanceof Date) return `'${value.toISOString()}'`;
    if (Buffer.isBuffer(value)) return this.hexLiteral(value);
    const text =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `'${this.escapeStringLiteral(text)}'`;
  }

  async restore(content: string, format: BackupFormat): Promise<RestoreResult> {
    if (format === 'sql') {
      const statements = splitSqlStatements(content);
      let count = 0;
      for (const stmt of statements) {
        await this.runSql(stmt, []);
        count++;
      }
      return { tables: 0, rows: count };
    }

    let doc: BackupDocument;
    try {
      doc = JSON.parse(content) as BackupDocument;
    } catch {
      throw new BadRequestError('Backup file is not valid JSON');
    }
    if (doc.syncle !== 'backup' || !Array.isArray(doc.tables)) {
      throw new BadRequestError('Not a Syncle backup file');
    }

    let rows = 0;
    for (const table of doc.tables) {
      // best-effort recreate; ignore "already exists"
      await this.createTable({
        schema: table.schema,
        table: table.name,
        columns: table.columns.map((name) => ({
          name,
          type: this.defaultRestoreType(),
          nullable: true,
          primaryKey: false,
          autoIncrement: false,
        })),
      }).catch(() => undefined);

      rows += await this.bulkInsert(
        table.name,
        table.schema,
        table.columns,
        table.rows,
      );
    }
    return { tables: doc.tables.length, rows };
  }

  /** column type used when recreating a table from a column-name-only dump */
  protected defaultRestoreType(): string {
    return 'TEXT';
  }

  /**
   * driver cap on bound placeholders per statement (Postgres/MySQL 65k-ish;
   * SQLite overrides with its lower 32766). restore batches are sized so
   * `rows × columns` stays under it even for very wide tables
   */
  protected maxBindParams(): number {
    return 65_534;
  }

  private async bulkInsert(
    table: string,
    schema: string | undefined,
    columns: string[],
    rows: Array<Record<string, unknown>>,
  ): Promise<number> {
    if (rows.length === 0 || columns.length === 0) return 0;
    const target = this.qualify(table, schema);
    const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
    const batchSize = Math.max(
      1,
      Math.min(RESTORE_BATCH, Math.floor(this.maxBindParams() / columns.length)),
    );
    let inserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const params: unknown[] = [];
      let ph = 1;
      const tuples = batch.map((row) => {
        const placeholders = columns.map((c) => {
          params.push(normalizeForInsert(row[c]));
          return this.placeholder(ph++);
        });
        return `(${placeholders.join(', ')})`;
      });
      await this.runSql(
        `INSERT INTO ${target} (${colSql}) VALUES ${tuples.join(', ')}`,
        params,
      );
      inserted += batch.length;
    }
    return inserted;
  }

  /**
   * primary-key columns for a relation, used to build safe row identities.
   * the default derives them from the schema introspection; engines may
   * override for efficiency
   */
  protected async primaryKeyColumns(
    table: string,
    schema?: string,
  ): Promise<string[]> {
    const dbSchema = await this.getSchema();
    for (const ns of dbSchema.namespaces) {
      if (schema && ns.name !== schema) continue;
      const found = ns.tables.find((t) => t.name === table);
      if (found) return found.primaryKey;
    }
    return [];
  }
}

/**
 * encode driver values that don't survive JSON for a backup document. Buffers
 * become the tagged `{ $bytes: base64 }` shape so a restore can rebuild the
 * original bytes instead of stringifying Node's `{type:'Buffer',data:[...]}`
 */
function encodeRowForBackup(
  row: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) {
      out ??= { ...row };
      out[k] = { $bytes: v.toString('base64') };
    }
  }
  return out ?? row;
}

/** decode the tagged `{ $bytes }` shape (or legacy Buffer JSON) to a Buffer */
function decodeBytes(value: Record<string, unknown>): Buffer | null {
  if (typeof value.$bytes === 'string' && Object.keys(value).length === 1) {
    return Buffer.from(value.$bytes, 'base64');
  }
  if (value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data as number[]);
  }
  return null;
}

/** coerce a JSON-decoded value into something a driver can bind for INSERT */
function normalizeForInsert(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    if (Buffer.isBuffer(value)) return value;
    const bytes = decodeBytes(value as Record<string, unknown>);
    if (bytes) return bytes;
    return JSON.stringify(value);
  }
  return value;
}

/**
 * split a `.sql` script into individual statements, respecting single-quoted
 * strings (with `''` escapes) and `--` / block comments. good enough for
 * Syncle-generated dumps and typical hand-written scripts
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inSingle) {
      cur += ch;
      if (ch === "'") {
        if (next === "'") {
          cur += next;
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
