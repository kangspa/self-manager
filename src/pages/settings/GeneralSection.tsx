import { getWeekStart, WeekStart } from "../../lib/date";
import { useWeekStartSetting } from "../../lib/weekStart";

export default function GeneralSection() {
  const { saved, save } = useWeekStartSetting();
  const value = saved ?? getWeekStart();
  const opts: [WeekStart, string][] = [[0, "일요일"], [1, "월요일"]];
  return (
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
  );
}
