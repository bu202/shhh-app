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
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, bundleId, currentAssets, KINDS, DIR } from "./policies.mjs";
import { INCLUDE } from "./build.mjs";
import { POLICY_BUNDLE } from "../worker/policies.js";
import { requiredPolicyKinds, REQUIRED_POLICY_EVENTS, SESSION_DAYS } from "../worker/index.js";
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
    [/매일 백업하지 않습니다/, "백업 주기 사실"],
    [/자동으로 되돌리는 기능은 만들지 않습니다/, "자동 복원 금지"],
  ]) assert.match(cur, re, t(`현재 방침 판에 ${what} 서술이 없다`));
}

console.log(`test-policies: 통과 — 단언 ${n}개 · 판 ${m.versions.length}개 · pv ${m.bundle.pv} · `
  + `필수 이벤트 ${REQUIRED_POLICY_EVENTS}종(${requiredPolicyKinds.map(([k, a]) => k + "/" + a).join(" ")})`);
