// `npm run build:pc`: builds the Windows app and collects the results in ./release
//   release/SelfManager.exe                    portable: double-click to run, no install
//   release/SelfManager_<ver>_x64-setup.exe    installer: Start menu + desktop shortcut
//
// It always runs the real `tauri build`. Deciding whether an earlier build is
// still current is Cargo's and Vite's job (they track sources, dependencies,
// compiler, flags, wrappers and environment exactly); re-implementing that here
// can only miss cases, so there is deliberately no "skip the build" mode.
// (dist/ holds just the web UI, which is embedded into the exe at build time.)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { publish } from "./publish-release.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fail = (msg) => {
  console.error(`\n[build:pc] ${msg}`);
  process.exit(1);
};

if (process.argv.includes("--skip-build")) {
  fail("--skip-build는 없앴습니다. 오래된 exe가 나가지 않도록 항상 실제로 빌드합니다: npm run build:pc");
}

const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const rel = path.join(root, "src-tauri", "target", "release");
const exe = path.join(rel, "self-manager.exe");
// The installer for *this* version only; the bundle folder keeps old versions too.
const setupName = `${conf.productName}_${version}_x64-setup.exe`;
const setup = path.join(rel, "bundle", "nsis", setupName);

const started = Date.now();
// One fixed command string (no user input is interpolated).
const r = spawnSync("npx tauri build", { cwd: root, stdio: "inherit", shell: true });
if (r.status !== 0) fail(`빌드 실패 (종료 코드 ${r.status})`);

if (!fs.existsSync(exe)) fail(`실행 파일이 없습니다: ${path.relative(root, exe)}`);
if (!fs.existsSync(setup)) fail(`이 버전(${version})의 설치 파일이 없습니다: ${path.relative(root, setup)}`);
// This build must have written both; otherwise old files would be shipped.
for (const [label, p] of [["실행 파일", exe], ["설치 파일", setup]]) {
  if (fs.statSync(p).mtimeMs < started - 2000) fail(`빌드는 끝났지만 ${label}이 새로 만들어지지 않았습니다: ${path.relative(root, p)}`);
}

// All-or-nothing: release/ ends up with either the complete new set (and no
// installer of another version) or exactly what it had before.
const out = path.join(root, "release");
try {
  await publish(out, [{ from: exe, name: "SelfManager.exe" }, { from: setup, name: setupName }], (n) => n === "SelfManager.exe" || n.endsWith("-setup.exe"));
} catch (e) {
  fail(e.message);
}

console.log(`\n완료 (v${version}): ${path.relative(root, out)}\\`);
console.log("  SelfManager.exe  (설치 없이 실행)");
console.log(`  ${setupName}  (설치 파일)`);
