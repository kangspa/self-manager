import { richPlain } from "../../lib/rich";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db, Row } from "../../lib/api";
import { useAutosave, useLoad, useOptions, useRows } from "../../lib/hooks";
import { addDays, isoWeek, parseYmd, quarterKey, today, weekRange, ym, ymd } from "../../lib/date";
import { LooseFiles } from "../../components/Attachments";
import { confirmDialog, Empty, Field, OptionSelect, Tabs } from "../../components/ui";
import { RichText } from "../../components/RichText";

type PT = "quarter" | "month" | "week";

const TEMPLATES: Record<PT, string> = {
  quarter: "### 이번 분기 목표\n- \n\n### 핵심 결과\n- \n\n### 회고\n- 잘한 점: \n- 아쉬운 점: \n",
  month: "### 이번 달 할 일\n- \n\n### 진행 상황\n- \n\n### 다음 달로 넘길 것\n- \n",
  week: "### 이번 주 할 일\n- \n\n### 한 일\n- \n\n### 메모\n- \n",
};

/** Every period key between start and end (default: current year), newest first. */
function periodKeys(type: PT, start?: string | null, end?: string | null): { key: string; label: string }[] {
  const a = start || `${today().slice(0, 4)}-01-01`;
  const b = end && end > a ? end : `${(start ?? today()).slice(0, 4)}-12-31`;
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  if (type === "week") {
    let d = weekRange(a, 1)[0];
    while (d <= b && out.length < 260) {
      const k = isoWeek(d);
      if (!seen.has(k)) {
        seen.add(k);
        const [s, e] = weekRange(d, 1);
        out.push({ key: k, label: `${k.slice(5)} · ${s.slice(5).replace("-", "/")}~${e.slice(5).replace("-", "/")}` });
      }
      d = addDays(d, 7);
    }
  } else {
    const d = parseYmd(a);
    d.setDate(1);
    while (ymd(d) <= b && out.length < 120) {
      const s = ymd(d);
      const k = type === "month" ? ym(d) : quarterKey(s);
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ key: k, label: type === "month" ? `${d.getFullYear()}년 ${d.getMonth() + 1}월` : `${k.slice(0, 4)}년 ${k.slice(6)}분기` });
      }
      d.setMonth(d.getMonth() + 1);
    }
  }
  return out.reverse();
}

function currentKey(type: PT) {
  const t = today();
  return type === "week" ? isoWeek(t) : type === "month" ? t.slice(0, 7) : quarterKey(t);
}

