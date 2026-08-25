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
import { POLICY_BUNDLE } from "../worker/policies.js";
import { requiredPolicyKinds, REQUIRED_POLICY_EVENTS } from "../worker/index.js";

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
  const cur = String(await R("policies/" + m.versions.filter((v) => v.kind === "privacy").at(-1).file))
    .replace(/\s+/g, " ");
  const src = (await Promise.all(["js/app.js", "js/auth.js", "js/authApi.js", "js/friends.js"]
    .map((f) => R(f)))).map(String).join("\n");
  // `const XXX_KEY = "shh-…"` 로 선언된 것만 센다 — 그것이 이 저장소의 영속 키 관용구다.
  const keys = [...src.matchAll(/const \w*KEY\w* = "(shh-[a-z-]+)"/g)].map((x) => x[1]);
  assert.ok(keys.length >= 12, t(`영속 저장 키를 못 뽑았다 (${keys.length}개)`));

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
  for (const v of m.versions.filter((x) => x.kind === "privacy").slice(-1)) {
    // ⚠️ **공백을 접어서 본다.** 문구가 줄바꿈을 걸쳐 있으면 그대로 매치하는 검사는
    //    「문서를 재포맷했다」는 이유만으로 깨지고, 사람이 검사를 느슨하게 고치게 된다.
    const txt = String(await R("policies/" + v.file)).replace(/\s+/g, " ");
    assert.ok(!/확인용 값에는 <b>회원님을 가리키는 정보가 들어 있지 않습니다/.test(txt),
      t("방침이 Turnstile 토큰에 식별정보가 없다고 단정한다 — 앱이 입증할 수 없는 주장이다"));
    assert.match(txt, /저희 앱은 그 확인용 값에 회원님의 계정 번호/,
      t("방침이 「앱이 무엇을 넣지 않는가」로 범위를 좁히지 않았다"));
    assert.match(txt, /그 안에 무엇이 담기는지는 Cloudflare 가 정합니다/,
      t("방침이 토큰 내용의 결정 주체가 Cloudflare 임을 적지 않았다"));
  }
}

console.log(`test-policies: 통과 — 단언 ${n}개 · 판 ${m.versions.length}개 · pv ${m.bundle.pv} · `
  + `필수 이벤트 ${REQUIRED_POLICY_EVENTS}종(${requiredPolicyKinds.map(([k, a]) => k + "/" + a).join(" ")})`);
