import { getWeekStart, WeekStart } from "../../lib/date";
import { useWeekStartSetting } from "../../lib/weekStart";
import { useHiddenNav } from "../../lib/navPrefs";
import { NAV } from "../../App";

export default function GeneralSection() {
  const { saved, save } = useWeekStartSetting();
  const value = saved ?? getWeekStart();
  const opts: [WeekStart, string][] = [[0, "일요일"], [1, "월요일"]];
  const { hidden, save: saveHidden } = useHiddenNav();
  return (
    <div className="stack">
    <div className="card section">
      <div className="section-title">한 주의 시작</div>
      <div className="faint small" style={{ marginTop: -6, marginBottom: 10 }}>일기·일정·업무·일일 관리의 주간·월간 보기가 이 요일부터 시작합니다. 목표의 주간 기록은 국제 표준(ISO) 주를 따라 항상 월요일부터입니다.</div>
      <div className="row">
        {opts.map(([v, label]) => (
          <label key={v} className="row">
            <input type="radio" name="week-start" checked={value === v} onChange={() => save(v)} />
            {label}
          </label>
        ))}
      </div>
    </div>
    <div className="card section">
      <div className="section-title">사이드바 메뉴</div>
      <div className="faint small" style={{ marginTop: -6, marginBottom: 10 }}>쓰지 않는 메뉴는 끄면 사이드바에서 숨겨집니다. 기록은 그대로 남고, 다시 켜면 보입니다.</div>
      <div className="list">
        {NAV.map(([to, icon, label]) => (
          <label key={to} className="list-row click">
            <input type="checkbox" checked={!hidden.includes(to)} onChange={(e) => saveHidden(e.target.checked ? hidden.filter((h) => h !== to) : [...hidden, to])} />
            <span className="nav-icon">{icon}</span>
            {label}
          </label>
        ))}
      </div>
    </div>
    </div>
  );
}
