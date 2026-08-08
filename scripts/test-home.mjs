// 홈의 '오늘의 수어' 검증. `node scripts/test-home.mjs`
// app.js 의 진짜 dailyIndex/todaysWord 를 쓴다(로직 중복 없음).
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("dailyIndex, todaysWord, dailyPool, loadDaily");
const dict = JSON.parse(readFileSync(new URL("../data/ksl-dict.json", import.meta.url), "utf8"));
// 후보 목록을 실제로 읽는다. 안 읽으면 앱과 다른 풀(사전 전체)을 재게 돼 이 테스트가 거짓말을 한다.
await M.loadDaily();

// 1. 같은 날이면 항상 같은 단어. 이게 깨지면 "둘이 같은 단어를 본다"는 전제가 무너진다.
const a = M.todaysWord(dict, "2026-08-05");
const b = M.todaysWord(dict, "2026-08-05");
assert.equal(a.word, b.word, "같은 날짜인데 단어가 다름");

// 2. 그림이 있어야 한다 — 홈은 손모양을 보여주는 화면이다.
assert.ok(a.media.src.length, `'${a.word}' 에 그림이 없음`);

// 3. 후보는 전부 그림 있는 순한글 짧은 표제어(변이형 ①②·기호 제외).
const pool = M.dailyPool(dict);
assert.ok(pool.length > 500, `후보가 너무 적음(${pool.length})`);
for (const e of pool) {
  assert.match(e.word, /^[가-힣]{1,4}$/, `후보에 이상한 표제어: ${e.word}`);
  assert.ok(e.media.src.length, `후보에 그림 없는 것: ${e.word}`);
}

// 3b. 첫 화면에 내놓을 말이 아닌 것은 후보에 없다.
// 군 계급·행정 용어가 '오늘의 수어'로 떴던 자리다(2026-08-08). 조건이 "그림 있고 4글자 이하"뿐이라
// 사전 전체가 후보였다. 분류가 '일상생활 > 기타'인 것을 빼서 고쳤다 — 이 필터를 되돌리면 여기서 걸린다.
const words = new Set(pool.map((e) => e.word));
for (const w of ["소령", "대령", "중령", "대위", "소위", "준장"]) {
  assert.ok(!words.has(w), `'${w}' 가 아직 오늘의 수어 후보에 있다 — 분류 필터가 안 걸렸다`);
}
// 지우기만 한 게 아니라는 확인. 일상어가 같이 날아갔으면 필터가 과하다.
for (const w of ["사랑", "호랑이", "커피", "연애"]) {
  assert.ok(words.has(w), `'${w}' 가 후보에서 빠졌다 — 분류 필터가 과하다`);
}

// 4. 날이 바뀌면 골고루 돈다. 한 단어에 눌러앉으면(해시가 망가지면) 여기서 걸린다.
const year = [...Array(365)].map((_, i) =>
  M.todaysWord(dict, new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)).word);
const uniq = new Set(year).size;
// 3,308개 후보에서 365번 뽑으면 겹침을 감안해 ~345개가 정상. 288개면 해시가 뭉친 것.
assert.ok(uniq > 330, `365일에 서로 다른 단어가 ${uniq}개뿐 — 해시가 뭉쳤다`);

// 5. 범위 밖으로 나가지 않는다.
for (const n of [1, 2, 7, 3622]) {
  const i = M.dailyIndex("2026-08-05", n);
  assert.ok(i >= 0 && i < n, `dailyIndex 범위 벗어남: ${i} (len=${n})`);
}

console.log(`ok — 오늘의 수어 '${a.word}' · 후보 ${pool.length}개 · 365일 중 서로 다른 단어 ${uniq}개`);
