//! pocket-db — the db module's reference core.
//!
//! SQLite behind the five-op boundary pinned in contracts/spec/db.ts
//! (`pocketjs_core::spec::db` is the generated mirror): open / close / exec /
//! query / lastError, mounted as `globalThis.db` through [`mount`]. Rows
//! cross as one JSON line per `query()` call using the spec's value
//! encoding; statement caching is host-side (rusqlite's prepared-statement
//! cache, keyed by the sql string), so the guest holds no statement handles.
//!
//! Storage policy is the host's: [`Storage::Memory`] for tests and
//! throwaway guests, [`Storage::Dir`] to map each logical database name to
//! `<dir>/<name>.sqlite` — an ORDINARY file in the app's own data root,
//! the same root the fs module is typically bound to. That is deliberate:
//! the database is the app's own asset, visible and touchable like any of
//! its files (backup = a file copy). An app that overwrites its own
//! database corrupts its own data — the same trust class as deleting its
//! own files, and SQLite fails loudly (SQLITE_CORRUPT), not unsafely.
//! `ATTACH` is refused twice over — a real SQLite authorizer for the
//! literal spelling, and `SQLITE_LIMIT_ATTACHED=0` for the expression
//! spelling the authorizer cannot see — which keeps that root the sandbox
//! boundary; `load_extension` stays off (rusqlite's default).
//!
//! ESP32/LittleFS: this crate carries its own ESP-IDF support (the
//! `espidf` module below — newlib symbol shims, the `unix-none` VFS, the
//! flash-friendly pragmas), all behind `cfg(target_os = "espidf")`;
//! desktop builds never see it. The build-environment recipe a firmware
//! needs (C flags, header shim) is documented in docs/DB.md — validated
//! on an ESP32-P4 with a LittleFS workspace, where data survived reopen
//! and power cycling.

#[cfg(feature = "mount")]
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(feature = "mount")]
use std::rc::Rc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use pocketjs_core::spec::db as spec;
use rusqlite::hooks::Authorization;
use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde_json::{json, Map as JsonMap, Value as Json};

/// Where logical database names live.
pub enum Storage {
    /// Every database, named or `:memory:`, is in-memory (tests, previews).
    /// Named databases still share a handle for the module's lifetime.
    Memory,
    /// A named database maps to `<dir>/<name>.sqlite` — an ordinary file
    /// in the app's own data root (created on first open), the same root
    /// the fs module is typically bound to. The guest never sees the path.
    Dir(PathBuf),
}

struct Db {
    conn: Connection,
    name: String,
    last_error: String,
}

/// The db module: every op as a method, [`mount`] to install the namespace.
pub struct DbModule {
    storage: Storage,
    dbs: HashMap<i32, Db>,
    by_name: HashMap<String, i32>,
    next_handle: i32,
}

impl DbModule {
    pub fn new(storage: Storage) -> DbModule {
        DbModule {
            storage,
            dbs: HashMap::new(),
            by_name: HashMap::new(),
            next_handle: 1,
        }
    }

