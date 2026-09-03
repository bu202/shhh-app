// 정책 문서 무결성. `node scripts/test-policies.mjs`
//
// 재는 것은 하나다: **파일 내용 · manifest · 서버 상수 세 값이 언제나 같은가.**
// 하나라도 어긋나면 화면이 보여준 문서와 DB 에 기록되는 해시가 달라지고, 그 순간
// 「사용자가 무엇을 보고 동의했는가」의 기록이 거짓이 된다.
//
// ⚠️ **이 검사가 증명하지 못하는 것**: 과거 항목을 파일과 manifest 에서 **함께** 지우는
//    의도적 삭제는 잡지 못한다 — 둘 다 사라지면 남은 것끼리는 여전히 일관적이다.
//    그것을 잡는 것은 테스트가 아니라 Git 이력과 코드 리뷰이고, 저장소 이력을 통제하는
//    사람에게는 그것도 방어가 아니다. **「불변」은 자동으로 강제되는 성질이 아니라 운영 규칙이다.**
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, bundleId, currentAssets, KINDS, DIR } from "./policies.mjs";
import { INCLUDE } from "./build.mjs";
import { POLICY_BUNDLE } from "../worker/policies.js";
import { requiredPolicyKinds, REQUIRED_POLICY_EVENTS, SESSION_DAYS,
         ENABLED_PROVIDERS, routeFor } from "../worker/index.js";
import { CONFIRMED_RETENTION } from "../worker/ledger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (rel) => readFile(path.join(ROOT, rel));
const sha = (b) => createHash("sha256").update(b).digest("hex");
let n = 0;
const t = (msg) => { n++; return msg; };

const m = await readManifest();

// 1. manifest 의 **모든 판**이 실제 파일이고 해시가 맞는가.
for (const v of m.versions) {
  const body = await R(`policies/${v.file}`);
  assert.equal(sha(body), v.hash, t(`policies/${v.file} 의 내용이 manifest 해시와 다르다 — 불변 파일이 고쳐졌다`));
  // 파일 이름 자체가 내용의 앞 12자다. 이름만 보고도 어긋남을 알 수 있게.
  assert.ok(v.file.startsWith(`${v.kind}-${v.hash.slice(0, 12)}.`),
    t(`${v.file} 의 이름이 내용 해시와 다르다`));
}

