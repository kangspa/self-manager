import { useCallback, useEffect, useState } from "react";
import { api, DeviceSettings, onChange, SyncStatus } from "../../lib/api";
import { fmtTs } from "../../lib/date";
import { confirmDialog, Field, run, toast } from "../../components/ui";
import { describe } from "../../components/SyncConflict";
import FileSyncCard from "./FileSyncCard";

function Same({ a, b }: { a?: number | null; b?: number | null }) {
  if (!a || !b) return null;
  return a === b ? <span className="badge ok">현재 화면과 같음</span> : a > b ? <span className="badge warn">현재보다 최신 내용</span> : <span className="badge">현재보다 이전 내용</span>;
}

export default function SyncSection() {
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [dev, setDev] = useState<DeviceSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cid, setCid] = useState("");
  const [secret, setSecret] = useState("");

  const load = useCallback(async (withDrive: boolean) => {
    const [s, d] = await Promise.all([api.syncStatus(withDrive).catch((e) => (toast(String(e), "error"), null)), api.deviceSettings()]);
    // Without a Drive query keep the last known Drive info on screen.
    if (s) setSt((p) => (withDrive || !p ? s : { ...s, drive: p.drive, drive_error: p.drive_error }));
    setDev(d);
    setCid(d.google.client_id);
  }, []);
  useEffect(() => {
    load(true);
    // Keep the "자동 저장" time live while this screen is open.
    return onChange(() => api.syncStatus(false).then((s) => setSt((p) => (p ? { ...s, drive: p.drive, drive_error: p.drive_error } : s))));
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    await run(fn, ok);
    setBusy(null);
    load(key.startsWith("drive") || key === "login");
  };

  if (!st || !dev) return <div className="empty">불러오는 중…</div>;
  const android = dev.platform === "android";

  return (
    <div>
      <div className="section-title">저장 상태</div>
      <div className="card tbl-wrap">
        <table className="sync-table">
          <thead>
            <tr><th>구분</th><th>저장 시각</th><th>담긴 내용의 시각</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><b>자동 저장</b><div className="faint small">현재 화면에 보이는 내용</div></td>
              <td>{fmtTs(st.auto_saved_at)}</td>
              <td>{fmtTs(st.auto_saved_at)}</td>
            </tr>
            <tr>
              <td><b>수동 저장</b><div className="faint small">이 기기에 직접 저장한 DB</div></td>
              <td>{fmtTs(st.manual_saved_at)}</td>
              <td>{st.manual_saved_at ? fmtTs(st.manual_local_modified) : "없음"} <Same a={st.manual_saved_at ? st.manual_local_modified : null} b={st.auto_saved_at} /></td>
            </tr>
            <tr>
              <td><b>구글 드라이브</b><div className="faint small">{st.drive?.device ? `${st.drive.device === "android" ? "폰" : "PC"}에서 올림` : "백업 파일"}</div></td>
              <td>{!st.logged_in ? "로그인 필요" : st.drive_error ? <span style={{ color: "var(--danger)" }}>확인 실패</span> : st.drive?.modified_time ? fmtTs(new Date(st.drive.modified_time).getTime()) : "없음"}</td>
              <td>{st.drive ? fmtTs(st.drive.local_modified) : "없음"} <Same a={st.drive?.local_modified} b={st.auto_saved_at} /></td>
            </tr>
          </tbody>
        </table>
        {st.drive_error && <div className="small" style={{ color: "var(--danger)", marginTop: 6 }}>{st.drive_error}</div>}
        {st.logged_in && st.unsynced && <div className="small muted" style={{ marginTop: 6 }}>이 기기에 드라이브로 아직 백업하지 않은 변경이 있습니다.</div>}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => load(true)}>새로고침</button>
        </div>
      </div>

      <div className="grid2 section">
        <div className="card">
          <div className="section-title">저장</div>
          <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => act("manual", () => api.manualSave(), "현재 내용을 수동 저장했습니다")}>💾 이 기기에 수동 저장</button>
            <button className="btn primary" disabled={!!busy || !st.logged_in} onClick={() => act("drive-up", async () => { const o = await api.driveBackup(); if (o.kind !== "needs_choice") toast(describe(o), "ok"); }, "")}>{busy === "drive-up" ? "백업 중…" : "☁️ 드라이브에 백업"}</button>
            <button className="btn" disabled={!!busy || !st.logged_in} onClick={() => act("drive-sync", async () => { const o = await api.syncNow(); if (o.kind !== "needs_choice") toast(describe(o), "ok"); }, "")}>{busy === "drive-sync" ? "동기화 중…" : "🔄 지금 동기화"}</button>
          </div>
          <div className="faint small" style={{ marginTop: 6 }}>
            드라이브에도 다른 기기의 새 변경이 있으면 덮어쓰지 않고 양쪽을 합친 뒤 올립니다. 같은 항목이 양쪽에서 다르게 바뀐 경우에만 어느 쪽을 우선할지 묻습니다.
          </div>
        </div>
        <div className="card">
          <div className="section-title">불러오기 (현재 내용 덮어쓰기)</div>
          <div className="row">
            <button className="btn" disabled={!!busy || !st.manual_saved_at} onClick={async () => (await confirmDialog(`수동 저장본(${fmtTs(st.manual_saved_at)})으로 현재 내용을 덮어씁니다.\n지금 화면의 내용은 사라집니다. 계속할까요?`, true)) && act("load-manual", () => api.loadManual(), "")}>수동 저장본 불러오기</button>
            <button className="btn" disabled={!!busy || !st.drive} onClick={async () => (await confirmDialog(`드라이브 백업(${fmtTs(st.drive?.local_modified)} 내용)으로 현재 내용을 덮어씁니다.\n지금 화면의 내용은 사라집니다. 계속할까요?`, true)) && act("drive-down", () => api.driveLoad(), "")}>{busy === "drive-down" ? "불러오는 중…" : "드라이브 백업 불러오기"}</button>
          </div>
          <div className="faint small" style={{ marginTop: 6 }}>덮어쓰기 직전 내용은 데이터 폴더의 <code>live.db.before-load</code>에 한 벌 남겨 둡니다.</div>
        </div>
      </div>

      <FileSyncCard loggedIn={st.logged_in} />

      <div className="card section">
        <div className="section-title">자동 백업·로드 {!st.logged_in && <span className="badge">구글 로그인 후 사용 가능</span>}</div>
        <label className="row" style={{ marginBottom: 8 }}>
          <input type="checkbox" disabled={!st.logged_in} checked={st.auto_backup} onChange={(e) => act("auto", () => api.setAuto(e.target.checked, st.auto_load), "")} />
          <span><b>자동 백업</b> — {android ? "앱이 백그라운드로 갈 때(뒤로 가기·홈 버튼)" : "창의 X 버튼으로 닫을 때"} 바뀐 내용이 있으면 드라이브에 올립니다</span>
        </label>
        <label className="row">
          <input type="checkbox" disabled={!st.logged_in} checked={st.auto_load} onChange={(e) => act("auto", () => api.setAuto(st.auto_backup, e.target.checked), "")} />
          <span><b>자동 로드</b> — {android ? "앱을 켤 때와 다시 돌아올 때" : "프로그램을 켤 때"} 드라이브의 최신 내용을 가져옵니다</span>
        </label>
        <div className="notice" style={{ marginTop: 10 }}>
          각 DB의 마지막 저장 시각으로 어느 쪽이 바뀌었는지 판단합니다. 한쪽만 바뀌었으면 그쪽 내용으로 맞추고, 양쪽 다 바뀌었으면 git처럼 합칩니다.
          같은 항목이 양쪽에서 다르게 바뀐 경우에만 <b>로컬 DB</b>와 <b>구글 드라이브</b> 중 우선할 쪽을 고르는 창이 뜹니다.
          창을 닫을 때·백그라운드로 갈 때는 묻지 않고 건너뛰며, 다음에 켤 때 묻습니다.
        </div>
      </div>

      <div className="card section" id="google">
        <div className="section-title">구글 연동 {st.email && <span className="badge ok">{st.email}</span>}</div>
        {!android && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {dev.google.env_client
                ? <>빌드할 때 <code>.env</code>의 <code>GOOGLE_CLIENT_ID</code>{dev.google.env_secret ? "와 보안 비밀" : ""}이 들어가 있어 입력하지 않아도 됩니다. 아래 칸은 이 기기에서만 다른 클라이언트를 쓸 때 채우세요.</>
                : <>Google Cloud 콘솔에서 OAuth 클라이언트를 만든 뒤 ID와 보안 비밀을 넣으세요.</>}
              {" "}클라이언트 유형은 반드시 <b>데스크톱 앱</b>이어야 합니다. 자세한 순서는 <code>docs/google-setup.md</code>.
            </p>
            <div className="grid2" style={{ gap: "0 12px" }}>
              <Field label="클라이언트 ID"><input value={cid} onChange={(e) => setCid(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" /></Field>
              <Field label="클라이언트 보안 비밀" hint={dev.google.has_secret ? "저장됨 (바꾸려면 새로 입력)" : undefined}><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
            </div>
            <button className="btn sm" onClick={() => act("client", () => api.googleSetClient(cid, secret || ""), "저장했습니다")} disabled={!cid && !secret}>클라이언트 정보 저장</button>
          </>
        )}
        {android && <p className="muted small" style={{ marginTop: 0 }}>PC와 같은 Google Cloud 프로젝트의 Android OAuth 클라이언트를 사용합니다. 같은 구글 계정으로 로그인해야 PC와 같은 백업을 봅니다.</p>}
        <div className="row" style={{ marginTop: 10 }}>
          {st.logged_in ? (
            <button className="btn" onClick={async () => (await confirmDialog("구글 로그아웃할까요? 자동 백업·로드도 꺼집니다.")) && act("logout", () => api.googleLogout(), "로그아웃했습니다")}>로그아웃</button>
          ) : (
            <button className="btn primary" disabled={!!busy || (!android && !dev.google.client_id && !dev.google.env_client)} onClick={() => act("login", () => api.googleLogin(), "구글 로그인 완료")}>{busy === "login" ? "브라우저에서 로그인하세요…" : "구글 로그인"}</button>
          )}
        </div>
      </div>
      <div className="faint small section">데이터 폴더: <code>{dev.data_dir}</code></div>
    </div>
  );
}
