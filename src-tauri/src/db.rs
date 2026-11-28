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
    /// The live file. Changes only by `switch_to`, and only while `conn` is
    /// locked, so code holding the connection always sees the matching path.
    path: std::sync::RwLock<PathBuf>,
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

/// The schema version a DB file was written with, read without migrating it.
pub fn schema_version(path: &Path) -> Result<i64> {
    let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

pub fn open_conn(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// Opens the live DB. Its file can come from anywhere (a backup, another
/// device): the work tree is repaired first, and a repair counts as an edit -
/// it bumps `last_modified` so the next sync uploads the fixed rows.
fn open_live(path: &Path) -> Result<Connection> {
    let mut conn = open_conn(path)?;
    // Repair and stamp commit together: a crash can't keep one without the other.
    let tx = conn.transaction()?;
    // A stamp that can't advance any more (only a hand-edited file has one)
    // restarts at the clock, as a change, so sync notices later edits again.
    let lm: Option<String> = tx.query_row("SELECT value FROM meta WHERE key='last_modified'", [], |r| r.get(0)).optional()?;
    if lm.is_some_and(|v| parse_stamp(&v).is_none()) {
        tx.execute("UPDATE meta SET value=?1 WHERE key='last_modified'", [now_ms().to_string()])?;
    }
    if normalize_work_all(&tx)? + normalize_expenses_all(&tx)? > 0 {
        touch(&tx)?;
    }
    tx.commit()?;
    Ok(conn)
}

/// Expense days are 'YYYY-MM-DD' (older writers added a time). An empty
/// withdrawal day means the purchase day; one that was set is kept as set,
/// even on the purchase day. Rows written some other way (an older app, a
/// restored file) are fixed here; fixed rows get a new `updated_at`, as in
/// [`normalize_work_all`].
pub fn normalize_expenses_all(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(&format!("UPDATE expenses SET {EXPENSE_DAYS}, updated_at = ?1 WHERE {EXPENSE_DAYS_OFF}"), [now_ms()])?)
}

const EXPENSE_DAYS: &str = "purchased_at = substr(purchased_at, 1, 10), paid_at = substr(paid_at, 1, 10)";
const EXPENSE_DAYS_OFF: &str = "(length(purchased_at) > 10 OR length(paid_at) > 10)";

/// SQL for a column in a filter or an order. `paid_day` on expenses is the day
/// the money leaves: the withdrawal day, or the purchase day when none is set.
fn col_sql(t: &TableDef, c: &str) -> Result<String> {
    if t.name == "expenses" && c == "paid_day" {
        return Ok("COALESCE(paid_at, purchased_at)".into());
    }
    check_col(t, c)?;
    Ok(c.to_string())
}

/// Moves a work item to another project with everything it holds - a phase's
/// items and every AI note inside either - in the caller's transaction. Done in
/// SQL so nothing is missed, however many rows there are.
pub fn move_work_item(conn: &Connection, id: i64, project_id: Option<i64>) -> Result<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE meetings SET project_id=?2, updated_at=?3 WHERE work_log_id=?1 OR work_log_id IN (SELECT id FROM work_logs WHERE parent_id=?1)",
        rusqlite::params![id, project_id, now],
    )?;
    conn.execute("UPDATE work_logs SET project_id=?2, updated_at=?3 WHERE parent_id=?1", rusqlite::params![id, project_id, now])?;
    conn.execute("UPDATE work_logs SET project_id=?2, parent_id=NULL, updated_at=?3 WHERE id=?1", rusqlite::params![id, project_id, now])?;
    normalize_work_tree(conn, id)
}

/// The stamp after `old`: the clock, or `old + 1` when the clock is at or
/// behind it (a device whose clock ran fast once keeps counting from there).
/// Never smaller, never equal; `None` only once `old` has reached the limit.
pub fn next_stamp(old: i64, now: i64) -> Option<i64> {
    let next = now.max(old.checked_add(1)?);
    (next <= MAX_STAMP).then_some(next)
}

/// Whole-table form of [`normalize_work_tree`]: only a phase of the same
/// project can be a parent, and a phase has none. Rows written without going
/// through `upsert` (sync merges, restored files) are fixed by this. One pass
/// is enough: it only clears `parent_id`, which no rule depends on.
/// Returns how many rows it fixed; those get a new `updated_at` so a later
/// merge sees the fix as the newer edit.
pub fn normalize_work_all(conn: &Connection) -> Result<usize> {
    let now = now_ms();
    let a = conn.execute("UPDATE work_logs SET parent_id=NULL, updated_at=?1 WHERE parent_id IS NOT NULL AND (kind='phase' OR parent_id=id)", [now])?;
    let b = conn.execute(
        "UPDATE work_logs SET parent_id=NULL, updated_at=?1 WHERE parent_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM work_logs p WHERE p.id=work_logs.parent_id AND p.kind='phase' AND p.project_id IS work_logs.project_id)",
        [now],
    )?;
    Ok(a + b)
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
    // A missing stamp is an old/blank file (0); a present one must be a stamp
    // this app could have written. Anything else is refused, not guessed at.
    match lm {
        None => Ok(0),
        Some(v) => parse_stamp(&v).ok_or_else(|| Error::msg(format!("DB 파일의 저장 시각이 올바르지 않습니다 ({v})"))),
    }
}

/// Highest `last_modified` a file may carry: the end of year 9999 (ms). Every
/// file this app writes stays at or below it (see `touch`).
pub const MAX_STAMP: i64 = 253_402_300_799_999;

/// The one way a stored stamp is read, everywhere: plain decimal digits (no
/// sign, spaces or other text), within 0..=MAX_STAMP.
pub fn parse_stamp(v: &str) -> Option<i64> {
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<i64>().ok().filter(|n| *n <= MAX_STAMP)
}

/// Moves the whole WAL into the main file, or fails. SQLite reports a partial
/// checkpoint (another reader still needs old pages) in its result row rather
/// than as an error, so the row is checked: only then is the main file alone a
/// complete copy that may be copied, renamed or have its side files removed.
pub fn checkpoint_fully(conn: &Connection) -> Result<()> {
    let (busy, log, done): (i64, i64, i64) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    // Not in WAL mode: log and done are -1 and there is nothing to move.
    if busy != 0 || done != log {
        return Err(Error::msg("데이터베이스를 다른 작업이 사용 중이라 지금은 교체할 수 없습니다. 잠시 후 다시 시도해 주세요."));
    }
    Ok(())
}

