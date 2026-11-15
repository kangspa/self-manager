import { useState } from "react";
import { api, db, Row } from "../lib/api";
import { useRows } from "../lib/hooks";
import { addDays, fmtDate, monthRange, nowLocal, parseYmd, today, WEEKDAYS, ymd } from "../lib/date";
import { scheduleReminder, cancelReminder } from "../lib/reminders";
import { AutoText, confirmDialog, Empty, Field, Modal, PageHeader, run, toast } from "../components/ui";
import { COLORS } from "./Memos";

const REMIND: [string, string][] = [["", "알림 없음"], ["0", "정시"], ["5", "5분 전"], ["10", "10분 전"], ["30", "30분 전"], ["60", "1시간 전"], ["1440", "하루 전"]];

function EventEditor({ ev, onClose }: { ev: Partial<Row>; onClose: () => void }) {
  const [d, setD] = useState<Partial<Row>>({ all_day: 0, remind_minutes: 10, ...ev });
  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const allDay = !!d.all_day;
  const save = async () => {
    if (!d.title?.trim()) return;
    const { id, created_at, updated_at, gcal_id, gcal_etag, gcal_updated, ...rest } = d;
    let start = rest.start_at ?? nowLocal();
    let end = rest.end_at || null;
    if (allDay) {
      start = start.slice(0, 10);
      end = end ? end.slice(0, 10) : null;
    } else if (start.length === 10) start = `${start}T09:00`;
    const saved = await db.upsert("events", { ...rest, start_at: start, end_at: end, ...(id ? { id } : {}) });
    await scheduleReminder(saved);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={ev.id ? "일정 수정" : "새 일정"}
      footer={
        <>
          {ev.id && (
            <button className="btn danger" onClick={async () => { if (await confirmDialog("일정을 삭제할까요?" + (ev.gcal_id ? "\n구글 캘린더에서도 다음 동기화 때 삭제됩니다." : ""), true)) { await cancelReminder(ev.id!); await api.eventDelete(ev.id!); onClose(); } }}>삭제</button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={save}>저장</button>
        </>
      }
    >
      <Field label="제목"><input value={d.title ?? ""} onChange={(e) => set("title", e.target.value)} autoFocus /></Field>
      <label className="row" style={{ marginBottom: 10 }}><input type="checkbox" checked={allDay} onChange={(e) => set("all_day", e.target.checked ? 1 : 0)} /> 종일</label>
      <div className="grid2" style={{ gap: "0 12px" }}>
        <Field label="시작">
          {allDay ? <input type="date" value={(d.start_at ?? "").slice(0, 10)} onChange={(e) => set("start_at", e.target.value)} /> : <input type="datetime-local" value={(d.start_at ?? "").length === 10 ? `${d.start_at}T09:00` : d.start_at ?? ""} onChange={(e) => set("start_at", e.target.value)} />}
        </Field>
        <Field label="종료">
          {allDay ? <input type="date" value={(d.end_at ?? "").slice(0, 10)} onChange={(e) => set("end_at", e.target.value)} /> : <input type="datetime-local" value={(d.end_at ?? "").length === 10 ? `${d.end_at}T10:00` : d.end_at ?? ""} onChange={(e) => set("end_at", e.target.value)} />}
        </Field>
        <Field label="알림">
          <select value={d.remind_minutes ?? ""} onChange={(e) => set("remind_minutes", e.target.value === "" ? null : Number(e.target.value))}>
            {REMIND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="장소"><input value={d.location ?? ""} onChange={(e) => set("location", e.target.value)} /></Field>
      </div>
      <Field label="색">
        <div className="colors">{COLORS.map((c) => <span key={c} className={`color-dot ${(d.color ?? "") === c ? "on" : ""}`} style={{ background: c || "var(--accent)" }} onClick={() => set("color", c || null)} />)}</div>
      </Field>
      <Field label="설명"><AutoText className="boxed" value={d.description ?? ""} onChange={(v) => set("description", v)} minRows={2} /></Field>
      {ev.gcal_id && <div className="faint small">구글 캘린더와 연결된 일정</div>}
    </Modal>
  );
}

export default function Calendar() {
  const [cur, setCur] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [sel, setSel] = useState(today());
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const [mFrom] = monthRange(cur);
  const gridFrom = addDays(mFrom, -parseYmd(mFrom).getDay());
  // Always 6 weeks so the grid height never jumps between months.
  const gridTo = addDays(gridFrom, 41);
  const { rows } = useRows("events", { filters: [{ col: "start_at", op: "<=", value: `${gridTo}T99` }, { col: "start_at", op: ">=", value: addDays(gridFrom, -40) }], order: [["start_at", "asc"]], limit: 5000 });
  const t = today();
  const days: string[] = [];
  for (let d = gridFrom; d <= gridTo; d = addDays(d, 1)) days.push(d);
  const onDay = (d: string) => rows.filter((e) => { const s = e.start_at.slice(0, 10); const en = (e.end_at || e.start_at).slice(0, 10); return s <= d && d <= en; });
  const selEvents = onDay(sel);

  return (
    <div>
      <PageHeader
        title="일정"
        icon="🗓️"
        actions={
          <>
            <button className="btn" onClick={async () => { const r = await run(() => api.gcalSync()); if (r) toast(`구글 캘린더 동기화 완료: 보냄 ${r.pushed} · 받음 ${r.pulled} · 삭제 ${r.deleted}`, "ok"); }}>구글 캘린더 동기화</button>
            <button className="btn primary" onClick={() => setEdit({ start_at: `${sel}T09:00`, end_at: `${sel}T10:00` })}>+ 일정</button>
          </>
        }
      />
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="icon-btn" onClick={() => setCur(new Date(cur.getFullYear(), cur.getMonth() - 1, 1))}>‹</button>
        <b style={{ fontSize: 17 }}>{cur.getFullYear()}년 {cur.getMonth() + 1}월</b>
        <button className="icon-btn" onClick={() => setCur(new Date(cur.getFullYear(), cur.getMonth() + 1, 1))}>›</button>
        <button className="btn sm" onClick={() => { const d = new Date(); setCur(new Date(d.getFullYear(), d.getMonth(), 1)); setSel(today()); }}>오늘</button>
      </div>
      <div className="cal">
        {WEEKDAYS.map((w, i) => <div key={w} className={`cal-h ${i === 0 ? "sun" : i === 6 ? "sat" : ""}`}>{w}</div>)}
        {days.map((d) => {
          const evs = onDay(d);
          const dd = parseYmd(d);
          return (
            <div key={d} className={`cal-d ${dd.getMonth() !== cur.getMonth() ? "other" : ""} ${d === t ? "today" : ""} ${d === sel ? "sel" : ""}`} onClick={() => setSel(d)} onDoubleClick={() => setEdit({ start_at: `${d}T09:00`, end_at: `${d}T10:00` })}>
              <span className={`cal-n ${dd.getDay() === 0 ? "sun" : dd.getDay() === 6 ? "sat" : ""}`}>{dd.getDate()}</span>
              {evs.slice(0, 3).map((e) => (
                <div key={e.id} className="cal-ev" style={{ ["--c" as any]: e.color || undefined }} onClick={(x) => { x.stopPropagation(); setEdit(e); }}>
                  {!e.all_day && e.start_at.slice(0, 10) === d ? `${e.start_at.slice(11, 16)} ` : ""}{e.title}
                </div>
              ))}
              {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
            </div>
          );
        })}
      </div>
      <div className="section">
        <div className="section-title">{fmtDate(sel)} 일정 <button className="btn sm" onClick={() => setEdit({ start_at: `${sel}T09:00`, end_at: `${sel}T10:00` })}>+ 추가</button></div>
        {selEvents.length === 0 && <Empty>일정이 없습니다</Empty>}
        <div className="list">
          {selEvents.map((e) => (
            <div key={e.id} className="list-row click" onClick={() => setEdit(e)}>
              <span className="dot" style={{ ["--c" as any]: e.color || "var(--accent)" }} />
              <span className="meta" style={{ width: 90 }}>{e.all_day ? "종일" : `${e.start_at.slice(11, 16)}${e.end_at ? `~${e.end_at.slice(11, 16)}` : ""}`}</span>
              <div className="grow"><b>{e.title}</b>{e.location && <span className="faint small"> · {e.location}</span>}</div>
              {e.remind_minutes != null && <span className="faint small">🔔</span>}
              {e.gcal_id && <span className="badge">Google</span>}
            </div>
          ))}
        </div>
      </div>
      {edit && <EventEditor key={edit.id ?? `new-${ymd(new Date())}`} ev={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
