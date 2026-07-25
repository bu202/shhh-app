// 전체 한국수어사전(13,950) 텍스트 수집: data.go.kr odcloud Open API → data/ksl-fulldict.json.
// 이미지가 아닌 "수형설명 텍스트"만 있는 사전. 앱이 이미지 사전(ksl-dict.json)과 런타임 병합(이미지 우선).
// 실행:  node scripts/fetch-fulldict.mjs <일반인증키(Decoding)>
//        node scripts/fetch-fulldict.mjs --mock   (매핑 로직만 검증)
//
// 데이터셋: 문화체육관광부 국립국어원_한국수어사전_한국어대응표현정보 (data.go.kr/15135637)
import { writeFileSync } from "node:fs";

const NAMESPACE = "15135637/v1";
const UDDI = "uddi:c3cf1016-16ae-4080-825f-f43ffdd2832b";
const PER_PAGE = 1000;

const splitList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

// odcloud row → 내부 스키마 { word, aliases, description, signId }. 필드명 바뀌면 여기만 수정.
function normalizeRow(r) {
  const words = splitList(r["한국어 대응표현"]);
  return {
    word: words[0] || "",
    aliases: words.slice(1),
    description: (r["수형설명"] || "").trim(),
    signId: r["수어 표제어 번호"] ?? null, // sldict 이미지 역추적용(별도 작업)
  };
}

// 표제어+수형설명으로 중복판정 → 완전 동일만 스킵, 같은 단어 다른 수형(이형태)은 보존.
function toDict(rows) {
  const seen = new Set();
  const out = [];
  for (const it of rows.map(normalizeRow)) {
    if (!it.word) continue;
    const sig = it.word + " " + it.description;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(it);
  }
  return out;
}

function runMock() {
  const rows = [
    { "한국어 대응표현": "복직,복임", "수형설명": "두 주먹을 …", "수어 표제어 번호": 24705 },
    { "한국어 대응표현": "복직,복임", "수형설명": "두 주먹을 …", "수어 표제어 번호": 24705 }, // 완전중복
    { "한국어 대응표현": "학교", "수형설명": "지붕 모양.", "수어 표제어 번호": 100 },
    { "한국어 대응표현": "학교", "수형설명": "다른 수형.", "수어 표제어 번호": 101 }, // 이형태
  ];
  const d = toDict(rows);
  const a = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  a(d.length === 3, "완전중복 제거 + 이형태 보존");
  a(d[0].word === "복직" && d[0].aliases[0] === "복임", "대응표현 쉼표 → word+aliases");
  a(d.filter((e) => e.word === "학교").length === 2, "학교 이형태 2개");
  console.log("mock OK —", d.length, "entries");
}

async function fetchAll(key) {
  const all = [];
  for (let page = 1; ; page++) {
    const url = `https://api.odcloud.kr/api/${NAMESPACE}/${UDDI}?page=${page}&perPage=${PER_PAGE}&serviceKey=${key}`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.code) { console.error("API 오류:", j.code, j.msg); process.exit(1); }
    all.push(...(j.data || []));
    process.stdout.write(`\r수신 ${all.length}/${j.totalCount}`);
    if (all.length >= j.totalCount || !j.data?.length) break;
  }
  process.stdout.write("\n");
  return all;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--mock")) return runMock();
  const key = args.find((a) => !a.startsWith("--"));
  if (!key) { console.error("사용법: node scripts/fetch-fulldict.mjs <일반인증키(Decoding)>"); process.exit(1); }

  const rows = await fetchAll(key);
  const dict = toDict(rows);
  writeFileSync("data/ksl-fulldict.json", JSON.stringify(dict) + "\n");
  console.log(`data/ksl-fulldict.json 생성: ${dict.length}개 (수신 ${rows.length}건)`);
}

main();
