import "@blocknote/mantine/style.css";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ko } from "@blocknote/core/locales";
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { api, Attachment, onChange as onDbChange, Table } from "../lib/api";
import { ATT_SCHEME, fileBlock, parseBlocks, registerInserter } from "../lib/rich";
import { useDarkTheme } from "../lib/theme";
import { AttachmentEditor, fmtSize } from "./Attachments";
import { toast } from "./ui";

export type RichOwner = { table: Table; id: number };

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** The record files put into the text belong to (they become its attachments). */
  owner?: RichOwner;
  /** Creates the record on the first file when it doesn't exist yet (e.g. today's empty diary). */
  ensureOwner?: () => Promise<RichOwner>;
  /** Offered in the "/" menu: creates an AI note and returns its id (work items). */
  onAiNote?: () => Promise<number>;
  /** Fixed toolbar on top: text and background colour, styles, file button (full-screen editing). */
  toolbar?: boolean;
  placeholder?: string;
  editable?: boolean;
  autoFocus?: boolean;
};

// The AI note block shows the note itself (recording, minutes, transcript).
const AiNote = lazy(() => import("../pages/work/AiNote").then((m) => ({ default: m.AiNoteById })));
const AiNoteBlock = createReactBlockSpec(
  { type: "aiNote", propSchema: { meetingId: { default: 0 } }, content: "none" },
  {
    render: ({ block }) => (
      <div className="rich-ai-note" contentEditable={false}>
        <Suspense fallback={<div className="faint small">AI 노트 불러오는 중…</div>}>
          <AiNote id={Number(block.props.meetingId)} />
        </Suspense>
      </div>
    ),
  },
);
const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, aiNote: AiNoteBlock() } });

type Blocks = ReturnType<typeof parseBlocks>;
type Doc = { type: string; content?: unknown; children?: unknown[] }[];
const isEmptyDoc = (blocks: Doc) =>
  blocks.length === 0 || (blocks.length === 1 && blocks[0].type === "paragraph" && (!Array.isArray(blocks[0].content) || blocks[0].content.length === 0) && !(blocks[0].children?.length));

/** How a file shows its sync state; null when it syncs normally. */
function syncNote(a: Attachment): string | null {
  if (!a.sync) return a.local ? "동기화 안 함 · 이 기기에만" : "다른 기기에만 있음";
  if (!a.local && !a.on_drive) return "다른 기기에서 아직 올라오지 않음";
  return null;
}

/** Files that don't sync get a small grey note on the block (selectors by attachment id). */
function syncStyles(files: Attachment[]) {
  const marked = files.map((a) => [a, syncNote(a)] as const).filter(([, n]) => n);
  if (!marked.length) return "";
  const sel = (a: Attachment) => `.rich .bn-block-content[data-url="${ATT_SCHEME}${a.id}"]`;
  return [
    `${marked.map(([a]) => sel(a)).join(",")}{position:relative;outline:1px dashed var(--line);outline-offset:2px;border-radius:6px}`,
    `${marked.map(([a]) => `${sel(a)}::after`).join(",")}{content:var(--att-note);position:absolute;top:4px;right:4px;font-size:11px;line-height:1.4;padding:1px 6px;border-radius:4px;background:var(--bg-soft);color:var(--text-soft);pointer-events:none}`,
    ...marked.map(([a, n]) => `${sel(a)}{--att-note:"⊘ ${n}"}`),
  ].join("\n");
}

const TEXT_COLORS: [string, string, string][] = [
  ["default", "기본", "var(--text)"], ["gray", "회색", "#9b9a97"], ["brown", "갈색", "#64473a"], ["red", "빨강", "#e03e3e"], ["orange", "주황", "#d9730d"],
  ["yellow", "노랑", "#dfab01"], ["green", "초록", "#4d6461"], ["blue", "파랑", "#0b6e99"], ["purple", "보라", "#6940a5"], ["pink", "분홍", "#ad1a72"],
];
const BG_COLORS: [string, string, string][] = [
  ["default", "없음", "transparent"], ["gray", "회색", "#ebeced"], ["brown", "갈색", "#e9e5e3"], ["red", "빨강", "#fbe4e4"], ["orange", "주황", "#f6e9d9"],
  ["yellow", "노랑", "#fbf3db"], ["green", "초록", "#ddedea"], ["blue", "파랑", "#ddebf1"], ["purple", "보라", "#eae4f2"], ["pink", "분홍", "#f4dfeb"],
];
const BLOCK_TYPES: [string, string, Record<string, unknown>?][] = [
  ["paragraph", "본문"], ["heading", "제목 1", { level: 1 }], ["heading", "제목 2", { level: 2 }], ["heading", "제목 3", { level: 3 }],
  ["bulletListItem", "글머리 목록"], ["numberedListItem", "번호 목록"], ["checkListItem", "체크박스"], ["toggleListItem", "토글"], ["quote", "인용"], ["codeBlock", "코드"],
];

