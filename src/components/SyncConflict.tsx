import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, SyncOutcome } from "../lib/api";
import { fmtTs } from "../lib/date";
import { Modal, toast } from "./ui";

type Choice = Extract<SyncOutcome, { kind: "needs_choice" }>;

export function describe(o: SyncOutcome | undefined) {
  if (!o) return "";
  switch (o.kind) {
    case "uploaded": return "드라이브에 백업했습니다";
    case "downloaded": return "드라이브의 최신 내용을 불러왔습니다";
    case "merged": return `이 기기와 드라이브의 변경을 합쳤습니다${o.conflicts ? ` (충돌 ${o.conflicts}건은 선택한 쪽으로)` : ""}`;
    case "remote_newer": return "드라이브 쪽이 더 최신입니다. ‘지금 동기화’를 누르면 불러옵니다";
    case "nothing": return "이미 최신 상태입니다";
    default: return "";
  }
}

/**
 * Asked only when the same item was changed differently on this device and on
 * Drive since the last sync. Everything else was already merged automatically.
 */
export function SyncConflictHost() {
  const [c, setC] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const off = listen<Choice>("sync-conflict", (e) => setC(e.payload));
    return () => { off.then((f) => f()); };
  }, []);
  const pick = async (prefer: "local" | "remote") => {
    setBusy(true);
    try {
      const o = await api.syncNow(prefer);
      sessionStorage.setItem("sm-toast", describe(o));
      setC(null);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (!c) return null;
  return (
    <Modal open onClose={() => !busy && setC(null)} title="동기화: 어느 쪽을 우선할까요?">
      <p style={{ marginTop: 0 }}>
        이 기기와 구글 드라이브 양쪽에서 <b>같은 항목이 서로 다르게</b> 바뀌었습니다 ({c.conflicts}건).
        겹치지 않는 변경은 양쪽 모두 합쳐지고, 겹치는 {c.conflicts}건만 고른 쪽 내용으로 저장됩니다.
      </p>
      <div className="grid2" style={{ gap: 10 }}>
        <button className="card click" style={{ textAlign: "left", font: "inherit" }} disabled={busy} onClick={() => pick("local")}>
          <b>로컬 DB 우선</b>
          <div className="muted small">이 기기에 자동 저장된 내용</div>
          <div className="small" style={{ marginTop: 6 }}>최근 저장: {fmtTs(c.local_saved_at)}</div>
        </button>
        <button className="card click" style={{ textAlign: "left", font: "inherit" }} disabled={busy} onClick={() => pick("remote")}>
          <b>구글 드라이브 우선</b>
          <div className="muted small">드라이브에 백업된 내용</div>
          <div className="small" style={{ marginTop: 6 }}>최근 저장: {fmtTs(c.drive_saved_at)}</div>
        </button>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <span className="faint small grow">{busy ? "합치는 중…" : "나중에 고르면 그때까지는 이 기기 내용을 그대로 씁니다."}</span>
        <button className="btn sm" disabled={busy} onClick={() => setC(null)}>나중에</button>
      </div>
    </Modal>
  );
}
