import { useState } from "react";
import { db } from "../../lib/api";
import { OptionItem, useOptions } from "../../lib/hooks";
import { confirmDialog, Fold, Modal } from "../../components/ui";

export const OPTION_SETS: [string, string, string][] = [
  ["expense.location", "가계부 · 결제 위치", "휴대폰의 알림 가계부에서 앱을 고르면 앱 이름으로 자동 추가됩니다"],
  ["expense.item", "가계부 · 품목", ""],
  ["expense.status", "가계부 · 현재 상태", "맨 위 항목이 새 지출의 기본 상태입니다"],
  ["goal.status", "목표 · 상태", ""],
  ["goal.category", "목표 · 카테고리", ""],
];
const PALETTE = ["#9b9b9b", "#f56c6c", "#f5a623", "#f2d024", "#3bb273", "#2bb3c0", "#4b8bf5", "#b06cf5", "#e86fb0"];

function OptionRow({ o, list, i }: { o: OptionItem; list: OptionItem[]; i: number }) {
  const [label, setLabel] = useState(o.label);
  const move = async (dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const arr = [...list];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await db.bulk(arr.map((x, k) => ({ table: "option_items" as const, row: { id: x.id, sort: k } })));
  };
  return (
    <div className="list-row" style={{ opacity: o.archived ? 0.5 : 1 }}>
      <select value={o.color ?? "#9b9b9b"} onChange={(e) => db.upsert("option_items", { id: o.id, color: e.target.value })} style={{ width: 44, padding: 2, background: o.color ?? "#9b9b9b", color: "transparent" }} aria-label="색">
        {PALETTE.map((c) => <option key={c} value={c} style={{ background: c }}>{c}</option>)}
      </select>
      <input className="grow" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() && label !== o.label && db.upsert("option_items", { id: o.id, label: label.trim() })} />
      <button className="icon-btn" onClick={() => move(-1)} aria-label="위로">↑</button>
      <button className="icon-btn" onClick={() => move(1)} aria-label="아래로">↓</button>
      <button className="btn sm ghost" onClick={() => db.upsert("option_items", { id: o.id, archived: o.archived ? 0 : 1 })}>{o.archived ? "다시 사용" : "숨기기"}</button>
      <button className="icon-btn" aria-label="삭제" onClick={async () => (await confirmDialog(`'${o.label}'을(를) 삭제할까요?\n이미 이 값을 쓰는 항목은 '선택 안 함'으로 보입니다. 기록을 유지하려면 '숨기기'를 쓰세요.`, true)) && db.remove("option_items", o.id)}>✕</button>
    </div>
  );
}

function OptionSetBody({ setKey, hint, autoFocus }: { setKey: string; hint: string; autoFocus?: boolean }) {
  const list = useOptions(setKey);
  const [label, setLabel] = useState("");
  const add = async () => {
    if (!label.trim()) return;
    await db.upsert("option_items", { set_key: setKey, label: label.trim(), color: PALETTE[(list.length + 1) % PALETTE.length], sort: list.length });
    setLabel("");
  };
  return (
    <>
      {hint && <div className="faint small" style={{ marginBottom: 8 }}>{hint}</div>}
      <div className="list">{list.map((o, i) => <OptionRow key={o.id} o={o} list={list} i={i} />)}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <input className="grow" placeholder="새 값" value={label} autoFocus={autoFocus} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <button className="btn sm" onClick={add}>추가</button>
      </div>
    </>
  );
}

function OptionSet({ setKey, title, hint }: { setKey: string; title: string; hint: string }) {
  const list = useOptions(setKey);
  return (
    <Fold head={<><b>{title}</b> <span className="faint small">{list.filter((o) => !o.archived).length}개</span></>}>
      <OptionSetBody setKey={setKey} hint={hint} />
    </Fold>
  );
}

/** One option set edited in place, from the page that uses it (no trip to 설정). */
export function OptionManager({ setKey, onClose }: { setKey: string; onClose: () => void }) {
  const [, title, hint] = OPTION_SETS.find(([k]) => k === setKey) ?? [setKey, "선택값", ""];
  return (
    <Modal open onClose={onClose} title={`${title} 관리`} footer={<button className="btn primary" onClick={onClose}>완료</button>}>
      <OptionSetBody setKey={setKey} hint={hint} autoFocus />
    </Modal>
  );
}

/** A page's option sets (e.g. 가계부: 결제 위치·품목·현재 상태), from its header. */
export function OptionSetsButton({ prefix }: { prefix: string }) {
  const [open, setOpen] = useState(false);
  const sets = OPTION_SETS.filter(([k]) => k.startsWith(prefix));
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="이 화면에서 고르는 값을 추가·수정합니다">⚙ 선택값</button>
      {open && (
        <Modal open wide onClose={() => setOpen(false)} title="선택값 관리" footer={<button className="btn primary" onClick={() => setOpen(false)}>완료</button>}>
          <div className="stack">{sets.map(([k, t, h]) => <OptionSet key={k} setKey={k} title={t} hint={h} />)}</div>
        </Modal>
      )}
    </>
  );
}

export default function OptionsSection() {
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>가계부와 목표에서 고르는 선택형 값을 직접 구성합니다.</p>
      <div className="stack">{OPTION_SETS.map(([k, t, h]) => <OptionSet key={k} setKey={k} title={t} hint={h} />)}</div>
    </div>
  );
}
