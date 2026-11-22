import { useState } from "react";

const GROUPS: [string, string][] = [
  ["생활", "☀️ 🌙 🛏️ 🚿 🪥 🧴 💊 💉 🩺 🧘 🛁 🧺 🧹 🍽️ 🍳 🥗 🥛 💧 ☕ 🍵 🍎 🥦 🍚 🚭 🍺"],
  ["운동", "🏃 🚶 🚴 🏊 🏋️ 🤸 🧗 ⚽ 🏀 🎾 🏸 ⛳ 🥊 🧘‍♀️ 🦵 💪 🫀 🏔️ 🚵 🛹"],
  ["공부·일", "📚 📖 ✍️ 📝 💻 ⌨️ 🧠 🎓 🗂️ 📊 📈 🧾 💼 🗓️ ⏰ ⏳ 🔔 📌 ✅ 🎯"],
  ["취미", "🎨 🎹 🎸 🎧 🎮 📷 🎬 🧩 🧶 🪴 🌱 🌸 🐶 🐱 🍳 ✈️ 🏕️ 🎤 🎻 🎲"],
  ["마음", "😀 😊 🥰 😌 😴 🤒 😤 😢 🙏 💖 ❤️ 💛 💚 💙 💜 ⭐ ✨ 🔥 🌈 🍀"],
  ["돈·집", "💰 💳 🪙 🧮 🏦 🛒 🏠 🔑 🧰 🪛 🚗 🚌 🚇 📦 🎁 📮 ☎️ 📱 🔋 🌐"],
];

/** Grid of common emoji, plus a box to paste any other one. */
export function EmojiPicker({ value, onChange }: { value: string | null; onChange: (e: string | null) => void }) {
  const [group, setGroup] = useState(0);
  const [typed, setTyped] = useState("");
  return (
    <div className="epick">
      <div className="epick-tabs">
        {GROUPS.map(([name], i) => (
          <button key={name} className={i === group ? "on" : ""} onClick={() => setGroup(i)}>{name}</button>
        ))}
      </div>
      <div className="epick-grid">
        {GROUPS[group][1].split(" ").map((e) => (
          <button key={e} className={value === e ? "on" : ""} onClick={() => onChange(e)} aria-label={e}>{e}</button>
        ))}
      </div>
      <div className="row nowrap">
        <input
          className="grow"
          value={typed}
          placeholder={navigator.userAgent.includes("Android") ? "다른 이모지 붙여넣기 (키보드의 이모지)" : "다른 이모지 붙여넣기 (Win+. 으로 입력)"}
          onChange={(e) => {
            setTyped(e.target.value);
            // Keep one emoji (a grapheme, so flags and skin tones stay whole).
            const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
            const first = [...seg.segment(e.target.value.trim())][0]?.segment;
            if (first && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first)) onChange(first);
          }}
        />
        <button className="btn sm" onClick={() => onChange(null)} disabled={!value}>이모지 없음</button>
      </div>
    </div>
  );
}

/**
 * How a daily item is marked everywhere: its emoji (on a circle of its
 * colour when it has one), or just a coloured dot when there is no emoji.
 */
export function PresetIcon({ emoji, color, size = 22 }: { emoji?: string | null; color?: string | null; size?: number }) {
  if (!emoji) return <span className="dot" style={{ ["--c" as any]: color || "var(--accent)", width: Math.round(size * 0.4), height: Math.round(size * 0.4) }} />;
  return (
    <span className={`preset-emoji ${color ? "filled" : ""}`} style={{ width: size, height: size, fontSize: Math.round(size * (color ? 0.62 : 0.8)), background: color || undefined }}>
      {emoji}
    </span>
  );
}
