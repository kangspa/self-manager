//! SQLite access. The live database file *is* the "auto-save": every write is
//! committed immediately and stamps `meta.last_modified`, so what the UI shows
//! always matches what is on disk.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::schema::{self, TableDef};

pub struct Db {
    conn: Mutex<Option<Connection>>,
    pub path: PathBuf,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Row ids are unique across devices so two databases can be merged:
/// `ms * 1000 + random(0..1000)`, strictly increasing within this process.
/// Stays below 2^53 (JavaScript-safe) until the year ~2255.
pub fn new_id() -> i64 {
    use rand::Rng;
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let cand = now_ms() * 1000 + rand::thread_rng().gen_range(0..1000);
    let prev = LAST.fetch_max(cand, Ordering::SeqCst);
    if cand > prev {
        cand
    } else {
        LAST.fetch_add(1, Ordering::SeqCst) + 1
    }
}

fn configure(conn: &Connection) -> Result<()> {
    // WAL keeps reads fast while writing; NORMAL sync is durable enough with WAL
    // and avoids an fsync per keystroke-driven save.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;
         PRAGMA temp_store=MEMORY;
         PRAGMA cache_size=-8000;
         PRAGMA busy_timeout=3000;",
    )?;
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let fresh = version == 0;
    for (i, sql) in schema::MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
        tx.commit()?;
    }
    if fresh {
        let tx = conn.transaction()?;
        tx.execute_batch(schema::SEED)?;
        let now = now_ms().to_string();
        tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('last_modified',?1)", [&now])?;
        tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('created_at',?1)", [&now])?;
        tx.commit()?;
    }
    Ok(())
}

pub fn open_conn(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Opens a foreign database file read-only and checks that it looks like ours.
pub fn validate_db_file(path: &Path) -> Result<i64> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if ok != "ok" {
        return Err(Error::msg(format!("손상된 DB 파일입니다: {ok}")));
    }
    let lm: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='last_modified'", [], |r| r.get(0))
        .optional()
        .map_err(|_| Error::msg("Self Manager DB 파일이 아닙니다"))?;
    Ok(lm.and_then(|v| v.parse().ok()).unwrap_or(0))
}

impl Db {
    pub fn open(path: PathBuf) -> Result<Self> {
        let conn = open_conn(&path)?;
        Ok(Db { conn: Mutex::new(Some(conn)), path })
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.conn.lock().map_err(|_| Error::msg("db lock poisoned"))?;
        let conn = guard.as_mut().ok_or_else(|| Error::msg("DB가 닫혀 있습니다"))?;
        f(conn)
    }

