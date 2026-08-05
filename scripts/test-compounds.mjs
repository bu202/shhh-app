// 합성 수어(결합정보 + 검증 대장)가 실제 문장에서 잡히는지 검증. `node scripts/test-compounds.mjs`
// app.js 의 진짜 conjugationNormalize/norm/matchSentence 를 쓴다(로직 중복 없음).
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("buildIndex, matchSentence, conjugationNormalize, norm, COMPOUNDS");

const load = (p) => JSON.parse(readFileSync(new URL("../data/" + p, import.meta.url), "utf8"));
const dict = load("ksl-dict.json");
M.buildIndex(dict);

// 앱의 loadCompounds 와 같은 키 규칙으로 채운다.
const comp = load("ksl-compounds.json");
const ver = load("ksl-verified.json");
for (const [w, v] of Object.entries(comp)) M.COMPOUNDS.set(M.conjugationNormalize(M.norm(w)), { ...v, word: w });
for (const [w, v] of Object.entries(ver)) M.COMPOUNDS.set(M.conjugationNormalize(M.norm(w)), { ...v, verified: true, word: w });

const first = (t) => M.matchSentence(t)[0];

// 1. 검증 대장이 자동 추출본을 이기고, 활용형에서도 잡힌다.
//    '보고싶다'는 사전에 표제어가 없다 — 영상(유손생)으로 확인해 대장에 넣은 것.
for (const q of ["보고싶다", "보고싶어", "보고싶었어", "보고 싶다"]) {
  const t = first(q);
  assert.equal(t.type, "compound", `${q}: 합성으로 안 잡힘 (type=${t.type})`);
  assert.deepEqual(t.combo.labels, ["보다", "원하다"], `${q}: 부품이 다름`);
  assert.ok(t.combo.verified, `${q}: 검증본이 아님`);
}

// 2. 사전에 그림이 있는 말은 단일 표제어가 이기고, 합성은 "어떻게 만들어졌나"로만 붙는다.
for (const [w, parts] of [["두통", ["머리", "아프다"]], ["헌금", ["바치다", "돈"]]]) {
  const t = first(w);
  assert.equal(t.type, "entry", `${w}: 단일 표제어가 이겨야 함`);
  const c = M.COMPOUNDS.get(M.conjugationNormalize(M.norm(w)));
  assert.deepEqual(c.parts, parts, `${w}: 결합정보가 다름`);
}

// 3. 모든 합성 부품은 사전에 있어야 한다 — 없으면 화면에 빈 카드가 뜬다.
let broken = 0;
for (const [key, v] of M.COMPOUNDS) {
  for (const p of v.parts) if (!M.matchSentence(p).some((t) => t.type === "entry")) { broken++; break; }
}
assert.equal(broken, 0, `부품이 사전에 없는 합성 ${broken}건`);

console.log(`ok — 합성 ${M.COMPOUNDS.size}개(검증 ${Object.keys(ver).length}개), 부품 전부 사전에 있음`);
