import { invoke } from "@tauri-apps/api/core";

export type Row = Record<string, any> & { id: number };

export type Filter = { col: string; op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "null" | "notnull" | "in"; value?: unknown };
export type Query = {
  filters?: Filter[];
  search?: string;
  order?: [string, "asc" | "desc"][];
  limit?: number;
  offset?: number;
};

export type Table =
  | "option_items" | "memos" | "tasks" | "expenses" | "subscriptions" | "notif_apps" | "notif_inbox"
  | "goals" | "goal_notes" | "diary_templates" | "diary_entries" | "daily_presets" | "daily_rules"
  | "daily_logs" | "events" | "projects" | "work_logs" | "meetings" | "attachments" | "app_settings";

// ---- change bus: every write notifies hooks that read the same table ----
const bus = new EventTarget();
export function notifyChange(table: Table | "*") {
  bus.dispatchEvent(new CustomEvent("change", { detail: table }));
}
export function onChange(fn: (table: string) => void) {
  const h = (e: Event) => fn((e as CustomEvent).detail);
  bus.addEventListener("change", h);
  return () => bus.removeEventListener("change", h);
}

// Android's WebView cannot carry binary IPC bodies (Tauri falls back to
// postMessage), so binary chunks travel as base64 there.
const isAndroid = navigator.userAgent.includes("Android");
function toB64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const binaryBody = (bytes: Uint8Array): any => (isAndroid ? { b64: toB64(bytes) } : bytes);

export const db = {
  list: <T extends Row = Row>(table: Table, query?: Query) => invoke<T[]>("db_list", { table, query }),
  get: <T extends Row = Row>(table: Table, id: number) => invoke<T | null>("db_get", { table, id }),
  async upsert<T extends Row = Row>(table: Table, row: Partial<T> & Record<string, unknown>): Promise<T> {
    const r = await invoke<T>("db_upsert", { table, row });
    notifyChange(table);
    return r;
  },
  async remove(table: Table, id: number) {
    await invoke("db_delete", { table, id });
    notifyChange(table);
  },
  async bulk(ops: { table: Table; row?: Record<string, unknown>; delete?: number }[]) {
    const r = await invoke<Row[]>("db_bulk", { ops });
    new Set(ops.map((o) => o.table)).forEach((t) => notifyChange(t));
    return r;
  },
};

export type SyncStatus = {
  auto_saved_at: number;
  manual_saved_at: number | null;
  manual_local_modified: number | null;
  /** The login this status belongs to. */
  session: number;
  drive: { id: string; modified_time: string | null; size: string | null; local_modified: number | null; device: string | null } | null;
  drive_error: string | null;
  synced_local_modified: number | null;
  last_backup_at: number | null;
  last_load_at: number | null;
  auto_backup: boolean;
  auto_load: boolean;
  logged_in: boolean;
  email: string | null;
  unsynced: boolean;
};

export type LlmConfig = { model: string };
export type SttConfig = { model: string; language: string; threads: number };
export type DeviceSettings = {
  llm: LlmConfig;
  stt: SttConfig;
  google: { email: string | null; env_client: boolean };
  gcal_last_sync: number | null;
  platform: "android" | "desktop";
  ai_enabled: boolean;
  models_size: number;
  data_dir: string;
};
export type ModelKind = "stt" | "llm";
export type ModelInfo = { kind: ModelKind; file: string; label: string; note: string; size: number; installed: boolean; preset: boolean; partial: number; downloading: boolean };
export type SyncOutcome =
  | { kind: "nothing" | "uploaded" | "downloaded" | "remote_newer" }
  | { kind: "merged"; from_local: number; from_remote: number; conflicts: number }
  | { kind: "needs_choice"; local_saved_at: number; drive_saved_at: number | null; conflicts: number };

export type Attachment = Row & {
  owner_table: string; owner_id: number; role: string | null; name: string; mime: string | null; size: number; sha256: string;
  sync_mode: "auto" | "on" | "off";
  /** file is on this device */ local: boolean; path: string | null;
  /** effective: follows sync_mode, or the size limit when "auto" */ sync: boolean;
  on_drive: boolean; downloading: boolean;
};

export type Parsed = { name: string; amount: number; purchased_at: string };

