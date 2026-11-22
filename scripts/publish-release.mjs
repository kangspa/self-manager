// Publishes a set of files into the release folder as one transaction: either
// every file of the new set is in place, or the folder is put back exactly as
// it was. Never a mix (e.g. a new exe next to an old installer).
//
// - Files are swapped by rename (current -> hidden backup, staged -> current).
//   Windows cannot overwrite or delete a running exe, but it can rename it.
// - Every rename is first written to a journal (write-ahead log). A run that
//   dies mid-swap, or whose rollback fails, leaves the journal behind and the
//   next run rolls it back *before* doing anything else.
// - The journal carries a checksum over its whole content. It is always written
//   in one atomic step, so a mismatch means it was cut short or damaged; then
//   nothing is moved or deleted and the user is told. Recovery never guesses.
// - A backup is deleted only when it is proven redundant: it was set aside by
//   a transaction whose commit was verified, and it still has the content
//   recorded then. Those go on a delete list (.publish-trash-<stamp>.json) first, so a
//   delete that fails (old exe still running) is retried by the next run. A
//   backup that is on no list, e.g. one a damaged journal forgot, is never
//   deleted automatically.
// - Antivirus scanners briefly lock fresh files, so renames are retried.
// - Only one publish per release folder runs at a time. The lock is an OS
//   object (a named pipe on Windows) that disappears when its process dies,
//   so a crashed run never leaves a stale lock that someone has to break.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const STAGE = ".staging";
const JOURNAL = ".publish-journal.json";
const BACKUP = /^\.(.+)\.old-(\d+)$/;

/** Identity of a directory: volume serial + file id (null where the OS reports none). */
function dirId(dir) {
  const st = fs.statSync(dir, { bigint: true });
  return st.ino !== 0n ? `${st.dev}:${st.ino}` : null;
}

class FolderReplaced extends Error {}

// The folder this process locked. Set for the duration of a publish; every
// write below checks it first, so a run whose folder was deleted or swapped
// under it stops instead of writing into the replacement (which another run
// may have locked by then).
let pinned = null;
function guard() {
  if (!pinned || !pinned.id) return;
  let now;
  try {
    now = dirId(pinned.dir);
  } catch {
    now = null;
  }
  if (now !== pinned.id) throw new FolderReplaced("배포 도중 release 폴더가 지워지거나 다른 폴더로 바뀌었습니다. 새 폴더는 건드리지 않고 멈췄습니다. 다시 실행하세요.");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    guard();
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      sleep(150);
    }
  }
}

const sha256text = (t) => crypto.createHash("sha256").update(t).digest("hex");
// Checksum over the content; an array fixes the order of the top-level fields.
const sealOf = (j) => sha256text(JSON.stringify([j.stamp, j.state, j.set, j.steps, j.carry]));

/** Atomic JSON write (temp + fsync + rename) so a crash never leaves half a file. */
function writeJournal(outDir, j) {
  const body = { stamp: j.stamp, state: j.state, set: j.set, steps: j.steps, carry: j.carry || [] };
  writeAtomic(outDir, JOURNAL, { ...body, sum: sealOf(body) });
}

