import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, db, Row } from "../../lib/api";
import { useAutosave, useLoad, useRows } from "../../lib/hooks";
import { MeetingRecorder } from "../../lib/recorder";
import { today } from "../../lib/date";
import { Attachments } from "../../components/Attachments";
import { confirmDialog, Empty, Field, Markdown, run, toast } from "../../components/ui";

type Seg = { start: number; end: number; text: string };

const ts = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor(t / 60) % 60).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** "- [ ] item" lines under the 할 일 heading of a summary. */
function actionItems(md: string) {
  const out: string[] = [];
  let inTodo = false;
  for (const l of md.split("\n")) {
    if (/^#{1,4}\s/.test(l)) inTodo = /할 일/.test(l);
    const m = l.match(/^\s*[-*]\s+\[ \]\s+(.*)/);
    if (inTodo && m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

function Recorder({ meeting }: { meeting: Row }) {
  const rec = useRef<MeetingRecorder | null>(null);
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);
  const hasAudio = meeting.duration_sec > 0;

  useEffect(() => () => { rec.current?.stop().catch(() => {}); }, []);

  const start = async () => {
    if (hasAudio && !(await confirmDialog("기존 녹음을 지우고 새로 녹음할까요?", true))) return;
    const r = new MeetingRecorder(meeting.id, () => force((x) => x + 1));
    try {
      await r.start();
      rec.current = r;
      force((x) => x + 1);
    } catch (e) {
      toast(`마이크를 사용할 수 없습니다: ${e}`, "error");
    }
  };
  const stop = async () => {
    if (!rec.current) return;
    setBusy(true);
    await run(() => rec.current!.stop(), "녹음을 저장했습니다");
    rec.current = null;
    setBusy(false);
  };
  const importFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "오디오", extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "mp4"] }] });
    if (typeof path === "string") {
      setBusy(true);
      await run(() => api.meetingImport(meeting.id, path), "오디오를 가져왔습니다");
      setBusy(false);
    }
  };

  const r = rec.current;
  if (r) {
    return (
      <div className="card row">
        {!r.paused && <span className="rec-dot" />}
        <b>{r.paused ? "일시정지" : "녹음 중"}</b>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{ts(r.seconds)}</span>
        <div className="progress grow" style={{ maxWidth: 160 }}><div style={{ width: `${Math.min(100, r.level * 300)}%` }} /></div>
        <span className="spacer" />
        <button className="btn" onClick={() => r.pause(!r.paused)}>{r.paused ? "계속" : "일시정지"}</button>
        <button className="btn primary" onClick={stop} disabled={busy}>■ 녹음 종료</button>
      </div>
    );
  }
  return (
    <div className="card row">
      {hasAudio ? <span>🎧 녹음 {ts(meeting.duration_sec)}</span> : <span className="muted">아직 녹음이 없습니다</span>}
      <span className="spacer" />
      <button className="btn primary" onClick={start} disabled={busy}>● {hasAudio ? "다시 녹음" : "녹음 시작"}</button>
      <button className="btn" onClick={importFile} disabled={busy}>파일 가져오기</button>
    </div>
  );
}

