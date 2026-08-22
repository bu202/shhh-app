// 배포 산출물 검사. `node scripts/test-dist.mjs`
//
// 라이브에서 `/CLAUDE.md` · `/worker/index.js` · `/scripts/test-friends.mjs` · `/wrangler.jsonc` 가
// 전부 200 이었다. 서버 소스와 내부 문서가 열려 있으면 방어를 읽고 우회 지점을 고르면 된다.
// 이 검사는 **빌드를 직접 돌린 뒤** 결과물을 훑는다 — 사람이 기억해서 돌리는 검사는 안 돈다.
import assert from "node:assert";
import { build, FORBIDDEN, swCacheName } from "./build.mjs";
import { readFileSync } from "node:fs";

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

// ── 화면 코드가 부르는 바깥 origin 이 CSP 에 다 열려 있나 ────────────────
// ⛔ **CSP 위반은 조용하다.** 위젯이 안 뜨고 콘솔도 별말 없어서, 빼고 배포해 대조하기 전까지
//    원인을 못 찾는다 — sldict 그림에서 이미 겪었다(`_headers` 머리말). 그래서 코드가 실제로
//    적어 둔 주소를 긁어 **정책과 대조한다.** 손으로 세는 목록은 반드시 낡는다.
{
  const csp = /Content-Security-Policy: ([^\n]+)/.exec(readFileSync(new URL("../_headers", import.meta.url), "utf8"));
  assert.ok(csp, "_headers 에서 CSP 를 못 읽었다 — 검사기가 낡았다");
  const client = ["js/auth.js", "js/authApi.js", "js/app.js", "js/friends.js", "service-worker.js"]
    .map((f) => readFileSync(new URL("../" + f, import.meta.url), "utf8")).join("\n");
  // ⚠️ **주석을 지우고 본다.** 「예전에는 이 주소였다」 같은 기록이 걸리면, 검사를 통과시키려고
  //    그 기록을 지우게 된다 — 왜 그렇게 했는지가 사라지는 쪽이 더 나쁘다.
  const code = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const origins = new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/g)].map((m) => m[1]));
  // 코드 안의 주소가 전부 「불러오는 것」은 아니다. 제공자 인증 주소는 화면 이동이지 fetch 가 아니다.
  const IGNORE = new Set(["developers.cloudflare.com", "kauth.kakao.com", "nid.naver.com",
                          "accounts.google.com", "kapi.kakao.com", "openapi.naver.com",
                          "oauth2.googleapis.com", "www.googleapis.com", "shhh-app.pages.dev",
                          "shhh.example.com", "example.com"]);
  for (const o of origins) {
    if (IGNORE.has(o)) continue;
    assert.ok(csp[1].includes(o),
      `화면 코드가 https://${o} 를 부르는데 CSP 에 없다 — 배포하면 조용히 막힌다`);
  }
  // Turnstile 은 **스크립트와 iframe 둘 다** 필요하다. 하나만 열면 위젯이 조용히 안 뜬다.
  if (/challenges\.cloudflare\.com/.test(code)) {
    const dirs = Object.fromEntries(csp[1].split(";").map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k, v.join(" ")];
    }));
    for (const d of ["script-src", "frame-src"])
      assert.ok((dirs[d] || "").includes("challenges.cloudflare.com"),
        `CSP 의 ${d} 에 challenges.cloudflare.com 이 없다 — 사람 확인 위젯이 조용히 안 뜬다`);
  }
}

// ── 호스트 잠금 미들웨어를 **실제로 돌려 본다** (2026-08-22 · 결정 0·1) ──
// ⛔ 소스를 훑는 검사만 두면 「조건을 통째로 꺼도 통과」한다(돌연변이 N12 가 그랬다).
//    Pages 가 정적 요청에 Worker 를 안 태우므로, 이 파일이 화면 쪽의 유일한 방어다.
{
  const mw = await import("../functions/_middleware.js");
  const run = (env, url, method = "GET") =>
    mw.onRequest({ env, request: new Request(url, { method }), next: () => new Response("next") });
  const OFF = { APP_ORIGIN: "https://shhh-app.pages.dev" };
  const ON = { EDGE_GUARD: "waf", APP_ORIGIN: "https://shhh.example.com" };

  // ① 선언이 없으면 **아무것도 안 한다** — 도메인이 붙기 전에 켜면 지금 주소가 죽는다.
  assert.equal((await run(OFF, "https://shhh-app.pages.dev/")).status, 200,
    "EDGE_GUARD 가 없는데 리다이렉트했다 — 지금 쓰는 주소가 죽는다");
  // ② waf + 정식 호스트 → 그대로 통과.
  assert.equal((await run(ON, "https://shhh.example.com/app")).status, 200,
    "정식 호스트인데 리다이렉트했다");
  // ③ waf + pages.dev → 302 로 정식 호스트. **쿼리와 경로를 잃지 않는다.**
  const r = await run(ON, "https://shhh-app.pages.dev/x?y=1");
  assert.equal(r.status, 302, `pages.dev 우회가 ${r.status} 로 통과했다 — WAF 를 지나지 않는 경로다`);
  assert.equal(r.headers.get("Location"), "https://shhh.example.com/x?y=1",
    "리다이렉트가 경로·쿼리를 잃었다");
  // ④ GET·HEAD 만 옮긴다.
  assert.equal((await run(ON, "https://shhh-app.pages.dev/api/book", "POST")).status, 200,
    "POST 를 리다이렉트했다 — 본문이 있는 요청은 API 의 403 이 답한다");
  // ⑤ waf 인데 APP_ORIGIN 이 아직 pages.dev 면 **아무것도 안 한다**(무한 리다이렉트 방지).
  assert.equal((await run({ EDGE_GUARD: "waf", APP_ORIGIN: "https://shhh-app.pages.dev" },
    "https://shhh-app.pages.dev/")).status, 200, "자기 자신으로 리다이렉트했다 — 무한 루프다");
}