function writeAtomic(outDir, file, obj) {
  const p = path.join(outDir, file);
  const tmp = `${p}.tmp`;
  guard();
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(obj));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameRetry(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const blocked = (why) => new Error(`release 폴더의 파일이 배포 기록과 달라, 되돌리면 원래 파일을 잃을 수 있어 아무것도 옮기지 않았습니다 (${why}). 기록·백업은 그대로 두었으니 폴더를 직접 확인하세요.`);
const corrupt = (why) => new Error(`배포 기록(${JOURNAL})이 손상돼 아무것도 옮기지 않았습니다 (${why}). release 폴더를 확인한 뒤 그 파일을 지우고 다시 실행하세요.`);

/**
 * Reads the journal and validates all of it up front, so a bad entry is found
 * before any file moves. An entry is accepted only if it is exactly what this
 * tool writes: a file it owns, the backup name derived from that file and the
 * journal's stamp, and the hash of the new file it placed.
 */
function readJournal(outDir, ours) {
  const p = path.join(outDir, JOURNAL);
  if (!entryExists(p)) return null;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw corrupt(`읽을 수 없음: ${e.message}`);
  }
  if (!j || typeof j !== "object" || typeof j.sum !== "string" || j.sum !== sealOf(j)) throw corrupt("체크섬이 맞지 않음: 잘렸거나 바뀐 기록");
  if (!["swapping", "committed", "done"].includes(j.state) || !Array.isArray(j.steps) || !Number.isSafeInteger(j.stamp) || j.stamp <= 0) {
    throw corrupt("형식이 다름");
  }
  // A "done" journal lists its own backups too; otherwise carried ones are older.
  j.carry = parseCarry(j.carry, ours, j.state === "done" ? null : j.stamp);
  if (j.state === "done") {
    // Cleanup only: the transaction is over, just its delete list is pending.
    if (j.steps.length || !Array.isArray(j.set) || j.set.length) throw corrupt("정리 대기 기록의 형식이 다름");
    j.set = [];
    return j;
  }
  j.set = parseSet(j.set, ours);
  j.steps = j.steps.map((raw, i) => parseStep(raw, i, j.stamp, ours));
  checkShape(j);
  if (j.state === "committed") {
    // "Committed" lets recovery delete the backups, so it must be true: every
    // file of the new set was placed and is there with the recorded content.
    const placed = j.steps.filter((s) => s.kind === "placed").length;
    if (placed !== j.set.length) throw corrupt("완료로 기록됐지만 새 파일 일부가 교체되지 않음");
    for (const f of j.set) {
      if (!sameFile(path.join(outDir, f.name), f.sha)) throw corrupt(`완료로 기록됐지만 ${f.name}이 새 파일과 다름`);
    }
    checkAccounted(outDir, j);
    // ...and every owned file outside the set was set aside.
    const inSet = new Set(j.set.map((f) => f.name.toLowerCase()));
    for (const n of fs.readdirSync(outDir)) {
      if (ours(n) && !BACKUP.test(n) && !inSet.has(n.toLowerCase())) throw corrupt(`완료로 기록됐지만 ${n}이 아직 남아 있음`);
    }
  }
  return j;
}

/** Backups of earlier, finished transactions still waiting to be queued for deletion. */
function parseCarry(carry, ours, stamp) {
  if (!Array.isArray(carry)) throw corrupt("정리 대기 목록 형식");
  return carry.map((t, i) => {
    const m = t && typeof t.name === "string" && !/[\\/:]/.test(t.name) ? BACKUP.exec(t.name) : null;
    if (!m || !ours(m[1]) || m[2] === String(stamp) || typeof t.sha !== "string" || !/^[0-9a-f]{64}$/.test(t.sha)) throw corrupt(`정리 대기 목록 ${i + 1}번째`);
    return { name: t.name, sha: t.sha };
  });
}

/** The new set the transaction was installing: owned names with their hashes. */
function parseSet(set, ours) {
  if (!Array.isArray(set) || !set.length) throw corrupt("새 파일 목록이 없음");
  const seen = new Set();
  return set.map((f, i) => {
    if (!f || typeof f !== "object") throw corrupt(`새 파일 목록 ${i + 1}번째`);
    const name = plainName(f.name, i);
    if (!ours(name) || seen.has(name.toLowerCase())) throw corrupt(`새 파일 목록의 ${name}`);
    if (typeof f.sha !== "string" || !/^[0-9a-f]{64}$/.test(f.sha)) throw corrupt(`새 파일 목록의 ${name} 해시`);
    seen.add(name.toLowerCase());
    return { name, sha: f.sha };
  });
}

/**
 * The steps must have exactly the shape publish writes:
 *   for each file of the set, in order:  [aside name]  placed name
 *   then, for owned files outside the set: aside name
 * A crash can cut this short anywhere, so only a prefix of it is required.
 */