export default function MeetingDetail() {
  const { id } = useParams();
  const mid = Number(id);
  const nav = useNavigate();
  const { data: m } = useLoad(() => db.get("meetings", mid), [mid], ["meetings"]);
  const projects = useRows("projects", { filters: [{ col: "archived", op: "=", value: 0 }] });
  const [progress, setProgress] = useState<number | null>(null);
  const [llm, setLlm] = useState<{ done: number; total: number; stage: string } | null>(null);
  const [title, setTitle] = useAutosave(m?.title ?? "", (v) => db.upsert("meetings", { id: mid, title: v }));
  const [summary, setSummary] = useAutosave(m?.summary_md ?? "", (v) => db.upsert("meetings", { id: mid, summary_md: v }));
  const [editSummary, setEditSummary] = useState(false);

  useEffect(() => {
    const a = listen<{ id: number; progress: number }>("stt-progress", (e) => e.payload.id === mid && setProgress(e.payload.progress));
    const b = listen<{ id: number; done: number; total: number; stage: string }>("llm-progress", (e) => e.payload.id === mid && setLlm(e.payload));
    return () => { a.then((f) => f()); b.then((f) => f()); };
  }, [mid]);

  if (m === null) return <Empty>불러오는 중…</Empty>;
  if (!m) return <Empty>회의를 찾을 수 없습니다</Empty>;
  let segs: Seg[] = [];
  try { segs = JSON.parse(m.transcript_json ?? "[]"); } catch { /* not transcribed */ }
  const busy = ["transcribing", "summarizing", "importing"].includes(m.status);
  const items = actionItems(summary);

  const toTasks = async () => {
    if (!items.length) return;
    await db.bulk(items.map((t) => ({ table: "tasks" as const, row: { title: t, note: `회의: ${m.title}` } })));
    toast(`체크리스트에 ${items.length}개를 추가했습니다`, "ok");
  };
  const toWorkLog = async () => {
    await db.upsert("work_logs", { date: m.date ?? today(), project_id: m.project_id, title: `회의: ${m.title}`, body: summary });
    toast("업무 기록에 추가했습니다", "ok");
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={() => nav("/work")}>‹ 업무</button>
        <span className="spacer" />
        <button className="btn danger sm" onClick={async () => { if (await confirmDialog("회의록과 녹음 파일을 삭제할까요?", true)) { await api.meetingDelete(mid); nav("/work"); } }}>삭제</button>
      </div>
      <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="회의 제목" />
      <div className="grid3" style={{ marginTop: 12 }}>
        <Field label="날짜"><input type="date" value={m.date ?? ""} onChange={(e) => db.upsert("meetings", { id: mid, date: e.target.value })} /></Field>
        <Field label="프로젝트">
          <select value={m.project_id ?? ""} onChange={(e) => db.upsert("meetings", { id: mid, project_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">없음</option>
            {projects.rows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>

      <Recorder meeting={m} />

      <div className="row" style={{ margin: "14px 0" }}>
        <button className="btn" disabled={busy || !(m.duration_sec > 0)} onClick={() => run(() => api.meetingTranscribe(mid), "받아쓰기를 마쳤습니다")}>① 받아쓰기 (음성 → 텍스트)</button>
        <button className="btn primary" disabled={busy || segs.length === 0} onClick={() => run(() => api.meetingSummarize(mid), "회의록을 정리했습니다")}>② AI 요약·정리</button>
        {m.status === "transcribing" && (
          <div className="row grow" style={{ minWidth: 160 }}>
            <div className="progress grow"><div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>
            <span className="small muted">{Math.round((progress ?? 0) * 100)}%</span>
          </div>
        )}
        {m.status === "summarizing" && (
          <div className="row grow" style={{ minWidth: 160 }}>
            <div className="progress grow"><div style={{ width: `${llm && llm.total ? Math.round((llm.done / llm.total) * 100) : 5}%` }} /></div>
            <span className="small muted">{llm?.stage ?? "모델 불러오는 중…"}</span>
          </div>
        )}
        {(m.status === "transcribing" || m.status === "summarizing") && <button className="btn sm" onClick={() => api.meetingCancel(mid)}>취소</button>}
        {m.status === "importing" && <span className="muted small">오디오 변환 중…</span>}
      </div>
      {m.error && <div className="notice" style={{ color: "var(--danger)", marginBottom: 12 }}>{m.error}</div>}
      <div className="faint small">화자 구분은 지원하지 않습니다. 받아쓰기와 요약 모두 이 기기 안에서 처리되며, 모델은 설정 › AI 모델에서 고르고 지울 수 있습니다.</div>

      <Attachments ownerTable="meetings" ownerId={mid} title="녹음·첨부 파일" />

      <div className="section">
        <div className="section-title">
          회의록
          <span className="row">
            {items.length > 0 && <button className="btn sm" onClick={toTasks}>할 일 {items.length}개 → 체크리스트</button>}
            {summary && <button className="btn sm" onClick={toWorkLog}>업무 기록에 추가</button>}
            <button className="btn sm" onClick={() => setEditSummary(!editSummary)}>{editSummary ? "보기" : "편집"}</button>
          </span>
        </div>
        {editSummary ? (
          <textarea style={{ width: "100%", minHeight: 320 }} value={summary} onChange={(e) => setSummary(e.target.value)} />
        ) : summary ? (
          <div className="card"><Markdown text={summary} /></div>
        ) : (
          <Empty>받아쓰기 후 ‘AI 요약·정리’를 누르면 요약, 결정 사항, 할 일이 정리됩니다</Empty>
        )}
      </div>

      <div className="section">
        <div className="section-title">전체 대화 {segs.length > 0 && <span className="faint small">{segs.length}개 구간</span>}</div>
        {segs.length === 0 ? (
          <Empty>아직 받아쓴 내용이 없습니다</Empty>
        ) : (
          <div className="card transcript">
            {segs.map((s, i) => (
              <div key={i} className="seg-line"><span className="seg-ts">{ts(s.start)}</span><span>{s.text}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
