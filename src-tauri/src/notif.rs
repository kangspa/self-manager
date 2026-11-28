//! Turns payment/shopping app notifications into ledger rows.
//! Parsing lives in Rust (not Kotlin) so rules can be tested on desktop too.

use chrono::{Datelike, Local, NaiveDate, TimeZone};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

use crate::db;
use crate::error::Result;

/// Per-app parsing rule (stored as JSON in `notif_apps.rule_json`). All fields
/// optional; empty fields fall back to the built-in Korean heuristics.
#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(default)]
pub struct Rule {
    /// Comma-separated keywords; when set, a notification must contain one.
    pub include: String,
    /// Comma-separated keywords; a notification containing one is ignored.
    pub exclude: String,
    /// Regex whose first capture group is the amount.
    pub amount_regex: String,
    /// Regex whose first capture group is the expense name.
    pub name_regex: String,
    /// "auto" | "title" | "text" | "regex"
    pub name_source: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Parsed {
    pub name: String,
    pub amount: i64,
    pub purchased_at: String,
}

#[derive(Deserialize, Clone)]
pub struct RawNotification {
    pub package: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    /// epoch ms
    pub posted_at: i64,
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}

fn to_amount(s: &str) -> Option<i64> {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().filter(|v: &i64| *v > 0)
}

fn split_keywords(s: &str) -> impl Iterator<Item = &str> {
    s.split(',').map(str::trim).filter(|k| !k.is_empty())
}

fn find_amount(text: &str) -> Option<i64> {
    static AMT: OnceLock<Regex> = OnceLock::new();
    // "12,300원", "₩12,300", "12,300 KRW"
    let amt = re(&AMT, r"(?:₩|KRW\s?)?(\d{1,3}(?:,\d{3})+|\d+)\s?(?:원|KRW)|₩\s?(\d{1,3}(?:,\d{3})+|\d+)");
    let mut best: Option<(i32, i64)> = None;
    for c in amt.captures_iter(text) {
        let m = c.get(0).unwrap();
        let Some(v) = c.get(1).or(c.get(2)).and_then(|g| to_amount(g.as_str())) else { continue };
        let before: String = text[..m.start()].chars().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
        // Balance / limit / accumulated figures are never the purchase amount.
        if ["잔액", "누적", "한도", "잔여", "포인트"].iter().any(|k| before.contains(k)) {
            continue;
        }
        let score = if ["결제", "승인", "금액", "출금", "사용", "구매", "주문"].iter().any(|k| before.contains(k)) { 2 } else { 1 };
        if best.map_or(true, |(s, _)| score > s) {
            best = Some((score, v));
        }
    }
    best.map(|b| b.1)
}

/// "11/11 13:20", "11.11 13:20", "11월 11일 13:20"
fn find_datetime(text: &str, posted: chrono::DateTime<Local>) -> Option<(chrono::NaiveDateTime, usize)> {
    static DT: OnceLock<Regex> = OnceLock::new();
    let dt = re(&DT, r"(\d{1,2})\s?[/.월]\s?(\d{1,2})\s?일?\s+(\d{1,2}):(\d{2})");
    let c = dt.captures(text)?;
    let (mo, d, h, mi): (u32, u32, u32, u32) = (c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?, c[4].parse().ok()?);
    // A December purchase notified in January belongs to the previous year.
    let mut year = posted.year();
    if mo > posted.month() + 1 {
        year -= 1;
    }
    let ndt = NaiveDate::from_ymd_opt(year, mo, d)?.and_hms_opt(h, mi, 0)?;
    Some((ndt, c.get(0)?.end()))
}

fn clean_name(s: &str) -> String {
    static CUT: OnceLock<Regex> = OnceLock::new();
    let cut = re(&CUT, r"(누적|잔액|한도|일시불|할부|\d{1,3}(?:,\d{3})+원|\d+원).*$");
    let s = cut.replace(s.trim(), "");
    s.trim().trim_matches(|c: char| c == '-' || c == '|' || c == ':' || c == ',').trim().chars().take(60).collect()
}

pub fn parse(rule: &Rule, title: &str, text: &str, posted_at_ms: i64) -> Option<Parsed> {
    let full = format!("{title}\n{text}");
    if !rule.include.trim().is_empty() && !split_keywords(&rule.include).any(|k| full.contains(k)) {
        return None;
    }
    if split_keywords(&rule.exclude).any(|k| full.contains(k)) {
        return None;
    }
    let posted = Local.timestamp_millis_opt(posted_at_ms).single().unwrap_or_else(Local::now);

    let amount = if rule.amount_regex.trim().is_empty() {
        find_amount(&full)
    } else {
        Regex::new(&rule.amount_regex).ok().and_then(|r| r.captures(&full)).and_then(|c| c.get(1).or(c.get(0)).and_then(|m| to_amount(m.as_str())))
    }?;

    let dt = find_datetime(&full, posted);
    let purchased_at = dt.map(|(d, _)| d.format("%Y-%m-%d").to_string()).unwrap_or_else(|| posted.format("%Y-%m-%d").to_string());

    let name = match rule.name_source.as_str() {
        "title" => clean_name(title),
        "text" => clean_name(text.lines().next().unwrap_or("")),
        "regex" => Regex::new(&rule.name_regex).ok().and_then(|r| r.captures(&full)).and_then(|c| c.get(1).or(c.get(0)).map(|m| clean_name(m.as_str()))).unwrap_or_default(),
        _ => {
            // Card approvals put the merchant right after the timestamp.
            let after_dt = dt.and_then(|(_, end)| full.get(end..)).map(|rest| clean_name(rest.lines().find(|l| !l.trim().is_empty()).unwrap_or(""))).filter(|n| !n.is_empty());
            after_dt.unwrap_or_else(|| {
                let t = clean_name(title);
                if t.is_empty() { clean_name(text) } else { t }
            })
        }
    };
    Some(Parsed { name: if name.is_empty() { "알림 결제".into() } else { name }, amount, purchased_at })
}

fn default_status(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn.query_row("SELECT id FROM option_items WHERE set_key='expense.status' AND archived=0 ORDER BY sort, id LIMIT 1", [], |r| r.get(0)).optional()?)
}

