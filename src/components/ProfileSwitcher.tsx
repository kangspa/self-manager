import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { api, notifyChange, ProfileInfo, ProfileList } from "../lib/api";
import { addProfile, profileLabel, switchProfile } from "../lib/profiles";
import { confirmDialog, toast } from "./ui";

/** Google picture when the account has one, else its initial. */
function Avatar({ p, small }: { p?: ProfileInfo; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const label = p ? profileLabel(p) : "…";
  if (p?.picture && !broken) {
    return <img className={`profile-avatar img ${small ? "sm" : ""}`} src={p.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return <span className={`profile-avatar ${small ? "sm" : ""}`}>{label.trim().charAt(0).toUpperCase() || "?"}</span>;
}

/**
 * Account menu at the bottom of the sidebar: the current account (Google
 * picture), and above it on click the other accounts, adding one, logging in
 * or out, and the settings.
 */
export default function ProfileSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const [list, setList] = useState<ProfileList | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = () => api.profileList().then(setList).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!open) return;
    load();
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const current = list?.profiles.find((p) => p.active);
  const others = list?.profiles.filter((p) => !p.active) ?? [];
  const go = async (fn: () => Promise<unknown>, reloads: boolean) => {
    setBusy(true);
    try {
      await fn();
      if (!reloads) {
        await load();
        notifyChange("*"); // the sync screen and others show the new login state
        setBusy(false);
      }
    } catch (e) {
      // Busy (a sync, recording...) or another error: stay as it is.
      toast(String(e), "error");
      setBusy(false);
    }
  };

  return (
    <div className="profile" ref={box}>
      {open && (
        <div className="profile-menu" role="menu">
          {others.map((p) => (
            <button key={p.id} role="menuitem" className="profile-item" disabled={busy} onClick={() => go(() => switchProfile(p.id), true)}>
              <Avatar p={p} small />
              <span className="profile-name">
                <span className="profile-label" title={profileLabel(p)}>{profileLabel(p)}</span>
                {!p.logged_in && <span className="profile-sub">로그인 안 됨</span>}
              </span>
            </button>
          ))}
          <button role="menuitem" className="profile-item add" disabled={busy} onClick={() => go(addProfile, true)}>
            <span className="profile-avatar sm">＋</span>
            <span className="profile-name">다른 계정 추가</span>
          </button>
          <div className="profile-sep" />
          {current && !current.logged_in && (
            <button role="menuitem" className="profile-item add" disabled={busy} onClick={() => go(() => api.googleLogin().then(() => toast("구글 로그인 완료", "ok")), false)}>
              <span className="profile-avatar sm">G</span>
              <span className="profile-name">{busy ? "브라우저에서 로그인하세요…" : "구글 로그인"}</span>
            </button>
          )}
          {current?.logged_in && (
            <button
              role="menuitem"
              className="profile-item add"
              disabled={busy}
              onClick={async () => (await confirmDialog("구글 로그아웃할까요? 자동 백업·로드도 꺼집니다.")) && go(() => api.googleLogout(), false)}
            >
              <span className="profile-avatar sm">⎋</span>
              <span className="profile-name">로그아웃</span>
            </button>
          )}
          <NavLink
            to="/settings"
            role="menuitem"
            className="profile-item add"
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
          >
            <span className="profile-avatar sm">⚙</span>
            <span className="profile-name">설정</span>
          </NavLink>
        </div>
      )}
      <button className="profile-current" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!current}>
        <Avatar p={current} />
        <span className="profile-name">
          <span className="profile-label" title={current ? profileLabel(current) : undefined}>{current ? profileLabel(current) : "불러오는 중…"}</span>
          {current && !current.logged_in && <span className="profile-sub">로그인 안 됨</span>}
        </span>
        <span className="profile-caret">{open ? "▾" : "▴"}</span>
      </button>
    </div>
  );
}
