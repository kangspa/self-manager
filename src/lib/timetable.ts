import { db, Row } from "./api";
import { useRows } from "./hooks";

/** Timetable settings, saved in app_settings so every device of the profile agrees. */
export type TtConfig = { unit: number; start: string; end: string };

const KEY = "timetable";
export const TT_DEFAULT: TtConfig = { unit: 30, start: "09:00", end: "18:00" };
export const UNITS = [10, 15, 20, 30, 40, 60, 90, 120];

/** 'HH:MM' -> minutes of the day ('24:00' = 1440, the end of the day). */
export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
export const toHm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export const unitLabel = (u: number) => (u < 60 ? `${u}분` : u % 60 === 0 ? `${u / 60}시간` : `${Math.floor(u / 60)}시간 ${u % 60}분`);

function valid(c: Partial<TtConfig> | null): c is TtConfig {
  return !!c && typeof c.unit === "number" && c.unit >= 5 && c.unit <= 720 && /^\d\d:\d\d$/.test(c.start ?? "") && /^\d\d:\d\d$/.test(c.end ?? "") && toMin(c.start!) < toMin(c.end!);
}

export function useTimetableConfig() {
  const { rows, loading } = useRows("app_settings", { filters: [{ col: "key", op: "=", value: KEY }] });
  const row = rows[0];
  let config = TT_DEFAULT;
  try {
    const v = row?.value ? JSON.parse(row.value) : null;
    if (valid(v)) config = { unit: v.unit, start: v.start, end: v.end };
  } catch {
    /* a broken value falls back to the default */
  }
  const save = (c: TtConfig) => {
    const value = JSON.stringify(c);
    return db.upsert("app_settings", row ? { id: row.id, value } : { key: KEY, value });
  };
  return { config, save, loading, isValid: valid };
}

export type Slot = { start: number; end: number };

/** The day's slots from start to end; the last one is cut at the end time. */
export function slotsOf(c: TtConfig): Slot[] {
  const out: Slot[] = [];
  const end = toMin(c.end);
  for (let s = toMin(c.start); s < end && out.length < 500; s += c.unit) out.push({ start: s, end: Math.min(s + c.unit, end) });
  return out;
}

/** The booking holding (part of) a slot, if any. */
export const bookingAt = (list: Row[], s: Slot) => list.find((b) => toMin(b.start_time) < s.end && toMin(b.end_time) > s.start);

/** Selected slot starts -> back-to-back runs, one booking each. */
export function runsOf(starts: number[], slots: Slot[]): Slot[] {
  const picked = slots.filter((s) => starts.includes(s.start));
  const runs: Slot[] = [];
  for (const s of picked) {
    const last = runs[runs.length - 1];
    if (last && last.end === s.start) last.end = s.end;
    else runs.push({ ...s });
  }
  return runs;
}

export const rangeText = (r: Slot) => `${toHm(r.start)}~${toHm(r.end)}`;