export const api = {
  /** Move a work item with its sub-items and AI notes to another project (one transaction). */
  async workMove(id: number, projectId: number | null) {
    await invoke("work_move", { id, projectId });
    notifyChange("work_logs");
    notifyChange("meetings");
  },
  expenseDashboard: (from: string, to: string) => invoke<any>("expense_dashboard", { from, to }),
  subscriptionSchedule: (from: string, to: string) => invoke<any[]>("subscription_schedule", { from, to }),
  dailyView: (from: string, to: string) => invoke<Record<string, { planned: number[]; logs: Row[] }>>("daily_view", { from, to }),
  notifPreview: (rule: unknown, title: string, text: string) => invoke<Parsed | null>("notif_preview", { rule, title, text }),
  notifIngest: async (items: { package: string; title: string; text: string; posted_at: number }[]) => {
    const n = await invoke<number>("notif_ingest", { items });
    notifyChange("expenses");
    notifyChange("notif_inbox");
    return n;
  },
  notifSync: async () => {
    const n = await invoke<number>("notif_sync");
    if (n) {
      notifyChange("expenses");
      notifyChange("notif_inbox");
    }
    return n;
  },
  native: <T = any>(cmd: "listApps" | "notificationAccess" | "openNotificationSettings" | "recentPackages") => invoke<T>("native_call", { cmd }),
  syncStatus: (withDrive: boolean) => invoke<SyncStatus>("sync_status", { withDrive }),
  manualSave: () => invoke<number>("sync_manual_save"),
  loadManual: () => invoke("sync_load_manual"),
  driveBackup: () => invoke<SyncOutcome>("sync_drive_backup"),
  /** prefer: which side wins where both changed the same data ("local" = auto-saved DB on this device). */
  syncNow: (prefer?: "local" | "remote") => invoke<SyncOutcome>("sync_now", { prefer: prefer ?? null }),
  driveLoad: () => invoke("sync_drive_load"),
  setAuto: (autoBackup: boolean, autoLoad: boolean) => invoke("sync_set_auto", { autoBackup, autoLoad }),
  googleLogin: () => invoke<string>("google_login"),
  googleLogout: () => invoke("google_logout"),
  gcalSync: async () => {
    const r = await invoke<{ pushed: number; pulled: number; deleted: number }>("gcal_sync");
    notifyChange("events");
    return r;
  },
  eventDelete: async (id: number) => {
    await invoke("event_delete", { id });
    notifyChange("events");
  },
  deviceSettings: () => invoke<DeviceSettings>("device_settings"),
  setLlm: (llm: LlmConfig) => invoke("device_set_llm", { llm }),
  setStt: (stt: SttConfig) => invoke("device_set_stt", { stt }),
  recStart: (id: number) => invoke("meeting_rec_start", { id }),
  recAppend: (id: number, pcm: Uint8Array) => invoke("meeting_rec_append", binaryBody(pcm), { headers: { "x-meeting-id": String(id) } }),
  recStop: (id: number) => invoke<Row>("meeting_rec_stop", { id }),
  meetingImport: (id: number, path: string) => invoke<Row>("meeting_import", { id, path }),
  meetingTranscribe: (id: number) => invoke<Row>("meeting_transcribe", { id }),
  meetingSummarize: (id: number) => invoke<Row>("meeting_summarize", { id }),
  meetingDelete: async (id: number) => {
    await invoke("meeting_delete", { id });
    notifyChange("meetings");
  },
  meetingCancel: (id: number) => invoke("meeting_cancel", { id }),
  attList: (ownerTable: Table, ownerId: number) => invoke<Attachment[]>("att_list", { ownerTable, ownerId }),
  /** Streams a picked file to Rust in 4MB chunks (same path on PC and Android). */
  async attUpload(ownerTable: Table, ownerId: number, file: File, onProgress?: (p: number) => void) {
    const token = await invoke<string>("att_begin", { ownerTable, ownerId, name: file.name, mime: file.type || null });
    try {
      const CHUNK = (isAndroid ? 2 : 4) * 1024 * 1024;
      for (let off = 0; off < file.size; off += CHUNK) {
        const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
        await invoke("att_chunk", binaryBody(buf), { headers: { "x-upload": token } });
        onProgress?.(Math.min(1, (off + CHUNK) / Math.max(1, file.size)));
      }
      const row = await invoke<Row>("att_finish", { token });
      notifyChange("attachments");
      return row;
    } catch (e) {
      await invoke("att_cancel", { token }).catch(() => {});
      throw e;
    }
  },
  attOpen: (id: number) => invoke("att_open", { id }),
  async attDelete(id: number) {
    await invoke("att_delete", { id });
    notifyChange("attachments");
  },
  attSummary: () => invoke<{ files: number; synced: number; synced_bytes: number; local_only: number; not_here: number; limit_mb: number }>("att_summary"),
  async attSetLimit(mb: number) {
    await invoke("att_set_limit", { mb });
    notifyChange("attachments");
  },
  filesSync: () => invoke<{ uploaded: number; downloaded: number; removed_from_drive: number; failed: string[] }>("files_sync"),
  models: () => invoke<ModelInfo[]>("models_list"),
  modelDownload: (kind: ModelKind, file?: string, url?: string) => invoke<string>("model_download", { kind, file: file ?? null, url: url ?? null }),
  modelCancel: (file: string) => invoke("model_cancel", { file }),
  modelDelete: (kind: ModelKind, file: string) => invoke("model_delete", { kind, file }),
  modelImport: (kind: ModelKind, path: string) => invoke<string>("model_import", { kind, path }),
};
