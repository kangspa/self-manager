import { ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, ChatMessage, ChatSession, ChatStream, ChatTool } from "../lib/api";
import { confirmDialog, toast } from "../components/ui";

// The answer being made lives outside the page: it keeps going (and is shown
// again) when the user leaves the page and comes back.
/** fresh: started as a new conversation (its id comes with the first event). */
type Live = { session: number | null; fresh: boolean; question: string; text: string; tools: ChatTool[]; status: string | null };
let live: Live | null = null;
let finished = 0; // bumps when an answer ends: the page reloads its lists
const subs = new Set<() => void>();
const setLive = (v: Live | null) => {
  live = v;
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
listen<ChatStream>("chat-stream", (e) => {
  if (live) setLive({ ...live, session: e.payload.session, text: e.payload.text, tools: e.payload.tools, status: e.payload.status });
});

// The internet switch (on by default), remembered on this device.
const WEB_KEY = "chat.web";
function loadWeb() {
  try {
    return localStorage.getItem(WEB_KEY) !== "off";
  } catch {
    return true;
  }
}

async function send(session: number | null, text: string, web: boolean): Promise<number | null> {
  setLive({ session, fresh: session === null, question: text, text: "", tools: [], status: "보내는 중" });
  try {
    const r = await api.chatSend(session, text, web);
    return r.session;
  } catch (e) {
    toast(String(e), "error");
    return live?.session ?? session;
  } finally {
    finished++;
    setLive(null);
  }
}

const TOOL_ICON: Record<string, string> = { search_records: "🔎", web_search: "🌐", fetch_page: "📄" };

const EXAMPLES = ["이번 달 가계부 지출 합계 알려줘", "이번 주 일정 정리해줘", "최근 업무 기록 요약해줘", "아이작 게임 언제 얼마에 샀지?"];

/** Answer text: the small markdown subset models write, links clickable. */
function Answer({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`u${out.length}`}>{list}</ul>);
    list = [];
  };
  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,!?])/g).map((p, i) => {
      const k = `${key}-${i}`;
      if (p.startsWith("**") && p.endsWith("**")) return <b key={k}>{p.slice(2, -2)}</b>;
      if (p.length > 2 && p.startsWith("*") && p.endsWith("*")) return <i key={k}>{p.slice(1, -1)}</i>;
      const md = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      const url = md ? md[2] : /^https?:\/\//.test(p) ? p : null;
      if (url)
        return (
          <a key={k} href={url} onClick={(e) => { e.preventDefault(); openUrl(url).catch(() => {}); }}>
            {md ? md[1] : p}
          </a>
        );
      return p;
    });
  text.split("\n").forEach((l, i) => {
    const t = l.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^#{1,4}\s+(.*)/))) {
      flush();
      out.push(<h4 key={i}>{inline(m[1], `h${i}`)}</h4>);
    } else if ((m = t.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/))) {
      list.push(<li key={i}>{inline(m[1], `l${i}`)}</li>);
    } else if (!t.trim()) {
      flush();
    } else {
      flush();
      out.push(<p key={i}>{inline(t, `p${i}`)}</p>);
    }
  });
  flush();
  return <div className="chat-md">{out}</div>;
}

function Tools({ tools }: { tools: ChatTool[] }) {
  if (!tools.length) return null;
  return (
    <div className="chat-tools">
      {tools.map((t, i) => (
        <span key={i} className={`chat-tool ${t.note === "실패" ? "bad" : ""}`}>
          {TOOL_ICON[t.name] ?? "🛠"} {t.label}
          {t.note ? <span className="faint"> · {t.note}</span> : null}
        </span>
      ))}
    </div>
  );
}

/** Pages the answer's web search found or read: links to check it against. */
function Sources({ tools }: { tools: ChatTool[] }) {
  const links = tools.flatMap((t) => t.links ?? []).filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i);
  if (!links.length) return null;
  return (
    <div className="chat-sources">
      <span className="faint small">출처</span>
      {links.slice(0, 5).map((l) => (
        <a key={l.url} href={l.url} title={l.url} onClick={(e) => { e.preventDefault(); openUrl(l.url).catch(() => {}); }}>
          {l.title || l.url.split("/")[2]} <span className="faint">· {l.url.split("/")[2]}</span>
        </a>
      ))}
    </div>
  );
}

