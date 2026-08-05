// 한글 조합기 자체검증. `node scripts/test-assemble.mjs`
// app.js 실제 소스를 읽어 assembleHangul만 뽑아 검증(로직 중복 없음).
import { loadApp } from "./_app.mjs";

// Node엔 navigator가 있고 serviceWorker는 없어 app.js의 SW 등록 블록은 스킵됨(스텁 불필요).
const { assembleHangul } = loadApp("assembleHangul");

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
process.exit(fail ? 1 : 0);
