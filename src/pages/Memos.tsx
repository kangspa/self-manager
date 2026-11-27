import { useState } from "react";
import { richFirstLine, richPlain } from "../lib/rich";
import { db, Row } from "../lib/api";
import { useAutosave, useRows } from "../lib/hooks";
import { relTs } from "../lib/date";
import { Attachments } from "../components/Attachments";
import { confirmDialog, Empty, Modal, PageHeader, SearchBox, useDebounced } from "../components/ui";
import { RichText } from "../components/RichText";

export const COLORS = ["", "#f56c6c", "#f5a623", "#f2d024", "#3bb273", "#4b8bf5", "#b06cf5"];

function MemoEditor({ memo, onClose }: { memo: Row; onClose: () => void }) {
  const [draft, setDraft, flush] = useAutosave({ title: memo.title ?? "", body: memo.body ?? "" }, (v) => db.upsert("memos", { id: memo.id, ...v }));
  const close = () => {
    flush();
    onClose();
  };
  const del = async () => {
    if (await confirmDialog("이 메모를 삭제할까요?", true)) {
      await db.remove("memos", memo.id);
      onClose();
    }
  };
  return (
    <Modal
      open
      onClose={close}
      wide
      title={
        <div className="row">
          <button className="btn sm" onClick={() => db.upsert("memos", { id: memo.id, pinned: memo.pinned ? 0 : 1 })}>{memo.pinned ? "📌 고정 해제" : "📌 고정"}</button>
          <div className="colors">
            {COLORS.map((c) => (
              <span key={c} className={`color-dot ${(memo.color ?? "") === c ? "on" : ""}`} style={{ background: c || "var(--bg-hover)" }} onClick={() => db.upsert("memos", { id: memo.id, color: c || null })} />
            ))}
          </div>
        </div>
      }
      footer={
        <>
          <span className="faint small spacer">자동 저장됨 · {relTs(memo.updated_at)}</span>
          <button className="btn danger" onClick={del}>삭제</button>
          <button className="btn primary" onClick={close}>완료</button>
        </>
      }
    >
      <input className="title-input" style={{ fontSize: 20 }} placeholder="제목" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
      <RichText value={draft.body} onChange={(v) => setDraft((d) => ({ ...d, body: v }))} placeholder="내용을 입력하세요" autoFocus owner={{ table: "memos", id: memo.id }} />
      <Attachments ownerTable="memos" ownerId={memo.id} />
    </Modal>
  );
}

export default function Memos() {
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const search = useDebounced(q);
  const { rows } = useRows("memos", { search, order: [["pinned", "desc"], ["updated_at", "desc"]], limit: 1000 });
  const open = rows.find((r) => r.id === openId);

  const add = async () => {
    const text = quick.trim();
    const r = await db.upsert("memos", { title: "", body: text });
    setQuick("");
    if (!text) setOpenId(r.id);
  };

  return (
    <div>
      <PageHeader title="메모" icon="📝" actions={<SearchBox value={q} onChange={setQ} />} />
      <div className="quick-add">
        <input placeholder="떠오른 생각을 적고 Enter" value={quick} onChange={(e) => setQuick(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()} />
        <button className="btn primary" onClick={add}>+ 새 메모</button>
      </div>
      {rows.length === 0 ? (
        <Empty>{search ? "검색 결과가 없습니다" : "아직 메모가 없습니다"}</Empty>
      ) : (
        <div className="memo-grid">
          {rows.map((m) => (
            <div key={m.id} className="memo-card" style={{ ["--mc" as any]: m.color || "transparent" }} onClick={() => setOpenId(m.id)}>
              <div className="row nowrap">
                <b className="ellipsis grow">{m.title || richFirstLine(m.body) || "제목 없음"}</b>
                {m.pinned ? <span>📌</span> : null}
              </div>
              {m.title && <div className="memo-body">{richPlain(m.body)}</div>}
              {!m.title && <div className="memo-body">{richPlain(m.body).split("\n").filter((l) => l.trim()).slice(1).join("\n")}</div>}
              <div className="faint small" style={{ marginTop: "auto" }}>{relTs(m.updated_at)}</div>
            </div>
          ))}
        </div>
      )}
      {open && <MemoEditor key={open.id} memo={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
