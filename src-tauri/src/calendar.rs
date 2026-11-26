//! Two-way sync between local `events` and the user's primary Google Calendar,
//! plus desktop reminder notifications.
//!
//! Sync bookkeeping per row: `gcal_updated` holds the local `updated_at` value at
//! the moment the row last matched Google. `updated_at != gcal_updated` means
//! the user edited it locally since.

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone};
use rusqlite::params;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::db::{now_ms, query_json};
use crate::error::Result;
use crate::google;
use crate::AppState;

const TOMBSTONES: &str = "gcal_tombstones";

fn local_to_rfc3339(s: &str) -> Option<String> {
    let ndt = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M")).ok()?;
    Local.from_local_datetime(&ndt).single().map(|d| d.to_rfc3339())
}

fn to_google(ev: &Value) -> Value {
    let all_day = ev["all_day"].as_i64() == Some(1);
    let start = ev["start_at"].as_str().unwrap_or("");
    let end = ev["end_at"].as_str().filter(|s| !s.is_empty()).unwrap_or(start);
    let (s, e) = if all_day {
        let sd = start.get(0..10).unwrap_or("").to_string();
        // Google's all-day end date is exclusive; ours is inclusive.
        let ed = NaiveDate::parse_from_str(end.get(0..10).unwrap_or(""), "%Y-%m-%d").map(|d| (d + Duration::days(1)).format("%Y-%m-%d").to_string()).unwrap_or(sd.clone());
        (json!({ "date": sd }), json!({ "date": ed }))
    } else {
        let st = local_to_rfc3339(start).unwrap_or_default();
        let en = local_to_rfc3339(end).filter(|x| x >= &st).unwrap_or_else(|| {
            DateTime::parse_from_rfc3339(&st).map(|d| (d + Duration::hours(1)).to_rfc3339()).unwrap_or(st.clone())
        });
        (json!({ "dateTime": st }), json!({ "dateTime": en }))
    };
    let reminders = match ev["remind_minutes"].as_i64() {
        Some(m) => json!({ "useDefault": false, "overrides": [{ "method": "popup", "minutes": m }] }),
        None => json!({ "useDefault": true }),
    };
    json!({
        "summary": ev["title"], "description": ev["description"], "location": ev["location"],
        "start": s, "end": e, "reminders": reminders,
    })
}

/// (start_at, end_at, all_day) in local format from a Google event.
fn from_google(g: &Value) -> Option<(String, String, i64)> {
    if let Some(d) = g["start"]["date"].as_str() {
        let end = g["end"]["date"].as_str().and_then(|e| NaiveDate::parse_from_str(e, "%Y-%m-%d").ok()).map(|e| (e - Duration::days(1)).format("%Y-%m-%d").to_string()).unwrap_or(d.to_string());
        return Some((d.to_string(), end, 1));
    }
    let conv = |s: &str| DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Local).format("%Y-%m-%dT%H:%M").to_string());
    let s = conv(g["start"]["dateTime"].as_str()?)?;
    let e = g["end"]["dateTime"].as_str().and_then(conv).unwrap_or(s.clone());
    Some((s, e, 0))
}

pub fn add_tombstone(app: &AppHandle, gcal_id: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let mut list: Vec<String> = state.db.meta_get(TOMBSTONES)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    list.push(gcal_id.to_string());
    let s = serde_json::to_string(&list)?;
    state.db.write(|tx| {
        tx.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![TOMBSTONES, s])?;
        Ok(())
    })
}

#[derive(serde::Serialize, Default)]
pub struct SyncReport {
    pub pushed: usize,
    pub pulled: usize,
    pub deleted: usize,
}

