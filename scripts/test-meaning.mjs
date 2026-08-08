// 국어사전 뜻 표시 검증. `node scripts/test-meaning.mjs`
// 앱의 meaningOf 와 수집 스크립트의 pickDefinition 을 같이 잰다 — 둘이 뜻 하나를 화면까지 나른다.
import assert from "node:assert";
import { loadApp } from "./_app.mjs";
import { pickDefinition, cleanDefinition } from "./fetch-meanings.mjs";

const M = loadApp("meaningOf, MEANINGS, loadMeanings");

// 파일이 없어도 앱이 서야 한다 — 인증키가 사람 몫이라 데이터가 늦게 붙는다.
await M.loadMeanings();
assert.equal(M.meaningOf("아무말"), "", "뜻 파일이 없으면 빈 문자열이어야 한다");

M.MEANINGS.set("식", "의식(儀式)을 치르는 일.");
M.MEANINGS.set("축하", "남의 좋은 일을 기뻐하고 즐거워한다는 뜻으로 인사함.");
M.MEANINGS.set("보다", "눈으로 대상의 존재나 형태적 특징을 알다.");

// 1. 사용자가 친 말의 뜻이 먼저다. '축하해'를 쳤는데 표제어 '식'의 뜻이 뜨면
//    자기가 안 친 말의 뜻을 읽게 된다(함정 17 과 같은 부류).
assert.equal(M.meaningOf("축하", "식"), "남의 좋은 일을 기뻐하고 즐거워한다는 뜻으로 인사함.");

// 2. 친 말에 뜻이 없으면 표제어의 뜻으로 내려간다. 빈칸보다 낫다.
assert.equal(M.meaningOf("없는별칭", "식"), "의식(儀式)을 치르는 일.");

// 3. @핀이 붙은 이름도 뜻을 찾아야 한다. 단어장·연습은 '보다@IMG000227009' 로 들고 다닌다 —
//    안 떼면 뜻이 통째로 안 뜨는데, 핀이 없는 단어에선 증상이 없어 눈에 안 띈다(함정 24 와 같은 부류).
assert.equal(M.meaningOf("보다@IMG000227009"), "눈으로 대상의 존재나 형태적 특징을 알다.");

// 4. 수집 쪽: 표제어가 정확히 같은 것만 쓴다. 검색은 '보다'에 '보다못해'까지 물어 온다.
assert.equal(
  pickDefinition({ channel: { item: [
    { word: "보다못해", sense: { definition: "딴 것" } },
    { word: "보다", sense: { definition: "눈으로 대상의 존재나 형태적 특징을 알다." } },
  ] } }, "보다"),
  "눈으로 대상의 존재나 형태적 특징을 알다.");
assert.equal(cleanDefinition("사람의 <FL>身體</FL>^부분"), "사람의 身體 부분");

console.log("ok — 뜻은 사용자가 친 말 우선 · @핀 통과 · 표제어 정확일치만 수집");
