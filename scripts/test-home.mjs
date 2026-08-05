// 홈의 '오늘의 수어' 검증. `node scripts/test-home.mjs`
// app.js 의 진짜 dailyIndex/todaysWord 를 쓴다(로직 중복 없음).
import { readFileSync } from "node:fs";
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("dailyIndex, todaysWord, dailyPool");
const dict = JSON.parse(readFileSync(new URL("../data/ksl-dict.json", import.meta.url), "utf8"));

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