function checkShape(j) {
  const key = (n) => n.toLowerCase();
  const inSet = new Map(j.set.map((f) => [key(f.name), f]));
  const asideSeen = new Set();
  let next = 0; // index into j.set of the next file to be placed
  j.steps.forEach((s, i) => {
    const bad = () => corrupt(`${i + 1}번째 항목의 순서`);
    if (s.kind === "placed") {
      const f = j.set[next];
      if (!f || key(f.name) !== key(s.name) || f.sha !== s.sha) throw bad();
      next++;
    } else {
      if (asideSeen.has(key(s.name))) throw bad();
      asideSeen.add(key(s.name));
      if (inSet.has(key(s.name))) {
        // the file being replaced: set aside right before its new one goes in
        const f = j.set[next];
        const follower = j.steps[i + 1];
        if (!f || key(f.name) !== key(s.name)) throw bad();
        if (follower && !(follower.kind === "placed" && key(follower.name) === key(s.name))) throw bad();
      } else if (next !== j.set.length) {
        // an obsolete file: only after the whole set is in place
        throw bad();
      }
    }
  });
}

function parseStep(raw, i, stamp, ours) {
  const at = `${i + 1}번째 항목`;
  if (!raw || typeof raw !== "object" || !["placed", "aside"].includes(raw.kind)) throw corrupt(`${at}의 종류`);
  const name = plainName(raw.name, i);
  if (!ours(name)) throw corrupt(`${at}: ${name}은 이 도구가 관리하는 파일이 아님`);
  if (raw.kind === "placed") {
    if (typeof raw.sha !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha)) throw corrupt(`${at}의 해시`);
    return { kind: "placed", name, sha: raw.sha };
  }
  if (raw.backup !== backupName(name, stamp)) throw corrupt(`${at}의 백업 이름 ${JSON.stringify(raw.backup)}`);
  if (typeof raw.sha !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha)) throw corrupt(`${at}의 원래 파일 해시`);
  return { kind: "aside", name, backup: raw.backup, sha: raw.sha };
}

const backupName = (name, stamp) => `.${name}.old-${stamp}`;

/** Every backup carrying this transaction's stamp must be one its journal set aside. */
function checkAccounted(outDir, j) {
  const listed = new Set(j.steps.filter((s) => s.kind === "aside").map((s) => s.backup.toLowerCase()));
  for (const n of fs.readdirSync(outDir)) {
    const m = BACKUP.exec(n);
    if (m && m[2] === String(j.stamp) && !listed.has(n.toLowerCase())) throw corrupt(`기록에 없는 백업 ${n}`);
  }
}

