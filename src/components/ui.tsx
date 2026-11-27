import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OptionItem } from "../lib/hooks";

// ---------------- Toasts ----------------
type ToastT = { id: number; text: string; kind: "info" | "error" | "ok" };
let pushToast: (t: ToastT) => void = () => {};
let toastSeq = 0;
export function toast(text: string, kind: ToastT["kind"] = "info") {
  pushToast({ id: ++toastSeq, text: text.replace(/^Error: /, ""), kind });
}
export function Toasts() {
  const [items, setItems] = useState<ToastT[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((p) => [...p.slice(-3), t]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== t.id)), t.kind === "error" ? 6000 : 2800);
    };
  }, []);
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => setItems((p) => p.filter((x) => x.id !== t.id))}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Runs an async action, showing errors (and an optional success message) as toasts. */
export async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok, "ok");
    return r;
  } catch (e) {
    toast(String(e), "error");
    return undefined;
  }
}

// ---------------- Modal / confirm ----------------
export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

let confirmImpl: (msg: string, danger?: boolean) => Promise<boolean> = async (m) => window.confirm(m);
export const confirmDialog = (msg: string, danger = false) => confirmImpl(msg, danger);
export function ConfirmHost() {
  const [st, setSt] = useState<{ msg: string; danger: boolean; resolve: (b: boolean) => void } | null>(null);
  useEffect(() => {
    confirmImpl = (msg, danger = false) => new Promise((resolve) => setSt({ msg, danger, resolve }));
  }, []);
  const close = (b: boolean) => {
    st?.resolve(b);
    setSt(null);
  };
  return (
    <Modal
      open={!!st}
      onClose={() => close(false)}
      title="확인"
      footer={
        <>
          <button className="btn" onClick={() => close(false)}>취소</button>
          <button className={`btn ${st?.danger ? "danger" : "primary"}`} onClick={() => close(true)} autoFocus>확인</button>
        </>
      }
    >
      <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{st?.msg}</p>
    </Modal>
  );
}

// ---------------- Layout bits ----------------
export function PageHeader({ title, icon, actions, sub }: { title: string; icon?: ReactNode; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>
          {icon && <span className="page-icon">{icon}</span>}
          {title}
        </h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, string][] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(([k, label]) => (
        <button key={k} role="tab" className={`tab ${value === k ? "on" : ""}`} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Chip({ label, color, faded, onClick, icon }: { label: string; color?: string | null; faded?: boolean; onClick?: () => void; icon?: ReactNode }) {
  return (
    <span className={`chip ${faded ? "faded" : ""} ${onClick ? "clickable" : ""} ${icon ? "with-icon" : ""}`} style={{ ["--c" as any]: color || "#9b9b9b" }} onClick={onClick}>
      {icon}
      {label}
    </span>
  );
}

/** Select bound to a user-configurable option set (see Settings > 선택값). */
export function OptionSelect({ options, value, onChange, placeholder = "선택 안 함" }: { options: OptionItem[]; value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string }) {
  const visible = options.filter((o) => !o.archived || o.id === value);
  const cur = options.find((o) => o.id === value);
  return (
    <div className="opt-select" style={{ ["--c" as any]: cur?.color || "transparent" }}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{placeholder}</option>
        {visible.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function OptionChip({ options, id }: { options: OptionItem[]; id: number | null | undefined }) {
  const o = options.find((x) => x.id === id);
  return o ? <Chip label={o.label} color={o.color} /> : null;
}

/** Textarea that grows with its content (Notion-like). */
export function AutoText({ value, onChange, placeholder, className, minRows = 3, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; minRows?: number; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} className={`autotext ${className ?? ""}`} rows={minRows} value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />;
}

export function SearchBox({ value, onChange, placeholder = "검색" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="search" type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Tiny markdown renderer for headings, bullets and checkboxes (meeting summaries). */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`u${out.length}`}>{list}</ul>);
    list = [];
  };
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p));
  lines.forEach((l, i) => {
    const t = l.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(#{1,4})\s+(.*)/))) {
      flush();
      const lvl = Math.min(m[1].length + 1, 4);
      out.push(lvl === 2 ? <h3 key={i}>{m[2]}</h3> : <h4 key={i}>{m[2]}</h4>);
    } else if ((m = t.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) {
      list.push(<li key={i} className="md-check">{m[1].trim() ? "☑" : "☐"} {inline(m[2])}</li>);
    } else if ((m = t.match(/^\s*[-*]\s+(.*)/))) {
      list.push(<li key={i}>{inline(m[1])}</li>);
    } else if (t.trim() === "") {
      flush();
    } else {
      flush();
      out.push(<p key={i}>{inline(t)}</p>);
    }
  });
  flush();
  return <div className="md">{out}</div>;
}

/**
 * A settings card that shows only its title line until clicked, then opens the
 * fields below it full width (narrow screens never squeeze the inputs).
 * `head` must not contain buttons: the whole line is the toggle.
 */
export function Fold({ head, children, defaultOpen = false, faded }: { head: ReactNode; children: ReactNode; defaultOpen?: boolean; faded?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`card fold ${open ? "open" : ""}`} style={faded ? { opacity: 0.55 } : undefined}>
      <button type="button" className="fold-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="fold-title">{head}</span>
        <span className="fold-caret" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
