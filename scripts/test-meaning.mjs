// 카드에 뜨는 「뜻」 검증. `node scripts/test-meaning.mjs`
//
// 뜻은 **국어원 사전의 「한국어 대응표현」**(= 내부 스키마의 aliases) 이다. 사전 문장이 아니라
// 이 손짓이 나타내는 낱말들이다: 내키다 → "싶다 · 원하다 · 바라다 · 소원 · 바람 · 욕구 · 염원 · 원".
// 새로 받아올 데이터가 없어서 인증키도 파일도 필요 없다 — 이미 사전에 들어 있던 값이다.
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("meaningOf");

// 1. 카드 이름에 이미 뜬 말은 빼고 나머지만. '원하다 (내키다)' 밑에 또 '내키다'가 오면
//    같은 말을 두 줄에서 읽게 된다.
const e = { word: "내키다", aliases: ["싶다", "원하다", "내키다", "바라다"] };
assert.equal(M.meaningOf(e, "원하다"), "싶다 · 바라다", "친 말과 표제어를 둘 다 빼야 한다");
assert.equal(M.meaningOf(e, ""), "싶다 · 원하다 · 바라다", "표제어만 뺀다");

// 2. @핀이 붙은 이름도 통과해야 한다. 단어장·연습은 '보다@IMG000227009' 로 들고 다닌다.
assert.equal(M.meaningOf({ word: "시각", aliases: ["보다", "관찰"] }, "보다@IMG000227009"), "관찰",
  "@핀을 안 떼면 친 말이 안 걸러진다");

// 3. 대응표현이 없으면 빈 문자열 — 뜻 줄이 아예 안 뜬다. **없는 걸 지어내지 않는다**(⛔ 1번).
//    실제로 12,943개 중 18% 에만 대응표현이 있어서 이 경우가 흔하다.
assert.equal(M.meaningOf({ word: "소령", aliases: [] }, "소령"), "");
assert.equal(M.meaningOf(null, "아무말"), "", "항목이 없으면 빈 문자열");

// 4. 붙임표가 붙은 것은 낱말이 아니라 조어 요소라 뜻 자리에서 안 읽힌다.
//    '사랑' 의 대응표현이 '-애' 하나뿐이라 카드에 "사랑 / -애" 가 떴다.
assert.equal(M.meaningOf({ word: "사랑", aliases: ["-애"] }, "사랑"), "", "붙임표만 남으면 비운다");
assert.equal(M.meaningOf({ word: "감사", aliases: ["고맙다", "-사"] }, "감사"), "고맙다", "낱말만 남긴다");
// 단 표제어 자신이 어미면 그대로 둔다 — 거기선 그게 맞는 답이다.
assert.equal(M.meaningOf({ word: "-습니다", aliases: ["-ㅂ니다"] }, "-습니다"), "-ㅂ니다",
  "어미 표제어의 뜻까지 지우면 안 된다");

// 5. 대응표현이 **없을 때만** 표준국어대사전 뜻풀이로 채운다(`data/ksl-meanings.json`).
//    대응표현이 있으면 그게 이긴다 — 국어원이 이 수형에 붙여 놓은 말이라 더 정확하다.
const F = loadApp("meaningOf, loadMeanings");
await F.loadMeanings();
assert.equal(F.meaningOf({ word: "커피", aliases: [] }, "커피"), "커피나무의 열매를 볶아서 간 가루.",
  "대응표현이 없는데 뜻풀이도 안 뜬다");
assert.equal(F.meaningOf({ word: "감사", aliases: ["고맙다"] }, "감사"), "고맙다",
  "대응표현이 있는데 뜻풀이가 이겼다");

// 6. **동형어가 여럿이면 수집기가 비워 둔다**(함정 47). 사전의 첫 뜻은 흔한 뜻이 아니라서
//    (`가구①`=佳句, `소령`=여러 뜻) 그냥 쓰면 틀린 뜻을 단정하게 된다. 뜻 줄이 안 뜨는 게 낫다.
assert.equal(F.meaningOf({ word: "소령", aliases: [] }, "소령"), "", "동형어인데 한 뜻으로 단정했다");
assert.equal(F.meaningOf({ word: "보다", aliases: [] }, "보다"), "", "동형어인데 한 뜻으로 단정했다");

console.log("ok — 뜻은 대응표현 우선 · 없으면 뜻풀이 · 동형어는 비움 · @핀 통과 · 붙임표 제외");
