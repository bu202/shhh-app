// 문장 매칭 자체검증. `node scripts/test-match.mjs`
// app.js 실제 buildIndex/matchSentence를 mock 사전으로 검증(로직 중복 없음).
import { loadApp } from "./_app.mjs";

const M = loadApp("buildIndex, matchSentence");

const MOCK = [
  { word: "미안", aliases: [] },
  { word: "년", aliases: ["해"] },
  { word: "사과", aliases: [] },          // 과일
  { word: "죄송하다", aliases: ["사과", "미안하다"] }, // 사죄
  { word: "학교", aliases: [] },
  { word: "사랑", aliases: [] },
  { word: "모두", aliases: ["다"] },       // "다"=모두 별칭(오매칭 유발원)
  { word: "반갑다", aliases: [] },
  { word: "먹", aliases: [] },
  { word: "보다", aliases: [] },
  { word: "보고", aliases: [] },       // report (다른 수형)
  { word: "싶다", aliases: [] },
];
M.buildIndex(MOCK);
const words = (t) => M.matchSentence(t).map((k) => (k.type === "entry" ? k.entries.map((e) => e.word).join("|") : "?" + k.text));

let fail = 0;
const eq = (got, exp, name) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g !== e) { console.error(`FAIL ${name}: ${g} (기대 ${e})`); fail++; }
  else console.log(`OK   ${name}: ${g}`);
};

eq(words("미안해"), ["미안"], "미안해 → 미안(해 흡수, 년 아님)");
eq(words("미안해요"), ["미안"], "미안해요 → 미안");
eq(words("사랑해"), ["사랑"], "사랑해 → 사랑");
eq(words("사과"), ["사과|죄송하다"], "사과 → 과일+사죄 후보 둘");
eq(words("학교에서"), ["학교"], "학교에서 → 학교(에서 흡수)");
eq(words("해"), ["년"], "해 홀로 → 년(어미 흡수는 매칭 뒤에만)");
eq(words("반갑습니다"), ["반갑다"], "반갑습니다 → 반갑다(습니다→다 정규화)");
eq(words("먹다"), ["먹"], "먹다 → 먹(다 흡수, 모두 오매칭 아님)");
eq(words("다"), ["모두"], "다 홀로 → 모두(정규화·흡수는 매칭 뒤에만)");
eq(words("보고싶다"), ["보다", "싶다"], "보고싶다 → 보다+싶다(보고=report 아님)");
eq(words("보고싶어요"), ["보다", "싶다"], "보고싶어요 → 보다+싶다");
eq(words("보고"), ["보고"], "보고 홀로 → 보고(report, 고싶 규칙 오작동 없음)");
process.exit(fail ? 1 : 0);
