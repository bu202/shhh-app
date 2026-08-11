// 배포 산출물 검사. `node scripts/test-dist.mjs`
//
// 라이브에서 `/CLAUDE.md` · `/worker/index.js` · `/scripts/test-friends.mjs` · `/wrangler.jsonc` 가
// 전부 200 이었다. 서버 소스와 내부 문서가 열려 있으면 방어를 읽고 우회 지점을 고르면 된다.
// 이 검사는 **빌드를 직접 돌린 뒤** 결과물을 훑는다 — 사람이 기억해서 돌리는 검사는 안 돈다.
import assert from "node:assert";
import { build, FORBIDDEN } from "./build.mjs";

const files = await build();

// 1. 금지 파일이 하나도 없다.
for (const f of files)
  for (const re of FORBIDDEN)
    assert.ok(!re.test(f), `dist/ 에 나가면 안 되는 파일이 있다: ${f} (${re})`);

// 2. 사람이 이름으로 아는 것들도 직접 짚는다 — 정규식이 언젠가 느슨해질 수 있다.
for (const bad of ["CLAUDE.md", "README.md", "package.json", "wrangler.jsonc",
                   "worker/index.js", "scripts/test-friends.mjs", "docs/API_KEY_GUIDE.md"])
  assert.ok(!files.includes(bad), `dist/ 에 ${bad} 가 있다`);

// 3. 앱이 서는 데 필요한 것은 다 있다. 뺄 것만 세면 "다 빼버린 dist" 도 통과한다.
for (const need of ["index.html", "privacy.html", "manifest.webmanifest", "service-worker.js",
                    "_headers", "css/style.css", "js/app.js", "js/auth.js", "js/authApi.js",
                    "js/friends.js", "data/ksl-dict.json", "data/ksl-fulldict.json",
                    "data/ksl-compounds.json", "data/ksl-verified.json", "data/ksl-meanings.json",
                    "data/ksl-daily.json", "icons/icon-192.png", "icons/icon-512.png"])
  assert.ok(files.includes(need), `dist/ 에 ${need} 가 없다 — 앱이 안 선다`);

// 4. 지화 그림 32장. 한 장이라도 빠지면 그 자모만 조용히 안 뜬다.
assert.equal(files.filter((f) => f.startsWith("assets/fingerspelling/")).length, 32, "지화 그림 수가 32장이 아니다");

// 5. service-worker 가 선캐시하는 목록이 **실제로 dist 에 있는지.** 없으면 install 의 addAll 이
//    통째로 실패해 SW 가 아예 안 붙는다 — 증상이 "오프라인이 안 된다"라서 늦게 발견된다.
const sw = files.includes("service-worker.js")
  ? (await import("node:fs/promises")).readFile(new URL("../dist/service-worker.js", import.meta.url), "utf8")
  : null;
const assets = [...(await sw).matchAll(/^\s*"([^"]+)",\s*$/gm)].map((m) => m[1])
  .filter((a) => a !== "./" && !a.startsWith("/api"));
for (const a of assets)
  assert.ok(files.includes(a), `service-worker 가 선캐시하는 ${a} 가 dist/ 에 없다 — SW 설치가 통째로 실패한다`);

console.log(`test-dist: 통과 — dist/ ${files.length}개, 내부 파일 0개, 선캐시 ${assets.length}개 전부 존재`);
