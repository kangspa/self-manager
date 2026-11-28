import { useEffect, useState } from "react";
import { api, db, Parsed, Row } from "../../lib/api";
import { useOptions, useRows } from "../../lib/hooks";
import { won } from "../../lib/date";
import { Empty, Field, Modal, OptionSelect, toast } from "../../components/ui";

type Rule = { include?: string; exclude?: string; amount_regex?: string; name_regex?: string; name_source?: string };
type App = { package: string; label: string; icon?: string };

function RuleEditor({ app, onClose }: { app: Row; onClose: () => void }) {
  const locs = useOptions("expense.location");
  const [rule, setRule] = useState<Rule>(() => { try { return JSON.parse(app.rule_json ?? "{}"); } catch { return {}; } });
  const [label, setLabel] = useState(app.label ?? "");
  const [loc, setLoc] = useState<number | null>(app.location_id);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [res, setRes] = useState<Parsed | null | undefined>(undefined);
  const recent = useRows("notif_inbox", { filters: [{ col: "package", op: "=", value: app.package }], order: [["posted_at", "desc"]], limit: 5 });
  const set = (k: keyof Rule, v: string) => setRule((r) => ({ ...r, [k]: v }));
  const test = async () => setRes(await api.notifPreview(rule, title, text));
  const save = async () => {
    await db.upsert("notif_apps", { id: app.id, label, location_id: loc, rule_json: JSON.stringify(rule) });
    onClose();
  };
  return (
    <Modal open wide onClose={onClose} title={`${app.label || app.package} 파싱 규칙`} footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn primary" onClick={save}>저장</button></>}>
      <div className="grid2" style={{ gap: "0 12px" }}>
        <Field label="표시 이름"><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="결제 위치 (자동 입력값)"><OptionSelect options={locs} value={loc} onChange={setLoc} /></Field>
        <Field label="포함 키워드" hint="쉼표로 구분. 비워 두면 모든 알림을 봅니다. 예: 결제,승인"><input value={rule.include ?? ""} onChange={(e) => set("include", e.target.value)} /></Field>
        <Field label="제외 키워드" hint="예: 광고,이벤트,취소"><input value={rule.exclude ?? ""} onChange={(e) => set("exclude", e.target.value)} /></Field>
        <Field label="지출명 가져오기">
          <select value={rule.name_source ?? "auto"} onChange={(e) => set("name_source", e.target.value)}>
            <option value="auto">자동 (카드 승인 문구는 가맹점, 아니면 제목)</option>
            <option value="title">알림 제목</option>
            <option value="text">알림 내용 첫 줄</option>
            <option value="regex">정규식</option>
          </select>
        </Field>
        {rule.name_source === "regex" && <Field label="지출명 정규식" hint="첫 번째 괄호 부분을 씁니다"><input value={rule.name_regex ?? ""} onChange={(e) => set("name_regex", e.target.value)} placeholder="상품명:\s*(.+)" /></Field>}
        <Field label="금액 정규식 (선택)" hint="비워 두면 '12,300원' 같은 금액을 자동으로 찾습니다"><input value={rule.amount_regex ?? ""} onChange={(e) => set("amount_regex", e.target.value)} placeholder="결제금액\s*([\d,]+)" /></Field>
      </div>
      <div className="card" style={{ marginTop: 6 }}>
        <div className="section-title">규칙 테스트</div>
        {recent.rows.length > 0 && (
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="faint small">최근 알림:</span>
            {recent.rows.map((r) => <button key={r.id} className="btn sm" onClick={() => { setTitle(r.title ?? ""); setText(r.text ?? ""); }}>{(r.title ?? "").slice(0, 12) || "알림"}</button>)}
          </div>
        )}
        <Field label="알림 제목"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="알림 내용"><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="홍*동님 12,300원 일시불 승인 11/11 13:20 스타벅스" /></Field>
        <button className="btn sm" onClick={test}>테스트</button>
        {res !== undefined && (
          <div className="notice" style={{ marginTop: 8 }}>
            {res ? <>지출명 <b>{res.name}</b> · 금액 <b>{won(res.amount)}</b> · 날짜 <b>{res.purchased_at}</b></> : "금액을 찾지 못했거나 키워드 조건에 맞지 않아 무시됩니다"}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Android only (the PC has no notifications to read). The phone's apps as a
 * checklist: ticking one starts reading its notifications, with a payment
 * place named after it; unticking stops (its rules are kept for next time).
 */
export default function NotifSection() {
  const apps = useRows("notif_apps", { order: [["label", "asc"]] });
  const locs = useOptions("expense.location");
  const [edit, setEdit] = useState<Row | null>(null);
  const [installed, setInstalled] = useState<App[] | null>(null);
  const [filter, setFilter] = useState("");
  const [access, setAccess] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const checkAccess = () => api.native<{ granted: boolean }>("notificationAccess").then((r) => setAccess(r.granted)).catch(() => {});
  useEffect(() => {
    checkAccess();
    // Back from the system's permission screen.
    const h = () => document.visibilityState === "visible" && checkAccess();
    document.addEventListener("visibilitychange", h);
    Promise.all([api.native<{ apps: App[] }>("listApps"), api.native<{ apps: App[] }>("recentPackages").catch(() => ({ apps: [] as App[] }))])
      .then(([list, recent]) => {
        // Apps that posted notifications lately come first: likely card / bank apps.
                const icons = new Map(list.apps.map((a) => [a.package, a.icon]));
        // Only apps that can be opened (the system UI and this app also post notifications).
        const recentApps = recent.apps.filter((a) => icons.has(a.package)).map((a) => ({ ...a, icon: icons.get(a.package) }));
        setInstalled([...recentApps, ...list.apps.filter((a) => !recentApps.some((r) => r.package === a.package))]);
      })
      .catch((e) => {
        toast(String(e), "error");
        setInstalled([]);
      });
    return () => document.removeEventListener("visibilitychange", h);
  }, []);

  const rowOf = (pkg: string) => apps.rows.find((x) => x.package === pkg);
  const toggle = async (a: App, on: boolean) => {
    setBusy(a.package);
    try {
      const row = rowOf(a.package);
      if (row) {
        await db.upsert("notif_apps", { id: row.id, enabled: on ? 1 : 0 });
      } else if (on) {
        // 결제 위치 follows the app: reuse a place with the same name or create one.
        let loc = locs.find((l) => l.label === a.label);
        if (!loc) loc = (await db.upsert("option_items", { set_key: "expense.location", label: a.label, color: "#4b8bf5", sort: locs.length })) as any;
        await db.upsert("notif_apps", { package: a.package, label: a.label, location_id: loc!.id, enabled: 1, rule_json: "{}" });
      }
      await api.notifSync();
    } catch (e) {
      toast(String(e), "error");
    }
    setBusy(null);
  };

  const on = apps.rows.filter((a) => a.enabled);
  const q = filter.trim().toLowerCase();
  const shown = (installed ?? []).filter((a) => !q || a.label.toLowerCase().includes(q) || a.package.toLowerCase().includes(q));
  const icon = (pkg: string) => installed?.find((a) => a.package === pkg)?.icon;

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        알림을 읽을 앱을 고르면 그 앱의 결제 알림에서 <b>지출명·결제 위치·구매 금액·구매 날짜</b>를 읽어 가계부에 자동으로 기록합니다. 기록은 PC와 동기화됩니다.
      </p>
      {access === false && (
        <div className="notice row">
          <b style={{ color: "var(--danger)" }}>알림 접근 권한이 필요합니다.</b>
          <button className="btn sm primary" onClick={() => api.native("openNotificationSettings")}>권한 설정 열기</button>
          <span className="faint small">설정에서 Self Manager를 켠 뒤 돌아오세요.</span>
        </div>
      )}
      <div className="card section">
        <div className="section-title">알림을 읽는 앱 <span className="faint small">{on.length}개</span></div>
        {on.length === 0 ? (
          <div className="faint small">아직 없습니다. 아래 목록에서 카드사·은행·결제 앱을 체크하세요.</div>
        ) : (
          <div className="list">
            {on.map((a) => (
              <div key={a.id} className="list-row">
                <AppIcon src={icon(a.package)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <b className="ellipsis">{a.label || a.package}</b>
                  <div className="faint small ellipsis">결제 위치: {locs.find((l) => l.id === a.location_id)?.label ?? "없음"}</div>
                </div>
                <button className="btn sm" onClick={() => setEdit(a)}>규칙·테스트</button>
                <button className="icon-btn" aria-label="그만 읽기" title="그만 읽기" disabled={busy === a.package} onClick={() => toggle({ package: a.package, label: a.label }, false)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card section">
        <div className="section-title">이 휴대폰의 앱</div>
        <input placeholder="앱 이름 검색" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        {installed === null ? (
          <div className="faint small">앱 목록을 읽는 중…</div>
        ) : (
          <div className="list app-pick">
            {shown.map((a) => {
              const checked = !!rowOf(a.package)?.enabled;
              return (
                <label key={a.package} className="list-row click">
                  <input type="checkbox" checked={checked} disabled={busy === a.package} onChange={(e) => toggle(a, e.target.checked)} />
                  <AppIcon src={a.icon} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis">{a.label}</div>
                    <div className="faint small ellipsis">{a.package}</div>
                  </div>
                </label>
              );
            })}
            {shown.length === 0 && <Empty>찾는 앱이 없습니다</Empty>}
          </div>
        )}
      </div>
      {edit && <RuleEditor app={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function AppIcon({ src }: { src?: string }) {
  return src ? <img className="app-icon" src={src} alt="" /> : <span className="app-icon blank" />;
}
