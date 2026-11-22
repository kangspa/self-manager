import { useState } from "react";
import { db, Row } from "../../lib/api";
import { useRows } from "../../lib/hooks";
import { addDays, daysBetween, fmtDate, monthGrid, overlaps, parseYmd, today } from "../../lib/date";
import { AutoText, Chip, confirmDialog, Empty, Field, Modal, PageHeader, SearchBox, Tabs, useDebounced } from "../../components/ui";
import { MonthGrid, PeriodNav, usePeriod, WeekColumns } from "../../components/Period";
import { COLORS } from "../Memos";
import { addAiNote, addItem, AddMenu, AiNote, Kind, KIND, kindOf, STATUSES, WorkItem } from "./WorkItem";

type View = "project" | "date";

function ProjectModal({ p, onClose }: { p: Partial<Row>; onClose: () => void }) {
  const [d, setD] = useState<Partial<Row>>({ ...p });
  return (
    <Modal open onClose={onClose} title={p.id ? "프로젝트 설정" : "새 프로젝트"} footer={
      <>
        {p.id && <button className="btn danger" onClick={async () => { if (await confirmDialog("프로젝트를 삭제할까요? 안의 업무와 AI 노트는 남고 프로젝트 연결만 해제됩니다.", true)) { await db.remove("projects", p.id!); onClose(); } }}>삭제</button>}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" onClick={async () => { const { created_at, updated_at, ...rest } = d; await db.upsert("projects", { ...rest, name: (rest.name ?? "").trim() || "새 프로젝트" }); onClose(); }}>저장</button>
      </>
    }>
      <Field label="이름"><input value={d.name ?? ""} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus /></Field>
      <div className="grid2" style={{ gap: "0 12px" }}>
        <Field label="전체 일정 시작"><input type="date" value={d.start_date ?? ""} onChange={(e) => setD({ ...d, start_date: e.target.value || null })} /></Field>
        <Field label="전체 일정 종료"><input type="date" value={d.end_date ?? ""} min={d.start_date ?? undefined} onChange={(e) => setD({ ...d, end_date: e.target.value || null })} /></Field>
      </div>
      <Field label="상태">
        <select value={d.status ?? ""} onChange={(e) => setD({ ...d, status: e.target.value || null })}>
          <option value="">지정 안 함</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="설명"><AutoText className="boxed" value={d.description ?? ""} onChange={(v) => setD({ ...d, description: v })} minRows={3} /></Field>
      <Field label="색"><div className="colors">{COLORS.map((c) => <span key={c} className={`color-dot ${(d.color ?? "") === c ? "on" : ""}`} style={{ background: c || "var(--bg-hover)" }} onClick={() => setD({ ...d, color: c || null })} />)}</div></Field>
      <label className="row"><input type="checkbox" checked={!!d.archived} onChange={(e) => setD({ ...d, archived: e.target.checked ? 1 : 0 })} /> 보관 (목록에서 숨김)</label>
    </Modal>
  );
}

