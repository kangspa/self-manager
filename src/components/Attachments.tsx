import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, Attachment, db, onChange, Table } from "../lib/api";
import { confirmDialog, Modal, run, toast } from "./ui";

export const fmtSize = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);

const kindOf = (a: Attachment) => {
  const m = a.mime ?? "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || a.name.toLowerCase().endsWith(".pdf")) return "pdf";
  return "file";
};
const ICON: Record<string, string> = { image: "🖼️", video: "🎞️", audio: "🎙️", pdf: "📄", file: "📎" };

/** One-line sync state, phrased from this device's point of view. */
export function syncLabel(a: Attachment): { text: string; tone: "ok" | "warn" | "muted" } {
  if (a.downloading) return { text: "받는 중…", tone: "muted" };
  if (!a.sync) return a.local ? { text: "동기화 안 함 · 이 기기에만", tone: "muted" } : { text: "동기화되지 않음 · 다른 기기에만 있음", tone: "warn" };
  if (a.local && a.on_drive) return { text: "동기화됨", tone: "ok" };
  if (a.local) return { text: "업로드 대기", tone: "muted" };
  if (a.on_drive) return { text: "드라이브에 있음 · 다음 동기화 때 받음", tone: "muted" };
  return { text: "다른 기기에서 아직 올라오지 않음", tone: "warn" };
}

function useAttachments(ownerTable: Table, ownerId: number | null | undefined) {
  const [items, setItems] = useState<Attachment[]>([]);
  const load = useCallback(async () => {
    if (!ownerId) return setItems([]);
    try {
      setItems(await api.attList(ownerTable, ownerId));
    } catch (e) {
      toast(String(e), "error");
    }
  }, [ownerTable, ownerId]);
  useEffect(() => {
    load();
    return onChange((t) => (t === "attachments" || t === "*") && load());
  }, [load]);
  return { items, reload: load };
}

/** Long press (touch) or right click (mouse) opens the per-file editor. */
function usePressMenu(open: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      open();
    },
    onTouchStart: () => {
      fired.current = false;
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(20);
        open();
      }, 500);
    },
    onTouchEnd: (e: React.TouchEvent) => {
      window.clearTimeout(timer.current);
      if (fired.current) e.preventDefault();
    },
    onTouchMove: () => window.clearTimeout(timer.current),
  };
}

