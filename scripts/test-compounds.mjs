// 합성 수어(결합정보 + 검증 대장)가 실제 문장에서 잡히는지 검증. `node scripts/test-compounds.mjs`
// app.js 의 진짜 conjugationNormalize/norm/matchSentence 를 쓴다(로직 중복 없음).
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("buildIndex, matchSentence, conjugationNormalize, norm, COMPOUNDS, PREFERRED, lookup, unpinnedCandidates, preferPinned, quizPool, bookItem, cost");

const load = (p) => JSON.parse(readFileSync(new URL("../data/" + p, import.meta.url), "utf8"));
const dict = load("ksl-dict.json");
M.buildIndex(dict);

// 앱의 loadCompounds 와 같은 키 규칙으로 채운다.
const comp = load("ksl-compounds.json");
const ver = load("ksl-verified.json");
for (const [w, v] of Object.entries(comp)) M.COMPOUNDS.set(M.conjugationNormalize(M.norm(w)), { ...v, word: w });
for (const [w, v] of Object.entries(ver)) {
  M.COMPOUNDS.set(M.conjugationNormalize(M.norm(w)), { ...v, verified: true, word: w });
  for (const p of v.parts) { const [pw, pin] = String(p).split("@"); if (pin) M.PREFERRED.set(M.norm(pw), pin); }
}

const first = (t) => M.matchSentence(t)[0];

// 1. 검증 대장이 자동 추출본을 이기고, 활용형에서도 잡힌다.
//    '보고싶다'는 사전에 표제어가 없다 — 영상(유손생)으로 확인해 대장에 넣은 것.
//    '보고파' 는 '보고 싶어'의 준말인데, 안 풀면 보고(報告)+지화 '파' 로 떨어진다(⛔ 위반).
//    같은 글자에 ㅡ탈락(배고파→배고프다)이 걸리므로 deconjugate 가 후보를 여럿 내야 둘 다 산다.
for (const q of ["보고싶다", "보고싶어", "보고싶었어", "보고 싶다", "보고파"]) {
  const t = first(q);
  assert.equal(t.type, "compound", `${q}: 합성으로 안 잡힘 (type=${t.type})`);
  assert.deepEqual(t.combo.labels, ["보다", "원하다"], `${q}: 부품이 다름`);
  assert.ok(t.combo.verified, `${q}: 검증본이 아님`);
  // ⛔ 실제 수어만 보여준다: '보다'는 사전에 수형이 둘(시각 / 조사 '~보다')이라
  //    못박지 않으면 첫 후보인 조사 쪽이 뜬다. 그림 파일까지 확인한다.
  const e = M.lookup(t.combo.parts[0]);
  assert.match(e.media.src[0], /IMG000227009/, `${q}: '보다'가 [시각] 수형이 아님 — ${e.description}`);
  assert.match(e.description, /두 눈에/, `${q}: '보다' 설명이 눈과 무관함`);
}

// 2. 사전에 그림이 있는 말은 단일 표제어가 이기고, 합성은 "어떻게 만들어졌나"로만 붙는다.
for (const [w, parts] of [["두통", ["머리", "아프다"]], ["헌금", ["바치다", "돈"]]]) {
  const t = first(w);
  assert.equal(t.type, "entry", `${w}: 단일 표제어가 이겨야 함`);
  const c = M.COMPOUNDS.get(M.conjugationNormalize(M.norm(w)));
  assert.deepEqual(c.parts, parts, `${w}: 결합정보가 다름`);
}

// 3. 모든 합성 부품은 사전에서 찾혀야 한다 — 없으면 화면에 빈 카드가 뜬다.
//    앱이 실제로 쓰는 lookup(@핀 포함)으로 확인한다.
let broken = 0;
for (const [key, v] of M.COMPOUNDS) {
  for (const p of v.parts) if (!M.lookup(p)) { broken++; break; }
}
assert.equal(broken, 0, `부품이 사전에 없는 합성 ${broken}건`);

// 4. ⛔ 단정 금지: 수형이 못박히지 않은 부품은 화면에서 "확인 안 됨"으로 드러나야 한다.
//    검증 대장의 부품은 사람이 전부 못박았으므로 하나도 걸리면 안 된다.
for (const [w] of Object.entries(ver)) {
  const c = M.COMPOUNDS.get(M.conjugationNormalize(M.norm(w)));
  for (const p of c.parts) {
    assert.equal(M.unpinnedCandidates(p).length, 0, `${w}: 검증본인데 부품 '${p}' 의 수형이 안 정해짐`);
  }
}
// 자동 추출본 중 수형이 실제로 갈리는 것은 반드시 걸려야 한다. 0이면 탐지가 죽은 것이고,
// 화면은 다시 "첫 후보"를 단정하게 된다 — 이 테스트가 그 회귀를 잡는다.
let flagged = 0, autos = 0;
for (const [, v] of M.COMPOUNDS) {
  if (v.verified) continue;
  autos++;
  if (v.parts.some((p) => M.unpinnedCandidates(p).length)) flagged++;
}
assert.ok(flagged > 0, "자동 추출본에서 미확정 부품이 하나도 안 잡힘 — 탐지가 죽었다");

