import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { db, Row } from "../../lib/api";
import { useAutosave, useRows } from "../../lib/hooks";
import { addDays, fmtDate, parseYmd, today, WEEKDAYS } from "../../lib/date";
import { Attachments } from "../../components/Attachments";
import { AutoText, Chip, confirmDialog, Empty, Field, Modal, PageHeader, SearchBox, Tabs, useDebounced } from "../../components/ui";
import { COLORS } from "../Memos";

type Tab = "date" | "project" | "meetings";

export function WorkLogCard({ log, projects, showDate, showProject }: { log: Row; projects: Row[]; showDate?: boolean; showProject?: boolean }) {
  const [d, setD] = useAutosave({ title: log.title ?? "", body: log.body ?? "", tags: log.tags ?? "" }, (v) => db.upsert("work_logs", { id: log.id, ...v }));
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row nowrap">
        <input className="bare grow" style={{ fontWeight: 650, fontSize: 15 }} placeholder="제목" value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} />
        {showDate && <input type="date" value={log.date} onChange={(e) => e.target.value && db.upsert("work_logs", { id: log.id, date: e.target.value })} style={{ width: 140 }} />}
        {showProject !== false && (
          <select value={log.project_id ?? ""} onChange={(e) => db.upsert("work_logs", { id: log.id, project_id: e.target.value ? Number(e.target.value) : null })} style={{ width: 140 }}>
            <option value="">프로젝트 없음</option>
            {projects.filter((p) => !p.archived || p.id === log.project_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <button className="icon-btn" aria-label="삭제" onClick={async () => (await confirmDialog("이 업무 기록을 삭제할까요?", true)) && db.remove("work_logs", log.id)}>✕</button>
      </div>
      <AutoText value={d.body} onChange={(v) => setD((x) => ({ ...x, body: v }))} placeholder="한 일, 이슈, 다음 할 일…" minRows={2} />
      <input className="bare small" style={{ width: "100%", color: "var(--text-soft)" }} placeholder="#태그 (쉼표로 구분)" value={d.tags} onChange={(e) => setD((x) => ({ ...x, tags: e.target.value }))} />
      <Attachments ownerTable="work_logs" ownerId={log.id} />
    </div>
  );
}

function ByDate({ projects }: { projects: Row[] }) {
  const [date, setDate] = useState(today());
  const logs = useRows("work_logs", { filters: [{ col: "date", op: "=", value: date }], order: [["id", "asc"]] });
  const meetings = useRows("meetings", { filters: [{ col: "date", op: "=", value: date }], order: [["id", "asc"]] });
  const recent = useRows("work_logs", { order: [["date", "desc"]], limit: 400 });
  const nav = useNavigate();
  const days = [...new Set(recent.rows.map((r) => r.date))].slice(0, 30);
  const dd = parseYmd(date);
  return (
    <div className="split">
      <div>
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="icon-btn" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <b style={{ fontSize: 17 }}>{dd.getMonth() + 1}월 {dd.getDate()}일 ({WEEKDAYS[dd.getDay()]})</b>
          <button className="icon-btn" onClick={() => setDate(addDays(date, 1))}>›</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <span className="spacer" />
          <button className="btn primary" onClick={() => db.upsert("work_logs", { date, title: "" })}>+ 기록</button>
        </div>
        {logs.rows.length === 0 && meetings.rows.length === 0 && <Empty>이 날의 업무 기록이 없습니다</Empty>}
        {logs.rows.map((l) => <WorkLogCard key={l.id} log={l} projects={projects} />)}
        {meetings.rows.length > 0 && (
          <div className="section">
            <div className="section-title">이 날의 회의</div>
            {meetings.rows.map((m) => (
              <div key={m.id} className="list-row click" onClick={() => nav(`/work/meeting/${m.id}`)}>🎙️ <b className="grow">{m.title || "회의"}</b><span className="meta">{m.status}</span></div>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="section-title">최근 기록한 날</div>
        <div className="list">
          {days.map((d) => (
            <div key={d} className="list-row click" onClick={() => setDate(d)} style={{ background: d === date ? "var(--bg-hover)" : undefined }}>
              <span className="grow">{fmtDate(d)}</span>
              <span className="faint small">{recent.rows.filter((r) => r.date === d).length}건</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectModal({ p, onClose }: { p: Partial<Row>; onClose: () => void }) {
  const [d, setD] = useState<Partial<Row>>({ ...p });
  return (
    <Modal open onClose={onClose} title={p.id ? "프로젝트 설정" : "새 프로젝트"} footer={
      <>
        {p.id && <button className="btn danger" onClick={async () => { if (await confirmDialog("프로젝트를 삭제할까요? 업무 기록은 남고 프로젝트 연결만 해제됩니다.", true)) { await db.remove("projects", p.id!); onClose(); } }}>삭제</button>}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" onClick={async () => { const { created_at, updated_at, ...rest } = d; await db.upsert("projects", rest); onClose(); }}>저장</button>
      </>
    }>
      <Field label="이름"><input value={d.name ?? ""} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus /></Field>
      <Field label="설명"><AutoText className="boxed" value={d.description ?? ""} onChange={(v) => setD({ ...d, description: v })} minRows={3} /></Field>
      <Field label="상태"><input value={d.status ?? ""} onChange={(e) => setD({ ...d, status: e.target.value })} placeholder="예: 진행 중, 대기, 완료" /></Field>
      <Field label="색"><div className="colors">{COLORS.map((c) => <span key={c} className={`color-dot ${(d.color ?? "") === c ? "on" : ""}`} style={{ background: c || "var(--bg-hover)" }} onClick={() => setD({ ...d, color: c || null })} />)}</div></Field>
      <label className="row"><input type="checkbox" checked={!!d.archived} onChange={(e) => setD({ ...d, archived: e.target.checked ? 1 : 0 })} /> 보관 (목록에서 숨김)</label>
    </Modal>
  );
}

function ByProject({ projects }: { projects: Row[] }) {
  const [sel, setSel] = useState<number | null>(null);
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const nav = useNavigate();
  const cur = projects.find((p) => p.id === sel) ?? projects.find((p) => !p.archived);
  const logs = useRows("work_logs", { filters: cur ? [{ col: "project_id", op: "=", value: cur.id }] : [{ col: "id", op: "=", value: -1 }], order: [["date", "desc"], ["id", "desc"]], limit: 1000 });
  const meetings = useRows("meetings", { filters: cur ? [{ col: "project_id", op: "=", value: cur.id }] : [{ col: "id", op: "=", value: -1 }], order: [["date", "desc"]] });
  const visible = projects.filter((p) => showArchived || !p.archived);
  return (
    <div className="split" style={{ gridTemplateColumns: "220px minmax(0, 1fr)" }}>
      <div>
        <div className="section-title">프로젝트 <button className="btn sm" onClick={() => setEdit({})}>+ 새로</button></div>
        <div className="list">
          {visible.map((p) => (
            <div key={p.id} className="list-row click" onClick={() => setSel(p.id)} style={{ background: cur?.id === p.id ? "var(--bg-hover)" : undefined, opacity: p.archived ? 0.5 : 1 }}>
              <span className="dot" style={{ ["--c" as any]: p.color || "#9b9b9b" }} />
              <span className="grow ellipsis">{p.name}</span>
            </div>
          ))}
        </div>
        <label className="row small muted" style={{ marginTop: 8 }}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관된 프로젝트 보기</label>
      </div>
      <div>
        {!cur ? (
          <Empty>프로젝트를 만들어 업무 기록을 묶어 보세요</Empty>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 20 }}>{cur.name}</h2>
              {cur.status && <Chip label={cur.status} color={cur.color} />}
              <span className="spacer" />
              <button className="btn sm" onClick={() => setEdit(cur)}>설정</button>
              <button className="btn primary sm" onClick={() => db.upsert("work_logs", { date: today(), project_id: cur.id, title: "" })}>+ 오늘 기록</button>
            </div>
            {cur.description && <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{cur.description}</p>}
            {meetings.rows.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {meetings.rows.map((m) => <div key={m.id} className="list-row click" onClick={() => nav(`/work/meeting/${m.id}`)}>🎙️ <span className="grow">{m.title || "회의"}</span><span className="meta">{fmtDate(m.date)}</span></div>)}
              </div>
            )}
            {logs.rows.length === 0 && <Empty>기록 없음</Empty>}
            {logs.rows.map((l) => <WorkLogCard key={l.id} log={l} projects={projects} showDate showProject={false} />)}
          </>
        )}
      </div>
      {edit && <ProjectModal p={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function Meetings({ projects }: { projects: Row[] }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const search = useDebounced(q);
  const { rows } = useRows("meetings", { search, order: [["date", "desc"], ["id", "desc"]], limit: 500 });
  const STATUS: Record<string, string> = { recording: "녹음 중", importing: "가져오는 중", recorded: "녹음됨", transcribing: "전사 중", transcribed: "전사 완료", summarizing: "요약 중", done: "정리 완료", error: "오류" };
  const create = async () => {
    const r = await db.upsert("meetings", { title: `${fmtDate(today())} 회의`, date: today(), status: "recorded" });
    nav(`/work/meeting/${r.id}`);
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <SearchBox value={q} onChange={setQ} placeholder="회의 검색" />
        <span className="spacer" />
        <button className="btn primary" onClick={create}>🎙️ 새 회의 녹음</button>
      </div>
      {rows.length === 0 && <Empty>회의를 녹음하거나 음성 파일을 가져오면 자동으로 받아 적고 요약합니다</Empty>}
      <div className="list">
        {rows.map((m) => (
          <div key={m.id} className="list-row click" onClick={() => nav(`/work/meeting/${m.id}`)}>
            <div className="grow">
              <b>{m.title || "회의"}</b>
              <div className="faint small">{fmtDate(m.date)}{m.duration_sec ? ` · ${Math.round(m.duration_sec / 60)}분` : ""}{m.project_id ? ` · ${projects.find((p) => p.id === m.project_id)?.name ?? ""}` : ""}</div>
            </div>
            <span className={`badge ${m.status === "done" ? "ok" : m.status === "error" ? "warn" : ""}`}>{STATUS[m.status] ?? m.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Work() {
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem("work-tab") as Tab) || "date");
  const projects = useRows("projects", { order: [["archived", "asc"], ["sort", "asc"], ["id", "asc"]] });
  const change = (t: Tab) => {
    setTab(t);
    sessionStorage.setItem("work-tab", t);
  };
  return (
    <div>
      <PageHeader title="업무 관리" icon="💼" />
      <Tabs<Tab> value={tab} onChange={change} items={[["date", "일자별"], ["project", "프로젝트별"], ["meetings", "회의록"]]} />
      {tab === "date" && <ByDate projects={projects.rows} />}
      {tab === "project" && <ByProject projects={projects.rows} />}
      {tab === "meetings" && <Meetings projects={projects.rows} />}
    </div>
  );
}
