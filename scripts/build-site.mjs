// Builds the public site (intro + privacy policy for the Google OAuth consent
// screen) into site-dist/ for Firebase Hosting. Runs as Firebase's predeploy.
//
// The contact address is not kept in the repo: it comes from SITE_CONTACT_EMAIL
// (environment, or the project-root .env that is git-ignored) and replaces
// __CONTACT_EMAIL__ in the pages. Without it the build stops, so a page with
// a placeholder never goes live.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "site");
const out = path.join(root, "site-dist");

function fromDotEnv(key) {
  try {
    const line = fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/).find((l) => l.trim().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

const email = (process.env.SITE_CONTACT_EMAIL || fromDotEnv("SITE_CONTACT_EMAIL")).trim();
if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) {
  console.error("SITE_CONTACT_EMAIL이 없거나 이메일 형식이 아닙니다. 프로젝트 루트 .env에 SITE_CONTACT_EMAIL=문의받을@주소 를 넣으세요.");
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  if (name.endsWith(".html")) {
    fs.writeFileSync(path.join(out, name), fs.readFileSync(from, "utf8").replaceAll("__CONTACT_EMAIL__", email));
  } else {
    fs.copyFileSync(from, path.join(out, name));
  }
}
// One source of truth for the icons: the app's own.
fs.copyFileSync(path.join(root, "icon.png"), path.join(out, "icon.png"));
fs.copyFileSync(path.join(root, "public", "favicon.svg"), path.join(out, "favicon.svg"));

const left = fs.readdirSync(out).filter((n) => n.endsWith(".html") && fs.readFileSync(path.join(out, n), "utf8").includes("__CONTACT_EMAIL__"));
if (left.length) {
  console.error(`치환되지 않은 자리표시자가 남았습니다: ${left.join(", ")}`);
  process.exit(1);
}
console.log(`site-dist/ 준비 완료 (${fs.readdirSync(out).length}개 파일)`);