fn read_stamp(conn: &Connection) -> Result<i64> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key='last_modified'", [], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(|v| parse_stamp(&v))
        .unwrap_or(0))
}

/// Opens the live DB at `path` and finishes what a crash may have left there.
fn open_at(path: &Path) -> Result<Connection> {
    // If the repair itself cannot run (only a hand-made file at the stamp
    // limit), the app still starts on the file as it is.
    let conn = open_live(path).or_else(|_| open_conn(path))?;
    // A restore cut short (crash) may have left work behind: its committed
    // before-load copy is put in place now; files of restores that never
    // committed are removed (the current before-load is never among them).
    let backup = path.with_extension("db.before-load");
    promote_before_load(&conn, &backup);
    let pending: Option<String> = conn.query_row("SELECT value FROM meta WHERE key='before_load_pending'", [], |r| r.get(0)).optional().ok().flatten();
    if let (Some(dir), Some(base)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let still_pending = pending.as_ref().is_some_and(|id| n.starts_with(&format!("{base}.before-load.new-{id}")));
            if n.starts_with(&format!("{base}.incoming-")) || (n.starts_with(&format!("{base}.before-load.new-")) && !still_pending) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(conn)
}

impl Db {
    pub fn open(path: PathBuf) -> Result<Self> {
        let conn = open_at(&path)?;
        Ok(Db { conn: Mutex::new(Some(conn)), path: std::sync::RwLock::new(path) })
    }

    /// The live DB file in use.
    pub fn path(&self) -> PathBuf {
        self.path.read().map(|p| p.clone()).unwrap_or_default()
    }

    /// Continues on another live DB file (another profile's). The new file is
    /// opened before the current one is let go, so a failure changes nothing.
    pub fn switch_to(&self, path: PathBuf) -> Result<()> {
        let conn = open_at(&path)?;
        let mut guard = self.conn.lock().map_err(|_| Error::msg("db lock poisoned"))?;
        *guard = Some(conn);
        *self.path.write().map_err(|_| Error::msg("db path lock poisoned"))? = path;
        Ok(())
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
        Ok(self.meta_get("last_modified")?.and_then(|v| parse_stamp(&v)).unwrap_or(0))
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

    /// Replaces the live DB's content with `src` (already validated), atomically
    /// and under SQLite's locks; the previous content is kept as
    /// `live.db.before-load`.
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
        // 1. Prepare the incoming file beside the live one: opened, migrated to
        //    this version and repaired there, so its tables match ours exactly.
        //    The live DB is not involved yet; a failure here changes nothing.
        // A name of its own per restore: two restores at once (manual and Drive)
        // never share - or overwrite - each other's prepared file.
        // The file this restore is for; checked again under the connection lock,
        // so a profile switch in between can never get another profile's content.
        let live = self.path();
        let staged = PathBuf::from(format!("{}.incoming-{:016x}", live.display(), rand::random::<u64>()));
        let remove_staged = || {
            let _ = std::fs::remove_file(&staged);
            for suffix in ["-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", staged.display()));
            }
        };
        remove_staged();
        let prepared = (|| -> Result<()> {
            std::fs::copy(src, &staged)?;
            let c = open_live(&staged)?;
            checkpoint_fully(&c)?;
            Ok(())
        })();
        if let Err(e) = prepared {
            remove_staged();
            return Err(e);
        }

        // 2. Keep a copy of what will be replaced, then copy the new content in
        //    through SQLite in one write transaction. SQLite's locks cover every
        //    connection to the file (also another process, e.g. an older build of
        //    this app): nobody writes during a copy, readers see all old or all new.
        //
        //    The copy is made under the write lock and finished as its own file
        //    (`before-load.new-<id>`); the current `before-load` is not touched.
        //    The restore then commits only if no connection at all committed in
        //    between (SQLite's data_version, which every commit changes), so the
        //    copy is exactly what was replaced. The restore records "<id> is the
        //    new before-load" in the same transaction; afterwards the file is put
        //    in place - or at the next start, should the app stop first. A restore
        //    that doesn't commit just deletes its new file.
        let backup = live.with_extension("db.before-load");
        let result = self.with(|conn| {
            if self.path() != live {
                return Err(Error::msg("프로필이 바뀌어 불러오기를 중단했습니다"));
            }
            // An earlier restore's copy still waiting to be put in place holds the
            // only rollback of what that restore replaced: settle it first, and
            // restore nothing more until it is in place.
            promote_before_load(conn, &backup);
            let pending_error = || {
                Error::msg("지난번 불러오기의 이전 상태 사본(live.db.before-load)을 아직 제자리에 두지 못했습니다. 그 파일을 열어 둔 프로그램을 닫고 다시 시도해 주세요.")
            };
            // Checked again under each write lock below: another process may
            // commit its own pending copy at any moment in between.
            let has_pending = |c: &Connection| -> Result<bool> { Ok(c.query_row("SELECT 1 FROM meta WHERE key='before_load_pending'", [], |_| Ok(())).optional()?.is_some()) };
            if has_pending(conn)? {
                return Err(pending_error());
            }
            for _attempt in 0..3 {
                let id = format!("{:016x}", rand::random::<u64>());
                let fresh = PathBuf::from(format!("{}.new-{id}", backup.display()));
                let drop_fresh = || {
                    let _ = std::fs::remove_file(&fresh);
                    let _ = std::fs::remove_file(format!("{}-journal", fresh.display()));
                };
                // a. The copy, under the write lock.
                let taken = (|| -> Result<Option<i64>> {
                    conn.execute("ATTACH DATABASE ?1 AS prev", [fresh.to_string_lossy().as_ref()])?;
                    let r = (|| -> Result<Option<i64>> {
                        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                        // "Only if nothing was typed meanwhile."
                        if expected_lm.is_some_and(|e| e != read_stamp(&tx).unwrap_or(-1)) {
                            return Ok(None);
                        }
                        if has_pending(&tx)? {
                            return Err(pending_error());
                        }
                        copy_schema_and_rows(&tx, "main", "prev")?;
                        let version = data_version(&tx)?;
                        tx.commit()?;
                        Ok(Some(version))
                    })();
                    let _ = conn.execute("DETACH DATABASE prev", []);
                    r
                })();
                let version = match taken {
                    Ok(Some(v)) => v,
                    Ok(None) => {
                        drop_fresh();
                        return Ok(false);
                    }
                    Err(e) => {
                        drop_fresh();
                        return Err(e);
                    }
                };
                // b. The restore - only if nothing at all was committed since (a).
                let copied = (|| -> Result<bool> {
                    conn.execute("ATTACH DATABASE ?1 AS incoming", [staged.to_string_lossy().as_ref()])?;
                    let r = (|| -> Result<bool> {
                        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                        if data_version(&tx)? != version {
                            return Ok(false);
                        }
                        // Never replace another restore's marker, and only point to
                        // a copy that really is on disk.
                        if has_pending(&tx)? {
                            return Err(pending_error());
                        }
                        if !fresh.exists() {
                            return Err(Error::msg("이전 상태 사본을 만들지 못해 불러오지 않았습니다. 다시 시도해 주세요."));
                        }
                        let tables: Vec<String> = {
                            let mut st = tx.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?;
                            let rows = st.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
                            rows
                        };
                        for t in &tables {
                            let cols = |db: &str| -> Result<Vec<String>> {
                                let mut st = tx.prepare(&format!("SELECT name FROM pragma_table_info('{t}', '{db}')"))?;
                                let rows = st.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
                                Ok(rows)
                            };
                            let theirs = cols("incoming")?;
                            let shared: Vec<String> = cols("main")?.into_iter().filter(|c| theirs.contains(c)).map(|c| format!("\"{c}\"")).collect();
                            tx.execute(&format!("DELETE FROM main.\"{t}\""), [])?;
                            if !shared.is_empty() {
                                let list = shared.join(",");
                                tx.execute(&format!("INSERT INTO main.\"{t}\" ({list}) SELECT {list} FROM incoming.\"{t}\""), [])?;
                            }
                        }
                        tx.execute(
                            "INSERT INTO meta(key,value) VALUES('before_load_pending',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            [&id],
                        )?;
                        tx.commit()?;
                        Ok(true)
                    })();
                    let _ = conn.execute("DETACH DATABASE incoming", []);
                    r
                })();
                match copied {
                    Ok(true) => {
                        promote_before_load(conn, &backup);
                        return Ok(true);
                    }
                    Ok(false) => {
                        drop_fresh();
                        if expected_lm.is_some() {
                            return Ok(false); // something changed: the caller asked for "unchanged only"
                        }
                    }
                    Err(e) => {
                        drop_fresh();
                        return Err(e);
                    }
                }
            }
            Err(Error::msg("다른 곳에서 계속 편집 중이라 불러오지 못했습니다. 다른 Self Manager 창을 닫고 다시 시도해 주세요."))
        });
        remove_staged();
        result
    }
}

