// '오늘의 수어' 후보 뽑기: data.go.kr 15135637 CSV 의 분류 → data/ksl-daily.json
//
// 왜 필요했나: 홈의 '오늘의 수어'에 **소령·대령 같은 군 계급**이 떴다. 후보 조건이 "그림 있고
// 4글자 이하 한글"뿐이라 사전 전체(3,308개)가 후보였기 때문이다. 손으로 고른 목록을 만들
// 필요는 없었다 — 국립국어원이 이미 표제어마다 분류를 붙여 뒀는데 앱이 그걸 안 쓰고 있었다.
//
// 분류표 전체를 앱에 싣지 않는 이유: 앱이 그걸로 하는 일이 후보 고르기 하나뿐이다.
// 15,482개 분류(263KB)를 매 로드마다 내려받느니 결과인 **단어 목록만**(약 12KB) 싣는다.
// 뜻풀이는 이것과 다른 축이라 data/ksl-meanings.json 이 따로 맡는다.
//
// 실행: node scripts/build-daily.mjs "<CSV 경로>"
//       node scripts/build-daily.mjs --selftest
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert";
import { parseCsv } from "./build-compounds.mjs";

// "일상생활 수어 > 인간 > 감정" → { top:"일상생활", leaf:"감정" }
// 화면엔 leaf 만 쓴다. "일상생활 수어 >" 는 3,304개 중 2,824개에 붙어 있어 정보가 없다.
export function splitCategory(raw) {
  const parts = String(raw || "").split(">").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const top = parts[0].replace(/\s*수어$/, "");
  const leaf = parts[parts.length - 1];
  return { top, leaf: leaf === parts[0] ? "" : leaf };
}

// 한 표제어가 여러 행에 나온다(불교 사전에도 '꿈'이 있다). 먼저 온 것을 쓰면 일상어가
// 전문용어로 분류된다 — 실제로 꿈→불교, 약속→국어 교과 용어가 됐다.
// 그래서 **일상생활 > (기타 아님)** 을 가장 좋은 것으로 두고 순위로 고른다.
export function rank(cat) {
  const c = splitCategory(cat);
  if (!c) return 3;
  if (c.top !== "일상생활") return 2;
  return c.leaf && c.leaf !== "기타" ? 0 : 1;
}

function selftest() {
  assert.deepEqual(splitCategory("일상생활 수어 > 인간 > 감정"), { top: "일상생활", leaf: "감정" });
  assert.deepEqual(splitCategory("일상생활 수어 > 기타"), { top: "일상생활", leaf: "기타" });
  assert.deepEqual(splitCategory("전문용어 수어 > 불교"), { top: "전문용어", leaf: "불교" });
  assert.equal(splitCategory(""), null);
  // 분류가 아예 없는 한 칸짜리는 leaf 를 비운다 — "일상생활"을 뜻처럼 보여주면 안 된다.
  assert.deepEqual(splitCategory("일상생활 수어"), { top: "일상생활", leaf: "" });
  assert.ok(rank("일상생활 수어 > 인간 > 감정") < rank("일상생활 수어 > 기타"));
  assert.ok(rank("일상생활 수어 > 기타") < rank("전문용어 수어 > 불교"));
  assert.ok(rank("전문용어 수어 > 불교") < rank(""));
  console.log("selftest ok");
}

// 첫 화면에 내놓을 만한 표제어인가. 그림이 있고 짧고 깨끗한 것 — 종전 조건 그대로다.
// 변이형(①②)·기호가 붙은 표제어는 오늘 하루의 얼굴로 삼기엔 지저분하다.
export const presentable = (e) =>
  !!e.media?.src?.length && e.word.length <= 4 && /^[가-힣]+$/.test(e.word);

function build(csvPath) {
  const rows = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
  const hdr = rows[0].map((h) => h.trim());
  const [iWord, iCat] = ["한국어 대응표현", "대/중 분류"].map((k) => {
    const i = hdr.indexOf(k);
    if (i < 0) throw new Error(`컬럼 없음: ${k} (있는 컬럼: ${hdr.join(", ")})`);
    return i;
  });

  const best = new Map(); // 표제어 -> 분류 원문
  for (const r of rows.slice(1)) {
    const cat = (r[iCat] || "").trim();
    if (!cat) continue;
    for (const w of (r[iWord] || "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!best.has(w) || rank(cat) < rank(best.get(w))) best.set(w, cat);
    }
  }

  const dict = JSON.parse(readFileSync("data/ksl-dict.json", "utf8"));
  const pool = dict.filter(presentable);
  // rank 0 = 일상생활 수어의 **이름 붙은** 소분류(감정·음식·동물…). '기타'를 남기면 소령이 남는다 —
  // 1,136개짜리 잡동사니 칸이라 군 계급·행정 용어가 거기 다 들어 있다.
  const out = pool.filter((e) => rank(best.get(e.word)) === 0).map((e) => e.word);
  writeFileSync("data/ksl-daily.json", JSON.stringify(out));
  console.log(`ksl-daily.json — 후보 ${pool.length} → ${out.length}개 (분류 없는 것 ${pool.filter((e) => !best.has(e.word)).length})`);
  console.log("예시:", out.slice(0, 12).join(" · "));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (arg === "--selftest") selftest();
  else if (arg) build(arg);
  else console.error('사용법: node scripts/build-daily.mjs "<CSV 경로>" | --selftest');
}
