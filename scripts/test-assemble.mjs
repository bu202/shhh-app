// 한글 조합기 자체검증. `node scripts/test-assemble.mjs`
// camera.js 를 그냥 import 한다 — 최상위에서 브라우저 전역을 안 건드리므로 스텁이 필요 없다.
import assert from "node:assert";
import { assembleHangul, JAMO_IMG, CHO, JUNG, JONG } from "../js/camera.js";
import { loadApp } from "./_app.mjs";

let fail = 0;
const t = (inp, exp) => {
  const got = assembleHangul(inp.split(""));
  if (got !== exp) { console.error(`FAIL ${inp} → ${got} (기대 ${exp})`); fail++; }
  else console.log(`OK   ${inp} → ${got}`);
};
t("ㅂㅏㅂ", "밥");
t("ㅇㅏㄴㄴㅕㅇ", "안녕");
t("ㅅㅏㄹㅏㅇ", "사랑");   // 연음: ㄹ이 받침 아닌 다음 초성
t("ㅎㅏㄴㄱㅡㄹ", "한글");
t("ㄱㅜㄱㅇㅓ", "국어");
t("ㅂ", "ㅂ");             // 자음 홀로
t("ㅏ", "ㅏ");             // 모음 홀로

// 자모 표가 app.js 와 camera.js 에 두 벌 있다(app.js 가 아직 classic script 라 import 불가).
// 한쪽만 고치면 화면의 지화와 카메라 인식이 조용히 어긋나므로 여기서 매번 대조한다.
// 계획서 B단계에서 utils.js 로 합치면 이 블록은 지운다.
const A = loadApp("JAMO_IMG, CHO, JUNG, JONG");
assert.deepStrictEqual(A.JAMO_IMG, JAMO_IMG, "JAMO_IMG 가 app.js 와 camera.js 에서 다르다");
assert.deepStrictEqual(A.CHO, CHO, "CHO 가 app.js 와 camera.js 에서 다르다");
assert.deepStrictEqual(A.JUNG, JUNG, "JUNG 이 app.js 와 camera.js 에서 다르다");
assert.deepStrictEqual(A.JONG, JONG, "JONG 이 app.js 와 camera.js 에서 다르다");
console.log("OK   자모 표 4벌이 app.js 와 일치");

process.exit(fail ? 1 : 0);
