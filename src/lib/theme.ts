import { useSyncExternalStore } from "react";

// Colour theme of this device (Settings > 일반). Kept per device, not synced:
// a phone and a PC may well want different ones.

export type Theme = "light" | "dark" | "system";
const KEY = "ui.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable: default */
  }
  return "light";
}

const resolved = (t: Theme) => (t === "system" ? (media().matches ? "dark" : "light") : t);

function apply() {
  document.documentElement.dataset.theme = resolved(getTheme());
  listeners.forEach((f) => f());
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* applied for this run only */
  }
  apply();
}

/** Applies the saved theme; called once before the first render. */
export function initTheme() {
  apply();
  media().addEventListener("change", () => getTheme() === "system" && apply());
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** The theme in effect ("light" or "dark"), updating when it changes. */
export const useDarkTheme = () => useSyncExternalStore(subscribe, () => document.documentElement.dataset.theme === "dark");

/** The chosen setting ("system" included). */
export const useThemeSetting = () => useSyncExternalStore(subscribe, getTheme);
