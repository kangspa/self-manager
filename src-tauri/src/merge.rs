//! Three-way merge of two Self Manager databases, git style.
//!
//! `base` is the last state both sides agreed on (saved at every successful
//! upload/download). For each row (by id) and each column:
//! - changed on one side only  -> take that side
//! - changed identically       -> take it
//! - changed differently       -> conflict, resolved by the side the user prefers
//! Deletions are changes too (row in base, missing on one side).
//! Unique natural keys (one diary entry per date, ...) are checked afterwards;
//! two different rows claiming the same key also count as a conflict.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::Connection;

use crate::db::{self, open_conn, touch};
use crate::error::Result;
use crate::schema::TABLES;

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Prefer {
    Local,
    Remote,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Report {
    pub conflicts: usize,
    pub from_local: usize,
    pub from_remote: usize,
    /// false when conflicts exist and no preference was given (nothing written)
    pub applied: bool,
}

type Row = Vec<Value>;

struct Table {
    cols: Vec<String>,
    rows: HashMap<i64, Row>,
}

fn load(conn: &Connection, table: &str, cols: Option<&[String]>) -> Result<Table> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let cols: Vec<String> = cols.map(|c| c.to_vec()).unwrap_or_else(|| names.clone());
    let idx: Vec<Option<usize>> = cols.iter().map(|c| names.iter().position(|n| n == c)).collect();
    let id_pos = names.iter().position(|n| n == "id").unwrap_or(0);
    let mut rows = HashMap::new();
    let mut q = stmt.query([])?;
    while let Some(r) = q.next()? {
        let id: i64 = r.get(id_pos)?;
        let row = idx.iter().map(|i| i.map(|i| r.get::<_, Value>(i)).transpose().map(|v| v.unwrap_or(Value::Null))).collect::<std::result::Result<Row, _>>()?;
        rows.insert(id, row);
    }
    Ok(Table { cols, rows })
}

/// Applies the expense day rules of [`db::normalize_expenses_all`] to loaded
/// rows. Done to the base, local and remote copies alike before comparing, so a
/// value one device filled in by itself never counts as an edit - and never
/// conflicts with a withdrawal day someone set on another device.
fn normalize_expense_rows(t: &mut Table) {
    let (Some(p), Some(w)) = (t.cols.iter().position(|c| c == "purchased_at"), t.cols.iter().position(|c| c == "paid_at")) else {
        return;
    };
    let day = |v: &Value| match v {
        Value::Text(s) if s.len() > 10 => Value::Text(s.chars().take(10).collect()),
        v => v.clone(),
    };
    for row in t.rows.values_mut() {
        row[p] = day(&row[p]);
        row[w] = if row[w] == Value::Null { row[p].clone() } else { day(&row[w]) };
    }
}

/// A withdrawal day that only followed the purchase day (it matched it before
/// and still does) is not an edit of its own: when the other side set the
/// withdrawal day, that one wins instead of conflicting. Run after
/// [`normalize_expense_rows`].
fn yield_followed_paid(b: &Table, l: &mut Table, r: &mut Table) {
    let (Some(p), Some(w)) = (b.cols.iter().position(|c| c == "purchased_at"), b.cols.iter().position(|c| c == "paid_at")) else {
        return;
    };
    for (id, base) in &b.rows {
        if base[w] != base[p] {
            continue;
        }
        let (Some(lr), Some(rr)) = (l.rows.get_mut(id), r.rows.get_mut(id)) else {
            continue;
        };
        let followed = |x: &Row| x[w] == x[p] && x[w] != base[w];
        let set = |x: &Row| x[w] != base[w] && x[w] != x[p];
        if followed(lr) && set(rr) {
            lr[w] = base[w].clone();
        } else if followed(rr) && set(lr) {
            rr[w] = base[w].clone();
        }
    }
}

/// Natural unique keys per table (must match the UNIQUE constraints in schema.rs).
fn unique_keys(table: &str) -> &'static [&'static str] {
    match table {
        "diary_entries" => &["date"],
        "goal_notes" => &["goal_id", "period_type", "period_key"],
        "notif_apps" => &["package"],
        "events" => &["gcal_id"],
        "app_settings" => &["key"],
        _ => &[],
    }
}

