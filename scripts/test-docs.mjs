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
// ⚠️ **`docs/OPS_RUNBOOK.md` 가 2026-08-22 까지 이 목록에 없었다.** 원격 작업의 절차 원본인데
//    낡은 문구·죽은 § 참조·원격 반영 과장 어느 검사도 그 파일을 읽지 않았다 — 실제로
//    「원격은 아무것도 하지 않았다」가 배포 뒤에도 그대로 남아 있었고 test-docs 는 통과했다.
const DOCS = [STAGE3, PACKET, STAGE2, "CLAUDE.md", "docs/HANDOFF.md",
              "docs/SECURITY_RELEASE_CHECKLIST.md", "docs/OPS_RUNBOOK.md", "privacy.html"];

for (const f of DOCS) if (!existsSync(new URL("../" + f, import.meta.url))) { bad(`파일 없음: ${f}`); }
if (fails) { console.error("test-docs: 실패"); process.exit(1); }

// ── 현재 production 배포는 **한 곳에서 파생한다** (2026-08-24) ─────────────
// 재현: 배포 ID `19e69dee` 가 검사 코드 다섯 자리에 손으로 박혀 있었고, 2026-08-24 에 새 배포를
// 올리자 그 다섯이 **한꺼번에 낡았다** — 검사가 「지금 라이브」가 아니라 「그날 라이브」를 강제한다.
// 배포 ID 는 계산해서 알 수 없으니, **원본을 한 곳으로 정하고** 나머지는 거기서 읽는다:
// `CLAUDE.md` 의 「현재 라이브」 블록이다. 다음 배포에서는 그 한 줄만 고치면 된다.
const LIVE = (() => {
  const m = R("CLAUDE.md").match(/-\s*\*\*배포 `([0-9a-f]{8})`\*\*\s*—\s*Production[^\n]*source\s*\*\*`([0-9a-f]{7,40})`\*\*/);
  if (!m) { bad("CLAUDE.md 「현재 라이브」에서 production 배포 ID·source 를 못 읽었다 — 그 줄의 모양이 바뀌었다"); return null; }
  // preview 도 같은 블록이 원본이다 — 현재 상태 블록이 옛 preview 를 적으면 검사 29 가 잡는다.
  const pv = R("CLAUDE.md").match(/preview 는 \*\*`([0-9a-f]{8})`\*\*/);
  return { deploy: m[1], source: m[2], preview: pv ? pv[1] : null };
})();
if (!LIVE) { console.error("test-docs: 실패"); process.exit(1); }
const RE_LIVE = new RegExp(LIVE.deploy);

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
  // 9판(2026-08-22 남용 방어 재감사)이 뒤집은 문장들. 넷 다 **8판이 검토를 통과시킨** 표현이다.
  ["D1 이 탈 일이 없다", "공개 `/ready` 는 방어와 무관하게 두 DB 를 조회한다 (위협 56)"],
  ["엣지가 센다", "버킷별 한도의 집행자는 우리 카운터 하나다 (위협 53)"],
  ["분산 공격을 막", "IP 별 리미터도 엣지 카운터도 분산 요청에는 부분 방어다 (위협 54)"],
  ["바인딩이 있으면 열린", "「있다」가 아니라 「부를 수 있고 답이 boolean 이다」가 조건이다 (위협 52)"],
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
const EDITION = 11;
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
  [STAGE3, ["## 0-5.", "## 0-6.", "## 0-7.", "## 0-8.", "## 0-9.", "### 12-2.", "### 12-3.",
            "### 5-3-5.", "### 5-4.", "### 10-5-2.", "#### ⛔ 10-6-0.",
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
// ⚠️ **두 어순을 다 본다**(2026-08-22). 전에는 「N개 스위트」만 봐서 「스위트 N개」는 그냥
//    지나갔다 — 실제로 그 형태로 적힌 문장이 문서 여러 곳에 있었다.
// ⚠️ **과거 서술은 면제한다.** 「그 돌연변이가 스위트 25개를 전부 통과했다」는 **그때의 사실**이고
//    지금 개수로 고치면 오히려 거짓이 된다. 현재 주장만 잰다.
const SUITE_RE = /(?:(\d+)\s*개\s*스위트|스위트\s*\*{0,2}(\d+)\s*개)/g;
// ⚠️ 과거인지 현재인지는 **한국어 과거 어미**로 가른다 — 「…를 전부 통과했다」는 그때의 사실이고
//    「…를 전부 통과한다」는 지금의 주장이다. 낱말 목록을 늘리는 대신 어미를 본다(목록은 낡는다).
// ⚠️ 강조 기호(`**`·백틱)를 떼고 본다. 「전부 통과**했다」처럼 사이에 끼면 낱말이 끊긴다.
// ⚠️ **앞뒤 한 줄까지 창으로 본다.** 표가 아닌 본문은 줄바꿈이 문장 가운데 오므로,
//    한 줄만 보면 「스위트 23개가\n… 통과하는 상태에서 나왔다」의 뒤쪽을 놓친다.
// ⚠️ `HIST` 는 아래에서 선언되므로 여기서 참조하지 않는다(TDZ).
const PAST_ENDING = /(됐|렀|났|했|였|았|었|졌|갔|왔|쟀|뒀|봤|났|섰)다|당시|그때|역사 기록|⛔/;
const plain = (t) => t.replace(/[*`]/g, "");
for (const f of DOCS) {
  const lines = R(f).split("\n");
  lines.forEach((ln, i) => {
    const window = plain(lines.slice(Math.max(0, i - 1), i + 2).join(" "));
    if (PAST_ENDING.test(window)) return;
    for (const m of plain(ln).matchAll(SUITE_RE)) {
      const got = +(m[1] ?? m[2]);
      if (got !== SUITES)
        bad(`${f}:${i + 1} "${m[0]}" 라고 적혀 있는데 실제는 ${SUITES}개 (package.json)`);
    }
  });
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
  // ⚠️ **판 번호를 손으로 적지 않는다.** `EDITION` 하나를 올리면 두 문서가 같이 실패한다 —
  //    8판까지는 여기 숫자가 박혀 있어서, 설계서만 올리고 CLAUDE.md 를 안 고쳐도 통과했다.
  [3, [new RegExp(`${EDITION}판`), /완료/, /결정/],
   // ⚠️ `미완료` 를 따로 막는다 — `/완료/` 는 **「미완료」 안에서도 참**이라 그것만 요구하면
   //    「미완료」라고 적힌 행이 조용히 통과한다.
   [/3단계[^|]*미착수/, /미완료/, new RegExp(`${EDITION - 1}판(으로)? 완료`)],
   `3단계는 ${EDITION}판 완료이고, 그 완료는 사용자 결정 0~7 에 기대고 있다`],
  // 4단계는 **로컬만** 끝났다. 「구현 완료」가 「출시 가능」으로 읽히지 않게 두 사실을 함께 요구한다.
  // ⚠️ **2026-08-22 에 「배포 0건」을 요구하지 않게 바꿨다.** 그날 안전 동기화 배포(`19e69dee`)와
  //    옛 배포 15개 삭제가 실제로 실행됐기 때문이다 — 검사가 낡은 사실을 **강제하고** 있었다.
  //    대신 두 가지를 **갈라서** 요구한다: ① 안전 동기화는 실행됐다 ② 계정 인프라는 미실행이다.
  //    한쪽만 적으면 다음 사람이 「배포됐으니 계정도 열렸겠지」 또는 그 반대로 읽는다.
  [4, [/로컬 구현 완료/, RE_LIVE, /계정 인프라는? (하나도 )?(안|미)/, /남용 방어|envelope|사람 확인/],
   [/미착수/, /코드 0줄/, /출시 완료/, /원격 미반영\.|원격 반영 0건/],
   "4단계는 로컬 구현 완료 · 안전 동기화 배포는 실행 · 계정 인프라는 미실행이다"],
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
  // ⚠️ **자리가 셋이 됐다**(2026-08-22 · 위협 52·56). 엣지 사전 거름이 게이트보다 앞이고,
  //    게이트가 우리 카운터보다 앞이고, 카운터가 임차증보다 앞이다. 하나라도 뒤집히면
  //    「막힌 요청이 DB 를 만진다」가 되살아난다.
  {
    const idx = strip(R("worker/index.js"));
    const edge = idx.indexOf("await edgeVerdict(env, req,");
    const gate = idx.indexOf("gate = await readMode(env)");
    const rl = idx.indexOf("await countVerdict(env, req, rt.bucket)");
    const lease = idx.indexOf("await acquireLease(env, LEASE_MODES_REQUEST)");
    if (edge < 0 || gate < 0 || rl < 0 || lease < 0)
      bad("worker/index.js 에서 엣지 거름·게이트·리미터·임차증 자리를 못 찾았다 — 검사기가 낡았다");
    else {
      if (edge > gate) bad("worker/index.js 의 엣지 사전 거름이 게이트보다 뒤에 있다 — 고장 난 바인딩의 503 이 ledger 를 읽는다 (위협 52)");
      // ⚠️ **이 줄이 없었다**(2026-08-22 에 더했다). 주석은 셋의 순서를 말하면서 실제로는 둘만
      //    쟀다 — 게이트와 카운터가 뒤집혀도 아무 검사가 실패하지 않았다. 그 상태에서는
      //    유지보수로 전환한 뒤에도 카운터가 계속 쓴다(위협 49 가 닫은 자리).
      if (gate > rl) bad("worker/index.js 의 유지보수 게이트가 리미터보다 뒤에 있다 — 닫힌 뒤에도 카운터가 쓴다 (위협 49)");
      if (rl > lease) bad("worker/index.js 의 리미터가 임차증보다 뒤에 있다 — 막힌 요청도 ledger 에 쓴다 (위협 47)");
    }
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

// ── 16. 2단계 결정서의 「현재 상태」가 따로 낡지 않았나 ────────────────────
//
// 재현(2026-08-20): `STAGE2` 는 검사 7의 `NOW_FILES` 에도, 검사 14의 `CURRENT_REGIONS` 에도
// 없었다. 그래서 4단계가 로컬로 끝나고 설계서가 7판이 된 뒤에도 이 문서는 **「3단계 6판 ·
// 4단계 미착수 · 회원가입 코드가 한 줄도 없다 · 엣지 캐시 내부 파일 7개 미해결」**을 현재
// 사실로 말하고 있었고, **test-docs 는 통과했다.** 결정서는 다음 사람이 「지금 무엇이
// 확정됐나」를 보러 오는 문서라, 여기가 낡으면 결정 자체가 낡은 것으로 읽힌다.
//
// 면제는 검사 14·15 와 같다 — **같은 줄**의 명시적 역사 표식뿐이다.
{
  const t2 = R(STAGE2);
  const i = t2.indexOf(NOW0), j = t2.indexOf(NOW1);
  if (i < 0 || j < i) bad(`${STAGE2} 에 현재상태 블록이 없다 — 상단 갈래표가 언제 낡았는지 알 수 없다`);
  else {
    const now = t2.slice(i, j);
    // 상단 갈래표는 **설계서의 현재 판**과 4단계의 실제 상태를 말해야 한다.
    if (!new RegExp(`${EDITION}판`).test(now))
      bad(`${STAGE2} 상단 갈래표가 설계서 ${EDITION}판을 말하지 않는다`);
    // ⚠️ **줄 단위로 본다.** 표 한 칸을 `[^|\n]*` 로 이으려 하면 셀 경계(`|`)가 끊어서
    //    「4단계 구현 | **미착수**」 같은 실제 회귀를 그대로 통과시킨다(돌연변이 M9 로 확인).
    for (const ln of now.split("\n")) {
      if (!/4단계|구현/.test(ln)) continue;
      for (const [re, why] of [
        [/미착수|착수하지 않았다|착수 조건 충족 후/, "4단계는 2026-08-18 에 착수해 로컬로 끝났다"],
        [/코드가 한 줄도 없다|코드 0줄/, "4단계 코드는 저장소에 있다"],
      ]) if (re.test(ln)) bad(`${STAGE2} 현재상태 블록 — ${why}\n      "${ln.trim().slice(0, 90)}"`);
    }
    // 「끝났다」만 적고 남은 것을 안 적으면 그것도 거짓이다.
    // ⚠️ **2026-08-22 에 「원격 반영 0건」에서 바꿨다** — 그날 안전 동기화 배포가 실제로 됐다.
    //    지금 요구하는 것은 **계정 인프라가 미실행이라는 사실**이다(그게 「출시 안 됨」의 근거다).
    for (const [re, what] of [
      [/계정 인프라는? (하나도 )?(안|미)|계정 인프라 미실행|계정 인프라는 미실행/, "계정 인프라가 미실행이라는 사실"],
      [/No-Go/, "출시 판정"],
    ]) if (!re.test(now)) bad(`${STAGE2} 현재상태 블록에 ${what} 가 없다`);
  }
  // §17(출시 No-Go 조건)·§20(최종 판정)은 블록 밖이라 따로 본다. 이미 닫힌 항목을
  // ❌ 로 남겨 두면 「아직 남았다」로 읽혀 다음 사람이 같은 일을 또 한다.
  const sec = (from, to) => t2.slice(t2.indexOf(from), t2.indexOf(to));
  const s17 = sec("## 17. 공개 출시 No-Go 조건", "## 18. ");
  for (const [re, why] of [
    [/privacy\.html 불일치 8건[^|\n]*\|\s*❌/, "privacy.html 불일치 8건은 2026-08-18 에 해소됐다"],
    [/엣지 캐시 내부 파일 7개[^|\n]*\|\s*❌/, "옛 엣지 캐시 7개는 2026-08-19 실측으로 닫혔다"],
  ]) if (re.test(s17)) bad(`${STAGE2} §17 — ${why}`);
  // 엣지 남용 방어는 **반대로** 열려 있어야 한다(위협 50). 닫힌 것으로 적으면 그게 거짓이다.
  if (!/남용 방어/.test(s17)) bad(`${STAGE2} §17 에 엣지 남용 방어 항목이 없다 — 계정 라우트가 그 때문에 닫혀 있다`);
  const s20 = sec("## 20. 최종 판정", "## 21. ");
  s20.split("\n").forEach((ln) => {
    if (HISTORY_MARK.test(ln) || /⛔/.test(ln)) return;
    if (/(\d+)판/.test(ln) && +/(\d+)판/.exec(ln)[1] < EDITION)
      bad(`${STAGE2} §20 이 낡은 판(${/(\d+)판/.exec(ln)[1]}판)을 현재 설계서로 말한다 — 지금은 ${EDITION}판이다`);
    if (/4단계[^\n]*(미착수|조건이 채워진 뒤에 시작)/.test(ln))
      bad(`${STAGE2} §20 이 4단계를 아직 시작 전이라고 말한다 — 로컬 구현은 끝났다`);
  });
}
ok("2단계 결정서 — 상단 갈래표 · §17 · §20 이 현재 사실과 일치");

// ── 17. 2026-08-22 재검증 이후의 「지금 사실」 아홉 가지 ────────────────────
//
// 왜 아홉을 따로 재나: 이 날 하루에 **원격 상태가 두 번 바뀌었고**(안전 동기화 배포 · 옛 배포
// 15개 삭제) **로컬 코드도 바뀌었는데 그것만 배포하지 않았다.** 셋을 한 문장으로 요약하면
// 반드시 한쪽이 거짓이 된다 — 「배포했다」로 읽으면 계정이 열린 줄 알고, 「아무것도 안 했다」로
// 읽으면 옛 배포가 남아 있는 줄 안다. 그래서 **아홉을 각각** 요구한다.
//
// ⚠️ 각 항목은 **어느 문서든 한 곳에만** 있으면 된다. 같은 사실을 모든 문서에 복사시키면
//    다음 사람이 한 곳만 고치고 나머지를 낡게 만든다.
{
  const all = DOCS.map((f) => [f, R(f)]);
  const anywhere = (re) => all.some(([, t]) => re.test(t));
  const NINE = [
    [new RegExp(`배포\\s*\`?${LIVE.deploy}\`?`), `① 안전 동기화 배포(${LIVE.deploy})가 실행됐다는 기록`],
    [/ledger D1 (미생성|을 만들지)|계정 인프라는? (하나도 )?(안|미)/,
     "② 계정 인프라(ledger D1·0005·시크릿·정리 Worker)는 원격 미실행이라는 사실"],
    [/8e16c92e/, "③ 옛 배포 폐쇄 결과 — 남은 preview(8e16c92e)"],
    [/위협 57~60|T73~T76/, "④ 공식 4단계 전체 재검증 결과(위협 57~60 · T73~T76)"],
    [new RegExp(`source\\s*\\*?\\*?\`${LIVE.source}\``),
     `⑤ 배포된 source 가 무엇인지(${LIVE.source})`],
    [/2026년 9월/, "⑥ 도메인·WAF 의 예정 시점(2026년 9월)"],
    [/공개 출시 No-Go[^\n]{0,20}폐쇄 베타 No-Go|폐쇄 베타 No-Go/,
     "⑦ 공개 출시와 폐쇄 베타가 모두 No-Go 라는 판정"],
    [/legacy KV 삭제는? (여기서 )?제외|KV 삭제[^\n]{0,20}제외/,
     "⑧ legacy KV 삭제는 이번 범위에서 제외라는 사실"],
    [/테스트가 전부 통과하는 것은 출시 승인이 아니다|개수(와 문서 일치)?는? 완료의 근거가 아니다/,
     "⑨ 테스트 통과가 출시 승인이 아니라는 문장"],
  ];
  for (const [re, what] of NINE) if (!anywhere(re)) bad(`문서 어디에도 ${what} 가 없다`);

  // ⛔ 반대 방향도 막는다 — 이번에 실행한 것을 「안 했다」고 적으면 다음 사람이 옛 배포가
  //    남아 있는 줄 알고 같은 일을 또 한다. 역사 표식이 같은 줄에 있으면 면제다.
  for (const [f, t] of all) {
    t.split("\n").forEach((ln, i) => {
      if (HIST.test(ln)) return;
      for (const [re, why] of [
        [/원격은 아무것도 (하지 않았다|안 했다)/, "안전 동기화 배포와 옛 배포 삭제는 실행됐다"],
        [/옛 배포[^\n]{0,20}(그대로 남|지우지 않았다|삭제 0건)/, "옛 배포 15개는 2026-08-22 에 지웠다"],
      ]) if (re.test(ln)) bad(`${f}:${i + 1} — ${why}\n      "${ln.trim().slice(0, 90)}"`);
    });
  }

  // 그리고 **「지웠다」를 「닫혔다」로 바꿔 적지 않았나.**
  // ⚠️ **2026-08-23 에 기준이 바뀌었다.** 그전에는 「아직 401 이다」를 요구했는데, 그날
  //    프리뷰 액세스로 15개가 전부 302 → Access 가 됐다. 그렇다고 **404 가 된 것은 아니다** —
  //    배포는 여전히 존재하고 Access 뒤에서 실행될 수 있으며, 끄면 다시 401 이다.
  //    그래서 요구를 「아직 답한다」에서 **「404 가 아니다」**로 옮긴다. 이건 Access 를 켜든
  //    끄든 참이고, 「지웠으니 사라졌다」는 오독만 정확히 막는다.
  if (!anywhere(/404\s*(가|는)?\s*아니|404\s*가 아니다|삭제[^\n]{0,40}(계속 답|여전히|아직 닫히지)/))
    bad("옛 배포 주소가 **404 가 아니라는** 사실이 문서 어디에도 없다 — 「지웠다 = 사라졌다」로 읽힌다");
}
ok("2026-08-22 이후의 현재 사실 9종 · 반대 방향 서술 0건");

