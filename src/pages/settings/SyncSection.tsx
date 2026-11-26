import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, DeviceSettings, onChange, SyncStatus } from "../../lib/api";
import { fmtTs } from "../../lib/date";
import { confirmDialog, run, toast } from "../../components/ui";
import { describe } from "../../components/SyncConflict";
import FileSyncCard from "./FileSyncCard";
import ProfilesCard from "./ProfilesCard";
import { LOGIN_NEW_PROFILE } from "../../lib/profiles";

function Same({ a, b }: { a?: number | null; b?: number | null }) {
  if (!a || !b) return null;
  return a === b ? <span className="badge ok">현재 화면과 같음</span> : a > b ? <span className="badge warn">현재보다 최신 내용</span> : <span className="badge">현재보다 이전 내용</span>;
}

export default function SyncSection() {
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [dev, setDev] = useState<DeviceSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Requests finish out of order (a Drive query is slow, the others are not),
  // so each part of the screen takes only its newest answer: the status from
  // the newest request, the Drive info from the newest Drive query - and Drive
  // info only from the same login as the status shown.
  const cur = useRef<SyncStatus | null>(null);
  const issued = useRef(0);
  const shown = useRef(0);
  const driveShown = useRef(0);
  const devShown = useRef(0);
  const show = useCallback((n: number, s: SyncStatus, withDrive: boolean) => {
    const p = cur.current;
    let next = s;
    if (n > shown.current) shown.current = n;
    else if (p) next = p;
    const driveFrom = withDrive && n > driveShown.current && s.session === next.session ? s : p && p.session === next.session ? p : null;
    if (driveFrom === s) driveShown.current = n;
    next = { ...next, drive: driveFrom?.drive ?? null, drive_error: driveFrom?.drive_error ?? null };
    cur.current = next;
    setSt(next);
  }, []);
  const load = useCallback(async (withDrive: boolean) => {
    const n = ++issued.current;
    const [s, d] = await Promise.all([api.syncStatus(withDrive).catch((e) => (toast(String(e), "error"), null)), api.deviceSettings()]);
    if (s) show(n, s, withDrive);
    // Only requests that read the device settings count here (the light ones
    // on DB changes do not), so the first answer always lands.
    if (n > devShown.current) {
      devShown.current = n;
      setDev(d);
    }
  }, [show]);
  useEffect(() => {
    load(true);
    // The session can end in the background (expired login during an auto
    // sync): show the logged-out state and the 구글 로그인 button right away.
    const ended = listen("google-session-ended", () => load(false));
    // Keep the "자동 저장" time live while this screen is open.
    const off = onChange(() => {
      const n = ++issued.current;
      api.syncStatus(false).then((s) => show(n, s, false));
    });
    return () => {
      off();
      ended.then((f) => f());
    };
  }, [load, show]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    await run(fn, ok);
    setBusy(null);
    load(key.startsWith("drive") || key === "login");
  };

  // A profile just added opens here: start its Google login right away (once).
  const loaded = !!st && !!dev;
  useEffect(() => {
    if (!loaded) return;
    let pending = false;
    try {
      pending = sessionStorage.getItem(LOGIN_NEW_PROFILE) === "1";
      sessionStorage.removeItem(LOGIN_NEW_PROFILE);
    } catch {
      /* no storage: the login button is there */
    }
    if (pending && !st?.logged_in) act("login", () => api.googleLogin(), "구글 로그인 완료");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

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

      <div className={`card section ${st.logged_in ? "" : "is-disabled"}`} aria-disabled={!st.logged_in}>
        <div className="section-title">자동 백업·로드 {!st.logged_in && <span className="badge">구글 로그인 후 사용 가능</span>}</div>
        <label className="row" style={{ marginBottom: 8 }}>
          <input type="checkbox" disabled={!st.logged_in || !!busy} checked={st.logged_in && st.auto_backup} onChange={(e) => act("auto", () => api.setAuto(e.target.checked, st.auto_load), "")} />
          <span><b>자동 백업</b> — {android ? "앱이 백그라운드로 갈 때(뒤로 가기·홈 버튼)" : "창의 X 버튼으로 닫을 때"} 바뀐 내용이 있으면 드라이브에 올립니다</span>
        </label>
        <label className="row">
          <input type="checkbox" disabled={!st.logged_in || !!busy} checked={st.logged_in && st.auto_load} onChange={(e) => act("auto", () => api.setAuto(st.auto_backup, e.target.checked), "")} />
          <span><b>자동 로드</b> — {android ? "앱을 켤 때와 다시 돌아올 때" : "프로그램을 켤 때"} 드라이브의 최신 내용을 가져옵니다</span>
        </label>
        <div className="notice" style={{ marginTop: 10 }}>
          각 DB의 마지막 저장 시각으로 어느 쪽이 바뀌었는지 판단합니다. 한쪽만 바뀌었으면 그쪽 내용으로 맞추고, 양쪽 다 바뀌었으면 git처럼 합칩니다.
          같은 항목이 양쪽에서 다르게 바뀐 경우에만 <b>로컬 DB</b>와 <b>구글 드라이브</b> 중 우선할 쪽을 고르는 창이 뜹니다.
          창을 닫을 때·백그라운드로 갈 때는 묻지 않고 건너뛰며, 다음에 켤 때 묻습니다.
        </div>
      </div>

      <ProfilesCard />

      <div className="card section" id="google">
        <div className="section-title">구글 연동 {st.email && (st.logged_in ? <span className="badge ok">{st.email}</span> : <span className="badge warn">{st.email} · 다시 로그인 필요</span>)}</div>
        {!android && !dev.google.env_client && (
          <p className="notice" style={{ marginTop: 0 }}>이 빌드에는 구글 클라이언트 정보가 들어 있지 않아 로그인할 수 없습니다. 프로젝트 루트 <code>.env</code>를 채운 뒤 다시 빌드하세요.</p>
        )}
        <p className="muted small" style={{ marginTop: 0 }}>구글 계정으로 로그인하면 드라이브 백업·동기화와 구글 캘린더 연동을 쓸 수 있습니다. {android ? "PC와" : "폰과"} 같은 계정으로 로그인해야 같은 백업을 봅니다.</p>
        <div className="row" style={{ marginTop: 10 }}>
          {st.logged_in ? (
            <button className="btn" onClick={async () => (await confirmDialog("구글 로그아웃할까요? 자동 백업·로드도 꺼집니다.")) && act("logout", () => api.googleLogout(), "로그아웃했습니다")}>로그아웃</button>
          ) : (
            <button className="btn primary" disabled={!!busy || (!android && !dev.google.env_client)} onClick={() => act("login", () => api.googleLogin(), "구글 로그인 완료")}>{busy === "login" ? "브라우저에서 로그인하세요…" : "구글 로그인"}</button>
          )}
        </div>
      </div>
      <div className="faint small section">데이터 폴더: <code>{dev.data_dir}</code></div>
    </div>
  );
}
