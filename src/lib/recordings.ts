import { useEffect, useState } from "react";
import { MeetingRecorder } from "./recorder";
import { notifyChange } from "./api";

// Recordings in progress, by AI note. They live here rather than in a
// component, so folding a note, scrolling it out of an editor, or opening
// another page never cuts a recording off; it ends only when stopped.

const active = new Map<number, MeetingRecorder>();
const listeners = new Set<() => void>();
const tick = () => listeners.forEach((f) => f());

export async function startRecording(meetingId: number) {
  if (active.has(meetingId)) return;
  const r = new MeetingRecorder(meetingId, tick);
  await r.start();
  active.set(meetingId, r);
  notifyChange("meetings");
  tick();
}

export async function stopRecording(meetingId: number) {
  const r = active.get(meetingId);
  if (!r) return;
  active.delete(meetingId);
  tick();
  try {
    await r.stop();
  } finally {
    notifyChange("meetings");
    notifyChange("attachments");
    tick();
  }
}

export function pauseRecording(meetingId: number, paused: boolean) {
  active.get(meetingId)?.pause(paused);
}

function useTick() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
}

/** The note's recording in progress (re-rendering every second), or undefined. */
export function useRecording(meetingId: number) {
  useTick();
  return active.get(meetingId);
}

/** Every recording in progress, for the indicator shown on all pages. */
export function useRecordings() {
  useTick();
  return [...active.entries()].map(([id, r]) => ({ id, seconds: r.seconds, paused: r.paused }));
}

export const fmtClock = (s: number) => {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor(t / 60) % 60).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
