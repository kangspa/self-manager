import { useSyncExternalStore } from "react";
import { db } from "./api";
import { useRows } from "./hooks";
import { getWeekStart, subscribeWeekStart, WeekStart } from "./date";

/** The week start in effect; a component that calls this re-renders when it changes
 * (in place, so whatever is being typed on the page stays). */
export const useWeekStart = () => useSyncExternalStore(subscribeWeekStart, getWeekStart);

const KEY = "week_start";

/** The first day of the week saved in app_settings (synced across devices). null until loaded or never set. */
export function useWeekStartSetting() {
  const { rows, loading } = useRows("app_settings", { filters: [{ col: "key", op: "=", value: KEY }] });
  const row = rows[0];
  const saved: WeekStart | null = loading || !row ? null : row.value === "1" ? 1 : 0;
  const save = (v: WeekStart) => db.upsert("app_settings", row ? { id: row.id, value: String(v) } : { key: KEY, value: String(v) });
  return { saved, save };
}