// ── 호스트 잠금 규칙이 두 곳에서 같은가 (2026-08-22 · 결정 0·1 · 위협 55) ──
// `functions/_middleware.js` 는 정적 요청을, `worker/index.js` 는 API 를 막는다. Pages 가
// 정적 요청에 Worker 를 안 태우므로 규칙이 두 벌일 수밖에 없다 — 어긋나면 한쪽만 막힌다.
{
  const mw = readFileSync(new URL("../functions/_middleware.js", import.meta.url), "utf8");
  const wk = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  for (const [re, why] of [
    [/"waf"/, "waf 모드에서만 도는 조건"],
    [/endsWith\(".pages.dev"\)/, "pages.dev 를 정식 호스트로 인정하지 않는 규칙"],
    [/new URL\(env\.APP_ORIGIN\)\.host/, "정식 호스트의 출처(APP_ORIGIN)"],
  ]) {
    assert.match(mw, re, `functions/_middleware.js 에 ${why} 가 없다`);
    assert.match(wk, re, `worker/index.js 에 ${why} 가 없다 — 두 곳의 규칙이 어긋난다`);
  }
  // GET·HEAD 만 옮긴다. 본문이 있는 요청을 리다이렉트하면 두 번 나가거나 GET 으로 바뀐다.
  assert.match(mw, /"GET" \|\| ctx\.request\.method === "HEAD"/,
    "_middleware 가 GET·HEAD 밖의 method 도 리다이렉트한다");
  // 주석에도 308 이라는 낱말이 나오므로 **실제 status 자리만** 본다.
  assert.ok(!/status:\s*(301|308)/.test(mw), "_middleware 가 영구 리다이렉트를 쓴다 — 되돌릴 수 없다");
}

// ── 테스트 전용 어댑터가 배포에 실려 나가지 않았나 (2026-08-22) ───────────
// `scripts/_workers-shim.mjs` 는 Node 스위트가 `crypto.subtle.timingSafeEqual` 을 쓸 수 있게
// 채워 주는 어댑터다. **운영 번들에 들어가면 그 순간 운영이 어느 구현으로 도는지 알 수 없다** —
// 약한 쪽이 조용히 이기는 길이라, 여기서 전수로 막는다.
{
  for (const f of files)
    assert.ok(!/_workers-shim/.test(f), `dist/ 에 테스트 어댑터가 있다: ${f}`);
  // Pages 가 따로 번들하는 `functions/` 와 그것이 끌어가는 `worker/` 도 같이 본다.
  // **부르는 자리만** 본다 — 「어댑터가 어디 사는가」를 적은 주석까지 막으면 규칙을 설명하는
  // 것이 벌이 된다.
  for (const f of ["functions/api/[[path]].js", "functions/_middleware.js",
                   "worker/index.js", "worker/ledger.js", "worker/ops.js",
                   "worker/policies.js", "worker/cleanup/index.js"]) {
    const body = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    assert.ok(!/(import|require)[^\n]*_workers-shim/.test(body),
      `${f} 가 테스트 어댑터를 import 한다 — 운영 번들에 들어간다`);
  }
  // 그리고 운영 코드는 **런타임 API 를 직접 부른다.** 자기 구현으로 덮어쓰면 그것도 fallback 이다.
  const w = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.ok(/crypto\.subtle\.timingSafeEqual\(/.test(w),
    "worker/index.js 가 timing-safe 비교 API 를 부르지 않는다");
  assert.ok(!/timingSafeEqual\s*=/.test(w),
    "worker/index.js 가 timingSafeEqual 을 스스로 정의한다 — 그건 fallback 이다");
}

console.log(`test-dist: 통과 — dist/ ${files.length}개, 내부 파일 0개, 선캐시 ${assets.length}개 전부 존재, `
  + `정책 ${pol.length}개(pv ${POLICY_BUNDLE.pv}), 캐시 ${cacheName}`);