    /// Runs `f` in a transaction and stamps the auto-save time on success.
    pub fn write<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T>) -> Result<T> {
        self.with(|conn| {
            let tx = conn.transaction()?;
            let out = f(&tx)?;
            touch(&tx)?;
            tx.commit()?;
            Ok(out)
        })
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        self.with(|c| Ok(c.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional()?))
    }

    pub fn last_modified(&self) -> Result<i64> {
        Ok(self.meta_get("last_modified")?.and_then(|v| v.parse().ok()).unwrap_or(0))
    }

    /// Consistent copy of the live DB (works while WAL has uncheckpointed pages).
    pub fn snapshot_to(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            std::fs::remove_file(dest)?;
        }
        let dest_str = dest.to_string_lossy().to_string();
        self.with(|c| {
            c.execute("VACUUM INTO ?1", [&dest_str])?;
            Ok(())
        })
    }

    /// Replaces the live DB with `src` (already validated). The connection is
    /// closed during the swap so no stale WAL pages survive.
    pub fn replace_with(&self, src: &Path) -> Result<()> {
        self.replace_inner(src, None).map(|_| ())
    }

    /// Like `replace_with`, but only if the live DB is still at `expected_lm`.
    /// The check and the swap happen under the same lock, so an edit made after
    /// a sync decided "nothing changed here" can never be overwritten.
    /// Returns false (and changes nothing) when the DB was edited meanwhile.
    pub fn replace_if_unchanged(&self, src: &Path, expected_lm: i64) -> Result<bool> {
        self.replace_inner(src, Some(expected_lm))
    }

    fn replace_inner(&self, src: &Path, expected_lm: Option<i64>) -> Result<bool> {
        let mut guard = self.conn.lock().map_err(|_| Error::msg("db lock poisoned"))?;
        if let (Some(expected), Some(conn)) = (expected_lm, guard.as_ref()) {
            let cur: i64 = conn
                .query_row("SELECT value FROM meta WHERE key='last_modified'", [], |r| r.get::<_, String>(0))
                .optional()?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if cur != expected {
                return Ok(false);
            }
        }
        if let Some(conn) = guard.take() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            drop(conn);
        }
        let backup = self.path.with_extension("db.before-load");
        let result = (|| -> Result<()> {
            if self.path.exists() {
                std::fs::copy(&self.path, &backup)?;
            }
            for ext in ["db-wal", "db-shm"] {
                let p = self.path.with_extension(ext);
                if p.exists() {
                    std::fs::remove_file(p)?;
                }
            }
            std::fs::copy(src, &self.path)?;
            Ok(())
        })();
        if let Err(e) = result {
            // Put the previous file back so the app keeps working.
            if backup.exists() {
                let _ = std::fs::copy(&backup, &self.path);
            }
            *guard = Some(open_conn(&self.path)?);
            return Err(e);
        }
        *guard = Some(open_conn(&self.path)?);
        Ok(true)
    }
}

pub fn touch(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('last_modified',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [now_ms().to_string()],
    )?;
    Ok(())
}

// ---------- JSON <-> SQL conversion ----------

pub fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

