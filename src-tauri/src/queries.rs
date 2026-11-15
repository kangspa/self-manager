//! Read-heavy aggregate queries that would be wasteful to assemble on the
//! frontend from generic lists.

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::db::query_json;
use crate::error::Result;

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(0..10)?, "%Y-%m-%d").ok()
}

fn last_day_of_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (NaiveDate::from_ymd_opt(ny, nm, 1).unwrap() - Duration::days(1)).day()
}

/// Charge dates of one subscription between `from` and `to` inclusive.
pub fn subscription_dates(cycle: &str, day: Option<i64>, month: Option<i64>, start: Option<NaiveDate>, end: Option<NaiveDate>, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    let lo = start.map_or(from, |s| s.max(from));
    let hi = end.map_or(to, |e| e.min(to));
    if lo > hi {
        return out;
    }
    match cycle {
        "weekly" => {
            let wd = day.unwrap_or(1).rem_euclid(7) as u32; // 0 = Sunday
            let mut d = lo;
            while d <= hi {
                if d.weekday().num_days_from_sunday() == wd {
                    out.push(d);
                    d += Duration::days(7);
                } else {
                    d += Duration::days(1);
                }
            }
        }
        "yearly" => {
            let m = month.unwrap_or(1).clamp(1, 12) as u32;
            for y in lo.year()..=hi.year() {
                let dd = (day.unwrap_or(1).max(1) as u32).min(last_day_of_month(y, m));
                if let Some(d) = NaiveDate::from_ymd_opt(y, m, dd) {
                    if d >= lo && d <= hi {
                        out.push(d);
                    }
                }
            }
        }
        _ => {
            let (mut y, mut m) = (lo.year(), lo.month());
            loop {
                let dd = (day.unwrap_or(1).max(1) as u32).min(last_day_of_month(y, m));
                let d = NaiveDate::from_ymd_opt(y, m, dd).unwrap();
                if d > hi {
                    break;
                }
                if d >= lo {
                    out.push(d);
                }
                if m == 12 {
                    y += 1;
                    m = 1;
                } else {
                    m += 1;
                }
            }
        }
    }
    out
}

/// Upcoming/past charges of active subscriptions within a date range.
pub fn subscription_schedule(conn: &Connection, from: &str, to: &str) -> Result<Vec<Value>> {
    let (Some(f), Some(t)) = (parse_date(from), parse_date(to)) else { return Ok(vec![]) };
    let subs = query_json(conn, "SELECT * FROM subscriptions WHERE active=1", &[])?;
    let mut out = Vec::new();
    for s in subs {
        let dates = subscription_dates(
            s["cycle"].as_str().unwrap_or("monthly"),
            s["day"].as_i64(),
            s["month"].as_i64(),
            s["start_date"].as_str().and_then(parse_date),
            s["end_date"].as_str().and_then(parse_date),
            f,
            t,
        );
        for d in dates {
            out.push(json!({
                "date": d.format("%Y-%m-%d").to_string(),
                "subscription_id": s["id"], "name": s["name"], "amount": s["amount"],
                "item_id": s["item_id"], "location_id": s["location_id"], "cycle": s["cycle"],
            }));
        }
    }
    out.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));
    Ok(out)
}

/// Monthly-equivalent cost of all active subscriptions.
fn subscription_monthly_total(conn: &Connection) -> Result<f64> {
    let rows = query_json(conn, "SELECT amount, cycle FROM subscriptions WHERE active=1", &[])?;
    Ok(rows
        .iter()
        .map(|r| {
            let a = r["amount"].as_f64().unwrap_or(0.0);
            match r["cycle"].as_str() {
                Some("yearly") => a / 12.0,
                Some("weekly") => a * 52.0 / 12.0,
                _ => a,
            }
        })
        .sum())
}