/** Bars of the project's phases and schedules over the project's whole period. */
function Timeline({ project, items }: { project: Row; items: Row[] }) {
  const dated = items.filter((i) => kindOf(i) !== "log");
  const starts = [project.start_date, ...dated.map((i) => i.date)].filter(Boolean) as string[];
  const ends = [project.end_date, ...dated.map((i) => i.end_date || i.date)].filter(Boolean) as string[];
  if (!dated.length || !starts.length) return null;
  const a = project.start_date || starts.sort()[0];
  const b = project.end_date || ends.sort().slice(-1)[0];
  const span = Math.max(1, (parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000 + 1);
  const pos = (s: string) => Math.min(100, Math.max(0, ((parseYmd(s).getTime() - parseYmd(a).getTime()) / 86400000 / span) * 100));
  const t = today();
  return (
    <div className="timeline">
      <div className="timeline-scale faint small"><span>{fmtDate(a)}</span><span>{fmtDate(b)}</span></div>
      {dated.map((i) => (
        <div key={i.id} className="timeline-row">
          <span className="timeline-name ellipsis">{KIND[kindOf(i)].icon} {i.title || "제목 없음"}</span>
          <span className="timeline-track">
            <span className={`timeline-bar ${i.status === "완료" ? "done" : ""}`} style={{ left: `${pos(i.date)}%`, width: `${Math.max(1.5, pos(addDays(i.end_date || i.date, 1)) - pos(i.date))}%` }} />
            {t >= a && t <= b && <span className="timeline-today" style={{ left: `${pos(t)}%` }} />}
          </span>
        </div>
      ))}
    </div>
  );
}

const NONE = [{ col: "id", op: "=" as const, value: -1 }];
const ORDER: [string, "asc" | "desc"][] = [["date", "asc"], ["sort", "asc"], ["id", "asc"]];
const uniq = (...lists: Row[][]) => [...new Map(lists.flat().map((r) => [r.id, r])).values()];
// The database returns at most LIMIT rows per query; one row fewer is shown,
// so "more exist" is known for sure whenever something is left out.
const LIMIT = 5000;
const SHOW = LIMIT - 1;
// The same order in SQL and on screen (date, then manual sort, then id), so
// the rows cut by the database are exactly the ones the screen would drop.
const NEWEST: [string, "asc" | "desc"][] = [["date", "desc"], ["sort", "desc"], ["id", "desc"]];
const byDateAsc = (a: Row, b: Row) => (a.date ?? "").localeCompare(b.date ?? "") || (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id;
/** The newest SHOW rows (in display order) and whether any were left out. */
function newest(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => byDateAsc(b, a));
  return { rows: sorted.slice(0, SHOW).sort(byDateAsc), capped: sorted.length > SHOW };
}
const Capped = ({ on }: { on: boolean }) => (on ? <div className="notice" style={{ marginBottom: 10 }}>항목이 많아 최근 {SHOW.toLocaleString()}개만 보여 줍니다. 검색이나 기간으로 좁혀 보세요.</div> : null);

/** AI notes inside the given items, plus `extra` ones (loaded by the DB, not filtered in memory). */
function useNotes(items: Row[], extra: Row[]) {
  const ids = items.map((i) => i.id);
  const linked = useRows("meetings", { filters: ids.length ? [{ col: "work_log_id", op: "in", value: ids }] : NONE, order: [["date", "asc"], ["id", "asc"]], limit: 5000 });
  return uniq(linked.rows, extra);
}

function ByProject({ projects }: { projects: Row[] }) {
  const [sel, setSel] = useState<number | null>(() => Number(sessionStorage.getItem("work-project")) || null);
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const cur = projects.find((p) => p.id === sel) ?? projects.find((p) => !p.archived);
  const visible = projects.filter((p) => showArchived || !p.archived || p.id === cur?.id);
  const choose = (id: number) => {
    setSel(id);
    sessionStorage.setItem("work-project", String(id));
  };
  // Only this project's rows are read from the database.
  // Newest first from the database, so a very large project keeps its recent work.
  const mineRows = useRows("work_logs", { filters: cur ? [{ col: "project_id", op: "=", value: cur.id }] : NONE, order: NEWEST, limit: LIMIT }).rows;
  const { rows: mine, capped } = newest(mineRows);
  const byProject = useRows("meetings", { filters: cur ? [{ col: "project_id", op: "=", value: cur.id }] : NONE, order: [["date", "asc"], ["id", "asc"]], limit: 5000 }).rows;
  const notes = useNotes(mine, byProject);
  const ids = new Set(mine.map((i) => i.id));
  const phases = mine.filter((i) => kindOf(i) === "phase");
  const phaseIds = new Set(phases.map((i) => i.id));
  const loose = mine.filter((i) => kindOf(i) !== "phase" && !(i.parent_id && phaseIds.has(i.parent_id)));
  // Project-level notes: not inside any item of this project.
  const projectNotes = notes.filter((n) => n.project_id === cur?.id && !(n.work_log_id && ids.has(n.work_log_id)));

  const pick = async (k: Kind | "ai") => {
    if (!cur) return;
    if (k === "ai") await addAiNote({ projectId: cur.id });
    else await addItem(k, { project_id: cur.id, date: k === "phase" && cur.start_date && cur.start_date > today() ? cur.start_date : today() });
  };

  return (
    <div className="split split-left">
      <div>
        <div className="section-title">프로젝트 <button className="btn sm" onClick={() => setEdit({})}>+ 새로</button></div>
        <div className="list">
          {visible.map((p) => (
            <div key={p.id} className="list-row click" onClick={() => choose(p.id)} style={{ background: cur?.id === p.id ? "var(--bg-hover)" : undefined, opacity: p.archived ? 0.5 : 1 }}>
              <span className="dot" style={{ ["--c" as any]: p.color || "#9b9b9b" }} />
              <span className="grow ellipsis">{p.name}</span>
              {p.status && <span className="faint small">{p.status}</span>}
            </div>
          ))}
        </div>
        <label className="row small muted" style={{ marginTop: 8 }}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관된 프로젝트 보기</label>
      </div>
      <div>
        {!cur ? (
          <Empty>프로젝트를 만들고, 그 안에 세부 단계·업무 일정·업무 기록·AI 노트를 추가해 보세요</Empty>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="dot" style={{ ["--c" as any]: cur.color || "#9b9b9b", width: 12, height: 12 }} />
              <h2 style={{ fontSize: 20 }}>{cur.name}</h2>
              {cur.status && <Chip label={cur.status} color={cur.color} />}
              <span className="spacer" />
              <button className="btn sm" onClick={() => setEdit(cur)}>설정</button>
              <AddMenu kinds={["phase", "schedule", "log", "ai"]} onPick={pick} />
            </div>
            <div className="row small muted" style={{ marginBottom: 8 }}>
              전체 일정
              <input type="date" value={cur.start_date ?? ""} onChange={(e) => db.upsert("projects", { id: cur.id, start_date: e.target.value || null })} />
              ~
              <input type="date" value={cur.end_date ?? ""} min={cur.start_date ?? undefined} onChange={(e) => db.upsert("projects", { id: cur.id, end_date: e.target.value || null })} />
            </div>
            {cur.description && <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{cur.description}</p>}
            <Capped on={capped} />
            <Timeline project={cur} items={mine} />
            {projectNotes.map((m) => <AiNote key={m.id} m={m} />)}
            {mine.length === 0 && projectNotes.length === 0 && <Empty>‘+ 추가’로 세부 단계(분기), 업무 일정, 업무 기록, AI 노트를 만들 수 있습니다</Empty>}
            {phases.map((ph) => <WorkItem key={ph.id} item={ph} projects={projects} phases={phases} notes={notes} children={mine} />)}
            {loose.length > 0 && phases.length > 0 && <div className="section-title" style={{ marginTop: 18 }}>단계 밖의 업무</div>}
            {loose.map((i) => <WorkItem key={i.id} item={i} projects={projects} phases={phases} notes={notes} />)}
          </>
        )}
      </div>
      {edit && <ProjectModal p={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Every phase (for the "단계" selects); phases are few compared with items. */
function usePhases() {
  return useRows("work_logs", { filters: [{ col: "kind", op: "=", value: "phase" }], order: ORDER, limit: 5000 }).rows;
}

function ByDate({ projects }: { projects: Row[] }) {
  const p = usePeriod("work", "day");
  const [from, to] = p.mode === "month" ? [monthGrid(p.anchor)[0], monthGrid(p.anchor)[41]] : p.range;
  // Rows of this period only: starting in it, or starting earlier and still running.
  const starting = useRows("work_logs", { filters: [{ col: "date", op: ">=", value: from }, { col: "date", op: "<=", value: to }], order: NEWEST, limit: LIMIT }).rows;
  const running = useRows("work_logs", { filters: [{ col: "date", op: "<", value: from }, { col: "end_date", op: ">=", value: from }], order: NEWEST, limit: LIMIT }).rows;
  // One cap for the whole period: the newest SHOW rows of both queries together.
  const { rows: items, capped } = newest(uniq(starting, running));
  const dated = useRows("meetings", { filters: [{ col: "date", op: ">=", value: from }, { col: "date", op: "<=", value: to }], order: [["date", "asc"], ["id", "asc"]], limit: 5000 }).rows;
  const notes = useNotes(items, dated);
  const allPhases = usePhases();
  const projOf = (i: Row) => projects.find((x) => x.id === i.project_id);
  // Phases are periods: listed once for the range rather than on every day.
  const phasesNow = items.filter((i) => kindOf(i) === "phase");
  const work = items.filter((i) => kindOf(i) !== "phase");
  const onDay = (d: string) => work.filter((i) => overlaps(i.date, i.end_date, d, d));
  const notesOn = (d: string) => notes.filter((n) => n.date === d);
  const chip = (i: Row) => (
    <div key={i.id} className="cal-ev click" style={{ ["--c" as any]: projOf(i)?.color || undefined, whiteSpace: "normal" }} onClick={() => p.openDay(i.date < from ? from : i.date)}>
      {KIND[kindOf(i)].icon} {i.title || "제목 없음"}{projOf(i) ? <span className="faint"> · {projOf(i)!.name}</span> : null}
    </div>
  );
  const day = p.anchor;
  const shownIds = new Set(onDay(day).map((i) => i.id));
  const looseNotes = notesOn(day).filter((n) => !(n.work_log_id && shownIds.has(n.work_log_id)));

  return (
    <div>
      <PeriodNav
        p={p}
        extra={p.mode === "day" && <AddMenu kinds={["log", "schedule", "ai"]} onPick={async (k) => (k === "ai" ? addAiNote({ date: day }) : addItem(k, { date: day }))} />}
      />
      <Capped on={capped} />
      {phasesNow.length > 0 && (
        <div className="phase-strip">
          {phasesNow.map((ph) => (
            <span key={ph.id} className="chip" style={{ ["--c" as any]: projOf(ph)?.color || "#9b9b9b" }} title={`${fmtDate(ph.date)} ~ ${fmtDate(ph.end_date)}`}>
              📂 {projOf(ph)?.name ? `${projOf(ph)!.name} › ` : ""}{ph.title || "단계"}{ph.status ? ` · ${ph.status}` : ""}
            </span>
          ))}
        </div>
      )}
      {p.mode === "day" && (
        <>
          {onDay(day).length === 0 && looseNotes.length === 0 && <Empty>이 날의 업무가 없습니다. ‘+ 추가’로 기록이나 일정을 만들어 보세요</Empty>}
          {onDay(day).map((i) => <WorkItem key={i.id} item={i} projects={projects} phases={allPhases} notes={notes} showProject />)}
          {looseNotes.map((m) => <AiNote key={m.id} m={m} />)}
        </>
      )}
      {p.mode === "week" && (
        <WeekColumns
          days={daysBetween(from, to)}
          onPick={p.openDay}
          render={(d) => (
            <>
              {onDay(d).map(chip)}
              {notesOn(d).map((n) => <div key={`m${n.id}`} className="cal-ev click" onClick={() => p.openDay(d)}>🎙️ {n.title || "AI 노트"}</div>)}
            </>
          )}
        />
      )}
      {p.mode === "month" && (
        <MonthGrid
          anchor={p.anchor}
          onPick={p.openDay}
          render={(d) => {
            const list = onDay(d);
            const n = notesOn(d).length;
            return (
              <>
                {list.slice(0, 3).map((i) => <div key={i.id} className="cal-ev" style={{ ["--c" as any]: projOf(i)?.color || undefined }}>{KIND[kindOf(i)].icon} {i.title || "제목 없음"}</div>)}
                {list.length > 3 && <span className="cal-more">+{list.length - 3}</span>}
                {n > 0 && <span className="cal-more">🎙️ {n}</span>}
              </>
            );
          }}
        />
      )}
    </div>
  );
}

/** Searched in the database (title, body, tags / note title, summary), newest first. */
function SearchResults({ q, projects }: { q: string; projects: Row[] }) {
  const found = useRows("work_logs", { search: q, order: [["date", "desc"], ["id", "desc"]], limit: 300 }).rows;
  const foundNotes = useRows("meetings", { search: q, order: [["date", "desc"], ["id", "desc"]], limit: 300 }).rows;
  const notes = useNotes(found, []);
  const allPhases = usePhases();
  if (!found.length && !foundNotes.length) return <Empty>찾는 업무가 없습니다</Empty>;
  return (
    <>
      {found.map((i) => <WorkItem key={i.id} item={i} projects={projects} phases={allPhases} notes={notes} showProject />)}
      {foundNotes.map((m) => <AiNote key={m.id} m={m} />)}
    </>
  );
}

export default function Work() {
  const [view, setView] = useState<View>(() => (localStorage.getItem("work-view") as View) || "project");
  const [q, setQ] = useState("");
  const search = useDebounced(q).trim();
  // One table holds every kind of work; each view asks the database only for
  // the rows it shows (a project, a period, or a search).
  const projects = useRows("projects", { order: [["archived", "asc"], ["sort", "asc"], ["id", "asc"]] });
  const change = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("work-view", v);
    } catch {
      /* not persisted */
    }
  };
  return (
    <div>
      <PageHeader title="업무 관리" icon="💼" actions={<SearchBox value={q} onChange={setQ} placeholder="업무·AI 노트 검색" />} />
      <Tabs<View> value={view} onChange={change} items={[["project", "프로젝트별"], ["date", "날짜별"]]} />
      {search ? <SearchResults q={search} projects={projects.rows} /> : view === "project" ? <ByProject projects={projects.rows} /> : <ByDate projects={projects.rows} />}
    </div>
  );
}
