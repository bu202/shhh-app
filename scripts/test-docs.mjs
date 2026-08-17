// 문서 일관성 검사. `node scripts/test-docs.mjs`
//
// **이것은 런타임 테스트가 아니다.** 4단계 기능이 도는지 재지 않는다 —
// 문서끼리 서로 다른 말을 하는지, 죽은 참조가 있는지, 이미 틀렸다고 판정한 문구가
// 되살아났는지만 본다. 그 구분을 흐리지 않으려고 파일을 따로 뒀다.
//
// 왜 필요한가: 2·3·4판이 각각 "완료"를 선언했고 그때마다 다음 재감사가
// **한 절을 고치고 다른 절의 반대 문장을 남긴 것**을 찾았다. 사람이 기억해서
// grep 하는 방식은 잊으면 그만이다. 어기면 `npm test` 가 실패하게 만든다.

import { readFileSync, existsSync } from "node:fs";

const R = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
let fails = 0, mark = 0;
const bad = (msg) => { console.error("  ✗ " + msg); fails++; };
// 직전 검사에서 실패가 늘었으면 "통과"라고 찍지 않는다.
const ok = (msg) => { if (fails === mark) console.log("  ✓ " + msg); mark = fails; };

const STAGE3 = "docs/STAGE3_SIGNUP_SECURITY_DESIGN.md";
const PACKET = "docs/PRIVACY_LEGAL_REVIEW_PACKET.md";
const STAGE2 = "docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md";
const DOCS = [STAGE3, PACKET, STAGE2, "CLAUDE.md", "docs/HANDOFF.md",
              "docs/SECURITY_RELEASE_CHECKLIST.md", "privacy.html"];

for (const f of DOCS) if (!existsSync(new URL("../" + f, import.meta.url))) { bad(`파일 없음: ${f}`); }
if (fails) { console.error("test-docs: 실패"); process.exit(1); }

// ── 1. 이미 틀렸다고 판정한 문구가 되살아나지 않았나 ──────────────────────
//
// ⚠️ **과거 오류를 설명하는 문장은 정상이다.** "4판까지 ~라고 적었다. 틀렸다" 같은 서술은
//    기록으로 남겨야 한다. 그래서 **금지 문구가 정정 맥락 안에 있으면 통과**시킨다 —
//    같은 줄이나 바로 앞뒤 줄에 정정 표시(틀렸다/정정/판에서/⚠️/⛔)가 있으면 설명으로 본다.
const FORBIDDEN = [
  ["가능한 한 같은", "필수 원자성을 재량으로 낮춘다 (R5)"],
  ["가능하면 원자", "같음"],
  ["언젠가 치운다", "보유기간에 정리 수단이 없다는 뜻이다 (§10-5-2)"],
  ["최소한 탐지", "탐지는 복원 허용 근거가 아니다 (§10-8-1 D11)"],
  ["수행된 적 없", "현재 비활성 ≠ 과거에도 없었음 (패킷 §2 앞머리)"],
  ["서비스 전용 값이라", "제공자 ID 를 셋으로 일반화할 근거가 없다 (패킷 §2-3)"],
  ["앱마다 다른 값이라", "같음"],
  ["L1~L7 은", "법률 질문 범위가 낡았다"],
  ["L1~L11", "같음"],
  ["L1~L12", "같음"],
  ["복원 9단계", "ledger 는 제자리 복원하지 않는다 (§10-6-0)"],
];
const CORRECTION = /틀렸|정정|판에서|판까지|⚠️|⛔|아니다|않는다|없앴|였다|있었다|예전|고친|결함|금지 문구/;
for (const f of [...DOCS, "worker/index.js", "wrangler.jsonc"]) {
  const lines = R(f).split("\n");
  for (const [phrase, why] of FORBIDDEN) {
    lines.forEach((ln, i) => {
      if (!ln.includes(phrase)) return;
      const ctx = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
      if (CORRECTION.test(ctx)) return;          // 과거 오류 설명은 통과
      bad(`${f}:${i + 1} 금지 문구 "${phrase}" — ${why}`);
    });
  }
}
ok(`낡은 문구 ${FORBIDDEN.length}종 — 정정 맥락 밖 사용 0건`);

