// 빌드타임 수집: kcisa 통합 수어정보 API → data/ksl-dict.json (정적 스냅샷).
// 실행:  node scripts/fetch-ksl.mjs <serviceKey> [numOfRows]
// 자가검증: node scripts/fetch-ksl.mjs --mock   (네트워크·키 없이 매핑 로직만)
//
// 키(문화공공데이터광장/kcisa 이메일로 받은 서비스키)는 로컬에서만 쓰이고
// 결과 JSON에는 안 들어감 → 정적 배포에 키 노출 없음.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// 공식 샘플: ...API_CNV_054/request?serviceKey={키}&numOfRows=10&pageNo=1&keyword=&collectionDb=
// ⛔ keyword·collectionDb 는 **빈 값이라도 반드시 포함**해야 한다(kcisa 공식 주의사항).
//    빼면 0건이 오는데 키 문제와 구분이 안 된다.
// 통합본은 일상생활수어 + 전문용어수어 + 문화정보수어를 한 번에 준다. 2025-04-25 에
// signDescription·signImages 가 추가됐고, **문화정보수어는 국립국어원 미제공이라 값이 공백**이다.
// ⚠️ 옛 엔드포인트는 일상생활 수어만이었다: /openapi/service/rest/meta13/getCTE01701
const ENDPOINT = "https://api.kcisa.kr/API_CNV_054/request";
// ⚠️ 실측(2026-09-04): numOfRows 를 1000 으로 줘도 **서버가 100건만 준다.**
//    그래서 "요청량보다 적게 오면 끝"이라는 판정은 **첫 페이지에서 즉시 끝난다** —
//    실제로 3,622개짜리 사전을 98개로 덮어썼다. 종료는 **빈 페이지**로만 판정한다.
const PER_PAGE = 100;

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
    // 통합본에서 온 분류. 옛 엔드포인트 응답에는 없어서 undefined 가 되고, 그 경우 키가 빠진다.
    ...(item.collectionDb ? { signType: decodeEntities(item.collectionDb) } : {}),
    ...(item.categoryType ? { category: decodeEntities(item.categoryType) } : {}),
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
    if (!it.word) continue;
    // ⛔ 이미지 없는 항목은 넣지 않는다 — 이 파일은 **이미지 사전**이고, 통합본의 문화정보수어는
    //    signImages 가 공백이라 그대로 두면 그림 없는 카드가 섞인다. 텍스트만 있는 표제어는
    //    data/ksl-fulldict.json 이 따로 담고 앱이 런타임에 병합한다(이미지 우선).
    if (it.media.src.length === 0) continue;
    // 표제어+수형(이미지)으로 중복 판정 → 완전 동일만 스킵, 같은 표제어의 다른 수형(이형태)은 보존.
    const sig = it.word + "\u0000" + it.media.src.join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
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
      { title: "학교", alternativeTitle: "배움터", signDescription: "지붕 모양.", signImages: "https://x/s1.jpg",
        collectionDb: "일상생활수어", categoryType: "교육" },
      // 통합본의 문화정보수어: 국립국어원 미제공이라 signImages 가 공백으로 온다 → 들어오면 안 된다.
      { title: "국립한글박물관", description: "박물관 안내.", signImages: "",
        collectionDb: "문화정보수어", categoryType: "국립 한글 박물관" },
    ] } } },
  };
  const dj = toDict(parseItems(JSON.stringify(jsonFixture)));
  a(dj.length === 2, "이미지 없는 문화정보수어는 제외 → 2개");
  a(!dj.some((e) => e.word === "국립한글박물관"), "signImages 공백 항목이 사전에 안 들어간다");
  a(dj[1].signType === "일상생활수어" && dj[1].category === "교육", "collectionDb·categoryType 캡처");
  a(!("signType" in dj[0]), "분류가 없는 옛 응답에는 키를 만들지 않는다");
  a(dj[0].word === "승려" && dj[0].aliases[0] === "스님", "title 쉼표 → word+aliases");
  a(dj[0].description === "4‧5지를 편다.", "엔티티 디코드");
  a(dj[0].media.src.every((u) => u.startsWith("https://")), "http → https 승격");
  a(dj[0].media.src.length === 2, "json signImages split");
  a(dj[1].aliases[0] === "배움터", "alternativeTitle → aliases");

  const xmlFixture = `<?xml version="1.0"?><response><body><items>
    <item><title>물</title><signDescription><![CDATA[손가락으로 입을 가리킨다.]]></signDescription>
      <signImages>https://x/water1.jpg,https://x/water2.jpg</signImages></item>
    <item><title>물</title><signDescription><![CDATA[중복 항목.]]></signDescription>
      <signImages>https://x/water1.jpg,https://x/water2.jpg</signImages></item>
    <item><title>물</title><signImages>https://x/water-variant.jpg</signImages></item>
    <item><title>불</title><signImages>https://x/fire1.jpg</signImages></item>
  </items></body></response>`;
  const dx = toDict(parseItems(xmlFixture));
  a(dx.length === 3, "xml: 완전중복 제거 + 변이(다른 수형) 보존 → 물×2 + 불");
  a(dx.filter((e) => e.word === "물").length === 2, "물 이형태 2개 보존");
  a(dx[0].word === "물" && dx[0].description.includes("입"), "xml CDATA description");
  a(dx[0].media.src.length === 2, "xml signImages split");

  // 페이징 종료 조건: 마지막 페이지는 요청량보다 적게 온다.
  // ⛔ 2026-09-04 회귀: 서버가 numOfRows 를 100 으로 깎으면 "요청량보다 적다"가 매 페이지 참이라
  //    첫 페이지에서 끝났고, 3,622개 사전을 98개로 덮어썼다. 그 조건이 되살아나면 여기서 죽는다.
  a(pageDone(100, 100, 0) === false, "서버가 요청량을 깎아도 계속 읽는다(회귀 방지)");
  a(pageDone(100, 100, 3622) === false, "totalCount 에 못 미치면 계속 읽는다");
  a(pageDone(0, 3622, 0) === true, "빈 페이지면 끝이다");
  a(pageDone(100, 3622, 3622) === true, "totalCount 를 채우면 끝이다");
  a(pageDone(100, 3700, 3622) === true, "totalCount 를 넘겨도 끝이다");

  // 덮어쓰기 방어: 같은 사고가 다시 나면 파일이 아니라 여기서 죽는다.
  a(shrankTooMuch(98, 3622) === true, "사전이 통째로 줄면 안 쓴다");
  a(shrankTooMuch(3700, 3622) === false, "늘어나는 것은 통과");
  a(shrankTooMuch(3600, 3622) === false, "소폭 감소는 통과(상류에서 몇 개 빠질 수 있다)");
  a(shrankTooMuch(98, 0) === false, "기준선이 없으면(첫 수집) 통과");

  console.log("mock OK — json:", dj.length, "xml:", dx.length);
}