    /// `open(name) -> handle | -1` (spec OP_OPEN).
    pub fn open(&mut self, name: &str) -> i32 {
        let memory = name == spec::MEMORY;
        if !memory {
            if !valid_name(name) {
                return -1;
            }
            if let Some(handle) = self.by_name.get(name) {
                return *handle;
            }
        }
        if self.dbs.len() >= spec::MAX_DATABASES {
            return -1;
        }
        let conn = match &self.storage {
            Storage::Memory => Connection::open_in_memory(),
            Storage::Dir(dir) if !memory => {
                if std::fs::create_dir_all(dir).is_err() {
                    return -1;
                }
                open_file(&dir.join(format!("{name}.sqlite")))
            }
            Storage::Dir(_) => Connection::open_in_memory(),
        };
        let conn = match conn {
            Ok(conn) => conn,
            Err(_) => return -1,
        };
        // The storage rule's teeth: ATTACH names a file, so it is denied at
        // the engine level. A database the authorizer cannot guard is a
        // database this module refuses to open.
        if conn
            .authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                match ctx.action {
                    rusqlite::hooks::AuthAction::Attach { .. } => Authorization::Deny,
                    _ => Authorization::Allow,
                }
            }))
            .is_err()
        {
            return -1;
        }
        // The authorizer only sees a FILENAME literal: `ATTACH <expr> AS x`
        // reaches it with a NULL filename, which rusqlite maps to
        // AuthAction::Unknown — allowed by the catch-all above. The engine
        // attach limit closes every spelling; the authorizer stays for the
        // clearer "not authorized" on the literal form.
        if conn
            .set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_ATTACHED, 0)
            .is_err()
        {
            return -1;
        }
        let handle = self.next_handle;
        self.next_handle += 1;
        self.dbs.insert(
            handle,
            Db {
                conn,
                name: name.to_owned(),
                last_error: String::new(),
            },
        );
        if !memory {
            self.by_name.insert(name.to_owned(), handle);
        }
        handle
    }

    /// `close(handle)` (spec OP_CLOSE) — idempotent.
    pub fn close(&mut self, handle: i32) {
        if let Some(db) = self.dbs.remove(&handle)
            && db.name != spec::MEMORY
        {
            self.by_name.remove(&db.name);
        }
    }

    /// `exec(handle, sql) -> 0 | 1` (spec OP_EXEC).
    pub fn exec(&mut self, handle: i32, sql: &str) -> i32 {
        let Some(db) = self.dbs.get_mut(&handle) else {
            return 1;
        };
        match db.conn.execute_batch(sql) {
            Ok(()) => {
                db.last_error.clear();
                0
            }
            Err(error) => {
                db.last_error = error.to_string();
                1
            }
        }
    }

    /// `query(handle, sql, args) -> json line` (spec OP_QUERY).
    pub fn query(&mut self, handle: i32, sql: &str, args: &str) -> String {
        let Some(db) = self.dbs.get_mut(&handle) else {
            return json!({ "error": "database is closed" }).to_string();
        };
        match run_query(&db.conn, sql, args) {
            Ok(line) => {
                db.last_error.clear();
                line
            }
            Err(message) => {
                db.last_error = message.clone();
                json!({ "error": message }).to_string()
            }
        }
    }

    /// `lastError(handle) -> string` (spec OP_LAST_ERROR).
    pub fn last_error(&self, handle: i32) -> String {
        match self.dbs.get(&handle) {
            Some(db) => db.last_error.clone(),
            None => "database is closed".to_owned(),
        }
    }
}

