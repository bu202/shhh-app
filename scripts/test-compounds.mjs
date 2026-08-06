// 합성 수어(결합정보 + 검증 대장)가 실제 문장에서 잡히는지 검증. `node scripts/test-compounds.mjs`
// app.js 의 진짜 conjugationNormalize/norm/matchSentence 를 쓴다(로직 중복 없음).
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("buildIndex, matchSentence, conjugationNormalize, norm, COMPOUNDS, PREFERRED, lookup, unpinnedCandidates, preferPinned");

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

console.log(`ok — 합성 ${M.COMPOUNDS.size}개(검증 ${Object.keys(ver).length}개), 부품 전부 사전에 있음`);
console.log(`   자동 추출 ${autos}건 중 ${flagged}건에 '확인 안 됨' 부품이 있어 화면에 표시됨`);
