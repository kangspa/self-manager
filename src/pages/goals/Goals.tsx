import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { db, Row } from "../../lib/api";
import { OptionItem, useOptions, useRows } from "../../lib/hooks";
import { today } from "../../lib/date";
import { Chip, Empty, OptionChip, PageHeader, SearchBox, useDebounced } from "../../components/ui";

function period(g: Row) {
  if (!g.start_date && !g.end_date) return "";
  return `${g.start_date ?? "?"} ~ ${g.end_date ?? ""}`;
}

/** How far through its date range a goal is (for the portfolio bar). */
function timeProgress(g: Row) {
  if (!g.start_date || !g.end_date) return null;
  const a = new Date(g.start_date).getTime();
  const b = new Date(g.end_date).getTime();
  const n = new Date(today()).getTime();
  if (b <= a) return null;
  return Math.min(1, Math.max(0, (n - a) / (b - a)));
}

function GoalCard({ g, status, cat, onClick }: { g: Row; status: OptionItem[]; cat: OptionItem[]; onClick: () => void }) {
  const p = timeProgress(g);
  return (
    <div className="card click" onClick={onClick} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="row nowrap">
        <b className="ellipsis grow">{g.title || "제목 없음"}</b>
        <OptionChip options={status} id={g.status_id} />
      </div>
      {g.summary && <div className="muted small" style={{ whiteSpace: "pre-wrap" }}>{g.summary}</div>}
      <div className="row" style={{ marginTop: "auto" }}>
        <OptionChip options={cat} id={g.category_id} />
        <span className="faint small">{period(g)}</span>
      </div>
      {p !== null && (
        <div className="progress" title={`기간 경과 ${Math.round(p * 100)}%`}>
          <div style={{ width: `${p * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export default function Goals() {
  const nav = useNavigate();
  const status = useOptions("goal.status");
  const cat = useOptions("goal.category");
  const [view, setView] = useState<"board" | "category" | "list">("board");
  const [q, setQ] = useState("");
  const [fCat, setFCat] = useState<number | null>(null);
  const search = useDebounced(q);
  const { rows } = useRows("goals", { search, filters: fCat ? [{ col: "category_id", op: "=", value: fCat }] : [], order: [["sort", "asc"], ["start_date", "asc"], ["id", "desc"]] });

  const add = async (status_id?: number) => {
    const r = await db.upsert("goals", { title: "", status_id: status_id ?? status[0]?.id ?? null, start_date: today() });
    nav(`/goals/${r.id}`);
  };

  const groups: { key: string; label: string; color?: string | null; id?: number; items: Row[] }[] =
    view === "board"
      ? [...status.filter((s) => !s.archived).map((s) => ({ key: `s${s.id}`, label: s.label, color: s.color, id: s.id, items: rows.filter((g) => g.status_id === s.id) })), { key: "none", label: "상태 없음", items: rows.filter((g) => !status.some((s) => s.id === g.status_id)) }]
      : view === "category"
        ? [...cat.map((c) => ({ key: `c${c.id}`, label: c.label, color: c.color, items: rows.filter((g) => g.category_id === c.id) })), { key: "none", label: "카테고리 없음", items: rows.filter((g) => !cat.some((c) => c.id === g.category_id)) }]
        : [{ key: "all", label: "", items: rows }];

  return (
    <div>
      <PageHeader
        title="개인 목표"
        icon="🎯"
        actions={
          <>
            <SearchBox value={q} onChange={setQ} />
            <button className="btn primary" onClick={() => add()}>+ 새 목표</button>
          </>
        }
      />
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="seg">
          {([["board", "상태별"], ["category", "카테고리별"], ["list", "목록"]] as const).map(([k, l]) => (
            <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
        <Chip label="전체" color={fCat ? "#9b9b9b" : "#4b8bf5"} onClick={() => setFCat(null)} />
        {cat.map((c) => <Chip key={c.id} label={c.label} color={c.color} faded={fCat !== null && fCat !== c.id} onClick={() => setFCat(fCat === c.id ? null : c.id)} />)}
      </div>
      {rows.length === 0 && <Empty>이루고 싶은 목표를 기록하고, 분기·월·주 단위로 진행 상황을 남겨 보세요</Empty>}
      {view === "list" ? (
        <div className="list">
          {rows.map((g) => (
            <div key={g.id} className="list-row click" onClick={() => nav(`/goals/${g.id}`)}>
              <b className="grow ellipsis">{g.title || "제목 없음"}</b>
              <OptionChip options={cat} id={g.category_id} />
              <OptionChip options={status} id={g.status_id} />
              <span className="meta">{period(g)}</span>
            </div>
          ))}
        </div>
      ) : (
        groups.filter((gr) => gr.items.length || (view === "board" && gr.id)).map((gr) => (
          <div key={gr.key} className="section">
            <div className="section-title">
              <span className="row"><Chip label={gr.label} color={gr.color} /> <span className="faint small">{gr.items.length}</span></span>
              {view === "board" && gr.id && <button className="btn sm ghost" onClick={() => add(gr.id)}>+ 추가</button>}
            </div>
            <div className="grid3">
              {gr.items.map((g) => <GoalCard key={g.id} g={g} status={status} cat={cat} onClick={() => nav(`/goals/${g.id}`)} />)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