// 5. 사람이 고른 수형은 그 표제어를 **그냥 검색해도** 대표로 떠야 한다.
//    안 그러면 '보고싶어'에선 [시각] 보다가, '보다'를 치면 조사 '~보다'가 떠서 앱이 자기모순이 된다.
for (const q of ["보다", "보자"]) {
  const t = first(q);
  assert.equal(t.type, "entry", `${q}: 표제어로 안 잡힘`);
  const [rep] = M.preferPinned(t.text, t.entries);
  assert.match(rep.media.src[0], /IMG000227009/, `${q}: 대표가 [시각] 수형이 아님 — ${rep.description}`);
}

// 6. 연습은 수형이 안 정해진 단어를 문제로 내면 안 된다.
//    사전 화면은 "(확인 안 됨)" 이라 말해놓고 연습에서 임의의 첫 후보를 '정답'으로 채점하면
//    앱이 틀린 수어를 정답으로 가르치게 된다(⛔ 위반). 단어장 표시도 같은 판정을 쓴다.
const unsureWord = [...M.COMPOUNDS].filter(([, v]) => !v.verified)
  .flatMap(([, v]) => v.parts).find((p) => M.unpinnedCandidates(p).length);
assert.ok(unsureWord, "수형 미확정 부품을 하나도 못 찾음 — 표본이 없어 이 검사가 무의미하다");
const settled = "사랑";
assert.equal(M.unpinnedCandidates(settled).length, 0, `표본 오류: '${settled}' 은 수형이 정해진 단어여야 한다`);
assert.deepEqual(M.quizPool([unsureWord, settled]), [settled],
  `연습이 수형 미확정 단어 '${unsureWord}' 를 문제로 낸다 — 임의의 첫 후보를 정답이라고 채점하게 된다`);

// 7. 합성은 단어장에 **한 항목**으로 담기고, 부품은 그 안에서 펼쳐진다.
//    예전엔 '보고싶다'를 담으면 보다·내키다 두 항목으로 쪼개져 사용자가 찾은 말이 사라졌다.
const compoundToken = first("보고싶어");
assert.equal(compoundToken.type, "compound", "'보고싶어' 가 합성으로 안 잡힘 — 표본이 깨졌다");
const key = compoundToken.combo.word;
const it = M.bookItem(key);
assert.ok(it, `단어장이 '${key}' 를 못 푼다 — 담아도 "사전에서 찾을 수 없어요" 가 뜬다`);
assert.equal(it.parts.length, 2, `'${key}' 부품이 2개여야 하는데 ${it.parts.length}개`);
assert.deepEqual(it.labels, ["보다", "원하다"], "부품 이름이 화면에 쓰는 것과 다름");
assert.equal(M.cost(key), 2, "합성은 무료 칸을 손짓 수만큼 차지해야 한다(한 항목으로 보여도 값은 그대로)");
assert.deepEqual(M.quizPool([key]), [key], `연습이 합성 '${key}' 를 통째로 못 낸다`);

// 표제어이면서 합성이기도 한 말('헌금')은 **표제어 쪽**으로 풀려야 한다 —
// 사전 화면이 표제어 카드를 보여주므로 단어장이 다른 걸 보여주면 두 화면이 어긋난다.
assert.equal(first("헌금").type, "entry", "'헌금' 표본이 깨졌다");
assert.equal(M.bookItem("헌금").parts.length, 1,
  "'헌금' 이 단어장에서 합성으로 풀린다 — 사전은 표제어 카드 하나를 보여주는데 단어장은 부품 2개를 편다");

console.log(`ok — 합성 ${M.COMPOUNDS.size}개(검증 ${Object.keys(ver).length}개), 부품 전부 사전에 있음`);
console.log(`   단어장: '${key}' 한 항목 = ${it.labels.join(" + ")} (${M.cost(key)}칸), 연습 출제 가능`);
console.log(`   연습 출제 제외 확인: '${unsureWord}'(수형 미확정) 빠지고 '${settled}' 만 남음`);
console.log(`   자동 추출 ${autos}건 중 ${flagged}건에 '확인 안 됨' 부품이 있어 화면에 표시됨`);
