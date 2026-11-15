import { useState } from "react";
import { api } from "../../lib/api";
import { useLoad } from "../../lib/hooks";
import { addDays, fmtDate, monthRange, today, won } from "../../lib/date";
import { Empty } from "../../components/ui";

type Period = "month" | "last" | "3m" | "year" | "custom";

function range(p: Period, custom: [string, string]): [string, string] {
  const now = new Date();
  if (p === "month") return [...monthRange(now)] as [string, string];
  if (p === "last") return [...monthRange(new Date(now.getFullYear(), now.getMonth() - 1, 1))] as [string, string];
  if (p === "3m") return [monthRange(new Date(now.getFullYear(), now.getMonth() - 2, 1))[0], today()];
  if (p === "year") return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
  return custom;
}

function Bars({ data }: { data: { key: string; total: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.total));
  if (!data.length) return <Empty>데이터 없음</Empty>;
  const daily = data[0]?.key.length === 10;
  return (
    <div className="bars">
      {data.map((d) => (
        <div key={d.key} className="bar-col" title={`${d.key} · ${won(d.total)}`}>
          <div className="bar" style={{ height: `${(d.total / max) * 100}%` }} />
          <span className="bar-label">{daily ? (Number(d.key.slice(8)) === 1 || Number(d.key.slice(8)) % 5 === 0 ? Number(d.key.slice(8)) : " ") : `${Number(d.key.slice(5))}월`}</span>
        </div>
      ))}
    </div>
  );
}

function HBars({ rows, total }: { rows: { label: string | null; color: string | null; total: number; count: number }[]; total: number }) {
  if (!rows.length) return <Empty>데이터 없음</Empty>;
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} className="hbar-row">
          <span className="ellipsis">{r.label ?? <span className="faint">미지정</span>}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(r.total / Math.max(1, total)) * 100}%`, ["--c" as any]: r.color || "#9b9b9b" }} />
          </div>
          <span className="small" style={{ textAlign: "right" }}>
            {won(r.total)} <span className="faint">{Math.round((r.total / Math.max(1, total)) * 100)}%</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [p, setP] = useState<Period>("month");
  const [custom, setCustom] = useState<[string, string]>([addDays(today(), -30), today()]);
  const [from, to] = range(p, custom);
  const { data } = useLoad(() => api.expenseDashboard(from, to), [from, to], ["expenses", "subscriptions", "option_items"]);
  // Average over days that have actually passed (this month so far, not all 30).
  const end = to < today() ? to : today();
  const days = Math.max(1, Math.round((new Date(end).getTime() - new Date(from).getTime()) / 86400000) + 1);
  const span = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const daily = p === "month" || p === "last" || (p === "custom" && span <= 45);
  // Show every day of the range, including days with no spending.
  const series = daily
    ? Array.from({ length: Math.max(0, span) }, (_, i) => {
        const k = addDays(from, i);
        return data?.by_day.find((d: any) => d.key === k) ?? { key: k, total: 0 };
      })
    : data?.by_month;

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="seg">
          {([["month", "이번 달"], ["last", "지난 달"], ["3m", "최근 3개월"], ["year", "올해"], ["custom", "직접 지정"]] as [Period, string][]).map(([k, l]) => (
            <button key={k} className={p === k ? "on" : ""} onClick={() => setP(k)}>{l}</button>
          ))}
        </div>
        {p === "custom" && (
          <>
            <input type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} />
            <span>~</span>
            <input type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} />
          </>
        )}
        <span className="muted small">{from} ~ {to}</span>
      </div>
      {!data ? (
        <Empty>불러오는 중…</Empty>
      ) : (
        <>
          <div className="grid3">
            <div className="card stat"><span className="stat-label">총 지출</span><span className="stat-value">{won(data.total)}</span></div>
            <div className="card stat"><span className="stat-label">건수</span><span className="stat-value">{data.count}건</span></div>
            <div className="card stat"><span className="stat-label">하루 평균</span><span className="stat-value">{won(data.total / days)}</span></div>
            <div className="card stat"><span className="stat-label">정기 결제 (월 환산)</span><span className="stat-value">{won(data.subscription_monthly)}</span></div>
          </div>
          <div className="card section">
            <div className="section-title">{daily ? "일별 지출" : "월별 지출"}</div>
            <Bars data={series ?? []} />
          </div>
          <div className="grid2 section">
            <div className="card"><div className="section-title">품목별</div><HBars rows={data.by_item} total={data.total} /></div>
            <div className="card"><div className="section-title">결제 위치별</div><HBars rows={data.by_location} total={data.total} /></div>
            <div className="card"><div className="section-title">상태별</div><HBars rows={data.by_status} total={data.total} /></div>
            <div className="card">
              <div className="section-title">큰 지출 TOP 5</div>
              {data.top.length === 0 && <Empty>없음</Empty>}
              {data.top.map((t: any) => (
                <div key={t.id} className="row nowrap" style={{ padding: "4px 0" }}>
                  <span className="meta" style={{ width: 70 }}>{fmtDate(t.purchased_at)}</span>
                  <span className="ellipsis grow">{t.name}</span>
                  <b className="small">{won(t.amount)}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="card section">
            <div className="section-title">앞으로 30일 정기 결제 <span className="muted small">{won(data.upcoming.reduce((s: number, u: any) => s + (u.amount ?? 0), 0))}</span></div>
            {data.upcoming.length === 0 && <Empty>예정된 정기 결제 없음</Empty>}
            {data.upcoming.map((u: any, i: number) => (
              <div key={i} className="row nowrap" style={{ padding: "4px 0" }}>
                <span className="meta" style={{ width: 70 }}>{fmtDate(u.date)}</span>
                <span className="ellipsis grow">{u.name}</span>
                <span className="small">{won(u.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
