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
//
// ⚠️ **이 면제는 넓다.** 실측: 이 정규식의 ±2줄 창이 문서 전체 비어 있지 않은 줄의 **47.7%**
//    에서 참이다(3,938줄 중 1,880줄). 즉 검사 1은 「금지 문구가 문서의 조용한 절반에 새로 들어올
//    때」만 잡는다. 그 정도로 충분한 이유는 여기 든 11종이 **설계 서술**이라 정정 맥락 밖에서
//    쓰일 일이 드물기 때문이다. **운영 상태(등록됐나·적용됐나·무엇이 라이브인가)에는 쓰지 않는다**
//    — 그쪽은 검사 10 이 훨씬 좁은 면제로 따로 본다.
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

// ── 9. 스위트 개수는 package.json 에서 읽는다 ─────────────────────────────
// 문서에 "16개 스위트" 를 손으로 적어 두면 스위트가 늘어도 아무도 안 고친다.
// 개수의 원본은 `package.json` 의 test 스크립트 하나뿐이다.
const testScript = JSON.parse(R("package.json")).scripts.test;
const suiteList = /for t in ([^;]+);/.exec(testScript);
if (!suiteList) bad("package.json 의 test 스크립트에서 스위트 목록을 못 읽었다 — 검사기가 낡았다");
const SUITES = suiteList ? suiteList[1].trim().split(/\s+/).length : 0;
for (const f of DOCS) {
  for (const m of R(f).matchAll(/(\d+)\s*개\s*스위트/g)) {
    if (+m[1] !== SUITES) bad(`${f} "${m[0]}" 라고 적혀 있는데 실제는 ${SUITES}개 (package.json)`);
  }
}
ok(`스위트 개수 ${SUITES}개 — package.json 과 문서가 일치`);

// ── 10. 낡은 「현재 운영 상태」가 되살아나지 않았나 ────────────────────────
//
// ⚠️ 검사 1의 `CORRECTION` 은 여기 쓰지 않는다. 그 정규식은 「않는다·아니다·였다」처럼
//    흔한 낱말을 포함해서, 운영 상태 문장 근처에서는 **거의 항상 참**이 되어 다 통과시킨다.
//    그래서 여기서는 **명시적인 역사 표식만** 면제한다 — 「당시 사실」·「역사 기록」·⛔.
//    날짜가 있다는 이유만으로도 통과시키지 않는다(현재형 문장에도 날짜는 붙는다).
const HIST = /당시 사실|역사 기록|⛔/;
const OLD_DEPLOYS = "acdecfa2|fa7d8ef0|774015e9";
const STALE_OPS = [
  [/RL_KEY[^\n]{0,20}(도\s*)?미등록|RL_KEY[^\n]{0,20}아직 등록되지|RL_KEY[^\n]{0,20}등록 전이라/,
   "RL_KEY 는 2026-08-17 production 에 등록됐다"],
  [/0004[^\n]{0,20}(아직|미적용)|아직 원격에 없다/, "0004 는 2026-08-17 원격에 적용됐다"],
  [/운영 미반영/, "1단계는 2026-08-17 배포 f72f5225 로 운영 반영됐다"],
  [new RegExp(`현재 라이브[^\\n]*(${OLD_DEPLOYS})|(${OLD_DEPLOYS})[^\\n]*현재 라이브`),
   "현재 라이브는 f72f5225(source cba3d3a) 다"],
];
// 면제는 셋뿐이고 전부 **그 줄 안에서** 판정한다 — 앞뒤 줄의 낱말로 통과시키지 않는다.
//  ① **일치한 문구 자체가** `~~취소선~~` 안에 있음 — 닫힌 과거 항목인 경우
//  ② 문구 바로 뒤(40자 안)의 부정 — "RL_KEY 미등록도 DB 오류도 **아니다**"
//  ③ 명시적 역사 표식 — 「당시 사실」·「역사 기록」·⛔
const struckAt = (ln, at) => {
  for (const m of ln.matchAll(/~~[^~]*~~/g)) {
    if (at >= m.index && at < m.index + m[0].length) return true;
  }
  return false;
};
if (!struckAt("~~RL_KEY 미등록~~", 2) ||
    struckAt("~~닫힌 옛 항목~~ · RL_KEY 미등록", "~~닫힌 옛 항목~~ · ".length)) {
  bad("취소선 면제가 일치한 문구 바깥까지 번진다 — 낡은 운영 상태를 숨길 수 있다");
}
const exempt = (ln, at) =>
  struckAt(ln, at) || /아니(다|었|라)/.test(ln.slice(at, at + 40)) || HIST.test(ln);