pub fn from_sql(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Runs a query and returns every row as a JSON object keyed by column name.
pub fn query_json(conn: &Connection, sql: &str, params: &[SqlValue]) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let mut rows = stmt.query(params_from_iter(params.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut obj = Map::with_capacity(names.len());
        for (i, n) in names.iter().enumerate() {
            obj.insert(n.clone(), from_sql(row.get_ref(i)?));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

// ---------- Generic CRUD ----------

#[derive(Deserialize, Default)]
pub struct Filter {
    pub col: String,
    pub op: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Deserialize, Default)]
pub struct ListQuery {
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub search: Option<String>,
    /// e.g. [["due_at","asc"],["id","desc"]]
    #[serde(default)]
    pub order: Vec<(String, String)>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

fn table_def(name: &str) -> Result<&'static TableDef> {
    schema::table(name).ok_or_else(|| Error::msg(format!("unknown table {name}")))
}

fn check_col(t: &TableDef, col: &str) -> Result<()> {
    if col == "id" || col == "updated_at" || (col == "created_at" && t.has_created) || t.cols.contains(&col) {
        Ok(())
    } else {
        Err(Error::msg(format!("unknown column {}.{col}", t.name)))
    }
}

pub fn list(conn: &Connection, table: &str, q: &ListQuery) -> Result<Vec<Value>> {
    let t = table_def(table)?;
    let mut sql = format!("SELECT * FROM {}", t.name);
    let mut params: Vec<SqlValue> = Vec::new();
    let mut wheres: Vec<String> = Vec::new();
    for f in &q.filters {
        check_col(t, &f.col)?;
        let clause = match f.op.as_str() {
            "=" | "!=" | "<" | "<=" | ">" | ">=" => {
                params.push(to_sql(&f.value));
                format!("{} {} ?", f.col, f.op)
            }
            "like" => {
                params.push(to_sql(&f.value));
                format!("{} LIKE ?", f.col)
            }
            "null" => format!("{} IS NULL", f.col),
            "notnull" => format!("{} IS NOT NULL", f.col),
            "in" => {
                let arr = f.value.as_array().cloned().unwrap_or_default();
                if arr.is_empty() {
                    "0".to_string()
                } else {
                    let marks = vec!["?"; arr.len()].join(",");
                    params.extend(arr.iter().map(to_sql));
                    format!("{} IN ({marks})", f.col)
                }
            }
            op => return Err(Error::msg(format!("bad operator {op}"))),
        };
        wheres.push(clause);
    }
    if let Some(s) = q.search.as_ref().filter(|s| !s.trim().is_empty()) {
        if !t.search.is_empty() {
            let like = format!("%{}%", s.trim());
            let ors: Vec<String> = t.search.iter().map(|c| format!("{c} LIKE ?")).collect();
            for _ in t.search {
                params.push(SqlValue::Text(like.clone()));
            }
            wheres.push(format!("({})", ors.join(" OR ")));
        }
    }
    if !wheres.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&wheres.join(" AND "));
    }
    if !q.order.is_empty() {
        let mut parts = Vec::new();
        for (c, d) in &q.order {
            check_col(t, c)?;
            let dir = if d.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
            parts.push(format!("{c} {dir}"));
        }
        sql.push_str(" ORDER BY ");
        sql.push_str(&parts.join(", "));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {}", q.limit.unwrap_or(500).clamp(1, 5000), q.offset.unwrap_or(0).max(0)));
    query_json(conn, &sql, &params)
}

pub fn get(conn: &Connection, table: &str, id: i64) -> Result<Option<Value>> {
    let t = table_def(table)?;
    Ok(query_json(conn, &format!("SELECT * FROM {} WHERE id=?", t.name), &[SqlValue::Integer(id)])?.into_iter().next())
}

/// Insert when `row.id` is absent, otherwise update only the provided columns.
pub fn upsert(conn: &Connection, table: &str, row: &Map<String, Value>) -> Result<Value> {
    let t = table_def(table)?;
    let now = now_ms();
    let id = row.get("id").and_then(Value::as_i64);
    let mut cols: Vec<&str> = Vec::new();
    let mut vals: Vec<SqlValue> = Vec::new();
    for (k, v) in row {
        if k == "id" || k == "updated_at" || k == "created_at" {
            continue;
        }
        if !t.cols.contains(&k.as_str()) {
            return Err(Error::msg(format!("unknown column {}.{k}", t.name)));
        }
        cols.push(k.as_str());
        vals.push(to_sql(v));
    }
    let row_id = match id {
        Some(id) => {
            let mut sets: Vec<String> = cols.iter().map(|c| format!("{c}=?")).collect();
            sets.push("updated_at=?".into());
            vals.push(SqlValue::Integer(now));
            vals.push(SqlValue::Integer(id));
            let n = conn.execute(&format!("UPDATE {} SET {} WHERE id=?", t.name, sets.join(",")), params_from_iter(vals.iter()))?;
            if n == 0 {
                // Row was deleted meanwhile (e.g. a debounced save landing after delete).
                return Ok(Value::Null);
            }
            id
        }
        None => {
            let id = new_id();
            cols.push("id");
            vals.push(SqlValue::Integer(id));
            cols.push("updated_at");
            vals.push(SqlValue::Integer(now));
            if t.has_created {
                cols.push("created_at");
                vals.push(SqlValue::Integer(now));
            }
            let marks = vec!["?"; cols.len()].join(",");
            conn.execute(&format!("INSERT INTO {} ({}) VALUES ({marks})", t.name, cols.join(",")), params_from_iter(vals.iter()))?;
            id
        }
    };
    get(conn, table, row_id)?.ok_or_else(|| Error::msg("row vanished"))
}

pub fn delete(conn: &Connection, table: &str, id: i64) -> Result<()> {
    let t = table_def(table)?;
    // Cascade by hand for parent/child pairs (keeps the schema FK-free so
    // whole-file restores never trip constraint checks).
    match t.name {
        "goals" => {
            conn.execute("DELETE FROM goal_notes WHERE goal_id=?", [id])?;
        }
        "daily_presets" => {
            conn.execute("DELETE FROM daily_rules WHERE preset_id=?", [id])?;
        }
        "projects" => {
            conn.execute("UPDATE work_logs SET project_id=NULL WHERE project_id=?", [id])?;
            conn.execute("UPDATE meetings SET project_id=NULL WHERE project_id=?", [id])?;
        }
        "work_logs" => {
            conn.execute("UPDATE meetings SET work_log_id=NULL WHERE work_log_id=?", [id])?;
        }
        _ => {}
    }
    // Attachments belong to their record (the files themselves are garbage
    // collected once nothing references them).
    if t.name != "attachments" {
        conn.execute("DELETE FROM attachments WHERE owner_table=?1 AND owner_id=?2", rusqlite::params![t.name, id])?;
    }
    conn.execute(&format!("DELETE FROM {} WHERE id=?", t.name), [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sm-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn row(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn crud_filters_and_whitelist() {
        let dir = tmp("crud");
        let db = Db::open(dir.join("live.db")).unwrap();
        let seeded: i64 = db.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM option_items", [], |r| r.get(0))?)).unwrap();
        assert!(seeded > 10, "seed options inserted");
        let a = db.write(|tx| upsert(tx, "tasks", &row(serde_json::json!({"title": "a", "due_at": "2026-11-12"})))).unwrap();
        db.write(|tx| upsert(tx, "tasks", &row(serde_json::json!({"title": "b"})))).unwrap();
        let id = a["id"].as_i64().unwrap();
        db.write(|tx| upsert(tx, "tasks", &row(serde_json::json!({"id": id, "done_at": 1})))).unwrap();
        let open = db.with(|c| list(c, "tasks", &ListQuery { filters: vec![Filter { col: "done_at".into(), op: "null".into(), value: Value::Null }], ..Default::default() })).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["title"], "b");
        let found = db.with(|c| list(c, "tasks", &ListQuery { search: Some("a".into()), ..Default::default() })).unwrap();
        assert_eq!(found.len(), 1);
        // Identifiers outside the whitelist never reach SQL.
        assert!(db.write(|tx| upsert(tx, "tasks", &row(serde_json::json!({"title) VALUES(1);--": 1})))).is_err());
        assert!(db.with(|c| list(c, "sqlite_master", &ListQuery::default())).is_err());
        assert!(db.with(|c| list(c, "tasks", &ListQuery { order: vec![("id; DROP TABLE tasks".into(), "asc".into())], ..Default::default() })).is_err());
    }

    #[test]
    fn snapshot_and_replace_roundtrip() {
        let dir = tmp("snap");
        let db = Db::open(dir.join("live.db")).unwrap();
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"body": "before"})))).unwrap();
        let lm_saved = db.last_modified().unwrap();
        let manual = dir.join("manual.db");
        db.snapshot_to(&manual).unwrap();
        assert_eq!(validate_db_file(&manual).unwrap(), lm_saved);
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"body": "after"})))).unwrap();
        assert_ne!(db.last_modified().unwrap(), lm_saved);
        db.replace_with(&manual).unwrap();
        let memos = db.with(|c| list(c, "memos", &ListQuery::default())).unwrap();
        assert_eq!(memos.len(), 1);
        assert_eq!(memos[0]["body"], "before");
        assert_eq!(db.last_modified().unwrap(), lm_saved, "auto-save time follows the loaded content");
        // A swap decided at an older stamp must not overwrite a newer edit.
        let lm_seen = db.last_modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"body": "typed during download"})))).unwrap();
        assert!(!db.replace_if_unchanged(&manual, lm_seen).unwrap());
        let memos = db.with(|c| list(c, "memos", &ListQuery::default())).unwrap();
        assert_eq!(memos.len(), 2, "edit survived");
        assert!(db.replace_if_unchanged(&manual, db.last_modified().unwrap()).unwrap());
        // Garbage files are rejected before the live DB is touched.
        let junk = dir.join("junk.db");
        std::fs::write(&junk, b"not a database").unwrap();
        assert!(validate_db_file(&junk).is_err());
    }
}
