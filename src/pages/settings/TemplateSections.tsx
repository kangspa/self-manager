import { useState } from "react";
import { db, Row } from "../../lib/api";
import { useRows } from "../../lib/hooks";
import { WEEKDAYS } from "../../lib/date";
import { confirmDialog, Empty, Field, Modal, Fold } from "../../components/ui";
import { EmojiPicker, PresetIcon } from "../../components/EmojiPicker";
import { ColorPicker } from "../../components/ColorPicker";
import { DiaryField, parseFields } from "../Diary";
import { COLORS } from "../Memos";

const TYPES: [DiaryField["type"], string][] = [["text", "한 줄 글"], ["longtext", "긴 글"], ["rating", "별점 (1~5)"], ["number", "숫자"], ["checkbox", "체크"], ["select", "선택지"]];

function TemplateEditor({ t }: { t: Row }) {
  const [name, setName] = useState(t.name);
  const [fields, setFields] = useState<DiaryField[]>(parseFields(t));
  const [dirty, setDirty] = useState(false);
  const upd = (f: DiaryField[]) => {
    setFields(f);
    setDirty(true);
  };
  const save = async () => {
    await db.upsert("diary_templates", { id: t.id, name, fields_json: JSON.stringify(fields.filter((f) => f.label.trim())) });
    setDirty(false);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const a = [...fields];
    [a[i], a[j]] = [a[j], a[i]];
    upd(a);
  };
  return (
    <Fold head={<><b>{t.name || "이름 없는 템플릿"}</b> {t.is_default ? <span className="badge ok">기본</span> : null} <span className="faint small">항목 {fields.length}개</span></>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="grow" style={{ fontWeight: 650 }} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
        {t.is_default ? <span className="badge ok">기본</span> : <button className="btn sm" onClick={async () => { const all = await db.list("diary_templates"); await db.bulk(all.map((x) => ({ table: "diary_templates" as const, row: { id: x.id, is_default: x.id === t.id ? 1 : 0 } }))); }}>기본으로</button>}
        <button className="icon-btn" aria-label="삭제" onClick={async () => (await confirmDialog(`'${t.name}' 템플릿을 삭제할까요? 이미 쓴 일기 내용은 남습니다.`, true)) && db.remove("diary_templates", t.id)}>✕</button>
      </div>
      {fields.map((f, i) => (
        <div key={f.key} className="row nowrap" style={{ marginBottom: 6 }}>
          <input className="grow" value={f.label} placeholder="항목 이름" onChange={(e) => upd(fields.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
          <select value={f.type} onChange={(e) => upd(fields.map((x, k) => (k === i ? { ...x, type: e.target.value as DiaryField["type"] } : x)))} style={{ width: 120 }}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {f.type === "select" && <input placeholder="선택지 (쉼표)" value={f.options ?? ""} onChange={(e) => upd(fields.map((x, k) => (k === i ? { ...x, options: e.target.value } : x)))} style={{ width: 160 }} />}
          <button className="icon-btn" onClick={() => move(i, -1)}>↑</button>
          <button className="icon-btn" onClick={() => move(i, 1)}>↓</button>
          <button className="icon-btn" onClick={() => upd(fields.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <div className="row">
        <button className="btn sm" onClick={() => upd([...fields, { key: `f${Date.now().toString(36)}`, label: "", type: "text" }])}>+ 항목</button>
        <span className="spacer" />
        {dirty && <button className="btn sm primary" onClick={save}>저장</button>}
      </div>
    </Fold>
  );
}

export function DiarySection() {
  const { rows } = useRows("diary_templates", { order: [["sort", "asc"], ["id", "asc"]] });
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>일기에 쓸 항목을 원하는 대로 구성하세요. 날마다 다른 템플릿을 골라 쓸 수도 있습니다.</p>
      {rows.map((t) => <TemplateEditor key={`${t.id}-${t.updated_at}`} t={t} />)}
      <button className="btn" onClick={() => db.upsert("diary_templates", { name: "새 템플릿", fields_json: JSON.stringify([{ key: "f1", label: "오늘의 기록", type: "longtext" }]), is_default: rows.length ? 0 : 1, sort: rows.length })}>+ 템플릿 추가</button>
    </div>
  );
}

// ---------------- Daily presets & recurrence ----------------

type RuleType = "" | "daily" | "weekday" | "monthday" | "date";

/** Emoji + background colour of a daily item. Without an emoji the colour is a dot, as before. */
function IconModal({ p, onClose }: { p: Row; onClose: () => void }) {
  const set = (row: Record<string, unknown>) => db.upsert("daily_presets", { id: p.id, ...row });
  return (
    <Modal open wide onClose={onClose} title={`${p.label} 아이콘과 색`} footer={<button className="btn primary" onClick={onClose}>완료</button>}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted small">미리 보기</span>
        <span className="preset-btn done" style={{ ["--c" as any]: p.color || "var(--accent)" }}><PresetIcon emoji={p.emoji} color={p.color} />{p.label}</span>
      </div>
      <div className="icon-edit">
        <div>
          <div className="field-label" style={{ marginBottom: 6 }}>이모지</div>
          <EmojiPicker value={p.emoji ?? null} onChange={(e) => set({ emoji: e })} />
        </div>
        <div>
          <div className="field-label" style={{ marginBottom: 6 }}>배경색 {p.emoji ? "(이모지 뒤 원 색)" : "(이모지가 없으면 점 색)"}</div>
          <ColorPicker value={p.color ?? null} onChange={(c) => set({ color: c })} />
        </div>
      </div>
    </Modal>
  );
}

function PresetRow({ p, rules, i, list }: { p: Row; rules: Row[]; i: number; list: Row[] }) {
  const [label, setLabel] = useState(p.label);
  const [iconOpen, setIconOpen] = useState(false);
  const rule = rules[0];
  const type = (rule?.rule_type ?? "") as RuleType;
  const value: string = rule?.value ?? "";
  const setRule = async (t: RuleType, v: string) => {
    // One recurrence rule per preset in this UI.
    const ops: Parameters<typeof db.bulk>[0] = rules.map((r) => ({ table: "daily_rules" as const, delete: r.id }));
    if (t) ops.push({ table: "daily_rules", row: { preset_id: p.id, rule_type: t, value: v } });
    await db.bulk(ops);
  };
  const days = new Set(type === "weekday" ? value.split(",").filter(Boolean) : []);
  const move = async (d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const a = [...list];
    [a[i], a[j]] = [a[j], a[i]];
    await db.bulk(a.map((x, k) => ({ table: "daily_presets" as const, row: { id: x.id, sort: k } })));
  };
  return (
    <Fold faded={!!p.archived} head={<><PresetIcon emoji={p.emoji} color={p.color} /> <b>{p.label}</b> <span className="faint small">{p.kind === "memo" ? "메모형" : "체크형"}{p.archived ? " · 숨김" : ""}</span></>}>
      <div className="row">
        <button className="btn icon-pick" onClick={() => setIconOpen(true)} title="이모지·배경색"><PresetIcon emoji={p.emoji} color={p.color} /></button>
        {iconOpen && <IconModal p={p} onClose={() => setIconOpen(false)} />}
        <input className="grow" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() && label !== p.label && db.upsert("daily_presets", { id: p.id, label: label.trim() })} />
        <select value={p.kind} onChange={(e) => db.upsert("daily_presets", { id: p.id, kind: e.target.value })} style={{ width: 110 }}>
          <option value="check">체크형</option>
          <option value="memo">메모형</option>
        </select>
        <button className="icon-btn" onClick={() => move(-1)}>↑</button>
        <button className="icon-btn" onClick={() => move(1)}>↓</button>
        <button className="btn sm ghost" onClick={() => db.upsert("daily_presets", { id: p.id, archived: p.archived ? 0 : 1 })}>{p.archived ? "다시 사용" : "숨기기"}</button>
        <button className="icon-btn" aria-label="삭제" onClick={async () => (await confirmDialog(`'${p.label}' 항목을 삭제할까요? 이미 남긴 기록은 '메모'로 표시됩니다.`, true)) && db.remove("daily_presets", p.id)}>✕</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted small">꼭 해야 하는 날</span>
        <select value={type} onChange={(e) => { const t = e.target.value as RuleType; setRule(t, t === "weekday" ? "1,2,3,4,5" : t === "monthday" ? "1" : t === "date" ? "" : ""); }} style={{ width: 130 }}>
          <option value="">지정 안 함</option>
          <option value="daily">매일</option>
          <option value="weekday">요일마다</option>
          <option value="monthday">매월 며칠</option>
          <option value="date">특정 날짜</option>
        </select>
        {type === "weekday" && (
          <div className="row" style={{ gap: 4 }}>
            {WEEKDAYS.map((w, k) => (
              <button key={k} className={`btn sm ${days.has(String(k)) ? "primary" : ""}`} onClick={() => { const n = new Set(days); n.has(String(k)) ? n.delete(String(k)) : n.add(String(k)); setRule("weekday", [...n].sort().join(",")); }}>{w}</button>
            ))}
          </div>
        )}
        {type === "monthday" && <input defaultValue={value} placeholder="예: 1,15" onBlur={(e) => setRule("monthday", e.target.value.replace(/\s/g, ""))} style={{ width: 120 }} />}
        {type === "date" && (
          <>
            <input type="date" onChange={(e) => e.target.value && setRule("date", [...new Set([...value.split(",").filter(Boolean), e.target.value])].sort().join(","))} />
            {value.split(",").filter(Boolean).map((d) => <button key={d} className="btn sm" onClick={() => setRule("date", value.split(",").filter((x) => x && x !== d).join(","))}>{d} ✕</button>)}
          </>
        )}
      </div>
    </Fold>
  );
}

export function DailySection() {
  const presets = useRows("daily_presets", { order: [["sort", "asc"], ["id", "asc"]] });
  const rules = useRows("daily_rules");
  const [label, setLabel] = useState("");
  const add = async () => {
    if (!label.trim()) return;
    await db.upsert("daily_presets", { label: label.trim(), kind: "check", sort: presets.rows.length, color: COLORS[(presets.rows.length % 6) + 1] });
    setLabel("");
  };
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        일일 관리에서 날짜를 눌러 추가할 항목입니다. <b>꼭 해야 하는 날</b>을 정해 두면 그날 칸에 흐리게 미리 나타나고, 실제로 하면 진하게 바뀝니다.
      </p>
      <Field label="새 항목">
        <div className="row nowrap">
          <input className="grow" value={label} placeholder="예: 영양제, 스트레칭, 가계부 정리" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
          <button className="btn primary" onClick={add}>추가</button>
        </div>
      </Field>
      {presets.rows.length === 0 && <Empty>항목이 없습니다</Empty>}
      {presets.rows.map((p, i) => <PresetRow key={p.id} p={p} i={i} list={presets.rows} rules={rules.rows.filter((r) => r.preset_id === p.id)} />)}
    </div>
  );
}
