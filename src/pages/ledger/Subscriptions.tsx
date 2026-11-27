import { useState } from "react";
import { api, db, Row } from "../../lib/api";
import { useLoad, useRows } from "../../lib/hooks";
import { addDays, daysUntil, fmtDate, monthRange, today, WEEKDAYS, won } from "../../lib/date";
import { confirmDialog, Empty, Field, Modal, OptionChip, OptionSelect, run } from "../../components/ui";
import { RichText } from "../../components/RichText";
import { useLedgerOptions } from "./Expenses";

const CYCLES: [string, string][] = [["monthly", "매월"], ["yearly", "매년"], ["weekly", "매주"]];

function cycleText(s: Row) {
  if (s.cycle === "weekly") return `매주 ${WEEKDAYS[(s.day ?? 1) % 7]}요일`;
  if (s.cycle === "yearly") return `매년 ${s.month ?? 1}월 ${s.day ?? 1}일`;
  return `매월 ${s.day ?? 1}일`;
}

function SubEditor({ row, onClose }: { row: Partial<Row>; onClose: () => void }) {
  const o = useLedgerOptions();
  const [d, setD] = useState<Partial<Row>>({ cycle: "monthly", day: new Date().getDate(), active: 1, ...row });
  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const save = async () => {
    const { id, created_at, updated_at, ...rest } = d;
    await db.upsert("subscriptions", { ...rest, ...(id ? { id } : {}), amount: Number(d.amount) || 0 });
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={row.id ? "정기 결제 수정" : "정기 결제 추가"}
      footer={
        <>
          {row.id && <button className="btn danger" onClick={async () => (await confirmDialog("삭제할까요?", true)) && (await db.remove("subscriptions", row.id!), onClose())}>삭제</button>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={save}>저장</button>
        </>
      }
    >
      <Field label="이름"><input value={d.name ?? ""} onChange={(e) => set("name", e.target.value)} autoFocus placeholder="예: 넷플릭스, 통신비" /></Field>
      <div className="grid2" style={{ gap: "0 12px" }}>
        <Field label="금액 (원)"><input type="number" value={d.amount ?? ""} onChange={(e) => set("amount", e.target.value)} /></Field>
        <Field label="주기">
          <select value={d.cycle} onChange={(e) => set("cycle", e.target.value)}>
            {CYCLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        {d.cycle === "yearly" && (
          <Field label="월"><input type="number" min={1} max={12} value={d.month ?? 1} onChange={(e) => set("month", Number(e.target.value))} /></Field>
        )}
        {d.cycle === "weekly" ? (
          <Field label="요일">
            <select value={d.day ?? 1} onChange={(e) => set("day", Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}요일</option>)}
            </select>
          </Field>
        ) : (
          <Field label="결제일" hint="말일보다 크면 그 달 말일에 결제된 것으로 봅니다">
            <input type="number" min={1} max={31} value={d.day ?? 1} onChange={(e) => set("day", Number(e.target.value))} />
          </Field>
        )}
        <Field label="결제 위치"><OptionSelect options={o.loc} value={d.location_id} onChange={(v) => set("location_id", v)} /></Field>
        <Field label="품목"><OptionSelect options={o.item} value={d.item_id} onChange={(v) => set("item_id", v)} /></Field>
        <Field label="시작일 (선택)"><input type="date" value={d.start_date ?? ""} onChange={(e) => set("start_date", e.target.value || null)} /></Field>
        <Field label="종료일 (선택)"><input type="date" value={d.end_date ?? ""} onChange={(e) => set("end_date", e.target.value || null)} /></Field>
      </div>
      <Field label="URL"><input type="url" value={d.url ?? ""} onChange={(e) => set("url", e.target.value)} /></Field>
      <Field label="메모"><RichText value={d.memo ?? ""} onChange={(v) => set("memo", v)} owner={row.id ? { table: "subscriptions", id: row.id } : undefined} /></Field>
      <label className="row"><input type="checkbox" checked={!!d.active} onChange={(e) => set("active", e.target.checked ? 1 : 0)} /> 사용 중</label>
    </Modal>
  );
}

export default function Subscriptions() {
  const o = useLedgerOptions();
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const { rows } = useRows("subscriptions", { order: [["active", "desc"], ["day", "asc"]] });
  const t = today();
  const [mFrom, mTo] = monthRange(new Date());
  const next = useLoad(() => api.subscriptionSchedule(t, addDays(t, 400)), [t], ["subscriptions"]);
  const month = useLoad(() => api.subscriptionSchedule(mFrom, mTo), [mFrom], ["subscriptions"]);
  const recorded = useRows("expenses", { filters: [{ col: "subscription_id", op: "notnull" }, { col: "purchased_at", op: ">=", value: mFrom }] });
  const nextOf = (id: number) => next.data?.find((s) => s.subscription_id === id)?.date;
  const monthlyTotal = rows.filter((r) => r.active).reduce((s, r) => s + (r.cycle === "yearly" ? r.amount / 12 : r.cycle === "weekly" ? (r.amount * 52) / 12 : r.amount), 0);
  const isRecorded = (sid: number, date: string) => recorded.rows.some((e) => e.subscription_id === sid && (e.purchased_at ?? "").startsWith(date));

  const record = (s: any) =>
    run(
      () => db.upsert("expenses", { name: s.name, amount: s.amount, purchased_at: `${s.date} 09:00`, item_id: s.item_id, location_id: s.location_id, status_id: o.status[0]?.id ?? null, subscription_id: s.subscription_id, source: "subscription" }),
      "지출 내역에 기록했습니다",
    );

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted">월 환산 합계 <b style={{ color: "var(--text)" }}>{won(monthlyTotal)}</b></span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEdit({})}>+ 정기 결제 추가</button>
      </div>
      <div className="grid2">
        <div>
          <div className="section-title">등록된 정기 결제</div>
          {rows.length === 0 && <Empty>매달 나가는 구독·통신비·보험료 등을 등록해 두세요</Empty>}
          <div className="list">
            {rows.map((s) => {
              const n = nextOf(s.id);
              return (
                <div key={s.id} className="list-row click" onClick={() => setEdit(s)} style={{ opacity: s.active ? 1 : 0.5 }}>
                  <div className="grow">
                    <div className="row nowrap"><b className="ellipsis">{s.name}</b><OptionChip options={o.item} id={s.item_id} /></div>
                    <div className="faint small">{cycleText(s)}{n ? ` · 다음 결제 ${fmtDate(n)} (D-${daysUntil(n)})` : ""}</div>
                  </div>
                  <b>{won(s.amount)}</b>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="section-title">이번 달 결제 일정</div>
          {(month.data ?? []).length === 0 && <Empty>없음</Empty>}
          <div className="list">
            {(month.data ?? []).map((s, i) => {
              const done = isRecorded(s.subscription_id, s.date);
              const past = s.date <= t;
              return (
                <div key={i} className="list-row" style={{ opacity: past ? 1 : 0.6 }}>
                  <span className="meta" style={{ width: 70 }}>{fmtDate(s.date)}</span>
                  <span className="grow ellipsis">{s.name}</span>
                  <span className="small">{won(s.amount)}</span>
                  {done ? <span className="badge ok">기록됨</span> : <button className="btn sm" onClick={() => record(s)}>지출로 기록</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {edit && <SubEditor row={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