/** Whether a directory entry exists, without following links (a dangling symlink exists). */
function entryExists(p) {
  return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

function sameFile(p, sha) {
  try {
    // lstat: a symlink is never "the same file", even if its target matches.
    return fs.lstatSync(p).isFile() && sha256(p) === sha;
  } catch {
    return false;
  }
}

/** A journal entry may only name a file directly inside the release folder. */
function plainName(n, i) {
  if (typeof n !== "string" || !n || n === "." || n === ".." || /[\\/:]/.test(n)) throw corrupt(`${i + 1}번째 항목의 이름 ${JSON.stringify(n)}`);
  return n;
}

/**
 * Undoes an unfinished transaction in two phases.
 *
 * 1. Plan, without touching anything: walk the steps newest first against the
 *    files on disk and work out every rename needed. Each step is checked
 *    against the hashes in the journal: the new file we move back out must be
 *    the one we placed, every original must still exist (as its backup, or
 *    untouched in place) with the content it had, and staged copies must be
 *    intact. If any original could not be brought back, nothing is moved.
 * 2. Carry out the plan in order, stopping at the first failure (the journal
 *    and backups are kept, and the next run plans again from the new state).
 *
 * Returns the names it could not undo (empty when done).
 */
function rollback(outDir, j) {
  const liveOf = (n) => path.join(outDir, n);
  const stagedOf = (n) => path.join(outDir, STAGE, n);
  const key = (n) => n.toLowerCase();
  checkAccounted(outDir, j);
  for (const f of j.set) {
    const staged = stagedOf(f.name);
    if (entryExists(staged) && !sameFile(staged, f.sha)) throw blocked(`준비 폴더의 새 ${f.name}이 손상됨`);
    const placedStep = j.steps.some((s) => s.kind === "placed" && key(s.name) === key(f.name));
    if (!placedStep && !entryExists(staged)) throw blocked(`새 ${f.name}이 준비 폴더에도 기록에도 없음`);
  }

  // Simulated presence of live names while planning.
  const present = new Map();
  const isPresent = (n) => (present.has(key(n)) ? present.get(key(n)) : entryExists(liveOf(n)));
  const plan = [];
  for (const s of [...j.steps].reverse()) {
    const live = liveOf(s.name);
    if (s.kind === "placed") {
      // The new file is back in (or never left) the stage - its hash was
      // checked above - so this step is already undone or never happened.
      // Whatever is live now is checked against the original by the aside step.
      // (This is also the state an interrupted rollback leaves behind.)
      if (!isPresent(s.name) || entryExists(stagedOf(s.name))) continue;
      const staged = stagedOf(s.name);
      if (!sameFile(live, s.sha)) throw blocked(`${s.name}이 기록된 새 파일과 다름`);
      const aside = j.steps.find((a) => a.kind === "aside" && key(a.name) === key(s.name));
      if (aside && !entryExists(liveOf(aside.backup))) {
        // The original's backup is gone. Only if the original had exactly
        // these bytes is the folder already as it was; otherwise refuse.
        if (aside.sha === s.sha) continue;
        throw blocked(`원래 ${s.name}의 백업(${aside.backup})이 없어 되돌릴 수 없음`);
      }
      plan.push({ from: live, to: staged, name: s.name });
      present.set(key(s.name), false);
    } else {
      const backup = liveOf(s.backup);
      if (entryExists(backup)) {
        if (!sameFile(backup, s.sha)) throw blocked(`백업 ${s.backup}이 원래 파일과 다름`);
        if (isPresent(s.name)) throw blocked(`${s.name} 자리가 비지 않아 백업을 되돌릴 수 없음`);
        plan.push({ from: backup, to: live, name: s.name });
        present.set(key(s.name), true);
      } else if (!(isPresent(s.name) && sameFile(live, s.sha))) {
        // No backup: fine only if the original is still in place with its
        // content (the rename never happened); otherwise it is lost.
        throw blocked(`원래 ${s.name}을 되살릴 수 없음 (백업 없음)`);
      }
    }
  }

  // The planned end state must already pass what checkRolledBack() verifies
  // afterwards, so an inconsistent folder is rejected before the first rename.
  // (Originals are covered above: each aside step either restores a verified
  // backup or found the original in place with its recorded hash.)
  for (const f of j.set) {
    const started = j.steps.some((s) => key(s.name) === key(f.name));
    const hadOriginal = j.steps.some((s) => s.kind === "aside" && key(s.name) === key(f.name));
    if (started && !hadOriginal && isPresent(f.name)) throw blocked(`원래 없던 ${f.name}이 되돌린 뒤에도 남게 됨`);
  }
  // ...and every backup entry of this transaction (any kind of entry, even a
  // dangling link) is moved back by the plan.
  const consumed = new Set(plan.map((a) => key(path.basename(a.from))));
  for (const n of fs.readdirSync(outDir)) {
    const m = BACKUP.exec(n);
    if (m && m[2] === String(j.stamp) && !consumed.has(key(n))) throw blocked(`백업 자리 ${n}이 되돌린 뒤에도 남게 됨`);
  }

  for (const a of plan) {
    try {
      guard();
      fs.mkdirSync(path.dirname(a.to), { recursive: true });
      // A rename onto an existing file would replace it; the plan never does that.
      if (entryExists(a.to)) throw new Error("대상이 이미 있음");
      renameRetry(a.from, a.to);
    } catch (e) {
      if (e instanceof FolderReplaced) throw e;
      return [`${a.name} (${e.code || e.message})`];
    }
  }
  return [];
}

/**
 * Confirms a rollback really restored the folder: every original is back with
 * its recorded content, no file of the new set that had no original is live,
 * and no backup of this transaction is left over. Otherwise the journal, stage
 * and backups are kept and the user is told.
 */
function checkRolledBack(outDir, j) {
  const key = (n) => n.toLowerCase();
  const problems = [];
  const asides = j.steps.filter((s) => s.kind === "aside");
  for (const a of asides) {
    if (!sameFile(path.join(outDir, a.name), a.sha)) problems.push(`원래 ${a.name}이 제자리에 없음`);
  }
  for (const f of j.set) {
    const started = j.steps.some((s) => key(s.name) === key(f.name));
    const hadOriginal = asides.some((a) => key(a.name) === key(f.name));
    if (started && !hadOriginal && entryExists(path.join(outDir, f.name))) problems.push(`새 ${f.name}이 남아 있음`);
  }
  for (const n of fs.readdirSync(outDir)) {
    const m = BACKUP.exec(n);
    if (m && m[2] === String(j.stamp)) problems.push(`백업 ${n}이 제자리로 돌아가지 않음`);
  }
  if (problems.length) {
    throw new Error(`되돌린 결과가 기록과 맞지 않아 멈췄습니다: ${problems.join(", ")}. 기록·백업·준비 폴더는 그대로 두었으니 release 폴더를 직접 확인하세요.`);
  }
}

/**
 * Finishes whatever an earlier run left behind. Throws if an unfinished
 * transaction cannot be rolled back; its journal and backups are then kept.
 */
function recover(outDir, ours) {
  guard();
  const j = readJournal(outDir, ours);
  if (j && j.state === "swapping") {
    // The stage is created in full before the first journal write and removed
    // only after the journal, so it must exist; it is the evidence of which new
    // files were moved in (their staged copy is gone).
    if (!fs.lstatSync(path.join(outDir, STAGE), { throwIfNoEntry: false })?.isDirectory()) throw corrupt("준비 폴더(.staging)가 없음");
    const stuck = rollback(outDir, j);
    if (stuck.length) {
      throw new Error(`이전 배포가 중간에 멈춘 상태를 되돌리지 못했습니다: ${stuck.join(", ")}. 실행 중인 SelfManager.exe를 닫고 다시 실행하세요 (백업은 보존했습니다).`);
    }
    checkRolledBack(outDir, j);
  }
  // Settle the journal: queue what it leaves to delete, then remove it.
  const carry = j ? retire(outDir, j) : { pending: [], keepStage: false };
  guard();
  fs.rmSync(path.join(outDir, `${JOURNAL}.tmp`), { force: true });
  if (!carry.keepStage) fs.rmSync(path.join(outDir, STAGE), { recursive: true, force: true });
  cleanTrash(outDir, ours, j && j.state === "swapping" ? j.stamp : null);
  return carry.pending;
}

/**
 * Ends a transaction whose outcome is settled (committed, rolled back, or
 * already "done"): its delete list - the backups it set aside if it committed,
 * plus any it carried over from earlier runs - is saved, then the journal is
 * removed. Nothing is read or stat'ed for the list, so no transient error can
 * lose an entry; content is checked right before each delete.
 *
 * If the list can't be saved, the journal is rewritten as "done" with the list
 * in it, so the next run retries; the list is also returned, and a publish
 * starting now carries it in its own journal - nothing is lost while journal
 * writes work. Only if even that fails is the old journal (and its stage) kept.
 */
function retire(outDir, j) {
  const pending = [];
  const add = (t) => pending.some((x) => x.name === t.name) || pending.push(t);
  j.carry.forEach(add);
  if (j.state === "committed") j.steps.filter((s) => s.kind === "aside").forEach((s) => add({ name: s.backup, sha: s.sha }));
  try {
    // A list already saved for this stamp came from this same journal.
    if (pending.length && !entryExists(path.join(outDir, trashName(j.stamp)))) {
      writeAtomic(outDir, trashName(j.stamp), { list: pending, sum: sha256text(JSON.stringify(pending)) });
    }
    guard();
    fs.rmSync(path.join(outDir, JOURNAL), { force: true });
    return { pending: [], keepStage: false };
  } catch (e) {
    if (e instanceof FolderReplaced) throw e;
  }
  console.warn(`[publish] 삭제 목록을 저장하지 못해 다음 실행 때 다시 시도합니다: ${pending.map((t) => t.name).join(", ")}`);
  if (j.state === "done" && j.carry.length === pending.length) return { pending, keepStage: false }; // already recorded as such
  try {
    writeJournal(outDir, { stamp: j.stamp, state: "done", set: [], steps: [], carry: pending });
    return { pending, keepStage: false };
  } catch (e) {
    if (e instanceof FolderReplaced) throw e;
    // The old journal stays as it is; a "swapping" one still needs its stage.
    return { pending, keepStage: j.state === "swapping" };
  }
}

// One delete list per committed transaction, so queuing never has to read
// (or rewrite) an older list that might be briefly unreadable.
const trashName = (stamp) => `.publish-trash-${stamp}.json`;
const TRASH_FILE = /^\.publish-trash-(\d+)\.json$/;

/**
 * Deletes queued backups that still hold the recorded content. Cleanup is
 * optional: any error (a list or backup locked by antivirus, metadata briefly
 * inaccessible, an old exe still running from a backup) keeps that entry or
 * list for a later run and never stops the publish. A list that is damaged
 * deletes nothing.
 */
function cleanTrash(outDir, ours, activeStamp) {
  let names;
  try {
    names = fs.readdirSync(outDir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(".publish-trash-") && n.endsWith(".json.tmp")) {
      try {
        guard();
        fs.rmSync(path.join(outDir, n), { force: true });
      } catch (e) {
        if (e instanceof FolderReplaced) throw e;
        /* otherwise retried later */
      }
      continue;
    }
    if (!TRASH_FILE.test(n)) continue;
    const file = path.join(outDir, n);
    let list;
    try {
      list = readTrashFile(file, ours);
    } catch (e) {
      if (e.damaged) {
        console.warn(`[publish] 삭제 목록 ${n}이 손상돼 무시합니다. 남은 .old- 백업은 직접 지워도 됩니다.`);
        try {
          guard();
          fs.rmSync(file, { force: true });
        } catch (e) {
          if (e instanceof FolderReplaced) throw e;
          /* otherwise retried later */
        }
      }
      continue; // unreadable right now: keep it for a later run
    }
    const left = [];
    for (const t of list) {
      const p = path.join(outDir, t.name);
      try {
        if (BACKUP.exec(t.name)[2] === String(activeStamp)) {
          left.push(t); // belongs to the transaction being recovered: never touch
          continue;
        }
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (!st) continue; // already gone
        if (!st.isFile()) continue; // a link or folder now: not ours to delete
        if (sha256(p) !== t.sha) continue; // changed since: not ours to delete
        guard();
        fs.rmSync(p, { force: true });
      } catch (e) {
        if (e instanceof FolderReplaced) throw e;
        left.push(t);
      }
    }
    try {
      guard();
      if (!left.length) fs.rmSync(file, { force: true });
      else if (left.length !== list.length) writeAtomic(outDir, n, { list: left, sum: sha256text(JSON.stringify(left)) });
    } catch (e) {
      if (e instanceof FolderReplaced) throw e;
      /* the old list stays; entries already deleted are simply "gone" next time */
    }
  }
}

/** Reads one delete list. Throws {damaged: true} for a bad list, anything else for "can't read now". */
function readTrashFile(file, ours) {
  const text = fs.readFileSync(file, "utf8");
  const damaged = () => Object.assign(new Error("damaged"), { damaged: true });
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw damaged();
  }
  const list = doc && doc.list;
  if (!Array.isArray(list) || doc.sum !== sha256text(JSON.stringify(list))) throw damaged();
  return list.map((t) => {
    const m = t && typeof t.name === "string" && !/[\\/:]/.test(t.name) ? BACKUP.exec(t.name) : null;
    if (!m || !ours(m[1]) || typeof t.sha !== "string" || !/^[0-9a-f]{64}$/.test(t.sha)) throw damaged();
    return { name: t.name, sha: t.sha };
  });
}

