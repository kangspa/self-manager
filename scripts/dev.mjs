// `npm run app`: starts `tauri dev` on the first free port pair from 1420.
// The installed app never needs a port (it loads its UI through Tauri's own
// protocol); only the dev server does, and 1420 may be taken by another program.
// Extra arguments are passed through, e.g. `npm run app -- --release`.
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function freeOn(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    // No IPv6 on this machine counts as free there.
    s.once("error", (e) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// "localhost" can resolve to either address, so both must be free.
const free = async (port) => (await freeOn(port, "127.0.0.1")) && (await freeOn(port, "::1"));

async function findPort(start) {
  for (let p = start; p < start + 200; p += 2) {
    // Vite uses p for the page and p+1 for hot reload.
    if ((await free(p)) && (await free(p + 1))) return p;
  }
  throw new Error(`${start}~${start + 200} 사이에 빈 포트가 없습니다`);
}

const preferred = Number(process.env.SM_DEV_PORT) || 1420;
const port = await findPort(preferred);
if (port !== preferred) console.log(`[self-manager] ${preferred}번 포트가 사용 중이라 ${port}번으로 엽니다`);

// Passed as a file: Windows' shell strips the quotes from inline JSON.
const config = path.join(os.tmpdir(), `self-manager-dev-${port}.json`);
fs.writeFileSync(config, JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }));
const child = spawn("npx", ["tauri", "dev", "--config", config, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, SM_DEV_PORT: String(port) },
});
child.on("exit", (code) => process.exit(code ?? 0));
