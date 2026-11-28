import { useState } from "react";
import { db, Filter, Row } from "../../lib/api";
import { useAutosave, useOptions, useRows } from "../../lib/hooks";
import { monthRange, today, won, ym } from "../../lib/date";
import { LooseFiles } from "../../components/Attachments";
import { confirmDialog, Empty, Field, Modal, OptionChip, OptionSelect, SearchBox, useDebounced } from "../../components/ui";
import { RichText } from "../../components/RichText";

export function useLedgerOptions() {
  return { loc: useOptions("expense.location"), item: useOptions("expense.item"), status: useOptions("expense.status") };
}

/** Which day an expense counts on: when it was bought, or when the money leaves. */
export type Basis = "purchase" | "paid";
/** `paid_day` = the withdrawal day, or the purchase day when none is set apart. */
export const basisCol = (b: Basis) => (b === "paid" ? "paid_day" : "purchased_at");
/** An empty withdrawal day means the purchase day. */
const paidDay = (r: Partial<Row>) => (r.paid_at || r.purchased_at || "").slice(0, 10);

/** Remembered per device, shared by the list and the dashboard. */
export function useBasis() {
  const [b, setB] = useState<Basis>(() => {
    try {
      return localStorage.getItem("ledger.basis") === "paid" ? "paid" : "purchase";
    } catch {
      return "purchase";
    }
  });
  const set = (v: Basis) => {
    setB(v);
    try {
      localStorage.setItem("ledger.basis", v);
    } catch {
      /* not remembered */
    }
  };
  return [b, set] as const;
}

export function BasisToggle({ value, onChange }: { value: Basis; onChange: (b: Basis) => void }) {
  return (
    <div className="seg" title="구매 날짜와 출금 날짜 중 어느 날로 셀지">
      <button className={value === "purchase" ? "on" : ""} onClick={() => onChange("purchase")}>구매일 기준</button>
      <button className={value === "paid" ? "on" : ""} onClick={() => onChange("paid")}>출금일 기준</button>
    </div>
  );
}

const md = (s?: string | null) => (s ?? "").slice(5, 10).replace("-", "/");

/** Full editor for one expense. `row` without id = new expense. */
export function ExpenseEditor({ row, onClose }: { row: Partial<Row>; onClose: () => void }) {
  const o = useLedgerOptions();
  const isNew = !row.id;
  const [d, setD, flush] = useAutosave<Partial<Row>>(row, async (v) => {
    if (!isNew) await db.upsert("expenses", { ...v, id: row.id });
  });
  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (isNew) {
      const bought = d.purchased_at || today();
      await db.upsert("expenses", { source: "manual", ...d, amount: Number(d.amount) || 0, purchased_at: bought });
    } else flush();
    onClose();
  };
  // An empty withdrawal day follows the purchase day; one set apart stays put
  // (setting it back to the purchase day empties it again).
  const setBought = (v: string) => setD((x) => ({ ...x, purchased_at: v, paid_at: x.paid_at && x.paid_at.slice(0, 10) !== v ? x.paid_at : null }));
  const setPaid = (v: string) => setD((x) => ({ ...x, paid_at: v === (x.purchased_at ?? "").slice(0, 10) ? null : v }));
  return (
    <Modal
      open
      wide
      onClose={isNew ? onClose : save}
      title={isNew ? "지출 추가" : "지출 상세"}
      footer={
        <>
          {!isNew && <button className="btn danger" onClick={async () => (await confirmDialog("이 지출을 삭제할까요?", true)) && (await db.remove("expenses", row.id!), onClose())}>삭제</button>}
          <span className="spacer" />
          {isNew && <button className="btn" onClick={onClose}>취소</button>}
          <button className="btn primary" onClick={save}>{isNew ? "추가" : "완료"}</button>
        </>
      }
    >
      <div className="grid2" style={{ gap: "0 14px" }}>
        <Field label="지출명">
          <input value={d.name ?? ""} onChange={(e) => set("name", e.target.value)} autoFocus={isNew} />
        </Field>
        <Field label="구매 금액 (원)">
          <input type="number" inputMode="numeric" value={d.amount ?? ""} onChange={(e) => set("amount", e.target.value === "" ? null : Number(e.target.value))} />
        </Field>
        <Field label="구매 날짜">
          <input type="date" value={(d.purchased_at ?? "").slice(0, 10)} onChange={(e) => e.target.value && setBought(e.target.value)} />
        </Field>
        <Field label="출금 날짜">
          <input type="date" value={paidDay(d)} onChange={(e) => e.target.value && setPaid(e.target.value)} />
        </Field>
        <Field label="결제 위치">
          <OptionSelect options={o.loc} value={d.location_id} onChange={(v) => set("location_id", v)} setKey="expense.location" />
        </Field>
        <Field label="품목">
          <OptionSelect options={o.item} value={d.item_id} onChange={(v) => set("item_id", v)} setKey="expense.item" />
        </Field>
        <Field label="현재 상태">
          <OptionSelect options={o.status} value={d.status_id} onChange={(v) => set("status_id", v)} setKey="expense.status" />
        </Field>
        <Field label="예상 배송일">
          <input type="date" value={d.expected_delivery ?? ""} onChange={(e) => set("expected_delivery", e.target.value || null)} />
        </Field>
        <Field label="URL">
          <input type="url" value={d.url ?? ""} placeholder="https://" onChange={(e) => set("url", e.target.value)} />
        </Field>
      </div>
      <Field label="메모">
        <RichText value={d.memo ?? ""} onChange={(v) => set("memo", v)} placeholder="구매 이유, 옵션, 교환/환불 메모 등 자유롭게" owner={row.id ? { table: "expenses", id: row.id } : undefined} />
      </Field>
      {!isNew && <LooseFiles ownerTable="expenses" ownerId={row.id} texts={[d.memo]} />}
      {d.raw_text && (
        <details>
          <summary className="muted small">원본 알림 문구</summary>
          <pre className="notice" style={{ whiteSpace: "pre-wrap" }}>{d.raw_text}</pre>
        </details>
      )}
      {!isNew && <div className="faint small">변경 사항은 자동 저장됩니다{row.source === "notification" ? " · 알림에서 자동 입력됨" : ""}</div>}
    </Modal>
  );
}

