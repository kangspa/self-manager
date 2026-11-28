import { useEffect, useMemo, useState } from "react";
import { db, Row } from "../lib/api";
import { useRows } from "../lib/hooks";
import { daysBetween, fmtDate, monthGrid, parseYmd, today, WEEKDAYS } from "../lib/date";
import { MonthGrid, PeriodNav, usePeriod } from "../components/Period";
import { confirmDialog, Empty, Field, Modal, PageHeader, toast } from "../components/ui";
import { bookingAt, rangeText, runsOf, Slot, slotsOf, toHm, toMin, TtConfig, unitLabel, UNITS, useTimetableConfig } from "../lib/timetable";

/** A new booking (chosen slot runs of a day) or an existing one being edited. */
type Draft = { kind: "new"; date: string; runs: Slot[] } | { kind: "edit"; row: Row };

const endLabel = (t: string) => (t === "24:00" ? "자정" : t);

export default function Timetable() {
  const p = usePeriod("timetable", "day");
  const { config, save } = useTimetableConfig();
  const [setup, setSetup] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const grid = monthGrid(p.anchor);
  const [from, to] = p.mode === "month" ? [grid[0], grid[41]] : p.range;
  const { rows } = useRows("bookings", { filters: [{ col: "date", op: ">=", value: from }, { col: "date", op: "<=", value: to }], order: [["date", "asc"], ["start_time", "asc"]], limit: 5000 });
  const slots = useMemo(() => slotsOf(config), [config.unit, config.start, config.end]);
  const byDay = useMemo(() => {
    const m: Record<string, Row[]> = {};
    for (const r of rows) (m[r.date] ??= []).push(r);
    return m;
  }, [rows]);
  const freeCount = (d: string) => slots.filter((s) => !bookingAt(byDay[d] ?? [], s)).length;

  return (
    <div>
      <PageHeader
        title="타임테이블"
        icon="⏰"
        sub={`${unitLabel(config.unit)} 단위 · ${config.start} ~ ${endLabel(config.end)} · 하루 ${slots.length}타임`}
        actions={<button className="btn" onClick={() => setSetup(true)}>⚙ 설정</button>}
      />
      <PeriodNav p={p} />
      {p.mode === "day" && <DayView day={p.anchor} slots={slots} list={byDay[p.anchor] ?? []} onNew={(runs) => setDraft({ kind: "new", date: p.anchor, runs })} onOpen={(row) => setDraft({ kind: "edit", row })} />}
      {p.mode === "week" && <WeekGrid days={daysBetween(from, to)} slots={slots} byDay={byDay} onPick={p.openDay} />}
      {p.mode === "month" && (
        <>
          <MonthGrid
            anchor={p.anchor}
            onPick={p.openDay}
            render={(d) => {
              // A past day only matters for what was booked on it.
              if (!slots.length || (d < today() && !byDay[d]?.length)) return null;
              const free = freeCount(d);
              const used = slots.length - free;
              return free === 0 ? <span className="tt-day full">마감</span> : <span className={`tt-day ${used ? "some" : "open"}`}>빈 {free}타임</span>;
            }}
          />
          <div className="row small muted" style={{ marginTop: 8 }}>
            <span className="tt-day full">마감</span> 더 넣을 수 없는 날
            <span className="tt-day some">빈 N타임</span> 예약이 있고 빈 타임도 있는 날
            <span className="tt-day open">빈 N타임</span> 예약이 없는 날
          </div>
        </>
      )}
      {setup && <SetupModal config={config} onSave={save} onClose={() => setSetup(false)} />}
      {draft && <BookingModal draft={draft} onClose={() => setDraft(null)} />}
    </div>
  );
}