pub fn expense_dashboard(conn: &Connection, from: &str, to: &str) -> Result<Value> {
    // `to` is inclusive; purchased_at is 'YYYY-MM-DD HH:MM', so compare with the next-day bound.
    let to_excl = parse_date(to).map(|d| (d + Duration::days(1)).format("%Y-%m-%d").to_string()).unwrap_or_else(|| to.to_string());
    let p = [SqlValue::Text(from.to_string()), SqlValue::Text(to_excl)];
    let range = "purchased_at >= ?1 AND purchased_at < ?2";
    let totals = query_json(conn, &format!("SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM expenses WHERE {range}"), &p)?;
    let by_month = query_json(conn, &format!("SELECT substr(purchased_at,1,7) AS key, SUM(amount) AS total, COUNT(*) AS count FROM expenses WHERE {range} GROUP BY key ORDER BY key"), &p)?;
    let by_day = query_json(conn, &format!("SELECT substr(purchased_at,1,10) AS key, SUM(amount) AS total, COUNT(*) AS count FROM expenses WHERE {range} GROUP BY key ORDER BY key"), &p)?;
    let group = |col: &str| {
        query_json(
            conn,
            &format!(
                "SELECT e.{col} AS id, o.label AS label, o.color AS color, SUM(e.amount) AS total, COUNT(*) AS count
                 FROM expenses e LEFT JOIN option_items o ON o.id = e.{col}
                 WHERE {range} GROUP BY e.{col} ORDER BY total DESC"
            ),
            &p,
        )
    };
    let by_item = group("item_id")?;
    let by_location = group("location_id")?;
    let by_status = group("status_id")?;
    let top = query_json(conn, &format!("SELECT id, name, amount, purchased_at FROM expenses WHERE {range} ORDER BY amount DESC LIMIT 5"), &p)?;
    let today = chrono::Local::now().date_naive();
    let upcoming = subscription_schedule(conn, &today.format("%Y-%m-%d").to_string(), &(today + Duration::days(30)).format("%Y-%m-%d").to_string())?;
    Ok(json!({
        "total": totals[0]["total"], "count": totals[0]["count"],
        "by_month": by_month, "by_day": by_day, "by_item": by_item, "by_location": by_location, "by_status": by_status,
        "top": top, "subscription_monthly": subscription_monthly_total(conn)?, "upcoming": upcoming,
    }))
}

/// For each date in range: presets that are *planned* by rules and logs the user added.
pub fn daily_view(conn: &Connection, from: &str, to: &str) -> Result<Value> {
    let (Some(f), Some(t)) = (parse_date(from), parse_date(to)) else { return Ok(json!({})) };
    let rules = query_json(conn, "SELECT r.preset_id, r.rule_type, r.value FROM daily_rules r JOIN daily_presets p ON p.id=r.preset_id WHERE p.archived=0", &[])?;
    let logs = query_json(conn, "SELECT * FROM daily_logs WHERE date >= ?1 AND date <= ?2 ORDER BY created_at", &[SqlValue::Text(from.into()), SqlValue::Text(to.into())])?;
    let mut days = serde_json::Map::new();
    let mut d = f;
    while d <= t && (d - f).num_days() <= 400 {
        let key = d.format("%Y-%m-%d").to_string();
        let wd = d.weekday().num_days_from_sunday().to_string();
        let md = d.day().to_string();
        let mut planned: Vec<Value> = Vec::new();
        for r in &rules {
            let v = r["value"].as_str().unwrap_or("");
            let hit = match r["rule_type"].as_str().unwrap_or("") {
                "daily" => true,
                "weekday" => v.split(',').any(|x| x.trim() == wd),
                "monthday" => v.split(',').any(|x| x.trim() == md),
                "date" => v.split(',').any(|x| x.trim() == key),
                _ => false,
            };
            if hit && !planned.contains(&r["preset_id"]) {
                planned.push(r["preset_id"].clone());
            }
        }
        let day_logs: Vec<Value> = logs.iter().filter(|l| l["date"].as_str() == Some(key.as_str())).cloned().collect();
        days.insert(key, json!({ "planned": planned, "logs": day_logs }));
        d += Duration::days(1);
    }
    Ok(Value::Object(days))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    #[test]
    fn monthly_clamps_to_last_day() {
        let v = subscription_dates("monthly", Some(31), None, None, None, d("2026-01-01"), d("2026-03-31"));
        assert_eq!(v, vec![d("2026-01-31"), d("2026-02-28"), d("2026-03-31")]);
    }

    #[test]
    fn weekly_and_yearly() {
        // 2026-11-11 is a Wednesday (3)
        let w = subscription_dates("weekly", Some(3), None, None, None, d("2026-11-01"), d("2026-11-30"));
        assert_eq!(w.len(), 4);
        assert_eq!(w[0], d("2026-11-04"));
        let y = subscription_dates("yearly", Some(15), Some(2), None, None, d("2026-01-01"), d("2027-12-31"));
        assert_eq!(y, vec![d("2026-02-15"), d("2027-02-15")]);
    }

    #[test]
    fn respects_start_end() {
        let v = subscription_dates("monthly", Some(10), None, Some(d("2026-02-01")), Some(d("2026-03-15")), d("2026-01-01"), d("2026-12-31"));
        assert_eq!(v, vec![d("2026-02-10"), d("2026-03-10")]);
    }
}
