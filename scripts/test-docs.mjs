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
  // 4단계가 로컬로 끝난 뒤 낡아진 문구들(2026-08-18).
  ["CASCADE 임시 유지", "CASCADE 는 2026-08-18 에 확정됐다 (프로젝트 결정 B)"],
  ["migration 생성 금지", "0005 를 만들었다"],
  ["코드 0줄", "4단계는 로컬 구현이 끝났다"],
  ["4단계 착수 조건", "착수 조건은 2026-08-18 에 해소됐다 — 남은 것은 원격 반영이다"],
  ["법률 검토까지 보류", "법률 검토는 착수 게이트에서 제외됐다 (프로젝트 결정 E)"],
  ["privacy/accepted", "처리 근거가 계약 이행이라 privacy 는 presented 다"],
  ["xborder/accepted", "국외 처리위탁·보관은 제28조의8 제1항 제3호를 근거로 삼는다"],
  // 7판(2026-08-19 독립 재감사)이 뒤집은 문장들. 전부 **한 번 검토를 통과했던** 표현이다.
  ["요청당 정확히 둘", "요청 수가 무제한이면 요청당 상수는 상한이 아니다 (위협 47)"],
  ["대상이 늘어나지 줄지", "틀린 mark 함수는 대상을 **줄인다** — 그래서 인자를 없앴다 (위협 44)"],
  ["읽기는 안 센다", "인증이 필요한 읽기도 `read` 버킷으로 센다 (위협 47)"],
  ["세는 단위는 사람이다", "리미터는 인증보다 먼저 돌아 IP 로 센다 (위협 47)"],
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
// ⚠️ **「전부 같은 숫자」가 아니다**(2026-08-19 정정). 옛 검사는 모든 문서의 최대 판 번호가
//    같기를 요구했는데, 그러면 **역사 서술이 있는 문서가 판을 올릴 때마다 같이 거짓이 된다** —
//    법률 패킷은 자기 판(5판)이 따로 있고, 「5판이 닫은 것」 같은 기록은 지우면 안 된다.
//    지금 재는 것은 둘이다: ① 설계서가 실제로 그 판이다 ② 어느 문서도 **그보다 앞선 판**을
//    말하지 않는다(앞서 나가면 그건 아직 없는 판을 완료라고 적은 것이다).
const EDITION = 7;
const editionOf = (t) => {
  const m = [...t.matchAll(/(\d+)판/g)].map((x) => +x[1]);
  return m.length ? Math.max(...m) : null;
};
if (editionOf(R(STAGE3)) !== EDITION) bad(`${STAGE3} 가 ${EDITION}판이 아니다`);
for (const f of [PACKET, STAGE2, "CLAUDE.md", "docs/HANDOFF.md"]) {
  const e = editionOf(R(f));
  if (e !== null && e > EDITION) bad(`${f} 가 아직 없는 ${e}판을 말한다 — 설계서는 ${EDITION}판이다`);
}
ok(`설계서 ${EDITION}판 · 앞서 나간 판 번호 0건`);

// ── 6. 반드시 있어야 할 heading ───────────────────────────────────────────
const REQUIRED = [
  [STAGE3, ["## 0-5.", "## 0-6.", "## 0-7.", "### 5-3-5.", "### 5-4.", "### 10-5-2.", "#### ⛔ 10-6-0.",
            "### 10-7.", "### 10-8-0.", "### 10-8-1.", "## 21. 최종 판정"]],
  [PACKET, ["### 2-3.", "### 12-4."]],
];
for (const [f, heads] of REQUIRED) {
  const t = R(f);
  for (const h of heads) if (!t.includes(h)) bad(`${f} 필수 절 없음: ${h}`);
}
ok("필수 절 전부 존재");