/// SQLite's counter that changes whenever another connection commits to the file.
fn data_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA data_version", [], |r| r.get(0))?)
}

/// Puts the before-load copy of the last committed restore in place, if one is
/// still waiting (the restore records its id; see `replace_inner`). Run after a
/// restore and whenever the DB opens; a failure just leaves it for next time.
fn promote_before_load(conn: &Connection, backup: &Path) {
    if let Some(id) = pending_before_load(conn) {
        settle_before_load(conn, backup, &id);
    }
}

/// The id of the before-load copy waiting to be put in place, if any.
fn pending_before_load(conn: &Connection) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key='before_load_pending'", [], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Puts the copy `id` in place and clears its marker - that marker only.
fn settle_before_load(conn: &Connection, backup: &Path, id: &str) {
    let fresh = PathBuf::from(format!("{}.new-{id}", backup.display()));
    let done = if fresh.exists() { std::fs::rename(&fresh, backup).is_ok() } else { true };
    if done {
        // Only the marker that was read: a newer restore (e.g. in another
        // process) may have left its own marker meanwhile, which must stay.
        let _ = conn.execute("DELETE FROM meta WHERE key='before_load_pending' AND value=?1", [id]);
    }
}

/// Builds a full copy of database `from` in the (empty) attached database
/// `to` - same tables, indexes and rows, same schema version - inside the
/// caller's transaction. Used where VACUUM INTO can't be (it can't run in one).
fn copy_schema_and_rows(conn: &Connection, from: &str, to: &str) -> Result<()> {
    let objects: Vec<(String, String, String)> = {
        let mut st = conn.prepare(&format!(
            "SELECT type, name, sql FROM {from}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index')
             ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
        ))?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?;
        rows
    };
    // "CREATE [UNIQUE] TABLE|INDEX [IF NOT EXISTS] name" -> the same, in `to`.
    let head = regex::Regex::new(r#"(?is)^\s*(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?)"#).expect("static regex");
    for (kind, name, sql) in &objects {
        let m = head.find(sql).ok_or_else(|| Error::msg(format!("알 수 없는 스키마: {name}")))?;
        conn.execute_batch(&format!("{}{to}.{}", &sql[..m.end()], &sql[m.end()..]))?;
        if kind == "table" {
            conn.execute(&format!("INSERT INTO {to}.\"{name}\" SELECT * FROM {from}.\"{name}\""), [])?;
        }
    }
    let version: i64 = conn.query_row(&format!("PRAGMA {from}.user_version"), [], |r| r.get(0))?;
    conn.execute_batch(&format!("PRAGMA {to}.user_version = {version};"))?;
    Ok(())
}

/// Marks the DB as changed. The stamp never goes back: sync takes "same stamp
/// as the last sync" to mean "unchanged", and every sync point is a stamp this
/// DB already passed, so a strictly increasing stamp can never land on one.
///
/// The limit (year 9999) is out of reach from any real clock; only a
/// hand-made file can bring a stamp there. Then saving fails loudly rather
/// than letting edits go unnoticed by sync.
pub fn touch(conn: &Connection) -> Result<()> {
    let next = next_stamp(read_stamp(conn)?, now_ms())
        .ok_or_else(|| Error::msg("이 DB의 저장 시각이 한계(9999년)에 도달해 더 저장할 수 없습니다. 정상적인 백업을 불러와 주세요."))?;
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('last_modified',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [next.to_string()],
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
        let col = col_sql(t, &f.col)?;
        let clause = match f.op.as_str() {
            "=" | "!=" | "<" | "<=" | ">" | ">=" => {
                params.push(to_sql(&f.value));
                format!("{col} {} ?", f.op)
            }
            "like" => {
                params.push(to_sql(&f.value));
                format!("{col} LIKE ?")
            }
            "null" => format!("{col} IS NULL"),
            "notnull" => format!("{col} IS NOT NULL"),
            "in" => {
                let arr = f.value.as_array().cloned().unwrap_or_default();
                if arr.is_empty() {
                    "0".to_string()
                } else {
                    let marks = vec!["?"; arr.len()].join(",");
                    params.extend(arr.iter().map(to_sql));
                    format!("{col} IN ({marks})")
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
            let c = col_sql(t, c)?;
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
    if t.name == "work_logs" {
        normalize_work_tree(conn, row_id)?;
    }
    if t.name == "expenses" {
        // Dates only, whoever writes (notifications, subscriptions, the assistant).
        conn.execute(&format!("UPDATE expenses SET {EXPENSE_DAYS} WHERE id = ?1 AND {EXPENSE_DAYS_OFF}"), [row_id])?;
    }
    get(conn, table, row_id)?.ok_or_else(|| Error::msg("row vanished"))
}

/// Work items form at most two levels: only a phase can be a parent, and a
/// phase is always top-level. Enforced on every write so no edit order (or
/// merge) can build a cycle.
fn normalize_work_tree(conn: &Connection, id: i64) -> Result<()> {
    // A phase has no parent; nothing is its own parent.
    conn.execute("UPDATE work_logs SET parent_id=NULL WHERE id=?1 AND (kind='phase' OR parent_id=id)", [id])?;
    // The parent must be a phase of the same project.
    conn.execute(
        "UPDATE work_logs SET parent_id=NULL WHERE id=?1 AND parent_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM work_logs p WHERE p.id=work_logs.parent_id AND p.kind='phase' AND p.project_id IS work_logs.project_id)",
        [id],
    )?;
    // An item that is not (or no longer) a phase, or moved project, lets its former children go.
    conn.execute(
        "UPDATE work_logs SET parent_id=NULL WHERE parent_id=?1 AND (
           (SELECT kind FROM work_logs WHERE id=?1) IS NOT 'phase'
           OR project_id IS NOT (SELECT project_id FROM work_logs WHERE id=?1))",
        [id],
    )?;
    Ok(())
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
            // Nothing is lost with an item: its AI notes and sub-items move up to
            // its parent (a phase) or to the project level.
            let parent: Option<i64> = conn.query_row("SELECT parent_id FROM work_logs WHERE id=?", [id], |r| r.get(0)).optional()?.flatten();
            conn.execute("UPDATE meetings SET work_log_id=?1 WHERE work_log_id=?2", rusqlite::params![parent, id])?;
            conn.execute("UPDATE work_logs SET parent_id=?1 WHERE parent_id=?2", rusqlite::params![parent, id])?;
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

    /// A profile switch moves every later read and write to the other file, and back.
    #[test]
    fn switch_to_moves_reads_and_writes_to_the_other_file() {
        let dir = tmp("switch");
        let (a, b) = (dir.join("a").join("live.db"), dir.join("b").join("live.db"));
        std::fs::create_dir_all(a.parent().unwrap()).unwrap();
        std::fs::create_dir_all(b.parent().unwrap()).unwrap();
        let db = Db::open(a.clone()).unwrap();
        let count = |db: &Db| db.with(|c| Ok(c.query_row("SELECT COUNT(*) FROM memos", [], |r| r.get::<_, i64>(0))?)).unwrap();
        db.write(|tx| upsert(tx, "memos", serde_json::json!({ "title": "in A" }).as_object().unwrap())).unwrap();
        db.switch_to(b.clone()).unwrap();
        assert_eq!(db.path(), b);
        assert_eq!(count(&db), 0, "B starts empty");
        db.write(|tx| upsert(tx, "memos", serde_json::json!({ "title": "in B" }).as_object().unwrap())).unwrap();
        db.write(|tx| upsert(tx, "memos", serde_json::json!({ "title": "in B too" }).as_object().unwrap())).unwrap();
        db.switch_to(a.clone()).unwrap();
        assert_eq!(count(&db), 1, "A kept only its own row");
        // A file that can't be opened leaves the current one in use.
        assert!(db.switch_to(dir.join("missing-dir").join("live.db")).is_err());
        assert_eq!(db.path(), a);
        assert_eq!(count(&db), 1);
    }

    fn row(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn opening_fills_withdrawal_days_left_by_an_older_app() {
        let dir = tmp("expense-open");
        let path = dir.join("live.db");
        drop(Db::open(path.clone()).unwrap());
        // What 0.2.0 writes into a file that already has the column.
        let c = Connection::open(&path).unwrap();
        c.execute("INSERT INTO expenses(id, name, amount, purchased_at, source) VALUES (7, 'old', 1, '2026-11-20 10:00', 'manual')", []).unwrap();
        drop(c);
        let db = Db::open(path).unwrap();
        let r = db.with(|c| get(c, "expenses", 7)).unwrap().unwrap();
        assert_eq!(r["purchased_at"], "2026-11-20");
        assert!(r["paid_at"].is_null());
        // Listed by the day the money leaves, which is the purchase day here.
        let q = ListQuery { filters: vec![Filter { col: "paid_day".into(), op: ">=".into(), value: serde_json::json!("2026-11-20") }], ..Default::default() };
        assert_eq!(db.with(|c| list(c, "expenses", &q)).unwrap().len(), 1);
    }

    #[test]
    fn expenses_keep_days_and_a_withdrawal_day() {
        let dir = tmp("expense");
        let db = Db::open(dir.join("live.db")).unwrap();
        let j = |v: Value| row(v);
        // A writer that still sends a time and no withdrawal day.
        let e = db.write(|tx| upsert(tx, "expenses", &j(serde_json::json!({"name": "카드", "amount": 1000, "purchased_at": "2026-11-28 14:30"})))).unwrap();
        assert_eq!(e["purchased_at"], "2026-11-28");
        assert!(e["paid_at"].is_null(), "not set apart: follows the purchase day");
        let id = e["id"].as_i64().unwrap();
        // Set apart, it stays apart when the purchase day changes.
        db.write(|tx| upsert(tx, "expenses", &j(serde_json::json!({"id": id, "paid_at": "2026-12-15"})))).unwrap();
        let e = db.write(|tx| upsert(tx, "expenses", &j(serde_json::json!({"id": id, "purchased_at": "2026-11-27"})))).unwrap();
        assert_eq!((e["purchased_at"].as_str(), e["paid_at"].as_str()), (Some("2026-11-27"), Some("2026-12-15")));
        // Moving the purchase day onto it and off again keeps it: it was chosen.
        db.write(|tx| upsert(tx, "expenses", &j(serde_json::json!({"id": id, "purchased_at": "2026-12-15"})))).unwrap();
        let e = db.write(|tx| upsert(tx, "expenses", &j(serde_json::json!({"id": id, "purchased_at": "2026-11-26"})))).unwrap();
        assert_eq!(e["paid_at"], "2026-12-15");
    }

    #[test]
    fn work_items_nest_and_deleting_moves_contents_up() {
        let dir = tmp("work");
        let db = Db::open(dir.join("live.db")).unwrap();
        let j = |v: Value| row(v);
        let p = db.write(|tx| upsert(tx, "projects", &j(serde_json::json!({"name": "P", "start_date": "2026-11-01", "end_date": "2026-12-31"})))).unwrap()["id"].as_i64().unwrap();
        let ph = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "phase", "date": "2026-11-01", "end_date": "2026-11-30", "project_id": p, "status": "진행"})))).unwrap()["id"].as_i64().unwrap();
        let it = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "schedule", "date": "2026-11-10", "project_id": p, "parent_id": ph})))).unwrap()["id"].as_i64().unwrap();
        // Only a phase can hold items: a log put under a schedule stays top-level.
        let under_schedule = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "log", "date": "2026-11-11", "project_id": p, "parent_id": it})))).unwrap();
        assert!(under_schedule["parent_id"].is_null());
        let sub = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "log", "date": "2026-11-11", "project_id": p, "parent_id": ph})))).unwrap()["id"].as_i64().unwrap();
        let note = db.write(|tx| upsert(tx, "meetings", &j(serde_json::json!({"title": "n", "work_log_id": it, "project_id": p})))).unwrap()["id"].as_i64().unwrap();
        // A plain log keeps the default kind.
        let plain = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"date": "2026-11-12"})))).unwrap();
        assert_eq!(plain["kind"], "log");
        assert_eq!(plain["sort"], 0);
        // Deleting the schedule moves its note up to its phase.
        db.write(|tx| delete(tx, "work_logs", it)).unwrap();
        let n = db.with(|c| get(c, "meetings", note)).unwrap().unwrap();
        assert_eq!(n["work_log_id"].as_i64(), Some(ph));
        // Deleting the phase moves its items and notes to the project level.
        db.write(|tx| delete(tx, "work_logs", ph)).unwrap();
        let s = db.with(|c| get(c, "work_logs", sub)).unwrap().unwrap();
        assert!(s["parent_id"].is_null());
        assert_eq!(s["project_id"].as_i64(), Some(p));
        let n = db.with(|c| get(c, "meetings", note)).unwrap().unwrap();
        assert!(n["work_log_id"].is_null());
        assert_eq!(n["project_id"].as_i64(), Some(p));
        // No cycles, whatever the edit order: A(phase) > B, then B -> phase, A -> log under B, A -> phase.
        let a = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "phase", "date": "2026-11-01", "project_id": p})))).unwrap()["id"].as_i64().unwrap();
        let b = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "log", "date": "2026-11-02", "project_id": p, "parent_id": a})))).unwrap()["id"].as_i64().unwrap();
        db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"id": b, "kind": "phase"})))).unwrap();
        db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"id": a, "kind": "log", "parent_id": b})))).unwrap();
        db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"id": a, "kind": "phase"})))).unwrap();
        for x in [a, b] {
            let r = db.with(|c| get(c, "work_logs", x)).unwrap().unwrap();
            assert!(r["parent_id"].is_null(), "a phase never has a parent");
        }
        // A parent must be a phase of the same project; self-parenting is dropped.
        let q = db.write(|tx| upsert(tx, "projects", &j(serde_json::json!({"name": "Q"})))).unwrap()["id"].as_i64().unwrap();
        let c1 = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "log", "date": "2026-11-03", "project_id": q, "parent_id": a})))).unwrap();
        assert!(c1["parent_id"].is_null());
        let c2 = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "log", "date": "2026-11-03", "project_id": p, "parent_id": a})))).unwrap();
        assert_eq!(c2["parent_id"].as_i64(), Some(a));
        let c2id = c2["id"].as_i64().unwrap();
        assert!(db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"id": c2id, "parent_id": c2id})))).unwrap()["parent_id"].is_null());
        // Daily items carry an emoji.
        let d = db.write(|tx| upsert(tx, "daily_presets", &j(serde_json::json!({"label": "물", "emoji": "💧", "color": "#4b8bf5"})))).unwrap();
        assert_eq!(d["emoji"], "💧");
    }

    #[test]
    fn moving_a_phase_takes_every_item_and_note_along() {
        let dir = tmp("move");
        let db = Db::open(dir.join("live.db")).unwrap();
        let j = |v: Value| row(v);
        let a = db.write(|tx| upsert(tx, "projects", &j(serde_json::json!({"name": "A"})))).unwrap()["id"].as_i64().unwrap();
        let b = db.write(|tx| upsert(tx, "projects", &j(serde_json::json!({"name": "B"})))).unwrap()["id"].as_i64().unwrap();
        let ph = db.write(|tx| upsert(tx, "work_logs", &j(serde_json::json!({"kind": "phase", "date": "2026-11-01", "project_id": a})))).unwrap()["id"].as_i64().unwrap();
        // More children and notes than any list query returns at once.
        db.write(|tx| {
            for i in 0..5001 {
                let c = upsert(tx, "work_logs", &j(serde_json::json!({"kind": "log", "date": "2026-11-02", "project_id": a, "parent_id": ph})))?;
                if i % 2 == 0 {
                    upsert(tx, "meetings", &j(serde_json::json!({"title": "n", "work_log_id": c["id"], "project_id": a})))?;
                }
            }
            upsert(tx, "meetings", &j(serde_json::json!({"title": "phase note", "work_log_id": ph, "project_id": a})))
        })
        .unwrap();
        db.write(|tx| move_work_item(tx, ph, Some(b))).unwrap();
        let count = |sql: &str| db.with(|c| Ok(c.query_row(sql, [], |r| r.get::<_, i64>(0))?)).unwrap();
        assert_eq!(count(&format!("SELECT COUNT(*) FROM work_logs WHERE project_id={a}")), 0, "nothing left in the old project");
        assert_eq!(count(&format!("SELECT COUNT(*) FROM work_logs WHERE project_id={b} AND parent_id={ph}")), 5001, "items stay inside the phase");
        assert_eq!(count(&format!("SELECT COUNT(*) FROM meetings WHERE project_id={a}")), 0, "no note left behind");
        assert_eq!(count(&format!("SELECT COUNT(*) FROM meetings WHERE project_id={b}")), 2502);
    }

    #[test]
    fn opening_a_file_repairs_its_work_tree() {
        let dir = tmp("repair");
        let path = dir.join("live.db");
        let db = Db::open(path.clone()).unwrap();
        let log = db.write(|tx| upsert(tx, "work_logs", &row(serde_json::json!({"kind": "log", "date": "2026-11-01"})))).unwrap()["id"].as_i64().unwrap();
        let child = db.write(|tx| upsert(tx, "work_logs", &row(serde_json::json!({"kind": "log", "date": "2026-11-02"})))).unwrap()["id"].as_i64().unwrap();
        drop(db);
        // A file written by something other than upsert (e.g. an old backup).
        Connection::open(&path).unwrap().execute("UPDATE work_logs SET parent_id=?1 WHERE id=?2", [log, child]).unwrap();
        let before = validate_db_file(&path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let db = Db::open(path.clone()).unwrap();
        assert!(db.with(|c| get(c, "work_logs", child)).unwrap().unwrap()["parent_id"].is_null());
        // The repair is an edit: the stamp moves on, so sync uploads it.
        assert!(db.last_modified().unwrap() > before, "repair bumps last_modified");
        // Even when the file's stamp is ahead of this device's clock.
        drop(db);
        let ahead = now_ms() + 3_600_000;
        {
            let c = Connection::open(&path).unwrap();
            c.execute("UPDATE meta SET value=?1 WHERE key='last_modified'", [ahead.to_string()]).unwrap();
            c.execute("UPDATE work_logs SET parent_id=?1 WHERE id=?2", [log, child]).unwrap();
        }
        let db = Db::open(path.clone()).unwrap();
        assert!(db.with(|c| get(c, "work_logs", child)).unwrap().unwrap()["parent_id"].is_null());
        assert!(db.last_modified().unwrap() > ahead, "stamp passes a clock-ahead source");
        drop(db);
        // A valid file is opened untouched.
        let lm = validate_db_file(&path).unwrap();
        let db = Db::open(path).unwrap();
        assert_eq!(db.last_modified().unwrap(), lm);
    }

    #[test]
    fn absurd_stamps_are_refused_and_never_freeze() {
        let dir = tmp("stamp");
        let path = dir.join("live.db");
        drop(Db::open(path.clone()).unwrap());
        let set = |v: &str| Connection::open(&path).unwrap().execute("UPDATE meta SET value=?1 WHERE key='last_modified'", [v]).unwrap();
        // Refused: beyond the limit, not an i64, not a number, negative, padded.
        for bad in [i64::MAX.to_string(), "253402300800000".into(), "9223372036854775808".into(), "abc".into(), "-5".into(), format!(" {}", now_ms()), format!("{}\n", now_ms()), "+5".into()] {
            set(&bad);
            assert!(validate_db_file(&path).is_err(), "{bad:?} must be refused");
        }
        // A device whose clock once ran years fast keeps counting from there:
        // its own files stay valid and every edit still moves the stamp.
        let ahead = now_ms() + 2 * 365 * 86_400_000;
        set(&ahead.to_string());
        assert_eq!(validate_db_file(&path).unwrap(), ahead);
        let db = Db::open(path.clone()).unwrap();
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "x"})))).unwrap();
        let after = db.last_modified().unwrap();
        assert!(after > ahead, "the edit is visible to sync");
        let snap = dir.join("snap.db");
        db.snapshot_to(&snap).unwrap();
        assert_eq!(validate_db_file(&snap).unwrap(), after, "what gets uploaded is valid");
        drop(db);
        // At the limit (only reachable by hand): the stamp is accepted, but saving
        // fails loudly instead of silently keeping the same stamp.
        set(&MAX_STAMP.to_string());
        assert_eq!(validate_db_file(&path).unwrap(), MAX_STAMP);
        let db = Db::open(path.clone()).unwrap();
        assert!(db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "z"})))).is_err());
        assert_eq!(db.last_modified().unwrap(), MAX_STAMP);
        drop(db);
        // A live file that already holds an impossible stamp restarts at the clock and keeps moving.
        set(&i64::MAX.to_string());
        let db = Db::open(path).unwrap();
        let a = db.last_modified().unwrap();
        assert!(a <= now_ms() && a > 0);
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "y"})))).unwrap();
        assert!(db.last_modified().unwrap() > a);
    }

    #[test]
    fn a_restore_that_cannot_open_keeps_the_previous_db() {
        let dir = tmp("restore");
        let db = Db::open(dir.join("live.db")).unwrap();
        let mine = db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "mine"})))).unwrap()["id"].as_i64().unwrap();
        // A backup that passes validation but can't be opened as live: stamp at
        // the limit plus a work tree that needs repair (the repair can't stamp).
        let bad = dir.join("bad.db");
        {
            let other = Db::open(bad.clone()).unwrap();
            let a = other.write(|tx| upsert(tx, "work_logs", &row(serde_json::json!({"kind": "log", "date": "2026-11-01"})))).unwrap()["id"].as_i64().unwrap();
            let b = other.write(|tx| upsert(tx, "work_logs", &row(serde_json::json!({"kind": "log", "date": "2026-11-02"})))).unwrap()["id"].as_i64().unwrap();
            drop(other);
            let c = Connection::open(&bad).unwrap();
            c.execute("UPDATE work_logs SET parent_id=?1 WHERE id=?2", [a, b]).unwrap();
            c.execute("UPDATE meta SET value=?1 WHERE key='last_modified'", [MAX_STAMP.to_string()]).unwrap();
        }
        assert!(validate_db_file(&bad).is_ok());
        let live_before = std::fs::read(dir.join("live.db")).unwrap();
        assert!(db.replace_with(&bad).is_err());
        // The live file was never touched, and no staging file is left behind.
        assert_eq!(std::fs::read(dir.join("live.db")).unwrap(), live_before);
        assert!(!dir.join("live.db.incoming").exists());
        // Still connected, still the previous content, still writable.
        assert_eq!(db.with(|c| get(c, "memos", mine)).unwrap().unwrap()["title"], "mine");
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"id": mine, "title": "still mine"})))).unwrap();

        // A good backup replaces it (repaired on the way in), keeping a copy of the old one.
        let good = dir.join("good.db");
        {
            let other = Db::open(good.clone()).unwrap();
            other.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "restored"})))).unwrap();
        }
        db.replace_with(&good).unwrap();
        let titles: Vec<String> = db.with(|c| Ok(c.prepare("SELECT title FROM memos")?.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?)).unwrap();
        assert_eq!(titles, vec!["restored".to_string()]);
        assert!(dir.join("live.db.before-load").exists());
        assert!(!dir.join("live.db.incoming").exists());
    }

    #[test]
    fn a_restore_is_safe_with_other_connections_on_the_file() {
        let dir = tmp("ckpt");
        let live = dir.join("live.db");
        let db = Db::open(live.clone()).unwrap();
        let mine = db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "before"})))).unwrap()["id"].as_i64().unwrap();
        let good = dir.join("good.db");
        {
            let g = Db::open(good.clone()).unwrap();
            g.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "restored"})))).unwrap();
        }
        let titles = |c: &Connection| -> Vec<String> { c.prepare("SELECT title FROM memos ORDER BY title").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect() };

        // Another process (e.g. an older build of the app) is writing: the restore
        // waits for SQLite's lock, gives up, and the live content is untouched.
        let other = Connection::open(&live).unwrap();
        other.execute_batch("BEGIN IMMEDIATE; UPDATE memos SET title='theirs';").unwrap();
        assert!(db.replace_with(&good).is_err(), "no restore while another writer holds the lock");
        other.execute_batch("COMMIT;").unwrap();
        assert_eq!(db.with(|c| Ok(titles(c))).unwrap(), vec!["theirs".to_string()]);

        // A reader in the middle of a read keeps seeing the old content; the
        // restore itself goes through, all at once.
        other.execute_batch("BEGIN; SELECT COUNT(*) FROM memos;").unwrap();
        db.replace_with(&good).unwrap();
        assert_eq!(titles(&other), vec!["theirs".to_string()], "an open read sees one consistent version");
        other.execute_batch("COMMIT;").unwrap();
        assert_eq!(titles(&other), vec!["restored".to_string()], "and then the new one");
        assert_eq!(db.with(|c| Ok(titles(c))).unwrap(), vec!["restored".to_string()]);
        assert!(db.with(|c| get(c, "memos", mine)).unwrap().is_none());
        // The previous content was kept, and the other connection still works.
        let kept = Connection::open(dir.join("live.db.before-load")).unwrap();
        assert_eq!(titles(&kept), vec!["theirs".to_string()]);
        other.execute("INSERT INTO memos(id, title, pinned) VALUES (1, 'after', 0)", []).unwrap();
        assert!(!dir.join("live.db.incoming").exists());
    }

    #[test]
    fn restore_rollback_copy_and_concurrent_restores() {
        let dir = tmp("restore2");
        let live = dir.join("live.db");
        let db = std::sync::Arc::new(Db::open(live.clone()).unwrap());
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "original"})))).unwrap();
        let make = |name: &str, title: &str| {
            let p = dir.join(name);
            let d = Db::open(p.clone()).unwrap();
            for i in 0..50 {
                d.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": format!("{title}-{i}")})))).unwrap();
            }
            p
        };
        let (a, b) = (make("a.db", "A"), make("b.db", "B"));
        let titles = |c: &Connection| -> Vec<String> { c.prepare("SELECT title FROM memos ORDER BY title").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect() };

        // The rollback copy is a complete, valid DB of what was replaced, and can be restored.
        db.replace_with(&a).unwrap();
        let kept = live.with_extension("db.before-load");
        assert!(validate_db_file(&kept).is_ok());
        assert_eq!(titles(&Connection::open(&kept).unwrap()), vec!["original".to_string()]);
        let v = |p: &Path| Connection::open(p).unwrap().query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(v(&kept), v(&live));
        db.replace_with(&kept).unwrap();
        assert_eq!(db.with(|c| Ok(titles(c))).unwrap(), vec!["original".to_string()]);

        // A restore skipped because of a newer edit leaves the previous copy alone.
        let before = std::fs::read(&kept).unwrap();
        assert!(!db.replace_if_unchanged(&b, 1).unwrap());
        assert_eq!(std::fs::read(&kept).unwrap(), before);

        // The old copy held open by another program (no sharing): the restore
        // still happens, the old copy is left exactly as it was, and the new copy
        // waits as "pending" until it can be put in place (here: once released).
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "edited"})))).unwrap();
            let old = std::fs::read(&kept).unwrap();
            let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&kept).unwrap();
            db.replace_with(&b).unwrap();
            assert!(db.with(|c| Ok(titles(c))).unwrap().iter().all(|t| t.starts_with("B-")));
            drop(held);
            assert_eq!(std::fs::read(&kept).unwrap(), old, "the old copy was never touched");
            let pending: Option<String> = db.with(|c| Ok(c.query_row("SELECT value FROM meta WHERE key='before_load_pending'", [], |r| r.get(0)).optional()?)).unwrap();
            assert!(pending.is_some(), "the new copy is waiting");
            // While it waits, another restore would replace its marker: refused,
            // nothing changes, the waiting copy stays.
            let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&kept).unwrap();
            assert!(db.replace_with(&a).is_err(), "no second restore while a copy is pending");
            assert!(db.with(|c| Ok(titles(c))).unwrap().iter().all(|t| t.starts_with("B-")), "content unchanged");
            let still: Option<String> = db.with(|c| Ok(c.query_row("SELECT value FROM meta WHERE key='before_load_pending'", [], |r| r.get(0)).optional()?)).unwrap();
            assert_eq!(still, pending);
            drop(held);
            db.with(|c| {
                promote_before_load(c, &kept);
                Ok(())
            })
            .unwrap();
            assert_eq!(titles(&Connection::open(&kept).unwrap()), vec!["edited".to_string(), "original".to_string()], "now it holds what that restore replaced");
            let pending: Option<String> = db.with(|c| Ok(c.query_row("SELECT value FROM meta WHERE key='before_load_pending'", [], |r| r.get(0)).optional()?)).unwrap();
            assert!(pending.is_none());
        }

        // Two restores at once: the result is wholly one of them, never a mix.
        let (d1, d2) = (db.clone(), db.clone());
        let (a2, b2) = (a.clone(), b.clone());
        let t1 = std::thread::spawn(move || d1.replace_with(&a2).unwrap());
        let t2 = std::thread::spawn(move || d2.replace_with(&b2).unwrap());
        t1.join().unwrap();
        t2.join().unwrap();
        let now = db.with(|c| Ok(titles(c))).unwrap();
        let all_a = now.iter().all(|t| t.starts_with("A-"));
        let all_b = now.iter().all(|t| t.starts_with("B-"));
        assert!(now.len() == 50 && (all_a || all_b), "{now:?}");
        // No working files are left behind.
        let left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.contains(".incoming-") || n.contains(".tmp-") || n.contains(".aside-")).collect();
        assert!(left.is_empty(), "{left:?}");
    }

    /// The app stops after a restore committed but before its before-load copy
    /// was put in place: the next start finishes the job.
    #[cfg(windows)]
    #[test]
    fn a_pending_before_load_copy_is_put_in_place_at_the_next_start() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tmp("pending");
        let live = dir.join("live.db");
        let kept = live.with_extension("db.before-load");
        let db = Db::open(live.clone()).unwrap();
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "first"})))).unwrap();
        let other = dir.join("other.db");
        drop(Db::open(other.clone()).unwrap());
        db.replace_with(&other).unwrap(); // creates a before-load copy
        db.write(|tx| upsert(tx, "memos", &row(serde_json::json!({"title": "second"})))).unwrap();
        // The old copy is locked, so this restore's copy stays pending; then the app "stops".
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&kept).unwrap();
        db.replace_with(&other).unwrap();
        drop(db);
        drop(held);
        let pending_files = || std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".new-")).count();
        assert_eq!(pending_files(), 1);
        let db = Db::open(live).unwrap();
        let titles: Vec<String> = Connection::open(&kept).unwrap().prepare("SELECT title FROM memos").unwrap().query_map([], |r| r.get(0)).unwrap().map(|x| x.unwrap()).collect();
        assert_eq!(titles, vec!["second".to_string()], "the copy of what the last restore replaced");
        assert_eq!(pending_files(), 0);
        assert!(db.meta_get("before_load_pending").unwrap().is_none());
    }

    /// Settling an old marker never clears a newer one written meanwhile: the
    /// marker is read, another connection (another process) commits a newer
    /// restore's marker, then the old one is settled.
    #[test]
    fn promotion_only_clears_its_own_marker() {
        let dir = tmp("marker");
        let live = dir.join("live.db");
        let backup = live.with_extension("db.before-load");
        let db = Db::open(live.clone()).unwrap();
        let fresh = |id: &str| PathBuf::from(format!("{}.new-{id}", backup.display()));
        db.with(|c| {
            c.execute("INSERT INTO meta(key,value) VALUES('before_load_pending','aaaa')", [])?;
            Ok(())
        })
        .unwrap();
        std::fs::write(fresh("aaaa"), b"copy a").unwrap();
        // 1. This side reads the marker.
        let id = db.with(|c| Ok(pending_before_load(c))).unwrap().unwrap();
        assert_eq!(id, "aaaa");
        // 2. Meanwhile another process commits a newer restore: its own copy and marker.
        std::fs::write(fresh("bbbb"), b"copy b").unwrap();
        Connection::open(&live).unwrap().execute("UPDATE meta SET value='bbbb' WHERE key='before_load_pending'", []).unwrap();
        // 3. This side settles what it read.
        db.with(|c| {
            settle_before_load(c, &backup, &id);
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), b"copy a", "its own copy went in place");
        assert_eq!(db.meta_get("before_load_pending").unwrap().as_deref(), Some("bbbb"), "the newer marker is kept");
        assert!(fresh("bbbb").exists(), "and so is the newer copy");
        // The newer one is settled in turn by the normal path.
        db.with(|c| {
            promote_before_load(c, &backup);
            Ok(())
        })
        .unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), b"copy b");
        assert!(db.meta_get("before_load_pending").unwrap().is_none());
    }

    /// Change detection between the two locks doesn't depend on the stamp.
    #[test]
    fn data_version_sees_commits_that_skip_the_stamp() {
        let dir = tmp("dv");
        let live = dir.join("live.db");
        let db = Db::open(live.clone()).unwrap();
        let before = db.with(|c| data_version(c)).unwrap();
        let lm = db.last_modified().unwrap();
        Connection::open(&live).unwrap().execute("INSERT INTO memos(id, title, pinned) VALUES (7, 'no stamp', 0)", []).unwrap();
        assert_eq!(db.last_modified().unwrap(), lm, "the other connection did not touch the stamp");
        assert_ne!(db.with(|c| data_version(c)).unwrap(), before, "but the commit is still seen");
    }

    #[test]
    fn next_stamp_only_moves_forward() {
        let now = 1_795_000_000_000;
        assert_eq!(next_stamp(1, now), Some(now), "normally the clock");
        assert_eq!(next_stamp(now + 5_000, now), Some(now + 5_001), "past a copy from a clock-ahead device");
        assert_eq!(next_stamp(now, now), Some(now + 1), "never equal to the old stamp");
        assert_eq!(next_stamp(MAX_STAMP, now), None, "never past the limit");
        for old in [0, 1, now - 1, now, now * 50, MAX_STAMP - 1] {
            let n = next_stamp(old, now).unwrap();
            assert!(n > old && n <= MAX_STAMP, "old={old} -> {n}");
        }
        assert_eq!(parse_stamp("0"), Some(0));
        assert_eq!(parse_stamp(&MAX_STAMP.to_string()), Some(MAX_STAMP));
        for bad in ["", " 1", "1 ", "+1", "-1", "1e3", "253402300800000"] {
            assert_eq!(parse_stamp(bad), None, "{bad:?}");
        }
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
