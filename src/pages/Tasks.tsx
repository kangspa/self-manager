import { FormEvent, useRef, useState } from "react";
import { db, Row } from "../lib/api";
import { useAutosave, useRows } from "../lib/hooks";
import { daysUntil } from "../lib/date";
import { Attachments } from "../components/Attachments";
import { AutoText, confirmDialog, Empty, PageHeader, SearchBox, Tabs, toast, useDebounced } from "../components/ui";

/** "11/22" from a created_at timestamp. */
const created = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear() !== new Date().getFullYear() ? `${String(d.getFullYear()).slice(2)}.` : ""}${d.getMonth() + 1}/${d.getDate()}`;
};

function Due({ due, done }: { due?: string | null; done: boolean }) {
  if (!due) return <span className="faint">-</span>;
  const n = daysUntil(due);
  const date = `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}`;
  const tail = done ? "" : n < 0 ? ` · ${-n}일 지남` : n === 0 ? " · 오늘" : n === 1 ? " · 내일" : "";
  return <span style={{ color: done ? undefined : n < 0 ? "var(--danger)" : n <= 1 ? "#d9822b" : undefined }}>{date}{tail}</span>;
}

/** Inline memo editor shown under a row when it is clicked. */
function TaskMemo({ task, focusTitle }: { task: Row; focusTitle?: boolean }) {
  const [d, setD] = useAutosave({ title: task.title ?? "", note: task.note ?? "" }, (v) => db.upsert("tasks", { id: task.id, ...v }));
  return (
    <div className="task-memo" onClick={(e) => e.stopPropagation()}>
      <input className="bare task-title-edit" value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} placeholder="할 일" autoFocus={focusTitle} />
      <AutoText value={d.note} onChange={(v) => setD((x) => ({ ...x, note: v }))} placeholder="메모를 적어 두세요" minRows={2} autoFocus={!focusTitle} />
      <div className="row">
        <label className="row small muted">
          마감일
          <input type="date" value={(task.due_at ?? "").slice(0, 10)} onChange={(e) => db.upsert("tasks", { id: task.id, due_at: e.target.value || null })} />
        </label>
        <span className="spacer" />
        <button className="btn sm danger" onClick={async () => (await confirmDialog("이 할 일을 삭제할까요?", true)) && db.remove("tasks", task.id)}>삭제</button>
      </div>
      <Attachments ownerTable="tasks" ownerId={task.id} />
    </div>
  );
}

export default function Tasks() {
  const [tab, setTab] = useState<"open" | "done" | "all">("open");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  // A task added with no title opens with its title field focused.
  const [freshId, setFreshId] = useState<number | null>(null);
  const search = useDebounced(q);
  const filters = tab === "open" ? [{ col: "done_at", op: "null" as const }] : tab === "done" ? [{ col: "done_at", op: "notnull" as const }] : [];
  const { rows } = useRows("tasks", { filters, search, order: [["done_at", "asc"], ["due_at", "asc"], ["id", "desc"]], limit: 2000 });
  // Dated tasks first (soonest due on top), then undated ones, newest first.
  const sorted = [...rows].sort((a, b) => {
    if (!!a.done_at !== !!b.done_at) return a.done_at ? 1 : -1;
    if (tab === "done") return (b.done_at ?? 0) - (a.done_at ?? 0);
    if (!!a.due_at !== !!b.due_at) return a.due_at ? -1 : 1;
    return (a.due_at ?? "").localeCompare(b.due_at ?? "") || b.id - a.id;
  });

  // Enter pressed while a Korean syllable is still being composed only ends the
  // composition; remember it and add once the composition is committed. Some
  // browsers then also send a plain Enter, so a second add right after one is
  // ignored. The input's own value is used: React state can lag behind the IME.
  const pendingEnter = useRef(false);
  const lastAdd = useRef(0);
  const titleRef = useRef(title);
  titleRef.current = title;
  // `blank`: the 추가 button with nothing typed makes an untitled task and
  // opens it, so the button always does something visible.
  const add = async (raw?: string, blank = false) => {
    const t = (raw ?? titleRef.current).trim();
    if ((!t && !blank) || Date.now() - lastAdd.current < 400) return;
    lastAdd.current = Date.now();
    setTitle("");
    titleRef.current = "";
    try {
      const row = await db.upsert("tasks", { title: t, due_at: due || null });
      // Make sure the new task is on screen: not filtered out by the 완료 tab or a search.
      if (tab === "done") setTab("open");
      if (q) setQ("");
      if (!t) {
        setOpenId(row.id);
        setFreshId(row.id);
      }
    } catch (e) {
      toast(`추가하지 못했습니다: ${e}`, "error");
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add(undefined, true);
  };

  return (
    <div>
      <PageHeader title="체크리스트" icon="✅" actions={<SearchBox value={q} onChange={setQ} />} />
      <form className="task-add" onSubmit={submit}>
        <input
          className="task-add-title"
          placeholder="할 일 추가"
          value={title}
          enterKeyHint="done"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (e.nativeEvent.isComposing) pendingEnter.current = true;
            else add(e.currentTarget.value);
          }}
          onCompositionEnd={(e) => {
            if (pendingEnter.current) {
              pendingEnter.current = false;
              add(e.currentTarget.value);
            }
          }}
        />
        <label className="task-add-due" title="마감일">
          <span className="small muted">마감일</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <button className="btn primary" type="submit">추가</button>
      </form>
      <Tabs value={tab} onChange={setTab} items={[["open", "진행 중"], ["done", "완료"], ["all", "전체"]]} />
      {sorted.length === 0 ? (
        <Empty>할 일이 없습니다</Empty>
      ) : (
        <div className="task-list">
          <div className="task-row task-head">
            <span>완료</span>
            <span>할 일</span>
            <span>생성일</span>
            <span>마감일</span>
          </div>
          {sorted.map((t) => {
            const done = !!t.done_at;
            const opened = openId === t.id;
            return (
              <div key={t.id} className={`task-item ${opened ? "open" : ""}`}>
                <div className="task-row click" onClick={() => setOpenId(opened ? null : t.id)}>
                  <input type="checkbox" checked={done} aria-label="완료" onClick={(e) => e.stopPropagation()} onChange={() => db.upsert("tasks", { id: t.id, done_at: done ? null : Date.now() })} />
                  <div className="task-main">
                    <span className={done ? "done-text" : ""}>{t.title || <span className="faint">제목 없음</span>}</span>
                    {t.note && !opened && <span className="faint small ellipsis task-note">📝 {t.note.split("\n")[0]}</span>}
                  </div>
                  <span className="task-date" data-label="생성">{created(t.created_at)}</span>
                  <span className="task-date" data-label="마감"><Due due={t.due_at} done={done} /></span>
                </div>
                {opened && <TaskMemo key={t.id} task={t} focusTitle={freshId === t.id} />}
              </div>
            );
          })}
        </div>
      )}
      {sorted.length > 0 && <div className="faint small" style={{ marginTop: 10 }}>할 일을 누르면 메모를 적을 수 있습니다.</div>}
    </div>
  );
}
