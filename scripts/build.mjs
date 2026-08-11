// 배포 산출물 만들기. `npm run build` → `dist/`
//
// 왜 생겼나: `pages_build_output_dir` 이 `.` 이라 **레포 루트가 통째로 공개되고 있었다** —
// CLAUDE.md · worker/index.js · scripts/*.mjs · wrangler.jsonc · package.json 이 전부 200 이었다.
// 서버 소스와 내부 문서가 누구에게나 열려 있으면, 여기 적힌 방어를 읽고 우회 지점을 고르면 된다.
//
// **denylist 가 아니라 allowlist 다.** 뺄 것을 적는 방식(.assetsignore)은 새 파일이 생길 때마다
// 사람이 기억해야 하고, 잊으면 조용히 공개된다 — 잊었다는 사실조차 안 보인다. 넣을 것만 적으면
// 새 파일의 기본값이 "안 나감"이 된다(기본값이 안전한 쪽 — MASTER_UIDS·DEV_ORIGINS 와 같은 규칙).
//
// ⚠️ `functions/` 는 여기 없다. Pages 는 **프로젝트 루트의 functions/** 를 따로 읽어 번들한다 —
//    dist 안에 넣는 것이 아니다. worker/index.js 도 그 번들에 들어가므로 정적으로 나갈 필요가 없다.
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = path.join(ROOT, "dist");

// 브라우저가 실제로 부르는 것만. 근거는 index.html·privacy.html 의 태그,
// service-worker.js 의 ASSETS, js/app.js 의 fetch() 다.
export const INCLUDE = [
  "index.html",
  "privacy.html",
  "manifest.webmanifest",
  "service-worker.js",
  "_headers",                 // 보안 헤더. 빠지면 CSP 가 통째로 사라진다
  "css",
  // js/camera.js 는 뺀다 — index.html 이 로드하지 않는다(6단계로 미룸). 되살릴 때 여기 추가.
  "js/app.js",
  "js/authApi.js",
  "js/auth.js",
  "js/friends.js",
  // data/ 는 통째로 안 넣는다: ksl-pins.json(사람이 고른 부품 수형)·ksl-knn-samples.backup.json 은
  // 빌드 입력이지 앱이 부르는 파일이 아니다.
  "data/ksl-dict.json",
  "data/ksl-fulldict.json",
  "data/ksl-compounds.json",
  "data/ksl-verified.json",
  "data/ksl-meanings.json",
  "data/ksl-daily.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "assets/fingerspelling",
];

// 나가면 안 되는 것. 빌드가 아니라 **검사**를 위한 목록이다 — allowlist 가 이미 막고 있지만,
// 누가 allowlist 에 폴더를 통째로 넣는 순간 조용히 새기 때문에 결과물을 한 번 더 훑는다.
export const FORBIDDEN = [
  /(^|\/)worker(\/|$)/, /(^|\/)functions(\/|$)/, /(^|\/)scripts(\/|$)/, /(^|\/)docs(\/|$)/,
  /(^|\/)design(\/|$)/, /(^|\/)brand(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/,
  /(^|\/)\.wrangler(\/|$)/, /\.md$/i, /wrangler\.jsonc?$/, /package(-lock)?\.json$/,
  /^\.env/, /\/\.env/, /\.mjs$/, /\.py$/, /\.DS_Store$/, /검수/, /캡처/,
];

export async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  const missing = [];
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    if (!existsSync(src)) { missing.push(rel); continue; }
    await mkdir(path.dirname(path.join(DIST, rel)), { recursive: true });
    await cp(src, path.join(DIST, rel), { recursive: true });
  }
  // 목록에 적힌 파일이 사라졌으면 **조용히 넘어가지 않는다.** 빠진 채로 배포되면
  // 증상이 "그림이 안 뜬다"·"CSP 가 없다"라서 사람이 늦게 알아챈다.
  if (missing.length) throw new Error("빌드 목록에 있는데 파일이 없다: " + missing.join(", "));
  return await listDist();
}

export async function listDist(dir = DIST, base = "") {
  const out = [];
  for (const name of await readdir(dir)) {
    const rel = base ? base + "/" + name : name;
    const s = await stat(path.join(dir, name));
    if (s.isDirectory()) out.push(...(await listDist(path.join(dir, name), rel)));
    else out.push(rel);
  }
  return out;
}

// 함정 20·53: import 한 스크립트의 하단이 실행되면 안 된다.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const files = await build();
  console.log(`dist/ ${files.length}개 파일`);
}
