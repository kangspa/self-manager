import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, db, Row } from "../../lib/api";
import { useRows } from "../../lib/hooks";
import { Empty, Field, Modal, run, Tabs } from "../../components/ui";
import { ExpenseEditor, useLedgerOptions } from "./Expenses";

function TestModal({ apps, onClose }: { apps: Row[]; onClose: () => void }) {
  const [pkg, setPkg] = useState(apps[0]?.package ?? "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title="알림 문구로 직접 추가"
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={async () => { await run(async () => { const n = await api.notifIngest([{ package: pkg, title, text, posted_at: Date.now() }]); return n; }, "알림함에 추가했습니다"); onClose(); }} disabled={!pkg}>추가</button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>PC에서 파싱 규칙을 확인하거나, 받은 알림 문구를 붙여넣어 기록할 때 씁니다.</p>
      <Field label="앱">
        <select value={pkg} onChange={(e) => setPkg(e.target.value)}>
          {apps.map((a) => <option key={a.id} value={a.package}>{a.label || a.package}</option>)}
        </select>
      </Field>
      <Field label="알림 제목"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="알림 내용"><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>
    </Modal>
  );
}

export default function Inbox() {
  const [tab, setTab] = useState<"pending" | "parsed" | "ignored">("pending");
  const [edit, setEdit] = useState<{ row: Partial<Row>; inbox: Row } | null>(null);
  const [test, setTest] = useState(false);
  const [access, setAccess] = useState<boolean | null>(null);
  const isAndroid = navigator.userAgent.includes("Android");
  const o = useLedgerOptions();
  const apps = useRows("notif_apps", { order: [["label", "asc"]] });
  const { rows } = useRows("notif_inbox", { filters: [{ col: "status", op: "=", value: tab }], order: [["posted_at", "desc"]], limit: 300 });
  const appLabel = (p: string) => apps.rows.find((a) => a.package === p)?.label || p;

  useEffect(() => {
    if (isAndroid) api.native<{ granted: boolean }>("notificationAccess").then((r) => setAccess(r.granted)).catch(() => setAccess(null));
  }, [isAndroid]);

  const convert = (n: Row) => {
    const app = apps.rows.find((a) => a.package === n.package);
    const d = new Date(n.posted_at);
    const p = (x: number) => String(x).padStart(2, "0");
    setEdit({
      inbox: n,
      row: { name: n.title, purchased_at: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, location_id: app?.location_id ?? null, status_id: o.status[0]?.id ?? null, raw_text: `${n.title}\n${n.text}`, source: "notification" },
    });
  };

  return (
    <div>
      <div className="notice" style={{ marginBottom: 14 }}>
        {isAndroid ? (
          <>
            <Link to="/settings#notif">설정 › 알림 가계부</Link>에서 고른 앱의 알림을 읽어 지출명·결제 위치·금액·날짜를 자동으로 채웁니다. 금액을 못 찾은 알림은 <b>확인 필요</b>에 남습니다.
          </>
        ) : (
          <>휴대폰(Android 앱)이 결제 알림에서 읽은 내용이 동기화되어 보입니다. 알림을 읽을 앱은 휴대폰의 설정 › 알림 가계부에서 고릅니다.</>
        )}
        {isAndroid && access === false && (
          <div className="row" style={{ marginTop: 8 }}>
            <b style={{ color: "var(--danger)" }}>알림 접근 권한이 꺼져 있습니다.</b>
            <button className="btn sm" onClick={() => api.native("openNotificationSettings")}>권한 설정 열기</button>
          </div>
        )}
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <Tabs value={tab} onChange={setTab} items={[["pending", "확인 필요"], ["parsed", "자동 기록됨"], ["ignored", "무시함"]]} />
        <span className="spacer" />
        {isAndroid && <button className="btn" onClick={() => run(async () => { const n = await api.notifSync(); return n; }, "알림을 가져왔습니다")}>지금 가져오기</button>}
        {isAndroid && <button className="btn" onClick={() => setTest(true)} disabled={!apps.rows.length}>문구로 추가</button>}
      </div>
      {rows.length === 0 ? (
        <Empty>{apps.rows.length ? "알림이 없습니다" : isAndroid ? "먼저 설정 › 알림 가계부에서 앱을 고르세요" : "휴대폰에서 알림을 읽을 앱을 고르면 여기에 보입니다"}</Empty>
      ) : (
        <div className="list">
          {rows.map((n) => (
            <div key={n.id} className="list-row">
              <div className="grow">
                <div className="row nowrap"><span className="badge">{appLabel(n.package)}</span><b className="ellipsis">{n.title}</b></div>
                <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{n.text}</div>
                <div className="faint small">{new Date(n.posted_at).toLocaleString("ko-KR")}</div>
              </div>
              {tab === "pending" && (
                <>
                  <button className="btn sm primary" onClick={() => convert(n)}>지출로 등록</button>
                  <button className="btn sm" onClick={() => db.upsert("notif_inbox", { id: n.id, status: "ignored" })}>무시</button>
                </>
              )}
              {tab === "parsed" && n.expense_id && <button className="btn sm" onClick={async () => { const e = await db.get("expenses", n.expense_id); if (e) setEdit({ row: e, inbox: n }); }}>지출 보기</button>}
              {tab === "ignored" && <button className="btn sm" onClick={() => db.upsert("notif_inbox", { id: n.id, status: "pending" })}>되돌리기</button>}
            </div>
          ))}
        </div>
      )}
      {edit && (
        <ExpenseEditor
          row={edit.row}
          onClose={async () => {
            // A new expense created from a pending notification: link it back.
            if (!edit.row.id && edit.inbox.status === "pending") {
              const latest = await db.list("expenses", { filters: [{ col: "raw_text", op: "=", value: edit.row.raw_text }], order: [["id", "desc"]], limit: 1 });
              if (latest[0]) await db.upsert("notif_inbox", { id: edit.inbox.id, status: "parsed", expense_id: latest[0].id });
            }
            setEdit(null);
          }}
        />
      )}
      {test && <TestModal apps={apps.rows} onClose={() => setTest(false)} />}
    </div>
  );
}
