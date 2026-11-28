import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PageHeader, Tabs } from "../../components/ui";
import GeneralSection from "./GeneralSection";
import SyncSection from "./SyncSection";
import OptionsSection from "./OptionsSection";
import NotifSection from "./NotifSection";
import { DailySection, DiarySection } from "./TemplateSections";
import AiSection from "./AiSection";

type T = "general" | "sync" | "options" | "notif" | "diary" | "daily" | "ai";
// Payment notifications can only be read on the phone: the PC has no such
// setting, and its ledger shows what the phone recorded (synced).
const ANDROID = navigator.userAgent.includes("Android");
const TABS: [T, string][] = ([["general", "일반"], ["sync", "백업·동기화"], ["options", "선택값 관리"], ["notif", "알림 가계부"], ["diary", "일기 템플릿"], ["daily", "일일 관리 항목"], ["ai", "AI 모델"]] as [T, string][]).filter(([k]) => ANDROID || k !== "notif");

export default function Settings() {
  const loc = useLocation();
  const nav = useNavigate();
  const fromHash = loc.hash.replace("#", "") as T;
  const [tab, setTab] = useState<T>(TABS.some(([k]) => k === fromHash) ? fromHash : "general");
  useEffect(() => {
    if (TABS.some(([k]) => k === fromHash)) setTab(fromHash);
  }, [fromHash]);
  return (
    <div>
      <PageHeader title="설정" icon="⚙️" />
      <Tabs<T> value={tab} onChange={(t) => { setTab(t); nav(`/settings#${t}`, { replace: true }); }} items={TABS} />
      {tab === "general" && <GeneralSection />}
      {tab === "sync" && <SyncSection />}
      {tab === "options" && <OptionsSection />}
      {tab === "notif" && <NotifSection />}
      {tab === "diary" && <DiarySection />}
      {tab === "daily" && <DailySection />}
      {tab === "ai" && <AiSection />}
    </div>
  );
}
