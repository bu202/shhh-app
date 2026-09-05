// 주장 표시 검사 — 사용자 결정에 들어가는 문서의 **사실 문장에 출처 표시가 붙어 있는지**만 본다.
//
// 왜 있나: 2026-09-05 까지 같은 무늬가 반복됐다 — **확인한 것과 그럴듯한 것을 같은 문장으로 쓴다.**
// 출력물에는 둘의 흔적이 안 남아서 다음 사람도 나 자신도 구분할 수 없다. 그 결과가 사용자 결정의
// 근거가 됐고, Codex 가 나중에 뒤집었다(당근 인용 2회 · RFC 가로채기 · 애플 4.2 · 「다리는 이미
// 있다」 · curl→네이티브 일반화).
//
// ⛔ **이 검사는 한국어 문장의 뜻을 판정하지 않는다**(`test-docs` 와 같은 규칙 — 목록은 언제나 늦는다).
//    보는 것은 **구조**뿐이다: 본문의 [id] 와 근거표의 행이 일대일인가, 종류가 셋 중 하나인가,
//    실측 행에 명령·결과가 있는가, 원문 행에 URL·날짜가 있는가, **미확인(U*)이 남아 있지 않은가.**
//
// 쓰는 법: 문서에 아래 블록을 두고 본문에서 `[M1]` 처럼 가리킨다.
//   <!-- claims:start -->
//   | id | 종류 | 주장 | 근거 |
//   |---|---|---|---|
//   | M1 | 실측 | ... | `명령` → 결과 · 2026-09-05 |
//   | S1 | 원문 | ... | https://... · 2026-09-05 |
//   | R1 | 추론 | ... | ... |
//   <!-- claims:end -->
// ⛔ **U 로 시작하는 id(미확인)가 하나라도 남으면 실패다** — 그 상태로 사용자에게 보내지 않는다.
import { readFileSync, readdirSync } from "node:fs";

const KINDS = new Set(["실측", "원문", "추론"]);
const C0 = "<!-- claims:start -->", C1 = "<!-- claims:end -->";
const DATE = /\b20\d{2}-\d{2}-\d{2}\b/;

