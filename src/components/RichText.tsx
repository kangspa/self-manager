import { lazy, Suspense } from "react";
import type { RichOwner } from "./RichEditor";
import { richPlain } from "../lib/rich";

// The editor is large; it loads the first time a note is opened, not at start.
const RichEditor = lazy(() => import("./RichEditor"));

export type { RichOwner };

/** Notion-style text field (see RichEditor). */
export function RichText(props: {
  value: string;
  onChange: (v: string) => void;
  owner?: RichOwner;
  ensureOwner?: () => Promise<RichOwner>;
  onAiNote?: () => Promise<number>;
  toolbar?: boolean;
  placeholder?: string;
  editable?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <Suspense fallback={<div className="rich rich-loading">{richPlain(props.value) || <span className="faint">{props.placeholder ?? ""}</span>}</div>}>
      <RichEditor {...props} />
    </Suspense>
  );
}
