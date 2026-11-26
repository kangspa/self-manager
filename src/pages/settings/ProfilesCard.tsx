import { useEffect, useState } from "react";
import { api, ProfileList } from "../../lib/api";
import { addProfile, profileLabel, switchProfile } from "../../lib/profiles";
import { confirmDialog, toast } from "../../components/ui";

/** Every account on this device: switch, add, or delete one that is not in use. */
export default function ProfilesCard() {
  const [list, setList] = useState<ProfileList | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.profileList().then(setList).catch((e) => toast(String(e), "error"));
  useEffect(() => {
    load();
  }, []);

  const go = async (fn: () => Promise<unknown>, reloads: boolean) => {
    setBusy(true);
    try {
      await fn();
      if (!reloads) {
        await load();
        setBusy(false);
      }
    } catch (e) {
      toast(String(e), "error");
      setBusy(false);
    }
  };

  if (!list) return null;
  return (
    <div className="card section">
      <div className="section-title">계정</div>
      <div className="faint small" style={{ marginTop: -6, marginBottom: 10 }}>
        구글 계정마다 기록·첨부 파일·드라이브 백업이 따로 있습니다. 사이드바 맨 위에서 바로 바꿀 수 있고, 다시 로그인하지 않아도 됩니다.
      </div>
      <div className="list">
        {list.profiles.map((p) => (
          <div key={p.id} className="list-row">
            <span className="grow">
              {profileLabel(p)}
              {p.active && <span className="badge ok" style={{ marginLeft: 8 }}>사용 중</span>}
              {!p.logged_in && <span className="badge" style={{ marginLeft: 8 }}>로그인 안 됨</span>}
            </span>
            {!p.active && (
              <button className="btn sm" disabled={busy} onClick={() => go(() => switchProfile(p.id), true)}>
                바꾸기
              </button>
            )}
            {!p.active && !p.default && (
              <button
                className="btn sm danger"
                disabled={busy}
                onClick={async () =>
                  (await confirmDialog(`'${profileLabel(p)}' 계정과 이 기기에 있는 그 계정의 기록·첨부 파일을 지울까요?\n구글 드라이브의 백업은 남아 있어, 나중에 같은 계정을 추가하면 다시 받을 수 있습니다.`, true)) &&
                  go(() => api.profileRemove(p.id), false)
                }
              >
                삭제
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm" disabled={busy} onClick={() => go(addProfile, true)}>
          ＋ 다른 계정 추가
        </button>
      </div>
    </div>
  );
}
