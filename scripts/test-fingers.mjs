// 손가락 번호 표기(1지=검지 … 5지=엄지)를 이름으로 바꾸는 변환 검증.
// 실행: node scripts/test-fingers.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";

// app.js에서 함수 본문만 떼어 온다(브라우저 전역 스크립트라 import가 안 됨).
const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const block = src.match(/const FINGERS = \[[\s\S]*?\n}/)[0];
const { namedFingers } = new Function(block + "; return { namedFingers };")();

// 실제 사전 문장 + 독립 출처로 교차검증한 단어들
assert.equal(
  namedFingers("오른 주먹의 4지를 펴서 끝 바닥을 턱에 가볍게 두 번 댄다."),
  "오른 주먹의 새끼손가락을 펴서 끝 바닥을 턱에 가볍게 두 번 댄다.",
  "괜찮다 = 새끼손가락 (평택시사신문·쉐어하우스 대조 확인)"
);
assert.equal(
  namedFingers("오른손의 1·5지 끝을 맞대어 동그라미를 만들어 이마에 댔다가"),
  "오른손의 검지·엄지손가락 끝을 맞대어 동그라미를 만들어 이마에 댔다가",
  "미안 = 검지+엄지 동그라미"
);
assert.equal(
  namedFingers("두 주먹의 1지를 펴서 마주 세웠다가 중앙으로 모아 마주 댄다."),
  "두 주먹의 검지손가락을 펴서 마주 세웠다가 중앙으로 모아 마주 댄다.",
  "만나다 = 두 검지"
);
assert.equal(
  namedFingers("오른 주먹의 1·2지를 펴서"),
  "오른 주먹의 검지·중지손가락을 펴서"
);
// 번호가 없는 설명은 건드리지 않는다
const plain = "오른손을 펴서 손바닥이 아래로 향하게 하여 관자놀이에 댔다가 밖으로 내민다.";
assert.equal(namedFingers(plain), plain, "번호 없는 문장은 그대로");

// 사전 전체에 돌려 숫자+지가 남지 않는지
const dict = JSON.parse(readFileSync(new URL("../data/ksl-dict.json", import.meta.url), "utf8"));
const leftover = dict.filter((e) => /[1-5]지/.test(namedFingers(e.description)));
assert.equal(leftover.length, 0, `변환 안 된 표기 ${leftover.length}건: ${leftover[0]?.word}`);

console.log(`ok — ${dict.length}개 표제어 전부 변환됨`);
