// 빌드타임 수집: kcisa 일상생활 수어 API → data/ksl-dict.json (정적 스냅샷).
// 실행:  node scripts/fetch-ksl.mjs <serviceKey> [numOfRows]
// 자가검증: node scripts/fetch-ksl.mjs --mock   (네트워크·키 없이 매핑 로직만)
//
// 키(문화공공데이터광장/kcisa 이메일로 받은 서비스키)는 로컬에서만 쓰이고
// 결과 JSON에는 안 들어감 → 정적 배포에 키 노출 없음.
import { writeFileSync } from "node:fs";

// 공식 샘플: ...getCTE01701?serviceKey={키}&numOfRows=100&pageNo=1&keyword=
// (주의: keyword는 빈 값이라도 반드시 포함해야 함)
const ENDPOINT = "https://api.kcisa.kr/openapi/service/rest/meta13/getCTE01701";

const splitList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const httpsify = (u) => u.replace(/^http:\/\//i, "https://"); // 혼합콘텐츠 방지
// 이중 인코딩된 HTML 엔티티 디코드 (&amp;#8231; → ‧ 등).
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .trim();
}

// --- API 교체 이음새 (seam) ---
// kcisa item 1건 → 내부 스키마 { word, aliases, description, media:{type,src} }.
// 실제 응답 필드명이 다르면 여기만 고치면 됨.
function normalizeEntry(item) {
  // title은 "승려,스님"처럼 동의어가 쉼표로 묶임 → 첫 단어=word, 나머지=aliases.
  const titles = splitList(item.title).map(decodeEntities);
  const aliases = [...titles.slice(1), ...splitList(item.alternativeTitle).map(decodeEntities)];
  const images = splitList(item.signImages).map(httpsify);
  const src = images.length ? images : (item.referenceIdentifier ? [httpsify(item.referenceIdentifier)] : []);
  return {
    word: titles[0] || "",
    aliases,
    description: decodeEntities(item.signDescription || item.description || ""),
    media: { type: "images", src },
  };
}

// JSON 응답 껍데기에서 item 배열 추출 (실제 중첩이 달라도 여기 1곳만 조정).
function extractJsonItems(json) {
  const body = json?.response?.body ?? json?.body ?? json;
  let items = body?.items?.item ?? body?.items ?? body?.item ?? [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  return items;
}

// XML 응답에서 <item> 블록별 필드 추출. 필드값은 평문/CDATA 뿐이라 정규식으로 충분.
// ponytail: naive XML 파서. item 내부에 중첩 태그가 생기면 정식 파서로 교체.
function parseXmlItems(xml) {
  const clean = (v) => v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const obj = {};
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) obj[f[1]] = clean(f[2]);
    items.push(obj);
  }
  return items;
}

// JSON/XML 자동 판별 → item 배열. 판별 불가면 null.
function parseItems(text) {
  const t = text.trimStart();
  if (t[0] === "{" || t[0] === "[") return extractJsonItems(JSON.parse(text));
  if (t[0] === "<") return parseXmlItems(text);
  return null;
}

function toDict(items) {
  const seen = new Set();
  const out = [];
  for (const it of items.map(normalizeEntry)) {
    if (!it.word || seen.has(it.word)) continue; // 표제어 없거나 중복 스킵
    seen.add(it.word);
    out.push(it);
  }
  return out;
}

// --- 자가검증 (--mock): JSON·XML 매핑/추출/dedupe 확인 ---
function runMock() {
  const a = (c, msg) => { if (!c) { console.error("FAIL:", msg); process.exit(1); } };

  const jsonFixture = {
    response: { body: { items: { item: [
      { title: "승려,스님", signDescription: "4&amp;#8231;5지를 편다.",
        signImages: "http://sldict/x1.jpg,http://sldict/x2.jpg" },   // 쉼표 title + 엔티티 + http
      { title: "학교", alternativeTitle: "배움터", signDescription: "지붕 모양.", signImages: "https://x/s1.jpg" },
    ] } } },
  };
  const dj = toDict(parseItems(JSON.stringify(jsonFixture)));
  a(dj.length === 2, "json count");
  a(dj[0].word === "승려" && dj[0].aliases[0] === "스님", "title 쉼표 → word+aliases");
  a(dj[0].description === "4‧5지를 편다.", "엔티티 디코드");
  a(dj[0].media.src.every((u) => u.startsWith("https://")), "http → https 승격");
  a(dj[0].media.src.length === 2, "json signImages split");
  a(dj[1].aliases[0] === "배움터", "alternativeTitle → aliases");

  const xmlFixture = `<?xml version="1.0"?><response><body><items>
    <item><title>물</title><signDescription><![CDATA[손가락으로 입을 가리킨다.]]></signDescription>
      <signImages>https://x/water1.jpg,https://x/water2.jpg</signImages></item>
    <item><title>물</title><signImages>https://x/dup.jpg</signImages></item>
    <item><title>불</title><signImages>https://x/fire1.jpg</signImages></item>
  </items></body></response>`;
  const dx = toDict(parseItems(xmlFixture));
  a(dx.length === 2, "xml dedupe (물 중복 제거)");
  a(dx[0].word === "물" && dx[0].description.includes("입"), "xml CDATA description");
  a(dx[0].media.src.length === 2, "xml signImages split");

  console.log("mock OK — json:", dj.length, "xml:", dx.length);
}

// 한 번 호출 → item 배열. (keyword 부분검색은 이 API에서 미동작하므로 전체 수집 방식 사용)
async function fetchItems(serviceKey, numOfRows) {
  // keyword= 는 빈 값이라도 반드시 포함 (kcisa 주의사항).
  const url = `${ENDPOINT}?serviceKey=${serviceKey}&numOfRows=${numOfRows}&pageNo=1&keyword=`;
  const res = await fetch(url);
  const text = await res.text();
  try {
    return parseItems(text) || [];
  } catch (e) {
    writeFileSync("scripts/last-response.txt", text);
    console.error("파싱 실패:", e.message, "→ scripts/last-response.txt 확인");
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--mock")) return runMock();

  const serviceKey = args.find((a) => !a.startsWith("--"));
  const num = args.find((a) => /^\d+$/.test(a));
  if (!serviceKey) {
    console.error("사용법:\n" +
      "  node scripts/fetch-ksl.mjs <serviceKey>        전체 사전 수집(약 3700+)\n" +
      "  node scripts/fetch-ksl.mjs <serviceKey> 200    상위 200개만\n" +
      "  node scripts/fetch-ksl.mjs --mock              자가검증");
    process.exit(1);
  }

  // 기본은 전체 수집. numOfRows 크게 주면 서버가 totalCount까지만 반환.
  const items = await fetchItems(serviceKey, num || 100000);
  if (!items || items.length === 0) {
    console.error("항목 0개. 키 미반영(최대 1시간)·오류응답 가능 → scripts/last-response.txt 확인.");
    process.exit(1);
  }

  const dict = toDict(items); // word 기준 dedupe
  writeFileSync("data/ksl-dict.json", JSON.stringify(dict, null, 2) + "\n");
  console.log(`data/ksl-dict.json 생성: ${dict.length}개 표제어 (수신 ${items.length}건, 중복 제거)`);
}

main();