function SessionItem({ s, on, onPick, onChanged }: { s: ChatSession; on: boolean; onPick: () => void; onChanged: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = async () => {
    if (edit !== null && edit.trim() !== s.title) await api.chatRename(s.id, edit).catch((e) => toast(String(e), "error"));
    setEdit(null);
    onChanged();
  };
  const remove = async () => {
    if (!(await confirmDialog(`'${s.title}' 대화를 지울까요?`, true))) return;
    await api.chatDelete(s.id).then(onChanged, (e) => toast(String(e), "error"));
  };
  if (edit !== null)
    return (
      <div className="chat-session on">
        <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEdit(null); }} />
      </div>
    );
  return (
    <div className={`chat-session ${on ? "on" : ""}`} onClick={onPick}>
      <span className="grow ellipsis">{s.title}</span>
      <button className="icon-btn sm" aria-label="이름 바꾸기" onClick={(e) => { e.stopPropagation(); setEdit(s.title); }}>✎</button>
      <button className="icon-btn sm" aria-label="삭제" onClick={(e) => { e.stopPropagation(); remove(); }}>🗑</button>
    </div>
  );
}

export default function Chat() {
  const cur = useSyncExternalStore(subscribe, () => live);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sid, setSid] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [model, setModel] = useState<"ok" | "none" | null>(null);
  const [web, setWebState] = useState(loadWeb);
  // The button shows a state only once the app has taken it: "꺼짐" on
  // screen means no further request can leave.
  const [webBusy, setWebBusy] = useState(false);
  const setWeb = async (on: boolean) => {
    // One change at a time: a click waits for the one before it to be taken.
    setWebBusy(true);
    try {
      await api.chatSetWeb(on);
    } catch (e) {
      toast(String(e), "error");
      return;
    } finally {
      setWebBusy(false);
    }
    setWebState(on);
    try {
      localStorage.setItem(WEB_KEY, on ? "on" : "off");
    } catch {}
  };
  // The app starts with the switch on; tell it what this device chose.
  useEffect(() => {
    api.chatSetWeb(loadWeb()).catch(() => {});
  }, []);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const done = useSyncExternalStore(subscribe, () => finished);
  // Bumps whenever the user picks a conversation (or a new one): an answer
  // that ends later moves the view only if the user is still where it was sent.
  const view = useRef(0);
  // The view a new conversation was started from (it follows that one only).
  const newFrom = useRef<number | null>(null);

  const loadSessions = useCallback(() => api.chatSessions().then(setSessions).catch(() => {}), []);
  useEffect(() => {
    loadSessions();
  }, [loadSessions, done]);
  // Back on the page while an answer is being made: show that conversation.
  useEffect(() => {
    if (live?.session != null) setSid(live.session);
    else if (live?.fresh) newFrom.current = view.current;
  }, []);
  // Follow the session a new conversation got once it is created.
  useEffect(() => {
    if (cur?.fresh && cur.session != null && sid === null && newFrom.current === view.current) setSid(cur.session);
  }, [cur?.session, sid]);
  useEffect(() => {
    if (sid === null) return setMsgs([]);
    api.chatMessages(sid).then(setMsgs).catch(() => setMsgs([]));
  }, [sid, done]);
  useEffect(() => {
    Promise.all([api.deviceSettings(), api.models()])
      .then(([d, ms]) => setModel(ms.some((m) => m.kind === "llm" && m.installed && m.file === d.llm.model) ? "ok" : "none"))
      .catch(() => setModel(null));
  }, []);
  // Keep the newest text in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, cur?.text, cur?.tools.length, cur?.status]);

  const running = !!cur;
  const mine = cur && (sid !== null ? cur.session === sid : cur.fresh && cur.session === null && newFrom.current === view.current);
  const submit = async (text = draft) => {
    const t = text.trim();
    if (!t || running) return;
    setDraft("");
    const v = view.current;
    newFrom.current = sid === null ? v : null;
    const s = await send(sid, t, web);
    if (s !== null && view.current === v) setSid(s);
  };
  const pick = (id: number | null) => {
    view.current++;
    setSid(id);
    setListOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className={`chat ${listOpen ? "list-open" : ""}`}>
      <aside className="chat-side">
        <button className="btn primary chat-new" onClick={() => pick(null)}>+ 새 대화</button>
        <div className="chat-sessions">
          {sessions.map((s) => (
            <SessionItem key={s.id} s={s} on={s.id === sid} onPick={() => pick(s.id)} onChanged={() => { loadSessions(); if (!sessions.some((x) => x.id === sid)) setSid(null); }} />
          ))}
          {!sessions.length && <div className="faint small" style={{ padding: 8 }}>아직 대화가 없습니다</div>}
        </div>
        <div className="faint small chat-privacy">대화는 이 기기에만 저장되고, 답변은 이 기기의 AI 모델이 만듭니다. 인터넷 검색을 할 때만 검색어가 검색 서비스(DuckDuckGo 또는 Brave)로 보내지며, 입력창의 🌐 버튼으로 끌 수 있습니다.</div>
      </aside>
      <section className="chat-main">
        <div className="chat-head">
          <button className="btn sm chat-list-btn" onClick={() => setListOpen(!listOpen)}>☰ 대화 목록</button>
          <b className="grow ellipsis">{sessions.find((s) => s.id === sid)?.title ?? "새 대화"}</b>
        </div>
        <div className="chat-log" ref={logRef}>
          {model === "none" && (
            <div className="card chat-notice">
              챗봇은 이 기기의 텍스트 AI 모델로 답합니다. <Link to="/settings#ai">설정 › AI 모델</Link>에서 텍스트 모델(예: Qwen3.5 2B)을 내려받고 선택해 주세요.
            </div>
          )}
          {!msgs.length && !mine && (
            <div className="chat-empty">
              <div className="chat-empty-title">무엇이든 물어보세요</div>
              <div className="faint small">가계부·일정·업무·메모 같은 내 기록을 찾아보고, 필요하면 인터넷도 검색합니다.</div>
              <div className="chat-examples">
                {EXAMPLES.map((e) => (
                  <button key={e} className="chip-btn" disabled={running} onClick={() => submit(e)}>{e}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="chat-msg user"><div className="chat-bubble">{m.content}</div></div>
            ) : (
              <div key={m.id} className="chat-msg bot">
                <Tools tools={m.tools} />
                <Answer text={m.content} />
                <Sources tools={m.tools} />
              </div>
            ),
          )}
          {mine && cur && (
            <>
              {/* The question shows at once; it is in msgs only after the answer. */}
              {!(msgs[msgs.length - 1]?.role === "user" && msgs[msgs.length - 1]?.content === cur.question) && (
                <div className="chat-msg user"><div className="chat-bubble">{cur.question}</div></div>
              )}
              <div className="chat-msg bot live">
                <Tools tools={cur.tools} />
                {cur.text ? <Answer text={cur.text} /> : null}
                {cur.status && <div className="faint small chat-status"><span className="chat-dots" /> {cur.status}</div>}
              </div>
            </>
          )}
        </div>
        <div className="chat-input">
          <button
            className={`btn chat-web ${web ? "on" : ""}`}
            aria-pressed={web}
            disabled={webBusy}
            title={web ? "인터넷 검색 켜짐: 필요하면 검색·페이지 읽기를 합니다" : "인터넷 검색 꺼짐: 이 기기 안의 기록만 봅니다"}
            onClick={() => setWeb(!web)}
          >
            🌐<span className="chat-web-label">{web ? "켜짐" : "꺼짐"}</span>
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={running ? "답변을 만드는 중…" : window.matchMedia("(pointer: fine)").matches ? "메시지 입력 (Enter 보내기, Shift+Enter 줄바꿈)" : "메시지 입력"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <button className="btn" onClick={() => api.chatCancel()}>■ 멈추기</button>
          ) : (
            <button className="btn primary" disabled={!draft.trim()} onClick={() => submit()}>보내기</button>
          )}
        </div>
      </section>
    </div>
  );
}