function AttachmentEditor({ a, limitMb, onClose }: { a: Attachment; limitMb: number; onClose: () => void }) {
  const [name, setName] = useState(a.name);
  const autoSyncs = a.size <= limitMb * 1024 * 1024;
  const setMode = (sync_mode: Attachment["sync_mode"]) => db.upsert("attachments", { id: a.id, sync_mode });
  const label = syncLabel(a);
  return (
    <Modal
      open
      onClose={onClose}
      title="첨부 파일"
      footer={
        <>
          <button className="btn danger" onClick={async () => { if (await confirmDialog(`'${a.name}'을(를) 삭제할까요?`, true)) { await api.attDelete(a.id); onClose(); } }}>삭제</button>
          <span className="spacer" />
          {a.local && <button className="btn" onClick={() => run(() => api.attOpen(a.id))}>열기</button>}
          <button className="btn primary" onClick={async () => { if (name.trim() && name !== a.name) await db.upsert("attachments", { id: a.id, name: name.trim() }); onClose(); }}>완료</button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">이름</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="kv" style={{ marginBottom: 14 }}>
        <span>크기</span><span>{fmtSize(a.size)}</span>
        <span>상태</span><span className={`sync-${label.tone}`}>{label.text}</span>
      </div>
      <div className="field-label" style={{ marginBottom: 6 }}>구글 드라이브 동기화</div>
      <div className="list">
        {([
          ["auto", `기본 설정 따르기 (${limitMb}MB 이하만) → 지금은 ${autoSyncs ? "동기화함" : "동기화 안 함"}`],
          ["on", "항상 동기화 (용량과 상관없이)"],
          ["off", "동기화 안 함 (이 기기에만 보관)"],
        ] as [Attachment["sync_mode"], string][]).map(([v, l]) => (
          <label key={v} className="list-row click" style={{ minHeight: 40 }}>
            <input type="radio" name={`sync-${a.id}`} checked={a.sync_mode === v} onChange={() => setMode(v)} />
            <span>{l}</span>
          </label>
        ))}
      </div>
      <p className="faint small">바뀐 설정은 다음 동기화 때 적용됩니다. 동기화를 끄면 드라이브의 사본은 지워지고, 이 파일이 없는 다른 기기에서는 이름만 보입니다.</p>
    </Modal>
  );
}

function Item({ a, onEdit }: { a: Attachment; onEdit: () => void }) {
  const press = usePressMenu(onEdit);
  const k = kindOf(a);
  const src = a.local && a.path ? convertFileSrc(a.path) : null;
  const label = syncLabel(a);
  const [big, setBig] = useState(false);
  return (
    <div className={`att ${a.local ? "" : "absent"}`} {...press} title="길게 누르거나 우클릭하면 설정">
      {src && k === "image" && <img className="att-thumb" src={src} alt={a.name} onClick={() => setBig(true)} />}
      {src && k === "video" && <video className="att-media" src={src} controls preload="metadata" />}
      {src && k === "audio" && <audio className="att-audio" src={src} controls preload="none" />}
      <div className="att-meta">
        <span className="att-icon">{ICON[k]}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis att-name">{a.name}</div>
          <div className={`small sync-${label.tone}`}>{fmtSize(a.size)} · {label.text}{a.sync_mode !== "auto" && " · 개별 설정"}</div>
        </div>
        <button className="icon-btn" aria-label="설정" onClick={onEdit}>⋯</button>
      </div>
      {big && src && (
        <Modal open wide onClose={() => setBig(false)} title={a.name}>
          <img src={src} alt={a.name} style={{ maxWidth: "100%", display: "block", margin: "0 auto" }} />
        </Modal>
      )}
    </div>
  );
}

/**
 * Attachments of one record. `ensureOwner` lets a record that does not exist
 * yet (e.g. today's empty diary) be created on the first file.
 */
export function Attachments({ ownerTable, ownerId, ensureOwner, title = "첨부 파일", hideRoles = [] }: { ownerTable: Table; ownerId: number | null | undefined; ensureOwner?: () => Promise<number>; title?: string; hideRoles?: string[] }) {
  const { items } = useAttachments(ownerTable, ownerId);
  const [edit, setEdit] = useState<number | null>(null);
  const [limit, setLimit] = useState(10);
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.attSummary().then((s) => setLimit(s.limit_mb)).catch(() => {});
  }, [items.length]);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    let id = ownerId;
    if (!id && ensureOwner) id = await ensureOwner();
    if (!id) return;
    for (const f of Array.from(files)) {
      setProgress(`${f.name} 0%`);
      await run(() => api.attUpload(ownerTable, id!, f, (p) => setProgress(`${f.name} ${Math.round(p * 100)}%`)));
    }
    setProgress(null);
    if (input.current) input.current.value = "";
  };

  const shown = items.filter((a) => !a.role || !hideRoles.includes(a.role));
  const current = items.find((a) => a.id === edit);
  return (
    <div className="section">
      <div className="section-title">
        <span>{title} {shown.length > 0 && <span className="faint small">{shown.length}</span>}</span>
        <button className="btn sm" onClick={() => input.current?.click()} disabled={!!progress}>+ 파일</button>
      </div>
      <input ref={input} type="file" multiple hidden onChange={(e) => add(e.target.files)} />
      {progress && <div className="faint small" style={{ marginBottom: 6 }}>올리는 중: {progress}</div>}
      {shown.length > 0 && <div className="att-grid">{shown.map((a) => <Item key={a.id} a={a} onEdit={() => setEdit(a.id)} />)}</div>}
      {shown.length > 0 && <div className="faint small" style={{ marginTop: 4 }}>파일을 길게 누르거나 우클릭하면 이름·동기화 여부를 바꿀 수 있습니다.</div>}
      {current && <AttachmentEditor a={current} limitMb={limit} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function useAttachmentList(ownerTable: Table, ownerId: number | null | undefined) {
  return useAttachments(ownerTable, ownerId).items;
}
