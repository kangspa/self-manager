import { lazy, ReactNode, Suspense, useEffect, useState } from "react";
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { notifyChange } from "./lib/api";
import { ConfirmHost, toast, Toasts } from "./components/ui";
import { SyncConflictHost } from "./components/SyncConflict";
import Home from "./pages/Home";
import { setWeekStart } from "./lib/date";
import { useWeekStartSetting } from "./lib/weekStart";
import { AppLogo, DailyIcon } from "./components/icons";
import ProfileSwitcher from "./components/ProfileSwitcher";
import { useHiddenNav } from "./lib/navPrefs";
import { fmtClock, useRecordings } from "./lib/recordings";

// Route-level code splitting keeps startup fast.
const Memos = lazy(() => import("./pages/Memos"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Ledger = lazy(() => import("./pages/ledger/Ledger"));
const Goals = lazy(() => import("./pages/goals/Goals"));
const GoalDetail = lazy(() => import("./pages/goals/GoalDetail"));
const Diary = lazy(() => import("./pages/Diary"));
const Daily = lazy(() => import("./pages/Daily"));
const Calendar = lazy(() => import("./pages/Calendar"));
const Work = lazy(() => import("./pages/work/Work"));
const MeetingDetail = lazy(() => import("./pages/work/MeetingDetail"));
const Settings = lazy(() => import("./pages/settings/Settings"));
const Chat = lazy(() => import("./pages/Chat"));

export const NAV: [string, ReactNode, string][] = [
  ["/", "🏠", "홈"],
  ["/memos", "📝", "메모"],
  ["/tasks", "✅", "체크리스트"],
  ["/ledger", "💳", "가계부"],
  ["/goals", "🎯", "목표"],
  ["/diary", "📔", "일기"],
  ["/daily", <DailyIcon key="daily" />, "일일 관리"],
  ["/calendar", "🗓️", "일정"],
  ["/work", "💼", "업무"],
  ["/chat", "💬", "챗봇"],
];

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  // Menus hidden in 설정 › 일반 (their pages stay reachable by link).
  const { hidden } = useHiddenNav();
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><AppLogo size={22} /> Self Manager</div>
      <nav>
        {NAV.filter(([to]) => !hidden.includes(to)).map(([to, icon, label]) => (
          <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `nav-item ${isActive ? "on" : ""}`} onClick={onNavigate}>
            <span className="nav-icon">{icon}</span>
            {label}
          </NavLink>
        ))}
      </nav>
      {/* Accounts and settings live at the bottom (see ProfileSwitcher). */}
      <ProfileSwitcher onNavigate={onNavigate} />
    </aside>
  );
}

/** A recording keeps going on other pages: this shows it, and opens its note. */
function RecordingPill() {
  const recs = useRecordings();
  const nav = useNavigate();
  const loc = useLocation();
  if (!recs.length) return null;
  const r = recs[0];
  if (loc.pathname === `/work/meeting/${r.id}`) return null;
  return (
    <button className="rec-pill" onClick={() => nav(`/work/meeting/${r.id}`)} title="녹음 중인 AI 노트 열기">
      {!r.paused && <span className="rec-dot" />}
      <b>{r.paused ? "녹음 일시정지" : "녹음 중"}</b>
      <span className="tabnum">{fmtClock(r.seconds)}</span>
      {recs.length > 1 && <span className="faint small">외 {recs.length - 1}개</span>}
    </button>
  );
}

function Shell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  // Apply the synced week start (changed in 설정 or on another device); week
  // views subscribe to it and re-render in place.
  const { saved: weekStart } = useWeekStartSetting();
  useEffect(() => {
    if (weekStart !== null) setWeekStart(weekStart);
  }, [weekStart]);
  const title = loc.pathname.startsWith("/settings") ? "설정" : (NAV.find(([to]) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to)))?.[2] ?? "");
  return (
    <div className="app">
      <Sidebar open={drawer} onNavigate={() => setDrawer(false)} />
      {drawer && <div className="drawer-back" onClick={() => setDrawer(false)} />}
      <div className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="메뉴">☰</button>
          <span className="topbar-title">{title}</span>
        </div>
        <div className={`content ${loc.pathname.startsWith("/chat") ? "full" : ""}`}>
          <Suspense fallback={<div className="empty">불러오는 중…</div>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/memos" element={<Memos />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/ledger/*" element={<Ledger />} />
              <Route path="/goals" element={<Goals />} />
              <Route path="/goals/:id" element={<GoalDetail />} />
              <Route path="/diary" element={<Diary />} />
              <Route path="/daily" element={<Daily />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/work" element={<Work />} />
              <Route path="/work/meeting/:id" element={<MeetingDetail />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/chat" element={<Chat />} />
            </Routes>
          </Suspense>
        </div>
      </div>
      <RecordingPill />
    </div>
  );
}

function useBackendEvents() {
  useEffect(() => {
    const offs: Promise<() => void>[] = [];
    // The live DB content was replaced (manual / Drive load, merge): every view
    // re-reads its data in place instead of reloading the page, so whatever is
    // being typed stays (autosave drafts keep their edits and save them on top;
    // ids are unique across devices, and a save to a row deleted meanwhile is dropped).
    offs.push(listen<string>("db-replaced", (e) => {
      notifyChange("*");
      toast(e.payload === "drive" ? "드라이브 DB를 불러왔습니다" : e.payload === "merge" ? "이 기기와 드라이브의 변경을 합쳤습니다" : "수동 저장 DB를 불러왔습니다", "ok");
    }));
    // Backend-side writes (meeting pipeline) don't pass through the JS change bus.
    offs.push(listen("meeting-updated", () => { notifyChange("meetings"); notifyChange("attachments"); }));
    // Background file sync finished: refresh "동기화됨 / 받는 중" labels.
    offs.push(listen("files-synced", () => notifyChange("attachments")));
    offs.push(listen("switch-backup", () => toast("계정을 바꾸기 전에 지금 계정의 변경을 드라이브에 백업합니다…")));
    offs.push(listen<string>("sync-error", (e) => toast(e.payload, "error")));
    offs.push(listen<number>("notif-imported", (e) => e.payload > 0 && toast(`알림에서 지출 ${e.payload}건을 가계부에 추가했습니다`, "ok")));
    return () => offs.forEach((p) => p.then((f) => f()));
  }, []);
}

export default function App() {
  useBackendEvents();
  return (
    <HashRouter>
      <Shell />
      <Toasts />
      <ConfirmHost />
      <SyncConflictHost />
    </HashRouter>
  );
}
