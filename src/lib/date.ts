const pad = (n: number) => String(n).padStart(2, "0");

export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const today = () => ymd(new Date());
export const nowLocal = () => `${ymd(new Date())}T${hm(new Date())}`;
export const nowSpace = () => `${ymd(new Date())} ${hm(new Date())}`;

export function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s: string, n: number) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function monthRange(d: Date) {
  const a = new Date(d.getFullYear(), d.getMonth(), 1);
  const b = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [ymd(a), ymd(b)] as const;
}

/** Monday-start week containing `s`. */
export function weekRange(s: string) {
  const d = parseYmd(s);
  const dow = (d.getDay() + 6) % 7;
  const a = addDays(s, -dow);
  return [a, addDays(a, 6)] as const;
}

/** ISO week key, e.g. 2026-W46. */
export function isoWeek(s: string) {
  const d = parseYmd(s);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(w)}`;
}

export const quarterKey = (s: string) => `${s.slice(0, 4)}-Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1}`;

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function fmtDate(s?: string | null) {
  if (!s) return "";
  const d = parseYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`;
}

export function fmtTs(ms?: number | null) {
  if (!ms) return "없음";
  const d = new Date(ms);
  return `${ymd(d)} ${hm(d)}:${pad(d.getSeconds())}`;
}

export function relTs(ms?: number | null) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "방금";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return ymd(new Date(ms));
}

export const won = (n?: number | null) => `${Math.round(n ?? 0).toLocaleString("ko-KR")}원`;

// ---- day / week / month views (shared by diary, calendar, work) ----
export type ViewMode = "day" | "week" | "month";
export const VIEW_LABEL: Record<ViewMode, string> = { day: "일", week: "주", month: "월" };

/** First and last day (inclusive) of the period containing `anchor`. Weeks start on Monday. */
export function periodRange(mode: ViewMode, anchor: string): readonly [string, string] {
  if (mode === "day") return [anchor, anchor] as const;
  if (mode === "week") return weekRange(anchor);
  return monthRange(parseYmd(anchor));
}

export function shiftPeriod(mode: ViewMode, anchor: string, n: number) {
  if (mode === "day") return addDays(anchor, n);
  if (mode === "week") return addDays(anchor, 7 * n);
  const d = parseYmd(anchor);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Keep the day when the target month has it (31 Jan + 1 month -> 28/29 Feb).
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return ymd(d);
}

export function periodLabel(mode: ViewMode, anchor: string) {
  const d = parseYmd(anchor);
  if (mode === "day") return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  if (mode === "month") return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  const [a, b] = weekRange(anchor);
  const pa = parseYmd(a), pb = parseYmd(b);
  return `${pa.getMonth() + 1}/${pa.getDate()} ~ ${pb.getMonth() + 1}/${pb.getDate()}`;
}

/** Every day from `a` to `b` inclusive. */
export function daysBetween(a: string, b: string) {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The 6-week (Monday-start) grid that shows the month of `anchor`. */
export function monthGrid(anchor: string) {
  const [first] = monthRange(parseYmd(anchor));
  const start = weekRange(first)[0];
  return daysBetween(start, addDays(start, 41));
}

/** Whether the date range [s, e] (e optional = single day) touches [a, b]. */
export const overlaps = (s: string, e: string | null | undefined, a: string, b: string) => s.slice(0, 10) <= b && (e || s).slice(0, 10) >= a;

/** Days from today to `s` (negative = past). */
export function daysUntil(s: string) {
  return Math.round((parseYmd(s).getTime() - parseYmd(today()).getTime()) / 86400000);
}