/** One day: every slot with its booking memo; free slots can be picked (several at once). */
function DayView({ day, slots, list, onNew, onOpen }: { day: string; slots: Slot[]; list: Row[]; onNew: (runs: Slot[]) => void; onOpen: (r: Row) => void }) {
  const [sel, setSel] = useState<number[]>([]);
  useEffect(() => setSel([]), [day]);
  // A slot that got booked meanwhile (another device, a sync) leaves the selection.
  useEffect(
    () =>
      setSel((v) =>
        v.filter((s) => {
          const slot = slots.find((x) => x.start === s);
          return !!slot && !bookingAt(list, slot);
        }),
      ),
    [list, slots],
  );
  const toggle = (s: number) => setSel((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  const free = slots.filter((s) => !bookingAt(list, s)).length;
  // Bookings no slot shows (the hours or the unit changed since): listed apart, never hidden.
  const outside = list.filter((b) => !slots.some((s) => bookingAt([b], s)));
  const runs = runsOf(sel, slots);
  if (!slots.length) return <Empty>설정에서 시작·종료 시각을 정해 주세요</Empty>;
  return (
    <div>
      <div className="row small muted" style={{ marginBottom: 8 }}>
        <span>예약 <b style={{ color: "var(--text)" }}>{slots.length - free}</b>타임</span>
        <span>· 빈 타임 <b style={{ color: "var(--ok)" }}>{free}</b></span>
        <span className="spacer" />
        <span className="faint">빈 타임을 눌러 여러 개 고른 뒤 예약을 추가하세요</span>
      </div>
      <div className="tt-day-list">
        {slots.map((s, i) => {
          const b = bookingAt(list, s);
          if (b) {
            const first = i === 0 || bookingAt(list, slots[i - 1])?.id !== b.id;
            return (
              <div key={s.start} className={`tt-row booked ${first ? "first" : "cont"}`} onClick={() => onOpen(b)}>
                <span className="tt-time">{toHm(s.start)}</span>
                <div className="tt-cell">
                  {first ? (
                    <>
                      <span className="tt-range">{b.start_time}~{endLabel(b.end_time)}</span>
                      <span className="tt-memo">{b.memo || <span className="faint">(메모 없음)</span>}</span>
                    </>
                  ) : (
                    <span className="faint small">〃</span>
                  )}
                </div>
              </div>
            );
          }
          const on = sel.includes(s.start);
          return (
            <div key={s.start} className={`tt-row free ${on ? "on" : ""}`} onClick={() => toggle(s.start)} role="checkbox" aria-checked={on}>
              <span className="tt-time">{toHm(s.start)}</span>
              <div className="tt-cell">
                <span className="tt-check">{on ? "✓" : ""}</span>
                <span className="faint small">비어 있음</span>
              </div>
            </div>
          );
        })}
      </div>
      {outside.length > 0 && (
        <div className="notice" style={{ marginTop: 10 }}>
          설정한 시간 밖의 예약
          {outside.map((b) => (
            <div key={b.id} className="click" style={{ padding: "4px 0" }} onClick={() => onOpen(b)}>
              <b>{b.start_time}~{endLabel(b.end_time)}</b> {b.memo}
            </div>
          ))}
        </div>
      )}
      {sel.length > 0 && (
        <div className="tt-bar">
          <span className="ellipsis grow">
            <b>{sel.length}타임</b> <span className="muted">{runs.map(rangeText).join(", ")}</span>
          </span>
          <button className="btn sm" onClick={() => setSel([])}>선택 해제</button>
          <button className="btn sm primary" onClick={() => onNew(runs)}>예약 추가</button>
        </div>
      )}
    </div>
  );
}

/** A week: booked and free slots only. */
function WeekGrid({ days, slots, byDay, onPick }: { days: string[]; slots: Slot[]; byDay: Record<string, Row[]>; onPick: (d: string) => void }) {
  const t = today();
  if (!slots.length) return <Empty>설정에서 시작·종료 시각을 정해 주세요</Empty>;
  return (
    <div className="tt-week-wrap">
      <table className="tt-week">
        <thead>
          <tr>
            <th />
            {days.map((d) => {
              const dd = parseYmd(d);
              const w = dd.getDay();
              return (
                <th key={d} className={`click ${d === t ? "today" : ""} ${w === 0 ? "sun" : w === 6 ? "sat" : ""}`} onClick={() => onPick(d)}>
                  {dd.getMonth() + 1}/{dd.getDate()} {WEEKDAYS[w]}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => (
            <tr key={s.start}>
              <td className="tt-time">{toHm(s.start)}</td>
              {days.map((d) => {
                const on = !!bookingAt(byDay[d] ?? [], s);
                return <td key={d} className={`tt-cellw ${on ? "on" : ""}`} title={`${fmtDate(d)} ${rangeText(s)} · ${on ? "예약" : "빈 타임"}`} onClick={() => onPick(d)} />;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row small muted" style={{ marginTop: 8 }}>
        <span className="tt-swatch on" /> 예약 <span className="tt-swatch" /> 빈 타임
      </div>
    </div>
  );
}

function SetupModal({ config, onSave, onClose }: { config: TtConfig; onSave: (c: TtConfig) => Promise<unknown>; onClose: () => void }) {
  const [unit, setUnit] = useState(config.unit);
  const [start, setStart] = useState(config.start);
  // A time input can't hold 24:00: midnight is shown (and picked) as 00:00.
  const [end, setEnd] = useState(config.end === "24:00" ? "00:00" : config.end);
  const endN = end === "00:00" ? "24:00" : end;
  const ok = !!start && !!end && toMin(start) < toMin(endN);
  const count = ok ? slotsOf({ unit, start, end: endN }).length : 0;
  const units = UNITS.includes(unit) ? UNITS : [...UNITS, unit].sort((a, b) => a - b);
  return (
    <Modal
      open
      onClose={onClose}
      title="타임테이블 설정"
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={!ok} onClick={async () => (await onSave({ unit, start, end: endN }), onClose())}>저장</button>
        </>
      }
    >
      <Field label="시간 단위" hint="한 타임의 길이입니다">
        <select value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
          {units.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}
        </select>
      </Field>
      <div className="grid2" style={{ gap: "0 14px" }}>
        <Field label="시작 시각">
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="종료 시각" hint="00:00이면 자정까지">
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <div className={ok ? "muted small" : "small"} style={ok ? undefined : { color: "var(--danger)" }}>
        {ok ? `매일 ${start} ~ ${endLabel(endN)}, ${unitLabel(unit)}씩 ${count}타임` : "종료 시각은 시작 시각보다 늦어야 합니다"}
      </div>
      <div className="faint small" style={{ marginTop: 6 }}>바꿔도 이미 넣은 예약은 그대로 남습니다.</div>
    </Modal>
  );
}

/** Overlap with another booking of that day (the list is read fresh, so other devices' bookings count). */
async function clash(date: string, ranges: Slot[], except?: number) {
  const others = (await db.list("bookings", { filters: [{ col: "date", op: "=", value: date }], limit: 1000 })).filter((b) => b.id !== except);
  return others.find((b) => ranges.some((r) => toMin(b.start_time) < r.end && toMin(b.end_time) > r.start));
}

function BookingModal({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const row = draft.kind === "edit" ? draft.row : null;
  const [memo, setMemo] = useState<string>(row?.memo ?? "");
  const [date, setDate] = useState<string>(row?.date ?? (draft.kind === "new" ? draft.date : today()));
  const [start, setStart] = useState<string>(row?.start_time ?? "");
  const [end, setEnd] = useState<string>(row?.end_time === "24:00" ? "00:00" : row?.end_time ?? "");
  const [busy, setBusy] = useState(false);
  const endN = end === "00:00" ? "24:00" : end;

  const save = async () => {
    setBusy(true);
    try {
      if (draft.kind === "new") {
        const hit = await clash(draft.date, draft.runs);
        if (hit) return toast(`${hit.start_time}~${endLabel(hit.end_time)}에 이미 예약이 있습니다`, "error");
        await db.bulk(draft.runs.map((r) => ({ table: "bookings" as const, row: { date: draft.date, start_time: toHm(r.start), end_time: toHm(r.end), memo } })));
      } else {
        if (!date || !start || !end || toMin(start) >= toMin(endN)) return toast("종료 시각은 시작 시각보다 늦어야 합니다", "error");
        const hit = await clash(date, [{ start: toMin(start), end: toMin(endN) }], row!.id);
        if (hit) return toast(`${hit.start_time}~${endLabel(hit.end_time)}에 이미 예약이 있습니다`, "error");
        await db.upsert("bookings", { id: row!.id, date, start_time: start, end_time: endN, memo });
      }
      onClose();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={draft.kind === "new" ? "예약 추가" : "예약"}
      footer={
        <>
          {row && (
            <button className="btn danger" onClick={async () => (await confirmDialog("이 예약을 삭제할까요?", true)) && (await db.remove("bookings", row.id), onClose())}>삭제</button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={busy} onClick={save}>{draft.kind === "new" ? "추가" : "저장"}</button>
        </>
      }
    >
      {draft.kind === "new" ? (
        <div className="notice" style={{ marginBottom: 12 }}>
          <b>{fmtDate(draft.date)}</b> · {draft.runs.map(rangeText).join(", ")}
          {draft.runs.length > 1 && <div className="faint small">떨어진 시간대는 같은 메모로 따로 저장됩니다</div>}
        </div>
      ) : (
        <div className="grid3" style={{ gap: "0 12px" }}>
          <Field label="날짜"><input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
          <Field label="시작"><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="종료"><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
      )}
      <Field label="메모">
        <textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="누구와 어떤 일을 하는지 (예: 김OO 학생 수학 과외)" autoFocus />
      </Field>
    </Modal>
  );
}
