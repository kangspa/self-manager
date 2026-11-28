import { useNavigate, useParams } from "react-router-dom";
import { AiNoteById } from "./AiNote";

export { MEETING_STATUS } from "./AiNote";

/**
 * One AI note on its own page (route /work/meeting/:id): opened from the
 * recording indicator, or a link kept from before notes opened in place.
 */
export default function MeetingDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={() => (window.history.length > 1 ? nav(-1) : nav("/work"))}>‹ 업무</button>
      </div>
      <AiNoteById key={id} id={Number(id)} defaultOpen />
    </div>
  );
}
