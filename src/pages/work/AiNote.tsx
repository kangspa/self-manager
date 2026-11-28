import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, db, Row } from "../../lib/api";
import { useAutosave, useLoad } from "../../lib/hooks";
import { appendRich, richToMarkdown } from "../../lib/rich";
import { fmtDate, today } from "../../lib/date";
import { fmtClock, pauseRecording, startRecording, stopRecording, useRecording } from "../../lib/recordings";
import { fmtSize, LooseFiles, useAttachmentList } from "../../components/Attachments";
import { RichText } from "../../components/RichText";
import { confirmDialog, Empty, run, toast } from "../../components/ui";

export const MEETING_STATUS: Record<string, string> = { recording: "녹음 중", importing: "가져오는 중", recorded: "녹음 대기", transcribing: "받아쓰는 중", transcribed: "받아쓰기 완료", summarizing: "요약 중", done: "정리 완료", error: "오류" };

type Seg = { start: number; end: number; text: string };
const BUSY = ["transcribing", "summarizing", "importing"];

/** "- [ ] item" lines under the 할 일 heading of a summary. */
function actionItems(value: string) {
  const out: string[] = [];
  let inTodo = false;
  // The summary may have been edited into blocks since the AI wrote it.
  for (const l of richToMarkdown(value).split("\n")) {
    if (/^#{1,4}\s/.test(l)) inTodo = /할 일/.test(l);
    const m = l.match(/^\s*[-*]\s+\[ \]\s+(.*)/);
    if (inTodo && m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** An AI note by id (the block placed in a text with "/"). */
export function AiNoteById({ id, defaultOpen }: { id: number; defaultOpen?: boolean }) {
  const { data: m } = useLoad(async () => (await db.get("meetings", id)) ?? undefined, [id], ["meetings"]);
  if (m === null) return <div className="ai-note faint small">AI 노트 불러오는 중…</div>;
  if (!m) return <div className="ai-note faint small" style={{ padding: "8px 12px" }}>🎙️ 삭제된 AI 노트입니다. 이 줄은 지워도 됩니다.</div>;
  return <AiNote m={m} defaultOpen={defaultOpen} />;
}

/** Record / pause / stop, usable while the note is folded. */
function RecordControls({ m }: { m: Row }) {
  const rec = useRecording(m.id);
  const [busy, setBusy] = useState(false);
  const hasAudio = m.duration_sec > 0;
  const start = async () => {
    if (hasAudio && !(await confirmDialog("기존 녹음을 지우고 새로 녹음할까요?", true))) return;
    setBusy(true);
    try {
      await startRecording(m.id);
    } catch (e) {
      toast(`녹음을 시작할 수 없습니다: ${e}`, "error");
    }
    setBusy(false);
  };
  const end = async () => {
    setBusy(true);
    await run(() => stopRecording(m.id), "녹음을 저장했습니다");
    setBusy(false);
  };
  if (rec) {
    return (
      <span className="row nowrap rec-controls" onClick={stop}>
        {!rec.paused && <span className="rec-dot" />}
        <span className="tabnum">{rec.paused ? "일시정지 " : ""}{fmtClock(rec.seconds)}</span>
        <button className="btn sm" onClick={() => pauseRecording(m.id, !rec.paused)}>{rec.paused ? "계속" : "일시정지"}</button>
        <button className="btn sm primary" onClick={end} disabled={busy}>■ 종료</button>
      </span>
    );
  }
  return (
    <button className="btn sm rec-start" onClick={(e) => { stop(e); start(); }} disabled={busy || BUSY.includes(m.status)} title={hasAudio ? "기존 녹음을 지우고 다시 녹음" : "녹음 시작"}>
      ● {hasAudio ? "다시 녹음" : "녹음"}
    </button>
  );
}

/**
 * One AI note: a folded line (title, date, state, recording controls) that
 * opens in place into the minutes and the full transcript.
 */
export function AiNote({ m, defaultOpen }: { m: Row; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [title, setTitle] = useAutosave(m.title ?? "", (v) => db.upsert("meetings", { id: m.id, title: v }));
  const preview = richToMarkdown(m.summary_md).replace(/^#+\s.*$/gm, "").replace(/[-*]\s+(\[.\]\s+)?/g, "").split("\n").map((s: string) => s.trim()).filter(Boolean)[0];
  return (
    <div className={`ai-note ${open ? "open" : ""}`}>
      <div className="ai-note-head click" onClick={() => setOpen(!open)}>
        <span className="faint ai-note-caret">{open ? "▾" : "▸"}</span>
        <span>🎙️</span>
        <input className="bare grow ai-note-title" value={title} placeholder="AI 노트 제목" onClick={stop} onKeyDown={stop} onChange={(e) => setTitle(e.target.value)} aria-label="AI 노트 제목" />
        <span className="faint small nowrap">{fmtDate(m.date)}{m.duration_sec ? ` · ${Math.max(1, Math.round(m.duration_sec / 60))}분` : ""}</span>
        <span className={`badge ${m.status === "done" ? "ok" : m.status === "error" ? "warn" : ""}`}>{MEETING_STATUS[m.status] ?? m.status}</span>
        <RecordControls m={m} />
      </div>
      {!open && preview && <div className="faint small ellipsis ai-note-preview">{preview}</div>}
      {open && <AiNoteBody m={m} />}
    </div>
  );
}

function AiNoteBody({ m }: { m: Row }) {
  const mid = m.id;
  const [tab, setTab] = useState<"minutes" | "transcript">(m.summary_md ? "minutes" : m.transcript_json ? "transcript" : "minutes");
  const [progress, setProgress] = useState<number | null>(null);
  const [llm, setLlm] = useState<{ done: number; total: number; stage: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useAutosave(m.summary_md ?? "", (v) => db.upsert("meetings", { id: mid, summary_md: v }));
  const { data: item } = useLoad(async () => (m.work_log_id ? db.get("work_logs", m.work_log_id) : null), [m.work_log_id], ["work_logs"]);
  const files = useAttachmentList("meetings", mid);
  const audio = files.find((a) => a.role === "audio");

  useEffect(() => {
    const a = listen<{ id: number; progress: number }>("stt-progress", (e) => e.payload.id === mid && setProgress(e.payload.progress));
    const b = listen<{ id: number; done: number; total: number; stage: string }>("llm-progress", (e) => e.payload.id === mid && setLlm(e.payload));
    return () => {
      a.then((f) => f());
      b.then((f) => f());
    };
  }, [mid]);

  let segs: Seg[] = [];
  try {
    segs = JSON.parse(m.transcript_json ?? "[]");
  } catch {
    /* not transcribed */
  }
  const working = BUSY.includes(m.status);
  const items = actionItems(summary);

  const importFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "오디오", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "mp4"] }] });
    if (typeof path !== "string") return;
    setBusy(true);
    await run(() => api.meetingImport(mid, path), "오디오를 가져왔습니다");
    setBusy(false);
  };
  const toTasks = async () => {
    await db.bulk(items.map((t) => ({ table: "tasks" as const, row: { title: t, note: `회의: ${m.title}` } })));
    toast(`체크리스트에 ${items.length}개를 추가했습니다`, "ok");
  };
  // The note belongs to an item: put the summary into that item. Otherwise
  // (a project-level note) it becomes a new work record of the project.
  const toWorkLog = async () => {
    if (item) {
      await db.upsert("work_logs", { id: item.id, body: appendRich(item.body, summary) });
      toast(`'${item.title || "업무"}' 내용에 요약을 붙였습니다`, "ok");
    } else {
      await db.upsert("work_logs", { date: m.date ?? today(), project_id: m.project_id, kind: "log", title: `회의: ${m.title}`, body: summary });
      toast("업무 기록으로 추가했습니다", "ok");
    }
  };
  const download = async () => {
    if (!audio) return;
    const at = await run(() => api.attExport(audio));
    if (at) toast(`녹음 파일을 저장했습니다: ${at}`, "ok");
  };

  return (
    <div className="ai-note-panel">
      <div className="row ai-note-tools">
        <button className="btn sm" disabled={working || !(m.duration_sec > 0)} onClick={() => run(() => api.meetingTranscribe(mid), "받아쓰기를 마쳤습니다")}>① 받아쓰기</button>
        <button className="btn sm primary" disabled={working || segs.length === 0} onClick={() => run(() => api.meetingSummarize(mid), "회의록을 정리했습니다")}>② AI 요약·정리</button>
        <button className="btn sm" onClick={importFile} disabled={busy || working}>오디오 파일 가져오기</button>
        <span className="spacer" />
        <input type="date" value={m.date ?? ""} onChange={(e) => db.upsert("meetings", { id: mid, date: e.target.value })} aria-label="날짜" />
        <button className="icon-btn" aria-label="AI 노트 삭제" title="AI 노트 삭제" onClick={async () => (await confirmDialog("이 AI 노트와 녹음 파일을 삭제할까요?", true)) && api.meetingDelete(mid)}>🗑</button>
      </div>
      {m.status === "transcribing" && (
        <div className="row">
          <div className="progress grow"><div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>
          <span className="small muted">받아쓰는 중 {Math.round((progress ?? 0) * 100)}%</span>
          <button className="btn sm" onClick={() => api.meetingCancel(mid)}>취소</button>
        </div>
      )}
      {m.status === "summarizing" && (
        <div className="row">
          <div className="progress grow"><div style={{ width: `${llm && llm.total ? Math.round((llm.done / llm.total) * 100) : 5}%` }} /></div>
          <span className="small muted">{llm?.stage ?? "모델 불러오는 중…"}</span>
          <button className="btn sm" onClick={() => api.meetingCancel(mid)}>취소</button>
        </div>
      )}
      {m.status === "importing" && <div className="muted small">오디오 변환 중…</div>}
      {m.error && <div className="notice" style={{ color: "var(--danger)" }}>{m.error}</div>}

      <div className="tabs ai-note-tabs">
        <button className={`tab ${tab === "minutes" ? "on" : ""}`} onClick={() => setTab("minutes")}>회의록</button>
        <button className={`tab ${tab === "transcript" ? "on" : ""}`} onClick={() => setTab("transcript")}>전체 대화{segs.length > 0 && <span className="faint small"> {segs.length}</span>}</button>
      </div>

      {tab === "minutes" && (
        <div>
          {(items.length > 0 || summary) && (
            <div className="row" style={{ marginBottom: 6 }}>
              {items.length > 0 && <button className="btn sm" onClick={toTasks}>할 일 {items.length}개 → 체크리스트</button>}
              {summary && <button className="btn sm" onClick={toWorkLog}>{item ? "업무 내용에 요약 붙이기" : "업무 기록으로 추가"}</button>}
            </div>
          )}
          {!summary && <div className="faint small" style={{ marginBottom: 6 }}>받아쓰기 후 ‘AI 요약·정리’를 누르면 요약, 결정 사항, 할 일이 정리됩니다. 직접 적거나 고쳐도 됩니다.</div>}
          <div className="card ai-note-minutes">
            <RichText value={summary} onChange={setSummary} owner={{ table: "meetings", id: mid }} placeholder="회의록을 적거나 AI 요약을 받으세요" />
          </div>
          <LooseFiles ownerTable="meetings" ownerId={mid} texts={[summary]} />
        </div>
      )}

      {tab === "transcript" && (
        <div>
          <div className="row ai-note-audio">
            {audio ? (
              <>
                {audio.local && audio.path ? <audio className="grow" src={convertFileSrc(audio.path)} controls preload="none" /> : <span className="faint small grow">녹음 파일이 이 기기에 없습니다 (동기화 대기 또는 동기화 안 함)</span>}
                <span className="faint small nowrap">{fmtClock(m.duration_sec || 0)} · {fmtSize(audio.size)}</span>
                <button className="btn sm" disabled={!audio.local} onClick={download}>⬇ 녹음 파일 받기</button>
              </>
            ) : (
              <span className="faint small">아직 녹음이 없습니다. 위의 ● 녹음 버튼으로 시작하세요.</span>
            )}
          </div>
          {segs.length === 0 ? (
            <Empty>아직 받아쓴 내용이 없습니다</Empty>
          ) : (
            <div className="card transcript">
              {segs.map((s, i) => (
                <div key={i} className="seg-line"><span className="seg-ts">{fmtClock(s.start)}</span><span>{s.text}</span></div>
              ))}
            </div>
          )}
          <div className="faint small" style={{ marginTop: 6 }}>화자 구분은 지원하지 않습니다. 받아쓰기와 요약 모두 이 기기 안에서 처리됩니다.</div>
        </div>
      )}
    </div>
  );
}