/// Stores notifications in the inbox and creates expenses for the ones that parse.
/// Returns the number of expenses created.
pub fn ingest(tx: &Connection, items: &[RawNotification]) -> Result<usize> {
    let mut created = 0;
    let status = default_status(tx)?;
    for n in items {
        let app: Option<(i64, Option<i64>, Option<String>)> = tx
            .query_row("SELECT enabled, location_id, rule_json FROM notif_apps WHERE package=?1", [&n.package], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        let Some((enabled, location_id, rule_json)) = app else { continue };
        if enabled == 0 {
            continue;
        }
        // Apps re-post the same notification when it updates; keep one copy.
        let dup: Option<i64> = tx
            .query_row(
                "SELECT id FROM notif_inbox WHERE package=?1 AND text=?2 AND title=?3 AND ABS(posted_at-?4) < 120000 LIMIT 1",
                rusqlite::params![n.package, n.text, n.title, n.posted_at],
                |r| r.get(0),
            )
            .optional()?;
        if dup.is_some() {
            continue;
        }
        let rule: Rule = rule_json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        let parsed = parse(&rule, &n.title, &n.text, n.posted_at);
        let mut inbox = Map::new();
        inbox.insert("package".into(), json!(n.package));
        inbox.insert("title".into(), json!(n.title));
        inbox.insert("text".into(), json!(n.text));
        inbox.insert("posted_at".into(), json!(n.posted_at));
        match parsed {
            Some(p) => {
                let mut e = Map::new();
                e.insert("name".into(), json!(p.name));
                e.insert("amount".into(), json!(p.amount));
                e.insert("purchased_at".into(), json!(p.purchased_at));
                e.insert("paid_at".into(), json!(p.purchased_at));
                e.insert("location_id".into(), json!(location_id));
                e.insert("status_id".into(), json!(status));
                e.insert("source".into(), json!("notification"));
                e.insert("raw_text".into(), json!(format!("{}\n{}", n.title, n.text)));
                let row = db::upsert(tx, "expenses", &e)?;
                inbox.insert("status".into(), json!("parsed"));
                inbox.insert("expense_id".into(), row["id"].clone());
                created += 1;
            }
            None => {
                inbox.insert("status".into(), json!("pending"));
            }
        }
        db::upsert(tx, "notif_inbox", &inbox)?;
    }
    Ok(created)
}

pub fn preview(rule: &Value, title: &str, text: &str) -> Option<Parsed> {
    let rule: Rule = serde_json::from_value(rule.clone()).unwrap_or_default();
    parse(&rule, title, text, Local::now().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> i64 {
        Local.from_local_datetime(&chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()).unwrap().timestamp_millis()
    }

    #[test]
    fn card_approval() {
        let p = parse(&Rule::default(), "KB국민카드", "홍*동님 12,300원 일시불 승인 11/11 13:20 스타벅스강남점 누적 523,000원", ts("2026-11-11 13:21")).unwrap();
        assert_eq!(p.amount, 12300);
        assert_eq!(p.purchased_at, "2026-11-11");
        assert_eq!(p.name, "스타벅스강남점");
    }

    #[test]
    fn shopping_order_prefers_payment_amount() {
        let p = parse(&Rule::default(), "주문이 완료되었어요", "적립 포인트 120원 · 결제금액 24,900원", ts("2026-11-10 09:00")).unwrap();
        assert_eq!(p.amount, 24900);
        assert_eq!(p.purchased_at, "2026-11-10");
        assert_eq!(p.name, "주문이 완료되었어요");
    }

    #[test]
    fn include_exclude_and_custom_regex() {
        let r = Rule { include: "결제".into(), exclude: "광고".into(), ..Default::default() };
        assert!(parse(&r, "이벤트", "오늘만 10,000원 할인", 0).is_none());
        assert!(parse(&r, "(광고) 결제 혜택", "5,000원", 0).is_none());
        let r = Rule { amount_regex: r"합계\s*([\d,]+)".into(), name_source: "regex".into(), name_regex: r"상품:\s*(.+)".into(), ..Default::default() };
        let p = parse(&r, "알림", "상품: 무선 이어폰\n합계 89,000", 0).unwrap();
        assert_eq!((p.amount, p.name.as_str()), (89000, "무선 이어폰"));
    }

    #[test]
    fn december_purchase_seen_in_january() {
        let p = parse(&Rule::default(), "카드", "승인 30,000원 12/31 23:50 편의점", ts("2027-01-01 00:05")).unwrap();
        assert_eq!(p.purchased_at, "2026-12-31");
    }
}