// ── 2. 존재하지 않는 § 참조 ───────────────────────────────────────────────
//
// 다른 문서를 가리키는 참조(`2단계 §9`, `HANDOFF.md §4-6`)는 제외한다 —
// 여기서 잡으려는 것은 **자기 문서 안의 죽은 참조**다(4판의 §22 가 그것이었다).
const CROSS = /(?:\d단계|[\w.\-/]+\.md|법률 패킷|법률 자료|설계서|패킷|체크리스트)[`'"\s]*(?:의\s*)?§/;
for (const f of [STAGE3, PACKET, STAGE2]) {
  const t = R(f);
  const heads = new Set();
  for (const m of t.matchAll(/^#{2,6}\s*[^\w\d]*§?\s*([0-9]+(?:-[0-9A-Za-z]+)*)\./gm)) heads.add(m[1]);
  const has = (r) => heads.has(r) || [...heads].some((h) => h.startsWith(r + "-"));
  const dead = new Set();
  for (const m of t.matchAll(/§\s*([0-9]+(?:-[0-9A-Za-z]+)*)/g)) {
    const before = t.slice(Math.max(0, m.index - 90), m.index + 1);
    if (CROSS.test(before)) continue;            // 다른 문서 참조
    if (!has(m[1])) dead.add(m[1]);
  }
  if (dead.size) bad(`${f} 죽은 자기참조: ${[...dead].map((d) => "§" + d).join(" ")}`);
}
ok("자기 문서 안의 § 참조 — 전부 실재");

// ── 3. 번호 연속성 (위협 · 테스트 · 법률 질문) ────────────────────────────
const span = (t, from, to) => t.slice(t.indexOf(from), to ? t.indexOf(to) : undefined);
const seq = (label, nums, file) => {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  if (!s.length) return bad(`${file} ${label} 번호를 하나도 못 찾았다 — 검사기가 낡았다`);
  const gaps = [];
  for (let i = s[0]; i <= s[s.length - 1]; i++) if (!s.includes(i)) gaps.push(i);
  if (gaps.length) bad(`${file} ${label} 결번: ${gaps.join(",")}`);
  else ok(`${label} ${s[0]}~${s[s.length - 1]} 연속 (${s.length}개)`);
  return s;
};

const s3 = R(STAGE3);
const threatBlock = span(s3, "## 11. 보안 위협 모델", "## 12. ");
const threats = seq("위협", [...threatBlock.matchAll(/^\|\s*\*?\*?(\d+)\*?\*?\s*\|/gm)].map((m) => +m[1]), STAGE3);
const tests = seq("테스트 T", [...s3.matchAll(/\bT(\d+)\b/g)].map((m) => +m[1]), STAGE3);
const ls = seq("법률 질문 L", [...R(PACKET).matchAll(/\bL(\d+)\b/g)].map((m) => +m[1]), PACKET);

// ── 4. 개수를 말하는 문장이 실제와 맞나 ───────────────────────────────────
// 문서가 "위협 35건" 이라고 적어 두고 표에는 38행이 있는 상태를 막는다.
const claim = (t, re, actual, what, file) => {
  for (const m of t.matchAll(re)) {
    if (+m[1] !== actual) bad(`${file} "${m[0]}" 라고 적혀 있는데 실제는 ${actual}${what}`);
  }
};
const maxT = tests[tests.length - 1], maxL = ls[ls.length - 1], maxTh = threats[threats.length - 1];
for (const f of DOCS) {
  const t = R(f);
  claim(t, /위협(?:\s*모델)?\s*(\d+)\s*건/g, maxTh, "건", f);
  claim(t, /테스트\s*(?:명세\s*)?(\d+)\s*건/g, maxT, "건", f);
  claim(t, /L1~L(\d+)/g, maxL, "", f);
}
ok(`선언된 개수 == 실제 (위협 ${maxTh} · T${maxT} · L${maxL})`);

// ── 5. 판 번호가 문서들 사이에서 같은가 ───────────────────────────────────
const EDITION = 5;
const editionOf = (t) => {
  const m = [...t.matchAll(/(\d+)판/g)].map((x) => +x[1]);
  return m.length ? Math.max(...m) : null;
};
for (const f of [STAGE3, PACKET, STAGE2, "CLAUDE.md", "docs/HANDOFF.md"]) {
  const e = editionOf(R(f));
  if (e !== null && e !== EDITION) bad(`${f} 최신 판 번호가 ${e}판 — 나머지는 ${EDITION}판`);
}
ok(`설계서 판 번호 ${EDITION}판으로 통일`);

// ── 6. 반드시 있어야 할 heading ───────────────────────────────────────────
const REQUIRED = [
  [STAGE3, ["## 0-5.", "### 5-3-5.", "### 5-4.", "### 10-5-2.", "#### ⛔ 10-6-0.",
            "### 10-7.", "### 10-8-0.", "### 10-8-1.", "## 21. 최종 판정"]],
  [PACKET, ["### 2-3.", "### 12-4."]],
];
for (const [f, heads] of REQUIRED) {
  const t = R(f);
  for (const h of heads) if (!t.includes(h)) bad(`${f} 필수 절 없음: ${h}`);
}
ok("필수 절 전부 존재");

// ── 7. 「완료」와 「미완료」가 같이 서 있지 않은가 ─────────────────────────
// 3단계가 완료라고 적으면서 4단계 착수·법률 검토·복원 금지 해제까지 완료로 읽히면 안 된다.
const verdict = span(s3, "## 21. 최종 판정");
for (const must of ["코드 0줄", "미검토", "restore 금지", "No-Go"]) {
  if (!verdict.includes(must)) bad(`${STAGE3} §21 에 "${must}" 가 없다 — 완료 선언의 범위가 흐려진다`);
}
ok("§21 이 완료의 범위를 제한하고 있다");

// ── 8. 방침이 아직 확정 안 된 보유기간을 단정하지 않는가 ──────────────────
// 결정 E: 세 항이 확정되기 전에는 privacy.html 에 숫자를 적지 않는다.
const priv = R("privacy.html");
for (const m of priv.matchAll(/(\d+)\s*일\s*(?:뒤|후)에?\s*(?:반드시\s*)?(?:삭제|지웁|지워)/g)) {
  bad(`privacy.html 확정되지 않은 보유기간을 단정: "${m[0]}" (설계서 §10-5)`);
}
ok("privacy.html — 미확정 보유기간 단정 0건");

console.log(fails
  ? `test-docs: 실패 ${fails}건`
  : "test-docs: 통과 — 낡은 문구 · 죽은 § 참조 · 번호 연속성 · 선언된 개수 · 판 번호 · 필수 절 · 완료 범위 · 보유기간 단정");
process.exit(fails ? 1 : 0);