/**
 * @param {string} outDir   folder to publish into (e.g. <root>/release)
 * @param {{from: string, name: string}[]} files  the complete new set
 * @param {(name: string) => boolean} ours  names this tool owns; owned files not
 *        in the new set (e.g. an older version's installer) are removed as part
 *        of the same transaction, other files are left alone
 */
export async function publish(outDir, files, ours) {
  fs.mkdirSync(outDir, { recursive: true });
  const id = dirId(outDir);
  // Two locks, both must be free. The identity lock catches other spellings of
  // the same folder (junction, UNC share, 8.3 name); the real-path lock catches
  // a folder that was replaced by a new one at the same place.
  const keys = [`path:${fs.realpathSync.native(outDir).toLowerCase()}`];
  if (id) keys.unshift(`id:${id}`);
  const held = [];
  try {
    for (const k of keys) held.push(await lockKey(k));
    // The folder may have been swapped while we were taking the locks.
    if (dirId(outDir) !== id) throw new FolderReplaced("잠금을 잡는 사이 release 폴더가 바뀌었습니다. 다시 실행하세요.");
    pinned = { dir: outDir, id };
    publishLocked(outDir, files, ours);
  } finally {
    pinned = null;
    for (const unlock of held.reverse()) await unlock();
  }
}

function lockEndpoint(name) {
  const key = crypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
  return process.platform === "win32" ? `\\\\.\\pipe\\selfmanager-publish-${key}` : path.join(os.tmpdir(), `selfmanager-publish-${key}.sock`);
}

