// Db module SDK — the thin guest-side algebra over the `db` spec
// (contracts/spec/db.ts). Framework-agnostic (no solid-js, no JSX): the
// same file serves ./db, ./vue-vapor/db and ./octane/db.
//
// The API is the bun:sqlite shape — `new Database(name)`, `db.query(sql)`
// returning a cached Statement with `.get/.all/.values/.run`, `db.exec`,
// `db.transaction(fn)` — so code written against Bun's built-in SQLite runs
// against the mounted module unchanged, and the model of "SQL in, plain
// objects out" carries across hosts. Two deliberate deviations from
// bun:sqlite, both from the spec:
//
//   - a Statement is a guest-side (db, sql) pair — statement caching is
//     HOST-side, keyed by the sql string, so there is nothing to finalize
//     and no handle to leak. `columnNames` is populated by execution
//     (empty before the first run).
//   - integers beyond 2^53 - 1 and non-finite REALs fail loudly instead of
//     losing precision (DB_MAX_SAFE_INTEGER; store money in cents).
//
// Unlike the audio SDK, absence does NOT degrade to a no-op: data code that
// silently drops writes is a corruption bug, not a missing enhancement.
// `new Database(...)` throws where `globalThis.db` is unmounted — declare
// `data.sqlite` in pocket.json `requires` so admission catches it first.

import { DB_BLOB_KEY, DB_MAX_SAFE_INTEGER, DB_MEMORY } from "../../contracts/spec/db.ts";
// QuickJS has no btoa/Buffer; the codec lives in bytes.ts (cold path),
// shared with the fs SDK.
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";

export { DB_MAX_RESULT_ROWS, DB_MAX_SAFE_INTEGER, DB_MEMORY } from "../../contracts/spec/db.ts";

/** The mounted db namespace — one method per spec op (DB_OP codes). */
export interface DbOps {
  open(name: string): number;
  close(handle: number): void;
  exec(handle: number, sql: string): number;
  query(handle: number, sql: string, args: string): string;
  lastError(handle: number): string;
}

/** The db module namespace, or null where the host doesn't mount one.
 *  A live lookup (not cached): hosts install `globalThis.db` before eval
 *  and reset it per app load, exactly like `globalThis.ui`. */
export function dbHost(): DbOps | null {
  const ns = (globalThis as { db?: unknown }).db;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as DbOps).open === "function" ? (ns as DbOps) : null;
}

// ---------------------------------------------------------------------------
// Value encoding (the contracts/spec/db.ts data contract, both directions)
// ---------------------------------------------------------------------------

/** A value crossing the boundary: what a row cell or a bound parameter is. */
export type SqlValue = null | number | string | boolean | Uint8Array;
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

function encodeValue(v: SqlValue): unknown {
  if (v instanceof Uint8Array) return { [DB_BLOB_KEY]: bytesToBase64(v) };
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error("db: cannot bind a non-finite number");
  }
  if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) > DB_MAX_SAFE_INTEGER) {
    throw new Error("db: integer exceeds DB_MAX_SAFE_INTEGER");
  }
  return v;
}

function decodeValue(v: unknown): SqlValue {
  if (v !== null && typeof v === "object") {
    return base64ToBytes((v as Record<string, string>)[DB_BLOB_KEY]);
  }
  return v as SqlValue;
}

