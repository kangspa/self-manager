import { useLocation, useNavigate } from "react-router-dom";
import { PageHeader, Tabs } from "../../components/ui";
import { OptionSetsButton } from "../settings/OptionsSection";
import Expenses from "./Expenses";
import Dashboard from "./Dashboard";
import Subscriptions from "./Subscriptions";
import Inbox from "./Inbox";

type T = "list" | "dashboard" | "subs" | "inbox";

export default function Ledger() {
  const loc = useLocation();
  const nav = useNavigate();
  const tab = (loc.pathname.split("/")[2] || "list") as T;
  return (
    <div>
      <PageHeader title="가계부" icon="💳" actions={<OptionSetsButton prefix="expense." />} />
      <Tabs<T> value={tab} onChange={(t) => nav(t === "list" ? "/ledger" : `/ledger/${t}`)} items={[["list", "지출 내역"], ["dashboard", "대시보드"], ["subs", "정기 결제"], ["inbox", "알림함"]]} />
      {tab === "list" && <Expenses />}
      {tab === "dashboard" && <Dashboard />}
      {tab === "subs" && <Subscriptions />}
      {tab === "inbox" && <Inbox />}
    </div>
  );
}
