/** Day-page calendar showing today's date: the 일일 관리 icon (일정 keeps 🗓️). */
export function DailyIcon({ size = 18 }: { size?: number }) {
  const day = new Date().getDate();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign: "-0.15em" }}>
      <rect x="3" y="4" width="18" height="17" rx="3.2" fill="#fff" stroke="#c9ccd1" strokeWidth="1.2" />
      <path d="M3 7.2A3.2 3.2 0 0 1 6.2 4h11.6A3.2 3.2 0 0 1 21 7.2V9H3Z" fill="#ef5350" />
      <rect x="7" y="2.2" width="1.8" height="4" rx="0.9" fill="#7b7f86" />
      <rect x="15.2" y="2.2" width="1.8" height="4" rx="0.9" fill="#7b7f86" />
      <text x="12" y="18.6" textAnchor="middle" fontSize={day >= 10 ? 9.6 : 10.5} fontWeight="700" fill="#2f3437" fontFamily="system-ui, sans-serif">{day}</text>
    </svg>
  );
}

/**
 * App mark: a bold "M" (Manager) on a blue-violet tile, with a green check
 * badge - "taken care of". Same artwork as src-tauri/icons/app-icon.svg.
 */
export function AppLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id="sm-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f7cff" />
          <stop offset="1" stopColor="#6a3ff0" />
        </linearGradient>
      </defs>
      <rect x="32" y="32" width="960" height="960" rx="224" fill="url(#sm-tile)" />
      <path d="M262 742V300L512 566 762 300V742" fill="none" stroke="#fff" strokeWidth="112" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="770" cy="754" r="150" fill="#22c58b" stroke="#fff" strokeWidth="36" />
      <path d="M700 756l50 50 92-104" fill="none" stroke="#fff" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
