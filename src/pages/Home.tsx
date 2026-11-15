import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, db, Row } from "../lib/api";
import { useLoad, useRows } from "../lib/hooks";
import { addDays, daysUntil, fmtDate, today, WEEKDAYS, won } from "../lib/date";
import { Chip, PageHeader, run } from "../components/ui";

export default function Home() {
  const t = today();
  const nav = useNavigate();
  const [memo, setMemo] = useState("");
  const tasks = useRows("tasks", { filters: [{ col: "done_at", op: "null" }], order: [["due_at", "asc"], ["id", "desc"]], limit: 200 });
  const events = useRows("events", { filters: [{ col: "start_at", op: ">=", value: t }, { col: "start_at", op: "<", value: addDays(t, 1) }], order: [["start_at", "asc"]] });
  const presets = useRows("daily_presets", { filters: [{ col: "archived", op: "=", value: 0 }], order: [["sort", "asc"]] });
  const daily = useLoad(() => api.dailyView(t, t), [t], ["daily_logs", "daily_rules", "daily_presets"]);
  const subs = useLoad(() => api.subscriptionSchedule(t, addDays(t, 7)), [t], ["subscriptions"]);
  const d = new Date();

  const due = tasks.rows.filter((x) => x.due_at && x.due_at.slice(0, 10) <= addDays(t, 3));
  const day = daily.data?.[t];
  const doneIds = new Set(day?.logs.map((l) => l.preset_id));

  const addMemo = async () => {
    if (!memo.trim()) return;
    await run(() => db.upsert("memos", { title: "", body: memo.trim() }), "메모를 저장했습니다");
    setMemo("");
  };

  return (
    <div>
      <PageHeader title={`${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`} sub="오늘 한눈에 보기" />
      <div className="quick-add">
        <input placeholder="빠른 메모… (Enter로 저장)" value={memo} onChange={(e) => setMemo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addMemo()} />
        <button className="btn" onClick={addMemo}>저장</button>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="section-title">
            오늘 일정 <Link to="/calendar" className="small">전체 →</Link>
          </div>
          {events.rows.length === 0 && <div className="faint small">일정 없음</div>}
          {events.rows.map((e: Row) => (
            <div key={e.id} className="row nowrap" style={{ padding: "4px 0" }}>
              <span className="meta" style={{ width: 52 }}>{e.all_day ? "종일" : e.start_at.slice(11, 16)}</span>
              <span className="ellipsis">{e.title}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="section-title">
            마감 임박 할 일 <Link to="/tasks" className="small">전체 →</Link>
          </div>
          {due.length === 0 && <div className="faint small">3일 안에 마감인 할 일이 없습니다</div>}
          {due.slice(0, 8).map((x) => {
            const n = daysUntil(x.due_at);
            return (
              <div key={x.id} className="row nowrap" style={{ padding: "4px 0" }}>
                <input type="checkbox" onChange={() => db.upsert("tasks", { id: x.id, done_at: Date.now() })} />
                <span className="ellipsis grow">{x.title}</span>
                <span className="meta" style={{ color: n < 0 ? "var(--danger)" : undefined }}>{n < 0 ? `${-n}일 지남` : n === 0 ? "오늘" : `D-${n}`}</span>
              </div>
            );
          })}
        </div>
        <div className="card click" onClick={() => nav("/daily")}>
          <div className="section-title">오늘의 일일 관리</div>
          <div className="row">
            {presets.rows.filter((p) => day?.planned.includes(p.id) || doneIds.has(p.id)).map((p) => (
              <Chip key={p.id} label={p.label} color={p.color} faded={!doneIds.has(p.id)} />
            ))}
            {!day?.planned.length && !day?.logs.length && <span className="faint small">기록 없음 · 눌러서 추가</span>}
          </div>
        </div>
        <div className="card">
          <div className="section-title">
            7일 내 정기 결제 <Link to="/ledger/subs" className="small">전체 →</Link>
          </div>
          {(subs.data ?? []).length === 0 && <div className="faint small">예정된 결제 없음</div>}
          {(subs.data ?? []).map((s, i) => (
            <div key={i} className="row nowrap" style={{ padding: "4px 0" }}>
              <span className="meta" style={{ width: 70 }}>{fmtDate(s.date)}</span>
              <span className="ellipsis grow">{s.name}</span>
              <span className="meta">{won(s.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