// 2. 현재 번들이 manifest 의 판 목록 안에 있는가. (밖에 있으면 어디서 온 값인지 알 수 없다)
for (const k of Object.keys(m.bundle.docs)) {
  const d = m.bundle.docs[k];
  assert.ok(m.versions.some((v) => v.file === d.path.replace(/^policies\//, "") && v.hash === d.hash),
    t(`현재 번들의 ${k} 가 manifest 판 목록에 없다`));
}

// 3. **pv 가 실제 해시들에서 계산되는가.** 손으로 적어 둔 값이면 여기서 걸린다.
assert.equal(m.bundle.pv, bundleId(m.bundle.docs), t("manifest 의 pv 가 문서 해시들과 맞지 않는다"));

// 4. ★ **T22 — 서버 상수 == manifest == 파일 해시.** 셋이 갈리면 화면이 보여준 문서와
//    기록되는 해시가 달라진다. 세 값을 각각 독립적으로 계산해 비교한다.
assert.equal(POLICY_BUNDLE.pv, m.bundle.pv, t("T22: 서버 상수의 pv 가 manifest 와 다르다"));
assert.deepEqual(POLICY_BUNDLE.docs, m.bundle.docs, t("T22: 서버 상수의 문서 목록이 manifest 와 다르다"));
for (const k of Object.keys(POLICY_BUNDLE.docs)) {
  const d = POLICY_BUNDLE.docs[k];
  assert.equal(sha(await R(d.path)), d.hash,
    t(`T22: 서버 상수의 ${k} 해시가 실제 파일 내용과 다르다 — 파일만 고치고 stamp 를 안 돌렸다`));
}

// 5. 서버가 기록하는 **모든 kind 가 번들에 있는가.** 없으면 그 자리에 undefined 가 들어간다.
for (const [kind] of requiredPolicyKinds)
  assert.ok(POLICY_BUNDLE.docs[kind], t(`서버가 기록하는 kind '${kind}' 가 번들에 없다`));
assert.equal(REQUIRED_POLICY_EVENTS, requiredPolicyKinds.length,
  t("REQUIRED_POLICY_EVENTS 가 집합 크기와 다르다 — 숫자를 따로 적어 뒀다"));
// **동의를 받지 않기로 한 것을 받은 척하지 않는다.** 처리 근거가 계약의 이행이므로
// `privacy` 는 `presented` 여야 하고, `xborder/accepted` 는 존재하면 안 된다.
const kinds = Object.fromEntries(requiredPolicyKinds);
assert.equal(kinds.privacy, "presented",
  t("privacy 의 action 이 presented 가 아니다 — 받지 않은 동의를 받았다고 기록하게 된다"));
assert.ok(!("xborder" in kinds), t("xborder 항목이 살아났다 — 국외 이전 별도 동의를 받지 않기로 했다"));

// 6. `privacy.html` 은 **가장 최근 불변 사본과 내용이 같아야 한다.**
//    두 벌을 두는 대가가 이것이다 — 어긋나면 사람이 읽는 문서와 기록되는 문서가 갈린다.
assert.equal(sha(await R("privacy.html")), POLICY_BUNDLE.docs.privacy.hash,
  t("privacy.html 이 현재 불변 사본과 다르다 — `node scripts/policies.mjs` 를 돌려라"));

// 7. 원본(`policies-src/`)도 각각 현재 사본과 같은가. 원본만 고치고 stamp 를 안 돌린 상태를 잡는다.
for (const kind of Object.keys(KINDS)) {
  assert.equal(sha(await R(KINDS[kind].src)), POLICY_BUNDLE.docs[kind].hash,
    t(`${KINDS[kind].src} 가 현재 번들과 다르다 — stamp 를 안 돌렸다`));
}

// 8. `policies/` 안에 **허용된 확장자만** 있는가. 이 폴더는 빌드가 통째로 내보내는 유일한
//    폴더라, 여기 `.md` 나 `.sql` 이 놓이면 그 순간 공개된다.
for (const f of readdirSync(DIR))
  assert.ok(/\.(html|txt|json)$/.test(f), t(`policies/ 에 허용되지 않은 파일이 있다: ${f}`));

// 9. 서비스워커 선캐시 목록이 **정확히 지금 번들**인가. 지난 판까지 넣으면 캐시가 계속 자라고,
//    더 나쁘게는 옛 문서를 렌더하면서 서버는 새 해시를 기록하는 상태가 된다.
{
  const sw = await readFile(path.join(ROOT, "service-worker.js"), "utf8");
  const listed = [...sw.matchAll(/^\s*"(policies\/[^"]+)",\s*$/gm)].map((x) => x[1]).sort();
  assert.deepEqual(listed, currentAssets(m).sort(),
    t("서비스워커의 정책 선캐시 목록이 지금 번들과 다르다"));
}

// 10. 판이 늘어날 때 **기존 항목이 안 바뀌는가**(추가만 허용). 지금 저장소 안에서 잴 수 있는
//     것은 「같은 kind 의 파일이 여럿이어도 각자 자기 해시를 지킨다」까지다 — 위 1번이 그것이다.
//     여기서는 **같은 파일 이름이 두 번 등록되지 않았는지**만 더 본다.
{
  const files = m.versions.map((v) => v.file);
  assert.equal(new Set(files).size, files.length, t("manifest 에 같은 파일이 두 번 등록됐다"));
}

// 11. **현재 방침 판이 실제 외부 요청을 전부 설명하는가**(2026-08-25 · 결함 C).
//     코드는 가입 화면에서 `challenges.cloudflare.com` 스크립트를 받고 서버는 Turnstile
//     siteverify 를 부른다. 그 사실이 방침에 없으면 **문서가 실제 동작보다 좁다** —
//     「다른 회사의 서버로 나가지 않습니다」 같은 포괄 문구와 정면으로 충돌한다.
//     ⚠️ **옛 판은 검사하지 않는다.** 그때는 그 동작이 없었고, 옛 판은 그때 본 바이트다.
{
  const cur = String(await R(POLICY_BUNDLE.docs.privacy.path));
  const REQUIRED = [
    [/Turnstile/, "Turnstile 이라는 이름"],
    [/challenges\.cloudflare\.com/, "브라우저가 요청을 보내는 주소"],
    [/가입 화면/, "언제 불러오는지(가입 화면일 때만)"],
    [/자동화/, "무엇을 막으려는 처리인지"],
  ];
  for (const [re, why] of REQUIRED)
    assert.match(cur, re, t(`현재 방침 판에 ${why} 가 없다 — 실제 외부 요청이 설명되지 않는다`));
  // 코드가 실제로 그 주소를 부르는가. 문서만 고치고 코드가 다른 곳을 부르면 둘이 갈린다.
  const client = String(await R("js/auth.js")), server = String(await R("worker/index.js"));
  assert.ok(client.includes("challenges.cloudflare.com"),
    t("js/auth.js 가 방침에 적힌 주소를 안 쓴다 — 문서와 코드가 갈렸다"));
  assert.ok(server.includes("challenges.cloudflare.com"),
    t("worker/index.js 가 방침에 적힌 주소를 안 쓴다"));
  // **로그인 전용 경로에는 위젯이 없다.** 「가입 화면에서만」이라는 문장의 근거다.
  assert.ok(/가입 화면을 \*\*열 때만\*\*/.test(client) || /가입 화면을 열 때만/.test(client),
    t("js/auth.js 에 「가입 화면을 열 때만」 근거 주석이 없다 — 방침의 범위 주장이 코드에 안 매여 있다"));
}

// ══ 영속 저장 키는 **전부 방침에 적혀 있어야 한다** (2026-08-25 · §4) ══════
//
// 왜: 방침의 「기기 안에만 저장되는 것」 목록은 사람이 손으로 유지한다. 코드가 키를 하나
// 더하면 그 순간 문서가 조용히 거짓이 된다 — 실제로 `shh-revoke` 가 그렇게 생겼다
// (위협 69 를 고치면서 새 키가 생겼는데 방침에는 한 줄도 없었다).
// 그래서 **코드에서 키를 뽑아** 현재 방침 판과 대조한다. 못 찾으면 실패다.
{
  // ⚠️ **현재 판을 `versions.at(-1)` 로 고르지 않는다**(2026-08-26 정정). `versions` 는
  //    `kind+file` **문자열 정렬**이라 파일 이름의 해시 순서에 좌우된다 — 새 판의 해시가
  //    옛 판보다 사전순으로 앞서면 마지막 항목이 **옛 판**이 되고, 그러면 이 검사가
  //    「지금 사람들이 보는 문서」가 아니라 아무 옛 문서나 재게 된다. 실제로 그 상태가
  //    한동안 통과하고 있었다(우연히 순서가 맞았을 뿐이다).
  //    **현재 판의 원본은 하나다 — `manifest.bundle.docs.privacy.path`.**
  //
  //    ⚠️ **경로를 먼저 붙잡고 그것이 번들의 것인지 단언한다.** 내용만 재면 안 된다 —
  //    실측(2026-08-26 돌연변이 M59): `.at(-1)` 로 되돌려도 **직전 판**이 잡혀서 아래
  //    내용 단언이 전부 통과했다. 즉 「우연히 비슷한 옛 문서」를 재고도 초록불이 된다.
  //    깨야 하는 것은 **고르는 방법**이지 그날의 내용이 아니다.
  const curPath = POLICY_BUNDLE.docs.privacy.path;
  assert.equal(curPath, m.bundle.docs.privacy.path,
    t("현재 방침 판의 경로를 번들이 아닌 곳에서 골랐다 — 원본은 manifest 의 번들 하나다"));
  const cur = String(await R(curPath)).replace(/\s+/g, " ");
  // ── 8-2. **검사 대상 JS 는 빌드 allowlist 에서 파생한다** ────────────────
  //    하드코딩한 네 파일만 보면 **새로 배포되는 JS 가 조용히 빠진다.** 배포되는 것의 원본은
  //    `scripts/build.mjs` 의 `INCLUDE` 하나이므로 거기서 `.js` 를 뽑는다. 그래서
  //    `js/camera.js` 는 지금 제외되고(빌드에 없다), **INCLUDE 에 넣는 순간 자동으로 들어온다.**
  const deployedJs = INCLUDE.filter((f) => f.endsWith(".js") && f !== "service-worker.js");
  assert.ok(deployedJs.length >= 4,
    t(`빌드 allowlist 에서 배포 JS 를 못 뽑았다 (${deployedJs.length}개) — INCLUDE 의 모양이 바뀌었다`));
  const src = (await Promise.all(deployedJs.map((f) => R(f)))).map(String).join("\n");
  // `const XXX_KEY = "shh-…"` 로 선언된 것만 센다 — 그것이 이 저장소의 영속 키 관용구다.
  const keys = [...src.matchAll(/const \w*KEY\w* = "(shh-[a-z-]+)"/g)].map((x) => x[1]);
  assert.ok(keys.length >= 12, t(`영속 저장 키를 못 뽑았다 (${keys.length}개)`));

  // ── 배포 JS 의 **영속 저장·외부 요청 수단**이 전부 알려진 자리인가 ────────
  //    키 이름만 세면 「관용구를 안 쓴 저장」이 통째로 빠진다. 저장 수단 자체를 훑어
  //    **선언된 키 밖에서 쓰이는 저장·외부 호스트가 있으면** 실패시킨다.
  const storageHits = [...src.matchAll(/\b(localStorage|sessionStorage|indexedDB|caches)\b/g)].map((x) => x[1]);
  assert.ok(storageHits.length > 0,
    t("배포 JS 에서 영속 저장 호출을 하나도 못 찾았다 — 이 검사가 아무것도 재지 않는다"));
  // 브라우저 코드에 쿠키를 **쓰는** 자리가 있으면 안 된다(세션은 HttpOnly 라 서버만 심는다).
  assert.ok(!/document\.cookie\s*=/.test(src),
    t("배포 JS 가 document.cookie 에 쓴다 — 방침은 세션이 HttpOnly 쿠키라고 적는다"));
  // 배포 JS 가 부르는 **바깥 호스트**가 전부 방침에 적혀 있는가.
  // ⚠️ **주석은 뺀다.** 재려는 것은 「코드가 무엇을 부르는가」이지 「주석이 무엇을 언급하는가」가
  //    아니다. 실제로 이 저장소의 주석에는 **옛 API 주소**와 **아직 안 쓰는 Play Billing 주소**가
  //    적혀 있는데, 그것까지 세면 방침에 「부르지도 않는 주소」를 적게 된다 — 문서가 사실보다
  //    넓어지는 것도 갈리는 것이다.
  // ⚠️ **블록 주석(`/* */`)은 지우지 않는다.** 그 정규식은 소스의 정규식 리터럴 안 `/*` 에
  //    걸려 파일을 통째로 삼켰고, 그러면 호스트가 0개가 되어 **검사가 조용히 아무것도 안 잰다.**
  //    그래서 아래 「하나도 못 뽑았다」 단언을 함께 둔다 — 0개는 통과가 아니라 실패다.
  const code = src
    .replace(/^\s*\/\/.*$/gm, " ")               // 줄 전체 주석
    .replace(/([^:])\/\/.*$/gm, "$1");           // 꼬리 주석 (`https://` 의 // 는 앞이 `:` 라 남는다)
  const EXTERNAL_HOSTS = { "challenges.cloudflare.com": /challenges\.cloudflare\.com/,
                           "sldict.korean.go.kr": /sldict\.korean\.go\.kr/ };
  const hosts = [...new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((x) => x[1].toLowerCase()))];
  assert.ok(hosts.length > 0,
    t("배포 JS 에서 외부 호스트를 하나도 못 뽑았다 — 이 검사가 아무것도 재지 않는다"));
  for (const h of hosts) {
    assert.ok(EXTERNAL_HOSTS[h], t(`배포 JS 가 부르는 호스트 '${h}' 가 이 검사의 대조표에 없다 — 방침에 적었는지 아무도 안 본다`));
    assert.match(cur, EXTERNAL_HOSTS[h], t(`배포 JS 가 부르는 호스트 '${h}' 가 현재 방침 판에 없다`));
  }

  // 각 키가 방침의 **어느 문장으로** 설명되는지. 키 이름 자체는 문서에 안 적는다(사용자에게
  // 뜻이 없다) — 그래서 「이 키를 설명하는 문구」를 여기서 짝지어 둔다.
  const DISCLOSED = {
    "shh-wordbook": /단어 목록/, "shh-via": /로그인 상태 표시/, "shh-me": /무작위 번호/,
    "shh-uid": /무작위 번호/, "shh-name": /별명/, "shh-invite": /초대 링크 코드/,
    "shh-bookver": /저장 번호/, "shh-dirty": /고친 적이 있는지/, "shh-rev": /고친 적이 있는지/,
    "shh-nonce": /일회용/, "shh-back": /보고 있던 주소/,
    "shh-intro-muted": /첫 실행 안내문/, "shh-peek": /둘러보기/, "shh-pro": /프로 이용/,
    "shh-master": /프로 이용/,
    // ★ 2026-08-25 신설. 이 줄이 없으면 아래 단언이 실패한다 — 그것이 이 검사의 목적이다.
    "shh-revoke": /재시도 표식/,
  };
  for (const k of new Set(keys)) {
    assert.ok(DISCLOSED[k],
      t(`영속 저장 키 '${k}' 가 이 검사의 대조표에 없다 — 방침에 적었는지 아무도 안 본다`));
    assert.match(cur, DISCLOSED[k],
      t(`영속 저장 키 '${k}' 를 설명하는 문구가 현재 방침 판에 없다`));
  }

  // ── `shh-revoke` 의 **제거 조건이 코드와 일치**해야 한다 ──────────────────
  // 방침은 「끊었다 또는 끊을 세션이 이미 없다」고 적는다. 코드의 terminal 판정이 그것과
  // 다르면(예: 모든 4xx 를 성공으로 치면) 문서가 거짓이 된다.
  const api = String(await R("js/authApi.js"));
  assert.match(api, /const REVOKED = \(status\) => status === 401 \|\| \(status >= 200 && status < 300\);/,
    t("shh-revoke 의 terminal 판정이 방침에 적은 「끊었다 · 이미 없다」와 다르다"));
  assert.match(cur, /끊었다.*끊을 세션이 이미 없다|끊을 세션이 이미 없다/,
    t("방침이 shh-revoke 의 제거 조건(2xx · 401)을 적지 않았다"));
  assert.match(cur, /정상적으로 새로 로그인/,
    t("방침이 「새로 로그인하면 지운다」를 적지 않았다 — 코드는 그렇게 한다"));
  // 담기는 값이 boolean 하나라는 사실도 코드와 맞아야 한다.
  assert.match(api, /localStorage\.setItem\(REVOKE_PENDING_KEY, "1"\)/,
    t("shh-revoke 에 '1' 이 아닌 값을 담는다 — 방침 문구와 다르다"));

  // ── 근거 없는 「식별정보가 없다」 단정이 다시 들어오면 실패한다 ───────────
  // 앱이 통제하지 못하는 것(Cloudflare 가 만드는 토큰의 내용)을 단정하지 않는다.
  {
    // ⚠️ **공백을 접어서 본다.** 문구가 줄바꿈을 걸쳐 있으면 그대로 매치하는 검사는
    //    「문서를 재포맷했다」는 이유만으로 깨지고, 사람이 검사를 느슨하게 고치게 된다.
    //    대상은 **현재 번들의 privacy** 하나다(`versions.slice(-1)` 이 아니다 — 위 8-1 참조).
    const txt = cur;
    assert.ok(!/확인용 값에는 <b>회원님을 가리키는 정보가 들어 있지 않습니다/.test(txt),
      t("방침이 Turnstile 토큰에 식별정보가 없다고 단정한다 — 앱이 입증할 수 없는 주장이다"));
    assert.match(txt, /저희 앱은 그 확인용 값에 회원님의 계정 번호/,
      t("방침이 「앱이 무엇을 넣지 않는가」로 범위를 좁히지 않았다"));
    assert.match(txt, /그 안에 무엇이 담기는지는 Cloudflare 가 정합니다/,
      t("방침이 토큰 내용의 결정 주체가 Cloudflare 임을 적지 않았다"));
  }
}

// ══ 12. **현재 방침 판에 근거 없는 법률 단정이 없는가** (2026-08-26 · §8-3) ══
//
// 왜: `privacy.html` 은 한동안 「법령에 따라 따로 보관해야 하는 기록은 없습니다」라고 적고
// 있었다. **우리가 확인한 것은 「결제·거래 기능이 없다」뿐**이고, 다른 법령의 보관 의무가
// 없다는 것은 **확인한 적이 없는 법률 결론**이다. 같은 무늬로 「제공자 회원 번호만으로는
// 누구인지 알 수 없다」도 적혀 있었다 — 제공자마다 다르고 셋 다 확인하지 못한 값이다.
//
// ⚠️ **현재 판만 본다.** 옛 판은 그때 사람들이 본 바이트라 고치면 안 된다 —
//    이 검사가 옛 판까지 보면 「불변 파일을 고쳐서 검사를 통과시키는」 길이 열린다.
{
  const cur = String(await R(POLICY_BUNDLE.docs.privacy.path)).replace(/\s+/g, " ");
  const FORBIDDEN_CLAIMS = [
    [/법령에 따라 따로 보관해야 하는 기록은 없/, "확인한 적 없는 법령상 보관 의무 부재를 단정"],
    [/법적 문제가 (전혀 )?없/, "법적 적합성 단정"],
    [/법적으로 완벽/, "같음"],
    [/변호사 검토 완료/, "받은 적이 없다"],
    [/외부 법률 검토 완료/, "같음"],
    [/이 번호만으로는 누구인지 알 수 없/, "제공자 식별자의 성질을 셋 다 확인하지 못했다"],
    [/다른 앱도 (하니|하므로)/, "사례는 적법성의 근거가 아니다"],
  ];
  for (const [re, why] of FORBIDDEN_CLAIMS)
    assert.ok(!re.test(cur), t(`현재 방침 판에 근거 없는 단정이 있다 — ${why}: ${re}`));

  // 반대 방향: **대신 적기로 한 문장**이 실제로 있어야 한다. 지우고 통과시키는 길을 막는다.
  for (const [re, what] of [
    [/결제·거래 기능이 없어 결제·거래 기록/, "확인한 사실(결제·거래 기록을 만들지 않는다)"],
    [/그 밖에 법령상 별도 보관 의무가 있는지는/, "단정하지 않는다는 단서"],
    [/개인정보로 취급/, "제공자 회원 번호를 개인정보로 취급한다는 서술"],
    [/제15조 제1항 제4호 — 정보주체와 체결한 계약을 이행하거나/, "제15조 제1항 제4호의 **현행** 문구"],
    [/제28조의8 제1항 제3호 — 정보주체와의 계약의 체결 및 이행/, "제28조의8 제1항 제3호의 **현행** 문구"],
    [/가목/, "제3호 가목(방침 공개)이 함께 필요하다는 사실"],
  ]) assert.match(cur, re, t(`현재 방침 판에 ${what} 가 없다`));

  // ⚠️ **2023-03-14 개정 전 문구가 되살아나면 실패한다.** 6차판 전에는 이 문구였다.
  assert.ok(!/불가피하게 필요한 경우/.test(cur),
    t("현재 방침 판이 제15조 제1항 제4호의 **개정 전** 문구(「불가피하게」)를 인용한다"));

  // ── 카메라: **배포 여부와 방침 문장이 함께 움직여야 한다** ────────────────
  //    지금 `js/camera.js` 는 빌드 allowlist 에 없어서 「카메라 기능이 없습니다」가 참이다.
  //    ⚠️ **빌드에 넣는 순간 그 문장이 거짓이 된다.** 그때 방침이 무엇을 적어야 하는지를
  //    여기 못박아 둔다 — 넣고 나서 「테스트가 통과하니 괜찮겠지」가 되지 않게.
  const cameraDeployed = INCLUDE.some((f) => f === "js/camera.js" || f === "js");
  if (!cameraDeployed) {
    assert.match(cur, /카메라 기능이 없습니다/,
      t("카메라 JS 가 배포되지 않는데 방침이 그 사실을 안 적는다"));
  } else {
    for (const [re, what] of [
      [/카메라 (권한|접근)/, "카메라 권한"],
      [/기기 (안|내)에서만/, "기기 내 처리 범위"],
      [/랜드마크|손 모양 좌표/, "손 랜드마크 처리"],
      [/저장|전송/, "영상·랜드마크·샘플의 저장·전송 여부"],
      [/jsDelivr|cdn\.jsdelivr\.net|MediaPipe/, "MediaPipe 내려받기 경로"],
      [/모델/, "모델 내려받기"],
    ]) assert.match(cur, re, t(`카메라 JS 가 배포되는데 방침에 ${what} 설명이 없다`));
    assert.ok(!/카메라 기능이 없습니다/.test(cur),
      t("카메라 JS 가 배포되는데 방침은 「카메라 기능이 없습니다」라고 적는다"));
  }
}

// ── 13. 2026-08-26 사용자 결정이 방침에 살아 있는가 ───────────────────────
//
// ⚠️ **여기 있는 숫자는 손으로 적은 것이 아니다.** 세션 기간과 표식 보유기간은 운영 코드의
//    상수에서 파생한다 — 한쪽만 고치면 실패한다. 옛 방식(문서에 숫자를 적어 두기)은
//    이 저장소에서 `RL_KEY` 때 한 번, 시크릿 목록 때 또 한 번 낡았다.
{
  const cur = String(await R(POLICY_BUNDLE.docs.privacy.path)).replace(/\s+/g, " ");
  const sum = String(await R(POLICY_BUNDLE.docs.summary.path)).replace(/\s+/g, " ");

  // ── a. **세션 기간은 코드에서 파생한다.** 180일이 되살아나면 여기서 잡힌다.
  const dayHits = [...cur.matchAll(/세션 토큰은 <b>?(\d+)일|<b>(\d+)일<\/b>이 지나면|세션 토큰은 (\d+)일/g)]
    .map((mm) => Number(mm[1] || mm[2] || mm[3]));
  assert.ok(dayHits.length >= 3,
    t(`방침에서 세션 기간 문장을 ${dayHits.length}개밖에 못 찾았다 — 검사기가 낡았거나 문장이 사라졌다`));
  for (const d of dayHits)
    assert.equal(d, SESSION_DAYS,
      t(`방침의 세션 기간 ${d}일이 코드의 SESSION_DAYS(${SESSION_DAYS}일)와 다르다`));

  // ── b. **삭제 표식 보유기간도 코드에서 파생한다.** 37일이 되살아나면 잡힌다.
  const keepDays = CONFIRMED_RETENTION / 86400e3;
  assert.match(cur, new RegExp(`약 ${keepDays}일`),
    t(`방침이 표식 보유기간 약 ${keepDays}일(CONFIRMED_RETENTION)을 적지 않는다`));
  assert.ok(!/37일/.test(cur),
    t("방침에 옛 보유기간 37일이 남아 있다 — Free 요금제 기준으로 재계산됐다"));

  // ── c. 개인정보처리자·보호책임자 — **이름이 빠지면 실패한다.**
  for (const [re, what] of [
    [/개인정보처리자/, "개인정보처리자 표기"],
    [/개인정보 보호책임자/, "보호책임자 표기"],
    [/배성욱/, "책임자 성명"],
  ]) assert.match(cur, re, t(`현재 방침 판에 ${what} 가 없다`));
  assert.match(sum, /배성욱/, t("가입 화면 요약에 보호책임자 성명이 없다 — 전문과 갈린다"));

  // ── d. **문의 주소가 실재하는가.** 플레이스홀더·예시 주소를 공개 정책에 넣지 않는다.
  //   ⚠️ 「없는 전용 도메인 주소를 미리 적어 두기」가 정확히 막으려는 것이다 —
  //      그 주소로 온 요청은 아무 데도 도착하지 않는데 방침은 도착한다고 말하게 된다.
  const mails = [...cur.matchAll(/mailto:([^"]+)"/g)].map((mm) => mm[1]);
  assert.ok(mails.length >= 1, t("현재 방침 판에 문의 이메일이 하나도 없다"));
  for (const a of mails) {
    assert.match(a, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i, t(`문의 주소가 이메일 모양이 아니다: ${a}`));
    assert.ok(!/example|test|todo|소유도메인|yourdomain|도메인|xxx/i.test(a),
      t(`문의 주소가 플레이스홀더다: ${a}`));
  }

  // ── e. **전화번호를 공개하지 않는다.** 기관 대표번호(분쟁조정·신고센터)는 예외다 —
  //    그건 우리 번호가 아니라 회원님이 도움을 요청할 곳이다.
  const INSTITUTION = ["1833-6972", "118", "1301", "182"];
  for (const mm of cur.matchAll(/0\d{1,2}-?\d{3,4}-?\d{4}|\b1\d{3}-\d{4}\b/g)) {
    assert.ok(INSTITUTION.includes(mm[0]),
      t(`방침에 운영자 전화번호로 보이는 값이 있다: ${mm[0]} — 공개하지 않기로 했다`));
  }
  assert.match(cur, /전화번호는 공개하지 않습니다/,
    t("전화번호를 공개하지 않는다는 사실이 방침에 없다 — 없는 이유를 적지 않으면 누락으로 읽힌다"));

  // ── f. 정보주체 권리 넷과 **행사 경로 둘**(앱 안 · 계정에 못 들어갈 때).
  for (const [re, what] of [
    [/열람/, "열람"], [/정정/, "정정"], [/처리정지/, "처리정지"],
    [/계정 삭제/, "삭제 경로"],
    [/계정에 들어가지 못하실 때|로그인이 안 되/, "계정 접근 불가 시의 예외 경로"],
    [/분쟁조정위원회/, "권익침해 구제 안내"],
    [/운영 기준/, "요청 기록 보유기간이 법정 의무가 아니라는 단서"],
  ]) assert.match(cur, re, t(`현재 방침 판에 ${what} 가 없다`));
  assert.match(sum, /열람·정정·삭제·처리정지/, t("가입 화면 요약에 권리 안내가 없다"));

  // ── g. **국외 처리** — 미국 법인·처리 위치를 적고, APAC 을 국가로 단정하지 않는다.
  for (const [re, what] of [
    [/미국 및 Cloudflare 글로벌 네트워크가 운영되는 국가/, "처리 위치의 적극적 공개"],
    [/미국 법인/, "Cloudflare 가 미국 법인이라는 사실"],
    [/국가가 아니라 지역/, "APAC 이 국가가 아니라는 단서"],
  ]) assert.match(cur, re, t(`현재 방침 판에 ${what} 가 없다`));
  for (const [re, why] of [
    [/APAC[^.]{0,20}(저장|보관)됩니다/, "APAC 을 저장 국가로 단정"],
    [/한국에 (저장|보관)/, "한국 저장 단정"],
    [/한국 관할|대한민국 관할/, "한국 관할 단정"],
  ]) assert.ok(!re.test(cur), t(`현재 방침 판이 확인한 적 없는 것을 단정한다 — ${why}`));

  // ── h. **복원 창과 그 한계.** 「정확히 며칠에 삭제」를 단정하면 안 된다(R2 삭제 지연).
  for (const [re, what] of [
    [/최대 7일/, "Free 등급 Time Travel 7일"],
    [/무료 등급/, "지금 쓰는 등급"],
    [/통상 하루 정도가 더 걸릴 수 있다/, "백업 삭제 지연 단서"],
    [/30일/, "유료 전환 시 늘어나는 범위"],
    [/먼저 다시 계산하고/, "유료 전환 전 재계산 게이트"],
    [/매일 하는 정기 백업은 하지 않고/, "백업 주기 사실"],
    [/자동으로 되돌리는 기능은 만들지 않습니다/, "자동 복원 금지"],
  ]) assert.match(cur, re, t(`현재 방침 판에 ${what} 서술이 없다`));
}

// ── 14. **방침이 말하는 것과 코드가 하는 일이 같은가** (2026-08-26 신설) ──
//
// ⛔ 왜 생겼나: 방침이 **없는 기능**과 **하지 않는 일**을 현재형으로 적고 있었다.
//   H1 백업 — 「7일 만료로 설정해 둔다」고 했지만 백업 코드도 저장 공간도 없었다
//   H2 권리 — 「이메일로 요청하면 처리해 준다」고 했지만 이메일을 받지 않아 계정을 이을 수 없다
//   H3 정지 — 「로그아웃하면 처리가 멈춘다」고 했지만 로그아웃은 세션만 끊는다
//   M1 비회원 — 「단어장도 만들지 않는다」고 했지만 기기 로컬 저장소에는 만든다
//   M2 요청 — 「그 밖엔 아무 요청도 안 나간다」고 했지만 폐기 재시도가 나간다
//   M3 제공자 — 구글을 현재 제공자로 적었지만 서버는 받지 않는다
//
// ⚠️ **문자열 하나로 「의미가 맞다」고 말하지 않는다.** 각 항목은 ⓐ 있어야 할 문장과
//    ⓑ **있으면 안 되는 반대 문장**을 함께 잰다. 그리고 가능한 것은 **코드에서 파생**한다.
{
  // ⚠️ **불변 사본을 읽는다**(살아 있는 원본이 아니라). 화면이 실제로 보여주는 바이트가
  //    그 사본이므로, 원본만 고치고 stamp 를 잊으면 여기서 실패한다.
  const cur = String(await R(POLICY_BUNDLE.docs.privacy.path)).replace(/\s+/g, " ");
  const sum = String(await R(POLICY_BUNDLE.docs.summary.path)).replace(/\s+/g, " ");
  const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

  // ── a. **제공자 목록은 코드에서 파생한다.** 손으로 적으면 갈라진다.
  {
    const open = ENABLED_PROVIDERS;
    const NAME = { kakao: "카카오", naver: "네이버", google: "구글" };
    assert.deepEqual([...open].sort(), ["kakao", "naver"],
      t("14-a: 열린 제공자 목록이 바뀌었다 — 방침 문장을 함께 고쳐야 한다"));
    for (const doc of [cur, sum]) {
      for (const k of open)
        assert.ok(doc.includes(NAME[k]), t(`14-a: 열려 있는 ${NAME[k]} 가 문서에 없다`));
    }
    // 닫힌 제공자는 **닫혔다고** 적혀 있어야 한다. 「그냥 안 적기」로는 부족하다 —
    // 옛 문장이 남아 있는지 아무도 못 잰다.
    for (const k of Object.keys(NAME).filter((x) => !open.includes(x))) {
      assert.match(cur, new RegExp(`${NAME[k]}[^<]{0,40}(쓰실 수 없|꺼 둔|비활성)`),
        t(`14-a: 닫힌 ${NAME[k]} 를 「지금 쓸 수 없다」고 적지 않았다`));
      assert.ok(!new RegExp(`카카오·네이버·${NAME[k]}가? 주는`).test(cur),
        t(`14-a: 닫힌 ${NAME[k]} 가 아직 현재 제공자로 적혀 있다`));
    }
  }

  // ── b. **로그아웃 ≠ 처리정지.** 옛 문장이 되살아나면 실패한다.
  assert.ok(!/로그아웃[^<]{0,30}(계정 관련 )?처리가 멈춥니다/.test(cur),
    t("14-b: ⛔ 「로그아웃하면 처리가 멈춘다」가 되살아났다 — 로그아웃은 세션만 끊는다"));
  assert.match(cur, /로그아웃은 처리정지가 아닙니다/,
    t("14-b: 로그아웃과 처리정지를 가르는 문장이 없다"));
  for (const [re, what] of [
    [/설정 → <b>처리정지<\/b>/, "처리정지의 앱 안 경로"],
    [/모든 기기에서 로그인이 풀리고/, "정지가 모든 기기에 듣는다는 사실"],
    [/데이터는 지우지 않고 그대로 보관/, "정지 ≠ 삭제"],
    [/로그인만으로는 자동으로 다시 시작되지 않습니다/, "자동 재개 금지"],
    [/「다시 시작하기」를 직접 누르셔야/, "명시적 재개"],
  ]) assert.match(cur, re, t(`14-b: 방침에 ${what} 가 없다`));
  // 코드에도 그 라우트가 실제로 있어야 한다 — 방침만 고치고 끝내지 않는다.
  assert.ok(routeFor("POST", "/me/suspend") && routeFor("POST", "/me/resume"),
    t("14-b: 방침은 처리정지·재개를 말하는데 라우트가 없다"));

  // ── c. **열람은 실제로 내려받을 수 있어야 한다.**
  assert.match(cur, /내 정보 내려받기/, t("14-c: 방침에 내려받기 경로가 없다"));
  assert.match(sum, /내 정보 내려받기/, t("14-c: 가입 요약에 내려받기 경로가 없다"));
  assert.ok(routeFor("GET", "/me/export"), t("14-c: 방침은 내려받기를 말하는데 라우트가 없다"));
  assert.match(cur, /친구의 제공자 회원 번호와 친구의 단어장은 들어 있지 않습니다/,
    t("14-c: 내려받기에 남의 것이 없다는 사실을 적지 않았다"));

  // ── d. ⛔ **이메일은 계정 소유 증명이 아니다.** 옛 약속이 되살아나면 실패한다.
  assert.ok(!/(카카오·네이버)의 계정에서 보내 주시거나/.test(cur),
    t("14-d: ⛔ 「제공자 계정에서 메일을 보내면 처리해 준다」가 되살아났다 — 확인할 방법이 없다"));
  for (const [re, what] of [
    [/이메일은 문의를 받는 수단일 뿐/, "이메일의 성질"],
    [/이메일만으로는 계정 정보를 알려 드리거나, 지우거나/, "이메일만으로 불가"],
    [/먼저 네이버·카카오 계정을 복구해 주세요/, "복구가 먼저"],
    [/실명·전화번호·신분증을 요구하지 않습니다/, "본인확인에 새 개인정보를 안 받는다"],
  ]) assert.match(cur, re, t(`14-d: 방침에 ${what} 가 없다`));
  assert.match(sum, /이메일만으로는 계정을 확인해 드릴 수 없습니다/,
    t("14-d: 가입 요약이 이메일 예외를 그대로 약속한다"));

  // ── e. **비회원 — 서버에는 없고 기기에는 있다.**
  assert.ok(!/로그인하지 않으시면 계정도 단어장도 만들지 않습니다/.test(cur),
    t("14-e: ⛔ 「비회원은 단어장을 안 만든다」가 되살아났다 — 기기에는 만든다"));
  assert.match(cur, /이 기기 안에는 단어장이 만들어집니다/,
    t("14-e: 기기 단어장이 생긴다는 사실이 없다"));
  // 코드가 실제로 그 키에 저장한다.
  assert.match(src("js/app.js"), /const BOOK_KEY = "shh-wordbook"/,
    t("14-e: 기기 단어장 키가 바뀌었다 — 방침 문장을 다시 봐야 한다"));

  // ── f. **비로그인 요청 — 폐기 재시도를 고지한다.**
  assert.ok(!/그 밖의 <code>\/api\/<\/code> 경로로는 로그인하지 않으면 아무 요청도 나가지 않습니다/.test(cur),
    t("14-f: ⛔ 「비로그인이면 아무 요청도 안 나간다」가 되살아났다"));
  assert.match(cur, /DELETE \/api\/session/,
    t("14-f: 세션 폐기 재시도 요청을 고지하지 않았다"));
  // 코드에 그 재시도가 실제로 있다.
  assert.match(src("js/authApi.js"), /addEventListener\("online", \(\) => \{ retryRevokeSession\(\); \}\)/,
    t("14-f: 폐기 재시도 경로가 코드에서 사라졌다 — 방침 문장을 다시 봐야 한다"));

  // ── g. **백업 — 「있다」와 「없다」를 동시에 말하지 않는다.**
  assert.ok(!/아직 확정해 말씀드릴 수 없습니다/.test(cur),
    t("14-g: ⛔ 같은 문서가 기간을 확정했다가 미확정이라고 다시 말한다"));
  assert.ok(!/만들어진 지 <b>7일이 지나면 만료<\/b>되도록<\/b>? ?설정해 둡니다/.test(cur),
    t("14-g: ⛔ 아직 없는 백업을 「설정해 두었다」고 현재형으로 말한다"));
  for (const [re, what] of [
    [/백업 사본은 지금 운영하고 있지 않습니다/, "백업 미운영 사실"],
    [/지금까지 만들어진 백업 사본은 하나도 없습니다/, "백업 0건"],
    [/실제로 백업을 운영하기 시작하면 이 문단을 먼저 고치겠습니다/, "운영 시작 시 개정 약속"],
  ]) assert.match(cur, re, t(`14-g: 방침에 ${what} 가 없다`));

  // ── h. **삭제 표식 — 15일은 최소이지 삭제 조건이 아니다.**
  for (const [re, what] of [
    [/15일은 「최소」이지\s*\n?\s*「그날 지운다」가 아닙니다/, "최소 ≠ 삭제일"],
    [/백업 사본이 더 이상 남아 있지 않음을 확인/, "백업 확인 조건"],
    [/확인하지 못하면\(모르면\) 지우지 않습니다/, "모름은 삭제 허가가 아니다"],
  ]) assert.match(cur, re, t(`14-h: 방침에 ${what} 가 없다`));
  // 코드도 같은 조건을 들고 있다 — 방침만 고치고 끝내지 않는다.
  assert.match(src("worker/ledger.js"), /NOT EXISTS \(SELECT 1 FROM backups/,
    t("14-h: 표식 삭제 SQL 에 백업 조건이 없다 — 방침이 거짓이 된다"));
}

// ── 15. **로그아웃의 범위 · 비회원 기기 단어장** (2026-08-27 · K4) ─────────
//
// ⛔ 왜 생겼나: 두 문장이 코드와 반대였다.
//   ① 「로그아웃은 **이 기기의** 접속을 끝내는 것」 — 실제로는 `killSessions()` 가 세대를 올리고
//      그 계정의 세션 행을 **전부** 지운다. 다른 기기도 그 자리에서 끊긴다
//   ② 한 줄 요약의 「계정도, **단어장도**, 별명도 만들지 않는다」 — 서버에는 안 만들지만
//      **기기 안에는 만든다**(같은 문서가 몇 문단 뒤에서 반대로 적고 있었다 = 내부 모순)
//
// ⚠️ **「있어야 할 문장」과 「있으면 안 되는 문장」을 함께 잰다.** 한쪽만 재면 새 문장을 더하고
//    옛 문장을 그대로 둔 문서가 통과한다 — 그러면 문서가 스스로 모순인 채로 초록불이 된다.
{
  const cur = String(await R(POLICY_BUNDLE.docs.privacy.path)).replace(/\s+/g, " ");
  const sum = String(await R(POLICY_BUNDLE.docs.summary.path)).replace(/\s+/g, " ");
  const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

  // ── a. 로그아웃은 **모든 기기**다. 코드에서 그 성질을 확인한 뒤 문서를 잰다.
  {
    const w = src("worker/index.js");
    const kill = w.slice(w.indexOf("async function killSessions("), w.indexOf("async function killSessions(") + 900);
    assert.ok(/UPDATE users SET session_version = session_version \+ 1/.test(kill),
      t("15-a: killSessions 가 세대를 안 올린다 — 「모든 기기」 문장의 근거가 사라졌다"));
    assert.ok(/DELETE FROM sessions WHERE user_id = \?/.test(kill),
      t("15-a: killSessions 가 그 계정의 세션을 전부 안 지운다"));
    for (const [doc, label] of [[cur, "방침"], [sum, "요약"]]) {
      assert.ok(/모든 기기/.test(doc),
        t(`15-a: ${label} 이 로그아웃의 범위를 「모든 기기」로 적지 않았다`));
      // ⛔ 반대 문장이 남아 있으면 안 된다.
      assert.ok(!/로그아웃은 (이 기기의 접속을 끝내는 것|「이 기기에서 그만 보기」)/.test(doc),
        t(`15-a: ${label} 에 「로그아웃 = 이 기기만」 이라는 옛 문장이 남아 있다`));
    }
  }

  // ── b. 비회원도 **기기 안에는** 단어장을 만든다. 한 줄 요약이 그 사실과 어긋나면 안 된다.
  {
    assert.ok(/BOOK_KEY\s*=\s*"shh-wordbook"/.test(src("js/app.js")),
      t("15-b: 기기 단어장 키가 사라졌다 — 이 검사의 전제가 무너졌다"));
    // 「단어장을 만들지 않는다」류의 문장은 **반드시 「서버」로 한정돼 있어야** 한다.
    for (const m of cur.matchAll(/[^.。]{0,80}단어장[^.。]{0,20}만들지 않[^.。]{0,20}/g)) {
      assert.ok(/서버/.test(m[0]),
        t(`15-b: 「단어장을 만들지 않는다」가 서버로 한정되지 않았다 — "${m[0].trim().slice(0, 60)}"`));
    }
    assert.ok(/이 기기 안에는 단어장이 만들어집니다/.test(cur),
      t("15-b: 기기 안에 단어장이 만들어진다는 사실이 방침에 없다"));
  }

  // ── c. **남용 방어 기록을 지우는 경로가 몇 개인가.** 방침이 세는 수와 코드가 같아야 한다.
  //    (2026-08-27 · 독립 검토 H1) 방침은 「로그인할 때 함께 지워지고, 정기 정리 작업도 지운다」로
  //    **둘**을 적고 있었는데, 카운터가 ledger 로 옮겨간 날(2026-08-20 · 위협 49) 로그인 시점
  //    청소는 `sessions` 한 표만 남았다 — 실제 경로는 **하나**이고 그 하나가 미배포다.
  {
    const worker = src("worker/index.js");
    const cron = src("worker/cleanup/index.js");
    const inWorker = (worker.match(/DELETE FROM rate_limits/g) || []).length;
    const inCron = (cron.match(/DELETE FROM rate_limits/g) || []).length;
    assert.equal(inWorker, 0,
      t("15-c: 요청 경로가 rate_limits 를 지운다 — 방침의 「경로는 하나」가 거짓이 된다"));
    assert.equal(inCron, 1,
      t(`15-c: 정리 크론의 rate_limits 삭제가 ${inCron}곳이다 — 하나여야 한다`));
    assert.ok(/지우는 경로는 .{0,20}정기 정리 작업 하나뿐/.test(cur),
      t("15-c: 방침이 삭제 경로를 「하나뿐」이라고 적지 않았다"));
    // ⛔ 반대 문장이 남아 있으면 안 된다.
    assert.ok(!/누군가 로그인할 때.{0,20}함께 지워지고/.test(cur),
      t("15-c: 「로그인할 때 함께 지워진다」는 옛 문장이 남아 있다"));
    // 로그인 시점 청소가 **무엇을** 지우는지도 코드에서 확인한다.
    assert.ok(/DELETE FROM sessions WHERE \(expires_at < \? OR revoked_at IS NOT NULL\)/.test(worker),
      t("15-c: 로그인 시점의 세션 청소가 사라졌다 — 방침의 정정 문장이 근거를 잃는다"));
  }

  // ── d. **지금 나가는 판의 이름표는 유일하다.** (2026-08-27 · 독립 검토 M2)
  //
  // 왜: `privacy-ec20ee0ec725.html` 과 `privacy-1cba78c8fc89.html` 은 **내용이 다른데** 둘 다
  // 「2026-08-26 (8차)」였다. 보관함의 쓸모는 「그때 그 사람이 본 문서가 이것이다」인데,
  // 이름표가 겹치면 사람이 사본을 지목할 수 없다.
  //
  // ⚠️ **옛 판을 고쳐서 맞추지 않는다.** 불변 사본이라 고치는 순간 그때의 기록이 거짓이 된다.
  //    실제로 옛 충돌이 **둘** 남아 있다 — `2026-08-18 (4차)` ×2, `2026-08-25 (5차)` ×2.
  //    그건 역사이고 지우지 않는다. 여기서 막는 것은 **앞으로 새로 나가는 판**이다.
  {
    const label = (body) =>
      (String(body).match(/마지막 수정:\s*([0-9-]+)\s*\(([^)]+)\)/) || []).slice(1).join("|");
    const curLabel = label(cur);
    assert.ok(curLabel, t("15-d: 현재 방침 판에 「마지막 수정」 표기가 없다"));
    const others = m.versions.filter((v) => v.kind === "privacy"
      && "policies/" + v.file !== m.bundle.docs.privacy.path);
    assert.ok(others.length >= 2, t(`15-d: 비교할 옛 판이 ${others.length}개다 — 검사가 헛돈다`));
    for (const v of others) {
      const l = label(await R("policies/" + v.file));
      assert.notEqual(l, curLabel,
        t(`15-d: 지금 나가는 판이 옛 판 ${v.file} 과 같은 이름표(${curLabel})를 단다 — 내용은 다르다`));
    }
  }
}

// ── 16. **보관함의 current / past / draft 구분** (2026-08-27 · K4) ────────
//
// 옛 보관함은 `versions` 전체를 「지난 판」으로 뿌렸다 — 그래서 **지금 나가는 사본 넷이
// 「지난 판」에도 함께** 있었다. 보관함의 쓸모는 「그때 그 사람이 본 문서가 이것이다」인데,
// 지금 판이 지난 판에 섞여 있으면 그 지목이 안 된다.
//
// 그리고 「지난 판」과 「아직 나간 적 없는 판」도 다르다. 로컬에서 stamp 만 하고 배포되지
// 않은 사본은 **아무도 본 적이 없다** — 그걸 「지난 판」이라 부르면 거짓이다.
{
  const idx = String(await R("policies/index.html"));
  const { shippedPolicyFiles, indexHtml } = await import("./policies.mjs");
  const { DEPLOYED_SOURCE } = await import("./deployed.mjs");
  const shipped = shippedPolicyFiles();
  // ⚠️ **생성기가 원본이다.** 보관함 페이지는 만들어지는 파일이므로, 여기서 다시 만들어
  //    디스크의 것과 바이트로 대조한다 — 그래야 「생성기를 고쳤는데 페이지는 옛 분류
  //    그대로」인 상태가 검사에 걸린다.
  assert.equal(indexHtml(m, shipped), idx,
    t("16: policies/index.html 이 생성기 출력과 다르다 — `npm run policies` 를 안 돌렸다"));
  assert.ok(shipped && shipped.size > 0, t("16: 배포 경계의 파일 목록을 못 읽었다 — 검사가 헛돈다"));

  const section = (h) => {
    const at = idx.indexOf(`<h2>${h}`);
    assert.ok(at > 0, t(`16: 보관함에 「${h}」 절이 없다`));
    const end = idx.indexOf("<h2>", at + 4);
    return idx.slice(at, end < 0 ? idx.length : end);
  };
  // 보관함 안의 사본만 센다 — `../privacy.html` 같은 바깥 링크는 사본이 아니다.
  const files = (block) => [...block.matchAll(/href="([^"/]+\.(?:html|txt))"/g)].map((x) => x[1]);
  const current = new Set(Object.values(m.bundle.docs).map((d) => d.path.replace(/^policies\//, "")));
  const past = files(section("지난 판"));
  const draft = files(section("아직 나간 적 없는 판"));

  // ── a. 지금 나가는 사본은 **지난 판에도 draft 에도 없다.**
  for (const f of current) {
    assert.ok(!past.includes(f), t(`16-a: ★ 지금 나가는 ${f} 가 「지난 판」에도 적혀 있다`));
    assert.ok(!draft.includes(f), t(`16-a: ★ 지금 나가는 ${f} 가 「아직 안 나간 판」에 적혀 있다`));
  }
  // ── b. 「지난 판」은 **배포 경계에 실제로 있던 것만**이다.
  for (const f of past) {
    assert.ok(shipped.has(f),
      t(`16-b: ★ 나간 적 없는 ${f} 를 「지난 판」이라 부른다 — 아무도 본 적이 없다`));
  }
  // ── c. draft 는 **배포 경계에 없던 것만**이다(양성 대조 — 둘 다 재야 한다).
  for (const f of draft) {
    assert.ok(!shipped.has(f),
      t(`16-c: ★ 실제로 나갔던 ${f} 를 「아직 안 나간 판」이라 부른다`));
  }
  // ── d. 셋을 합치면 manifest 전체다. 어느 사본도 조용히 사라지지 않는다.
  assert.equal(new Set([...current, ...past, ...draft]).size, m.versions.length,
    t(`16-d: 보관함이 ${past.length + draft.length + current.size}개를 적는데 manifest 는 ${m.versions.length}개다`));
  // ── e. **불변 사본의 바이트는 그대로다.** 이름의 해시와 내용이 계속 일치해야 한다.
  for (const v of m.versions) {
    const body = await R("policies/" + v.file);
    assert.equal(createHash("sha256").update(body).digest("hex"), v.hash,
      t(`16-e: ★ 불변 사본 ${v.file} 의 내용이 바뀌었다`));
  }
  // ── f. **분류 자체를 합성 입력으로 잰다.** ⚠️ a~e 는 전부 **지금 저장소의 상태**를 잰다 —
  //    모든 판이 이미 나간 지금은 `past = rest` 로 되돌리는 변이가 **동등 변이**가 되어
  //    조용히 살아남는다(2026-09-02 실측 · D45 생존). 나간 판과 안 나간 판이 **둘 다 있는**
  //    입력을 직접 만들어, 저장소 상태와 무관하게 분류를 잰다.
  {
    const fake = {
      bundle: { pv: "0", docs: { terms: { path: "policies/cur.html", hash: "0" } } },
      versions: [{ file: "cur.html", kind: "terms" }, { file: "old.html", kind: "terms" },
                 { file: "new.html", kind: "terms" }],
    };
    const html = indexHtml(fake, new Set(["cur.html", "old.html"]));
    const sec = (h) => {
      const at = html.indexOf(`<h2>${h}`);
      assert.ok(at > 0, t(`16-f: 합성 보관함에 「${h}」 절이 없다`));
      const end = html.indexOf("<h2>", at + 4);
      return html.slice(at, end < 0 ? html.length : end);
    };
    assert.deepEqual(files(sec("지난 판")), ["old.html"],
      t("16-f: ★ 실제로 나갔던 사본만 「지난 판」이어야 한다"));
    assert.deepEqual(files(sec("아직 나간 적 없는 판")), ["new.html"],
      t("16-f: ★ 나간 적 없는 사본만 「아직 안 나간 판」이어야 한다"));
  }
  // ── g. **보관함은 배포 경계 해시를 본문에 담지 않는다**(2026-09-02).
  //    담았더니 배포 → 경계 갱신 → 이 페이지 변경 → 선캐시 BUILD_ID 변경 → 또 배포 로
  //    **끝나지 않는 고리**가 됐다. 경계는 배포한 뒤에야 정해지므로 자기 경계를 적은
  //    페이지는 언제나 한 세대 뒤처진 값을 말한다. ⛔ 분류는 그대로 경계에서 파생한다.
  assert.ok(!idx.includes(DEPLOYED_SOURCE),
    t(`16-g: ★ 보관함이 배포 경계 해시(${DEPLOYED_SOURCE})를 본문에 적었다 — 배포마다 BUILD_ID 가 바뀐다`));
}

// ── 17. **처리정지 약속을 코드가 문장 안에서 지키는가** (2026-08-27 · 위협 82) ──
//
// 방침은 「처리정지를 누르면 **모든 기기에서 로그인이 풀린다**」고 적는다. 그런데 그 약속은
// 세션을 지우는 것만으로는 지켜지지 않는다 — **정지가 끝난 뒤에 도착하는 OAuth 콜백**이
// 세션을 하나 새로 만들면, 사용자가 재개하는 순간 그 기기가 살아난다.
// 그래서 발급 문장 자체가 「정지되지 않았고 세대가 그대로」를 요구해야 한다.
{
  const src = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  const ins = (src.match(/INSERT INTO sessions[\s\S]{0,400}?\{FENCE\}`\)/) || [])[0] || "";
  assert.ok(ins, t("17: 세션 INSERT 문장을 못 찾았다 — 검사가 낡았다"));
  assert.match(ins, /suspended_at IS NULL/,
    t("17: ★ 세션 발급이 정지 여부를 안 본다 — 「모든 기기에서 로그인이 풀린다」가 거짓이 된다"));
  assert.match(ins, /session_version = COALESCE\(\?, session_version\)/,
    t("17: ★ 세션 발급이 자격 확인 시점의 세대를 안 본다 — 로그아웃 뒤에도 발급된다"));
  assert.match(src, /if \(!\(ins\.meta && ins\.meta\.changes === 1\)\) throw new SessionRace\(\)/,
    t("17: ★ 0행 발급이 성공으로 넘어간다"));
  // 방침 쪽 문장도 함께 잰다 — 한쪽만 고치면 둘이 갈라진다.
  const cur = String(await R(POLICY_BUNDLE.docs.privacy.path)).replace(/\s+/g, " ");
  const sum = String(await R(POLICY_BUNDLE.docs.summary.path)).replace(/\s+/g, " ");
  for (const [label, body] of [["privacy.html", cur], ["요약", sum]]) {
    assert.ok(/모든 기기/.test(body),
      t(`17: ${label} 이 처리정지의 범위를 「모든 기기」로 적지 않았다`));
    assert.ok(/로그인만으로는|직접 누르셔야/.test(body),
      t(`17: ${label} 이 「로그인만으로 재개되지 않는다」를 적지 않았다`));
  }
}

console.log(`test-policies: 통과 — 단언 ${n}개 · 판 ${m.versions.length}개 · pv ${m.bundle.pv} · `
  + `필수 이벤트 ${REQUIRED_POLICY_EVENTS}종(${requiredPolicyKinds.map(([k, a]) => k + "/" + a).join(" ")})`);
