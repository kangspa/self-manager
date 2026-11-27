import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, DeviceSettings, ModelInfo, ModelKind, SttConfig } from "../../lib/api";
import { confirmDialog, Field, run, toast } from "../../components/ui";

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : `${Math.round(n / 1e6)}MB`);

function ModelList({ kind, models, selected, onSelect, progress, reload, android, totalRam }: {
  kind: ModelKind; models: ModelInfo[]; selected: string; onSelect: (file: string) => void; totalRam: number;
  progress: Record<string, number>; reload: () => void; android: boolean;
}) {
  const [url, setUrl] = useState("");
  const download = async (file?: string, u?: string) => {
    await run(() => api.modelDownload(kind, file, u), "내려받기를 마쳤습니다");
    reload();
  };
  const remove = async (m: ModelInfo) => {
    if (!(await confirmDialog(`${m.label} (${gb(m.size)})을(를) 삭제할까요?\n필요하면 다시 내려받을 수 있습니다.`, true))) return;
    await run(() => api.modelDelete(kind, m.file), "삭제했습니다");
    if (selected === m.file) onSelect("");
    reload();
  };
  const importFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: kind === "llm" ? "GGUF 모델" : "whisper 모델", extensions: [kind === "llm" ? "gguf" : "bin"] }] });
    if (typeof path === "string") {
      toast("모델 파일을 복사하는 중…");
      await run(() => api.modelImport(kind, path), "모델을 추가했습니다");
      reload();
    }
  };
  return (
    <>
      <div className="list" style={{ marginBottom: 10 }}>
        {models.map((m) => {
          const p = progress[m.file];
          const busy = m.downloading || p !== undefined;
          return (
            <div key={m.file} className="list-row">
              <input type="radio" name={`model-${kind}`} checked={selected === m.file} disabled={!m.installed} onChange={() => onSelect(m.file)} aria-label="사용" />
              <div className="grow">
                <b>{m.label}</b> {selected === m.file && m.installed && <span className="badge ok">사용 중</span>}
                <div className="faint small">디스크 {gb(m.size)} · 실행 시 메모리 약 {gb(m.ram)} · {m.note}</div>
                {totalRam > 0 && m.ram > totalRam * 0.7 && <div className="small" style={{ color: "var(--danger)" }}>이 기기 RAM {gb(totalRam)}에서는 부족할 수 있습니다 (다른 앱이 쓰는 메모리 포함)</div>}
                {busy && (
                  <div className="row nowrap" style={{ marginTop: 4 }}>
                    <div className="progress grow"><div style={{ width: `${Math.round((p ?? 0) * 100)}%` }} /></div>
                    <span className="small muted">{Math.round((p ?? 0) * 100)}%</span>
                  </div>
                )}
                {!busy && !m.installed && m.partial > 0 && <div className="faint small">{gb(m.partial)} 받다가 멈춤 · 이어받기 가능</div>}
              </div>
              {m.installed ? (
                <button className="btn sm danger" onClick={() => remove(m)}>삭제</button>
              ) : busy ? (
                <button className="btn sm" onClick={() => api.modelCancel(m.file)}>멈춤</button>
              ) : (
                <>
                  <button className="btn sm" onClick={() => download(m.file)}>{m.partial > 0 ? "이어받기" : `받기 ${gb(m.size)}`}</button>
                  {m.partial > 0 && <button className="icon-btn" aria-label="받던 파일 삭제" onClick={() => remove(m)}>✕</button>}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="row">
        <input className="grow" placeholder={kind === "llm" ? "다른 모델 추가: https://…/모델.gguf" : "다른 모델 추가: https://…/ggml-….bin"} value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn sm" disabled={!url.trim()} onClick={() => { download(undefined, url.trim()); setUrl(""); }}>주소로 받기</button>
        {!android && <button className="btn sm" onClick={importFile}>파일에서 추가</button>}
      </div>
    </>
  );
}

export default function AiSection() {
  const [dev, setDev] = useState<DeviceSettings | null>(null);
  const [stt, setStt] = useState<SttConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const reload = useCallback(async () => {
    const d = await api.deviceSettings();
    setDev(d);
    setStt(d.stt);
    setModels(await api.models());
  }, []);
  useEffect(() => {
    reload();
    const off = listen<{ file: string; got: number; total: number }>("model-progress", (e) => {
      const { file, got, total } = e.payload;
      setProgress((p) => (total && got >= total ? (({ [file]: _, ...rest }) => rest)(p) : { ...p, [file]: total ? got / total : 0 }));
    });
    return () => { off.then((f) => f()); };
  }, [reload]);

  if (!dev || !stt) return <div className="empty">불러오는 중…</div>;
  const android = dev.platform === "android";
  const saveStt = (next: SttConfig) => {
    setStt(next);
    api.setStt(next).catch((e) => toast(String(e), "error"));
  };
  const selectLlm = async (file: string) => {
    await api.setLlm({ model: file });
    reload();
  };

  return (
    <div>
      <div className="notice" style={{ marginBottom: 14 }}>
        회의 받아쓰기·요약과 챗봇은 모두 <b>이 기기 안에서</b> 처리합니다. 녹음과 기록은 외부 AI 서비스로 보내지 않습니다.
        모델은 기능을 쓸 때만 내려받으면 되고, 안 쓰면 삭제해서 공간을 비울 수 있습니다. 지금 모델이 차지하는 용량: <b>{gb(dev.models_size)}</b>{dev.total_ram > 0 && <> · 이 기기 RAM <b>{gb(dev.total_ram)}</b></>}. 실행 시 메모리는 추정치입니다.
      </div>
      {!dev.ai_enabled && <div className="notice" style={{ color: "var(--danger)", marginBottom: 14 }}>이 빌드에는 온디바이스 AI가 포함되지 않았습니다.</div>}
      <div className="stack">
        <div className="card">
          <div className="section-title">① 받아쓰기 모델 (음성 → 텍스트)</div>
          <ModelList kind="stt" models={models.filter((m) => m.kind === "stt")} selected={stt.model} onSelect={(f) => saveStt({ ...stt, model: f })} progress={progress} reload={reload} android={android} totalRam={dev.total_ram} />
          <div className="grid2" style={{ gap: "0 12px", marginTop: 12 }}>
            <Field label="언어"><select value={stt.language} onChange={(e) => saveStt({ ...stt, language: e.target.value })}><option value="ko">한국어</option><option value="en">영어</option><option value="auto">자동 감지</option></select></Field>
            <Field label="CPU 스레드" hint="받아쓰기·요약 공통"><input type="number" min={1} max={32} value={stt.threads} onChange={(e) => saveStt({ ...stt, threads: Number(e.target.value) || 4 })} /></Field>
          </div>
        </div>
        <div className="card">
          <div className="section-title">② 텍스트 모델 (회의록 요약 · 챗봇)</div>
          <ModelList kind="llm" models={models.filter((m) => m.kind === "llm")} selected={dev.llm.model} onSelect={selectLlm} progress={progress} reload={reload} android={android} totalRam={dev.total_ram} />
          <p className="faint small">
            폰은 Qwen3.5 2B(1.3GB)를 권장합니다. 긴 회의는 모델이 한 번에 읽을 수 있는 길이로 나눠 정리한 뒤 합치므로, 1시간 회의는 폰에서 수십 분 걸릴 수 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
}
