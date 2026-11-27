import { useState } from "react";
import { richToMarkdown } from "../../lib/rich";
import { useNavigate } from "react-router-dom";
import { api, db, Row } from "../../lib/api";
import { useAutosave } from "../../lib/hooks";
import { fmtDate, today } from "../../lib/date";
import { Attachments } from "../../components/Attachments";
import { confirmDialog } from "../../components/ui";
import { RichText } from "../../components/RichText";
import { MEETING_STATUS, MeetingPanel } from "./MeetingDetail";

export type Kind = "phase" | "schedule" | "log";
export const KIND: Record<Kind, { icon: string; label: string }> = {
  phase: { icon: "📂", label: "세부 단계" },
  schedule: { icon: "🗓️", label: "업무 일정" },
  log: { icon: "📝", label: "업무 기록" },
};
export const STATUSES = ["예정", "진행", "완료", "보류"];
const STATUS_COLOR: Record<string, string> = { 예정: "#9b9b9b", 진행: "#4b8bf5", 완료: "#3bb273", 보류: "#f5a623" };

export const kindOf = (r: Row): Kind => (r.kind === "phase" || r.kind === "schedule" ? r.kind : "log");

/** Create a work item and return it. */
export function addItem(kind: Kind, fields: { project_id?: number | null; parent_id?: number | null; date?: string }) {
  return db.upsert("work_logs", {
    kind,
    title: "",
    date: fields.date ?? today(),
    project_id: fields.project_id ?? null,
    parent_id: fields.parent_id ?? null,
    status: kind === "log" ? null : "예정",
  });
}

/** Create an AI note attached to an item (or to a project when `item` is null). */
export async function addAiNote(owner: { item?: Row | null; projectId?: number | null; date?: string }) {
  const it = owner.item;
  return db.upsert("meetings", {
    title: `${it?.title ? `${it.title} ` : ""}AI 노트`,
    date: owner.date ?? (it?.date && it.date <= today() ? today() : it?.date) ?? today(),
    work_log_id: it?.id ?? null,
    project_id: owner.projectId ?? it?.project_id ?? null,
    status: "recorded",
  });
}

/**
 * Move an item to another project together with what it holds: a phase's
 * children follow it, and every AI note inside goes along. Done in one database
 * transaction, so nothing is left behind whatever the number of rows.
 */
const moveToProject = (item: Row, projectId: number | null) => api.workMove(item.id, projectId);

/** Change an item's kind. Only phases hold items, so a phase with children asks first (they move up). */
async function changeKind(item: Row, kind: Kind) {
  if (kindOf(item) === "phase" && kind !== "phase") {
    const n = (await db.list("work_logs", { filters: [{ col: "parent_id", op: "=", value: item.id }], limit: 5000 })).length;
    if (n && !(await confirmDialog(`이 단계 안의 항목 ${n}개는 단계 밖(프로젝트 바로 아래)으로 옮겨집니다. 바꿀까요?`))) return;
  }
  // The database keeps the tree two levels deep (a phase never has a parent).
  await db.upsert("work_logs", { id: item.id, kind, ...(kind === "log" ? { end_date: null } : {}), ...(kind === "phase" ? { parent_id: null } : {}) });
}