// ── 18. **모순** — 같은 자리에서 서로 어긋나는 두 서술 (2026-08-22 · 독립 검토) ──
//
// 검사 17 은 「이 문장이 있나」를 봤다. 그것만으로는 부족하다 — **있어야 할 문장과 있으면 안 되는
// 문장이 같은 구간에 함께 있어도** 통과하기 때문이다. 실제로 그런 상태가 있었다:
// 「A안 확정」과 「무엇을 붙일지 사용자 결정 대기」가 같은 문서에 나란히 있었다.
// 여기서는 **짝**을 본다.
{
  const all = DOCS.map((f) => [f, R(f)]);
  const nowBlock = (t) => {
    const i = t.indexOf(NOW0), j = t.indexOf(NOW1);
    return i >= 0 && j > i ? t.slice(i, j) : null;
  };

  // ① **엣지 방어는 A안으로 이미 결정됐다**(사용자 결정 1 · 2026-08-22). 그러므로 현재 상태
  //    구간에 「무엇을 붙일지 대기」류가 남아 있으면 그 자체가 거짓이다 — 「확정」과 나란히
  //    있는지와 무관하게 막는다(둘 다 지워 버리는 회귀도 아래 ①-b 가 잡는다).
  //    ⚠️ 「…가 아니다」로 정정하는 문장은 면제한다(규칙을 적는 것이 벌이 되면 안 된다).
  const PENDING_RE = /무엇을 붙일지[^\n]{0,20}(사용자 )?결정 대기|A·B·C 중[^\n]{0,10}대기|선택 대기|어느 것을 붙일지[^\n]{0,10}대기/;
  for (const [f, t] of all) {
    const now = nowBlock(t);
    if (!now) continue;
    now.split("\n").forEach((ln) => {
      if (!PENDING_RE.test(ln)) return;
      if (/가 아니다|아니다\.|정정/.test(ln)) return;
      bad(`${f} 현재 상태에 「선택 대기」가 남아 있다 — 엣지 방어는 A안으로 확정됐다\n      "${ln.trim().slice(0, 90)}"`);
    });
  }
  // ①-b **반대 방향.** 결정 자체가 문서 어디에도 없으면 그것도 낡은 상태다.
  if (!all.some(([, t]) => /A안[^\n]{0,30}(확정|결정)/.test(t)))
    bad("엣지 방어가 A안으로 확정됐다는 사실이 문서 어디에도 없다");

  // ② 「원격 0건」류와 「실제 배포 완료」가 **둘 다 현재형**으로 있으면 안 된다.
  for (const [f, t] of all) {
    t.split("\n").forEach((ln, i) => {
      if (HIST.test(ln) || /(됐|했|였|았|었)다/.test(ln)) return;
      if (/원격 (반영 )?0건|배포 0건|원격은 아무것도/.test(ln) && (RE_LIVE.test(ln) || /8e16c92e/.test(ln)))
        bad(`${f}:${i + 1} 같은 줄이 「원격 0건」과 실제 배포를 함께 말한다\n      "${ln.trim().slice(0, 90)}"`);
    });
  }

  // ③ 「옛 배포 폐쇄/차단 완료」와 「삭제한 주소가 아직 응답」이 함께 있으면 안 된다.
  //    ⛔ **제어면 삭제와 공개 URL 폐쇄는 다른 사건이다.** 같은 완료 표시로 합치면
  //       다음 사람이 「끝났다」로 읽고 재측정을 건너뛴다.
  {
    // 「아직 열려 있다」의 형태는 시점에 따라 둘이다 — 401 로 답하거나(Access 끄기 전),
    // Access 로 막혔지만 **404 는 아니거나**(지금). 둘 중 하나는 반드시 적혀 있어야 한다.
    const stillUp = all.some(([, t]) =>
      /(삭제[^\n]{0,40}(계속 답|여전히|아직 닫히지)|「지웠다」(를)? 「닫혔다」|공개 URL 폐쇄[^\n]{0,10}(미완료|❌)|404\s*(가|는)?\s*아니)/.test(t));
    // ⚠️ **앞뒤 한 줄까지 창으로 본다.** 「…를 아직 쓰지 않는다 —」 다음 줄에 금지 표현을
    //    나열하는 문장이 실제로 있었다. 한 줄만 보면 그 나열을 주장으로 읽는다.
    for (const [f, t] of all) {
      const lines = t.split("\n");
      lines.forEach((ln, i) => {
        if (HIST.test(ln)) return;
        // ⚠️ **「」 안에 인용된 것은 주장이 아니다.** 「다음 표현을 아직 쓰지 않는다 —
        //    「옛 배포 폐쇄 완료」…」 처럼 **금지 표현을 나열하는 문장**이 실제로 있다.
        //    창(window)으로 면제하면 진짜 회귀까지 같이 빠져나가므로(돌연변이 C3 로 확인),
        //    인용 부호를 직접 본다.
        // 인용(「…」) 안은 **주장이 아니라 인용**이므로 통째로 떼고 본다.
        const said = ln.replace(/「[^」]*」/g, "");
        const m = /옛 배포[^\n]{0,20}(폐쇄|차단)\s*완료|조건 ⑦[^\n]{0,10}충족/.exec(said);
        if (!m) return;
        // ⚠️ **부정은 그 주장 바로 옆에 있어야 면제다.** 줄 전체에서 「아니」를 찾으면
        //    같은 줄 다른 문장의 부정이 진짜 회귀를 덮는다(돌연변이 C3 로 확인).
        const near = said.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
        if (/아니|미충족|미완료|않는다|못|안 /.test(near)) return;
        bad(`${f}:${i + 1} 「옛 배포 폐쇄/차단 완료」라고 말한다 — 삭제한 주소가 아직 응답 중이다\n      "${ln.trim().slice(0, 90)}"`);
      });
    }
    if (!stillUp)
      bad("삭제한 배포 주소의 현재 상태(아직 401 인가 · Access 로 막혔지만 404 는 아닌가)를 말하는 문장이 어디에도 없다");
  }

  // ④ **판이 올랐는데 공식 범위가 낡은 T 번호로 끝나면 안 된다.**
  //    설계서의 최대 T 번호를 원본으로 삼아, 현재 상태 구간이 그보다 작은 범위를 말하는지 본다.
  {
    const maxT2 = Math.max(...[...R(STAGE3).matchAll(/\bT(\d+)\b/g)].map((m) => +m[1]));
    for (const [f, t] of all) {
      const now = nowBlock(t);
      if (!now) continue;
      for (const m of now.matchAll(/T1~T(\d+)/g)) {
        if (+m[1] !== maxT2)
          bad(`${f} 현재 상태가 공식 범위를 "${m[0]}" 라고 말한다 — 설계서의 최대는 T${maxT2} 다`);
      }
    }
  }

  // ⑤ 제어면 삭제와 공개 URL 폐쇄가 **같은 문장에서 하나의 완료**로 합쳐지지 않았나.
  for (const [f, t] of all) {
    const lines = t.split("\n");
    lines.forEach((ln, i) => {
      if (HIST.test(ln)) return;
      const deleted = /15개[^\n]{0,10}삭제|deployment delete|제어면[^\n]{0,10}삭제/.test(ln);
      const closed = /(폐쇄|차단)\s*(완료|됐다)|404 가 됐다/.test(ln);
      // 같은 규칙 — 부정은 **주장 근처**에 있어야 면제다.
      const cm = /(폐쇄|차단)\s*(완료|됐다)|404 가 됐다/.exec(ln);
      const cnear = cm ? ln.slice(Math.max(0, cm.index - 20), cm.index + cm[0].length + 20) : "";
      if (deleted && closed && !/아직|미완료|아니|❌|않는다/.test(cnear))
        bad(`${f}:${i + 1} 제어면 삭제와 공개 URL 폐쇄를 하나의 완료로 합쳤다\n      "${ln.trim().slice(0, 90)}"`);
    });
  }
}
ok("모순 5종 — 「확정 vs 대기」 · 「0건 vs 배포」 · 「폐쇄 완료 vs 응답 중」 · 낡은 T 범위 · 삭제≠폐쇄");

