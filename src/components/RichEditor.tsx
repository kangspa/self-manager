import "@blocknote/mantine/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ko } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { api, Attachment, Table } from "../lib/api";
import { ATT_SCHEME, parseBlocks } from "../lib/rich";
import { toast } from "./ui";

export type RichOwner = { table: Table; id: number };

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** The record files dropped into the text belong to (they become its attachments). */
  owner?: RichOwner;
  placeholder?: string;
  editable?: boolean;
  autoFocus?: boolean;
};

const useDark = () => {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => setDark(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return dark;
};

type Blocks = ReturnType<typeof parseBlocks>;
const isEmptyDoc = (blocks: { type: string; content?: unknown; children?: unknown[] }[]) =>
  blocks.length === 0 || (blocks.length === 1 && blocks[0].type === "paragraph" && (!Array.isArray(blocks[0].content) || blocks[0].content.length === 0) && !(blocks[0].children?.length));

/**
 * Notion-style editor (BlockNote): "# " heading 1, "## " heading 2, "- " list,
 * "[] " checkbox, "> " toggle, '" ' quote, "/" for every block, and files or
 * images dropped/pasted right into the text. Stores the blocks as JSON; older
 * plain text / markdown is read as markdown.
 */
export default function RichEditor({ value, onChange, owner, placeholder, editable = true, autoFocus }: Props) {
  const dark = useDark();
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const files = useRef<Map<number, Attachment>>(new Map());

  const initial = useMemo(() => parseBlocks(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useCreateBlockNote({
    initialContent: initial && initial.length ? (initial as never) : undefined,
    dictionary: { ...ko, placeholders: { ...ko.placeholders, default: placeholder ?? ko.placeholders.default } },
    // A file put into the text is uploaded as an attachment of the record;
    // the text keeps only its id.
    uploadFile: async (file: File) => {
      const o = ownerRef.current;
      if (!o) throw new Error("저장한 뒤에 파일을 넣을 수 있습니다");
      try {
        const row = await api.attUpload(o.table, o.id, file);
        return `${ATT_SCHEME}${row.id}`;
      } catch (e) {
        toast(String(e), "error");
        throw e;
      }
    },
    // Each device shows its own copy of the file (or nothing if it isn't here).
    resolveFileUrl: async (url: string) => {
      if (!url.startsWith(ATT_SCHEME)) return url;
      const id = Number(url.slice(ATT_SCHEME.length));
      const o = ownerRef.current;
      if (!files.current.has(id) && o) {
        for (const a of await api.attList(o.table, o.id).catch(() => [] as Attachment[])) files.current.set(a.id, a);
      }
      const a = files.current.get(id);
      return a?.local && a.path ? convertFileSrc(a.path) : "";
    },
  });

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
    const doc = editor.document as unknown as { type: string; content?: unknown; children?: unknown[] }[];
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

  return (
    <div className="rich" onKeyDownCapture={editable ? onKeyDownCapture : undefined}>
      <BlockNoteView editor={editor} editable={editable} theme={dark ? "dark" : "light"} onChange={emit} />
    </div>
  );
}