export function AddMenu({ label = "+ 추가", kinds, onPick }: { label?: string; kinds: (Kind | "ai")[]; onPick: (k: Kind | "ai") => void }) {
  const [open, setOpen] = useState(false);
  if (kinds.length === 1) return <button className="btn sm" onClick={() => onPick(kinds[0])}>{label}</button>;
  return (
    <span className="add-menu">
      <button className="btn sm" onClick={() => setOpen(!open)}>{label}</button>
      {open && (
        <>
          <span className="add-menu-back" onClick={() => setOpen(false)} />
          <span className="add-menu-pop">
            {kinds.map((k) => (
              <button key={k} onClick={() => { setOpen(false); onPick(k); }}>
                {k === "ai" ? "🎙️ AI 노트 (회의 녹음·요약)" : `${KIND[k].icon} ${KIND[k].label}`}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

/** One AI note block inside an item: collapsed preview, expands in place. */
export function AiNote({ m }: { m: Row }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const preview = richToMarkdown(m.summary_md).replace(/^#+\s.*$/gm, "").replace(/[-*]\s+(\[.\]\s+)?/g, "").split("\n").map((s: string) => s.trim()).filter(Boolean)[0];
  return (
    <div className={`ai-note ${open ? "open" : ""}`}>
      <div className="ai-note-head click" onClick={() => setOpen(!open)}>
        <span>🎙️</span>
        <b className="grow ellipsis">{m.title || "AI 노트"}</b>
        <span className="faint small">{fmtDate(m.date)}{m.duration_sec ? ` · ${Math.round(m.duration_sec / 60)}분` : ""}</span>
        <span className={`badge ${m.status === "done" ? "ok" : m.status === "error" ? "warn" : ""}`}>{MEETING_STATUS[m.status] ?? m.status}</span>
        <button className="icon-btn" title="전체 화면" onClick={(e) => { e.stopPropagation(); nav(`/work/meeting/${m.id}`); }}>⤢</button>
        <span className="faint">{open ? "▾" : "▸"}</span>
      </div>
      {!open && preview && <div className="faint small ellipsis ai-note-preview">{preview}</div>}
      {open && <MeetingPanel mid={m.id} embedded onDeleted={() => setOpen(false)} />}
    </div>
  );
}

function DateRange({ item, single }: { item: Row; single: boolean }) {
  const set = (k: "date" | "end_date", v: string) => {
    if (k === "date" && !v) return;
    const row: Record<string, unknown> = { id: item.id, [k]: v || null };
    // Keep the range in order.
    if (k === "date" && item.end_date && v > item.end_date) row.end_date = v;
    if (k === "end_date" && v && v < item.date) row.end_date = item.date;
    db.upsert("work_logs", row);
  };
  return (
    <span className="row nowrap date-range">
      <input type="date" value={item.date ?? ""} onChange={(e) => set("date", e.target.value)} aria-label="시작일" />
      {!single && (
        <>
          <span className="faint">~</span>
          <input type="date" value={item.end_date ?? ""} min={item.date} onChange={(e) => set("end_date", e.target.value)} aria-label="종료일" />
        </>
      )}
    </span>
  );
}

/**
 * A work item card. Phases list their children (and can add more inside);
 * every item can hold AI notes. `projects`/`phases` feed the move selects.
 */
export function WorkItem({ item, projects, phases, notes, children, showProject, openByDefault, nested }: {
  item: Row;
  projects: Row[];
  phases: Row[];
  notes: Row[];
  children?: Row[];
  showProject?: boolean;
  openByDefault?: boolean;
  /** Set on children: they never render children of their own (the tree is two levels). */
  nested?: boolean;
}) {
  const kind = kindOf(item);
  const [open, setOpen] = useState(!!openByDefault || !item.title);
  const [d, setD] = useAutosave({ title: item.title ?? "", body: item.body ?? "", tags: item.tags ?? "" }, (v) => db.upsert("work_logs", { id: item.id, ...v }));
  const projPhases = phases.filter((p) => p.project_id === item.project_id && p.id !== item.id);
  const project = projects.find((p) => p.id === item.project_id);
  const myNotes = notes.filter((n) => n.work_log_id === item.id);
  const kids = kind === "phase" && !nested ? (children ?? []).filter((c) => c.parent_id === item.id && c.id !== item.id && kindOf(c) !== "phase") : [];

  const pick = async (k: Kind | "ai") => {
    if (k === "ai") await addAiNote({ item });
    else await addItem(k, { project_id: item.project_id, parent_id: item.id, date: item.date });
    setOpen(true);
  };

  return (
    <div className={`work-item kind-${kind} ${open ? "open" : ""}`} style={{ ["--c" as any]: project?.color || "var(--line)" }}>
      <div className="work-item-head">
        <button className="icon-btn" onClick={() => setOpen(!open)} aria-label={open ? "접기" : "펼치기"}>{open ? "▾" : "▸"}</button>
        <span title={KIND[kind].label}>{KIND[kind].icon}</span>
        <input className="bare grow work-item-title" placeholder={`${KIND[kind].label} 제목`} value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} />
        {item.status && <span className="chip" style={{ ["--c" as any]: STATUS_COLOR[item.status] ?? "#9b9b9b" }}>{item.status}</span>}
        {!open && <span className="faint small nowrap">{fmtDate(item.date)}{item.end_date && item.end_date !== item.date ? ` ~ ${fmtDate(item.end_date)}` : ""}</span>}
        {!open && myNotes.length > 0 && <span className="faint small">🎙️{myNotes.length}</span>}
        {!open && kids.length > 0 && <span className="faint small">하위 {kids.length}</span>}
      </div>
      {open && (
        <div className="work-item-body">
          <div className="row work-item-meta">
            <DateRange item={item} single={kind === "log"} />
            {kind !== "log" && (
              <select value={item.status ?? ""} onChange={(e) => db.upsert("work_logs", { id: item.id, status: e.target.value || null })} style={{ width: 90 }}>
                <option value="">상태</option>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <select value={kind} onChange={(e) => changeKind(item, e.target.value as Kind)} style={{ width: 110 }} aria-label="종류">
              {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k].label}</option>)}
            </select>
            {showProject && (
              <select value={item.project_id ?? ""} onChange={(e) => moveToProject(item, e.target.value ? Number(e.target.value) : null)} style={{ width: 140 }} aria-label="프로젝트">
                <option value="">프로젝트 없음</option>
                {projects.filter((p) => !p.archived || p.id === item.project_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {kind !== "phase" && projPhases.length > 0 && (
              <select value={item.parent_id ?? ""} onChange={(e) => db.upsert("work_logs", { id: item.id, parent_id: e.target.value ? Number(e.target.value) : null })} style={{ width: 140 }} aria-label="단계">
                <option value="">단계 없음</option>
                {projPhases.map((p) => <option key={p.id} value={p.id}>📂 {p.title || "제목 없음"}</option>)}
              </select>
            )}
            <span className="spacer" />
            <button className="icon-btn" aria-label="삭제" onClick={async () => (await confirmDialog(kids.length || myNotes.length ? "이 항목을 삭제할까요? 안에 있던 항목과 AI 노트는 한 단계 위로 옮겨집니다." : "이 항목을 삭제할까요?", true)) && db.remove("work_logs", item.id)}>🗑</button>
          </div>
          <RichText value={d.body} onChange={(v) => setD((x) => ({ ...x, body: v }))} placeholder={kind === "phase" ? "이 단계의 목표, 범위…" : "한 일, 이슈, 다음 할 일…"} owner={{ table: "work_logs", id: item.id }} />
          <input className="bare small" style={{ width: "100%", color: "var(--text-soft)" }} placeholder="#태그 (쉼표로 구분)" value={d.tags} onChange={(e) => setD((x) => ({ ...x, tags: e.target.value }))} />
          {myNotes.map((m) => <AiNote key={m.id} m={m} />)}
          {kind === "phase" && (
            <div className="work-children">
              {kids.map((c) => <WorkItem key={c.id} item={c} projects={projects} phases={phases} notes={notes} nested />)}
            </div>
          )}
          <div className="row">
            <AddMenu kinds={kind === "phase" ? ["schedule", "log", "ai"] : ["ai"]} label={kind === "phase" ? "+ 이 단계에 추가" : "+ AI 노트"} onPick={pick} />
          </div>
          <Attachments ownerTable="work_logs" ownerId={item.id} />
        </div>
      )}
    </div>
  );
}
