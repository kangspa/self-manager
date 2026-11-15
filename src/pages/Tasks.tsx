import { useState } from "react";
import { db, Row } from "../lib/api";
import { useAutosave, useRows } from "../lib/hooks";
import { daysUntil, fmtTs, today } from "../lib/date";
import { Attachments } from "../components/Attachments";
import { AutoText, confirmDialog, Empty, Field, Modal, PageHeader, SearchBox, Tabs, useDebounced } from "../components/ui";

const PRIORITY = ["보통", "중요", "긴급"];

function dueLabel(due?: string | null) {
  if (!due) return null;
  const n = daysUntil(due);
  const time = due.length > 10 ? ` ${due.slice(11, 16)}` : "";
  const text = n < 0 ? `${-n}일 지남` : n === 0 ? `오늘${time}` : n === 1 ? `내일${time}` : `${due.slice(5, 10).replace("-", "/")}${time}`;
  return <span className="meta" style={{ color: n < 0 ? "var(--danger)" : n <= 1 ? "#d9822b" : undefined }}>{text}</span>;
}

function TaskEditor({ task, onClose }: { task: Row; onClose: () => void }) {
  const [d, setD, flush] = useAutosave({ title: task.title ?? "", note: task.note ?? "" }, (v) => db.upsert("tasks", { id: task.id, ...v }));
  const close = () => {
    flush();
    onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title="할 일"
      footer={
        <>
          <button className="btn danger" onClick={async () => (await confirmDialog("삭제할까요?", true)) && (await db.remove("tasks", task.id), onClose())}>삭제</button>
          <span className="spacer" />
          <button className="btn primary" onClick={close}>완료</button>
        </>
      }
    >
      <Field label="제목">
        <input value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} autoFocus />
      </Field>
      <div className="grid2" style={{ gap: 10 }}>
        <Field label="마감 기한">
          <input type="datetime-local" value={task.due_at ? (task.due_at.length === 10 ? `${task.due_at}T23:59` : task.due_at) : ""} onChange={(e) => db.upsert("tasks", { id: task.id, due_at: e.target.value || null })} />
        </Field>
        <Field label="중요도">
          <select value={task.priority ?? 0} onChange={(e) => db.upsert("tasks", { id: task.id, priority: Number(e.target.value) })}>
            {PRIORITY.map((p, i) => <option key={i} value={i}>{p}</option>)}
          </select>
        </Field>
      </div>
      <Field label="메모">
        <AutoText className="boxed" value={d.note} onChange={(v) => setD((x) => ({ ...x, note: v }))} placeholder="세부 내용" />
      </Field>
      <Attachments ownerTable="tasks" ownerId={task.id} />
      <div className="kv" style={{ marginTop: 12 }}>
        <span>만든 시각</span><span>{fmtTs(task.created_at)}</span>
        <span>상태</span><span>{task.done_at ? `완료 (${fmtTs(task.done_at)})` : "진행 중"}</span>
      </div>
    </Modal>
  );
}

export default function Tasks() {
  const [tab, setTab] = useState<"open" | "done" | "all">("open");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const search = useDebounced(q);
  const filters = tab === "open" ? [{ col: "done_at", op: "null" as const }] : tab === "done" ? [{ col: "done_at", op: "notnull" as const }] : [];
  const order: [string, "asc" | "desc"][] = tab === "done" ? [["done_at", "desc"]] : [["done_at", "asc"], ["priority", "desc"], ["due_at", "asc"], ["id", "desc"]];
  const { rows } = useRows("tasks", { filters, search, order, limit: 2000 });
  // Undated tasks after dated ones
  const sorted = tab === "done" ? rows : [...rows].sort((a, b) => (!!a.done_at === !!b.done_at ? (a.due_at ? 0 : 1) - (b.due_at ? 0 : 1) : 0));
  const open = rows.find((r) => r.id === openId);

  const add = async () => {
    if (!title.trim()) return;
    await db.upsert("tasks", { title: title.trim(), due_at: due || null });
    setTitle("");
    setDue("");
  };

  return (
    <div>
      <PageHeader title="체크리스트" icon="✅" actions={<SearchBox value={q} onChange={setQ} />} />
      <div className="quick-add">
        <input placeholder="할 일 추가 (Enter)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} title="마감일" style={{ flex: "0 0 auto" }} />
        <button className="btn primary" onClick={add}>추가</button>
      </div>
      <Tabs value={tab} onChange={setTab} items={[["open", "진행 중"], ["done", "완료"], ["all", "전체"]]} />
      {sorted.length === 0 ? (
        <Empty>할 일이 없습니다</Empty>
      ) : (
        <div className="list">
          {sorted.map((t) => (
            <div key={t.id} className="list-row click" onClick={() => setOpenId(t.id)}>
              <input type="checkbox" checked={!!t.done_at} onClick={(e) => e.stopPropagation()} onChange={() => db.upsert("tasks", { id: t.id, done_at: t.done_at ? null : Date.now() })} />
              <div className="grow">
                <div className={t.done_at ? "done-text" : ""}>
                  {t.priority > 0 && <span style={{ color: t.priority > 1 ? "var(--danger)" : "#d9822b", marginRight: 6 }}>{"!".repeat(t.priority)}</span>}
                  {t.title}
                </div>
                {t.note && <div className="faint small ellipsis">{t.note}</div>}
              </div>
              {!t.done_at && dueLabel(t.due_at)}
              <span className="meta" title="만든 날">{new Date(t.created_at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}</span>
            </div>
          ))}
        </div>
      )}
      {open && <TaskEditor key={open.id} task={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
