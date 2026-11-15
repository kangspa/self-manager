import { useState } from "react";
import { Link } from "react-router-dom";
import { api, db, Row } from "../lib/api";
import { useLoad, useRows } from "../lib/hooks";
import { addDays, fmtDate, monthRange, parseYmd, today, weekRange, WEEKDAYS } from "../lib/date";
import { AutoText, Chip, Empty, Modal, PageHeader } from "../components/ui";

type Day = { planned: number[]; logs: Row[] };

function DayModal({ date, day, presets, onClose }: { date: string; day: Day; presets: Row[]; onClose: () => void }) {
  const [memoFor, setMemoFor] = useState<number | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const logsOf = (pid: number) => day.logs.filter((l) => l.preset_id === pid);

  const toggle = async (p: Row) => {
    if (p.kind === "memo") {
      setMemoFor(p.id);
      setNote("");
      return;
    }
    const ex = logsOf(p.id);
    if (ex.length) await db.remove("daily_logs", ex[0].id);
    else await db.upsert("daily_logs", { date, preset_id: p.id, done: 1 });
  };
  const saveNote = async () => {
    if (!note.trim()) return;
    await db.upsert("daily_logs", { date, preset_id: memoFor ?? null, done: 1, note: note.trim() });
    setMemoFor(undefined);
    setNote("");
  };

  return (
    <Modal open onClose={onClose} title={`${fmtDate(date)} 기록`} footer={<button className="btn primary" onClick={onClose}>완료</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>눌러서 오늘 한 일로 기록합니다. 점선 항목은 이 날 하기로 정해 둔 일입니다.</p>
      <div className="preset-pick">
        {presets.map((p) => {
          const done = logsOf(p.id).length > 0;
          const planned = day.planned.includes(p.id);
          return (
            <button key={p.id} className={`preset-btn ${done ? "done" : planned ? "planned" : ""}`} style={{ ["--c" as any]: p.color || "var(--accent)" }} onClick={() => toggle(p)}>
              <span className="dot" />
              {p.label}
              {p.kind === "memo" && " ✎"}
              {done && p.kind !== "memo" && " ✓"}
            </button>
          );
        })}
        <button className="preset-btn" onClick={() => { setMemoFor(null); setNote(""); }}>+ 자유 메모</button>
      </div>
      {memoFor !== undefined && (
        <div className="section" style={{ marginTop: 14 }}>
          <div className="field-label">{memoFor ? presets.find((p) => p.id === memoFor)?.label : "자유 메모"}</div>
          <AutoText className="boxed" value={note} onChange={setNote} minRows={2} autoFocus placeholder="무엇을 했는지 짧게" />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn primary sm" onClick={saveNote}>추가</button>
            <button className="btn sm" onClick={() => setMemoFor(undefined)}>취소</button>
          </div>
        </div>
      )}
      <div className="section">
        <div className="section-title">이 날의 기록</div>
        {day.logs.length === 0 && <Empty>아직 기록이 없습니다</Empty>}
        {day.logs.map((l) => {
          const p = presets.find((x) => x.id === l.preset_id);
          return (
            <div key={l.id} className="list-row">
              <span className="dot" style={{ ["--c" as any]: p?.color || "#9b9b9b" }} />
              <div className="grow">
                <b>{p?.label ?? "메모"}</b>
                {l.note && <div className="small" style={{ whiteSpace: "pre-wrap" }}>{l.note}</div>}
              </div>
              <span className="meta">{new Date(l.created_at).toTimeString().slice(0, 5)}</span>
              <button className="icon-btn" onClick={() => db.remove("daily_logs", l.id)} aria-label="삭제">✕</button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export default function Daily() {
  const [mode, setMode] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(today());
  const [open, setOpen] = useState<string | null>(null);
  const presets = useRows("daily_presets", { filters: [{ col: "archived", op: "=", value: 0 }], order: [["sort", "asc"], ["id", "asc"]] });
  const [from, to] = mode === "week" ? weekRange(anchor) : (() => { const [a, b] = monthRange(parseYmd(anchor)); return [weekRange(a)[0], weekRange(b)[1]] as const; })();
  const { data } = useLoad(() => api.dailyView(from, to), [from, to], ["daily_logs", "daily_rules", "daily_presets"]);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const pmap = new Map(presets.rows.map((p) => [p.id, p]));
  const t = today();
  const shift = (n: number) => {
    if (mode === "week") setAnchor(addDays(anchor, 7 * n));
    else {
      const d = parseYmd(anchor);
      d.setMonth(d.getMonth() + n, 1);
      setAnchor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`);
    }
  };
  const a = parseYmd(anchor);

  const cell = (d: string, compact: boolean) => {
    const day = data?.[d] ?? { planned: [], logs: [] };
    const loggedIds = new Set(day.logs.map((l) => l.preset_id));
    const pending = day.planned.filter((id) => !loggedIds.has(id));
    const checks = day.logs.filter((l) => !l.note);
    const notes = day.logs.filter((l) => l.note);
    const dd = parseYmd(d);
    return (
      <div key={d} className={`daily-day ${d === t ? "today" : ""}`} onClick={() => setOpen(d)} style={compact ? { minHeight: 96, opacity: mode === "month" && dd.getMonth() !== a.getMonth() ? 0.45 : 1 } : undefined}>
        <div className="daily-day-h">
          <span className={dd.getDay() === 0 ? "sun" : dd.getDay() === 6 ? "sat" : ""}>{compact ? dd.getDate() : `${dd.getMonth() + 1}/${dd.getDate()} ${WEEKDAYS[dd.getDay()]}`}</span>
          {pending.length > 0 && <span className="faint small">{pending.length} 남음</span>}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {checks.map((l) => { const p = pmap.get(l.preset_id); return p ? <Chip key={l.id} label={p.label} color={p.color} /> : null; })}
          {pending.map((id) => { const p = pmap.get(id); return p ? <Chip key={`p${id}`} label={p.label} color={p.color} faded /> : null; })}
        </div>
        {!compact && notes.map((l) => (
          <div key={l.id} className="daily-note" style={{ ["--c" as any]: pmap.get(l.preset_id)?.color }}>{l.note}</div>
        ))}
        {compact && notes.length > 0 && <span className="faint small">✎ {notes.length}</span>}
      </div>
    );
  };

  return (
    <div>
      <PageHeader title="일일 관리" icon="📅" sub="매일 할 일과 한 일을 한눈에" actions={<Link to="/settings#daily" className="btn">항목·반복 설정</Link>} />
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="seg">
          <button className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>주</button>
          <button className={mode === "month" ? "on" : ""} onClick={() => setMode("month")}>월</button>
        </div>
        <button className="icon-btn" onClick={() => shift(-1)}>‹</button>
        <b>{mode === "week" ? `${from.slice(5).replace("-", "/")} ~ ${to.slice(5).replace("-", "/")}` : `${a.getFullYear()}년 ${a.getMonth() + 1}월`}</b>
        <button className="icon-btn" onClick={() => shift(1)}>›</button>
        <button className="btn sm" onClick={() => setAnchor(today())}>오늘</button>
      </div>
      {presets.rows.length === 0 && <Empty>설정에서 매일 체크할 항목(운동, 독서 등)을 먼저 만들어 주세요</Empty>}
      {mode === "week" ? (
        <div className="daily-week">{days.map((d) => cell(d, false))}</div>
      ) : (
        <div className="daily-week month" style={{ gridTemplateColumns: "repeat(7, minmax(44px, 1fr))", gap: 4 }}>
          {["월", "화", "수", "목", "금", "토", "일"].map((w) => <div key={w} className="faint small" style={{ textAlign: "center" }}>{w}</div>)}
          {days.map((d) => cell(d, true))}
        </div>
      )}
      {open && <DayModal date={open} day={data?.[open] ?? { planned: [], logs: [] }} presets={presets.rows} onClose={() => setOpen(null)} />}
    </div>
  );
}
