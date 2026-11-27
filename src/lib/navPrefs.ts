import { db } from "./api";
import { useRows } from "./hooks";

const KEY = "hidden_nav";

/** Sidebar menus the user hid (paths), saved in app_settings so every device of the profile agrees. */
export function useHiddenNav() {
  const { rows } = useRows("app_settings", { filters: [{ col: "key", op: "=", value: KEY }] });
  const row = rows[0];
  let hidden: string[] = [];
  try {
    const v = row?.value ? JSON.parse(row.value) : [];
    if (Array.isArray(v)) hidden = v.filter((x) => typeof x === "string");
  } catch {
    /* a broken value shows every menu */
  }
  const save = (next: string[]) => {
    const value = JSON.stringify([...new Set(next)].sort());
    return db.upsert("app_settings", row ? { id: row.id, value } : { key: KEY, value });
  };
  return { hidden, save };
}
