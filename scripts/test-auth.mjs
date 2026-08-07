// 로그인 동기화 규칙(syncPlan)을 화면 없이 잰다.
// 이 규칙이 틀리면 증상이 "단어장이 조용히 사라졌다"라서 사람이 눈으로는 못 잡는다.
import { readFileSync } from "node:fs";
import assert from "node:assert";

// auth.js 의 화면 부분은 `typeof document !== "undefined"` 안에 있어 Node 에선 안 돈다.
const src = readFileSync(new URL("../js/auth.js", import.meta.url), "utf8");
const { syncPlan } = new Function(`${src}\n; return { syncPlan };`)();

const R = (words, updated) => ({ words, updated });

// 1. 오프라인(서버 응답 없음) — 로컬을 절대 건드리지 않는다.
assert.equal(syncPlan(null, ["사랑"], 100, false).action, "none");
assert.equal(syncPlan(null, [], 0, true).action, "none");

// 2. 로그인 첫 순간 — 합집합. 로그인 전에 담아둔 것도, 다른 기기 것도 남는다.
const first = syncPlan(R(["사랑", "고맙다"], 500), ["사랑", "잘 자다"], 100, true);
assert.equal(first.action, "merge");
assert.deepEqual(first.words, ["사랑", "고맙다", "잘 자다"]);
assert.equal(new Set(first.words).size, first.words.length, "합집합에 중복이 생기면 안 된다");

// 3. 그 뒤로는 last-write-wins. 서버가 새것이면 받아온다.
assert.deepEqual(syncPlan(R(["가"], 900), ["나", "다"], 800, false), { action: "pull", words: ["가"] });

// 4. 로컬이 새것이면 올린다. **삭제도 전파돼야 한다** — 여기서 합집합을 쓰면
//    다른 기기에서 뺀 단어가 되살아난다(그래서 3·4 를 합집합으로 안 했다).
assert.deepEqual(syncPlan(R(["가", "나"], 700), ["가"], 800, false), { action: "push", words: ["가"] });

// 5. 서버에 아무것도 없던 첫 기기(updated=0) → 로컬을 올린다.
assert.equal(syncPlan(R([], 0), ["사랑"], 100, false).action, "push");

// 6. 같은 시각이면 로컬이 이긴다. 방금 내가 고친 걸 되돌리지 않기 위해서 —
//    pull 로 기울면 사용자가 "방금 뺀 단어가 다시 생겼다"를 본다.
assert.equal(syncPlan(R(["가"], 800), ["나"], 800, false).action, "push");

console.log("test-auth: 6개 통과");