function PeriodNote({ goalId, type, pkey, label, note, isCurrent }: { goalId: number; type: PT; pkey: string; label: string; note?: Row; isCurrent: boolean }) {
  const [open, setOpen] = useState(isCurrent || !!note?.body);
  const [body, setBody] = useAutosave(note?.body ?? "", async (v) => {
    // goal_notes has UNIQUE(goal_id, period_type, period_key): update the existing row or create it.
    const existing = note?.id ? note : (await db.list("goal_notes", { filters: [{ col: "goal_id", op: "=", value: goalId }, { col: "period_type", op: "=", value: type }, { col: "period_key", op: "=", value: pkey }], limit: 1 }))[0];
    await db.upsert("goal_notes", existing ? { id: existing.id, body: v } : { goal_id: goalId, period_type: type, period_key: pkey, body: v });
  });
  // A file put into a period with no note yet creates the note first.
  const ensureNote = async () => {
    const found = (await db.list("goal_notes", { filters: [{ col: "goal_id", op: "=", value: goalId }, { col: "period_type", op: "=", value: type }, { col: "period_key", op: "=", value: pkey }], limit: 1 }))[0];
    const row = found ?? (await db.upsert("goal_notes", { goal_id: goalId, period_type: type, period_key: pkey, body }));
    return { table: "goal_notes" as const, id: row.id as number };
  };
  return (
    <div className="card" style={{ marginBottom: 8, borderColor: isCurrent ? "var(--accent)" : undefined }}>
      <div className="row" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"}</span>
        <b>{label}</b>
        {isCurrent && <span className="badge ok">현재</span>}
        {!open && body && <span className="faint small ellipsis grow">{richPlain(body).replace(/[#\-\n]+/g, " ").trim()}</span>}
        <span className="spacer" />
        {open && !body && <button className="btn sm" onClick={(e) => { e.stopPropagation(); setBody(TEMPLATES[type]); }}>템플릿 넣기</button>}
      </div>
      {open && <RichText value={body} onChange={setBody} placeholder="이 기간의 계획, 진행, 회고를 적어 보세요" owner={note?.id ? { table: "goal_notes", id: note.id } : undefined} ensureOwner={ensureNote} />}
    </div>
  );
}

export default function GoalDetail() {
  const { id } = useParams();
  const gid = Number(id);
  const nav = useNavigate();
  const status = useOptions("goal.status");
  const cat = useOptions("goal.category");
  const { data: goal } = useLoad(() => db.get("goals", gid), [gid], ["goals"]);
  const [ptype, setPtype] = useState<PT>(() => (localStorage.getItem("goal-ptype") as PT) || "month");
  useEffect(() => {
    try { localStorage.setItem("goal-ptype", ptype); } catch { /* storage unavailable */ }
  }, [ptype]);
  const notes = useRows("goal_notes", { filters: [{ col: "goal_id", op: "=", value: gid }, { col: "period_type", op: "=", value: ptype }] });
  const [d, setD] = useAutosave({ title: goal?.title ?? "", summary: goal?.summary ?? "", body: goal?.body ?? "" }, (v) => db.upsert("goals", { id: gid, ...v }));

  if (goal === null) return <Empty>불러오는 중…</Empty>;
  if (!goal) return <Empty>목표를 찾을 수 없습니다</Empty>;
  const set = (k: string, v: unknown) => db.upsert("goals", { id: gid, [k]: v });
  const keys = periodKeys(ptype, goal.start_date, goal.end_date);
  const cur = currentKey(ptype);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={() => nav("/goals")}>‹ 목표 목록</button>
        <span className="spacer" />
        <button className="btn danger sm" onClick={async () => { if (await confirmDialog("이 목표와 기간별 기록을 모두 삭제할까요?", true)) { await db.remove("goals", gid); nav("/goals"); } }}>삭제</button>
      </div>
      <input className="title-input" placeholder="목표 이름" value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} autoFocus={!goal.title} />
      <div className="grid3" style={{ marginTop: 14 }}>
        <Field label="상태"><OptionSelect options={status} value={goal.status_id} onChange={(v) => set("status_id", v)} setKey="goal.status" /></Field>
        <Field label="카테고리"><OptionSelect options={cat} value={goal.category_id} onChange={(v) => set("category_id", v)} setKey="goal.category" /></Field>
        <Field label="시작 날짜"><input type="date" value={goal.start_date ?? ""} onChange={(e) => set("start_date", e.target.value || null)} /></Field>
        <Field label="종료 날짜"><input type="date" value={goal.end_date ?? ""} onChange={(e) => set("end_date", e.target.value || null)} /></Field>
      </div>
      <Field label="한 줄 요약 (카드에 표시)">
        <input value={d.summary} onChange={(e) => setD((x) => ({ ...x, summary: e.target.value }))} placeholder="왜 이 목표를 세웠는지, 완료 기준은 무엇인지" />
      </Field>
      <div className="section">
        <div className="section-title">상세 내용</div>
        <RichText value={d.body} onChange={(v) => setD((x) => ({ ...x, body: v }))} placeholder="목표의 배경, 성공 기준, 참고 자료, 포트폴리오로 남길 결과물 등" owner={{ table: "goals", id: gid }} />
      </div>
      <LooseFiles ownerTable="goals" ownerId={gid} texts={[d.body]} />
      <div className="section">
        <div className="section-title">기간별 기록</div>
        <Tabs<PT> value={ptype} onChange={setPtype} items={[["quarter", "분기별"], ["month", "월별"], ["week", "주간별"]]} />
        {/* Current and past periods first (newest on top); future periods folded away. */}
        {keys.filter((k) => k.key <= cur).map((k) => (
          <PeriodNote key={`${ptype}-${k.key}`} goalId={gid} type={ptype} pkey={k.key} label={k.label} note={notes.rows.find((n) => n.period_key === k.key)} isCurrent={k.key === cur} />
        ))}
        {keys.some((k) => k.key > cur) && (
          <details style={{ marginTop: 8 }}>
            <summary className="muted small" style={{ cursor: "pointer" }}>앞으로의 기간 {keys.filter((k) => k.key > cur).length}개</summary>
            <div style={{ marginTop: 8 }}>
              {keys.filter((k) => k.key > cur).reverse().map((k) => (
                <PeriodNote key={`${ptype}-${k.key}`} goalId={gid} type={ptype} pkey={k.key} label={k.label} note={notes.rows.find((n) => n.period_key === k.key)} isCurrent={false} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