// ── 7. 현재 상태와 역사 기록이 갈려 있는가 ────────────────────────────────
//
// 무엇이 문제였나(2026-08-18 재현): `CLAUDE.md` 는 「4단계 로컬 구현 완료」라고 적고, 같은 날
// `SECURITY_RELEASE_CHECKLIST.md` 는 「코드 0줄」, `STAGE3 §21` 은 「4단계는 착수하지 않았다」라고
// 적고 있었다. **셋 다 test-docs 를 통과했다** — 검사 1의 정정 문맥 면제(±2줄에 ⚠️ 하나면 통과)가
// 너무 넓어서, 낡은 **현재 상태**까지 역사 설명으로 봐 준 것이다.
//
// 고친 방법: 문서마다 현재 상태를 `<!-- 현재상태:시작/끝 -->` 로 **명시적으로 묶는다.**
// 그 안에서는 **면제가 없다.** 밖은 전부 역사 기록이라 옛 판정이 그대로 있어도 통과한다.
const NOW0 = "<!-- 현재상태:시작 -->", NOW1 = "<!-- 현재상태:끝 -->";
// 현재 상태 블록 안에서는 이 문구들이 곧 거짓이다.
const STALE_NOW = [
  [/코드 0줄/, "4단계 코드는 2026-08-18 에 로컬로 구현됐다"],
  [/미착수|착수하지 않았다|착수 조건/, "4단계는 착수됐다"],
  [/전부 없다/, "산출물은 저장소에 있다(설계서 §13-6)"],
  [/설계만이고/, "같음"],
];
// 반대로, 「끝났다」만 적고 남은 것을 안 적으면 그것도 거짓이다.
const NOW_MUST = [
  [/로컬 구현 완료|구현 완료 2026-08-18|4단계 원격 반영|원격 반영/, "4단계가 어디까지 됐는지"],
  [/원격(은 )?0건|원격 미반영|배포 0건|미실행|미등록/, "원격은 아무것도 안 했다는 사실"],
  [/No-Go/, "출시 판정"],
];
const NOW_FILES = ["CLAUDE.md", "docs/HANDOFF.md", "docs/SECURITY_RELEASE_CHECKLIST.md", STAGE3];
for (const f of NOW_FILES) {
  const t = R(f);
  const i = t.indexOf(NOW0), j = t.indexOf(NOW1);
  if (i < 0 || j < i) { bad(`${f} 에 현재상태 블록이 없다 — 현재와 과거를 가를 수 없다`); continue; }
  if (t.indexOf(NOW0, i + 1) >= 0) bad(`${f} 에 현재상태 블록이 둘 이상이다 — 원본이 하나여야 한다`);
  const now = t.slice(i, j);
  // ⚠️ **줄 단위로 본다.** 블록 전체에 걸면 「이후 단계는 미착수」처럼 지금도 참인 문장까지
  //    걸린다. 잡으려는 것은 **4단계·구현을 두고 낡은 말을 하는 줄**이다.
  for (const ln of now.split("\n")) {
    if (!/4단계|구현/.test(ln)) continue;
    for (const [re, why] of STALE_NOW) {
      if (re.test(ln)) bad(`${f} 현재상태 블록에 ${re} 가 있다 — ${why}\n      "${ln.trim().slice(0, 90)}"`);
    }
  }
  for (const [re, what] of NOW_MUST) {
    if (!re.test(now)) bad(`${f} 현재상태 블록에 ${what} 가 없다 — 완료 선언의 범위가 흐려진다`);
  }
}
// 같은 문구가 **블록 밖(역사 기록)에는** 남아 있어야 정상이다. 지워 버리면 왜 그렇게 판단했는지가
// 사라진다 — 이 저장소가 세 판 연속으로 「완료」를 잘못 선언한 기록이 바로 거기 있다.
{
  const t = R(STAGE3);
  const hist = t.slice(t.indexOf(NOW1));
  if (!hist.includes("코드 0줄")) bad(`${STAGE3} 역사 기록에서 옛 판정이 지워졌다 — 왜 틀렸는지가 사라진다`);
}
ok(`현재상태 블록 ${NOW_FILES.length}개 — 낡은 현재 상태 0건 · 역사 기록 보존`);

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
  // 2026-08-19 실측으로 닫혔다. 「아직 열려 있다」·「만료를 기다린다」는 이제 거짓이다.
  [/엣지 캐시[^\n]{0,30}(아직 열려|여전히 원문|만료 대기|만료를 기다)|내부 파일 7개[^\n]{0,20}열려 있다/,
   "옛 엣지 캐시 7개는 2026-08-19 18:15 KST 실측에서 전부 SPA 폴백이었다"],
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
  // 1단계는 **2026-08-19 실측으로 닫혔다.** 근거를 함께 요구한다 — 「완료」만 적고 무엇을 재서
  // 그렇게 판정했는지 안 적으면, 그게 이 저장소가 세 번 반복한 실수다.
  [1, [/완료 2026-08-19|2026-08-19 실측|08-19 18:15/, /엣지 캐시/], [/운영 미반영/, /만료(를)? 기다/],
   "1단계는 2026-08-19 실측(canonical 7개 전부 SPA 폴백)으로 완료다"],
  [2, [/정책 결정|결정 완료/, /외부 법률 검토 미완료/],
   [/외부 법률 검토 완료/, /4단계[^|]*구현 완료/], "2단계는 내부 정책 결정만 완료다"],
  [3, [/6판/, /완료/], [/3단계[^|]*미착수/], "3단계는 6판 설계 완료다"],
  // 4단계는 **로컬만** 끝났다. 「구현 완료」가 「출시 가능」으로 읽히지 않게 두 사실을 함께 요구한다.
  [4, [/로컬 구현 완료/, /원격 미반영/, /배포 0건/], [/미착수/, /코드 0줄/, /출시 완료/],
   "4단계는 로컬 구현 완료이고 원격은 아무것도 안 했다"],
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