// ── 19. **운영현황** — 「지금」이라고 말하는 자리의 원격 실측값이 낡지 않았나 ──────
//
// 재현(2026-08-22 후속): 검사 7·14·17·18 이 전부 통과하는 상태에서 `docs/HANDOFF.md` §2
// 「지금 서 있는 자리」 표가 **여섯 가지를 낡은 채로** 말하고 있었다 —
// production 시크릿 「두 개」(`READY_KEY` 가 빠졌다) · 원격 migration 「적용 대기 0건」
// (`0005` 가 대기 중이다) · 라이브 `f72f5225`(지금은 `19e69dee`) · `rate_limits` 5행 ·
// 새 시크릿 「3개」 · preview 시크릿을 production 목록에서 **추정**한 서술.
// **왜 못 잡았나**: 검사 14 의 `CURRENT_REGIONS` 는 HANDOFF 에서 §0 과 §4-1~4-7 만 봤고,
// 검사 7 의 `현재상태` 블록은 §0 안에 있다. §2 는 **둘 사이에 끼여 어느 검사에도 안 걸렸다.**
// 같은 날 `SECURITY_RELEASE_CHECKLIST.md` 의 「**옛 공개 배포 폐쇄** … 완료」도 통과했다 —
// 검사 18-③ 의 정규식이 `옛 배포` 를 **붙여 쓴 형태로만** 찾았고(「옛 **공개** 배포」를 놓쳤다),
// `폐쇄` 와 `완료` 사이의 `** | **` 를 `\s*` 로 이을 수 없었다.
//
// 고친 방법 두 가지:
//   ① **범위를 넓힌다.** 「현재상태」·「운영현황」 블록에 더해, **제목이 「지금」·「현재」라고
//      말하는 절**을 전부 현재 구간으로 본다. 자동검사 대상이 되거나, 줄마다 명시적 역사
//      표식을 달거나 둘 중 하나다 — 「검사 밖에 있는 현재 서술」이 없어진다.
//   ② **값을 파생시킨다.** 판 번호는 `EDITION`, T 범위·위협 범위·결함 합계는 설계서,
//      옛 배포 해시는 HANDOFF 의 삭제 목록에서 읽는다. 손으로 적은 숫자는 반드시 낡는다.
{
  const OPS0 = "<!-- 운영현황:시작 -->", OPS1 = "<!-- 운영현황:끝 -->";

  // 파생값 — 문서가 아니라 **원본**에서 읽는다.
  const s3 = R(STAGE3);
  const maxT3 = Math.max(...[...s3.matchAll(/\bT(\d+)\b/g)].map((m) => +m[1]));
  // 위협 모델 표의 행 번호(`| **63** |`)가 위협 번호의 원본이다.
  const maxThreat = Math.max(...[...s3.matchAll(/^\|\s*\*\*(\d+)\*\*\s*\|/gm)].map((m) => +m[1]));
  // 재감사 결함은 위협 39 부터 이어져 있다(6판 §0-6 이 39 에서 시작한다).
  const FIRST_REAUDIT_THREAT = 39;
  const defects = maxThreat - FIRST_REAUDIT_THREAT + 1;
  // 6판부터 판마다 완료 판정이 한 번씩 철회됐다 — 「n 판 연속」의 원본은 `EDITION` 이다.
  const streak = EDITION - 5;

  // 지운 배포 해시 목록도 문서가 아니라 **HANDOFF 의 삭제 기록**에서 읽는다.
  const handoffT = R("docs/HANDOFF.md");
  const delBlock = /\*\*삭제한 15개\*\*:([\s\S]{0,400}?)\n\n/.exec(handoffT);
  const DELETED = delBlock ? [...delBlock[1].matchAll(/`([0-9a-f]{8})`/g)].map((m) => m[1]) : [];
  if (DELETED.length !== 15)
    bad(`HANDOFF 의 「삭제한 15개」 목록에서 해시 ${DELETED.length}개를 읽었다 — 15개여야 한다`);

  // ── 19-a. 현재를 말하는 구간을 **전부** 모은다 ──────────────────────────
  // 표식 블록 + 제목이 「지금·현재」인 절. 어느 쪽에도 안 들어가는 현재 서술이 없어야 한다.
  const scopes = [];   // [파일, 라벨, 텍스트]
  const blockOf = (t, a, b) => {
    const i = t.indexOf(a); if (i < 0) return null;
    const j = t.indexOf(b, i + 1); return j > i ? t.slice(i, j) : null;
  };
  for (const f of DOCS) {
    const t = R(f);
    for (const [a, b, lab] of [[NOW0, NOW1, "현재상태 블록"], [OPS0, OPS1, "운영현황 블록"]]) {
      const s = blockOf(t, a, b);
      if (s) scopes.push([f, lab, s]);
    }
    // 제목이 스스로 「지금·현재」라고 말하는 절. 다음 같은 깊이 이상의 제목까지가 그 절이다.
    const lines = t.split("\n");
    lines.forEach((ln, i) => {
      const h = /^(#{2,4})\s+(.*(?:지금|현재).*)$/.exec(ln);
      if (!h) return;
      if (HIST.test(h[2])) return;                       // 제목이 스스로 역사라고 밝힌 절
      let end = lines.length;
      for (let k = i + 1; k < lines.length; k++) {
        const h2 = /^(#{1,4})\s/.exec(lines[k]);
        if (h2 && h2[1].length <= h[1].length) { end = k; break; }
      }
      const body = lines.slice(i, end).join("\n");
      // 운영 사실을 말하지 않는 절(설계 서술·금지 규칙 등)은 대상이 아니다.
      if (!/배포|시크릿|secret|migration|pages\.dev|D1 (생성|목록)/.test(body)) return;
      scopes.push([f, `「${h[2].slice(0, 34)}」 절`, body]);
    });
  }
  if (!scopes.some(([f, lab]) => f === "docs/HANDOFF.md" && lab === "운영현황 블록"))
    bad(`docs/HANDOFF.md 에 운영현황 블록(${OPS0})이 없다 — 원격 실측값의 원본이 사라졌다`);

  // ── 19-b. 그 구간들이 낡은 원격 사실을 말하지 않는가 ────────────────────
  //
  // 면제는 셋뿐이고 전부 **줄 안에서 스스로 밝힌 것**이다(앞뒤 줄로 번지지 않는다):
  //   · 「당시 사실」·「역사 기록」 — 그 줄이 스스로 과거라고 밝힌 경우
  //
  // ⛔ **여기서는 `HIST` 를 쓰지 않는다.** `HIST` 에는 ⛔ 가 들어 있는데, 이 저장소는 ⛔ 를
  //    「위험·차단」 강조로 문서 전체에서 쓴다 — 역사 표식이 아니다. 실제로 운영현황의
  //    시크릿 행이 「⛔ 아직 없는 값 5개」라고 적고 있어서, 그 한 글자가 **같은 행의 현재
  //    서술까지 통째로 면제**시켰다(돌연변이 D03 이 그 상태로 살아남았다).
  //   · **닫힌 체크리스트 행**(`| ~~P0~~ ✅ |`) — 취소선이 곧 「이건 지난 항목이다」라는 표식이다
  //   · 인용(「…」) — 금지 문구를 **나열하는** 문장은 주장이 아니다
  // 취소선은 표의 첫 칸에도, 번호 칸 다음에도 온다(`| ~~18~~ …` · `| 7 | ~~…~~ ✅ |`).
  const HIST_ONLY = /당시 사실|역사 기록/;
  const CLOSED_ROW = /^\s*\|(\s*[^|]{0,16}\|)?\s*~~/;
  for (const [f, lab, text] of scopes) {
    const marked = (ln) => HIST_ONLY.test(ln) || CLOSED_ROW.test(ln);
    text.split("\n").forEach((raw) => {
      if (marked(raw)) return;
      const ln = raw.replace(/「[^」]*」/g, "");
      const say = (why) => bad(`${f} ${lab} 이 낡은 운영 사실을 말한다 — ${why}\n      "${raw.trim().slice(0, 100)}"`);

      // ① 지운 배포를 **현재 라이브**라고 말하면 안 된다.
      //    ⚠️ 「…가 라이브에서 403 이었다」처럼 라이브라는 말이 다른 뜻으로 쓰인 줄이 있다.
      //       그래서 **주장과 해시가 서로 60자 안에 붙어 있을 때만** 잡는다. 60 인 이유는
      //       「| **라이브 (production)** | **배포 `<해시>`**」 한 칸이 그만큼 길기 때문이다 —
      //       30자로 뒀더니 바로 그 행의 돌연변이 D01 이 살아남았다. 반대쪽 오탐인
      //       「배포 `774015e9` … 가 라이브에서 403」은 둘 사이가 90자라 안 걸린다.
      for (const c of ln.matchAll(/라이브|현재 production|현재 배포|지금 (도는|올라간)/g)) {
        const near = ln.slice(Math.max(0, c.index - 60), c.index + 60);
        for (const h of DELETED)
          if (near.includes(h)) say(`\`${h}\` 는 2026-08-22 에 지운 배포다. 현재 production 은 \`${LIVE.deploy}\` 다`);
      }

      // ② 원격 migration 「대기 0건」. 저장소에 `0005` 가 있고 문서가 미적용이라고 말하는 한 거짓이다.
      if (/(적용\s*)?대기\s*\*{0,2}\s*0\s*건/.test(ln)) say("원격 `0005` 가 적용 대기 중이다(대기 0건이 아니다)");

      // ③ production 시크릿을 「두 개」라고 세거나 `READY_KEY` 를 빼면 안 된다.
      if (/시크릿[^\n]{0,24}\(?production\)?|production[^\n]{0,24}시크릿/.test(ln)) {
        if (/(두 개|2개|둘뿐|두개)/.test(ln)) say("production 시크릿은 `READY_KEY`·`RL_KEY`·`STATE_KEY` 세 개다");
        if (/등록|목록|있다/.test(ln) && !/READY_KEY/.test(ln))
          say("production 시크릿 목록에 `READY_KEY` 가 없다(2026-08-22 등록됨)");
      }
    });

    // ── 판 번호 · T 범위 · 위협 범위 · 결함 합계 · 연속 판수 ──────────────
    // ⚠️ **줄이 아니라 구간 전체로 본다.** 이 넷은 한 문장이 두 줄에 걸쳐 있는 일이 잦아서
    //    (실제로 「결함 25건을 / 차례로 재현했다」가 그렇다) 줄 단위로 재면 놓친다.
    //    대신 **주장 문형을 아주 좁게** 잡아 서술형 문장을 걸지 않는다.
    const prose = text.split("\n").filter((ln) => !marked(ln)).join(" ").replace(/「[^」]*」/g, "");
    const sayS = (why) => bad(`${f} ${lab} 이 낡은 운영 사실을 말한다 — ${why}`);

    // ④ 「설계 N판 완료」가 현재 판정으로 쓰였는가. **더 높은 판을 같이 말하면 서술형**이라 넘어간다.
    const maxSaid = Math.max(0, ...[...prose.matchAll(/(\d+)판/g)].map((m) => +m[1]));
    for (const m of prose.matchAll(/설계\s*\*{0,2}(\d+)판\s*\*{0,2}\s*완료/g))
      if (+m[1] < EDITION && maxSaid < EDITION)
        sayS(`설계서는 ${EDITION}판이다 — "${m[0]}" 는 낡았다`);

    // ⑤ 공식 테스트 명세의 범위.
    for (const m of prose.matchAll(/(?:명세|범위|테스트)[^.。]{0,24}T1~T(\d+)|T1~T(\d+)[^.。]{0,16}(?:명세|구현 매핑)/g)) {
      const v = +(m[1] ?? m[2]);
      if (v !== maxT3) sayS(`테스트 명세의 최대는 T${maxT3} 다 — "T1~T${v}" 는 낡았다`);
    }
    // ⑥ 재감사 위협 범위.
    for (const m of prose.matchAll(/위협\s*\*{0,2}39~(\d+)/g))
      if (+m[1] !== maxThreat) sayS(`위협 번호의 최대는 ${maxThreat} 이다 — "${m[0]}" 는 낡았다`);
    // ⑦ 재감사 결함 **합계**. 판별 문형은 「차례로 재현」과 「4+5+…건」 둘뿐이다.
    for (const m of prose.matchAll(/결함\s*\*{0,2}(\d+)\s*\*{0,2}건을?\s*\*{0,2}\s*차례로 재현/g))
      if (+m[1] !== defects) sayS(`재감사 결함 합계는 ${defects}건이다(위협 ${FIRST_REAUDIT_THREAT}~${maxThreat}) — "${m[1]}건" 는 낡았다`);
    for (const m of prose.matchAll(/결함\s*((?:\d\+)+\d)건/g)) {
      const sum = m[1].split("+").reduce((a, b) => a + +b, 0);
      if (sum !== defects) sayS(`재감사 결함 합계는 ${defects}건인데 "${m[0]}" 는 ${sum}건이다`);
    }
    // ⑧ 완료 판정이 철회된 판수. 6판부터 이어졌으므로 `EDITION` 에서 파생한다.
    const W = { 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
    for (const m of prose.matchAll(/([가-힣]+|\d+)\s*판\s*연속/g)) {
      const v = W[m[1]] ?? (/^\d+$/.test(m[1]) ? +m[1] : null);
      if (v !== null && v !== streak)
        sayS(`완료 판정이 철회된 것은 6판부터 ${EDITION}판까지 ${streak}판 연속이다 — "${m[0].trim()}" 는 낡았다`);
    }
  }

  // ── 19-c. **제어면 삭제 ≠ 공개 URL 폐쇄.** 두 사실이 서로 다른 줄에 있어야 한다 ──
  // ⚠️ 검사 18-③·⑤ 를 여기서 **넓힌다.** 저기는 `옛 배포` 를 붙여 쓴 형태만 찾았고
  //    `폐쇄`·`완료` 사이의 `** | **` 를 넘지 못했다 — 「**옛 공개 배포 폐쇄** | **완료」가
  //    그대로 통과했다. 수식어와 강조·표 구분자를 넘어서 본다.
  const CLOSED_CLAIM = /옛[^\n]{0,12}배포[^\n]{0,24}(폐쇄|차단)[\s*|:—·-]{0,10}(완료|됐다|끝났다)/;
  for (const f of DOCS) {
    R(f).split("\n").forEach((ln, i) => {
      const said = ln.replace(/「[^」]*」/g, "");         // 인용은 주장이 아니다
      const m = CLOSED_CLAIM.exec(said);
      if (!m) return;
      // ⚠️ **면제는 전부 「주장 바로 옆」에서만 본다**(2026-08-23). 전에는 시점 표식과 ⛔ 를
      //    **줄 전체**에서 찾아 면제했는데, 체크리스트 18번처럼 긴 표 행은 머리에 현재형 판정을
      //    적고 꼬리에 「당시 실측」을 함께 담는다 — 꼬리 하나가 머리의 거짓을 덮었고,
      //    돌연변이 D05 가 그렇게 살아남았다(실측 2회). ⛔ 도 같은 이유로 쓰지 않는다:
      //    경고 기호가 한 번이라도 나오면 줄이 통째로 빠져나갔다.
      const near = said.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
      if (/아니|미완료|미충족|않는다|못|안 |부분|제어면|당시|역사 기록/.test(near)) return;
      bad(`${f}:${i + 1} 「옛 공개 배포 폐쇄 완료」라고 말한다 — 제어면에서만 지웠고 공개 URL 은 아직 401 이다\n      "${ln.trim().slice(0, 100)}"`);
    });
  }
  // 두 사실이 **각각** 있어야 한다. 하나로 합치면 다음 사람이 재측정을 건너뛴다.
  {
    const ops = blockOf(handoffT, OPS0, OPS1) || "";
    const rows = ops.split("\n");
    // ⛔ **세 사건이다**(2026-08-23 확장): ① 제어면 삭제 ② 공개 접근 차단(Access) ③ 404.
    //    ①은 2026-08-22, ②는 2026-08-23 에 됐고 **③은 아직이다.** 어느 둘도 한 행에 합치지 않는다 —
    //    합치는 순간 다음 사람이 「끝났다」로 읽고 재측정을 건너뛴다.
    const ctlRow = rows.find((r) => /제어면/.test(r) && /삭제/.test(r) && /(✅|완료)/.test(r));
    const accRow = rows.find((r) => /공개 (URL|접근)/.test(r) && /Access/.test(r));
    if (!ctlRow) bad("HANDOFF 운영현황에 「옛 배포 — 제어면 삭제 완료」 행이 없다");
    if (!accRow) bad("HANDOFF 운영현황에 「옛 배포 — 공개 접근을 Access 로 차단」 행이 없다");
    if (accRow && !/404\s*(가|는)?\s*아니/.test(accRow))
      bad("HANDOFF 운영현황의 공개 접근 행이 **404 가 아니라는** 사실을 말하지 않는다 — Access 차단을 삭제로 오독하게 된다");
    if (accRow && !/가역|되돌|끄면/.test(accRow))
      bad("HANDOFF 운영현황의 공개 접근 행이 **가역적이라는** 사실을 말하지 않는다 — 끄면 다시 401 이다");
    if (ctlRow && accRow && ctlRow === accRow)
      bad("HANDOFF 운영현황이 제어면 삭제와 공개 접근 차단을 **한 행**에 합쳤다 — 다른 사건이므로 행을 나눈다");
  }

  // ── 19-d. 운영현황 블록이 반드시 담아야 할 실측 사실 ──────────────────────
  {
    const ops = blockOf(handoffT, OPS0, OPS1) || "";
    for (const [re, what] of [
      [/READY_KEY/, "production 시크릿 목록의 `READY_KEY`"],
      [/`?0005[^\n]{0,60}(대기|미적용)/, "원격 `0005` 가 적용 대기라는 사실"],
      [RE_LIVE, "현재 production 배포"],
      [/preview[^\n]{0,60}0개|0개[^\n]{0,60}preview/, "preview 시크릿이 0개라는 **직접 조회** 결과"],
      [/KST/, "원격을 언제 쟀는지(측정 시각)"],
      [/Access/, "옛 배포의 공개 접근을 무엇으로 막았는지(Cloudflare Access)"],
    ]) if (!re.test(ops)) bad(`HANDOFF 운영현황 블록에 ${what} 가 없다`);
    if (handoffT.indexOf(OPS0) !== handoffT.lastIndexOf(OPS0))
      bad("docs/HANDOFF.md 에 운영현황 블록이 둘 이상이다 — 현재 운영 상태의 원본은 하나여야 한다");
  }
}

// ── 19-e. 「Access 로 막았다」를 「404 가 됐다 / 삭제됐다」로 승격하지 않았나 ──────
// 2026-08-23 의 실측은 **302 → Access** 이지 404 가 아니다. 그 둘을 같게 적으면
// 복원 금지 해제 조건 ⑦ 이 저절로 충족된 것처럼 읽힌다 — 그건 별도 검토 대상이다.
{
  const HIST_ONLY2 = /당시 사실|역사 기록/;
  for (const f of DOCS) {
    R(f).split("\n").forEach((ln, i) => {
      if (HIST_ONLY2.test(ln) || /^\s*\|(\s*[^|]{0,16}\|)?\s*~~/.test(ln)) return;
      const said = ln.replace(/「[^」]*」/g, "");
      const m = /옛[^\n]{0,14}배포[^\n]{0,40}(404\s*(가|로)?\s*(됐|된|바뀌)|사라졌|없어졌)/.exec(said);
      if (!m) return;
      const near = said.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24);
      if (/아니|않|못|은 아직|미충족/.test(near)) return;
      bad(`${f}:${i + 1} 옛 배포가 404 가 됐다고 말한다 — 실측은 302 → Access 다(배포는 남아 있다)\n      "${ln.trim().slice(0, 100)}"`);
    });
  }
  // 반대 방향 — 조건 ⑦ 이 Access 하나로 충족됐다고 적으면 안 된다.
  for (const f of DOCS) {
    R(f).split("\n").forEach((ln, i) => {
      if (HIST_ONLY2.test(ln)) return;
      // ⚠️ **인용(「…」)은 주장이 아니다.** 금지 표현을 **나열하는** 문장이 실제로 있다
      //    (「옛 배포 폐쇄 완료」·「복원 금지 조건 ⑦ 충족」을 쓰지 않는다고 적은 줄).
      const claim = ln.replace(/「[^」]*」/g, "");
      // 「⑦ 충족과도 **다르다**」처럼 **구별하는** 문장은 주장이 아니다 — 오히려 규칙을 적는 쪽이다.
      if (/조건 ⑦[^\n]{0,30}(충족|닫혔)/.test(claim) && !/미충족|아니|별도|않|다르다|같지 않/.test(claim))
        bad(`${f}:${i + 1} 복원 금지 해제 조건 ⑦ 이 충족됐다고 말한다 — Access 차단은 D1~D12 증명이 아니다`);
    });
  }
}
ok("운영현황 — 낡은 서술 0건 · 제어면 삭제 ≠ 공개 접근 차단 ≠ 404 · 조건 ⑦ 과장 0건");

// ── 20. **날짜가 붙은 운영 기록 절** 중 옛 것이 현재형 판정을 계속 주장하지 않나 ──────
//
// 재현(2026-08-23): `docs/HANDOFF.md` 의 `## 2026-08-22 (2) 운영 반영 기록` 절이
// 「그러므로 **지금 사실**은 공개 URL 폐쇄 ❌ 미완료」·「**다음 단계는** Cloudflare 지원 문의가
// 필요하다」를 그대로 들고 있었다. 그런데 문서 맨 앞에는 **더 최신인 2026-08-23 Access 기록**이
// 있고 거기서는 15개가 302 로 막혔다. 두 절이 서로 다른 「지금」을 말한 것이다.
//
// **왜 기존 검사가 못 잡았나**: 검사 19-b 는 「제목이 지금·현재라고 말하는 절」과 마커 블록만
// 본다. `## 2026-08-22 (2) 운영 반영 기록 …` 이라는 제목에는 그 말이 없어서 범위 밖이었다.
// 게다가 검사 17·18 은 그때 **「삭제한 주소가 아직 답한다」는 문장이 있을 것을 요구**하고
// 있었으므로, 낡은 현재형 문장이 오히려 통과 조건을 채워 주고 있었다.
//
// 고친 방법: **날짜 제목 자체를 순서로 쓴다.** 같은 문서 안에서 `## <YYYY-MM-DD> … 운영 반영 기록`
// 을 모두 모아 가장 최신 날짜를 찾고, **그보다 오래된 절**에서는 현재형 운영 판정을 금지한다.
// 면제는 그 절이 스스로 「당시」라고 밝힌 경우뿐이다.
{
  const DATED = /^##\s+(\d{4})-(\d{2})-(\d{2})[^\n]*운영 반영 기록/;
  for (const f of DOCS) {
    const lines = R(f).split("\n");
    const secs = [];
    lines.forEach((ln, i) => {
      const m = DATED.exec(ln);
      if (m) secs.push({ date: `${m[1]}-${m[2]}-${m[3]}`, start: i, title: ln.trim() });
    });
    if (secs.length < 2) continue;                       // 비교할 것이 없으면 대상이 아니다
    secs.forEach((s, k) => { s.end = k + 1 < secs.length ? secs[k + 1].start : lines.length; });
    const newest = secs.reduce((a, b) => (a.date >= b.date ? a : b)).date;

    // 현재형 **운영 판정**만 잡는다. 절차 설명·명령어·과거 서술은 대상이 아니다.
    const PRESENT_VERDICT = [
      [/그러므로\s*지금 사실은|지금 사실은\s*\*\*/, "「지금 사실은 …」"],
      [/다음 단계는[^\n]{0,40}(필요하다|이다)/, "「다음 단계는 … 필요하다」"],
      [/현재 (상태|판정)은[^\n]{0,30}(이다|다)\b/, "「현재 상태는 …」"],
    ];
    for (const s of secs) {
      if (s.date === newest) continue;                   // 가장 최신 절은 현재형이어도 된다
      for (let i = s.start; i < s.end; i++) {
        const ln = lines[i];
        // 그 줄이나 절 제목이 스스로 「당시」라고 밝히면 면제다.
        if (/당시|그날|역사 기록|그때의 기록/.test(ln)) continue;
        for (const [re, what] of PRESENT_VERDICT) {
          if (!re.test(ln)) continue;
          bad(`${f}:${i + 1} ${s.date} 절이 ${what} 라는 **현재형 운영 판정**을 한다 — `
            + `이 문서에는 더 최신인 ${newest} 운영 기록이 있다. 옛 절은 「당시 판정」으로 적고 `
            + `현재 상태는 최신 절로 넘긴다\n      "${ln.trim().slice(0, 90)}"`);
        }
      }
    }
    // 반대 방향 — 옛 절이 「당시」라고 밝히는 문장을 통째로 지워도 안 된다(왜 그렇게 판단했는지가 사라진다).
    const oldest = secs.reduce((a, b) => (a.date <= b.date ? a : b));
    if (!lines.slice(oldest.start, oldest.end).some((ln) => /당시|그날|역사 기록|그때의 기록/.test(ln)))
      bad(`${f} 의 ${oldest.date} 운영 기록 절에 「당시」 표식이 하나도 없다 — 옛 절이 현재로 읽힌다`);
  }
}
ok("날짜별 운영 기록 — 옛 절의 현재형 판정 0건 · 당시 표식 보존");

// ── 21. 움직이는 커밋 해시를 현재 상태 표에 **고정**하지 않았나 ──────────────
//
// 재현(2026-08-23): 운영현황의 「미배포 로컬 커밋」 행이 `156fd8a`·`41455b6`·`8628e14` 를
// **「최신 세 커밋」**이라고 적고 있었다. 그 뒤로 커밋이 셋 더 쌓여서 이미 낡았는데
// 어떤 검사도 보지 않았다.
//
// ⚠️ **특정 해시 하나를 금지하지 않는다.** 그러면 다음 해시로 바꿔 적는 순간 또 통과한다.
//    금지하는 것은 **「최신/최근 커밋」이라는 말과 커밋 해시가 같은 줄에 있는 것** 자체다.
//    배포된 지점(`7477867` 같은 **고정된 운영 사실**)은 그 말과 붙지 않으므로 통과한다.
// ⚠️ **Git 을 조회하지 않는다.** 메타데이터 없는 archive 에서도 돌아야 하므로,
//    「문서에 움직이는 해시를 적지 않는다」는 **문서 내부 불변식**으로만 만든다.
{
  const OPS0 = "<!-- 현재상태:시작 -->", OPS1 = "<!-- 현재상태:끝 -->";
  const OPSA = "<!-- 운영현황:시작 -->", OPSB = "<!-- 운영현황:끝 -->";
  const MOVING = /(최신|최근|현재)\s*(\S{0,4}\s*)?커밋/;
  const HASH = /`[0-9a-f]{7,40}`/;
  for (const f of DOCS) {
    const txt = R(f);
    for (const [a, b] of [[OPS0, OPS1], [OPSA, OPSB]]) {
      const i = txt.indexOf(a), j = txt.indexOf(b, i + 1);
      if (i < 0 || j < 0) continue;
      txt.slice(i, j).split("\n").forEach((ln) => {
        if (/당시 사실|역사 기록/.test(ln)) return;
        // ⚠️ **근접해야 잡는다.** 「최신 로컬 커밋은 배포하지 않았다 … 라이브는 `<배포ID>` 다」처럼
        //    같은 줄 멀리에 **배포 지점**이 적힌 것은 고정이 아니다(실측 오탐 1건).
        //    잡으려는 것은 해시가 **그 말의 대상으로 바로 제시된** 모양이다 — 「최신 세 커밋(`abc1234`…)」.
        const mv = MOVING.exec(ln);
        if (!mv) return;
        const near = ln.slice(mv.index, mv.index + mv[0].length + 30);
        // 「…를 **적지 않는다**」류의 규칙 문장은 주장이 아니다. ⚠️ **부정은 그 말 바로 옆에
        //    있어야 면제다** — 줄 전체에서 찾으면 같은 줄 다른 문장의 부정이 진짜 회귀를 덮는다
        //    (돌연변이 D13 이 정확히 그렇게 살아남았다: 첫 문장만 고쳐도 뒤의 규칙 문장이 면제시켰다).
        if (/적지 않는다|고정하지 않|쓰지 않는다|묻는다/.test(near)) return;
        if (HASH.test(near))
          bad(`${f} 현재 상태 표가 움직이는 커밋 해시를 「${mv[0]}」으로 고정했다 — `
            + `HEAD 는 커밋마다 움직이므로 손으로 유지하면 반드시 낡는다. `
            + `고정된 운영 사실(배포된 source)만 적고 현재 HEAD 는 git 에게 묻는다\n      "${ln.trim().slice(0, 90)}"`);
      });
    }
  }
}
ok("현재 상태 표 — 움직이는 커밋 해시 고정 0건");

// ── 25. **Access 기록이 있으면 현재 상태가 「아직 401」이라고 말할 수 없다** (2026-08-23) ──
//
// ⛔ **왜 이 검사가 필요했나 — 검사 방법의 공백이다.** 위 검사 ③ 은 「삭제한 주소가 아직
//    응답 중」이라는 문장이 **어디엔가 하나 있으면**(`stillUp`) 통과시켰고, 그 갈래에
//    `공개 URL 폐쇄[^\n]{0,10}(미완료|❌)` 를 **허용 형태로 넣어 뒀다.** 그래서 2026-08-23 에
//    프리뷰 액세스로 15개를 전부 302 로 막은 뒤에도 `docs/OPS_RUNBOOK.md` §0 과
//    `docs/SECURITY_RELEASE_CHECKLIST.md` 하단이 **「아직 401 이다 · 공개 URL 폐쇄 미완료」**를
//    현재형으로 말했고, `npm test` 는 통과했다 — 그 낡은 문장이 오히려 검사를 **만족시키고**
//    있었다. 검사가 「둘 중 하나」를 받는 한, 낡은 쪽이 정답 자리를 차지한다.
//
// 그래서 **최신 사실을 기준으로 갈라 잰다**: Access 기록이 있으면 허용 형태는
// **「404 가 아니다」 하나뿐**이고, 「아직 401」·「폐쇄 현재 미완료」는 **현재 상태 구간에서
// 금지**된다. ⚠️ **역사 기록은 건드리지 않는다** — 「당시 사실」·「역사 기록」·⛔ 표식이 붙은
// 줄과 현재 상태 구간 밖은 그대로 통과한다(옛 401 실측은 반드시 보존돼야 한다).
{
  const all = DOCS.map((f) => [f, R(f)]);
  // Access 가 실제로 적용됐다는 기록. 세 조각이 다 있어야 한다 — 「하려고 한다」와 구분한다.
  const accessApplied = all.some(([, t]) =>
    /프리뷰 액세스|Preview Access/.test(t) && /cloudflareaccess\.com/.test(t) && /302/.test(t));

  if (accessApplied) {
    // ① 현재 상태 구간에서 「지금도 401」·「폐쇄가 지금 미완료」라고 말하지 않는다.
    //    같은 뜻의 다른 문장도 잡도록 **의미 단위**로 적는다(한 문장 하드코딩이 아니다).
    const STALE = [
      [/공개 URL[^\n]{0,12}폐쇄[^\n]{0,12}(미완료|❌|아직|안 됐|되지 않)/, "「공개 URL 폐쇄가 지금 미완료」"],
      [/폐쇄[^\n]{0,10}(미완료|❌)/, "「폐쇄 미완료」"],
      [/(옛|지운|삭제한)[^\n]{0,20}(배포|주소|해시)[^\n]{0,30}(아직|여전히|계속)[^\n]{0,20}401/, "「옛 배포가 아직 401」"],
      [/(아직|여전히|계속)[^\n]{0,16}401[^\n]{0,16}(로 )?(답한다|응답한다|남아 있다)/, "「아직 401 로 답한다」"],
    ];
    for (const [f, t] of all) {
      const i = t.indexOf(NOW0), j = t.indexOf(NOW1);
      const now = i >= 0 && j > i ? t.slice(i, j) : null;
      if (!now) continue;
      now.split("\n").forEach((ln, k) => {
        if (HIST.test(ln) || HISTORY_MARK.test(ln)) return;   // 역사 서술은 면제
        for (const [re, what] of STALE) {
          if (!re.test(ln)) continue;
          bad(`${f} 현재 상태가 ${what} 이라고 말한다 — 2026-08-23 프리뷰 액세스로 `
            + `옛 15개는 전부 302(Access) 다. 옛 401 실측은 「당시 사실」로 남기고 `
            + `현재형 판정만 고친다\n      "${ln.trim().slice(0, 90)}"`);
          break;
        }
      });
    }
    // ② 그렇다고 **404·삭제로 승격해서도 안 된다.** 허용 형태가 실제로 있어야 한다.
    if (!all.some(([, t]) => /404\s*(가|는)?\s*아니/.test(t)))
      bad("Access 로 막았다는 기록은 있는데 「404 가 아니다」가 어디에도 없다 — 「막았다 = 사라졌다」로 읽힌다");
    if (!all.some(([, t]) => /가역적|끄면[^\n]{0,20}401/.test(t)))
      bad("Access 차단이 **가역적**이라는 사실이 어디에도 없다 — 끄면 그 자리에서 다시 401 이다");
    // ③ **옛 401 실측은 지워지면 안 된다.** 「당시」 표식과 함께 남아 있어야 한다.
    const kept = all.some(([, t]) => t.split("\n").some((ln) =>
      HISTORY_MARK.test(ln) && /401/.test(ln)));
    if (!kept)
      bad("2026-08-22 의 401 실측이 「당시」 표식과 함께 남아 있지 않다 — 기록은 고치는 것이 아니라 시점을 붙이는 것이다");
  }
}
ok("Access 기록 이후 — 현재형 「아직 401」 0건 · 404 승격 0건 · 옛 401 실측 보존");

// ── 26. **돌연변이 개수는 `MUTATIONS` 에서 파생한다** (2026-08-23) ──────────
//
// ⛔ 재현: `CLAUDE.md` 와 체크리스트가 「22종 · 사망 22」라고 적고 있었는데 실제 목록은
//    **35종(동작 22 · 정적 13)** 이었다. 「22종」이 전체인지 동작 검사만인지 문장만으로는
//    알 수 없었고, 어느 검사도 그 숫자를 목록과 대조하지 않았다.
// 그래서 **손으로 적은 총수를 금지하지 않되, 적었으면 목록과 같아야 한다.**
// ⚠️ 동작 검사만 말할 때는 반드시 **「동작」이라고 명시**해야 한다 — 정적 검사가 아무리
//    촘촘해도 런타임 방어를 증명하지 못한다(그 착각이 이 저장소가 겪은 사고의 모양이다).
{
  const { MUTATIONS } = await import("./mutations.mjs");
  const total = MUTATIONS.length;
  const behave = MUTATIONS.filter((m) => (m.kind || "동작") === "동작").length;
  const statik = total - behave;
  const counts = { total, behave, statik };
  for (const [f, t] of DOCS.map((f) => [f, R(f)])) {
    t.split("\n").forEach((ln, i) => {
      // ⚠️ **`HIST` 를 쓰지 않는다.** 거기엔 ⛔ 가 들어 있어서, 경고 기호가 붙은 줄이면
      //    무엇이든 면제됐다 — 실제로 체크리스트 23번이 ⛔ 한 글자로 빠져나가 돌연변이 D15 가
      //    살아남았다. 여기서 면제할 것은 **시점 표식이 붙은 역사 서술**뿐이다.
      if (HISTORY_MARK.test(ln)) return;
      if (!/돌연변이|mutate\.mjs|mutations\.mjs/.test(ln)) return;
      // ⚠️ **「N종」을 아무 데서나 세지 않는다.** 같은 줄의 「잔여 위험 6종」이나 옛 보고서를
      //    인용한 「34종 중 33종 사망」까지 잡으면 검사가 못 쓰게 된다(실측 오탐 9건).
      //    **현재값을 주장하는 정해진 문형에서만** 센다 — 그래서 문서는 이 형태로 적어야 한다.
      for (const m of ln.matchAll(
        /(?:목록\s*|현재\s*|총\s*|합계\s*)(\d+)\s*종|(동작|정적)\s*(?:검사\s*)?(\d+)\s*종/g)) {
        const n = +(m[1] ?? m[3]);
        const kind = m[1] ? "total" : (m[2] === "동작" ? "behave" : "statik");
        if (n !== counts[kind])
          bad(`${f}:${i + 1} 돌연변이 개수를 「${m[0].trim()}」이라고 적었다 — `
            + `scripts/mutations.mjs 의 실제는 총 ${total}종(동작 ${behave} · 정적 ${statik}) 이다\n`
            + `      "${ln.trim().slice(0, 90)}"`);
      }
    });
  }
}
ok("돌연변이 개수 — 문서의 주장이 MUTATIONS 목록과 일치");

// ── 27. **미배포 범위를 말하는 줄의 위협 범위는 최신까지여야 한다** (2026-08-23 신설) ──
//
// 재현: 위협 64 를 닫은 뒤에도 세 곳이 「위협 57~63 의 수정은 로컬에만 있다」로 남아 있었다
// (`CLAUDE.md` 는 57~60 이었다). 검사 4 는 **선언된 개수**(「위협 65건」)만 보고, 검사 19-b·25 는
// 이 문장들을 현재 상태 구간 밖에서 만난다 — 그래서 셋 다 통과했다.
//
// **왜 이 규칙이 파생 가능한가**: 「그 뒤 로컬 커밋은 전부 미배포다」는 **끝이 열린 주장**이다.
// 배포된 source 이후에 닫은 위협은 전부 미배포이므로, 그 범위의 끝은 **언제나 최신 위협 번호**여야
// 한다. 그러니 숫자를 하드코딩하지 않고 위협 표에서 뽑은 `maxTh` 와 대조한다.
//
// ⚠️ **일부러 좁다.** 「미배포·로컬에만」을 말하는 줄에서만 본다 — 특정 감사 회차를 가리키는
//    범위(「위협 43~47 을 닫았다」)는 그 회차의 사실이라 바뀌면 안 된다.
{
  // 「그 뒤는 전부 미배포다」와 「그 수정이 배포본에 들어 있다」는 **같은 모양의 주장**이다 —
  // 둘 다 배포 지점과 지금 사이의 **열린 구간**을 가리키므로 끝은 언제나 최신 위협 번호다.
  const SPAN = /미배포|로컬에만|배포하지 않았다|배포된 source|여기 들어 있다/;
  for (const f of DOCS) {
    R(f).split("\n").forEach((ln, i) => {
      if (!SPAN.test(ln)) return;
      for (const m of ln.matchAll(/위협\s*\*{0,2}(\d+)~(\d+)\*{0,2}/g)) {
        // ⚠️ **면제는 주장 바로 옆에서만 본다**(2026-08-24). 줄 전체에서 찾았더니, 머리에
        //    현재형 판정을 담고 꼬리에 「당시 …」를 단 긴 표 행이 통째로 빠져나갔다 —
        //    체크리스트 20번이 배포 뒤에도 「배포하지 않았다」를 현재형으로 달고 통과했다.
        //    검사 19-c 에서 이미 한 번 고친 무늬를 여기서 되풀이했다.
        const near = ln.slice(Math.max(0, m.index - 70), m.index + 70);
        if (HISTORY_MARK.test(near)) continue;
        if (+m[2] !== maxTh)
          bad(`${f}:${i + 1} 배포 경계 범위를 「${m[0].trim()}」이라고 적었다 — `
            + `배포 지점 이후를 가리키는 주장이면 끝은 최신 위협 번호 ${maxTh} 여야 한다\n`
            + `      "${ln.trim().slice(0, 90)}"`);
      }
    });
  }
}
ok(`배포 경계 범위의 위협 끝번호 == ${maxTh}`);

// ── 28. **매핑 절의 「N건 전부 연결됐다」는 실제 최대 T 번호와 같아야 한다** (2026-08-24 신설) ──
//
// 재현: §13-6 이 T81 까지 행을 갖고 있는데 바로 아래 요약이 「**79건** 전부 실행 가능한 단언으로
// 연결됐다」로 남아 있었다. T80·T81 을 더하면서 표만 늘리고 합계 문장을 안 고쳤다.
//
// **왜 검사 4 가 놓쳤나**: 저기는 `테스트\s*(?:명세\s*)?(\d+)\s*건` 을 찾는다. 이 문장은
// 「79건」으로 **바로 시작**해서 그 문형에 안 걸린다. 개수를 말하는 방식이 하나 더 있었던 것이다.
//
// ⚠️ **숫자를 여기 적지 않는다.** 기준은 문서에서 뽑은 `maxT` 다 — 그래야 T 를 더하는 사람이
//    이 검사를 따로 기억하지 않아도 된다. 범위도 **매핑 절 안**으로 좁힌다(다른 절의 「N건」은
//    회차별 결함 수처럼 다른 것을 센다).
{
  const mapStart = s3.indexOf("### 13-6.");
  if (mapStart < 0) bad(`${STAGE3} §13-6 매핑 절을 못 찾았다 — 검사기가 낡았다`);
  else {
    const rest = s3.slice(mapStart + 1);
    const nextHead = rest.search(/\n#{2,3} /);
    const sec = nextHead < 0 ? rest : rest.slice(0, nextHead);
    const claims = [...sec.matchAll(/(\d+)\s*건\s*전부[^\n]*?연결/g)];
    if (!claims.length)
      bad(`${STAGE3} §13-6 에 「N건 전부 … 연결」 요약이 없다 — 문장을 지웠거나 검사기가 낡았다`);
    for (const m of claims) {
      if (+m[1] !== maxT)
        bad(`${STAGE3} §13-6 이 「${m[0].trim()}」이라고 적었다 — 매핑 표의 최대는 T${maxT} 다`);
    }
  }
}
ok(`§13-6 매핑 합계 == T${maxT}`);

// ── 29. **현재 상태 블록의 배포 ID·source 는 「현재 라이브」와 같아야 한다** (2026-08-24 신설) ──
//
// 재현: 2026-08-24 에 production 이 `7362d2f0`(source `e02e810`)로 바뀐 뒤에도 현재 상태
// 블록 **네 곳**이 안전 동기화를 여전히 `19e69dee`(source `7477867`)라고 적고 있었다 —
// 체크리스트 5번·14번, `docs/HANDOFF.md` 단계 현황 4단계 행, 설계서 §현재 상태.
//
// **왜 기존 검사가 못 잡았나**: 검사 7 의 `STALE_NOW`·`NOW_MUST` 는 **문구**만 보고 배포 ID 는
// 안 봤다. 검사 21(운영현황)은 `docs/HANDOFF.md` §2 만 봤고, 다른 문서의 현재 상태 블록은
// 아무도 배포 ID 로 대조하지 않았다. 날짜가 옆에 있으면 사람 눈에도 「그때 기록」처럼 보인다.
//
// **면제는 날짜가 아니라 말로 받는다.** 「2026-08-22 완료」 같은 날짜는 옛 배포를 현재 사실처럼
// 적어도 붙는다 — 실제로 그렇게 통과했다. 그래서 **당시·직전·롤백·옛·역사** 중 하나가
// 주장 바로 옆(±80자)에 있어야 옛 배포 ID 를 허용한다.
{
  // ⚠️ **「옛」 한 글자를 면제 표식으로 쓰지 않는다**(2026-08-24 · 첫 시도의 실수).
  //    「옛 배포 **15개 삭제**」가 옆줄에 흔해서, 그 한 단어가 낡은 배포 ID 를 통째로
  //    빠져나가게 했다 — `docs/HANDOFF.md` 단계 현황과 설계서 §현재 상태가 그렇게 통과했다.
  const PAST = /당시|직전|롤백|역사|그날|옛 (?:위험 )?세대/;
  const live = new Set([LIVE.deploy, LIVE.source, LIVE.preview].filter(Boolean));
  for (const f of [...NOW_FILES, "docs/OPS_RUNBOOK.md"]) {
    const t = R(f);
    const i = t.indexOf(NOW0), j = t.indexOf(NOW1);
    if (i < 0 || j < i) continue;            // 블록 부재는 검사 7 이 이미 말한다
    const now = t.slice(i, j);
    const line0 = t.slice(0, i).split("\n").length;
    for (const m of now.matchAll(/`([0-9a-f]{7,8})`/g)) {
      if (live.has(m[1])) continue;
      const near = now.slice(Math.max(0, m.index - 80), m.index + 80);
      if (PAST.test(near)) continue;
      bad(`${f}:~${line0 + now.slice(0, m.index).split("\n").length - 1} 현재 상태 블록이 `
        + `배포·source \`${m[1]}\` 를 현재 사실처럼 적었다 — 지금 라이브는 `
        + `${LIVE.deploy}(source ${LIVE.source})다. 옛 배포는 **당시·직전·롤백** 맥락에서만 적는다\n`
        + `      "…${near.replace(/\n/g, " ").trim().slice(0, 110)}…"`);
    }
  }
}
ok(`현재 상태 블록의 배포 ID == 현재 라이브 ${LIVE.deploy}`);

// ── 30. **「로컬 완료 · 배포 안 함」은 배포 뒤에 거짓이다** (2026-08-24 신설) ──
//
// 재현: 위협 57~60 을 고친 네 행이 배포 뒤에도 「**로컬 완료 2026-08-22 · 배포 안 함**」을
// 현재형으로 달고 있었다. 그 수정은 `${LIVE.source}` 에 들어가 production 으로 나갔다.
//
// **왜 검사 27 이 못 잡았나**: 저기는 「위협 N~M」이라는 **범위**를 말하는 줄만 본다.
// 이 네 행은 각자 위협 하나(57·58·59·60)만 가리켜 범위 문형에 안 걸렸다.
//
// **왜 파생 가능한가**: 배포된 source 는 저장소 역사의 한 지점이고, 문서가 「로컬 완료」라고
// 적은 수정은 전부 그 앞이다. 그러니 배포가 한 번이라도 있었다면 「로컬 완료 + 미배포」는
// **당시 기록일 때만** 참이다.
//
// ⚠️ **정리 Worker 는 예외다.** 그것은 Pages 번들이 아니라 **따로 배포하는 Worker** 라
//    Pages 배포로 나가지 않는다 — 지금도 진짜 미배포다.
{
  const LOCAL_DONE = /로컬\s*(?:구현\s*)?(?:수정\s*)?완료|로컬 구현만/;
  const NOT_DEPLOYED = /배포 안 함|배포하지 않음|배포하지 않았다|배포되지 않았|미배포|로컬에만/g;
  const SEPARATE = /정리\s*(?:전용\s*)?(?:Worker|크론)|cleanup/;   // 별도 배포 대상
  for (const f of DOCS) {
    R(f).split("\n").forEach((ln, i) => {
      if (!LOCAL_DONE.test(ln)) return;
      for (const m of ln.matchAll(NOT_DEPLOYED)) {
        const near = ln.slice(Math.max(0, m.index - 80), m.index + 80);
        if (HISTORY_MARK.test(near) || SEPARATE.test(near)) continue;
        bad(`${f}:${i + 1} 「로컬 완료 … ${m[0]}」를 현재형으로 적었다 — 그 수정은 `
          + `${LIVE.source} 로 배포됐다(${LIVE.deploy}). 「당시 사실」로 적거나 배포 사실을 함께 적는다\n`
          + `      "${ln.trim().slice(0, 100)}"`);
      }
    });
  }
}
ok("「로컬 완료 · 미배포」 현재형 서술 0건");

// ── 31. **timing-safe 비교 서술은 현재 구현과 같아야 한다** (2026-08-24 신설) ──
//
// 재현: `worker/index.js` 는 요약 32바이트를 **런타임의 `crypto.subtle.timingSafeEqual()`** 로
// 비교한다(위협 62 · T79). 그런데 문서가 그 앞 단계의 결론 — 「Node 에 없으니 쓰지 않는다」 —
// 를 현재 설명처럼 남기고 있었다. 읽는 사람은 JS XOR 비교가 아직 있다고 믿는다.
//
// **기준은 코드다.** 운영 코드가 그 API 를 실제로 부르는지 여기서 읽어, 부르는 동안에는
// 「쓰지 않는다」는 문장을 금지한다. 되돌리면(다시 안 부르면) 이 검사도 저절로 꺼진다.
{
  const usesTSE = /crypto\.subtle\.timingSafeEqual\s*\(/.test(R("worker/index.js"));
  if (!usesTSE) ok("worker/index.js 가 timingSafeEqual 을 쓰지 않는다 — 서술 검사 생략");
  else {
    const NOT_USED = /쓰지 않는다|안 쓴다|사용하지 않는다|못 쓴다|쓸 수 없다|쓰지 못한다/g;
    for (const f of DOCS) {
      R(f).split("\n").forEach((ln, i) => {
        if (!/timingSafeEqual/.test(ln)) return;
        for (const m of ln.matchAll(NOT_USED)) {
          // ⚠️ **면제는 주장 바로 옆(±80자)에서만 본다**(같은 실수를 세 번째로 고쳤다 —
          //    검사 19-c · 27 과 같은 무늬다). 줄 전체에서 찾았더니, 머리에 「당시 사실」을
          //    단 긴 표 행이 꼬리의 현재형 서술까지 통째로 면제시켜 **D20 이 살아남았다.**
          //    「그때는 안 썼다」는 기록이라 남기고, **판을 밝힌 문장도 기록이다** —
          //    설계서의 위협 표는 「10판은 …라고 적었다」를 그대로 인용한다.
          const near = ln.slice(Math.max(0, m.index - 80), m.index + 80);
          if (HISTORY_MARK.test(near) || /\d+판/.test(near)) continue;
          bad(`${f}:${i + 1} timingSafeEqual 을 「${m[0]}」고 적었다 — `
            + `worker/index.js 는 digest 뒤 crypto.subtle.timingSafeEqual() 을 실제로 부른다\n`
            + `      "…${near.trim().slice(0, 110)}…"`);
        }
      });
    }
    ok("timing-safe 비교 서술 == worker/index.js 구현");
  }
}

console.log(fails
  ? `test-docs: 실패 ${fails}건`
  : "test-docs: 통과 — 낡은 문구 · 죽은 § 참조 · 번호 연속성 · 선언된 개수 · 판 번호 · 필수 절 · 완료 범위 · 보유기간 단정 · 스위트 수 · 낡은 운영 상태 · 단계 상태 일치 · 주 D1 접근 분류 등재 · 법률 자료 현재 사실 · 인수인계 현재성 · 현재 상태 구간의 낡은 drain·구현·lease·T6 서술 · drain 미구현 0건 · 정리 대상 개수 = 코드 · 2단계 결정서 현재성 · 재검증 후 현재 사실 9종 · 모순 5종 · 운영현황 실측값 · 날짜별 운영 기록 · 움직이는 해시 · Access 이후 현재형 401 · 돌연변이 개수=MUTATIONS · 배포 경계 범위의 위협 끝번호 · §13-6 매핑 합계=maxT · 현재 상태 블록의 배포 ID · 「로컬 완료·미배포」 현재형 0건 · timing-safe 서술=구현");
process.exit(fails ? 1 : 0);