// 한 페이지 호출 → item 배열. (keyword 부분검색은 이 API에서 미동작하므로 전체 수집 방식 사용)
async function fetchPage(serviceKey, numOfRows, pageNo) {
  // keyword=·collectionDb= 는 빈 값이라도 반드시 포함 (kcisa 주의사항).
  const url = `${ENDPOINT}?serviceKey=${serviceKey}&numOfRows=${numOfRows}&pageNo=${pageNo}&keyword=&collectionDb=`;
  const res = await fetch(url);
  const text = await res.text();
  let items;
  try {
    items = parseItems(text) || [];
  } catch (e) {
    writeFileSync("scripts/last-response.txt", text);
    console.error("파싱 실패:", e.message, "→ scripts/last-response.txt 확인");
    process.exit(1);
  }
  if (items.length === 0) {
    // 0건 원인 진단: 응답 헤더 메시지 노출(점검 중/키 오류 등). resultCode 9999 = 서비스 점검.
    const pick = (re) => (text.match(re) || [])[1] || "";
    const code = pick(/<resultCode>([\s\S]*?)<\/resultCode>/) || pick(/"resultCode"\s*:\s*"?([^",}]*)/);
    const msg = pick(/<resultMsg>([\s\S]*?)<\/resultMsg>/) || pick(/"resultMsg"\s*:\s*"([^"]*)"/);
    writeFileSync("scripts/last-response.txt", text);
    if (code || msg) console.error(`API 응답 [${code || "?"}] ${msg || "(메시지 없음)"} → scripts/last-response.txt`);
  }
  const tc = Number((text.match(/<totalCount>(\d+)<\/totalCount>/) || text.match(/"totalCount"\s*:\s*"?(\d+)/) || [])[1] || 0);
  return { items, totalCount: tc };
}

// 전체 수집. ⛔ 한 번에 다 달라고 하지 않는다 — 개발 계정은 **일 1,000건 제한**이고
// 통합본은 일상생활+전문용어+문화정보를 합쳐 주므로 옛 방식(numOfRows=100000)으로는
// 한도에 걸리거나 잘린 응답을 조용히 받는다. 마지막 페이지는 요청량보다 적게 온다.
// ⚠️ 순수 함수로 뺀다 — 페이징 종료 판정은 네트워크 없이 재야 회귀를 잡는다.
// ⛔ **요청량과 비교하지 않는다.** 서버가 numOfRows 를 자기 상한으로 깎으면 매 페이지가
//    "요청량보다 적게" 오므로 첫 페이지에서 끝나 버린다(2026-09-04 실측 사고).
//    빈 페이지만이 끝의 증거다. totalCount 를 주면 그것도 함께 본다.
const pageDone = (received, collected, totalCount) =>
  received === 0 || (totalCount > 0 && collected >= totalCount);

// ⛔ 2026-09-04 사고 방어: 페이징이 조용히 일찍 끝나면 사전 전체가 작아진 채로 덮인다
//    (3,622개 → 98개). 종료 조건 하나에 기대지 않고 **쓰기 직전에 개수를 대조**한다.
//    정말 줄어야 하는 날에는 기존 파일을 지우고(또는 옮기고) 다시 돌린다 — 기준선이 없으면 통과한다.
const MIN_KEEP_RATIO = 0.9; // ponytail: 상한 없는 증가는 허용. 감소만 막는다.
const shrankTooMuch = (next, prev) => prev > 0 && next < prev * MIN_KEEP_RATIO;

async function fetchAll(serviceKey, perPage) {
  const all = [];
  let total = 0;
  for (let pageNo = 1; ; pageNo++) {
    const { items, totalCount } = await fetchPage(serviceKey, perPage, pageNo);
    if (totalCount > 0) total = totalCount;
    all.push(...items);
    process.stdout.write(`\r수신 ${all.length}${total ? "/" + total : ""}건 (page ${pageNo})`);
    if (pageDone(items.length, all.length, total)) break;
    // 개발 계정은 일 1,000건 제한이라 상한도 그 근처에 둔다.
    if (pageNo >= 1000) { console.error("\n페이지 상한 초과 — 응답이 끝나지 않는다"); process.exit(1); }
  }
  process.stdout.write("\n");
  return all;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--mock")) return runMock();

  const serviceKey = args.find((a) => !a.startsWith("--"));
  const num = args.find((a) => /^\d+$/.test(a));
  if (!serviceKey) {
    console.error("사용법:\n" +
      "  node scripts/fetch-ksl.mjs <serviceKey>        전체 사전 수집(통합 수어정보)\n" +
      "  node scripts/fetch-ksl.mjs <serviceKey> 200    페이지당 200건으로 수집\n" +
      "  node scripts/fetch-ksl.mjs --mock              자가검증\n" +
      "\n키는 문화공공데이터광장(culture.go.kr) 활용신청 → data@kcisa.kr 메일로 온다.");
    process.exit(1);
  }

  const items = await fetchAll(serviceKey, Number(num) || PER_PAGE);
  if (!items || items.length === 0) {
    console.error("항목 0개. 키 미반영(최대 1시간)·오류응답 가능 → scripts/last-response.txt 확인.");
    process.exit(1);
  }

  const dict = toDict(items); // word 기준 dedupe
  const out = "data/ksl-dict.json";
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")).length : 0;
  if (shrankTooMuch(dict.length, prev)) {
    console.error(`중단: 기존 ${prev}개 → 수집 ${dict.length}개로 줄었다. 덮어쓰지 않았다.\n` +
      "페이징이 일찍 끝났을 가능성이 높다 → scripts/last-response.txt 와 수신 건수를 먼저 본다.\n" +
      `정말 줄어야 하면 ${out} 을 옮기고 다시 돌린다.`);
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(dict, null, 2) + "\n");
  console.log(`data/ksl-dict.json 생성: ${dict.length}개 표제어 (수신 ${items.length}건, 중복 제거)`);
}

main();
