// 결합정보(합성 수어) 추출: data.go.kr 15135637 CSV → data/ksl-compounds.json
//
// "보고싶다"처럼 단일 표제어가 없는 말은 두 수어를 이어서 표현한다(보다+원하다).
// 그 결합 규칙이 이 CSV의 '결합정보' 컬럼에 들어 있다. 예: 헌금 => 바치다+돈
//
// 실행: node scripts/build-compounds.mjs "<CSV 경로>"
//       node scripts/build-compounds.mjs --selftest   (파서만 검증, 파일 불필요)
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert";

// 따옴표 필드를 지원하는 최소 CSV 파서. 의존성 추가 대신 20줄.
export function parseCsv(s) {
  const rows = [];
  let field = "", row = [], inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c !== '"') field += c;
      else if (s[i + 1] === '"') { field += '"'; i++; }
      else inQuote = false;
    } else if (c === '"') inQuote = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 결합정보 → 부품 배열. "바치다+돈" → ["바치다","돈"].
// 6,289개 중 형식이 깨끗한 A+B만 받는다(약 4,200개). 나머지는 사람이 봐야 하는 것들이라 버린다:
//   ①②  변이 표기      "①묻다. ②부탁하다"      어느 쪽을 쓸지 데이터만으론 못 정함
//   /    선택/보조 표기  "①남자 생식기/혹"
//   지문자                "지문자 'ㅊ'(…)/지식"    합성이 아니라 지화 안내
//   ( )  조건 설명       "(바지를)입다"           단서를 버리면 뜻이 달라짐
//   끝이 +로 잘린 것     "하늘②군+"              원본 결손
export function parseCombo(raw) {
  const s = (raw || "").trim();
  if (!s || !s.includes("+")) return null;
  if (/[①-⑳()（）\/.]|지문자/.test(s)) return null;
  const parts = s.split("+").map((x) => x.trim());
  if (parts.some((p) => !p)) return null; // "A+" 처럼 한쪽이 빈 것
  return parts.length >= 2 ? parts : null;
}

function selftest() {
  assert.deepEqual(parseCsv('a,b\n1,"x,y"\n')[1], ["1", "x,y"]);
  assert.deepEqual(parseCsv('a\n"he said ""hi"""\n')[1], ['he said "hi"']);
  assert.deepEqual(parseCombo("바치다+돈"), ["바치다", "돈"]);
  assert.deepEqual(parseCombo("고속버스+곳"), ["고속버스", "곳"]);
  assert.deepEqual(parseCombo("적합하다+아니다"), ["적합하다", "아니다"]);
  assert.equal(parseCombo(""), null, "빈 값");
  assert.equal(parseCombo("지식"), null, "+ 없으면 합성 아님");
  assert.equal(parseCombo("지문자 ‘ㅊ’(‘철학’의 ‘ㅊ’)/지식"), null, "지문자 표기 제외");
  assert.equal(parseCombo("①생각+중. ②싶다"), null, "①② 변이 표기 제외");
  assert.equal(parseCombo("하늘②군+"), null, "끝이 +로 잘린 것 제외");
  assert.equal(parseCombo("서식+복사②"), null, "부품에 변이 표기 붙은 것 제외");
  assert.equal(parseCombo("①남자 생식기/혹"), null, "슬래시 표기 제외");
  console.log("selftest ok");
}

function build(csvPath) {
  const rows = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
  const hdr = rows[0].map((h) => h.trim());
  const [iWord, iCombo, iDesc] = ["한국어 대응표현", "결합정보", "수형설명"].map((k) => {
    const i = hdr.indexOf(k);
    if (i < 0) throw new Error(`컬럼 없음: ${k} (있는 컬럼: ${hdr.join(", ")})`);
    return i;
  });

  // 부품이 사전에 없으면 화면에 그림을 못 띄운다 → 그런 규칙은 넣지 않는다(빈칸 대신 아예 안 보여줌).
  const known = new Set();
  for (const e of JSON.parse(readFileSync("data/ksl-dict.json", "utf8"))) {
    known.add(e.word);
    for (const a of e.aliases || []) known.add(a);
  }

  const out = {};
  let raw = 0, badFormat = 0, missingPart = 0;
  for (const r of rows.slice(1)) {
    if (!(r[iCombo] || "").trim()) continue;
    raw++;
    const parts = parseCombo(r[iCombo]);
    if (!parts) { badFormat++; continue; }
    if (!parts.every((p) => known.has(p))) { missingPart++; continue; }
    // 한국어 대응표현은 "퇴학,퇴교" 처럼 동의어 묶음 — 전부 같은 합성으로 넣는다.
    for (const w of (r[iWord] || "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!out[w]) out[w] = { parts, desc: (r[iDesc] || "").trim() };
    }
  }

  writeFileSync("data/ksl-compounds.json", JSON.stringify(out));
  console.log(`결합정보 ${raw}건 → 형식탈락 ${badFormat} · 부품이 사전에 없음 ${missingPart}`);
  console.log(`ksl-compounds.json — 표제어 ${Object.keys(out).length}개 (그림까지 다 띄울 수 있는 것만)`);
  console.log("예시:", Object.entries(out).slice(0, 5).map(([w, v]) => `${w}=${v.parts.join("+")}`).join(" · "));
}

const arg = process.argv[2];
if (arg === "--selftest") selftest();
else if (arg) build(arg);
else console.error("사용법: node scripts/build-compounds.mjs \"<CSV 경로>\" | --selftest");
