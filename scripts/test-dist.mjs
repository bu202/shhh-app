// 배포 산출물 검사. `node scripts/test-dist.mjs`
//
// 라이브에서 `/CLAUDE.md` · `/worker/index.js` · `/scripts/test-friends.mjs` · `/wrangler.jsonc` 가
// 전부 200 이었다. 서버 소스와 내부 문서가 열려 있으면 방어를 읽고 우회 지점을 고르면 된다.
// 이 검사는 **빌드를 직접 돌린 뒤** 결과물을 훑는다 — 사람이 기억해서 돌리는 검사는 안 돈다.
import assert from "node:assert";
import { build, FORBIDDEN, swCacheName } from "./build.mjs";

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

// 3b. 정책 문서. **폴더를 통째로 넣는 유일한 자리**라 안에 무엇이 들었는지 따로 본다.
//     허용 확장자를 좁혀 두지 않으면 누가 `.md` 나 `.sql` 을 여기 두는 순간 조용히 공개된다.
const pol = files.filter((f) => f.startsWith("policies/"));
for (const f of pol)
  assert.ok(/\.(html|txt|json)$/.test(f), `policies/ 에 허용되지 않은 파일이 있다: ${f}`);
assert.ok(files.includes("policies/manifest.json"), "policies/manifest.json 이 없다");
// 서버 상수가 가리키는 **현재 번들 파일이 실제로 나갔는지.** 하나라도 없으면 가입 화면이
// 자기가 렌더할 바이트를 해시할 수 없어 가입 버튼을 못 그린다(fail-closed 라 조용히 막힌다).
const { POLICY_BUNDLE } = await import("../worker/policies.js");
for (const k of Object.keys(POLICY_BUNDLE.docs))
  assert.ok(files.includes(POLICY_BUNDLE.docs[k].path),
    `현재 정책 번들의 ${k} 파일이 dist 에 없다: ${POLICY_BUNDLE.docs[k].path}`);
// 원본(살아 있는 파일)은 나가지 않는다.
assert.ok(!files.some((f) => f.startsWith("policies-src/")), "dist/ 에 policies-src/ 가 있다");

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

// 6. **캐시 이름이 자산 내용에 묶여 있는지.** 사람이 기억해서 버전을 올리는 방식은 잊는다 —
//    실제로 잊었다: js/friends.js·js/authApi.js 의 응답 계약을 바꾼 뒤에도 캐시 이름은 `shhh-v10`
//    그대로였고, 그래서 설치형 PWA 는 v10 캐시에 들어 있던 **옛 friends.js** 를 계속 돌렸다.
//    그 세대의 renderFriends 에는 실패 분기가 아예 없어서 `불러오는 중이에요…` 가 영원히 남았다.
//    이제 빌드가 선캐시 자산 전체의 해시를 이름에 박는다 — 한 글자만 바뀌어도 이름이 달라지고,
//    activate 가 옛 캐시를 통째로 지운다. 잊을 수 있는 자리가 없어진다.
const cacheName = (await sw).match(/const CACHE = PREFIX \+ "([^"]+)"/)?.[1];
assert.ok(/-[0-9a-f]{12}$/.test(cacheName || ""),
  `캐시 이름에 내용 해시가 없다(${cacheName}) — 자산이 바뀌어도 이름이 그대로라 옛 세대가 남는다`);
assert.equal(cacheName, await swCacheName(), "캐시 이름이 지금 dist 자산의 해시와 다르다");

// 7. 자산이 바뀌면 이름도 **반드시** 바뀐다. 위 검사만으로는 "해시를 늘 상수로 계산해도" 통과한다.
{
  const { writeFile, readFile } = await import("node:fs/promises");
  const target = new URL("../dist/js/friends.js", import.meta.url);
  const keep = await readFile(target, "utf8");
  const before = await swCacheName();
  await writeFile(target, keep + "\n// 자산 한 줄 변경\n");
  const after = await swCacheName();
  await writeFile(target, keep);
  assert.notEqual(after, before, "자산을 바꿨는데 캐시 이름이 그대로다 — 세대가 안 갈린다");
}

// 8. **서비스워커가 선캐시하는 정책 파일이 정확히 지금 번들인지.** 지난 판까지 선캐시하면
//    캐시가 계속 자라고, 더 나쁘게는 옛 문서를 렌더하면서 서버는 새 해시를 기록하게 된다.
{
  const { currentAssets } = await import("./policies.mjs");
  const { readManifest } = await import("./policies.mjs");
  const want = currentAssets({ bundle: POLICY_BUNDLE, versions: (await readManifest()).versions }).sort();
  const got = assets.filter((a) => a.startsWith("policies/")).sort();
  assert.deepEqual(got, want,
    "서비스워커의 정책 선캐시 목록이 지금 번들과 다르다 — `node scripts/policies.mjs` 를 다시 돌려라");
}

console.log(`test-dist: 통과 — dist/ ${files.length}개, 내부 파일 0개, 선캐시 ${assets.length}개 전부 존재, `
  + `정책 ${pol.length}개(pv ${POLICY_BUNDLE.pv}), 캐시 ${cacheName}`);
