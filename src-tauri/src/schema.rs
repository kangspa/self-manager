//! Database schema, migrations and the column whitelist used by the generic CRUD
//! commands. Every identifier that reaches SQL text must come from `TABLES`.

pub struct TableDef {
    pub name: &'static str,
    /// Writable columns (excluding `id`, `created_at`, `updated_at`).
    pub cols: &'static [&'static str],
    /// Columns searched by the free-text `search` filter.
    pub search: &'static [&'static str],
    pub has_created: bool,
}

pub const TABLES: &[TableDef] = &[
    TableDef { name: "option_items", cols: &["set_key", "label", "color", "sort", "archived"], search: &["label"], has_created: false },
    TableDef { name: "memos", cols: &["title", "body", "pinned", "color"], search: &["title", "body"], has_created: true },
    TableDef { name: "tasks", cols: &["title", "note", "due_at", "done_at", "priority"], search: &["title", "note"], has_created: true },
    TableDef {
        name: "expenses",
        cols: &["name", "url", "location_id", "amount", "purchased_at", "expected_delivery", "item_id", "status_id", "memo", "source", "raw_text", "subscription_id"],
        search: &["name", "memo", "url"],
        has_created: true,
    },
    TableDef {
        name: "subscriptions",
        cols: &["name", "amount", "cycle", "day", "month", "location_id", "item_id", "start_date", "end_date", "memo", "active", "url"],
        search: &["name", "memo"],
        has_created: true,
    },
    TableDef { name: "notif_apps", cols: &["package", "label", "location_id", "enabled", "rule_json"], search: &["package", "label"], has_created: true },
    TableDef { name: "notif_inbox", cols: &["package", "title", "text", "posted_at", "status", "expense_id"], search: &["title", "text"], has_created: true },
    TableDef { name: "goals", cols: &["title", "summary", "status_id", "category_id", "start_date", "end_date", "body", "sort"], search: &["title", "summary", "body"], has_created: true },
    TableDef { name: "goal_notes", cols: &["goal_id", "period_type", "period_key", "body"], search: &["body"], has_created: true },
    TableDef { name: "diary_templates", cols: &["name", "fields_json", "is_default", "sort"], search: &["name"], has_created: true },
    TableDef { name: "diary_entries", cols: &["date", "template_id", "values_json", "mood"], search: &["values_json"], has_created: true },
    TableDef { name: "daily_presets", cols: &["label", "kind", "color", "sort", "archived"], search: &["label"], has_created: true },
    TableDef { name: "daily_rules", cols: &["preset_id", "rule_type", "value"], search: &[], has_created: true },
    TableDef { name: "daily_logs", cols: &["date", "preset_id", "done", "note", "value"], search: &["note"], has_created: true },
    TableDef {
        name: "events",
        cols: &["title", "description", "start_at", "end_at", "all_day", "location", "remind_minutes", "color", "gcal_id", "gcal_etag", "gcal_updated"],
        search: &["title", "description", "location"],
        has_created: true,
    },
    TableDef { name: "projects", cols: &["name", "description", "status", "color", "archived", "sort"], search: &["name", "description"], has_created: true },
    TableDef { name: "work_logs", cols: &["date", "project_id", "title", "body", "tags"], search: &["title", "body", "tags"], has_created: true },
    TableDef {
        name: "meetings",
        cols: &["work_log_id", "project_id", "title", "date", "audio_path", "duration_sec", "transcript_json", "summary_md", "status", "error"],
        search: &["title", "summary_md"],
        has_created: true,
    },
    // Files attached to any record. The bytes live outside the DB in
    // files/<sha256>; this row is the (small, mergeable) metadata.
    TableDef { name: "attachments", cols: &["owner_table", "owner_id", "role", "name", "mime", "size", "sha256", "sync_mode"], search: &["name"], has_created: true },
    // Settings shared by all devices (merged like any other row, unique by key).
    TableDef { name: "app_settings", cols: &["key", "value"], search: &[], has_created: false },
];

pub fn table(name: &str) -> Option<&'static TableDef> {
    TABLES.iter().find(|t| t.name == name)
}

/// Ordered list of migrations; `PRAGMA user_version` stores how many were applied.
pub const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE option_items (
  id INTEGER PRIMARY KEY, set_key TEXT NOT NULL, label TEXT NOT NULL, color TEXT,
  sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
);
CREATE INDEX idx_option_set ON option_items(set_key, sort);

CREATE TABLE memos (
  id INTEGER PRIMARY KEY, title TEXT, body TEXT, pinned INTEGER NOT NULL DEFAULT 0, color TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_memos_updated ON memos(pinned DESC, updated_at DESC);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', note TEXT, due_at TEXT, done_at INTEGER,
  priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_tasks_due ON tasks(done_at, due_at);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY, name TEXT, url TEXT, location_id INTEGER, amount INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT, expected_delivery TEXT, item_id INTEGER, status_id INTEGER, memo TEXT,
  source TEXT NOT NULL DEFAULT 'manual', raw_text TEXT, subscription_id INTEGER,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_expenses_date ON expenses(purchased_at);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0,
  cycle TEXT NOT NULL DEFAULT 'monthly', day INTEGER, month INTEGER, location_id INTEGER, item_id INTEGER,
  start_date TEXT, end_date TEXT, memo TEXT, active INTEGER NOT NULL DEFAULT 1, url TEXT,
  created_at INTEGER, updated_at INTEGER
);

