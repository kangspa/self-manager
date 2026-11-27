import { useState } from "react";
import { richFirstLine } from "../lib/rich";
import { api, db, Row } from "../lib/api";
import { useRows } from "../lib/hooks";
import { addDays, daysBetween, fmtDate, monthGrid, nowLocal, overlaps, today, ymd } from "../lib/date";
import { MonthGrid, PeriodNav, usePeriod, WeekColumns } from "../components/Period";
import { scheduleReminder, cancelReminder } from "../lib/reminders";
import { confirmDialog, Empty, Field, Modal, PageHeader, run, toast } from "../components/ui";
import { RichText } from "../components/RichText";
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
      <Field label="설명"><RichText value={d.description ?? ""} onChange={(v) => set("description", v)} owner={ev.id ? { table: "events", id: ev.id } : undefined} /></Field>
      {ev.gcal_id && <div className="faint small">구글 캘린더와 연결된 일정</div>}
    </Modal>
  );
}

/** "09:00~10:00" / "종일" / multi-day ranges, as seen from day `d`. */
function timeText(e: Row, d: string) {
  if (e.all_day) return "종일";
  const s = e.start_at.slice(0, 10), en = (e.end_at || e.start_at).slice(0, 10);
  const st = s === d ? e.start_at.slice(11, 16) : "…";
  const et = e.end_at ? (en === d ? e.end_at.slice(11, 16) : "…") : "";
  return et ? `${st}~${et}` : st;
}

function EventRows({ events, day, onOpen }: { events: Row[]; day: string; onOpen: (e: Row) => void }) {
  if (events.length === 0) return <Empty>일정이 없습니다</Empty>;
  return (
    <div className="list">
      {events.map((e) => (
        <div key={e.id} className="list-row click" onClick={() => onOpen(e)}>
          <span className="dot" style={{ ["--c" as any]: e.color || "var(--accent)" }} />
          <span className="meta" style={{ width: 96 }}>{timeText(e, day)}</span>
          <div className="grow">
            <b>{e.title}</b>
            {e.location && <span className="faint small"> · {e.location}</span>}
            {e.description && <div className="faint small ellipsis">{richFirstLine(e.description)}</div>}
          </div>
          {e.remind_minutes != null && <span className="faint small">🔔</span>}
          {e.gcal_id && <span className="badge">Google</span>}
        </div>
      ))}
    </div>
  );
}

export default function Calendar() {
  const p = usePeriod("calendar", "month");
  const [sel, setSel] = useState(today());
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const grid = monthGrid(p.anchor);
  const [from, to] = p.mode === "month" ? [grid[0], grid[41]] : p.range;
  // Events that started up to 40 days before the range can still be running in it.
  const { rows } = useRows("events", { filters: [{ col: "start_at", op: "<=", value: `${to}T99` }, { col: "start_at", op: ">=", value: addDays(from, -40) }], order: [["all_day", "desc"], ["start_at", "asc"]], limit: 5000 });
  const onDay = (d: string) => rows.filter((e) => overlaps(e.start_at, e.end_at, d, d));
  const newAt = (d: string) => setEdit({ start_at: `${d}T09:00`, end_at: `${d}T10:00` });
  const focus = p.mode === "month" ? sel : p.anchor;

  return (
    <div>
      <PageHeader
        title="일정"
        icon="🗓️"
        actions={
          <>
            <button className="btn" onClick={async () => { const r = await run(() => api.gcalSync()); if (r) toast(`구글 캘린더 동기화 완료: 보냄 ${r.pushed} · 받음 ${r.pulled} · 삭제 ${r.deleted}`, "ok"); }}>구글 캘린더 동기화</button>
            <button className="btn primary" onClick={() => newAt(focus)}>+ 일정</button>
          </>
        }
      />
      <PeriodNav p={p} />
      {p.mode === "day" && <EventRows events={onDay(p.anchor)} day={p.anchor} onOpen={setEdit} />}
      {p.mode === "week" && (
        <WeekColumns
          days={daysBetween(from, to)}
          onPick={p.openDay}
          action={(d) => <button className="icon-btn" aria-label="일정 추가" onClick={() => newAt(d)}>+</button>}
          render={(d) =>
            onDay(d).map((e) => (
              <div key={e.id} className="cal-ev click" style={{ ["--c" as any]: e.color || undefined, whiteSpace: "normal" }} onClick={() => setEdit(e)}>
                <span className="faint">{timeText(e, d)}</span> {e.title}
              </div>
            ))
          }
        />
      )}
      {p.mode === "month" && (
        <>
          <MonthGrid
            anchor={p.anchor}
            selected={sel}
            onPick={setSel}
            onDouble={newAt}
            render={(d) => {
              const evs = onDay(d);
              return (
                <>
                  {evs.slice(0, 3).map((e) => (
                    <div key={e.id} className="cal-ev" style={{ ["--c" as any]: e.color || undefined }} onClick={(x) => { x.stopPropagation(); setEdit(e); }}>
                      {!e.all_day && e.start_at.slice(0, 10) === d ? `${e.start_at.slice(11, 16)} ` : ""}{e.title}
                    </div>
                  ))}
                  {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
                </>
              );
            }}
          />
          <div className="section">
            <div className="section-title">
              {fmtDate(sel)} 일정
              <span className="row">
                <button className="btn sm" onClick={() => p.openDay(sel)}>이 날 보기</button>
                <button className="btn sm" onClick={() => newAt(sel)}>+ 추가</button>
              </span>
            </div>
            <EventRows events={onDay(sel)} day={sel} onOpen={setEdit} />
          </div>
        </>
      )}
      {edit && <EventEditor key={edit.id ?? `new-${ymd(new Date())}`} ev={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
