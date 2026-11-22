import { lazy, ReactNode, Suspense, useEffect, useState } from "react";
import { HashRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { notifyChange } from "./lib/api";
import { ConfirmHost, toast, Toasts } from "./components/ui";
import { SyncConflictHost } from "./components/SyncConflict";
import Home from "./pages/Home";
import { AppLogo, DailyIcon } from "./components/icons";

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
  ["/settings", "⚙️", "설정"],
];

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><AppLogo size={22} /> Self Manager</div>
      <nav>
        {NAV.map(([to, icon, label]) => (
          <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `nav-item ${isActive ? "on" : ""}`} onClick={onNavigate}>
            <span className="nav-icon">{icon}</span>
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

function Shell() {
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const title = NAV.find(([to]) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to)))?.[2] ?? "";
  return (
    <div className="app">
      <Sidebar open={drawer} onNavigate={() => setDrawer(false)} />
      {drawer && <div className="drawer-back" onClick={() => setDrawer(false)} />}
      <div className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="메뉴">☰</button>
          <span className="topbar-title">{title}</span>
        </div>
        <div className="content">
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
            </Routes>
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function useBackendEvents() {
  useEffect(() => {
    const offs: Promise<() => void>[] = [];
    // The live DB file was swapped (manual / Drive load): rebuild every view from it.
    offs.push(listen<string>("db-replaced", (e) => {
      if (!sessionStorage.getItem("sm-toast")) {
        sessionStorage.setItem("sm-toast", e.payload === "drive" ? "드라이브 DB를 불러왔습니다" : e.payload === "merge" ? "이 기기와 드라이브의 변경을 합쳤습니다" : "수동 저장 DB를 불러왔습니다");
      }
      window.location.reload();
    }));
    // Backend-side writes (meeting pipeline) don't pass through the JS change bus.
    offs.push(listen("meeting-updated", () => { notifyChange("meetings"); notifyChange("attachments"); }));
    // Background file sync finished: refresh "동기화됨 / 받는 중" labels.
    offs.push(listen("files-synced", () => notifyChange("attachments")));
    offs.push(listen("closing-backup", () => toast("드라이브에 백업한 뒤 종료합니다…")));
    offs.push(listen<string>("sync-error", (e) => toast(e.payload, "error")));
    offs.push(listen<number>("notif-imported", (e) => e.payload > 0 && toast(`알림에서 지출 ${e.payload}건을 가계부에 추가했습니다`, "ok")));
    const msg = sessionStorage.getItem("sm-toast");
    if (msg) {
      sessionStorage.removeItem("sm-toast");
      setTimeout(() => toast(msg, "ok"), 300);
    }
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
