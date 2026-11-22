import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from "react";

// ---- colour maths (HSV <-> hex) ----
type Hsv = { h: number; s: number; v: number };

function hsvToHex({ h, s, v }: Hsv) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

function hexToHsv(hex: string): Hsv | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const full = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export const normalizeHex = (s: string) => {
  const hsv = hexToHsv(s);
  return hsv ? hsvToHex(hsv) : null;
};

const SWATCHES = ["#f56c6c", "#f5a623", "#f8d34a", "#3bb273", "#2bb6b0", "#4b8bf5", "#7a6cf5", "#b06cf5", "#f06cb6", "#9b9b9b", "#5d4037", "#2f3437"];

/**
 * Colour wheel: the angle picks the hue and the distance from the centre the
 * saturation; the bar on the right sets the brightness; a hex code can be typed
 * below. `null` means "no colour".
 */
export function ColorPicker({ value, onChange }: { value: string | null; onChange: (hex: string | null) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? "") ?? { h: 210, s: 0.7, v: 0.95 });
  const [text, setText] = useState(value ?? "");
  const wheel = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  // Follow outside changes (e.g. a swatch, or another device's edit).
  useEffect(() => {
    const next = hexToHsv(value ?? "");
    if (next && hsvToHex(next) !== hsvToHex(hsv)) setHsv(next);
    setText(value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (n: Hsv) => {
    setHsv(n);
    const hex = hsvToHex(n);
    setText(hex);
    onChange(hex);
  };

  const drag = (ref: RefObject<HTMLDivElement | null>, at: (x: number, y: number, r: DOMRect) => void) => (e: RPointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent | RPointerEvent) => at(ev.clientX, ev.clientY, el.getBoundingClientRect());
    move(e);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onWheel = drag(wheel, (x, y, r) => {
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const rad = r.width / 2;
    // 0° at the top, clockwise - the same as the conic gradient.
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    commit({ ...hsv, h, s: Math.min(1, Math.hypot(dx, dy) / rad) });
  });
  const onBar = drag(bar, (_x, y, r) => commit({ ...hsv, v: 1 - Math.min(1, Math.max(0, (y - r.top) / r.height)) }));

  const knobAngle = (hsv.h * Math.PI) / 180;
  const pure = hsvToHex({ ...hsv, v: 1 });
  return (
    <div className="cpick">
      <div className="cpick-main">
        <div ref={wheel} className="cpick-wheel" onPointerDown={(e) => onWheel(e)} style={{ ["--dim" as any]: 1 - hsv.v }}>
          <span className="cpick-knob" style={{ left: `${50 + Math.sin(knobAngle) * hsv.s * 50}%`, top: `${50 - Math.cos(knobAngle) * hsv.s * 50}%`, background: value ?? "transparent" }} />
        </div>
        <div ref={bar} className="cpick-bar" onPointerDown={(e) => onBar(e)} style={{ background: `linear-gradient(${pure}, #000)` }} aria-label="밝기">
          <span className="cpick-bar-knob" style={{ top: `${(1 - hsv.v) * 100}%` }} />
        </div>
      </div>
      <div className="cpick-swatches">
        {SWATCHES.map((c) => <span key={c} className={`color-dot ${value === c ? "on" : ""}`} style={{ background: c }} onClick={() => onChange(c)} />)}
      </div>
      <div className="row nowrap">
        <span className="cpick-preview" style={{ background: value ?? "transparent" }} />
        <input
          className="grow"
          value={text}
          placeholder="#4b8bf5"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex) onChange(hex);
          }}
          aria-label="색상 코드"
        />
        <button className="btn sm" onClick={() => onChange(null)} disabled={!value}>색 없음</button>
      </div>
    </div>
  );
}