// ── 11b. 4단계 산출물이 실제로 있는가 ─────────────────────────────────────
// 문서가 「구현 완료」라고 말하는데 파일이 없으면, 그 선언이 가장 위험한 거짓말이 된다.
// ⚠️ **이것은 「도는가」를 재지 않는다** — 그건 런타임 테스트의 몫이다. 여기서는 존재만 본다.
for (const f of ["worker/policies.js", "worker/ledger.js", "worker/ops.js", "worker/cleanup/index.js",
                 "worker/ledger-schema.sql", "policies/manifest.json",
                 "migrations/0005_policy_events_and_signup_states.sql",
                 "migrations-ledger/0001_ledger_init.sql",
                 "scripts/test-signup.mjs", "scripts/test-policies.mjs",
                 "scripts/test-deletion-ledger.mjs", "scripts/test-cleanup.mjs"]) {
  if (!existsSync(new URL("../" + f, import.meta.url))) bad(`4단계 산출물이 없는데 문서는 구현 완료라 말한다: ${f}`);
}
ok("4단계 산출물 12개 전부 존재");

// ── 11c. 「원격에 반영했다」고 말하지 않는가 ──────────────────────────────
// 로컬 구현과 운영 반영은 다른 말이다. 섞이면 다음 사람이 배포된 줄 알고 검증을 건너뛴다.
const REMOTE_CLAIMS = [
  [/ledger D1[^\n]{0,30}(생성 완료|만들었다)/, "ledger D1 은 아직 만들지 않았다"],
  [/0005[^\n]{0,20}(원격에 )?적용 완료/, "0005 는 원격에 적용하지 않았다"],
  [/(SIGNUP_STATE_KEY|TOMBSTONE_KEY|DELETION_KEY)[^\n]{0,20}등록 완료/, "새 시크릿은 등록하지 않았다"],
  [/정리 (크론|Worker)[^\n]{0,20}배포 완료/, "정리 Worker 는 배포하지 않았다"],
];
for (const f of DOCS) {
  const lines = R(f).split("\n");
  for (const [re, why] of REMOTE_CLAIMS) {
    lines.forEach((ln, i) => {
      if (!re.test(ln)) return;
      if (HIST.test(ln) || /아니|안 했|않았|없다|금지|대기|예정/.test(ln)) return;
      bad(`${f}:${i + 1} 원격 반영을 완료라고 말한다 — ${why}\n      "${ln.trim().slice(0, 90)}"`);
    });
  }
}
ok(`원격 반영 과장 ${REMOTE_CLAIMS.length}종 — 0건`);

