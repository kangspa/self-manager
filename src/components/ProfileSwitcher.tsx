import { useEffect, useRef, useState } from "react";
import { api, ProfileList } from "../lib/api";
import { addProfile, profileLabel, switchProfile } from "../lib/profiles";
import { toast } from "./ui";

/** Current account at the top of the sidebar; opens the other accounts to switch to. */
export default function ProfileSwitcher() {
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
  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn(); // reloads the page on success
    } catch (e) {
      // Busy (a sync, recording...) or another error: stay on this profile.
      toast(String(e), "error");
      setBusy(false);
    }
  };
  const initial = (s: string) => s.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="profile" ref={box}>
      <button className="profile-current" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!current}>
        <span className="profile-avatar">{current ? initial(profileLabel(current)) : "…"}</span>
        <span className="profile-name">
          <span className="profile-label" title={current ? profileLabel(current) : undefined}>{current ? profileLabel(current) : "불러오는 중…"}</span>
          {current && !current.logged_in && <span className="profile-sub">로그인 안 됨</span>}
        </span>
        <span className="profile-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          {others.map((p) => (
            <button key={p.id} role="menuitem" className="profile-item" disabled={busy} onClick={() => go(() => switchProfile(p.id))}>
              <span className="profile-avatar sm">{initial(profileLabel(p))}</span>
              <span className="profile-name">
                <span className="profile-label" title={profileLabel(p)}>{profileLabel(p)}</span>
                {!p.logged_in && <span className="profile-sub">로그인 안 됨</span>}
              </span>
            </button>
          ))}
          <button role="menuitem" className="profile-item add" disabled={busy} onClick={() => go(addProfile)}>
            <span className="profile-avatar sm">＋</span>
            <span className="profile-name">다른 계정 추가</span>
          </button>
        </div>
      )}
    </div>
  );
}
