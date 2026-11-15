import { useCallback, useEffect, useRef, useState } from "react";
import { db, onChange, Query, Row, Table } from "./api";
import { toast } from "../components/ui";

/** Rows of one table, reloaded whenever that table is written anywhere in the app. */
export function useRows<T extends Row = Row>(table: Table, query?: Query, extraTables: Table[] = []) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(query ?? {});
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await db.list<T>(table, query);
      if (my === seq.current) setRows(r);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, key]);
  useEffect(() => {
    reload();
    const watch = new Set<string>([table, ...extraTables, "*"]);
    return onChange((t) => watch.has(t) && reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  return { rows, setRows, loading, reload };
}

/** Any async loader that should rerun when the given tables change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], tables: Table[]) {
  const [data, setData] = useState<T | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await fn();
      if (my === seq.current) setData(d);
    } catch (e) {
      toast(String(e), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
    const watch = new Set<string>([...tables, "*"]);
    return onChange((t) => watch.has(t) && reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  return { data, reload };
}

export type OptionItem = Row & { set_key: string; label: string; color: string | null; sort: number; archived: number };

export function useOptions(setKey: string) {
  const { rows } = useRows<OptionItem>("option_items", {
    filters: [{ col: "set_key", op: "=", value: setKey }],
    order: [["sort", "asc"], ["id", "asc"]],
  });
  return rows;
}

/**
 * Local edit buffer that writes back after the user pauses typing.
 * Flushes on unmount so nothing typed is lost when navigating away.
 */
export function useAutosave<T>(value: T, save: (v: T) => Promise<unknown> | void, delay = 500) {
  const [draft, setDraft] = useState<T>(value);
  const dirty = useRef(false);
  const latest = useRef(draft);
  const saveRef = useRef(save);
  saveRef.current = save;
  const timer = useRef<number | undefined>(undefined);

  // Adopt external changes only when the user is not mid-edit.
  const ext = JSON.stringify(value);
  useEffect(() => {
    if (!dirty.current) {
      setDraft(value);
      latest.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (dirty.current) {
      dirty.current = false;
      Promise.resolve(saveRef.current(latest.current)).catch((e) => toast(String(e), "error"));
    }
  }, []);

  const update = useCallback(
    (v: T | ((p: T) => T)) => {
      setDraft((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        latest.current = next;
        return next;
      });
      dirty.current = true;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [delay, flush],
  );

  useEffect(() => () => flush(), [flush]);
  return [draft, update, flush] as const;
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [q]);
  return m;
}