// ── 11d. 복원 금지 gate 를 손으로 열지 않았나 ─────────────────────────────
// `noActiveLeases` 는 **질의 결과여야 하는 값**이다. 코드에 `true` 로 적으면 gate 가
// 「지금 요청이 도는가」를 안 보고 열린다 — 그게 결정 A′ 가 막으려던 바로 그것이다.
{
  // ⚠️ **주석을 뺀다.** 규칙을 적어 둔 문장("손으로 noActiveLeases: true 를 적지 않는다")까지
  //    벌하면, 규칙을 문서화하는 것이 검사 실패가 된다 — 같은 함정을 이미 한 번 밟았다.
  const strip = (t) => t.split("\n").filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join("\n");
  const ops = strip(R("worker/ops.js"));
  if (/noActiveLeases:\s*true/.test(ops)) {
    bad("worker/ops.js 가 noActiveLeases 를 손으로 true 로 적었다 — 그 값은 drainReport() 의 질의 결과여야 한다");
  }
  for (const k of ["oldDeployments", "regressionTests"]) {
    if (new RegExp(k + "\\s*:\\s*true").test(ops)) {
      bad(`worker/ops.js 가 ${k} 를 true 로 적었다 — 원격 증명 없이 복원 금지가 풀린다`);
    }
  }
  // 7판 방어: 재개방 판정이 다시 호출자 함수를 받으면 위협 44 가 되살아난다.
  for (const [re, why] of [
    [/reopenReport\s*\(\s*env\s*,\s*\{[^}]*markFns/, "재개방 판정이 호출자 함수를 다시 받는다 (위협 44)"],
    [/export async function reconcile\(env, \{ mark[,\s}]/, "reconciliation 이 호출자 함수를 다시 받는다 (위협 46)"],
    [/READS_USER_DATA = new Set\(\["open"\]\)/, "maintenance 도 읽기를 허용한다 — 옆문이 다시 열린다 (위협 43)"],
  ]) {
    if (re.test(ops)) bad(`worker/ops.js ${why}`);
  }
  // 리미터가 임차증보다 뒤로 가면 위협 47 이 되살아난다. **순서를 소스에서 직접 잰다.**
  {
    const idx = strip(R("worker/index.js"));
    const rl = idx.indexOf("await limited(env, req, rt.bucket)");
    const lease = idx.indexOf("await acquireLease(env, LEASE_MODES_REQUEST)");
    if (rl < 0 || lease < 0) bad("worker/index.js 에서 리미터·임차증 자리를 못 찾았다 — 검사기가 낡았다");
    else if (rl > lease) bad("worker/index.js 의 리미터가 임차증보다 뒤에 있다 — 막힌 요청도 ledger 에 쓴다 (위협 47)");
  }
  // 임차증 해제가 UPDATE 로 되돌아가면 표가 무한히 자란다(정리 크론은 시간당 200행).
  if (/UPDATE write_leases SET released_at/.test(strip(R("worker/ledger.js")))) {
    bad("worker/ledger.js 가 임차증 해제를 UPDATE 로 되돌렸다 — 요청마다 행이 쌓여 표가 자란다");
  }
}
ok("복원 금지 gate — 손으로 연 자리 0건 · 임차증 해제는 DELETE · 7판 방어 4종 유지");

// ── 11e. 주 D1 을 만지는 파일이 분류표에 다 올라와 있나 ───────────────────
// 재현(2026-08-18): §10-9-6 이 `worker/index.js` 의 쓰기 11개만 세고 있었고, 그래서
// **정리 크론이 분류 밖에 남았다.** 크론은 게이트만 읽고 임차증 없이 주 D1 을 지웠고,
// 지우는 도중에 `drainState()` 가 `drained:true` 를 답했다(T47b).
//
// ⚠️ **이 검사는 완전한 증명이 아니다.** 정규식이 세는 것은 「파일 이름이 그 절에 적혔나」뿐이고,
//    적어 놓고 임차증을 안 거는 것은 못 잡는다(그건 T47b·T47d 가 런타임으로 잡는다).
//    빠뜨림을 줄이는 장치이지, 안전의 근거가 아니다.
{
  const { readdirSync } = await import("node:fs");
  const files = [];
  for (const d of ["worker", "worker/cleanup"]) {
    for (const f of readdirSync(new URL("../" + d, import.meta.url)))
      if (f.endsWith(".js")) files.push(`${d}/${f}`);
  }
  const section = (R(STAGE3).split("#### 10-9-6.")[1] || "").split("#### 10-9-7.")[0];
  if (!section) bad(`${STAGE3} 에 §10-9-6 분류표가 없다`);
  const touching = files.filter((f) => /env\.DB|["']DB["']/.test(R(f)));
  for (const f of touching) {
    if (!section.includes(f)) {
      bad(`§10-9-6 분류표에 ${f} 가 없다 — 주 D1 을 만지는데 어느 부류인지 아무도 안 적었다`);
    }
  }
  if (touching.length < 3) bad(`주 D1 접근 파일을 ${touching.length}개만 찾았다 — 검색이 틀렸다`);
  // 낡은 현재형: 임차증이 삭제 saga 전용이라는 말은 이제 거짓이다.
  for (const [f, re, why] of [
    ["worker/ledger-schema.sql", /지금은 \*\*삭제 saga 만\*\* 딴다/, "임차증은 HTTP 요청과 정리 크론이 모두 딴다"],
    ["worker/ops.js", /^\/\/ 8개 조건이/m, "조건은 9개이고, 개수를 손으로 적으면 또 낡는다"],
    // ⚠️ 단정형만 잡는다 — "옛 주석은 「…」였다" 같은 **역사 서술은 통과**시킨다. 기록은 지우면 안 된다.
    ["worker/ops.js", /이것은 삭제 saga 의 drain 이다\.\*\*/, "온라인 workload 전체의 drain 이다"],
  ]) {
    if (re.test(R(f))) bad(`${f} 가 낡은 현재형을 말한다 — ${why}`);
  }
}
ok(`주 D1 접근 파일이 §10-9-6 분류표에 전부 등재 · 임차증 범위 낡은 문구 0건`);

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

// ── 14. 4단계 마감 뒤 낡아진 「현재 상태」가 되살아나지 않았나 ────────────
//
// ⚠️ **검사 1(FORBIDDEN)과 다른 도구다.** 저기는 ±2줄 정정 맥락을 면제하는데, 실측 47.7% 의 줄이
//    그 창에 걸려 운영 상태에는 못 쓴다. 여기는 반대로 간다 — **현재 상태를 말하는 구간만** 보고,
//    면제는 **같은 줄에 역사 표시가 있을 때만** 준다. 그래서 역사 기록은 문서 어디에 있어도 통과하고,
//    「지금 이렇다」고 말하는 자리에서만 잡힌다.
//
// 왜 생겼나(2026-08-18): 결정 A′ 구현이 끝난 뒤에도 설계서 머리말·§21-0·§13-6, HANDOFF 의 현재
// 작업표, CLAUDE.md 가 「drain 방식 미선택」·「사용자 결정 대기」·「코드 0줄」·「해제된 lease 를
// 지운다」·「T6·T8 은 아직 못 막는 시험」을 **현재 사실로** 계속 말하고 있었다. 전부 코드와 반대다.
const CURRENT_REGIONS = [
  [STAGE3, "# 3단계 상세 설계", "## 개정 이력", "설계서 머리말"],
  [STAGE3, "### 13-6.", "## 14. ", "설계서 §13-6 현재 구현 매핑"],
  [STAGE3, "### 21-0.", "<!-- 현재상태:끝 -->", "설계서 §21-0 현재 상태"],
  ["docs/HANDOFF.md", "## 0. 30초 요약", "## 1. ", "HANDOFF 30초 요약"],
  ["docs/HANDOFF.md", "### 4-1.", "### 4-7.", "HANDOFF 현재 작업표"],
  ["CLAUDE.md", "### 1-1.", "## 6. 구조와 경계", "CLAUDE.md 현재 규칙"],
];
// 같은 줄이 스스로 「이건 과거다」라고 말하면 통과시킨다. **줄 단위다** — 앞뒤 줄로 번지지 않는다.
// ⚠️ **표식은 좁게 잡는다.** 처음에 `이었다|였다|그때|예전` 까지 넣었더니 돌연변이 2건이 그대로
//    통과했다 — 표 한 줄이 길면 그 안 어딘가에 과거형 서술어가 반드시 하나는 있어서, 줄 전체가
//    면제됐다. 면제는 **「이 줄은 기록이다」라고 명시한 말**에만 준다.
//    ⚠️ `그때의 기록|기록이다` 도 뺐다 — 「아래는 그때의 기록이다」로 시작하는 한 줄에
//    **현재 서술과 과거 서술이 같이 들어 있는** 표 칸이 있어서, 그 한 마디가 현재 부분까지
//    덮어 버렸다(돌연변이 M3 이 통과했다). 한 줄이 둘을 겸하면 **현재 쪽 규칙을 적용한다.**
const HISTORY_MARK = /당시|그날|역사 기록|판 시점|판 당시/;
const CURRENT_LIES = [
  [/drain[^\n]{0,40}미선택|미선택[^\n]{0,40}drain/, "전역 user-data drain 은 결정 A′ 로 구현됐다(방식 미선택 아님)"],
  [/drain[^\n]{0,40}결정 대기|결정 대기[^\n]{0,40}drain/, "drain 은 사용자 결정 대기가 아니라 구현 완료다"],
  [/코드 0줄|테스트 파일[^\n]{0,10}전부[^\n]{0,4}없다|구현 파일이 없다/, "4단계 코드·테스트는 2026-08-18 에 만들어졌다"],
  [/해제된 (lease|임차증)/, "해제는 행 DELETE 다 — 표에 남은 행은 전부 진행 중이거나 stale 이고 정리 대상이 아니다"],
  [/(lease|임차증)[^\n]{0,30}(정리 대상|지운다|청소)[^\n]{0,20}(크론|Worker)|정리[^\n]{0,20}Worker[^\n]{0,40}(lease|임차증)[^\n]{0,20}(지운다|정리한다)/,
   "정리 Worker 의 대상은 4가지이고 write_leases 는 거기 없다"],
];
for (const [f, from, to, label] of CURRENT_REGIONS) {
  const t = R(f);
  const i = t.indexOf(from), j = t.indexOf(to, i + 1);
  if (i < 0 || j < 0) { bad(`${f} 에서 「${label}」 구간을 못 찾았다 — 표식이 바뀌었으면 이 검사도 고친다`); continue; }
  const lines = t.slice(i, j).split("\n");
  lines.forEach((ln, k) => {
    if (HISTORY_MARK.test(ln)) return;                 // 스스로 과거라고 밝힌 줄
    for (const [re, why] of CURRENT_LIES)
      if (re.test(ln)) bad(`${f} 「${label}」 ${k + 1}번째 줄이 낡은 현재 상태를 말한다 — ${why}`);
    // T6 과 T8 을 **한 덩어리로 묶어** 「아직 못 막는다」고 하면 틀렸다. T6 은 통과 검사가 됐고
    // T8 만 남았다. ⚠️ 둘이 같은 줄에 있는 것 자체는 정상이다(「T6 은 통과, T8 만 실패 재현」이
    // 바로 그 모양이다) — 잡는 것은 **`T6·T8`처럼 붙여 쓴 열거**뿐이다.
    if (/T6\s*[·,]\s*T8|T6\s*(?:과|와)\s*T8/.test(ln) && /못 막는|실패 재현|아직 통과함|두 건/.test(ln))
      bad(`${f} 「${label}」 ${k + 1}번째 줄이 T6·T8 을 함께 「아직 못 막는 시험」이라 한다 — 지금 그건 T8 하나다`);
  });
}
ok(`현재 상태 구간 ${CURRENT_REGIONS.length}곳 — 낡은 drain·구현·lease·T6 서술 0건`);

// ── 15. 문서 전체에서 「drain 미구현」과 정리 대상 개수 ────────────────────
//
// 검사 14 는 **현재 상태 구간**만 본다. 그런데 같은 거짓이 구간 밖에도 흩어져 있었다(2026-08-18
// 실측 4곳): §10-9 비교표의 「금지(전역 drain 미구현)」 · 위협 38 의 「6가지 대상」 ·
// §13-6 결론의 「T6·T8 두 건」 · §14 배포 체크리스트 18번의 「전역 drain 미구현 상태에서는」.
// 앞의 셋은 구간 밖이라 검사 14 가 못 잡았다. 그래서 이 둘만 **문서 전체**에서 본다 —
// 넓게 보는 대신 **문구를 아주 좁게** 잡아 정상 서술을 걸지 않는다.
//
// 면제는 검사 14 와 같다: **같은 줄**의 명시적 역사 표식뿐이다(앞뒤 줄로 번지지 않는다).
{
  for (const f of DOCS) {
    R(f).split("\n").forEach((ln, i) => {
      if (HISTORY_MARK.test(ln)) return;
      if (/drain[^\n]{0,8}미구현|미구현[^\n]{0,8}drain/.test(ln))
        bad(`${f}:${i + 1} 「drain 미구현」 — 전역 user-data drain 은 결정 A′ 로 구현됐다. `
          + `복원 금지 사유는 §10-8-0 의 ⑤ 지금 임차증 0건 미확인 · ⑦ 옛 배포 차단 · ⑨ T8 이다`);
    });
  }
  // 정리 대상 개수는 **코드에서 읽는다.** 문서에 적은 숫자와 `JOBS` 의 길이가 어긋나면 실패한다 —
  // 사람이 양쪽을 기억해야 맞는 숫자는 언젠가 어긋난다.
  const jobs = (R("worker/cleanup/index.js").match(/^\s*\["[a-z_]+",\s*"(?:DB|LEDGER)"/gm) || []).length;
  if (jobs !== 4) bad(`worker/cleanup/index.js 의 정리 대상이 ${jobs}개다 — 문서의 「삭제 대상 4개」와 어긋난다`);
  const s3t = R(STAGE3);
  if (!s3t.includes("**삭제 대상 4개**")) {
    bad(`${STAGE3} 가 정리 Worker 의 「삭제 대상 4개」를 말하지 않는다 — pending 집계는 삭제가 아니다`);
  }
  for (const m of s3t.matchAll(/^.*?(\d)가지 대상.*$/gm)) {
    if (HISTORY_MARK.test(m[0])) continue;
    bad(`${STAGE3} 「${m[1]}가지 대상」 — 정리 Worker 는 **삭제 대상 4개 + pending 경보 집계 1개**다. `
      + `해제된 lease 는 대상이 아니다(해제가 행 DELETE 라 남은 행은 전부 진행 중이거나 stale)`);
  }
}
ok("drain 미구현 서술 0건 · 정리 대상 개수가 코드(JOBS 4개)와 일치");

console.log(fails
  ? `test-docs: 실패 ${fails}건`
  : "test-docs: 통과 — 낡은 문구 · 죽은 § 참조 · 번호 연속성 · 선언된 개수 · 판 번호 · 필수 절 · 완료 범위 · 보유기간 단정 · 스위트 수 · 낡은 운영 상태 · 단계 상태 일치 · 주 D1 접근 분류 등재 · 법률 자료 현재 사실 · 인수인계 현재성 · 현재 상태 구간의 낡은 drain·구현·lease·T6 서술 · drain 미구현 0건 · 정리 대상 개수 = 코드");
process.exit(fails ? 1 : 0);
