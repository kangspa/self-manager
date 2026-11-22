import { useState } from "react";
import { Link } from "react-router-dom";
import { db, Row } from "../lib/api";
import { useAutosave, useLoad, useRows } from "../lib/hooks";
import { daysBetween, fmtDate, monthGrid } from "../lib/date";
import { Attachments } from "../components/Attachments";
import { MonthGrid, PeriodNav, usePeriod, WeekColumns } from "../components/Period";
import { AutoText, confirmDialog, Empty, PageHeader, SearchBox, useDebounced } from "../components/ui";

export type DiaryField = { key: string; label: string; type: "text" | "longtext" | "rating" | "number" | "checkbox" | "select"; options?: string };

export function parseFields(t?: Row | null): DiaryField[] {
  try {
    return JSON.parse(t?.fields_json ?? "[]");
  } catch {
    return [];
  }
}

function FieldInput({ f, value, onChange }: { f: DiaryField; value: any; onChange: (v: any) => void }) {
  switch (f.type) {
    case "longtext":
      return <AutoText className="boxed" value={value ?? ""} onChange={onChange} minRows={4} />;
    case "rating":
      return (
        <div className="row" style={{ fontSize: 22, gap: 4 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} style={{ cursor: "pointer", opacity: (value ?? 0) >= n ? 1 : 0.25 }} onClick={() => onChange(value === n ? 0 : n)}>★</span>
          ))}
        </div>
      );
    case "number":
      return <input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} style={{ width: 160 }} />;
    case "checkbox":
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case "select":
      return (
        <div className="preset-pick">
          {(f.options ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((o) => (
            <button key={o} className={`preset-btn ${value === o ? "done" : ""}`} style={{ ["--c" as any]: "var(--accent)" }} onClick={() => onChange(value === o ? null : o)}>{o}</button>
          ))}
        </div>
      );
    default:
      return <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }} />;
  }
}

function Entry({ date, entry, templates }: { date: string; entry: Row | undefined; templates: Row[] }) {
  const def = templates.find((t) => t.is_default) ?? templates[0];
  const [tid, setTid] = useState<number | undefined>(entry?.template_id ?? def?.id);
  const tpl = templates.find((t) => t.id === tid) ?? def;
  const fields = parseFields(tpl);
  const initial = (() => {
    try {
      return JSON.parse(entry?.values_json ?? "{}");
    } catch {
      return {};
    }
  })();
  const [vals, setVals] = useAutosave<Record<string, any>>(initial, async (v) => {
    const mood = fields.find((f) => f.type === "rating");
    const row = { date, template_id: tpl?.id ?? null, values_json: JSON.stringify(v), mood: mood ? v[mood.key] ?? null : null };
    // One entry per date (UNIQUE): look it up again in case it was created meanwhile.
    const existing = entry?.id ?? (await db.list("diary_entries", { filters: [{ col: "date", op: "=", value: date }], limit: 1 }))[0]?.id;
    await db.upsert("diary_entries", existing ? { id: existing, ...row } : row);
  });
  const [entryId, setEntryId] = useState<number | undefined>(entry?.id);
  const ensureEntry = async () => {
    const found = (await db.list("diary_entries", { filters: [{ col: "date", op: "=", value: date }], limit: 1 }))[0];
    const id = found?.id ?? (await db.upsert("diary_entries", { date, template_id: tpl?.id ?? null, values_json: JSON.stringify(vals) })).id;
    setEntryId(id);
    return id;
  };
  // Values for fields no longer in the template stay stored and are shown read-only.
  const orphans = Object.keys(vals).filter((k) => !fields.some((f) => f.key === k) && vals[k] !== "" && vals[k] != null);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted small">템플릿</span>
        <select value={tpl?.id ?? ""} onChange={(e) => setTid(Number(e.target.value))}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <Link to="/settings#diary" className="small">템플릿 편집</Link>
        <span className="spacer" />
        {entry && <button className="btn sm danger" onClick={async () => (await confirmDialog(`${date} 일기를 삭제할까요?`, true)) && db.remove("diary_entries", entry.id)}>삭제</button>}
      </div>
      {fields.length === 0 && <Empty>템플릿에 항목이 없습니다. 설정 › 일기 템플릿에서 항목을 추가하세요.</Empty>}
      {fields.map((f) => (
        <div key={f.key} className="section" style={{ marginTop: 18 }}>
          <div className="field-label" style={{ marginBottom: 6 }}>{f.label}</div>
          <FieldInput f={f} value={vals[f.key]} onChange={(v) => setVals((p) => ({ ...p, [f.key]: v }))} />
        </div>
      ))}
      <Attachments ownerTable="diary_entries" ownerId={entryId} ensureOwner={ensureEntry} title="사진·첨부 파일" />
      {orphans.length > 0 && (
        <details className="section">
          <summary className="muted small">다른 템플릿으로 쓴 내용 {orphans.length}개</summary>
          {orphans.map((k) => <div key={k} className="notice" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}><b>{k}</b>: {String(vals[k])}</div>)}
        </details>
      )}
    </div>
  );
}