struct Merged {
    row: Row,
    in_local: bool,
    in_remote: bool,
}

fn as_ms(v: &Value) -> i64 {
    match v {
        Value::Integer(i) => *i,
        _ => 0,
    }
}

/// Merges one table. Returns merged rows and the number of conflicting rows.
fn merge_table(cols: &[String], b: &Table, l: &Table, r: &Table, prefer: Prefer, rep: &mut Report) -> (Vec<Merged>, usize) {
    let upd = cols.iter().position(|c| c == "updated_at");
    let same = |x: &Row, y: &Row| x.iter().zip(y).enumerate().all(|(i, (a, b))| Some(i) == upd || a == b);
    let eq = |x: Option<&Row>, y: Option<&Row>| match (x, y) {
        (None, None) => true,
        (Some(a), Some(b)) => same(a, b),
        _ => false,
    };
    let ids: BTreeSet<i64> = b.rows.keys().chain(l.rows.keys()).chain(r.rows.keys()).copied().collect();
    let mut out = Vec::new();
    let mut conflicts = 0;
    for id in ids {
        let (bo, lo, ro) = (b.rows.get(&id), l.rows.get(&id), r.rows.get(&id));
        let pick = |row: Option<&Row>| row.cloned();
        let merged: Option<Row> = if eq(lo, ro) {
            // Same content; keep the later updated_at.
            match (lo, ro, upd) {
                (Some(a), Some(c), Some(u)) if as_ms(&c[u]) > as_ms(&a[u]) => pick(ro),
                _ => pick(lo),
            }
        } else if eq(lo, bo) {
            rep.from_remote += 1;
            pick(ro)
        } else if eq(ro, bo) {
            rep.from_local += 1;
            pick(lo)
        } else {
            match (lo, ro) {
                (Some(a), Some(c)) => {
                    // Column-level: only columns changed differently on both sides conflict.
                    let mut row = a.clone();
                    let mut conflicted = false;
                    for i in 0..cols.len() {
                        if Some(i) == upd {
                            row[i] = if as_ms(&c[i]) > as_ms(&a[i]) { c[i].clone() } else { a[i].clone() };
                            continue;
                        }
                        let bc = bo.map(|x| &x[i]);
                        row[i] = if a[i] == c[i] {
                            a[i].clone()
                        } else if bc == Some(&a[i]) {
                            c[i].clone()
                        } else if bc == Some(&c[i]) {
                            a[i].clone()
                        } else {
                            conflicted = true;
                            if prefer == Prefer::Local { a[i].clone() } else { c[i].clone() }
                        };
                    }
                    if conflicted {
                        conflicts += 1;
                    } else {
                        rep.from_local += 1;
                        rep.from_remote += 1;
                    }
                    Some(row)
                }
                // Deleted on one side, edited on the other.
                _ => {
                    conflicts += 1;
                    if prefer == Prefer::Local { pick(lo) } else { pick(ro) }
                }
            }
        };
        if let Some(row) = merged {
            out.push(Merged { row, in_local: lo.is_some(), in_remote: ro.is_some() });
        }
    }
    (out, conflicts)
}

/// Keeps one row per natural key. Returns the number of key collisions.
fn dedupe(table: &str, cols: &[String], rows: &mut Vec<Merged>, prefer: Prefer) -> usize {
    let keys = unique_keys(table);
    if keys.is_empty() {
        return 0;
    }
    let kidx: Vec<usize> = keys.iter().filter_map(|k| cols.iter().position(|c| c == k)).collect();
    let upd = cols.iter().position(|c| c == "updated_at");
    let mut groups: HashMap<Vec<String>, Vec<usize>> = HashMap::new();
    for (i, m) in rows.iter().enumerate() {
        let key: Vec<String> = kidx.iter().map(|&k| format!("{:?}", m.row[k])).collect();
        if kidx.iter().any(|&k| m.row[k] == Value::Null) {
            continue; // NULLs never collide (e.g. events without gcal_id)
        }
        groups.entry(key).or_default().push(i);
    }
    let mut drop = BTreeSet::new();
    let mut collisions = 0;
    for (_, idxs) in groups.into_iter().filter(|(_, v)| v.len() > 1) {
        collisions += 1;
        let side = |m: &Merged| if prefer == Prefer::Local { m.in_local } else { m.in_remote };
        let keep = idxs
            .iter()
            .copied()
            .max_by_key(|&i| (side(&rows[i]), upd.map(|u| as_ms(&rows[i].row[u])).unwrap_or(0)))
            .unwrap();
        drop.extend(idxs.into_iter().filter(|&i| i != keep));
    }
    for i in drop.into_iter().rev() {
        rows.remove(i);
    }
    collisions
}