function encodeParams(params: SqlParams): string {
  if (Array.isArray(params)) return JSON.stringify(params.map(encodeValue));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = encodeValue(v as SqlValue);
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Database / Statement (the bun:sqlite shape)
// ---------------------------------------------------------------------------

interface QueryResult {
  cols?: string[];
  rows?: unknown[][];
  changes?: number;
  lastInsertRowid?: number;
  error?: string;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export class Statement {
  private cols: string[] = [];

  constructor(
    private readonly ops: DbOps,
    private readonly handle: number,
    private readonly sql: string,
  ) {}

  /** Column names of the last execution ([] before the first run). */
  get columnNames(): readonly string[] {
    return this.cols;
  }

  private execute(params: SqlParams): QueryResult {
    const line = this.ops.query(this.handle, this.sql, encodeParams(params));
    const result = JSON.parse(line) as QueryResult;
    if (result.error !== undefined) throw new Error(`db: ${result.error}`);
    this.cols = result.cols ?? [];
    return result;
  }

  /** First row as a column-name keyed object, or null. */
  get(...params: SqlValue[]): Record<string, SqlValue> | null;
  get(params: SqlParams): Record<string, SqlValue> | null;
  get(...args: unknown[]): Record<string, SqlValue> | null {
    const rows = this.values(...(args as SqlValue[]));
    if (rows.length === 0) return null;
    const out: Record<string, SqlValue> = {};
    this.cols.forEach((c, i) => (out[c] = rows[0][i]));
    return out;
  }

  /** Every row as a column-name keyed object. */
  all(...params: SqlValue[]): Record<string, SqlValue>[];
  all(params: SqlParams): Record<string, SqlValue>[];
  all(...args: unknown[]): Record<string, SqlValue>[] {
    const rows = this.values(...(args as SqlValue[]));
    return rows.map((r) => {
      const out: Record<string, SqlValue> = {};
      this.cols.forEach((c, i) => (out[c] = r[i]));
      return out;
    });
  }

  /** Every row as an array in column order. */
  values(...params: SqlValue[]): SqlValue[][];
  values(params: SqlParams): SqlValue[][];
  values(...args: unknown[]): SqlValue[][] {
    const params = normalizeArgs(args);
    const result = this.execute(params);
    return (result.rows ?? []).map((r) => r.map(decodeValue));
  }

  /** Execute for effect; rows (if any) are discarded. */
  run(...params: SqlValue[]): RunResult;
  run(params: SqlParams): RunResult;
  run(...args: unknown[]): RunResult {
    const result = this.execute(normalizeArgs(args));
    return { changes: result.changes ?? 0, lastInsertRowid: result.lastInsertRowid ?? 0 };
  }
}

/** Spread positional values, one array, or one named-parameter object. */
function normalizeArgs(args: unknown[]): SqlParams {
  if (args.length === 1 && Array.isArray(args[0])) return args[0] as SqlValue[];
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !(args[0] instanceof Uint8Array)
  ) {
    return args[0] as Record<string, SqlValue>;
  }
  return args as SqlValue[];
}

export class Database {
  private readonly ops: DbOps;
  private readonly handle: number;
  private readonly statements = new Map<string, Statement>();
  private txDepth = 0;

  constructor(name: string = DB_MEMORY) {
    const ops = dbHost();
    if (!ops) {
      throw new Error(
        "db: globalThis.db is not mounted — declare `data.sqlite` in pocket.json requires",
      );
    }
    const handle = ops.open(name);
    if (handle < 0) throw new Error(`db: open(${JSON.stringify(name)}) refused`);
    this.ops = ops;
    this.handle = handle;
  }

  /** Cached statement for `sql` (host-side prepare cache backs it). */
  query(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = new Statement(this.ops, this.handle, sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Uncached statement (the bun:sqlite `prepare` spelling). */
  prepare(sql: string): Statement {
    return new Statement(this.ops, this.handle, sql);
  }

  /** Run one statement with parameters, for effect. */
  run(sql: string, params: SqlParams = []): RunResult {
    return this.query(sql).run(params);
  }

  /** Run one or more statements with no parameters and no result rows —
   *  the schema/migration path. */
  exec(sql: string): void {
    if (this.ops.exec(this.handle, sql) !== 0) {
      throw new Error(`db: ${this.ops.lastError(this.handle)}`);
    }
  }

  /**
   * Wrap `fn` in BEGIN/COMMIT with ROLLBACK on throw; nested calls become
   * savepoints (the bun:sqlite convention). Batching writes into one
   * transaction is also the flash-wear discipline on device hosts.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const name = `pocket_tx_${this.txDepth}`;
      const [begin, commit, rollback] =
        this.txDepth === 0
          ? ["BEGIN", "COMMIT", "ROLLBACK"]
          : [`SAVEPOINT ${name}`, `RELEASE ${name}`, `ROLLBACK TO ${name}; RELEASE ${name}`];
      this.exec(begin);
      this.txDepth++;
      try {
        const result = fn(...args);
        this.txDepth--;
        this.exec(commit);
        return result;
      } catch (error) {
        this.txDepth--;
        this.exec(rollback);
        throw error;
      }
    };
  }

  close(): void {
    this.statements.clear();
    this.ops.close(this.handle);
  }
}