CREATE TABLE notif_apps (
  id INTEGER PRIMARY KEY, package TEXT NOT NULL UNIQUE, label TEXT, location_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1, rule_json TEXT, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE notif_inbox (
  id INTEGER PRIMARY KEY, package TEXT, title TEXT, text TEXT, posted_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', expense_id INTEGER, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_inbox_status ON notif_inbox(status, posted_at DESC);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', summary TEXT, status_id INTEGER, category_id INTEGER,
  start_date TEXT, end_date TEXT, body TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE goal_notes (
  id INTEGER PRIMARY KEY, goal_id INTEGER NOT NULL, period_type TEXT NOT NULL, period_key TEXT NOT NULL,
  body TEXT, created_at INTEGER, updated_at INTEGER,
  UNIQUE(goal_id, period_type, period_key)
);

CREATE TABLE diary_templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', fields_json TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE diary_entries (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL UNIQUE, template_id INTEGER, values_json TEXT NOT NULL DEFAULT '{}',
  mood INTEGER, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE daily_presets (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'check', color TEXT,
  sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE daily_rules (
  id INTEGER PRIMARY KEY, preset_id INTEGER NOT NULL, rule_type TEXT NOT NULL, value TEXT NOT NULL,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_daily_rules_preset ON daily_rules(preset_id);

CREATE TABLE daily_logs (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, preset_id INTEGER, done INTEGER NOT NULL DEFAULT 1, note TEXT,
  value REAL, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_daily_logs_date ON daily_logs(date);

CREATE TABLE events (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', description TEXT, start_at TEXT NOT NULL, end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0, location TEXT, remind_minutes INTEGER, color TEXT,
  gcal_id TEXT, gcal_etag TEXT, gcal_updated TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_events_start ON events(start_at);
CREATE UNIQUE INDEX idx_events_gcal ON events(gcal_id) WHERE gcal_id IS NOT NULL;

CREATE TABLE projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT, status TEXT, color TEXT,
  archived INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);

CREATE TABLE work_logs (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, project_id INTEGER, title TEXT, body TEXT, tags TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_work_date ON work_logs(date);
CREATE INDEX idx_work_project ON work_logs(project_id, date);

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY, work_log_id INTEGER, project_id INTEGER, title TEXT, date TEXT,
  audio_path TEXT, duration_sec REAL, transcript_json TEXT, summary_md TEXT,
  status TEXT NOT NULL DEFAULT 'recording', error TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_meetings_date ON meetings(date);
CREATE INDEX idx_meetings_work ON meetings(work_log_id);
"#,
    r#"
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY, owner_table TEXT NOT NULL, owner_id INTEGER NOT NULL, role TEXT,
  name TEXT NOT NULL DEFAULT '', mime TEXT, size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL,
  -- 'auto' = follow the size limit in settings, 'on' = always sync, 'off' = never sync
  sync_mode TEXT NOT NULL DEFAULT 'auto', created_at INTEGER, updated_at INTEGER
);
CREATE INDEX idx_att_owner ON attachments(owner_table, owner_id);
CREATE INDEX idx_att_sha ON attachments(sha256);

CREATE TABLE app_settings (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT, updated_at INTEGER);
-- Fixed id so every device edits the same row and merges it column-wise.
INSERT INTO app_settings(id, key, value, updated_at) VALUES (1, 'sync_max_mb', '10', 0);
"#,
];

/// Default selectable values and templates inserted into a brand-new database.
pub const SEED: &str = r#"
INSERT INTO option_items(set_key,label,color,sort) VALUES
 ('expense.status','결제완료','#4b8bf5',0),('expense.status','배송중','#f5a623',1),
 ('expense.status','배송완료','#3bb273',2),('expense.status','취소/환불','#9b9b9b',3),
 ('expense.item','식비','#f56c6c',0),('expense.item','생활','#4b8bf5',1),('expense.item','쇼핑','#b06cf5',2),
 ('expense.item','교통','#3bb273',3),('expense.item','구독','#f5a623',4),('expense.item','기타','#9b9b9b',5),
 ('expense.location','직접 입력','#9b9b9b',0),
 ('goal.status','예정','#9b9b9b',0),('goal.status','진행','#4b8bf5',1),('goal.status','완료','#3bb273',2),('goal.status','폐기','#f56c6c',3),
 ('goal.category','커리어','#4b8bf5',0),('goal.category','건강','#3bb273',1),('goal.category','학습','#b06cf5',2),
 ('goal.category','재정','#f5a623',3),('goal.category','취미','#f56c6c',4);

INSERT INTO diary_templates(name,fields_json,is_default,sort) VALUES
 ('기본 일기','[{"key":"mood","label":"오늘의 기분","type":"rating"},{"key":"done","label":"오늘 있었던 일","type":"longtext"},{"key":"thanks","label":"감사한 일","type":"text"},{"key":"tomorrow","label":"내일 할 일","type":"text"}]',1,0);

INSERT INTO daily_presets(label,kind,color,sort) VALUES
 ('운동','check','#3bb273',0),('독서','check','#b06cf5',1),('물 2L','check','#4b8bf5',2),('한 줄 메모','memo','#f5a623',3);
"#;
