// 일상어를 앱에 통째로 먹여 "앱이 지금 뭐라 답하나"를 등급별로 가른다.
//
// 재는 것: ① 사람이 영상으로 확인했나 ② 어느 수형인지 정해졌나 ③ 사용자가 친 말과 카드 이름이
// 같은가 ④ 사전에 있는데 지화로 떨어지진 않나(밥 유형).
//
// ⛔ **이 도구는 "실제 수어와 같은가"를 판정하지 않는다.** 그건 영상을 보는 사람 몫이다
//    (CLAUDE.md: Claude 를 검증자로 세우지 않는다). 여기서 나오는 건 **사람이 볼 순서**다.
//
//   node scripts/audit-signs.mjs            # 등급별 요약 + 목록
//   node scripts/audit-signs.mjs --md       # 문서용 표
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAppState } from "./_app.mjs";

// 연인·친구가 실제로 칠 만한 말. 사전 표제어가 아니라 **사람이 치는 말**을 모은다.
const WORDS = `
안녕 안녕하세요 잘가 잘자 좋은아침 반가워 오랜만이야 고마워 감사합니다 미안해 죄송합니다
사랑해 좋아해 보고싶어 보고싶다 그리워 사랑 결혼하자 결혼 뽀뽀 안아줘 데이트 자기야 여보
밥 밥먹었어 밥먹자 먹다 배고파 배불러 맛있다 맛없다 물 커피 술 소주 맥주 라면 치킨 점심
저녁 아침 간식 요리 카페 식당
어디야 뭐해 뭐야 언제 누구 왜 어떻게 몇시 오늘 내일 어제 지금 나중에 주말 휴일 시간
집 학교 회사 지하철 버스 택시 자동차 병원 화장실 편의점 마트 공원 바다 산 여행
피곤해 졸려 아파 힘들다 괜찮아 괜찮다 심심해 재밌어 재미있다 슬퍼 화났어 우울해 신난다
행복해 무서워 놀랐어 부끄러워 외로워 심각해 답답해 짜증나
미쳤다 대박 진짜 정말 완전 너무 조금 많이 빨리 천천히 조심해 위험해 잠깐 그만 하지마
안돼 돼 맞아 아니야 몰라 알았어 그래 응 아니 좋아 싫어 최고 별로
예쁘다 귀엽다 멋있다 잘생겼다 못생겼다 크다 작다 뚱뚱하다 날씬하다 키크다
돈 비싸다 싸다 사다 팔다 선물 생일 축하해 파티 게임 영화 음악 노래 춤 운동 공부 일 숙제
전화 문자 카톡 사진 유튜브 인터넷 컴퓨터 핸드폰
엄마 아빠 언니 오빠 형 누나 동생 친구 가족 아기 남자 여자 사람 선생님
날씨 비 눈 바람 덥다 춥다 따뜻하다 시원하다 봄 여름 가을 겨울
자다 일어나 씻다 입다 가다 오다 앉다 서다 걷다 뛰다 웃다 울다 말하다 듣다 보다 읽다 쓰다
힘내 화이팅 응원 축하 고생했어 수고했어 잘했어 미안 사과 용서 약속 비밀 거짓말 진심
`.trim().split(/\s+/);

const ver = existsSync("data/ksl-verified.json") ? JSON.parse(readFileSync("data/ksl-verified.json", "utf8")) : {};

const APP = await loadAppState("COMPOUNDS, matchSentence, norm, deconjugate");
const { norm } = APP;
const INDEX = APP.index();
const imgId = (e) => ((e.media?.src?.[0] || "").match(/IMG\d+/) || [""])[0];
const bare = (s) => String(s).split("@")[0];

// app.js 의 unpinnedCandidates 와 같은 규칙: 수형 설명이 서로 다른 후보가 둘 이상이면 미확정.
const unpinned = (w) => {
  if (String(w).includes("@")) return []; // 사람이 수형을 못박았다 — 이 줄을 빼면 대장 항목이 전부 '미확정'으로 샌다
  const c = INDEX.get(norm(bare(w))) || [];
  return c.length >= 2 && new Set(c.map((e) => e.description)).size > 1 ? c : [];
};

// 지화로 떨어진 말이 **말끝만 바꾸면 사전에 닿는가**. 닿으면 사전이 아니라 **활용 규칙**이 구멍이다
// (신난다→신나다, 답답해→답답하다). 사전에 없어서 못 찾는 것과 원인이 달라 고치는 자리도 다르다.
const VARIANTS = (w) => {
  const v = [w + "다", w + "하다"];
  const last = w.slice(-1), head = w.slice(0, -1);
  if (last === "해") v.push(head + "하다");
  if (last === "다" && /[ㄴ은는]/.test("") === false) v.push(head.slice(0, -1) + "다"); // 신난다→신나다 꼴
  if (/[아어여]$/.test(last)) v.push(head + "다", head + "하다");
  if (/[았었였]/.test(last) || /[았었였]/.test(head.slice(-1))) v.push(w.replace(/[았었였]\w?$/, "다"));
  // 종성만 떼기: 난→나 (신난다 → 신나다)
  const code = w.codePointAt(w.length - 2);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const j = (code - 0xac00) % 28;
    if (j) v.push(w.slice(0, -2) + String.fromCodePoint(code - j) + last);
  }
  return [...new Set(v)].filter((x) => x !== w);
};
const reachable = (w) => VARIANTS(w).filter((v) => INDEX.has(norm(v)));