/// Open a persistent database file the platform way. Desktop: the default
/// VFS. ESP-IDF: the `unix-none` VFS — LittleFS has no fcntl file locks,
/// and a Pocket guest's module instance is the file's only writer — plus
/// the flash-friendly pragmas the ESP32-P4 probe validated (TRUNCATE
/// journal: WAL is compiled out on MCU builds; NORMAL sync; a 32 KiB page
/// cache sized for a device heap).
fn open_file(path: &std::path::Path) -> rusqlite::Result<Connection> {
    #[cfg(not(target_os = "espidf"))]
    {
        Connection::open(path)
    }
    #[cfg(target_os = "espidf")]
    {
        let conn = Connection::open_with_flags_and_vfs(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            "unix-none",
        )?;
        conn.query_row("PRAGMA journal_mode=TRUNCATE", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32;")?;
        Ok(conn)
    }
}

// ---------------------------------------------------------------------------
// ESP-IDF (ESP32) support
// ---------------------------------------------------------------------------
// SQLite's unix VFS keeps a syscall table referencing a handful of POSIX
// symbols newlib does not provide. Under this crate's configuration
// (unix-none VFS, `-Dlstat=stat`, no symlinks, no dotlock files) the first
// five are never actually called — no-op successes are the honest
// implementations for a filesystem with no users, permissions or symlinks.
// nanosleep IS called (the busy handler sleeps); it routes through
// ESP-IDF's usleep. Compiled only for espidf; a desktop build never sees
// these. The build-environment recipe these link against is in docs/DB.md.
#[cfg(target_os = "espidf")]
mod espidf {
    #[repr(C)]
    pub struct Timespec {
        tv_sec: i64, // espidf_time64: 64-bit time_t
        tv_nsec: i32,
    }

    unsafe extern "C" {
        fn usleep(microseconds: u32) -> i32;
    }

    #[unsafe(no_mangle)]
    extern "C" fn geteuid() -> u32 {
        0
    }

    #[unsafe(no_mangle)]
    extern "C" fn fchmod(_fd: i32, _mode: u32) -> i32 {
        0
    }

    #[unsafe(no_mangle)]
    extern "C" fn fchown(_fd: i32, _owner: u32, _group: u32) -> i32 {
        0
    }

    #[unsafe(no_mangle)]
    extern "C" fn utimes(
        _path: *const core::ffi::c_char,
        _times: *const core::ffi::c_void,
    ) -> i32 {
        0
    }

    #[unsafe(no_mangle)]
    extern "C" fn readlink(
        _path: *const core::ffi::c_char,
        _buf: *mut core::ffi::c_char,
        _len: usize,
    ) -> isize {
        -1 // never a symlink on LittleFS
    }

    #[unsafe(no_mangle)]
    extern "C" fn nanosleep(request: *const Timespec, _remain: *mut Timespec) -> i32 {
        let request = unsafe { &*request };
        let micros = (request.tv_sec as u64)
            .saturating_mul(1_000_000)
            .saturating_add((request.tv_nsec as u64) / 1_000);
        unsafe { usleep(micros.min(u32::MAX as u64) as u32) }
    }
}

/// Logical persistent-database names (spec DB_NAME_PATTERN):
/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,56}$`, spelled out to keep regex out of
/// the dependency tree. 57 chars keeps `<name>.sqlite` within the fs
/// module's 64-byte segment ceiling.
fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 57 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn run_query(conn: &Connection, sql: &str, args: &str) -> Result<String, String> {
    let params: Json = serde_json::from_str(args).map_err(|e| format!("malformed args: {e}"))?;
    let mut statement = conn
        .prepare_cached(sql)
        .map_err(|e| e.to_string())?;

    match &params {
        Json::Array(list) => {
            if list.len() != statement.parameter_count() {
                return Err(format!(
                    "expected {} parameters, got {}",
                    statement.parameter_count(),
                    list.len()
                ));
            }
            for (i, value) in list.iter().enumerate() {
                statement
                    .raw_bind_parameter(i + 1, decode_param(value)?)
                    .map_err(|e| e.to_string())?;
            }
        }
        Json::Object(named) => {
            for (key, value) in named {
                let index = statement
                    .parameter_index(key)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("unknown parameter: {key}"))?;
                statement
                    .raw_bind_parameter(index, decode_param(value)?)
                    .map_err(|e| e.to_string())?;
            }
        }
        _ => return Err("args must be a JSON array or object".to_owned()),
    }

    let cols: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let column_count = cols.len();

    let mut rows_out: Vec<Json> = Vec::new();
    let mut rows = statement.raw_query();
    loop {
        let row = rows.next().map_err(|e| e.to_string())?;
        let Some(row) = row else { break };
        if rows_out.len() >= spec::MAX_RESULT_ROWS {
            return Err("query exceeds DB_MAX_RESULT_ROWS; add LIMIT or aggregate".to_owned());
        }
        let mut cells: Vec<Json> = Vec::with_capacity(column_count);
        for i in 0..column_count {
            cells.push(encode_cell(row.get_ref(i).map_err(|e| e.to_string())?)?);
        }
        rows_out.push(Json::Array(cells));
    }
    drop(rows);

    Ok(json!({
        "cols": cols,
        "rows": rows_out,
        "changes": conn.changes(),
        "lastInsertRowid": conn.last_insert_rowid(),
    })
    .to_string())
}

/// JSON parameter -> SQLite value (the spec's binding rules).
fn decode_param(value: &Json) -> Result<Value, String> {
    Ok(match value {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(i64::from(*b)),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i.unsigned_abs() > spec::MAX_SAFE_INTEGER as u64 {
                    return Err("integer exceeds DB_MAX_SAFE_INTEGER".to_owned());
                }
                Value::Integer(i)
            } else {
                let f = n.as_f64().ok_or("unrepresentable number")?;
                if !f.is_finite() {
                    return Err("cannot bind a non-finite number".to_owned());
                }
                Value::Real(f)
            }
        }
        Json::String(s) => Value::Text(s.clone()),
        Json::Object(map) => Value::Blob(decode_blob(map)?),
        Json::Array(_) => return Err("cannot bind an array value".to_owned()),
    })
}

fn decode_blob(map: &JsonMap<String, Json>) -> Result<Vec<u8>, String> {
    let Some(Json::String(b64)) = map.get(spec::BLOB_KEY) else {
        return Err("malformed blob parameter".to_owned());
    };
    BASE64
        .decode(b64)
        .map_err(|e| format!("malformed blob parameter: {e}"))
}

/// SQLite cell -> JSON value (the spec's row encoding; loud on lossy).
fn encode_cell(cell: ValueRef<'_>) -> Result<Json, String> {
    Ok(match cell {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => {
            if i.unsigned_abs() > spec::MAX_SAFE_INTEGER as u64 {
                return Err("integer result exceeds DB_MAX_SAFE_INTEGER".to_owned());
            }
            json!(i)
        }
        ValueRef::Real(f) => {
            if !f.is_finite() {
                return Err("non-finite REAL result".to_owned());
            }
            json!(f)
        }
        ValueRef::Text(t) => {
            Json::String(String::from_utf8(t.to_vec()).map_err(|_| "non-UTF-8 TEXT result")?)
        }
        ValueRef::Blob(b) => json!({ spec::BLOB_KEY: BASE64.encode(b) }),
    })
}

/// Mount the module as `globalThis.db` on a pocket-mod [`Guest`] — one JS
/// function per spec op, marshaled as (i32, String) -> i32/String.
/// Feature `mount` (default); a host with its own QuickJS wiring turns it
/// off and spells these five functions itself.
#[cfg(feature = "mount")]
pub fn mount(guest: &pocket_mod::Guest, module: Rc<RefCell<DbModule>>) -> anyhow::Result<()> {
    use pocket_mod::qjs::Function;
    guest.mount("db", |ctx, ns| {
        let m = module.clone();
        ns.set(
            "open",
            Function::new(ctx.clone(), move |name: String| -> i32 {
                m.borrow_mut().open(&name)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "close",
            Function::new(ctx.clone(), move |handle: i32| {
                m.borrow_mut().close(handle);
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "exec",
            Function::new(ctx.clone(), move |handle: i32, sql: String| -> i32 {
                m.borrow_mut().exec(handle, &sql)
            })?,
        )?;
        let m = module.clone();
        ns.set(
            "query",
            Function::new(
                ctx.clone(),
                move |handle: i32, sql: String, args: String| -> String {
                    m.borrow_mut().query(handle, &sql, &args)
                },
            )?,
        )?;
        let m = module.clone();
        ns.set(
            "lastError",
            Function::new(ctx.clone(), move |handle: i32| -> String {
                m.borrow().last_error(handle)
            })?,
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module() -> DbModule {
        DbModule::new(Storage::Memory)
    }

    fn rows(line: &str) -> Json {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn crud_round_trip_with_positional_and_named_parameters() {
        let mut m = module();
        let h = m.open(spec::MEMORY);
        assert!(h > 0);
        assert_eq!(m.exec(h, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"), 0);
        let ins = rows(&m.query(h, "INSERT INTO t (v) VALUES ($v)", r#"{"$v":"hello"}"#));
        assert_eq!(ins["changes"], 1);
        assert_eq!(ins["lastInsertRowid"], 1);
        let sel = rows(&m.query(h, "SELECT id, v FROM t WHERE id = ?", "[1]"));
        assert_eq!(sel["cols"], json!(["id", "v"]));
        assert_eq!(sel["rows"], json!([[1, "hello"]]));
    }

    #[test]
    fn open_refuses_bad_names_and_over_limit() {
        let mut m = module();
        assert_eq!(m.open("../escape"), -1);
        assert_eq!(m.open(".hidden"), -1);
        assert_eq!(m.open(""), -1);
        // 57 is the ceiling: `<name>.sqlite` stays a valid fs segment.
        assert_eq!(m.open(&"a".repeat(58)), -1);
        let longest = m.open(&"a".repeat(57));
        assert!(longest > 0);
        m.close(longest);
        for i in 0..spec::MAX_DATABASES {
            assert!(m.open(&format!("app-{i}")) > 0);
        }
        assert_eq!(m.open("one-too-many"), -1);
    }

    #[test]
    fn same_persistent_name_shares_a_handle_and_memory_never_does() {
        let mut m = module();
        let a = m.open("app");
        assert_eq!(m.open("app"), a);
        assert_ne!(m.open(spec::MEMORY), m.open(spec::MEMORY));
    }

    #[test]
    fn attach_is_denied_by_the_authorizer() {
        let mut m = module();
        let h = m.open(spec::MEMORY);
        assert_eq!(m.exec(h, "ATTACH DATABASE ':memory:' AS other"), 1);
        assert!(m.last_error(h).contains("not authorized"), "{}", m.last_error(h));
        let line = m.query(h, "ATTACH DATABASE ':memory:' AS other", "[]");
        assert!(rows(&line)["error"].as_str().unwrap().contains("not authorized"));
    }

    #[test]
    fn attach_with_an_expression_filename_is_refused_by_the_attach_limit() {
        // `ATTACH <expr> AS x` reaches the authorizer with a NULL filename
        // (AuthAction::Unknown), so only SQLITE_LIMIT_ATTACHED=0 refuses it.
        let mut m = module();
        let h = m.open(spec::MEMORY);
        assert_eq!(m.exec(h, "ATTACH hex('2f746d702f78') AS other"), 1);
        assert!(
            m.last_error(h).contains("attached databases"),
            "{}",
            m.last_error(h)
        );
        let line = m.query(h, "ATTACH ':memory:' AS other", "[]");
        let error = rows(&line)["error"].as_str().unwrap().to_owned();
        assert!(
            error.contains("not authorized") || error.contains("attached databases"),
            "{error}"
        );
    }

    #[test]
    fn closed_handles_fail_loudly_and_close_is_idempotent() {
        let mut m = module();
        let h = m.open(spec::MEMORY);
        m.close(h);
        m.close(h);
        assert_eq!(m.exec(h, "SELECT 1"), 1);
        assert_eq!(rows(&m.query(h, "SELECT 1", "[]"))["error"], "database is closed");
        assert_eq!(m.last_error(h), "database is closed");
    }

    #[test]
    fn blobs_round_trip_and_big_integers_fail_loudly() {
        let mut m = module();
        let h = m.open(spec::MEMORY);
        m.exec(h, "CREATE TABLE b (data BLOB)");
        let ins = m.query(h, "INSERT INTO b VALUES (?)", r#"[{"$b":"AAEC+vv8/f7/"}]"#);
        assert_eq!(rows(&ins)["changes"], 1);
        let sel = rows(&m.query(h, "SELECT data FROM b", "[]"));
        assert_eq!(sel["rows"][0][0][spec::BLOB_KEY], "AAEC+vv8/f7/");

        let over = rows(&m.query(h, "SELECT 9007199254740993", "[]"));
        assert!(over["error"].as_str().unwrap().contains("DB_MAX_SAFE_INTEGER"));
        let ok = rows(&m.query(h, "SELECT 9007199254740991", "[]"));
        assert_eq!(ok["rows"], json!([[9007199254740991i64]]));
    }

    #[test]
    fn result_rows_beyond_the_ceiling_fail() {
        let mut m = module();
        let h = m.open(spec::MEMORY);
        m.exec(h, "CREATE TABLE n (v INTEGER)");
        let fill = format!(
            "WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq LIMIT {})
             INSERT INTO n SELECT x FROM seq",
            spec::MAX_RESULT_ROWS + 1
        );
        assert_eq!(m.exec(h, &fill), 0);
        let over = rows(&m.query(h, "SELECT v FROM n", "[]"));
        assert!(over["error"].as_str().unwrap().contains("DB_MAX_RESULT_ROWS"));
        let capped = rows(&m.query(
            h,
            &format!("SELECT v FROM n LIMIT {}", spec::MAX_RESULT_ROWS),
            "[]",
        ));
        assert_eq!(capped["rows"].as_array().unwrap().len(), spec::MAX_RESULT_ROWS);
    }

    #[test]
    fn persistent_dir_storage_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("pocket-db-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let mut m = DbModule::new(Storage::Dir(dir.clone()));
            let h = m.open("ledger");
            m.exec(h, "CREATE TABLE snap (v INTEGER); INSERT INTO snap VALUES (42)");
        }
        {
            let mut m = DbModule::new(Storage::Dir(dir.clone()));
            let h = m.open("ledger");
            let sel = rows(&m.query(h, "SELECT v FROM snap", "[]"));
            assert_eq!(sel["rows"], json!([[42]]));
        }
        // The database is an ordinary file in the data root — the app's own
        // asset, visible to a co-mounted fs module like any of its files.
        assert!(dir.join("ledger.sqlite").is_file());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(feature = "mount")]
    #[test]
    fn mounted_namespace_serves_a_quickjs_guest() {
        let guest = pocket_mod::Guest::new().unwrap();
        let module = Rc::new(RefCell::new(module()));
        mount(&guest, module).unwrap();
        guest
            .eval(
                "boot",
                r#"
                const h = db.open(":memory:");
                if (h < 0) throw new Error("open failed");
                if (db.exec(h, "CREATE TABLE t (v TEXT)") !== 0) throw new Error(db.lastError(h));
                const ins = JSON.parse(db.query(h, "INSERT INTO t VALUES (?)", '["from-guest"]'));
                if (ins.changes !== 1) throw new Error("insert failed");
                const sel = JSON.parse(db.query(h, "SELECT v FROM t", "[]"));
                globalThis.result = sel.rows[0][0];
                "#,
            )
            .unwrap();
        let result: String = guest.with(|ctx| ctx.globals().get("result").unwrap());
        assert_eq!(result, "from-guest");
    }
}
