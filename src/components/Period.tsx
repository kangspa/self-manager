import { ReactNode, useState } from "react";
import { monthGrid, parseYmd, periodLabel, periodRange, shiftPeriod, today, ViewMode, VIEW_LABEL } from "../lib/date";

/**
 * Day / week / month view state for a page. The chosen mode is remembered per
 * page; the date being viewed survives navigating away and back in a session.
 */
export function usePeriod(key: string, def: ViewMode = "day") {
  const read = (s: Storage, k: string) => {
    try {
      return s.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (s: Storage, k: string, v: string) => {
    try {
      s.setItem(k, v);
    } catch {
      /* storage unavailable: keep it in memory only */
    }
  };
  const [mode, setModeS] = useState<ViewMode>(() => {
    const m = read(localStorage, `view-${key}`);
    return m === "day" || m === "week" || m === "month" ? m : def;
  });
  const [anchor, setAnchorS] = useState(() => read(sessionStorage, `anchor-${key}`) || today());
  const setMode = (m: ViewMode) => {
    setModeS(m);
    write(localStorage, `view-${key}`, m);
  };
  const setAnchor = (a: string) => {
    setAnchorS(a);
    write(sessionStorage, `anchor-${key}`, a);
  };
  /** Open one day in day view (from a week/month cell). */
  const openDay = (d: string) => {
    setAnchor(d);
    setMode("day");
  };
  return { mode, setMode, anchor, setAnchor, openDay, range: periodRange(mode, anchor) };
}
export type Period = ReturnType<typeof usePeriod>;

export function PeriodNav({ p, extra }: { p: Period; extra?: ReactNode }) {
  return (
    <div className="period-nav">
      <div className="seg">
        {(["day", "week", "month"] as ViewMode[]).map((m) => (
          <button key={m} className={p.mode === m ? "on" : ""} onClick={() => p.setMode(m)}>
            {VIEW_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="row nowrap period-move">
        <button className="icon-btn" onClick={() => p.setAnchor(shiftPeriod(p.mode, p.anchor, -1))} aria-label="이전">‹</button>
        <b className="period-label">{periodLabel(p.mode, p.anchor)}</b>
        <button className="icon-btn" onClick={() => p.setAnchor(shiftPeriod(p.mode, p.anchor, 1))} aria-label="다음">›</button>
      </div>
      <button className="btn sm" onClick={() => p.setAnchor(today())} disabled={p.anchor === today()}>오늘</button>
      <input type="date" className="period-date" value={p.anchor} onChange={(e) => e.target.value && p.setAnchor(e.target.value)} aria-label="날짜 선택" />
      {extra && (
        <>
          <span className="spacer" />
          {extra}
        </>
      )}
    </div>
  );
}

export const WEEK_HEAD = ["월", "화", "수", "목", "금", "토", "일"];

const dayClass = (d: string) => {
  const w = parseYmd(d).getDay();
  return w === 0 ? "sun" : w === 6 ? "sat" : "";
};

/** Month calendar (Monday start, always 6 weeks so the height never jumps). */
export function MonthGrid({ anchor, selected, onPick, onDouble, render }: { anchor: string; selected?: string; onPick: (d: string) => void; onDouble?: (d: string) => void; render: (d: string) => ReactNode }) {
  const month = parseYmd(anchor).getMonth();
  const t = today();
  return (
    <div className="cal">
      {WEEK_HEAD.map((w, i) => <div key={w} className={`cal-h ${i === 6 ? "sun" : i === 5 ? "sat" : ""}`}>{w}</div>)}
      {monthGrid(anchor).map((d) => (
        <div key={d} className={`cal-d ${parseYmd(d).getMonth() !== month ? "other" : ""} ${d === t ? "today" : ""} ${d === selected ? "sel" : ""}`} onClick={() => onPick(d)} onDoubleClick={onDouble && (() => onDouble(d))}>
          <span className={`cal-n ${dayClass(d)}`}>{parseYmd(d).getDate()}</span>
          {render(d)}
        </div>
      ))}
    </div>
  );
}

/** Seven day columns (one column on phones); each day's content comes from `render`. */
export function WeekColumns({ days, onPick, render, action }: { days: string[]; onPick: (d: string) => void; render: (d: string) => ReactNode; action?: (d: string) => ReactNode }) {
  const t = today();
  return (
    <div className="week-cols">
      {days.map((d) => {
        const dd = parseYmd(d);
        return (
          <div key={d} className={`week-day ${d === t ? "today" : ""}`}>
            <div className="week-day-h">
              <button className={`link-btn ${dayClass(d)}`} onClick={() => onPick(d)}>{dd.getMonth() + 1}/{dd.getDate()} {WEEK_HEAD[(dd.getDay() + 6) % 7]}</button>
              {action?.(d)}
            </div>
            <div className="week-day-body">{render(d)}</div>
          </div>
        );
      })}
    </div>
  );
}