for (const f of DOCS) {
  const lines = R(f).split("\n");
  for (const [re, why] of STALE_OPS) {
    lines.forEach((ln, i) => {
      const m = re.exec(ln);
      if (!m) return;
      if (exempt(ln, m.index)) return;
      // 역사 표식은 절 전체에 걸리기도 한다(앞 2줄까지만 본다).
      if (HIST.test(lines.slice(Math.max(0, i - 2), i).join(" "))) return;
      bad(`${f}:${i + 1} 낡은 운영 상태 — ${why}\n      "${ln.trim().slice(0, 90)}"`);
    });
  }
}
ok(`낡은 운영 상태 ${STALE_OPS.length}종 — 역사 표식 밖 사용 0건`);

// ── 11. CLAUDE.md 와 HANDOFF.md 의 단계 상태가 같은 말을 하나 ──────────────
// 단계 정의의 원본은 CLAUDE.md §1-1 이다. HANDOFF 가 다른 말을 하면 실패시킨다.
const STAGE_FACTS = [
  [1, [/운영 반영 완료/, /엣지 캐시/], [/운영 미반영/, /1단계[^|]*최종 완료/],
   "1단계는 운영 반영 완료이고 엣지 캐시 때문에 최종 미완료다"],
  [2, [/정책 결정|결정 완료/, /외부 법률 검토 미완료/],
   [/외부 법률 검토 완료/, /4단계[^|]*구현 완료/], "2단계는 내부 정책 결정만 완료다"],
  [3, [/5판/, /완료/], [/3단계[^|]*미착수/], "3단계는 5판 설계 완료다"],
  [4, [/미착수/, /코드 0줄/], [/4단계[^|]*구현 완료/], "4단계는 미착수·코드 0줄이다"],
];
for (const [n, must, mustNot, why] of STAGE_FACTS) {
  for (const f of ["CLAUDE.md", "docs/HANDOFF.md"]) {
    const rows = R(f).split("\n").filter((ln) => new RegExp(`^[>\\s]*\\|\\s*${n}단계`).test(ln));
    if (!rows.length) { bad(`${f} 에 ${n}단계 행이 없다 — 단계 현황표가 사라졌거나 모양이 바뀌었다`); continue; }
    const row = rows.join(" ");
    for (const re of must) if (!re.test(row)) bad(`${f} ${n}단계 행에 ${re} 가 없다 — ${why}`);
    for (const re of mustNot) if (re.test(row)) bad(`${f} ${n}단계 행에 ${re} 가 남아 있다 — ${why}`);
  }
}
ok("CLAUDE.md 와 HANDOFF.md 의 1~4단계 상태가 일치");

// ── 12. 법률 자료가 현재 운영 사실을 담고 있나 ────────────────────────────
// 외부 검토자에게 나가는 자료다. 낡은 사실이 남으면 검토 전제가 틀어진다.
const PACKET_FACTS = [
  [/RL_KEY[^\n]*production 에 등록/, "RL_KEY 가 production 에 등록되어 있다는 사실"],
  [/providers:\s*\[\]/, "/api/ready 의 503 원인이 providers: [] 라는 사실"],
  [/rate_limits[^\n]*저장된다/, "로그인하지 않은 요청도 rate_limits 행을 만든다는 사실"],
];
{
  const t = R(PACKET);
  for (const [re, what] of PACKET_FACTS) if (!re.test(t)) bad(`${PACKET} 에 ${what} 가 없다`);
}
ok("법률 자료가 현재 운영 사실 3건을 담고 있다");

// ── 13. 인수인계·법률 자료의 현재형 문구가 다시 낡지 않았나 ──────────────
const handoff = R("docs/HANDOFF.md");
if (/^# 인수인계[^\n]*\(\d{4}-\d{2}-\d{2} 기준\)/m.test(handoff)) {
  bad("HANDOFF 제목에 고정된 기준일이 남아 있다 — 본문 최신 실측과 다시 충돌한다");
}
if (/^프로덕션 재배포는 2026-08-14 에 끝났다/m.test(handoff)) {
  bad("HANDOFF 가 2026-08-17 배포 뒤에도 08-14 재배포를 현재 완료 상태로 말한다");
}
if (/자동 삭제 수단이 없다/.test(R(PACKET))) {
  bad(`${PACKET} 가 다음 로그인 삭제를 설명하면서 자동 삭제 수단이 전혀 없다고 단정한다`);
}
ok("인수인계 기준일 · 배포 시점 · 정리 수단 표현이 현재 사실과 일치");

console.log(fails
  ? `test-docs: 실패 ${fails}건`
  : "test-docs: 통과 — 낡은 문구 · 죽은 § 참조 · 번호 연속성 · 선언된 개수 · 판 번호 · 필수 절 · 완료 범위 · 보유기간 단정 · 스위트 수 · 낡은 운영 상태 · 단계 상태 일치 · 법률 자료 현재 사실 · 인수인계 현재성");
process.exit(fails ? 1 : 0);