/** Takes an exclusive, crash-safe lock. Fails fast if another publish holds it. */
async function lockKey(name) {
  const ep = lockEndpoint(name);
  const listen = () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer((c) => c.destroy());
      srv.once("error", reject);
      srv.listen(ep, () => resolve(srv));
    });
  const busy = () => new Error("다른 배포(npm run build:pc)가 이 release 폴더에 쓰는 중입니다. 끝난 뒤 다시 실행하세요.");
  let srv;
  try {
    srv = await listen();
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    // Unix sockets leave a file behind when their owner dies; a live owner accepts connections.
    if (process.platform === "win32") throw busy();
    const alive = await new Promise((r) => {
      const c = net.connect(ep, () => (c.destroy(), r(true)));
      c.once("error", () => r(false));
    });
    if (alive) throw busy();
    fs.rmSync(ep, { force: true });
    try {
      srv = await listen();
    } catch (e2) {
      if (e2.code === "EADDRINUSE") throw busy();
      throw e2;
    }
  }
  return () => new Promise((r) => srv.close(() => r()));
}

function publishLocked(outDir, files, ours) {
  files.forEach((f, i) => {
    plainName(f.name, i);
    if (!ours(f.name)) throw new Error(`${f.name}은 이 도구가 관리하는 이름이 아닙니다`);
  });
  const carry = recover(outDir, ours);
  // Every file this publish will set aside is hashed for the journal; a link
  // or folder under an owned name can't be, so stop before touching anything.
  for (const n of fs.readdirSync(outDir)) {
    if (!ours(n) || BACKUP.test(n)) continue;
    if (!fs.lstatSync(path.join(outDir, n)).isFile()) {
      throw new Error(`release 폴더의 ${n}이 일반 파일이 아닙니다(링크나 폴더). 아무것도 바꾸지 않았으니 그 항목을 정리한 뒤 다시 실행하세요.`);
    }
  }
  const stage = path.join(outDir, STAGE);
  // Never reuse a stamp still in use (the clock can go back), so a backup name
  // always identifies exactly one transaction. Stamps only need to be unique,
  // not ordered: start at the clock and step past used ones, so even an absurd
  // stamp in some name can't push the new one out of the safe-integer range.
  const used = new Set();
  for (const n of fs.readdirSync(outDir)) {
    const m = BACKUP.exec(n) || TRASH_FILE.exec(n); // a delete list's name carries a stamp too
    if (m) used.add(m[m.length - 1]);
  }
  for (const c of carry) used.add(BACKUP.exec(c.name)[2]); // their files may already be gone
  let stamp = Date.now();
  while (used.has(String(stamp))) stamp++;
  if (!Number.isSafeInteger(stamp) || stamp <= 0) throw new Error(`배포 시각을 정하지 못했습니다(${stamp}). 아무것도 바꾸지 않았습니다.`);

  // 1. Copy and verify the whole new set before touching any live file.
  try {
    guard();
    fs.mkdirSync(stage);
    for (const f of files) {
      const dest = path.join(stage, f.name);
      guard();
      fs.copyFileSync(f.from, dest);
      f.sha = sha256(dest);
      if (f.sha !== sha256(f.from)) throw new Error(`복사한 ${f.name}이 원본과 다릅니다`);
    }
  } catch (e) {
    if (e instanceof FolderReplaced) throw e;
    guard();
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`새 파일을 준비하지 못해 release 폴더는 그대로 두었습니다: ${e.message}`);
  }

  // 2. Swap, logging each step *before* doing it.
  const j = { stamp, state: "swapping", set: files.map((f) => ({ name: f.name, sha: f.sha })), steps: [], carry };
  const step = (s, act) => {
    j.steps.push(s);
    writeJournal(outDir, j);
    act();
  };
  // Journal entries are names relative to the folder: if the folder is moved,
  // recovery resolves them against where it is now.
  const setAside = (name) => {
    const backup = backupName(name, stamp);
    step({ kind: "aside", name, backup, sha: sha256(path.join(outDir, name)) }, () => renameRetry(path.join(outDir, name), path.join(outDir, backup)));
  };
  try {
    for (const f of files) {
      if (entryExists(path.join(outDir, f.name))) setAside(f.name);
      step({ kind: "placed", name: f.name, sha: f.sha }, () => renameRetry(path.join(stage, f.name), path.join(outDir, f.name)));
    }
    for (const n of fs.readdirSync(outDir)) {
      if (ours(n) && !files.some((f) => f.name === n) && !BACKUP.test(n)) setAside(n);
    }
    // 3. Commit point: once this record is on disk the new set is the truth.
    //    If writing it fails, the transaction is aborted like any other failure.
    j.state = "committed";
    writeJournal(outDir, j);
  } catch (e) {
    // Our journal and backups live in the old folder, which the next publish
    // there recovers. Never "roll back" into a folder that isn't ours.
    if (e instanceof FolderReplaced) throw e;
    j.state = "swapping";
    const stuck = rollback(outDir, j);
    if (stuck.length) {
      // Keep journal + backups: the next run finishes this rollback first.
      throw new Error(`교체 중 실패했고 일부를 되돌리지 못했습니다: ${stuck.join(", ")}. 백업과 기록은 보존했으니 실행 중인 SelfManager.exe를 닫고 다시 실행하면 자동으로 복구됩니다. 원인: ${e.code || e.message}`);
    }
    checkRolledBack(outDir, j);
    const left = retire(outDir, j);
    guard();
    fs.rmSync(path.join(outDir, `${JOURNAL}.tmp`), { force: true });
    if (!left.keepStage) fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`교체 중 실패해 release 폴더를 이전 상태로 되돌렸습니다 (실행 중인 SelfManager.exe를 닫고 다시 실행하세요): ${e.code || e.message}`);
  }

  // Committed: clear journal, stage and (where possible) backups. The publish
  // already succeeded; if cleanup fails, the committed journal makes the next
  // run finish it.
  try {
    recover(outDir, ours);
  } catch (e) {
    if (e instanceof FolderReplaced) throw e;
    console.warn(`[publish] 배포는 끝났고, 정리(옛 백업 삭제)는 다음 실행 때 마칩니다: ${e.code || e.message}`);
  }
}
