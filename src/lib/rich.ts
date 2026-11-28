// Stored form of rich text (notes, memos, diary, ...).
//
// A field holds either the editor's blocks as JSON, or - written before the
// editor existed, or by the AI summary - plain text / markdown, which the
// editor reads as markdown the first time it opens. Files placed in the text
// are stored as `sm-att://<attachment id>`: the attachment belongs to the
// record, and each device resolves the id to its own local file.

export const ATT_SCHEME = "sm-att://";

export type RichBlock = { type?: string; props?: Record<string, unknown>; content?: unknown; children?: RichBlock[] };

/** The blocks of a stored value, or null when it is plain text / markdown. */
export function parseBlocks(value: string | null | undefined): RichBlock[] | null {
  const v = (value ?? "").trim();
  if (!v.startsWith("[")) return null;
  try {
    const blocks = JSON.parse(v);
    return Array.isArray(blocks) && blocks.every((b) => b && typeof b === "object" && typeof b.type === "string") ? blocks : null;
  } catch {
    return null;
  }
}

function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const o = c as { type?: string; text?: string; content?: unknown };
      if (o.type === "text") return o.text ?? "";
      if (o.type === "link") return inlineText(o.content);
      return "";
    })
    .join("");
}

/** Readable text of a stored value: for previews, search hints and the AI. */
export function richPlain(value: string | null | undefined): string {
  const blocks = parseBlocks(value);
  if (!blocks) return value ?? "";
  const out: string[] = [];
  const walk = (bs: RichBlock[], depth: number) => {
    for (const b of bs) {
      const pad = "  ".repeat(depth);
      if (b.type === "image") out.push(`${pad}[이미지${b.props?.name ? `: ${b.props.name}` : ""}]`);
      else if (b.type === "aiNote") out.push(`${pad}[AI 노트]`);
      else if (b.type === "file" || b.type === "video" || b.type === "audio") out.push(`${pad}[파일${b.props?.name ? `: ${b.props.name}` : ""}]`);
      else if (b.type === "table") out.push(`${pad}[표]`);
      else {
        const t = inlineText(b.content);
        const mark = b.type === "checkListItem" ? (b.props?.checked ? "[x] " : "[ ] ") : b.type === "bulletListItem" || b.type === "toggleListItem" ? "- " : "";
        if (t || mark) out.push(pad + mark + t);
      }
      if (b.children?.length) walk(b.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out.join("\n");
}

/** First non-empty line, for list previews. */
export const richFirstLine = (value: string | null | undefined) =>
  richPlain(value)
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

/** A stored value as simple markdown (blocks converted; text returned as is). */
export function richToMarkdown(value: string | null | undefined): string {
  const blocks = parseBlocks(value);
  if (!blocks) return value ?? "";
  const out: string[] = [];
  const walk = (bs: RichBlock[], depth: number) => {
    let n = 0;
    for (const b of bs) {
      const pad = "  ".repeat(depth);
      const t = inlineText(b.content);
      switch (b.type) {
        case "heading": out.push(`${"#".repeat(Number(b.props?.level) || 1)} ${t}`); break;
        case "checkListItem": out.push(`${pad}- [${b.props?.checked ? "x" : " "}] ${t}`); break;
        case "bulletListItem": case "toggleListItem": out.push(`${pad}- ${t}`); break;
        case "numberedListItem": out.push(`${pad}${++n}. ${t}`); break;
        case "quote": out.push(`> ${t}`); break;
        case "image": out.push(`![${b.props?.name ?? ""}](${b.props?.url ?? ""})`); break;
        case "file": case "video": case "audio": out.push(`[${b.props?.name ?? "파일"}](${b.props?.url ?? ""})`); break;
        case "aiNote": out.push(`${pad}[AI 노트]`); break;
        default: out.push(pad + t);
      }
      if (b.type !== "numberedListItem") n = 0;
      if (b.children?.length) walk(b.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out.join("\n");
}

function eachBlock(value: string | null | undefined, f: (b: RichBlock) => void) {
  const walk = (bs: RichBlock[]) => bs.forEach((b) => (f(b), b.children?.length && walk(b.children)));
  walk(parseBlocks(value) ?? []);
}

/** Attachment ids of the files placed in a stored value. */
export function richFileIds(value: string | null | undefined): number[] {
  const ids: number[] = [];
  eachBlock(value, (b) => {
    const url = b.props?.url;
    if (typeof url === "string" && url.startsWith(ATT_SCHEME)) ids.push(Number(url.slice(ATT_SCHEME.length)));
  });
  return ids;
}

/** AI notes (meeting ids) placed in a stored value with the "/" menu. */
export function richNoteIds(value: string | null | undefined): number[] {
  const ids: number[] = [];
  eachBlock(value, (b) => {
    if (b.type === "aiNote" && Number(b.props?.meetingId)) ids.push(Number(b.props!.meetingId));
  });
  return ids;
}

/** The editor block that shows an attachment. */
export function fileBlock(a: { id: number; name: string; mime: string | null }) {
  const m = a.mime ?? "";
  const type = m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : m.startsWith("audio/") ? "audio" : "file";
  return { type, props: { url: `${ATT_SCHEME}${a.id}`, name: a.name } };
}

// Open editors by the record they write into, so a file listed outside the
// text can be put into it ("본문에 넣기"). The one used last wins when a
// record has several (a diary's fields).
type Inserter = (a: { id: number; name: string; mime: string | null }) => void;
const inserters = new Map<string, Inserter[]>();
const ownerKey = (table: string, id: number) => `${table}:${id}`;

export function registerInserter(table: string, id: number, f: Inserter) {
  const k = ownerKey(table, id);
  inserters.set(k, [...(inserters.get(k) ?? []).filter((x) => x !== f), f]);
  return () => {
    inserters.set(k, (inserters.get(k) ?? []).filter((x) => x !== f));
  };
}

export function insertIntoText(table: string, id: number, a: { id: number; name: string; mime: string | null }) {
  const list = inserters.get(ownerKey(table, id)) ?? [];
  const f = list[list.length - 1];
  if (!f) return false;
  f(a);
  return true;
}

/** Simple markdown lines as blocks (headings, lists, checkboxes, quotes, text). */
function markdownToBlocks(md: string): RichBlock[] {
  const text = (s: string) => (s ? [{ type: "text", text: s, styles: {} }] : []);
  return md.split("\n").map((line): RichBlock => {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) return { type: "heading", props: { level: m[1].length }, content: text(m[2]) };
    if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/))) return { type: "checkListItem", props: { checked: m[1] !== " " }, content: text(m[2]) };
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) return { type: "bulletListItem", content: text(m[1]) };
    if ((m = line.match(/^\s*\d+\.\s+(.*)/))) return { type: "numberedListItem", content: text(m[1]) };
    if ((m = line.match(/^>\s?(.*)/))) return { type: "quote", content: text(m[1]) };
    return { type: "paragraph", content: text(line) };
  });
}

/**
 * `base` with `addition` after it. Both may be blocks or text; once either is
 * blocks the result is blocks (the text side converted), so nothing turns
 * into a JSON string inside plain text.
 */
export function appendRich(base: string | null | undefined, addition: string): string {
  if (!(base ?? "").trim()) return addition;
  const a = parseBlocks(base);
  const b = parseBlocks(addition);
  if (!a && !b) return `${base}\n\n${addition}`;
  return JSON.stringify([...(a ?? markdownToBlocks(base ?? "")), { type: "paragraph", content: [] }, ...(b ?? markdownToBlocks(addition))]);
}
