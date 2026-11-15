import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, onChange } from "../../lib/api";
import { fmtSize } from "../../components/Attachments";
import { run, toast } from "../../components/ui";

type Summary = Awaited<ReturnType<typeof api.attSummary>>;

/** Size limit for syncing attached files + a manual "sync files now". */
export default function FileSyncCard({ loggedIn }: { loggedIn: boolean }) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [mb, setMb] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const load = () => api.attSummary().then((s) => { setSum(s); setMb((cur) => cur || String(s.limit_mb)); }).catch((e) => toast(String(e), "error"));
  useEffect(() => {
    load();
    const off1 = onChange((t) => (t === "attachments" || t === "*") && load());
    const off2 = listen<{ stage: string; name: string; done: number; total: number }>("files-progress", (e) =>
      setProgress(`${e.payload.stage === "upload" ? "올리는 중" : "받는 중"}: ${e.payload.name} (${e.payload.done + 1}/${e.payload.total})`),
    );
    const off3 = listen("files-synced", () => { setProgress(null); load(); });
    return () => { off1(); off2.then((f) => f()); off3.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveLimit = async () => {
    const v = Number(mb);
    if (!Number.isFinite(v) || v < 0) return toast("0 이상의 숫자를 입력하세요", "error");
    await run(() => api.attSetLimit(v), `${v}MB 이하 파일을 동기화합니다`);
    load();
  };

  return (
    <div className="card section">
      <div className="section-title">첨부 파일 동기화</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span>이 크기 이하 파일만 드라이브에 동기화</span>
        <input type="number" min={0} step={1} value={mb} onChange={(e) => setMb(e.target.value)} style={{ width: 90 }} />
        <span>MB</span>
        <button className="btn sm" onClick={saveLimit} disabled={!sum || Number(mb) === sum.limit_mb}>적용</button>
      </div>
      <p className="faint small" style={{ marginTop: 0 }}>
        기본값은 이 기준을 따르고, 파일마다 <b>길게 누르기(우클릭)</b>로 "항상 동기화 / 동기화 안 함"을 따로 정할 수 있습니다.
        이 기준은 모든 기기에 함께 적용됩니다. 동기화하지 않는 파일은 다른 기기에서 이름과 "동기화되지 않음"만 보입니다.
      </p>
      {sum && (
        <div className="kv" style={{ marginBottom: 10 }}>
          <span>첨부 파일</span><span>{sum.files}개</span>
          <span>동기화 대상</span><span>{sum.synced}개 · {fmtSize(sum.synced_bytes)}</span>
          <span>이 기기에만 보관</span><span>{sum.local_only}개</span>
          <span>이 기기에 없음</span><span>{sum.not_here}개</span>
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={busy || !loggedIn} onClick={async () => { setBusy(true); const r = await run(() => api.filesSync()); setBusy(false); setProgress(null); if (r) toast(`파일 동기화: 올림 ${r.uploaded} · 받음 ${r.downloaded} · 드라이브에서 정리 ${r.removed_from_drive}${r.failed.length ? `
실패 ${r.failed.length}건 (다음 동기화 때 다시 시도): ${r.failed[0]}` : ""}`, r.failed.length ? "error" : "ok"); load(); }}>
          {busy ? "파일 동기화 중…" : "📁 파일 지금 동기화"}
        </button>
        {progress && <span className="small muted">{progress}</span>}
      </div>
      <p className="faint small">
        파일은 내용(해시)으로 구분해서, 드라이브와 이 기기 중 <b>없는 쪽에만</b> 올리거나 받습니다. 이미 있는 파일은 다시 전송하지 않습니다.
        DB 동기화가 끝나면 백그라운드에서 자동으로 진행됩니다.
      </p>
    </div>
  );
}