fn tombstones(conn: &Connection) -> Vec<String> {
    conn.query_row("SELECT value FROM meta WHERE key='gcal_tombstones'", [], |r| r.get::<_, String>(0)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Merges `local` and `remote` (given `base`) into `out`.
/// All inputs are throwaway copies; they are migrated to the current schema in place.
/// With conflicts and `prefer == None`, nothing is written and `applied == false`.
pub fn merge_files(base: Option<&Path>, local: &Path, remote: &Path, out: &Path, prefer: Option<Prefer>) -> Result<Report> {
    let lc = open_conn(local)?;
    let rc = open_conn(remote)?;
    let remote_lm: i64 = rc
        .query_row("SELECT value FROM meta WHERE key='last_modified'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| db::parse_stamp(&v))
        .unwrap_or(0);
    let bc = match base {
        Some(p) => Some(open_conn(p)?),
        None => None,
    };
    let mut rep = Report::default();
    let mut merged: Vec<(&str, Vec<String>, Vec<Merged>)> = Vec::new();
    let mut conflicts = 0;
    for t in TABLES {
        let mut l = load(&lc, t.name, None)?;
        let mut r = load(&rc, t.name, Some(&l.cols))?;
        let mut b = match &bc {
            Some(c) => load(c, t.name, Some(&l.cols))?,
            None => Table { cols: l.cols.clone(), rows: HashMap::new() },
        };
        if t.name == "expenses" {
            for x in [&mut b, &mut l, &mut r] {
                normalize_expense_rows(x);
            }
            yield_followed_paid(&b, &mut l, &mut r);
        }
        let (mut rows, c) = merge_table(&l.cols, &b, &l, &r, prefer.unwrap_or(Prefer::Local), &mut rep);
        conflicts += c + dedupe(t.name, &l.cols, &mut rows, prefer.unwrap_or(Prefer::Local));
        merged.push((t.name, l.cols, rows));
    }
    rep.conflicts = conflicts;
    if conflicts > 0 && prefer.is_none() {
        return Ok(rep);
    }
    let mut stones: BTreeSet<String> = tombstones(&lc).into_iter().collect();
    stones.extend(tombstones(&rc));
    drop((lc, rc, bc));

    std::fs::copy(local, out)?;
    let mut oc = open_conn(out)?;
    let tx = oc.transaction()?;
    for (name, cols, rows) in &merged {
        tx.execute(&format!("DELETE FROM {name}"), [])?;
        let marks = vec!["?"; cols.len()].join(",");
        let mut ins = tx.prepare(&format!("INSERT INTO {name} ({}) VALUES ({marks})", cols.join(",")))?;
        for m in rows {
            ins.execute(rusqlite::params_from_iter(m.row.iter()))?;
        }
    }
    if stones.is_empty() {
        tx.execute("DELETE FROM meta WHERE key='gcal_tombstones'", [])?;
    } else {
        tx.execute(
            "INSERT INTO meta(key,value) VALUES('gcal_tombstones',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&stones.into_iter().collect::<Vec<_>>())?],
        )?;
    }
    // Column-wise merging can combine edits that are each valid but not
    // together (one device turns a phase into a log, the other files an item
    // under it): restore the work tree rules on the merged result.
    db::normalize_work_all(&tx)?;
    // Rows from a device still on an app without the withdrawal day.
    db::normalize_expenses_all(&tx)?;
    touch(&tx)?;
    // The merged stamp must also pass the remote one: the remote stamp becomes
    // the sync point, and stamps only move forward from there.
    let floor = db::next_stamp(remote_lm, 0)
        .ok_or_else(|| crate::error::Error::msg("드라이브 백업의 저장 시각이 한계(9999년)에 도달해 합칠 수 없습니다. 정상적인 백업을 불러와 주세요."))?;
    tx.execute(
        "UPDATE meta SET value=CAST(?1 AS TEXT) WHERE key='last_modified' AND CAST(value AS INTEGER) < ?1",
        [floor],
    )?;
    tx.commit()?;
    // The result is used as a plain file (copied, uploaded): all of it must be in it.
    db::checkpoint_fully(&oc)?;
    rep.applied = true;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Db};
    use serde_json::json;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sm-merge-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn up(db: &Db, table: &str, v: serde_json::Value) -> i64 {
        db.write(|tx| db::upsert(tx, table, v.as_object().unwrap())).unwrap()["id"].as_i64().unwrap()
    }
    fn memos(p: &Path) -> Vec<(i64, String, String)> {
        let c = Connection::open(p).unwrap();
        let mut s = c.prepare("SELECT id, COALESCE(title,''), COALESCE(body,'') FROM memos ORDER BY id").unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|x| x.unwrap()).collect()
    }

    /// A withdrawal day one device filled in by itself (left empty by an older
    /// app) gives way to one set on the other device, without a conflict.
    #[test]
    fn filled_withdrawal_day_never_conflicts_with_a_set_one() {
        let d = dir("paid");
        drop(Db::open(d.join("b.db")).unwrap());
        let c = Connection::open(d.join("b.db")).unwrap();
        c.execute("INSERT INTO expenses(id, name, amount, purchased_at, source) VALUES (9, 'card', 1, '2026-11-20 10:00', 'manual')", []).unwrap();
        drop(c);
        std::fs::copy(d.join("b.db"), d.join("l.db")).unwrap();
        std::fs::copy(d.join("b.db"), d.join("r.db")).unwrap();
        drop(Db::open(d.join("l.db")).unwrap()); // fills it in on opening
        let r = Db::open(d.join("r.db")).unwrap();
        up(&r, "expenses", json!({"id": 9, "paid_at": "2026-12-15"}));
        drop(r);
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("out.db"), None).unwrap();
        assert_eq!(rep.conflicts, 0);
        let c = Connection::open(d.join("out.db")).unwrap();
        let got: (String, String) = c.query_row("SELECT purchased_at, paid_at FROM expenses WHERE id=9", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(got, ("2026-11-20".to_string(), "2026-12-15".to_string()));
    }

    /// One device moves the purchase day (the withdrawal day follows), the other
    /// sets the withdrawal day: both edits are kept, without a conflict.
    #[test]
    fn followed_withdrawal_day_gives_way_to_a_set_one() {
        let d = dir("follow");
        let base = Db::open(d.join("base.db")).unwrap();
        let id = up(&base, "expenses", json!({"name": "card", "amount": 1, "purchased_at": "2026-11-20"}));
        for f in ["b.db", "phone.db", "pc.db"] {
            base.snapshot_to(&d.join(f)).unwrap();
        }
        let phone = Db::open(d.join("phone.db")).unwrap();
        let pc = Db::open(d.join("pc.db")).unwrap();
        up(&phone, "expenses", json!({"id": id, "purchased_at": "2026-11-22", "paid_at": "2026-11-22"}));
        up(&pc, "expenses", json!({"id": id, "paid_at": "2026-12-15"}));
        phone.snapshot_to(&d.join("l.db")).unwrap();
        pc.snapshot_to(&d.join("r.db")).unwrap();
        for (l, r) in [("l.db", "r.db"), ("r.db", "l.db")] {
            let rep = merge_files(Some(&d.join("b.db")), &d.join(l), &d.join(r), &d.join("out.db"), None).unwrap();
            assert_eq!(rep.conflicts, 0);
            let c = Connection::open(d.join("out.db")).unwrap();
            let got: (String, String) = c.query_row("SELECT purchased_at, paid_at FROM expenses WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            assert_eq!(got, ("2026-11-22".to_string(), "2026-12-15".to_string()));
            drop(c);
            let _ = std::fs::remove_file(d.join("out.db"));
        }
    }

    /// Scenario from the spec: phone edits (backup failed), PC edits and backs up.
    #[test]
    fn merges_both_sides_without_conflict() {
        let d = dir("ok");
        let base = Db::open(d.join("base.db")).unwrap();
        let a = up(&base, "memos", json!({"title": "A", "body": "a"}));
        let b = up(&base, "memos", json!({"title": "B", "body": "b"}));
        let gone = up(&base, "memos", json!({"title": "C", "body": "c"}));
        base.snapshot_to(&d.join("phone.db")).unwrap();
        base.snapshot_to(&d.join("pc.db")).unwrap();
        base.snapshot_to(&d.join("b.db")).unwrap();
        let phone = Db::open(d.join("phone.db")).unwrap();
        let pc = Db::open(d.join("pc.db")).unwrap();
        up(&phone, "memos", json!({"id": a, "title": "A-phone"}));
        up(&phone, "memos", json!({"title": "new phone"}));
        up(&pc, "memos", json!({"id": a, "body": "a-pc"})); // different column of the same row
        up(&pc, "memos", json!({"title": "new pc"}));
        pc.write(|tx| db::delete(tx, "memos", gone)).unwrap();
        phone.snapshot_to(&d.join("l.db")).unwrap();
        pc.snapshot_to(&d.join("r.db")).unwrap();
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("out.db"), None).unwrap();
        assert_eq!(rep.conflicts, 0);
        assert!(rep.applied);
        let m = memos(&d.join("out.db"));
        let titles: Vec<&str> = m.iter().map(|x| x.1.as_str()).collect();
        assert_eq!(m.len(), 4, "{m:?}");
        assert!(titles.contains(&"new phone") && titles.contains(&"new pc") && titles.contains(&"B"));
        let row_a = m.iter().find(|x| x.0 == a).unwrap();
        assert_eq!((row_a.1.as_str(), row_a.2.as_str()), ("A-phone", "a-pc"), "column-level merge");
        assert!(!m.iter().any(|x| x.0 == gone), "deletion on PC survives");
        let _ = b;
    }

    /// One device turns an empty phase into a log, the other files an item under
    /// that phase. Each edit is valid alone; merged, the item must not end up
    /// under a log.
    #[test]
    fn merge_keeps_the_work_tree_valid() {
        let d = dir("tree");
        let base = Db::open(d.join("base.db")).unwrap();
        let p = up(&base, "projects", json!({"name": "P"}));
        let ph = up(&base, "work_logs", json!({"kind": "phase", "date": "2026-11-01", "project_id": p}));
        for f in ["phone", "pc", "b"] {
            base.snapshot_to(&d.join(format!("{f}.db"))).unwrap();
        }
        let phone = Db::open(d.join("phone.db")).unwrap();
        let pc = Db::open(d.join("pc.db")).unwrap();
        up(&phone, "work_logs", json!({"id": ph, "kind": "log"}));
        let child = up(&pc, "work_logs", json!({"kind": "log", "date": "2026-11-02", "project_id": p, "parent_id": ph}));
        phone.snapshot_to(&d.join("l.db")).unwrap();
        pc.snapshot_to(&d.join("r.db")).unwrap();
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("out.db"), None).unwrap();
        assert!(rep.applied);
        let c = Connection::open(d.join("out.db")).unwrap();
        let (kind, parent): (String, Option<i64>) = c.query_row("SELECT (SELECT kind FROM work_logs WHERE id=?1), (SELECT parent_id FROM work_logs WHERE id=?2)", [ph, child], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(kind, "log");
        assert_eq!(parent, None, "the item is not left under a log");
    }

    /// The remote copy's stamp is ahead of this device's clock: the merged
    /// result must still carry a larger stamp than both inputs.
    #[test]
    fn merged_stamp_passes_both_sides() {
        let d = dir("stamp");
        let base = Db::open(d.join("base.db")).unwrap();
        up(&base, "memos", json!({"title": "A"}));
        for f in ["l", "r", "b"] {
            base.snapshot_to(&d.join(format!("{f}.db"))).unwrap();
        }
        let l = Db::open(d.join("l.db")).unwrap();
        up(&l, "memos", json!({"title": "local"}));
        drop(l);
        let r = Db::open(d.join("r.db")).unwrap();
        up(&r, "memos", json!({"title": "remote"}));
        drop(r);
        let ahead = db::now_ms() + 3_600_000;
        Connection::open(d.join("r.db")).unwrap().execute("UPDATE meta SET value=?1 WHERE key='last_modified'", [ahead.to_string()]).unwrap();
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("out.db"), None).unwrap();
        assert!(rep.applied);
        let lm: i64 = Connection::open(d.join("out.db")).unwrap().query_row("SELECT value FROM meta WHERE key='last_modified'", [], |r| r.get::<_, String>(0)).unwrap().parse().unwrap();
        assert!(lm > ahead, "merged {lm} must pass remote {ahead}");
    }

    #[test]
    fn conflicts_need_a_choice_and_honour_it() {
        let d = dir("conflict");
        let base = Db::open(d.join("base.db")).unwrap();
        let a = up(&base, "memos", json!({"title": "A"}));
        up(&base, "diary_entries", json!({"date": "2026-11-11", "values_json": "{}"}));
        for f in ["l", "r", "b"] {
            base.snapshot_to(&d.join(format!("{f}.db"))).unwrap();
        }
        let l = Db::open(d.join("l.db")).unwrap();
        let r = Db::open(d.join("r.db")).unwrap();
        up(&l, "memos", json!({"id": a, "title": "local"}));
        up(&r, "memos", json!({"id": a, "title": "remote"}));
        // Both create a diary entry for the same new date (UNIQUE(date)).
        up(&l, "diary_entries", json!({"date": "2026-11-12", "values_json": "{\"x\":\"L\"}"}));
        up(&r, "diary_entries", json!({"date": "2026-11-12", "values_json": "{\"x\":\"R\"}"}));
        drop((l, r));
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("o1.db"), None).unwrap();
        assert_eq!(rep.conflicts, 2);
        assert!(!rep.applied && !d.join("o1.db").exists());
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("o2.db"), Some(Prefer::Remote)).unwrap();
        assert!(rep.applied);
        assert_eq!(memos(&d.join("o2.db"))[0].1, "remote");
        let c = Connection::open(d.join("o2.db")).unwrap();
        let v: String = c.query_row("SELECT values_json FROM diary_entries WHERE date='2026-11-12'", [], |r| r.get(0)).unwrap();
        assert!(v.contains('R'));
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("o3.db"), Some(Prefer::Local)).unwrap();
        assert!(rep.applied);
        assert_eq!(memos(&d.join("o3.db"))[0].1, "local");
    }

    #[test]
    fn delete_vs_edit_is_a_conflict() {
        let d = dir("del");
        let base = Db::open(d.join("base.db")).unwrap();
        let a = up(&base, "tasks", json!({"title": "t"}));
        for f in ["l", "r", "b"] {
            base.snapshot_to(&d.join(format!("{f}.db"))).unwrap();
        }
        let l = Db::open(d.join("l.db")).unwrap();
        let r = Db::open(d.join("r.db")).unwrap();
        l.write(|tx| db::delete(tx, "tasks", a)).unwrap();
        up(&r, "tasks", json!({"id": a, "title": "edited"}));
        drop((l, r));
        let rep = merge_files(Some(&d.join("b.db")), &d.join("l.db"), &d.join("r.db"), &d.join("o.db"), Some(Prefer::Remote)).unwrap();
        assert_eq!(rep.conflicts, 1);
        let c = Connection::open(d.join("o.db")).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "remote edit wins over local delete");
    }
}