export function checkClaims(name, text) {
  const out = [];
  const a = text.split(C0).length - 1, b = text.split(C1).length - 1;
  if (a === 0 && b === 0) return out;                      // 표시를 안 쓰는 문서다
  if (a !== 1 || b !== 1) {
    out.push(`${name} claims 마커가 각 1개가 아니다 (start ${a} · end ${b})`);
    return out;
  }
  const i = text.indexOf(C0), j = text.indexOf(C1);
  if (i > j) { out.push(`${name} claims 마커 순서가 뒤집혔다`); return out; }
  const block = text.slice(i + C0.length, j);
  const body = text.slice(0, i) + text.slice(j + C1.length);

  const rows = new Map();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*\|\s*([A-Z]\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (!m) continue;
    const [, id, kind, claim, why] = m;
    if (rows.has(id)) out.push(`${name} 근거표에 id ${id} 가 두 번 있다`);
    rows.set(id, { kind, claim, why });
  }
  if (rows.size === 0) out.push(`${name} 근거표에 행이 하나도 없다 — 표시를 쓰면 표가 있어야 한다`);

  for (const [id, r] of rows) {
    if (id.startsWith("U"))
      out.push(`${name} ${id} 가 **미확인**이다 — 확인하거나 지운 뒤에 사용자에게 보낸다`);
    else if (!KINDS.has(r.kind))
      out.push(`${name} ${id} 의 종류가 「${r.kind}」다 — ${[...KINDS].join("·")} 중 하나여야 한다`);
    if (!r.claim) out.push(`${name} ${id} 에 주장이 비어 있다`);
    if (r.kind === "실측" && !(r.why.includes("`") || r.why.includes("→")))
      out.push(`${name} ${id}(실측)의 근거에 명령이나 결과가 없다 — 무엇을 어떻게 쟀는지 적는다`);
    if (r.kind === "실측" && !DATE.test(r.why))
      out.push(`${name} ${id}(실측)의 근거에 날짜가 없다 — 실측은 잰 날이 곧 유효기간이다`);
    if (r.kind === "원문" && !(/https?:\/\//.test(r.why) && DATE.test(r.why)))
      out.push(`${name} ${id}(원문)의 근거에 URL 과 날짜가 둘 다 있어야 한다`);
  }

  const used = new Set([...body.matchAll(/\[([A-Z]\d+)\]/g)].map((m) => m[1]));
  for (const id of used) if (!rows.has(id)) out.push(`${name} 본문이 [${id}] 를 가리키는데 근거표에 없다`);
  for (const id of rows.keys()) if (!used.has(id)) out.push(`${name} 근거표의 ${id} 를 본문이 안 쓴다 — 낡은 행이다`);
  return out;
}

// ⚠️ **검사기 자신을 잰다.** 이 저장소는 「검사가 초록이다」와 「검사가 돌기는 했다」를 가르는 것을
//    이미 한 번 비싸게 배웠다(위협 91). 합성 입력이라 저장소 상태에 기대지 않는다.
const T = (name, text, expect) => {
  const got = checkClaims("t", text);
  const ok = expect === 0 ? got.length === 0 : got.length > 0;
  if (!ok) { console.error(`self-test 실패: ${name}\n  ${got.join("\n  ")}`); process.exit(1); }
};
const tbl = (rows) => `${C0}\n| id | 종류 | 주장 | 근거 |\n|---|---|---|---|\n${rows}\n${C1}`;
T("표시 없는 문서는 통과", "그냥 글이다", 0);
T("온전한 문서는 통과",
  `본문 [M1] [S1] [R1]\n` + tbl(
    "| M1 | 실측 | 403 이다 | `node x.mjs` → 403 · 2026-09-05 |\n" +
    "| S1 | 원문 | 규정이 그렇다 | https://e.com · 2026-09-05 |\n" +
    "| R1 | 추론 | 아마 그렇다 | 이유 |"), 0);
T("미확인이 남으면 실패", `본문 [U1]\n` + tbl("| U1 | 추론 | 모른다 | - |"), 1);
T("모르는 종류는 실패", `본문 [M1]\n` + tbl("| M1 | 느낌 | x | y |"), 1);
T("실측에 명령이 없으면 실패", `본문 [M1]\n` + tbl("| M1 | 실측 | x | 2026-09-05 그냥 봤다 |"), 1);
T("실측에 날짜가 없으면 실패", `본문 [M1]\n` + tbl("| M1 | 실측 | x | `cmd` → 결과 |"), 1);
T("원문에 URL 이 없으면 실패", `본문 [S1]\n` + tbl("| S1 | 원문 | x | 2026-09-05 어딘가 |"), 1);
T("원문에 날짜가 없으면 실패", `본문 [S1]\n` + tbl("| S1 | 원문 | x | https://e.com |"), 1);
T("본문이 없는 id 를 가리키면 실패", `본문 [M9]\n` + tbl("| M1 | 추론 | x | y |"), 1);
T("안 쓰는 행이 남으면 실패", `본문에 표시가 없다\n` + tbl("| M1 | 추론 | x | y |"), 1);
T("마커가 하나뿐이면 실패", `${C0}\n| M1 | 추론 | x | y |`, 1);

const problems = [];
for (const f of readdirSync("docs").filter((f) => f.endsWith(".md")))
  problems.push(...checkClaims(`docs/${f}`, readFileSync(`docs/${f}`, "utf8")));
if (problems.length) { console.error(problems.map((p) => "  " + p).join("\n")); process.exit(1); }
console.log(`test-claims: self-test 12개 + docs/*.md 통과 — 주장 표시의 구조만 본다(뜻은 사람이 본다)`);