// 지화로 떨어진 말에 **사전이 실제로는 갖고 있는** 근사어가 있나(밥 유형 탐지).
// 판정이 아니라 **사람이 볼 후보**다 — 2-gram 겹침으로 줄만 세운다.
const grams = (s) => new Set([...s].map((_, i) => s.slice(i, i + 2)).filter((g) => g.length === 2));
function nearby(word, n = 3) {
  const g = grams(word);
  const out = [];
  for (const [k, arr] of INDEX) {
    if (k.length < 2 || Math.abs(k.length - word.length) > 2) continue;
    const h = grams(k);
    let hit = 0;
    for (const x of g) if (h.has(x)) hit++;
    if (!hit) continue;
    const score = (2 * hit) / (g.size + h.size);
    if (score >= 0.34) out.push({ key: k, word: arr[0].word, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

// 앱이 그 말에 답한 결과를 등급으로 가른다.
function grade(word) {
  const toks = APP.matchSentence(word);
  const hits = toks.filter((t) => t.type !== "unknown");
  const jamo = toks.filter((t) => t.type === "unknown");

  if (ver[word]) {
    const v = ver[word];
    return { g: "A", why: (v.labels || v.parts).join(" + "), note: `${v.by} · ${v.checked}` };
  }
  if (!hits.length) {
    const r = reachable(word);
    if (r.length) return { g: "D1", why: "전부 지화", note: `말끝만 바꾸면 닿음 → ${r.map((x) => `${x}=[${INDEX.get(norm(x))[0].word}]`).join(" · ")}` };
    const near = nearby(word);
    return near.length
      ? { g: "D2", why: "전부 지화", note: `사전에 이 말을 품은 표제어가 있음 → ${near.map((n) => `${n.key}${n.key === n.word ? "" : `(${n.word})`}`).join(" · ")}` }
      : { g: "E", why: "전부 지화", note: "사전에 근사어 없음" };
  }
  if (jamo.length) {
    return { g: "C", why: toks.map((t) => (t.type === "unknown" ? `지화'${t.text}'` : `[${label(t)}]`)).join(" + "), note: "" };
  }
  // 전부 잡혔다. 위험 순으로 다시 가른다.
  const amb = hits.flatMap((t) => (t.type === "entry" ? unpinned(t.text) : (t.combo.parts || []).flatMap(unpinned)));
  if (amb.length) return { g: "B1", why: hits.map(label).map((x) => `[${x}]`).join(" + "), note: `수형 ${amb.length}개 중 미확정` };

  const auto = hits.find((t) => t.type === "compound" && !t.combo.verified);
  if (auto) return { g: "B3", why: hits.map(label).map((x) => `[${x}]`).join(" + "), note: "자동 추출 합성(미검증)" };

  // 별칭으로 잡힌 것: 사용자가 친 말과 표제어가 다르다 → 카드가 '축하 (식)' 처럼 뜬다.
  const alias = hits.filter((t) => t.type === "entry" && norm(t.entries[0].word) !== norm(t.text));
  if (alias.length) return { g: "B2", why: hits.map(label).map((x) => `[${x}]`).join(" + "), note: `별칭 매칭 → 표제어 '${alias[0].entries[0].word}'` };

  return { g: "B0", why: hits.map(label).map((x) => `[${x}]`).join(" + "), note: hits.length > 1 ? "여러 장" : "" };
}
const label = (t) => (t.type === "compound" ? (t.combo.labels || t.combo.parts.map(bare)).join(" + ") : t.entries[0].word);

const GRADES = {
  A: "사람이 영상으로 확인함 — 안전",
  B0: "표제어 하나로 잡힘 · 수형도 하나 — 영상 대조만 남음",
  B2: "별칭으로 잡힘 — 사용자가 친 말 ≠ 표제어 (오해 위험)",
  B1: "수형이 여럿인데 미확정 — 화면이 '확인 안 됨'을 붙인다",
  B3: "자동 추출 합성 — 사람이 확인 안 함",
  C: "조각 섞임 — 지화와 손짓이 뒤섞임 (⛔ 최우선)",
  D1: "지화로 떨어지지만 **말끝만 바꾸면 사전에 있음** — 활용 규칙 구멍 (⛔ 최우선, 코드로 고침)",
  D2: "지화로 떨어지고 표제어도 없지만 **합성어 안에 그 말이 있음** — 밥 유형 (영상 확인 후 대장)",
  E: "전부 지화이고 사전에도 없음 — 사전 한계",
};
const ORDER = ["C", "D1", "D2", "B1", "B3", "B2", "B0", "A", "E"];

function main() {
  const md = process.argv.includes("--md");
  const rows = WORDS.map((w) => ({ w, ...grade(w) }));
  const by = (g) => rows.filter((r) => r.g === g);

  console.log(`# 일상어 ${WORDS.length}개 — 앱이 지금 뭐라 답하나\n`);
  console.log("| 등급 | 뜻 | 건수 |");
  console.log("|---|---|---|");
  for (const g of ORDER) console.log(`| ${g} | ${GRADES[g]} | ${by(g).length} |`);

  for (const g of ORDER) {
    const list = by(g);
    if (!list.length) continue;
    console.log(`\n## ${g} — ${GRADES[g]} (${list.length})\n`);
    if (md) {
      console.log("| 친 말 | 앱의 답 | 비고 |\n|---|---|---|");
      for (const r of list) console.log(`| ${r.w} | ${r.why} | ${r.note} |`);
    } else {
      for (const r of list) console.log(`  ${r.w.padEnd(8)} ${r.why}${r.note ? "   — " + r.note : ""}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(); // 함정 20·53: 하단 실행 가드
