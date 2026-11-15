import { cancel, isPermissionGranted, requestPermission, Schedule, sendNotification } from "@tauri-apps/plugin-notification";
import type { Row } from "./api";

const isAndroid = navigator.userAgent.includes("Android");

/**
 * Android: hand the reminder to the OS so it fires even when the app is closed.
 * Desktop reminders are fired by the Rust loop while the app is running.
 */
export async function scheduleReminder(ev: Row) {
  if (!isAndroid) return;
  try {
    await cancel([ev.id]);
    if (ev.remind_minutes == null) return;
    const start = ev.all_day ? new Date(`${ev.start_at.slice(0, 10)}T09:00`) : new Date(ev.start_at);
    const at = new Date(start.getTime() - ev.remind_minutes * 60_000);
    if (at.getTime() <= Date.now()) return;
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (!ok) return;
    sendNotification({ id: ev.id, title: ev.title, body: `${ev.all_day ? "종일" : ev.start_at.slice(11, 16)} ${ev.location ?? ""}`.trim(), schedule: Schedule.at(at, false, true) });
  } catch (e) {
    console.warn("reminder", e);
  }
}

export async function cancelReminder(id: number) {
  if (!isAndroid) return;
  try {
    await cancel([id]);
  } catch {
    /* nothing scheduled */
  }
}