/**
 * Notion-style editor (BlockNote): "# " heading 1, "## " heading 2, "- " list,
 * "[] " checkbox, "> " toggle, '" ' quote, "```" code, "/" for every block, and
 * files or images dropped/pasted right where they go in the text. Stores the
 * blocks as JSON; older plain text / markdown is read as markdown.
 */
export default function RichEditor({ value, onChange, owner, ensureOwner, onAiNote, toolbar, placeholder, editable = true, autoFocus }: Props) {
  const dark = useDarkTheme();
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const ensureRef = useRef(ensureOwner);
  ensureRef.current = ensureOwner;
  const [files, setFiles] = useState<Attachment[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const limit = useRef(10);

  // The record's files: where each one is on this device, and whether it syncs.
  const ownerKey = owner ? `${owner.table}:${owner.id}` : "";
  useEffect(() => {
    if (!owner) return setFiles([]);
    const load = () => api.attList(owner.table, owner.id).then(setFiles).catch(() => {});
    load();
    api.attSummary().then((s) => (limit.current = s.limit_mb)).catch(() => {});
    return onDbChange((t) => (t === "attachments" || t === "*") && load());
  }, [ownerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    let o = ownerRef.current;
    if (!o && ensureRef.current) o = await ensureRef.current();
    if (!o) {
      const msg = "저장한 뒤에 파일을 넣을 수 있습니다";
      toast(msg, "error");
      throw new Error(msg);
    }
    try {
      const row = await api.attUpload(o.table, o.id, file);
      if (file.size > limit.current * 1024 * 1024) {
        toast(`'${file.name}'(${fmtSize(file.size)})은 동기화 기준 ${limit.current}MB를 넘어 이 기기에만 보관됩니다. 파일을 우클릭하거나 길게 누르면 바꿀 수 있습니다.`);
      }
      return row as unknown as Attachment;
    } catch (e) {
      toast(String(e), "error");
      throw e;
    }
  };

  const initial = useMemo(() => parseBlocks(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useCreateBlockNote({
    schema,
    initialContent: initial && initial.length ? (initial as never) : undefined,
    dictionary: { ...ko, placeholders: { ...ko.placeholders, default: placeholder ?? ko.placeholders.default } },
    // A file put into the text is uploaded as an attachment of the record;
    // the text keeps only its id.
    uploadFile: async (file: File) => `${ATT_SCHEME}${(await upload(file)).id}`,
    // Each device shows its own copy of the file (or nothing if it isn't here).
    resolveFileUrl: async (url: string) => {
      if (!url.startsWith(ATT_SCHEME)) return url;
      const id = Number(url.slice(ATT_SCHEME.length));
      let a = filesRef.current.find((f) => f.id === id);
      const o = ownerRef.current;
      if (!a && o) a = (await api.attList(o.table, o.id).catch(() => [] as Attachment[])).find((f) => f.id === id);
      return a?.local && a.path ? convertFileSrc(a.path) : "";
    },
  });

  // Puts a file at the cursor: into the line itself when that line is empty.
  const placeFile = (a: { id: number; name: string; mime: string | null }) => {
    const block = fileBlock(a) as never;
    const cur = editor.getTextCursorPosition().block as unknown as { type: string; content?: unknown[] };
    if (cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0) editor.updateBlock(cur as never, block);
    else editor.insertBlocks([block], cur as never, "after");
  };
  useEffect(() => (owner ? registerInserter(owner.table, owner.id, placeFile) : undefined), [ownerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Content put in by code (conversion, a change from outside) is not an edit:
  // it must not be saved back, or opening a note would rewrite it.
  const quiet = useRef(0);
  const replace = (blocks: unknown) => {
    quiet.current++;
    try {
      editor.replaceBlocks(editor.document, blocks as never);
    } finally {
      queueMicrotask(() => quiet.current--);
    }
  };

  // Plain text / markdown from before the editor: shown converted; stored as
  // blocks only once the user edits it.
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (!initial && value.trim()) {
      replace(editor.tryParseMarkdownToBlocks(value));
    }
    if (autoFocus) editor.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A change from outside (sync, another screen) while this one isn't being edited.
  useEffect(() => {
    if (value === lastEmitted.current || editor.isFocused()) return;
    lastEmitted.current = value;
    const blocks: Blocks = parseBlocks(value);
    replace(blocks ?? (value.trim() ? editor.tryParseMarkdownToBlocks(value) : []));
  }, [value, editor]);

  const emit = () => {
    if (quiet.current > 0) return;
    const doc = editor.document as unknown as Doc;
    const next = isEmptyDoc(doc) ? "" : JSON.stringify(doc);
    if (next === lastEmitted.current) return;
    lastEmitted.current = next;
    onChange(next);
  };

  // Notion's shortcuts that differ from BlockNote's: "> " makes a toggle (not
  // a quote) and '" ' makes a quote. Handled before the space is typed, so
  // BlockNote's own "> " rule never runs.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key !== " " || e.nativeEvent.isComposing) return;
    const block = editor.getTextCursorPosition().block as unknown as { type: string; content?: { type: string; text?: string }[] };
    if (block.type !== "paragraph" || !Array.isArray(block.content)) return;
    const text = block.content.map((c) => (c.type === "text" ? c.text ?? "" : "\u0000")).join("");
    const to = text === ">" ? "toggleListItem" : text === '"' ? "quote" : null;
    if (!to) return;
    e.preventDefault();
    e.stopPropagation();
    editor.updateBlock(block as never, { type: to, content: [] } as never);
  };

  // A file in the text: right click or long press opens its settings (name,
  // sync, delete), like the file cards.
  const [fileMenu, setFileMenu] = useState<number | null>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  const fileAt = (t: EventTarget | null) => {
    const el = (t as HTMLElement | null)?.closest?.(`[data-url^="${ATT_SCHEME}"]`);
    return el ? Number(el.getAttribute("data-url")!.slice(ATT_SCHEME.length)) : null;
  };
  const menuHandlers = {
    onContextMenu: (e: React.MouseEvent) => {
      const id = fileAt(e.target);
      if (id == null) return;
      e.preventDefault();
      setFileMenu(id);
    },
    onTouchStart: (e: React.TouchEvent) => {
      const id = fileAt(e.target);
      if (id == null) return;
      pressTimer.current = window.setTimeout(() => {
        navigator.vibrate?.(20);
        setFileMenu(id);
      }, 550);
    },
    onTouchEnd: () => window.clearTimeout(pressTimer.current),
    onTouchMove: () => window.clearTimeout(pressTimer.current),
  };
  const menuFile = files.find((f) => f.id === fileMenu);

  const slashItems = async (query: string) => {
    const items = getDefaultReactSlashMenuItems(editor);
    if (onAiNote) {
      items.push({
        title: "AI 노트",
        subtext: "회의 녹음 · 받아쓰기 · 요약을 이 자리에",
        aliases: ["ai", "녹음", "회의", "회의록", "노트", "note"],
        group: "업무",
        icon: <span style={{ fontSize: 18 }}>🎙️</span>,
        onItemClick: () => {
          onAiNote()
            .then((id) => insertOrUpdateBlockForSlashMenu(editor, { type: "aiNote", props: { meetingId: id } } as never))
            .catch((e) => toast(String(e), "error"));
        },
      });
    }
    return filterSuggestionItems(items, query);
  };

  return (
    <div className={`rich ${toolbar ? "rich-full" : ""}`} onKeyDownCapture={editable ? onKeyDownCapture : undefined} {...menuHandlers}>
      <style>{syncStyles(files)}</style>
      {toolbar && editable && <Toolbar editor={editor} upload={upload} place={placeFile} />}
      <BlockNoteView editor={editor} editable={editable} theme={dark ? "dark" : "light"} onChange={emit} slashMenu={false} formattingToolbar={!toolbar}>
        <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
      </BlockNoteView>
      {menuFile && <AttachmentEditor a={menuFile} limitMb={limit.current} onClose={() => setFileMenu(null)} />}
    </div>
  );
}

type Ed = BlockNoteEditor<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The full-screen editor's fixed toolbar. Buttons keep the text's selection (mousedown is not let through). */
function Toolbar({ editor, upload, place }: { editor: Ed; upload: (f: File) => Promise<Attachment>; place: (a: Attachment) => void }) {
  const [, force] = useState(0);
  const [pop, setPop] = useState<"text" | "bg" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const a = editor.onSelectionChange(() => force((x) => x + 1));
    const b = editor.onChange(() => force((x) => x + 1));
    return () => {
      a();
      b();
    };
  }, [editor]);
  const styles = editor.getActiveStyles() as Record<string, unknown>;
  const block = editor.getTextCursorPosition().block as unknown as { type: string; props?: { level?: number } };
  const typeIndex = BLOCK_TYPES.findIndex(([t, , p]) => t === block.type && (!p || p.level === block.props?.level));
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const toggle = (s: string) => {
    editor.toggleStyles({ [s]: true } as never);
    editor.focus();
  };
  const color = (kind: "textColor" | "backgroundColor", c: string) => {
    if (c === "default") editor.removeStyles({ [kind]: "" } as never);
    else editor.addStyles({ [kind]: c } as never);
    setPop(null);
    editor.focus();
  };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const f of Array.from(list)) {
      setBusy(f.name);
      try {
        place(await upload(f));
      } catch {
        /* told by upload */
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    editor.focus();
  };
  const cur = (kind: "textColor" | "backgroundColor") => (styles[kind] as string) || "default";
  return (
    <div className="rich-toolbar" onMouseDown={keep}>
      <select
        value={typeIndex < 0 ? "" : String(typeIndex)}
        onChange={(e) => {
          const [type, , props] = BLOCK_TYPES[Number(e.target.value)];
          editor.updateBlock(block as never, { type, props } as never);
          editor.focus();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label="블록 종류"
      >
        {typeIndex < 0 && <option value="">—</option>}
        {BLOCK_TYPES.map(([, label], i) => <option key={i} value={i}>{label}</option>)}
      </select>
      <span className="rich-toolbar-sep" />
      {([["bold", "B", "굵게 (Ctrl+B)"], ["italic", "I", "기울임 (Ctrl+I)"], ["underline", "U", "밑줄 (Ctrl+U)"], ["strike", "S", "취소선"], ["code", "</>", "코드"]] as const).map(([s, l, t]) => (
        <button key={s} className={`tb-btn tb-${s} ${styles[s] ? "on" : ""}`} title={t} onClick={() => toggle(s)}>{l}</button>
      ))}
      <span className="rich-toolbar-sep" />
      <span className="tb-pop-wrap">
        <button className="tb-btn" title="글자 색" onClick={() => setPop(pop === "text" ? null : "text")}>
          <span style={{ color: TEXT_COLORS.find(([k]) => k === cur("textColor"))?.[2], fontWeight: 700 }}>A</span>
          <span className="tb-under" style={{ background: TEXT_COLORS.find(([k]) => k === cur("textColor"))?.[2] }} />
        </button>
        <button className="tb-btn" title="배경 색" onClick={() => setPop(pop === "bg" ? null : "bg")}>
          <span className="tb-bg" style={{ background: BG_COLORS.find(([k]) => k === cur("backgroundColor"))?.[2] }}>A</span>
        </button>
        {pop && (
          <span className="tb-pop">
            <span className="faint small">{pop === "text" ? "글자 색" : "배경 색"}</span>
            <span className="tb-swatches">
              {(pop === "text" ? TEXT_COLORS : BG_COLORS).map(([k, label, css]) => (
                <button key={k} className={`tb-swatch ${cur(pop === "text" ? "textColor" : "backgroundColor") === k ? "on" : ""}`} title={label} onClick={() => color(pop === "text" ? "textColor" : "backgroundColor", k)}>
                  {pop === "text" ? <span style={{ color: css, fontWeight: 700 }}>A</span> : <span className="tb-bg" style={{ background: css }}>A</span>}
                </button>
              ))}
            </span>
          </span>
        )}
      </span>
      <span className="rich-toolbar-sep" />
      <button className="tb-btn wide" title="파일 첨부 (커서 위치에 들어갑니다)" onClick={() => input.current?.click()} disabled={!!busy}>
        📎 {busy ? `올리는 중: ${busy}` : "파일"}
      </button>
      <input ref={input} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
    </div>
  );
}