pub async fn sync(app: &AppHandle) -> Result<SyncReport> {
    let state = app.state::<AppState>();
    // Bound to the active profile: no switch while this runs (see profiles.rs).
    let _profile = crate::hold(&state, None)?;
    let mut rep = SyncReport::default();

    // 1. Deletions made locally.
    let tomb: Vec<String> = state.db.meta_get(TOMBSTONES)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    for id in &tomb {
        google::calendar_delete(app, id).await?;
        rep.deleted += 1;
    }
    if !tomb.is_empty() {
        state.db.write(|tx| {
            tx.execute("DELETE FROM meta WHERE key=?1", [TOMBSTONES])?;
            Ok(())
        })?;
    }

    // 2. Push new / locally edited events.
    let dirty = state.db.with(|c| query_json(c, "SELECT * FROM events WHERE gcal_id IS NULL OR gcal_updated IS NULL OR CAST(gcal_updated AS INTEGER) != updated_at", &[]))?;
    for ev in dirty {
        let body = to_google(&ev);
        let res = google::calendar_put(app, ev["gcal_id"].as_str(), &body).await?;
        let id = ev["id"].as_i64().unwrap_or(0);
        state.db.write(|tx| {
            tx.execute(
                "UPDATE events SET gcal_id=?1, gcal_etag=?2, gcal_updated=CAST(updated_at AS TEXT) WHERE id=?3",
                params![res["id"].as_str(), res["etag"].as_str(), id],
            )?;
            Ok(())
        })?;
        rep.pushed += 1;
    }

    // 3. Pull remote changes (3 months back, 12 months ahead).
    let now = Local::now();
    let items = google::calendar_list(app, &(now - Duration::days(90)).to_rfc3339(), &(now + Duration::days(365)).to_rfc3339()).await?;
    let n = state.db.write(|tx| {
        let mut changed = 0;
        for g in &items {
            let Some(gid) = g["id"].as_str() else { continue };
            let local: Option<(i64, Option<String>, i64, Option<String>)> = tx
                .query_row("SELECT id, gcal_etag, updated_at, gcal_updated FROM events WHERE gcal_id=?1", [gid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .ok();
            if g["status"].as_str() == Some("cancelled") {
                if let Some((id, ..)) = local {
                    tx.execute("DELETE FROM events WHERE id=?1", [id])?;
                    changed += 1;
                }
                continue;
            }
            let Some((start, end, all_day)) = from_google(g) else { continue };
            let remind = g["reminders"]["overrides"].as_array().and_then(|a| a.first()).and_then(|o| o["minutes"].as_i64());
            let etag = g["etag"].as_str();
            match local {
                Some((id, letag, updated, synced)) => {
                    let locally_clean = synced.and_then(|s| s.parse::<i64>().ok()) == Some(updated);
                    if locally_clean && letag.as_deref() != etag {
                        let ts = now_ms();
                        tx.execute(
                            "UPDATE events SET title=?1, description=?2, location=?3, start_at=?4, end_at=?5, all_day=?6, remind_minutes=?7, gcal_etag=?8, updated_at=?9, gcal_updated=CAST(?9 AS TEXT) WHERE id=?10",
                            params![g["summary"].as_str().unwrap_or(""), g["description"].as_str(), g["location"].as_str(), start, end, all_day, remind, etag, ts, id],
                        )?;
                        changed += 1;
                    }
                }
                None => {
                    let ts = now_ms();
                    tx.execute(
                        "INSERT INTO events(id, title, description, location, start_at, end_at, all_day, remind_minutes, gcal_id, gcal_etag, created_at, updated_at, gcal_updated) VALUES(?11,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,CAST(?10 AS TEXT))",
                        params![g["summary"].as_str().unwrap_or("(제목 없음)"), g["description"].as_str(), g["location"].as_str(), start, end, all_day, remind, gid, etag, ts, crate::db::new_id()],
                    )?;
                    changed += 1;
                }
            }
        }
        Ok(changed)
    })?;
    rep.pulled = n;
    state.device.update(|d| d.gcal_last_sync = Some(now_ms()))?;
    Ok(rep)
}

/// Desktop only: fires reminder notifications while the app is running.
#[cfg(desktop)]
pub fn spawn_reminder_loop(app: AppHandle) {
    use std::collections::HashSet;
    use tauri_plugin_notification::NotificationExt;
    tauri::async_runtime::spawn(async move {
        let mut fired: HashSet<String> = HashSet::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let state = app.state::<AppState>();
            let now = Local::now().naive_local();
            let lo = (now - Duration::days(1)).format("%Y-%m-%dT%H:%M").to_string();
            let hi = (now + Duration::days(8)).format("%Y-%m-%dT%H:%M").to_string();
            let Ok(evs) = state.db.with(|c| {
                query_json(c, "SELECT id, title, start_at, all_day, remind_minutes, location FROM events WHERE remind_minutes IS NOT NULL AND start_at >= ?1 AND start_at <= ?2", &[lo.into(), hi.into()])
            }) else {
                continue;
            };
            for ev in evs {
                let start_s = ev["start_at"].as_str().unwrap_or("");
                let start = if ev["all_day"].as_i64() == Some(1) {
                    NaiveDate::parse_from_str(start_s.get(0..10).unwrap_or(""), "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(9, 0, 0))
                } else {
                    NaiveDateTime::parse_from_str(start_s, "%Y-%m-%dT%H:%M").ok()
                };
                let Some(start) = start else { continue };
                let fire = start - Duration::minutes(ev["remind_minutes"].as_i64().unwrap_or(0));
                let key = format!("{}@{}", ev["id"], fire);
                if fire <= now && now - fire < Duration::minutes(5) && fired.insert(key) {
                    let body = format!("{} {}", start.format("%m/%d %H:%M"), ev["location"].as_str().unwrap_or(""));
                    let _ = app.notification().builder().title(ev["title"].as_str().unwrap_or("일정")).body(body.trim()).show();
                }
            }
        }
    });
}