/** Text of an entry for previews (all filled text fields, in order). */
function previewOf(r: Row) {
  try {
    return Object.values(JSON.parse(r.values_json)).filter((x) => typeof x === "string" && x).join(" · ");
  } catch {
    return "";
  }
}

function DayEditor({ date, templates }: { date: string; templates: Row[] }) {
  // Loaded once per date (not on every write) so the editor is not remounted while typing.
  const { data: loaded } = useLoad(async () => ({ date, entry: (await db.list("diary_entries", { filters: [{ col: "date", op: "=", value: date }], limit: 1 }))[0] }), [date], []);
  if (templates.length === 0) return <Empty>설정 › 일기 템플릿에서 템플릿을 만들어 주세요</Empty>;
  return loaded?.date === date ? <Entry key={date} date={date} entry={loaded.entry} templates={templates} /> : null;
}

export default function Diary() {
  const p = usePeriod("diary", "day");
  const [q, setQ] = useState("");
  const search = useDebounced(q);
  const templates = useRows("diary_templates", { order: [["sort", "asc"], ["id", "asc"]] });
  const [from, to] = p.mode === "month" ? [monthGrid(p.anchor)[0], monthGrid(p.anchor)[41]] : p.range;
  const inRange = useRows("diary_entries", { filters: [{ col: "date", op: ">=", value: from }, { col: "date", op: "<=", value: to }], order: [["date", "asc"]], limit: 100 });
  const recent = useRows("diary_entries", { search, order: [["date", "desc"]], limit: 60 });
  const byDate = new Map(inRange.rows.map((r) => [r.date, r]));
  const stars = (r?: Row) => (r?.mood ? "★".repeat(r.mood) : "");

  return (
    <div>
      <PageHeader title="일기" icon="📔" actions={<SearchBox value={q} onChange={setQ} placeholder="일기 검색" />} />
      <PeriodNav p={p} />
      {search ? (
        <div className="list">
          {recent.rows.map((r) => (
            <div key={r.id} className="list-row click" onClick={() => { setQ(""); p.openDay(r.date); }} style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span className="small"><b>{fmtDate(r.date)}</b> {stars(r)}</span>
              <span className="faint small ellipsis" style={{ maxWidth: "100%" }}>{previewOf(r)}</span>
            </div>
          ))}
          {recent.rows.length === 0 && <Empty>찾는 일기가 없습니다</Empty>}
        </div>
      ) : p.mode === "day" ? (
        <div className="split">
          <DayEditor date={p.anchor} templates={templates.rows} />
          <div>
            <div className="section-title">최근 일기</div>
            <div className="list">
              {recent.rows.map((r) => (
                <div key={r.id} className="list-row click" onClick={() => p.setAnchor(r.date)} style={{ background: r.date === p.anchor ? "var(--bg-hover)" : undefined, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                  <span className="small"><b>{fmtDate(r.date)}</b> {stars(r)}</span>
                  <span className="faint small ellipsis" style={{ maxWidth: "100%" }}>{previewOf(r)}</span>
                </div>
              ))}
              {recent.rows.length === 0 && <Empty>아직 일기가 없습니다</Empty>}
            </div>
          </div>
        </div>
      ) : p.mode === "week" ? (
        <WeekColumns
          days={daysBetween(from, to)}
          onPick={p.openDay}
          render={(d) => {
            const r = byDate.get(d);
            return r ? (
              <div className="click" onClick={() => p.openDay(d)}>
                {stars(r) && <div className="diary-stars">{stars(r)}</div>}
                <div className="small diary-preview">{previewOf(r) || <span className="faint">내용 없음</span>}</div>
              </div>
            ) : (
              <button className="btn sm ghost faint" onClick={() => p.openDay(d)}>+ 쓰기</button>
            );
          }}
        />
      ) : (
        <MonthGrid
          anchor={p.anchor}
          onPick={p.openDay}
          render={(d) => {
            const r = byDate.get(d);
            return r ? (
              <>
                {stars(r) && <span className="diary-stars small">{stars(r)}</span>}
                <span className="cal-ev">{previewOf(r) || "일기"}</span>
              </>
            ) : null;
          }}
        />
      )}
    </div>
  );
}