export default function Expenses() {
  const [month, setMonth] = useState(ym(new Date()));
  const [q, setQ] = useState("");
  const [fLoc, setFLoc] = useState<number | null>(null);
  const [fItem, setFItem] = useState<number | null>(null);
  const [fStatus, setFStatus] = useState<number | null>(null);
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const o = useLedgerOptions();
  const [basis, setBasis] = useBasis();
  const col = basisCol(basis);
  const search = useDebounced(q);
  const [from, to] = monthRange(new Date(`${month}-01T00:00`));
  const filters: Filter[] = [];
  if (!search) {
    filters.push({ col, op: ">=", value: from }, { col, op: "<", value: `${to} 99` });
  }
  if (fLoc) filters.push({ col: "location_id", op: "=", value: fLoc });
  if (fItem) filters.push({ col: "item_id", op: "=", value: fItem });
  if (fStatus) filters.push({ col: "status_id", op: "=", value: fStatus });
  const { rows } = useRows("expenses", { filters, search, order: [[col, "desc"], ["id", "desc"]], limit: 3000 });
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const shift = (n: number) => {
    const d = new Date(`${month}-01T00:00`);
    d.setMonth(d.getMonth() + n);
    setMonth(ym(d));
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="icon-btn" onClick={() => shift(-1)}>‹</button>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} disabled={!!search} />
        <button className="icon-btn" onClick={() => shift(1)}>›</button>
        <SearchBox value={q} onChange={setQ} placeholder="전체 기간 검색" />
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEdit({ purchased_at: today(), status_id: o.status[0]?.id ?? null })}>+ 지출 추가</button>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div style={{ width: 150 }}><OptionSelect options={o.loc} value={fLoc} onChange={setFLoc} placeholder="결제 위치 전체" /></div>
        <div style={{ width: 130 }}><OptionSelect options={o.item} value={fItem} onChange={setFItem} placeholder="품목 전체" /></div>
        <div style={{ width: 130 }}><OptionSelect options={o.status} value={fStatus} onChange={setFStatus} placeholder="상태 전체" /></div>
        <BasisToggle value={basis} onChange={setBasis} />
        <span className="spacer" />
        <span className="muted">{rows.length}건 · <b style={{ color: "var(--text)" }}>{won(total)}</b></span>
      </div>
      {rows.length === 0 ? (
        <Empty>지출 내역이 없습니다</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{basis === "paid" ? "출금일" : "구매일"}</th>
                <th>지출명</th>
                <th>품목</th>
                <th>결제 위치</th>
                <th>상태</th>
                <th className="num">금액</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" onClick={() => setEdit(r)}>
                  <td className="meta">
                    {md(basis === "paid" ? paidDay(r) : r.purchased_at)}
                    {/* The other day, when the two differ (card bills, sponsorships). */}
                    {r.paid_at && (
                      <div className="faint small">{basis === "paid" ? `구매 ${md(r.purchased_at)}` : `출금 ${md(r.paid_at)}`}</div>
                    )}
                  </td>
                  <td>
                    {r.name || <span className="faint">(이름 없음)</span>}
                    {r.memo && <span className="faint small"> · 📝</span>}
                    {r.source === "notification" && <span className="badge">알림</span>}
                  </td>
                  <td><OptionChip options={o.item} id={r.item_id} /></td>
                  <td><OptionChip options={o.loc} id={r.location_id} /></td>
                  <td>
                    <OptionChip options={o.status} id={r.status_id} />
                    {r.expected_delivery && <span className="faint small"> {r.expected_delivery.slice(5).replace("-", "/")} 도착</span>}
                  </td>
                  <td className="num"><b>{won(r.amount)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <ExpenseEditor key={edit.id ?? "new"} row={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
