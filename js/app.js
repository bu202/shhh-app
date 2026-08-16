"use strict";

// --- API 교체 이음새 (seam) ---
// mock 사전과 실제 kcisa API 응답을 같은 내부 스키마로 정규화.
// 실제 키 발급 후에는 이 함수 하나만 바꾸면 됨. 내부 스키마:
//   { word, aliases:[], description, media: { type: "images"|"video", src } }
function normalizeEntry(raw) {
  return raw;
}

let DICT = [];
let INDEX = new Map(); // 표제어/alias(정규화) -> entry[] (동음이의 전부 보유, 표제어 먼저)
let MAX_KEY = 1;       // 최장 키 길이 (그리디 스캔 상한)

function norm(s) {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function buildIndex(dict) {
  const idx = new Map();
  let max = 1;
  const add = (key, e) => {
    const k = norm(key);
    if (!k) return;
    let arr = idx.get(k);
    if (!arr) idx.set(k, (arr = []));
    if (!arr.includes(e)) arr.push(e); // 동음이의 누적. 표제어 루프가 먼저라 표제어가 배열 앞.
    if (k.length > max) max = k.length;
  };
  for (const e of dict) add(e.word, e);                       // 표제어 먼저(후보 배열 앞자리)
  for (const e of dict) for (const a of e.aliases || []) add(a, e); // 별칭 뒤
  // 괄호는 뜻이 아니라 **동음이의 구분표**다: `(신체의)눈`·`(마시는)차`·`(시설물)다리`.
  // 그대로만 색인하면 사용자가 치는 `눈`·`차`·`모자`가 사전에 없는 말이 되어 지화로 떨어졌다.
  // 표제어는 안 바꾼다 — 카드에 `(신체의)눈` 이라고 뜨는 게 어느 수형인지 말해주기 때문이다.
  //
  // ⚠️ **별칭보다 뒤에 둔다.** 앞에 두면 이미 답이 있던 12개의 답이 바뀐다 — 재보니 좋아지는 것
  //    (`다리` [남대문]→[(시설물)다리])과 나빠지는 것(`닫다` [폐쇄]→[(입을)닫다], `맞추다`
  //    [일치]→[(음식에 간을)맞추다], `지르다` [고함]→[(불을)지르다])이 섞여 있었다. 어느 쪽이
  //    맞는지는 **판단**이고 판단은 사람 몫이라, 지금은 **아무도 답하지 않던 자리만** 채운다.
  for (const e of dict) if (/[()]/.test(e.word)) add(e.word.replace(/\([^)]*\)/g, ""), e);
  INDEX = idx;
  MAX_KEY = max;
}

async function loadDictionary() {
  const res = await fetch("data/ksl-dict.json");
  if (!res.ok) throw new Error("dict load failed: " + res.status);
  const dict = (await res.json()).map(normalizeEntry);
  // 전체 수어사전(수형설명 텍스트, 이미지 없음) 병합 — 이미지 사전에 없는 표제어만 추가(이미지 우선).
  try {
    const full = await fetch("data/ksl-fulldict.json");
    if (full.ok) {
      const known = new Set(dict.map((e) => e.word));
      for (const r of await full.json()) {
        if (known.has(r.word)) continue; // 이미지 있는 단어는 그림 우선. 텍스트 이형태도 첫 것만.
        known.add(r.word);
        dict.push({ word: r.word, aliases: r.aliases || [], description: r.description, media: { type: "images", src: [] } });
      }
    }
  } catch { /* 전체 사전 파일 없으면 이미지 사전만 사용 */ }
  return dict;
}

// 합성 수어: 단일 손짓이 없고 두 수어를 이어서 표현하는 말. 예 헌금 = 바치다 + 돈.
// data.go.kr 15135637 '결합정보' 컬럼 → scripts/build-compounds.mjs 가 생성.
let DICT_SUB = "단어를 손으로"; // 헤더 부제 — 사전 로드 후 개수로 채워진다
let COMPOUNDS = new Map(); // 정규화 표제어 -> { parts:[표제어], labels?, source? }
let PREFERRED = new Map(); // 정규화 표제어 -> IMG id. 사람이 영상으로 확인하며 고른 대표 수형.
async function loadCompounds() {
  // 자동 추출본을 먼저 깔고, 사람이 영상으로 확인한 것(ksl-verified.json)으로 덮어쓴다.
  // 사람이 이긴다 — 자동 추출은 사전에 있는 말만 알고, 사전에 없는 말(보고싶다)은 못 본다.
  for (const [path, verified] of [["data/ksl-compounds.json", false], ["data/ksl-verified.json", true]]) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      // 키도 문장과 똑같이 정규화한다. matchSentence 가 conjugationNormalize(norm(text)) 로 훑으므로
      // 그 위에서 찾으려면 키도 같은 처리를 거쳐야 한다. (보고싶다 → 보다싶다 ← 보고싶어)
      for (const [w, v] of Object.entries(await res.json())) {
        COMPOUNDS.set(conjugationNormalize(norm(w)), { ...v, verified, word: w });
        // 사람이 영상을 보며 고른 수형은 **그 표제어의 대표**로도 쓴다. 안 하면 '보다'를 그냥
        // 검색했을 때 사전 순서상 조사 '~보다'가 먼저라 조사 수형이 대표로 떴다(⛔ 위반).
        // 자동 추출본의 핀은 쓰지 않는다 — 그건 그 합성어 안에서의 수형이지 표제어의 대표가 아니다.
        if (verified) for (const p of v.parts) {
          const [pw, pin] = String(p).split("@");
          if (pin) PREFERRED.set(norm(pw), pin);
        }
      }
    } catch { /* 파일 없으면 그 단계만 건너뜀 */ }
  }
}

// 홈의 '오늘의 수어' 후보 목록(표제어 문자열). null 이면 아직 안 읽은 것 —
// 그땐 사전 전체에서 고른다. 홈이 통째로 비는 것보다 낫다고 보고 폴백을 남겼다.
let DAILY = null;
async function loadDaily() {
  try {
    const res = await fetch("data/ksl-daily.json");
    if (res.ok) DAILY = new Set(await res.json());
  } catch { /* 파일이 없으면 종전대로 사전 전체에서 고른다 */ }
}

// 화면에 쓸 뜻 = **이 손짓 하나가 나타내는 한국어 말들**(국어원 사전의 「한국어 대응표현」).
// 사전 문장이 아니라 낱말 몇 개다: 내키다 → "싶다 · 바라다 · 소원 · 바람 · 욕구". 뜻을 확인하는
// 데는 이게 문장보다 빠르고, 이미 사전 데이터에 들어 있어 새로 받아올 것이 없다.
//
// ⚠️ 지어낸 뜻이 아니다(⛔ 1번) — 국어원이 이 수형에 붙여 놓은 말 그대로다. 없으면 빈 문자열이고
//    뜻 줄이 아예 안 뜬다. 없는 걸 채우지 않는다.
// 대응표현이 **없을 때만** 표준국어대사전 뜻풀이로 채운다(`data/ksl-meanings.json`).
// 대응표현이 있으면 그게 이긴다 — 국어원이 이 수형에 붙여 놓은 말이라 더 정확하다.
// 커버리지: 대응표현만이면 12,799 중 2,217(17%), 뜻풀이를 얹으면 3,717(29%).
// 그림 있는 표제어로 좁히면 3,478 중 1,556 → **2,081(60%)**.
// ⚠️ 뜻풀이는 **낱말의 뜻이지 그 수형의 뜻이 아니다**(함정 47). 한 낱말에 수형이 여럿인 자리에서
//    어느 뜻이 어느 수형인지 국어사전은 모른다. 그래서 동형어가 여럿이면 수집기가 **비워 둔다**.
// 카드 이름에 이미 뜬 말(사용자가 친 말·표제어)은 뺀다. '원하다 (내키다)' 밑에 또 '내키다'가
// 오면 같은 말을 두 줄에서 읽게 된다.
let MEANINGS = null;
async function loadMeanings() {
  try {
    const res = await fetch("data/ksl-meanings.json");
    if (res.ok) MEANINGS = await res.json();
  } catch { /* 없으면 대응표현만 쓴다 — 뜻 줄이 덜 뜰 뿐 앱은 온전히 돈다 */ }
}
function meaningOf(entry, key) {
  if (!entry) return "";
  const shown = new Set([bare(key || ""), entry.word]);
  // 붙임표가 붙은 것(-애, -러)은 낱말이 아니라 조어 요소라 뜻 자리에서 안 읽힌다 —
  // '사랑' 의 대응표현이 '-애' 하나뿐이라 카드에 "사랑 / -애" 가 떴다. 전체 4,401개 중 35개다.
  // 단 **표제어 자신이 어미면 그대로 둔다**(-습니다 → -ㅂ니다). 거기선 그게 맞는 답이다.
  const boundHead = entry.word.startsWith("-");
  const alias = (entry.aliases || [])
    .filter((a) => !shown.has(a) && (boundHead || !/^-|-$/.test(a)))
    .join(" · ");
  return alias || (MEANINGS?.[entry.word] ?? "");
}

// 표제어 매칭 뒤에 붙는 한글 활용 어미/일부 조사. 별도 수어로 내지 않고 흡수(미안"해"→년 오매칭 방지).
// ponytail: 형태소 분석기($0 vanilla 불가)의 대용 휴리스틱. 하다-활용 + 안전한 다음절 조사만.
//           단음절 조사(은/는/이/가…)는 단어 첫음절과 흔히 충돌해 일부러 제외. 오작동 시 이 목록만 손봄.
const ENDINGS = [
  // 하-활용
  "했습니다", "하겠습니다", "하였다", "합니다", "했어요", "하세요", "해요", "했어", "했다",
  "하니까", "하는데", "하지만", "하면서", "하려고", "하겠다", "하겠어요",
  "해서", "하고", "하는", "하지", "하게", "해도", "하면", "한다", "하다", "해",
  // 청유 '하자'. 없으면 결혼"하자" 의 뒤가 표제어 **하자(瑕疵, 흠)** 에 걸려 카드가 두 장 뜬다 — ⛔ 위반.
  // 매칭 뒤에만 흡수하므로 '하자' 를 홀로 치면 그대로 표제어가 나온다.
  "하자",
  // 격식/서술
  "습니다", "입니다", "이에요", "예요", "이다", "였다",
  // 과거·존대
  "었습니다", "았습니다", "였습니다", "었어요", "았어요", "였어요", "었어", "았어", "였어", "었다", "았다",
  "겠습니다", "겠어요", "세요", "셨어요", "으세요",
  // 의문·종결
  "습니까", "나요", "까요", "은가요", "는가요", "잖아요", "잖아", "거든요", "거든",
  "어요", "아요", "네요", "군요", "지요", "죠",
  // 연결어미
  "지만", "는데", "은데", "으니까", "니까", "으려고", "려고", "으면서", "면서", "어서", "아서", "여서",
  // 조사(다음절 위주 — 단음절은 단어 첫음절과 충돌해 제외)
  "에서", "에게서", "에게", "한테서", "한테", "으로", "부터", "까지", "처럼", "만큼", "밖에", "라도", "마다", "보다",
  "다", // ← 종결어미. 매칭 뒤에만 흡수하므로 "다리"(단어)는 안전. (없으면 간"다"→모두 오매칭)
  "요", // ← 존대 어미. 없으면 고마워"요"·잘자"요"의 끝 글자가 지화로 떨어진다.
  "야", // ← 반말 종결. 없으면 최고"야"·어디"야"의 끝 글자가 지화로 떨어진다.
].sort((a, b) => b.length - a.length); // 최장 우선
function stripEnding(s, i) {
  for (const end of ENDINGS) if (s.startsWith(end, i)) return end.length;
  return 0;
}
// ⚠️ **어미 흡수 앞에 "여기서 다음 말이 시작하나"를 묻는 안은 재보고 버렸다**(2026-08-08).
//    '안돼 하지마' 는 고쳐지지만(어미 "하지" 가 별칭 '하지 마'=[그만] 의 앞부분을 먹고 있었다),
//    같은 검사가 **맞던 것 3건을 깬다**: 감사합니다 → [감사합니다]+[거행] 카드 두 장,
//    기다려 → [다리미질], 내가 → [해내다]. 어미 목록과 표제어가 겹치는 게 예외가 아니라 흔한 일이라,
//    이 자리에서 사전을 한 번 더 보면 얻는 것보다 잃는 것이 많다. 1:3 이었다.
// 활용 정규화: 격식체·구문을 사전 표제어(다-형)로. 반갑습니다→반갑다, 보고싶다→보다+싶다.
// ponytail: 형태소 분석 없는 최소 규칙. 감사합니다(완전표제) → 감사하다→감사(하다 흡수)로 바뀌나 뜻은 유지.
function conjugationNormalize(s) {
  return s
    .replace(/합니다/g, "하다")
    .replace(/습니다/g, "다")
    .replace(/고싶/g, "다싶")          // V고싶다 → V다+싶다 (보고싶다→보다싶다, 먹고싶다→먹다싶다)
    .replace(/싶었어요|싶었습니다|싶었어|싶었다|싶어요|싶어/g, "싶다"); // 싶다 활용 정규화(과거형 포함)
}

// 어간이 변하는 활용형 → 표제어(다-형) 후보들. ENDINGS 는 어미를 떼기만 해서 이걸 못 푼다.
// 고마워→고맙다(ㅂ불규칙), 기다려→기다리다, 배고파→배고프다(ㅡ탈락), 괜찮아→괜찮다, 보고파→보다싶다.
// 안 고치면 그리디가 표제어를 못 찾고 1글자로 떨어져 배고파=배(선박)+고+파(대파) 가 된다.
// 과생성(만나→만느다)은 사전에 없어서 그냥 버려지므로 무해하다 — 조회가 곧 검증이다.
//
// 후보를 **여럿** 내는 이유: 'V고파'(보고파=보고 싶어)와 'ㅡ탈락'(배고파=배고프다)이 같은 글자에
// 걸린다. 하나만 내면 배고파를 살리려다 보고파가 죽고, 그 반대도 마찬가지다. 앞에서부터 사전에
// 있는 것을 쓴다 — conjugationNormalize 로는 못 한다(문장 전체를 미리 바꿔서 배고파가 먼저 망가진다).
const syl = (c, v, t) => String.fromCharCode(0xac00 + (c * 21 + v) * 28 + t);
const jamo = (ch) => { const n = ch.charCodeAt(0) - 0xac00; return n < 0 || n > 11171 ? null : [Math.floor(n / 588), Math.floor((n % 588) / 28), n % 28]; };
function deconjugate(w) {
  if (w.length < 2) return [];
  const out = [];
  const last = w.slice(-1), head = w.slice(0, -1);
  const prev = jamo(head.slice(-1));                                          // 앞 글자의 자모(받침을 봐야 하는 규칙들이 쓴다)
  if (last === "워") { const p = jamo(head.slice(-1)); if (p && !p[2]) out.push(head.slice(0, -1) + syl(p[0], p[1], 17) + "다"); } // 고마워→고맙다
  if (last === "려") out.push(head + "리다");                                  // 기다려→기다리다
  // 르-불규칙: 모르+아 → 몰라 처럼 어간의 '르' 가 'ㄹ+ㄹ' 로 갈라진다. 앞 글자의 ㄹ 받침을 떼고 '르다' 를 붙여 되돌린다.
  // 없으면 몰라·목말라·배불러가 전부 지화로 떨어진다(사전엔 모르다·목마르다·배부르다가 다 있는데도).
  if ((last === "라" || last === "러") && prev && prev[2] === 8) out.push(head.slice(0, -1) + syl(prev[0], prev[1], 0) + "르다");
  // 과거 았/었: 앞 글자에 ㅆ 받침이 있으면 그 자리가 과거다. 되돌리는 길이 둘인데 **같지 않다**.
  //  ① ㅆ만 떼면 앞 글자의 모음이 어간에 남는다 — 화났어→화나다, 지냈어→지내다.
  //  ② 그 글자를 통째로 떼면 어간이 자음으로 끝난다 — 알았어→알다, 늦었어→늦다.
  // ②를 아무 데나 쓰면 **지냈어가 '지다'(패배)로 떨어진다** — 사전에 있는 말이라 조회로 안 걸러지고,
  // 지화로 떨어지던 말이 틀린 수어로 단정된다(⛔). 그래서 ②는 그 글자가 **정확히 았/었/였**일 때만.
  // (았/었/였 = 초성 ㅇ + 중성 ㅏ/ㅓ/ㅕ + 종성 ㅆ. 났·냈처럼 초성이 있으면 그 자음이 어간의 것이다.)
  // ③ 그 자리 모음이 ㅕ 면 어간이 'ㅣ' 였던 것이 어미 '어' 와 붙어 줄어든 것이다 — 미쳤어→미치다.
  //    (기다려→기다리다 규칙이 ㄹ 에만 하던 일을 자음 전체로 넓힌 것이다.)
  //    이게 없으면 사전에 미치다가 **있는데도** '미쳤어'가 통째로 지화로 떨어진다.
  const pastStem = (h, p) => {
    const o = [h.slice(0, -1) + syl(p[0], p[1], 0) + "다"];                    // ① 화났어→화나다, 지냈어→지내다
    if (p[0] === 11 && (p[1] === 0 || p[1] === 4 || p[1] === 6)) o.push(h.slice(0, -1) + "다"); // ② 알았어→알다
    if (p[1] === 6) o.push(h.slice(0, -1) + syl(p[0], 20, 0) + "다");          // ③ 미쳤어→미치다
    return o;
  };
  if ((last === "아" || last === "어") && prev && prev[2] === 20) out.push(...pastStem(head, prev));
  // 과거 + 종결 '다' 도 같은 자리다: 미쳤다·화났다. 어미 목록의 '었다/았다' 는 앞 글자가 정확히
  // 었/았일 때만 걸려서 '쳤다·났다' 를 못 뗀다.
  if (last === "다" && prev && prev[2] === 20) out.push(...pastStem(head, prev));
  if (last === "아" || last === "어") out.push(head + "다");                    // 괜찮아→괜찮다, 먹어→먹다
  const p = jamo(last);                                                       // 고파→고프다, 예뻐→예쁘다
  if (p && !p[2] && (p[1] === 0 || p[1] === 4)) out.push(head + syl(p[0], 18, 0) + "다");
  if (last === "자") out.push(head + "다");                                    // 놀자→놀다, 가자→가다(청유)
  if (last === "이") out.push(head + "다");                                    // 많이→많다 (부사 파생)
  if (last === "히") out.push(head + "하다");                                   // 천천히→천천하다, 조용히→조용하다
  if (last === "돼") out.push(head + "되다");                                   // 안돼→안되다
  if (w.endsWith("고파")) out.push(w.slice(0, -2) + "다싶다");                  // 보고파→보다싶다(=보고싶다 합성 키)
  // 어간 그대로 + 다. **맨 뒤에 둔다** — 가장 헐거운 규칙이라 위의 구체적인 규칙이 먼저 이겨야 한다.
  // 이게 없으면 '일어나'가 표제어를 못 찾고 한 칸 짧은 '일어'(일본어)로 떨어졌다 — ⛔ 위반이었다.
  out.push(w + "다");                                                          // 일어나→일어나다, 만나→만나다
  // ⚠️ **1글자 후보는 버린다.** matchSentence 의 1글자 가드는 *부분 문자열* 길이만 보고
  //    활용 후보는 안 본다. 과거 규칙이 '재밌어'의 '밌어'에서 후보 "다" 를 냈고, 1글자 표제어
  //    "다"(=모두)에 걸려 **재밌어 = 지화'재' + [모두]** 가 떴다(함정 16 이 막으려던 바로 그 부류).
  //    어간+다 는 언제나 두 글자 이상이라 잃는 것이 없다.
  return out.filter((k) => k.length > 1);
}

// 두 조각이 화면에 **같은 그림**을 그리는가. 타입만으로는 못 가린다 — 대장 항목 `밥`(합성 1부품)과
// 표제어 `먹다` 는 종류가 다른데 같은 수형이다. 그려질 사전 항목까지 풀어서 견준다.
const signEntries = (p) =>
  p.type === "entry" ? [p.entries[0]]
  : p.type === "compound" ? p.combo.parts.map((x) => lookup(x))
  : null;
function sameSign(a, b) {
  const x = signEntries(a), y = signEntries(b);
  return !!x && !!y && x.length === y.length && x.every((e, i) => e && e === y[i]);
}

// 최장일치 그리디. 띄어쓰기 무관 스캔. 매칭 뒤 활용 어미는 흡수.
// 반환: [{type:"entry", entries:[...], text} | {type:"unknown", text}] 순서대로.
// ponytail: 매 위치 최대 MAX_KEY까지 substring 조회 → O(n·MAX_KEY). 커지면 트라이로 교체.
function matchSentence(text) {
  const s = conjugationNormalize(norm(text));
  const out = [];
  let i = 0, unknown = "";
  const flush = () => { if (unknown) { out.push({ type: "unknown", text: unknown }); unknown = ""; } };

  while (i < s.length) {
    let hit = null, len = 0;
    for (let L = Math.min(MAX_KEY, s.length - i); L >= 1; L--) {
      const key = s.slice(i, i + L);
      const keys = [key, ...deconjugate(key)];
      // 문장 안에서 1글자 표제어는 잡지 않는다. 1글자 키가 394개인데 를·는·의·해 같은
      // 조사·어미까지 섞여 있어 거의 언제나 오답이 된다(잘자=잘하다+사람, 힘내=기운+자신).
      // 틀린 수어를 단정하느니 지화로 떨어지는 게 낫다(⛔ 실제 수어만 보여준다).
      const solo = L === 1 && s.length > 1;
      const e = solo ? null : keys.reduce((h, k) => h || INDEX.get(k), null);
      if (e) { hit = { type: "entry", entries: e }; len = L; break; }
      // 같은 길이면 단일 표제어 우선. 사전에 없는 말만 합성으로 받는다.
      const c = keys.reduce((h, k) => h || COMPOUNDS.get(k), null);
      // 1글자 가드는 **색인의 잡동사니**를 막으려던 것이지 사람의 판정을 막으려던 게 아니다.
      // 사람이 영상으로 확인해 대장에 적은 말(`verified`)은 1글자여도 잡는다 — 안 그러면
      // '밥'을 확인해 넣어도 '밥먹었어'에서는 여전히 지화로 떨어져 대장이 반만 듣는다.
      // 자동 추출 합성은 여기서 제외한다. 그건 사람이 확인한 것이 아니라 같은 위험을 그대로 진다.
      if (c && (!solo || c.verified)) { hit = { type: "compound", combo: c }; len = L; break; }
    }
    if (hit) {
      flush();
      // 잇달아 같은 손짓이 나오면 한 장으로 합친다. '밥 먹었어' 는 대장이 밥=[먹다] 라고 적어 둔
      // 뒤로 [먹다] 카드가 두 장 떴는데, 같은 손짓을 두 번 하라는 건 **다른 말**이다(⛔).
      // 앞의 것이 붙들고 있던 글자는 살려서 화면 이름이 사용자가 친 말 그대로이게 한다.
      const prevHit = out[out.length - 1];
      if (prevHit && sameSign(prevHit, hit)) {
        prevHit.text += s.slice(i, i + len);
        i += len + stripEnding(s, i + len);
        continue;
      }
      out.push({ ...hit, text: s.slice(i, i + len) });
      i += len + stripEnding(s, i + len); // 표제어 뒤 활용 어미 흡수
    } else { unknown += s[i]; i += 1; }
  }
  flush();
  return out;
}

// --- 지화(한글 지문자) 분해 ---
// 자모 -> Wikimedia Commons 파일명(로마자). 32장 세트에 있는 base 자모만.
const JAMO_IMG = {
  "ㄱ":"g","ㄴ":"n","ㄷ":"d","ㄹ":"r","ㅁ":"m","ㅂ":"b","ㅅ":"s","ㅇ":"ng",
  "ㅈ":"j","ㅊ":"ch","ㅋ":"k","ㅌ":"t","ㅍ":"p","ㅎ":"h","ㅆ":"ss",
  "ㅏ":"a","ㅐ":"ae","ㅑ":"ya","ㅒ":"yae","ㅓ":"eo","ㅔ":"e","ㅕ":"yeo","ㅖ":"ye",
  "ㅗ":"o","ㅛ":"yo","ㅜ":"u","ㅠ":"yu","ㅡ":"eu","ㅣ":"i","ㅚ":"oe","ㅟ":"wi","ㅢ":"ui"
};
// 초/중/종성 인덱스 -> base 자모 문자열(된소리는 겹침, 겹받침·이중모음은 성분으로 분해).
// ponytail: 된소리 ㄲ=ㄱㄱ 근사 표기 [?] — 실제 현행 표준과 미세차이 가능.
const CHO = ["ㄱ","ㄱㄱ","ㄴ","ㄷ","ㄷㄷ","ㄹ","ㅁ","ㅂ","ㅂㅂ","ㅅ","ㅆ","ㅇ","ㅈ","ㅈㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅗㅏ","ㅗㅐ","ㅚ","ㅛ","ㅜ","ㅜㅓ","ㅜㅔ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
const JONG = ["","ㄱ","ㄱㄱ","ㄱㅅ","ㄴ","ㄴㅈ","ㄴㅎ","ㄷ","ㄹ","ㄹㄱ","ㄹㅁ","ㄹㅂ","ㄹㅅ","ㄹㅌ","ㄹㅍ","ㄹㅎ","ㅁ","ㅂ","ㅂㅅ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

// 문자열 -> 자모 배열. 지화 불가(이미지 없는 자모/비한글 포함) 시 null.
function decomposeToJamo(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const s = code - 0xac00;
      const parts = CHO[Math.floor(s / 588)] + JUNG[Math.floor((s % 588) / 28)] + JONG[s % 28];
      for (const j of parts) out.push(j);
    } else if (JAMO_IMG[ch]) {
      out.push(ch);           // 이미 낱자 자모
    } else {
      return null;            // 숫자·영문·기호 등 → 지화 불가
    }
  }
  return out.every((j) => JAMO_IMG[j]) ? out : null;
}

// --- 렌더 ---
let playTimers = [];
function stopPlayers() { playTimers.forEach(clearInterval); playTimers = []; }

// 카드 DOM 생성(textContent로 XSS 안전, 플레이어 인라인 연결).
// mean 은 이 손짓이 나타내는 말들(선택). 단어와 손모양 설명 **사이**에 둔다 — 사용자가 확인하고
// 싶은 건 "내가 친 말이 그 말이 맞나"라서, 손을 어떻게 움직이는지보다 먼저 읽혀야 한다.
//
// 손모양 설명은 **접어서** 낸다. 줄여 쓰는 길은 재보고 버렸다(2026-08-08): 어느 손가락·어느 방향·
// 몇 번인지가 다 필요한 정보라 한 조각만 빼도 **다른 손짓**이 된다(⛔ 2번). 실제로 규칙 셋을
// 30건에 돌려 봤더니 — 첫 절만 남기면 동작 절반이 사라지고('소주'가 코 잡는 데서 끝난다),
// 방향 수식절을 지우면 손가락 목록까지 잘려 "두 주먹의 1·하복부에 댄다" 같은 틀린 손모양이 나오고,
// 글자 수로 자르면 말 중간에서 끊긴다. 접기는 **아무것도 안 버리면서** 카드를 짧게 만든다.
function card(word, desc, frames, cls, mean) {
  // 시안 순서: 그림 → 단어 → 뜻 → 설명. 손모양이 먼저 눈에 들어와야 한다.
  const el = document.createElement("div");
  el.className = "card" + (cls ? " " + cls : "");
  if (frames) {
    const img = document.createElement("img");
    img.className = "frame"; img.alt = word + " 수형"; el.appendChild(img);
    startPlayer(img, frames);
  }
  const w = document.createElement("p");
  w.className = "word"; w.textContent = word; el.appendChild(w);
  if (mean) {
    const m = document.createElement("p");
    m.className = "mean"; m.textContent = mean; el.appendChild(m);
  }
  if (desc && cls !== "unsupported") {
    const d = document.createElement("details");
    d.className = "desc";
    const s = document.createElement("summary");
    // 그림이 없는 표제어에는 지화(글자를 손으로 쓴 것)를 보여준다. 그게 이 말의 손짓이라고
    // 읽히면 ⛔ 위반이라, 설명을 접어도 **그 사실만은 접히지 않게** 여는 줄에 적는다.
    s.textContent = cls === "text-sign" ? "손모양 설명 — 그림이 없어 지화로 보여줘요" : "손모양 설명";
    const p = document.createElement("p");
    p.textContent = desc;
    d.append(s, p); el.appendChild(d);
  } else if (desc) {
    // '미지원' 카드의 글은 손모양 설명이 아니라 왜 못 보여주는지에 대한 답이다. 접으면 카드가
    // 이유 없이 비어 보인다.
    const p = document.createElement("p");
    p.className = "desc"; p.textContent = desc; el.appendChild(p);
  }
  return el;
}

function startPlayer(img, frames) {
  img.src = frames[0];
  if (frames.length > 1) {
    let i = 0;
    playTimers.push(setInterval(() => {
      i = (i + 1) % frames.length;
      img.src = frames[i];
    }, 800));
  }
}

function entryFrames(entry) {
  const src = entry.media.src;
  if (src && src.length) return entry.media.type === "images" ? src : [src];
  // 이미지 없는 텍스트 표제어(전체 사전) → 지화로 시각 표현. 지화 불가면 null(텍스트만).
  const jamo = decomposeToJamo(entry.word);
  return jamo ? jamoFrames(jamo) : null;
}
function jamoFrames(jamo) {
  return jamo.map((j) => "assets/fingerspelling/" + JAMO_IMG[j] + ".jpg");
}

// 주소에서 온 문자열을 푼다. **decodeURIComponent 는 던진다** — `#q=%E0%A4%A` 같은 반쪽 인코딩이면
// URIError 가 나는데, 그게 main() 안에서 나면 그 뒤가 통째로 안 돈다: 로그인·친구 초기화가
// appReadyFns 로 뒤에 붙어 있어서 **링크 하나로 앱을 반쯤 죽일 수 있었다.**
// 길이도 여기서 막는다 — 해시는 아무나 만들어 보내는 값이라 메가바이트짜리도 온다.
// ⚠️ 주소에서 온 값을 innerHTML 에 넣지 않는다. 쓰는 곳은 input.value 와 사전 조회뿐이다.
//
// ⚠️ **아래 손가락 표기 블록 앞에 둔다.** scripts/test-fingers.mjs 는 그 선언부터 첫 `}` 까지를
//    정규식으로 떼어 쓴다. 사이에 함수를 끼우면 블록이 거기서 잘려 namedFingers 가 통째로
//    안 잡히고, 선언 이름을 주석에 그대로 적어도 정규식이 **주석을 먼저 잡는다**(둘 다 겪었다).
const MAX_HASH = 4096;
function safeDecode(s) {
  if (typeof s !== "string" || s.length > MAX_HASH) return "";
  try { return decodeURIComponent(s); } catch { return ""; }
}

// 한국수어 수형 표기의 손가락 번호는 상식과 반대다: 1지=검지 … 5지=엄지.
// 그대로 보여주면 "4지"를 약지로 읽는다(실제로는 새끼). 사전 설명의 84%가 이 표기를 쓴다.
const FINGERS = ["검지", "중지", "약지", "새끼", "엄지"];
const JOSA = { 를: "을", 는: "은", 가: "이" }; // "…손가락"은 받침으로 끝나 조사가 바뀐다
// 문자열을 HTML 에 넣기 전에. 이 앱에서 innerHTML 에 사전 문자열이 닿는 곳은 연습 해설 하나뿐이라
// 함수도 하나면 된다 — 새로 생기면 여기를 부른다(직접 이어 붙이지 말 것).
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function namedFingers(s) {
  return s
    .replace(/([1-5])(?:·([1-5]))*지/g, (m) =>
      m.slice(0, -1).split("·").map((n) => FINGERS[n - 1]).join("·") + "손가락")
    .replace(/손가락([를는가])/g, (_, j) => "손가락" + JOSA[j]);
}

// key = 화면에서 실제로 매칭된 말. 별칭으로 걸렸으면 둘 다 보여준다 —
// '축하해'를 쳤는데 카드에 '식'만 뜨면 사용자는 자기가 친 말과 다른 걸 본다.
// 합성 카드가 쓰는 "라벨 (표제어)" 형식과 같게 맞췄다.
function entryCard(e, key) {
  const noImg = !(e.media.src && e.media.src.length);
  const name = !key || key === e.word ? e.word : key + " (" + e.word + ")";
  // 뜻을 같이 보여주는 이유: 손모양만 보면 자기가 친 말이 그 말이 맞는지 확인할 길이 없다.
  // 동음이의 후보를 펼쳤을 때 어느 것을 고를지도 여기서 갈린다('참다'의 수형 3개).
  // 그림이 없다는 사실은 card() 가 접힘 줄에 적는다 — 접혀 있어도 보여야 하는 말이라서다.
  return card(name, namedFingers(e.description), entryFrames(e), noImg ? "text-sign" : "", meaningOf(e, key));
}

// 부품에 @핀이 없고 후보 수형이 여럿이면 앱은 **첫 후보를 임의로** 집는다(함정 14).
// 그걸 단정해서 보여주는 게 ⛔ 위반이었다. 어느 것인지 정해주지 못하더라도 정해지지 않았다는
// 사실과 나머지 후보는 보여줄 수 있다 — 검증 진도와 무관하게 화면이 정직해진다.
// 설명이 전부 같으면 어느 쪽을 집어도 같은 손모양이라 아무 문제가 없다(안전, 2026-08 기준 240건).
// 받침 있으면 "은", 없으면 "는". 표제어를 문장에 끼워 넣는 곳이면 어디든 필요하다("'참다'은" 이 떴다).
const eunNeun = (w) => (jamo(w.slice(-1))?.[2] ? "은" : "는");

function unpinnedCandidates(spec) {
  if (spec.includes("@")) return [];                       // 사람이 수형을 못박았다
  const c = INDEX.get(norm(bare(spec))) || [];
  if (c.length < 2) return [];
  return new Set(c.map((e) => e.description)).size > 1 ? c : [];
}

// 합성 수어를 ① ② … 순서대로. 부품이 사전에 있는 것만 빌드에 들어오므로 여기선 못 찾을 일이 없다.
function compoundGroup(word, combo, showHead = true) {
  const group = document.createElement("div");
  group.className = "token-group compound";
  // 영상에서 부르는 이름이 사전 표제어와 다를 수 있음(원하다/내키다). 없으면 부품 이름 그대로 —
  // parts 를 그대로 쓰면 @핀이 붙은 순간 "말@IMG000225447 (말)" 이 화면에 뜬다.
  const labels = combo.labels || combo.parts.map(bare);
  if (showHead) {
    const head = document.createElement("p");
    head.className = "note";
    const b = document.createElement("b");
    const parts = document.createElement("b");
    parts.className = "inline";
    parts.textContent = labels.join(" + ");
    // 부품이 늘 2개인 게 아니다 — 3개 이상이 333건, 1개(말끝만 떼면 되는 말)도 있다.
    // "두 수어"로 못박아 뒀더니 3부품 합성에서 화면이 틀린 말을 했다(⛔ 단정하지 않는다).
    if (labels.length === 1) {
      b.textContent = "말끝만 떼면 되는 말이에요";
      head.append(b, `'${word}'는 `, parts, " 하나로 표현해요.");
    } else {
      b.textContent = `${["", "", "두", "세", "네", "다섯"][labels.length] || labels.length} 수어를 이어서 표현해요`;
      head.append(b, `'${word}'는 하나의 손짓이 아니라 `, parts, "입니다.");
    }
    group.appendChild(head);
  }
  // 사람이 영상으로 확인한 것과 사전에서 기계로 뽑은 것을 구분한다. 안 하면 둘이 똑같아 보인다.
  if (!combo.verified) {
    const warn = document.createElement("p");
    warn.className = "note bad";
    const b = document.createElement("b");
    b.textContent = "아직 사람이 확인하지 않았어요";
    warn.append(b, "국어원 사전의 결합 정보에서 기계로 뽑은 조합이에요. 실제로 쓰는 표현과 다를 수 있으니 영상으로 한 번 확인하고 쓰세요.");
    group.appendChild(warn);
  }
  const unsure = [];
  group.appendChild(cardRow(combo.parts.map((p, n) => {
    const e = lookup(p); // @핀이 붙어 있으면 그 수형으로. 동음이의가 있는 표제어(보다) 때문에 필요.
    if (!e) return null;
    const cands = unpinnedCandidates(p);
    if (cands.length) unsure.push({ label: bare(p), cands });
    const name = labels[n] === bare(p) ? bare(p) : labels[n] + " (" + bare(p) + ")";
    // 순번은 이어서 하는 동작이 둘 이상일 때만. 하나뿐인데 ① 을 붙이면 목록처럼 읽힌다.
    const no = combo.parts.length > 1 ? "①②③④⑤"[n] + " " : "";
    return card(no + name, namedFingers(e.description), entryFrames(e), cands.length ? "unsure" : "", meaningOf(e, labels[n]));
  }).filter(Boolean)));
  for (const u of unsure) {
    const det = document.createElement("details");
    det.className = "alts";
    const sum = document.createElement("summary");
    sum.textContent = `'${u.label}'${eunNeun(u.label)} 수형이 ${u.cands.length}개예요 — 어느 것인지 확인 안 됐어요`;
    det.appendChild(sum);
    det.appendChild(cardRow(u.cands.map((e) => entryCard(e))));
    group.appendChild(det);
  }
  // 출처(영상 URL·채널)는 화면에 안 띄운다 — 근거는 data/ksl-verified.json 에 그대로 남아 있고,
  // verify.mjs --check 가 그걸 본다. 사용자 화면엔 "확인했다"는 사실만 있으면 된다.
  return group;
}

// 사람이 고른 수형(PREFERRED)이 있으면 그것을 대표(첫 후보)로 끌어올린다. 나머지 순서는 건드리지 않는다.
// 검색한 말이 별칭일 수 있어 키와 표제어 양쪽으로 찾는다.
function preferPinned(key, entries) {
  const id = PREFERRED.get(norm(key)) || entries.map((e) => PREFERRED.get(norm(e.word))).find(Boolean);
  if (!id) return entries;
  const i = entries.findIndex((e) => (e.media?.src?.[0] || "").includes(id));
  return i > 0 ? [entries[i], ...entries.filter((_, n) => n !== i)] : entries;
}

// 토큰 -> DOM 노드. 동음이의는 첫 후보를 대표로, 나머지는 "다른 뜻 N개" 안에.
function renderToken(token) {
  if (token.type === "compound") return compoundGroup(token.combo.word || token.text, token.combo);
  if (token.type === "entry") {
    const [primary, ...alts] = preferPinned(token.text, token.entries);
    const group = document.createElement("div");
    group.className = "token-group";
    group.appendChild(cardRow([entryCard(primary, token.text)]));
    // 사전에 그림이 있어도 합성으로 만들어진 말이면 어떻게 만들어졌는지 같이 보여준다(학습용).
    const combo = COMPOUNDS.get(norm(primary.word));
    if (combo) {
      const det = document.createElement("details");
      det.className = "alts";
      const sum = document.createElement("summary");
      // bare 로 @핀을 뗀다 — 안 떼면 "말@IMG000225447 + 만들다" 가 화면에 그대로 뜬다.
      sum.textContent = "어떻게 만들어졌나: " + (combo.labels || combo.parts.map(bare)).join(" + ");
      det.appendChild(sum);
      det.appendChild(compoundGroup(primary.word, combo, false));
      group.appendChild(det);
    }
    if (alts.length) {
      const det = document.createElement("details");
      det.className = "alts";
      const sum = document.createElement("summary");
      // 같은 표제어면 이형태(다른 수형), 다른 표제어면 다른 뜻.
      const sameWord = alts.every((a) => a.word === primary.word);
      sum.textContent = sameWord
        ? "다른 수형 " + alts.length + "개"
        : "다른 뜻 " + alts.length + "개 (" + alts.map((a) => a.word).join(", ") + ")";
      det.appendChild(sum);
      det.appendChild(cardRow(alts.map((a) => entryCard(a)))); // map 의 index 가 key 로 새면 "1 (해내다)" 가 된다
      group.appendChild(det);
    }
    return group;
  }
  // 미지원 단어: 하이브리드 — 지화 가능하면 지문자, 아니면 안내.
  const jamo = decomposeToJamo(token.text);
  if (jamo) return cardRow([card(token.text, "지문자(지화): " + jamo.join(" · "), jamoFrames(jamo), "finger")]);
  return cardRow([card("미지원: " + token.text, "지화로도 표현할 수 없는 문자예요.", null, "unsupported")]);
}

// 카드를 시안의 2열 그리드에 담는다. 하나뿐이면 한 칸을 다 쓴다(.one).
function cardRow(cards) {
  const row = document.createElement("div");
  row.className = "cards" + (cards.length === 1 ? " one" : "");
  cards.forEach((c) => row.appendChild(c));
  return row;
}

function renderResults(tokens) {
  stopPlayers();
  const box = document.getElementById("result");
  box.innerHTML = "";
  if (tokens.length === 0) {
    box.innerHTML = '<p class="hint">찾을 말을 입력하면 바로 표시돼요.<br>예: 보고싶어 · 사랑 · 고맙습니다</p>';
    lastWords = []; refreshStash();
    return;
  }
  for (const t of tokens) box.appendChild(renderToken(t));

  // 담기 대상: 화면에 뜬 그대로. 합성은 **부품으로 쪼개지 않고 한 덩어리로** 담는다 —
  // 쪼개면 '보고싶다'를 찾아 담았는데 단어장엔 보다·내키다만 남아 찾은 말이 사라진다.
  // 부품은 bookItem() 이 단어장·연습에서 다시 펼친다.
  lastWords = [...new Set(tokens.flatMap((t) =>
    t.type === "entry" ? [pinned(preferPinned(t.text, t.entries)[0])]
    : t.type === "compound" ? [t.combo.word || t.text] : []))];
  refreshStash();
}

async function main() {
  const status = document.getElementById("status");
  try {
    DICT = await loadDictionary();
    buildIndex(DICT);
    await Promise.all([loadCompounds(), loadDaily(), loadMeanings()]);
    DICT_SUB = DICT.length.toLocaleString() + "개 단어를 손으로";
    document.getElementById("screen-sub").textContent = DICT_SUB;
    status.textContent = "";
  } catch (e) {
    status.textContent = "사전 로드 실패: " + e.message;
    return;
  }
  setupIntro();

  const input = document.getElementById("input");
  const run = () => renderResults(matchSentence(input.value));
  const debouncedRun = debounce(run, 250);

  // 실시간 변환. IME 조합 중(e.isComposing)엔 건너뛰고 조합 완료 시 실행.
  input.addEventListener("input", (e) => { if (!e.isComposing) debouncedRun(); });
  input.addEventListener("compositionend", debouncedRun);

  setupWordbook();
  const go = setupTabs();
  go("home"); // 첫 화면. 링크(#q/#w)로 들어왔으면 바로 아래 openHash 가 옮긴다.

  // 링크로 들어온 것 처리. #w=단어장 / #q=단어 하나.
  // 앱을 열어둔 채 링크를 누르면 해시만 바뀌고 리로드가 안 된다 → hashchange 로도 받는다.
  // 조작된 해시로 앱 초기화가 멈추면 안 된다. 이 함수는 main() 안에서 불리고, 로그인·친구
  // 초기화(appReadyFns)가 **그 뒤에** 붙어 있어서 여기서 던지면 링크 하나로 앱이 반쯤 죽는다.
  const openHash = () => {
    try {
      const q = safeDecode((location.hash.match(/[#&]q=([^&]*)/) || [])[1] || "");
      if (q) { input.value = q; run(); go("dict"); }
      const added = mergeFromHash(); // 사전 로드 뒤라야 lookup 이 된다
      if (added) { go("book"); toast(`링크에서 ${added}개를 단어장에 담았어요`); }
    } catch (e) {
      console.warn("[hash]", e && e.message);   // 링크 하나가 앱 전체를 멈추게 두지 않는다
    }
    refreshStash();
  };
  addEventListener("hashchange", openHash);
  openHash();

  // 로그인 동기화는 **여기서** 시작한다. 사전이 서기 전에 서버 단어장을 받으면
  // replaceBook 의 bookItem 검사가 전부 실패해 담아둔 단어가 통째로 버려진다.
  // **등록 순서대로, 하나씩 기다려서** 부른다. friends.js 의 초대 링크 처리는 auth.js 가
  // 로그인 토큰을 세운 뒤라야 뜻이 있는데, 안 기다리면 아직 로그아웃 상태로 보고 되돌아간다.
  appReadyDone = true;
  // **하나가 죽어도 나머지는 돈다.** 예전엔 그냥 await 라, auth.js 가 조작된 해시에서 던지면
  // 뒤에 등록된 friends.js 가 통째로 안 붙었다 — 링크 하나로 앱을 반쯤 죽이는 자리였다.
  // 순서는 그대로 지킨다(friends 는 auth 가 토큰을 세운 뒤라야 뜻이 있다).
  for (const fn of appReadyFns) {
    try { await fn(); } catch (e) { console.warn("[appReady]", e && e.message); }
  }

  // 카메라(손 읽기)는 6단계로 미뤄 화면에서 뺐다. 검출·KNN 코드는 그대로 살아 있으니
  // #camera 마크업 + data-go="camera" 탭을 붙이고 setupSignInput() 을 켜면 다시 동작한다.
  // (모드 전환 전용 setupModes 는 지웠다 — 화면 전환은 setupTabs 하나로 한다.)
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ══ 우리 단어장 ══════════════════════════════════════════════════════
// 저장하는 건 표제어 문자열뿐. 뜻도 그림도 사전에서 다시 찾는다 —
// 사용자가 뜻을 정하지 않는다는 수칙(CLAUDE.md ⛔)이 자료구조에서부터 지켜지도록.
const BOOK_KEY = "shh-wordbook";
const FREE_LIMIT = 5; // 무료 단어장 상한. 프로면 무제한.

// ── 프로 상태 ────────────────────────────────────────────────────────
// 결제는 아직 붙이지 않았다. Play Billing 은 구매 승인(acknowledge)에 백엔드가 필요하고
// (안 하면 3일 뒤 자동 환불), 스토어에 서명된 빌드가 올라가야 동작해서 지금은 검증이 불가능하다.
// 그래서 지금은 상태와 벽만 만들고, 결제 호출은 requestPro() 한 곳으로 격리해 둔다.
// 5단계에서 여기만 Play Billing(getDigitalGoodsService + PaymentRequest)으로 바꾸면 된다.
const PRO_KEY = "shh-pro";
// ⚠️ **가격을 화면에 쓰지 않는다.** 예전엔 `₩4,900 / 월` 이 벽·담기 버튼·마이 화면 세 곳에 떴는데,
//    누르면 "결제는 앱(Play 스토어) 버전에서 열려요"로 끝났다 — 파는 물건이 없는데 값을 부르고,
//    사용자는 **넘어갈 방법이 없는 벽** 앞에 선다. 결제가 붙는 날 여기에 가격을 되살린다.
const PRO_PRICE = "";

// 베타 동안 무료 벽을 세우지 않는다. 이유는 하나 — **살 수 있는 것이 없기 때문**이다.
// 벽을 세워 두면 담기를 누른 사람이 결제도 못 하고 담지도 못하는 막다른 길에 갇힌다.
// 결제(5b Play Billing)가 붙는 날 이 한 줄을 `false` 로 되돌리면 벽이 그대로 돌아온다 —
// FREE_LIMIT·bookCost·upsell 은 손대지 않았다.
// ⚠️ 벽을 되살릴 때는 **서버가 판정하게** 같이 옮긴다. 지금 isPro 는 localStorage 라
//    콘솔 한 줄로 켤 수 있는데, 팔기 시작하는 순간 그게 그대로 구멍이 된다.
const BETA_NO_WALL = true;
// 마스터: **만든 사람의 계정**이라는 표시. 서버가 정하고(MASTER_UIDS), 로그인해야 켜진다 —
// 마스터는 계정 하나여야 하므로 브라우저에 심는 길은 두지 않는다(2026-08-08 에 코드 방식을 지웠다).
// 로컬에도 적어 둔다: 다음에 열 때 서버 응답을 기다리는 동안과 오프라인에서 이름이 '무료'로
// 깜빡이지 않게. 서버가 아니라고 하면 그때 꺼진다.
const MASTER_KEY = "shh-master";
let isMaster = localStorage.getItem(MASTER_KEY) === "1";
let isPro = isMaster || localStorage.getItem(PRO_KEY) === "1";
const limit = () => (BETA_NO_WALL || isPro ? Infinity : FREE_LIMIT);

// ⚠️ `?pro=1` 로 벽을 넘던 개발 코드는 **지웠다**(2026-08-11). 주소 하나로 유료 상태를 켤 수 있는데
//    화면은 가격을 말하고 있어서, 결제를 붙이는 순간 그대로 구멍이 된다. 개발 중에 벽 너머를 보려면
//    콘솔에서 `localStorage.setItem('shh-pro','1')` 하면 된다 — 코드로 열어 둘 이유가 없다.
//    진짜 해결(서버가 판정)은 결제가 붙을 때다. localStorage 를 직접 고치는 길은 그때까지 남는다.

// 서버가 정하는 상태. 로그인한 계정이 MASTER_UIDS 에 있으면 master, 그러면 pro 도 참이다.
// **로컬에도 적어 둔다** — 다음에 열 때 서버 응답을 기다리는 동안, 그리고 오프라인일 때도
// 벽이 다시 서면 안 되기 때문이다. 서버가 아니라고 하면 그때 꺼진다(서버가 최종 권한).
//
// pro 와 master 를 가른 이유: 지금은 마스터만 pro 지만, 결제가 붙으면 **산 사람도 pro** 가 된다.
// 그때 이름이 갈려야 화면이 "마스터"와 "프로"를 구분해 말할 수 있다.
// 함정 36: 함수 선언이라 Node 에서 평가돼도 안전하다 — 안 부르면 그만이다.
function setEntitlement(pro, master) {
  const nextMaster = !!master, nextPro = nextMaster || !!pro;
  if (isMaster === nextMaster && isPro === nextPro) return false;
  isMaster = nextMaster; isPro = nextPro;
  localStorage.setItem(MASTER_KEY, isMaster ? "1" : "0");
  localStorage.setItem(PRO_KEY, isPro ? "1" : "0");
  renderWordbook(); refreshStash();
  return true;
}

async function requestPro() {
  // ponytail: 5단계에서 여기에 Play Billing 을 넣는다. 그때까지는 정직하게 안내만 한다.
  //   1) window.getDigitalGoodsService("https://play.google.com/billing")
  //   2) service.getDetails([SKU]) → PaymentRequest → show()
  //   3) purchaseToken 을 백엔드로 보내 검증 + acknowledge  ← 서버가 필요한 지점
  //   4) service.listPurchases() 로 다른 기기 복원 (이건 서버 없이 됨)
  if (!("getDigitalGoodsService" in window)) {
    toast("결제는 앱(Play 스토어) 버전에서 열려요");
    return false;
  }
  toast("결제 준비 중이에요");
  return false;
}
let BOOK = (() => { try { return JSON.parse(localStorage.getItem(BOOK_KEY)) || []; } catch { return []; } })();

// ── 로그인 동기화가 붙는 자리 (js/auth.js) ─────────────────────────────
// auth.js 를 안 읽으면 null 로 남아 앱은 종전대로 기기 안에서만 돈다 — 로그인은 얹는 기능이지
// 단어장이 서 있는 조건이 아니다. 테스트도 이 상태로 돈다(함정 13: 최상위에서 window 를 만지지 않는다).
let bookChanged = null;
// ⚠️ **배열이어야 한다.** 예전엔 함수 하나만 들고 있었는데(`appReady = fn`), friends.js 가
//    붙는 순간 auth.js 가 등록해 둔 콜백을 덮어써서 **로그인이 통째로 안 돌았다**.
//    붙는 파일이 하나뿐일 땐 증상이 없는 종류의 버그다.
let appReadyFns = [], appReadyDone = false;
let saveGuard = null;
// 공유 버튼이 무엇을 보내는가. js/friends.js 가 붙으면 **친구 초대 링크**를 만든다.
// 안 붙으면(테스트·로그인 미사용) 종전의 단어장 링크(#w=)가 그대로 나간다.
let inviteLink = null;
// 화면이 바뀔 때마다 불린다. friends.js 가 단어장 화면의 갈래(내 것/친구)를 되살리는 데 쓴다.
// 이 훅이 없으면 friends.js 가 탭 버튼을 직접 뒤져야 하고, 탭을 하나 늘릴 때마다 두 파일을 고치게 된다.
let screenShown = null;
function onBookChanged(fn) { bookChanged = fn; }
function onInviteLink(fn) { inviteLink = fn; }
function onScreenShown(fn) { screenShown = fn; }
// 담기를 막을 수 있는 자리(로그인 게이트). 안 붙으면 종전대로 누구나 담는다.
function onSaveGuard(fn) { saveGuard = fn; }
const mayAddToBook = () => !saveGuard || saveGuard();
// 이미 준비가 끝난 뒤에 붙으면 그 자리에서 바로 부른다 — 스크립트 로드 순서에 기대지 않으려고.
function onAppReady(fn) { appReadyDone ? fn() : appReadyFns.push(fn); }

// quiet 는 **서버에서 받은 걸 되쓸 때**만 참이다. 안 가르면 서버 → 로컬 저장 → 다시 서버로 PUT 이 돈다.
const saveBook = (quiet) => {
  localStorage.setItem(BOOK_KEY, JSON.stringify(BOOK));
  if (!quiet) bookChanged?.(BOOK);
};
const bookHas = (w) => BOOK.includes(w);

// 다른 기기의 단어장으로 갈아끼운다. 사전에서 사라진 단어는 버린다 —
// 담을 때 bookItem 을 통과한 것만 들어오므로 꺼낼 때도 같은 문을 통과시킨다.
function replaceBook(words) {
  BOOK = words.filter((w) => bookItem(w));
  saveBook(true);
  renderWordbook(); refreshStash(); renderHome();
}

// 표제어 -> 사전 항목. 없으면 null(사전이 바뀌어 사라진 단어).
//
// ⚠️ 같은 표제어가 여러 수형으로 있다. '보다'는 [시각]과 [비교]가 둘 다 표제어 "보다"라서
//    첫 번째를 집으면 뜻이 다른 수어가 뜬다(⛔ 실제 수어만 보여준다 위반).
//    그래서 "보다@IMG000227009" 처럼 @뒤에 그림 파일 이름을 적어 수형을 못박을 수 있게 했다.
//    @가 없으면 종전대로 첫 후보. 못박은 그림이 사라졌으면 첫 후보로 떨어진다(빈 화면 대신).
const bare = (w) => w.split("@")[0];
// 단어장에 담을 때 쓰는 이름. 동음이의가 있는 표제어는 **화면에 뜬 그 수형**을 못박아 담는다 —
// 안 그러면 단어장·연습에서 다른 뜻의 수어로 바뀐다.
function pinned(e) {
  const id = ((e.media?.src?.[0] || "").match(/IMG\d+/) || [])[0];
  return id && (INDEX.get(norm(e.word)) || []).length > 1 ? e.word + "@" + id : e.word;
}
function lookup(w) {
  const [word, pin] = String(w).split("@");
  const c = INDEX.get(norm(word)) || [];
  return (pin && c.find((e) => (e.media?.src?.[0] || "").includes(pin))) || c[0] || null;
}

// 단어장 항목 하나가 가리키는 것. 합성이면 **한 항목 안에** 부품을 함께 들고 있는다.
// 예전엔 '보고싶다'를 담으면 보다·내키다 **두 항목**으로 쪼개져서, 사용자가 찾은 말이
// 단어장에서 사라졌다. 사용자가 친 말이 곧 단어장의 이름이어야 한다.
//
// ⚠️ 표제어를 **먼저** 본다. '헌금'은 표제어이면서 합성이기도 한데(결합정보가 표제어에 붙은
//    컬럼이라 이런 게 대부분이다), 사전 화면은 표제어 카드를 보여준다(matchSentence 가 같은
//    길이면 표제어를 집는다). 순서를 뒤집으면 사전과 단어장이 서로 다른 걸 보여준다.
function bookItem(w) {
  const e = lookup(w);
  if (e) return { label: bare(w), parts: [String(w)], labels: [bare(w)], entries: [e] };
  const combo = COMPOUNDS.get(conjugationNormalize(norm(bare(w))));
  if (!combo) return null;
  return {
    label: combo.word || bare(w), combo, parts: combo.parts,
    labels: combo.labels || combo.parts.map(bare),
    entries: combo.parts.map((p) => lookup(p)),
  };
}
// 무료 칸 계산. 합성은 손짓 수만큼 차지한다 — 한 항목으로 보이게 바꿨다고 값이 싸지지는 않는다
// (외울 손짓 수는 그대로다). 표시 단위와 과금 단위가 다르므로 문구도 '개'와 '칸'을 갈라 쓴다.
const cost = (w) => bookItem(w)?.parts.length || 1;
const bookCost = (list = BOOK) => list.reduce((n, w) => n + cost(w), 0);
// 부품 중 하나라도 수형이 안 정해졌으면 그 부품들. 사전 화면과 **같은 함수**로 판정해야
// 두 화면의 말이 갈리지 않는다(⛔ 틀릴 수 있는 걸 단정하지 않는다).
const unsureParts = (it) => (it ? it.parts.filter((p) => unpinnedCandidates(p).length) : []);

// 링크 공유: 서버가 없으므로 단어 목록 자체를 URL 조각에 담는다.
// UTF-8 → base64url. 12단어면 150자 안쪽이라 압축은 아직 필요 없다.
function encodeBook(words) {
  const bytes = new TextEncoder().encode(words.join("\n"));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBook(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    .split("\n").map((x) => x.trim()).filter(Boolean);
}

function shareLink() {
  return location.origin + location.pathname + "#w=" + encodeBook(BOOK);
}

// 링크로 들어온 단어를 합친다. 겹치는 건 건너뛴다.
function mergeFromHash() {
  const m = location.hash.match(/[#&]w=([^&]+)/);
  if (!m || m[1].length > MAX_HASH) return 0;   // 해시는 아무나 만들어 보내는 값이다
  // 게이트가 막으면 **해시를 그대로 둔다** — 지워버리면 로그인하고 돌아왔을 때
  // 링크로 받은 단어가 조용히 사라진다(예전에 실제로 그랬다).
  if (!mayAddToBook()) return 0;
  history.replaceState(null, "", location.pathname); // 새로고침해도 다시 합쳐지지 않게
  let added = 0;
  try {
    for (const w of decodeBook(m[1])) {
      // bookItem 으로 받는다 — lookup 만 보면 합성('보고 싶다')이 표제어가 아니라서
      // 링크로 보낸 단어가 조용히 사라진다.
      if (!bookHas(w) && bookItem(w)) { BOOK.push(w); added++; }
    }
  } catch { return 0; }
  if (added) saveBook();
  return added;
}

function renderWordbook() {
  const box = document.getElementById("wordbook");
  box.innerHTML = "";
  // 빌 게 없으면 비우기 버튼도 없다.
  document.getElementById("empty-btn").hidden = !BOOK.length;
  if (!BOOK.length) {
    box.innerHTML = '<p class="hint">아직 담은 단어가 없어요.<br>사전에서 찾아 <b>단어장에 담기</b>를 눌러보세요.</p>';
    return;
  }
  for (const w of BOOK) {
    const it = bookItem(w);
    const first = it && it.entries[0];
    const wrap = document.createElement("div");
    wrap.className = "book-entry";

    const item = document.createElement("div");
    item.className = "item";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const frames = first && entryFrames(first);
    if (frames) { const img = document.createElement("img"); img.alt = ""; startPlayer(img, frames); thumb.appendChild(img); }
    item.appendChild(thumb);

    const txt = document.createElement("div");
    const t = document.createElement("div"); t.className = "t";
    t.textContent = it ? it.label : bare(w);
    const s = document.createElement("div"); s.className = "s";
    // 사전 화면이 "(확인 안 됨)" 이라고 말한 부품이 여기서는 그냥 확정된 단어로 보였다.
    // 담기는 순간 임의의 첫 후보로 굳는 자리가 1,277곳이라 ⛔ "틀릴 수 있는 걸 단정하지 않는다"에 걸린다.
    const unsure = unsureParts(it);
    if (unsure.length) s.className = "s unsure";
    s.textContent = !it ? "사전에서 찾을 수 없어요"
      : unsure.length ? `${unsure.map(bare).join(" · ")} — 수형이 아직 확인 안 됐어요`
      : it.parts.length > 1 ? `손짓 ${it.parts.length}개를 이어서 해요`
      // 부품 1개짜리 합성(심심해=심심하다)은 담은 이름과 손짓 이름이 다르다. 그걸 밝혀 준다.
      : it.combo ? `[${it.labels[0]}] 손짓 하나예요`
      // 뜻은 사전 카드와 **같은 함수**로 만든다. 예전엔 여기서 aliases 를 직접 이어 붙였는데,
      // 사전 카드가 붙임표를 걸러내기 시작하자 두 화면이 갈렸다 — 단어장에만 '사랑 / -애' 가 남았다.
      // (없으면 비워 둔다. 예전엔 출처 이름("국립국어원 한국수어사전")을 넣었는데, 뜻이 오는 자리에
      //  기관명이 와서 그게 이 단어의 뜻인 것처럼 읽혔다.)
      : meaningOf(first, it.label);
    txt.append(t, s); item.appendChild(txt);

    const del = document.createElement("button");
    del.className = "chk"; del.type = "button";
    del.setAttribute("aria-label", (it ? it.label : bare(w)) + " 빼기"); del.textContent = "✕";
    del.addEventListener("click", () => {
      BOOK = BOOK.filter((x) => x !== w); saveBook(); renderWordbook(); refreshStash();
    });
    item.appendChild(del);
    wrap.appendChild(item);

    // 합성이면 부품을 이 항목 **안에** 펼친다. 따로 담기지 않으니 여기서 안 보여주면
    // 사용자는 무슨 손짓을 하는지 알 길이 없다.
    if (it && it.parts.length > 1) {
      const row = document.createElement("div");
      row.className = "book-parts";
      it.parts.forEach((p, n) => {
        const e = it.entries[n];
        const part = document.createElement("div");
        part.className = "book-part" + (unpinnedCandidates(p).length ? " unsure" : "");
        const th = document.createElement("div");
        th.className = "thumb sm";
        const f = e && entryFrames(e);
        if (f) { const img = document.createElement("img"); img.alt = ""; startPlayer(img, f); th.appendChild(img); }
        const nm = document.createElement("span");
        nm.textContent = "①②③④⑤"[n] + " " + it.labels[n];
        part.append(th, nm);
        row.appendChild(part);
      });
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  }
  if (!BETA_NO_WALL && !isPro && bookCost() >= FREE_LIMIT) box.appendChild(upsell());
}

// 벽에 닿았을 때의 안내. 한 곳에서만 만든다 — 문구가 갈리지 않게.
function upsell() {
  const lock = document.createElement("div");
  lock.className = "locked";
  const t = document.createElement("div");
  // 단위를 '단어'라고 쓰면 안 된다 — 세는 건 손짓이라, 합성 3단어를 담은 사람에게 "5개까지"가
  // 거짓말이 된다(단어 3개인데 이미 막힘). 담기 문구도 같은 단위를 쓴다.
  t.className = "t"; t.textContent = `무료로는 손짓 ${FREE_LIMIT}개까지 담을 수 있어요`;
  const s = document.createElement("p");
  s.className = "s"; s.textContent = "둘 중 한 명만 프로면 둘 다 무제한이에요";
  const b = document.createElement("button");
  // 가격이 없으면 값을 부르지 않는다 — 결제가 붙기 전까지 PRO_PRICE 는 빈 문자열이다.
  b.className = "btn-primary sm"; b.textContent = PRO_PRICE || "더 담을 수 있게 알림 받기";
  b.addEventListener("click", async () => { if (await requestPro()) { renderWordbook(); refreshStash(); } });
  lock.append(t, s, b);
  return lock;
}

// 사전 화면 하단의 담기 버튼 — 지금 결과에 뜬 표제어를 담는다.
let lastWords = []; // renderResults가 채운다
function refreshStash() {
  const box = document.getElementById("stash");
  const label = document.getElementById("stash-label");
  const btn = document.getElementById("stash-btn");
  const fresh = lastWords.filter((w) => !bookHas(w));
  box.hidden = lastWords.length === 0;
  if (!fresh.length) {
    label.textContent = lastWords.length ? "이미 단어장에 있어요" : "";
    btn.disabled = true; btn.textContent = "담김 ✓";
    return;
  }
  // 칸은 손짓 수로 센다 — 합성이 한 항목으로 보여도 외울 손짓은 그대로 여럿이다.
  const need = bookCost(fresh);
  const full = bookCost() + need > limit();
  // 벽에 닿았을 땐 라벨을 비운다. 남은 자리와 필요한 자리를 괄호로 같이 말하던 줄이 있었는데,
  // 두 번 읽어야 뜻이 잡혀서 뺐다. 이유는 버튼(가격)이 대신 말한다.
  label.textContent = full ? "" : `찾은 단어 ${fresh.length}개를 우리 단어장에`;
  btn.textContent = full ? (PRO_PRICE ? PRO_PRICE + "로 무제한" : "지금은 더 담을 수 없어요") : "단어장에 담기";
  btn.disabled = false;
  box.classList.toggle("upsell", full);
  btn.onclick = full
    ? async () => { if (await requestPro()) refreshStash(); }
    : () => {
        if (!mayAddToBook()) return;   // 로그인 게이트가 열린다
        for (const w of lastWords) if (!bookHas(w)) BOOK.push(w);
        saveBook(); refreshStash(); renderWordbook();
        // 담고 나면 키보드를 내린다. 안 내리면 폰에서 화면이 확대·밀린 채로 남는다.
        document.getElementById("input").blur();
      };
}
// 링크 보내기. 폰에선 공유 시트, 데스크톱에선 클립보드.
async function sendLink(url, title) {
  try {
    if (navigator.share) await navigator.share({ title, url });
    else { await navigator.clipboard.writeText(url); toast("링크를 복사했어요"); }
  } catch { /* 사용자가 공유를 취소함 */ }
}

function setupWordbook() {
  // 담기/업그레이드 동작은 refreshStash 가 상황에 따라 btn.onclick 으로 갈아끼운다.
  document.getElementById("share-btn").addEventListener("click", async () => {
    // 친구 초대 링크로 바뀌었다. 단어 목록을 통째로 링크에 담아 보내던 예전 방식은 **한 번 보낸
    // 순간의 복사본**이라, 그 뒤에 담은 단어가 상대에게 안 갔다. 친구로 이어 두면 계속 보인다.
    if (inviteLink) {
      const url = await inviteLink();
      if (!url) return;  // 로그인이 필요하거나 오프라인 — friends.js 가 이미 안내했다
      return sendLink(url, "shhh! — 친구 초대");
    }
    if (!BOOK.length) return toast("담은 단어가 없어요");
    await sendLink(shareLink(), "shhh! — 우리 단어장");
  });
  // 단어장을 비운다. 계정은 그대로 둔다 — 계정을 지우는 건 마이 → 설정 → 계정에 있다.
  document.getElementById("empty-btn").addEventListener("click", () => {
    if (!BOOK.length) return;
    if (!confirm(`담은 ${BOOK.length}개를 전부 뺍니다. 계정은 그대로예요. 계속할까요?`)) return;
    BOOK = [];
    saveBook();            // 로그인했으면 서버의 단어장도 비워진다(auth.js 가 밀어 올린다)
    renderWordbook(); refreshStash();
    toast("단어장을 비웠어요");
  });
}

function toast(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.textContent = ""; }, 2500);
}

// ══ 연습 (플래시카드) ═════════════════════════════════════════════════
// 손모양을 보여주고 뜻을 맞힌다. 문제는 단어장에서만 낸다 — 안 배운 걸 묻지 않는다.
// 한 판의 문제 수는 **담은 단어 수에 맞춘다**(최대 5). 늘 5문제를 내면 3개 담은 사람에게
// 같은 단어가 두 번 나오는데 진행 점은 새 문제인 척해서, 화면이 실제보다 많이 배운 것처럼 보였다.
const QUIZ_MAX = 5;
const quizLen = (pool) => Math.min(QUIZ_MAX, pool.length);
let quiz = null;
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

// 문제로 낼 수 있는 단어. **수형이 안 정해진 건 뺀다** — 임의로 고른 첫 후보를 '정답'이라고
// 채점하면 앱이 틀린 수어를 정답으로 가르치는 셈이라, 안 배운 걸 묻는 것보다 더 나쁘다.
// DOM 밖의 순수 함수로 둔 이유: 이 규칙이 살아 있는지를 test-compounds.mjs 가 직접 잰다.
function quizPool(book) {
  return book.filter((w) => {
    const it = bookItem(w);
    // 합성이면 부품이 **전부** 그림이 있고 전부 수형이 정해져야 문제로 낼 수 있다.
    return it && it.entries.every((e) => e && entryFrames(e)) && !unsureParts(it).length;
  });
}

function startQuiz() {
  const pool = quizPool(BOOK);
  if (pool.length < 3) { quiz = null; return; }
  quiz = { pool, len: quizLen(pool), n: 0, ok: 0, q: null };
  nextQuestion();
}
function nextQuestion() {
  // 셋을 한 번에 뽑고 그중 하나를 정답으로 삼는다 — 정답 위치가 저절로 섞인다.
  const options = pick(quiz.pool, 3);
  quiz.q = { answer: options[Math.floor(Math.random() * options.length)], options, done: false };
  renderPractice();
}
function renderPractice() {
  const box = document.getElementById("practice");
  box.innerHTML = "";
  if (!quiz) {
    // 담은 게 3개가 넘는데도 문제가 안 나오는 경우가 있다 — 수형이 안 정해진 단어를 뺐기 때문이다.
    // 그때 "3개 이상 담아주세요"라고 하면 4개를 담아둔 사람에게 거짓말이 된다.
    const ready = quizPool(BOOK).length;
    box.innerHTML = BOOK.length >= 3
      ? `<p class="hint">담은 ${BOOK.length}개 중 수형이 정해진 건 <b>${ready}개</b>예요.<br>'아직 확인 안 됐어요'로 표시된 단어는 정답을 단정할 수 없어 문제로 내지 않아요.</p>`
      : `<p class="hint">연습하려면 단어장에 <b>3개 이상</b> 담아주세요.<br>사전에서 찾아 담으면 여기서 문제로 나와요.</p>`;
    return;
  }
  if (quiz.n >= quiz.len) {
    const done = document.createElement("div");
    done.className = "note";
    done.innerHTML = `<b>${quiz.len}문제 끝!</b>${quiz.ok}개 맞혔어요.`;
    const again = document.createElement("button");
    again.className = "btn-primary"; again.textContent = "한 번 더";
    again.addEventListener("click", startQuiz);
    box.append(done, again);
    return;
  }

  const dots = document.createElement("div");
  dots.className = "dots";
  for (let i = 0; i < quiz.len; i++) {
    const d = document.createElement("i");
    if (i < quiz.n) d.className = "on";
    dots.appendChild(d);
  }
  box.appendChild(dots);

  // 합성은 손짓이 여럿이다. 첫 부품만 보여주면 '보고싶다'를 묻는데 [보다] 그림만 떠서
  // 문제 자체가 거짓말이 된다 — 부품을 전부 나란히 보여준다.
  const it = bookItem(quiz.q.answer);
  const multi = it.parts.length > 1;
  const q = document.createElement("div");
  q.className = "card quiz";
  const lab = document.createElement("p");
  lab.className = "quiz-lab";
  lab.textContent = multi ? `이 손짓 ${it.parts.length}개, 무슨 뜻일까요?` : "이 손, 무슨 뜻일까요?";
  q.appendChild(lab);
  const strip = document.createElement("div");
  strip.className = "quiz-frames";
  it.entries.forEach((e, n) => {
    const cell = document.createElement("div");
    const img = document.createElement("img");
    img.className = "frame"; img.alt = "수형";
    cell.appendChild(img);
    if (multi) { const no = document.createElement("span"); no.textContent = "①②③④⑤"[n]; cell.appendChild(no); }
    strip.appendChild(cell);
    startPlayer(img, entryFrames(e));
  });
  q.appendChild(strip); box.appendChild(q);
  // 해설은 부품마다. 하나뿐이면 종전과 같은 한 줄이다.
  // 사전 문자열은 **우리가 쓴 글이 아니다**(국립국어원 API 에서 받아 빌드한 JSON). 여기만
  // innerHTML 로 들어가므로 그 자리에서 막는다 — 카드 쪽은 card() 가 textContent 로 넣는다.
  // CSP 가 인라인 스크립트를 이미 막지만, 데이터가 마크업이 되는 길 자체를 두지 않는다.
  const desc = it.entries
    .map((e, n) => (multi ? `<b class="inline">${esc(it.labels[n])}</b> ` : "") + esc(namedFingers(e.description)))
    .join("<br>");

  const btns = new Map(); // 보기 -> 버튼. 글자로 되찾지 않는다 — @핀이 다른 동음이의는 글자가 같다.
  for (const opt of quiz.q.options) {
    const b = document.createElement("button");
    b.className = "opt"; b.textContent = bare(opt);
    btns.set(opt, b);
    b.addEventListener("click", () => {
      if (quiz.q.done) return;
      quiz.q.done = true;
      const right = opt === quiz.q.answer;
      if (right) quiz.ok++;
      b.classList.add(right ? "right" : "wrong");
      if (!right) btns.get(quiz.q.answer)?.classList.add("right");

      const fb = document.createElement("div");
      fb.className = "note" + (right ? "" : " bad");
      fb.innerHTML = right
        ? "<b>잘했어요!</b>" + desc
        : `<b>아쉬워요 — 정답은 '${esc(bare(quiz.q.answer))}'</b>` + desc;
      box.appendChild(fb);

      const next = document.createElement("button");
      next.className = "btn-primary";
      next.textContent = quiz.n + 1 >= quiz.len ? "결과 보기" : "다음";
      next.addEventListener("click", () => { quiz.n++; quiz.n >= quiz.len ? renderPractice() : nextQuestion(); });
      box.appendChild(next);
    });
    box.appendChild(b);
  }
}

// ══ 홈 ═══════════════════════════════════════════════════════════════
// 오늘의 수어 + 우리 단어장 요약. 둘 다 이미 있는 자료만 쓴다 — 새로 저장하는 건 없다.
// ponytail: "최근 찾은 단어"는 안 만든다. 저장소가 하나 더 늘고, 없어도 홈이 성립한다.

// 하루의 기준. UTC 라 한국에선 오전 9시에 날이 바뀌지만, 안내문과 오늘의 수어가
// 같은 함수를 써야 둘이 어긋나지 않는다. 바꾸려면 여기 한 곳만.
const today = () => new Date().toISOString().slice(0, 10);

// 날짜로 정해지는 단어. 무작위면 기기마다 달라지는데, 이 앱의 전제가 "둘이 같이 외운다"라
// 같은 날엔 두 사람이 같은 단어를 봐야 한다. 그래서 날짜 문자열 해시를 씨앗으로 쓴다.
// FNV-1a. 날짜 문자열은 서로 너무 닮아서(2026-08-05 / 2026-08-06) h*31 로는 값이 뭉친다 —
// 실측으로 365일에 서로 다른 단어가 288개(FNV 는 355개). test-home.mjs 가 이 분산을 지킨다.
function dailyIndex(dateStr, len) {
  let h = 2166136261;
  for (const ch of dateStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % len;
}
// 후보: 그림이 있고 표제어가 짧고 깨끗한 것. 변이형(①②)·기호 붙은 표제어는 첫 화면감이 아니다.
// **그 조건만으로는 부족했다** — 3,308개가 전부 후보라 '소령'·'대령' 같은 군 계급이 오늘의 수어로 떴다.
// 국립국어원이 표제어마다 붙여 둔 분류 중 '일상생활 수어 > (이름 붙은 소분류)'만 남긴 목록이
// data/ksl-daily.json 이다(scripts/build-daily.mjs). 소령·대령은 '일상생활 > 기타'라 여기서 빠진다.
// 손으로 고른 목록이 아니라 **사전이 이미 갖고 있던 판단**이라 데이터가 늘어도 다시 빌드하면 된다.
const presentable = (e) => !!e.media?.src?.length && e.word.length <= 4 && /^[가-힣]+$/.test(e.word);
// 분류로도 못 거른 것이 남았다 — 홈에 '죄수'(죄를 지어 교도소에 수감된 사람)가 떴다.
// 분류는 **주제**를 적어 둔 것이지 **말의 무게**를 적어 둔 게 아니라, '일상생활 > 인간' 안에
// 죄수·감옥이 같이 들어 있다. 사전이 대신 판단해 줄 수 있는 축이 아니다.
// 그래서 여기서만 손으로 뺀다: 범죄·형벌·죽음·중병. 하루의 얼굴로 삼기엔 무거운 말이다.
// 감기·두통·배탈 같은 가벼운 병은 남긴다 — 둘이 실제로 주고받는 말이다.
// ponytail: 반응형 목록이라 새 단어는 못 막는다. 후보가 크게 늘거나 같은 지적이 또 나오면
//           그때 사람이 훑은 허용 목록으로 뒤집는다(2,054개를 지금 훑는 건 값보다 대가가 크다).
const HEAVY = new Set([
  "감금", "감옥", "교도소", "죄수", "범죄", "절도", "절도죄", "횡령죄", "사형",
  "납치", "폭행", "피해자", "군사재판", "압류", "권총",
  "죽다", "뇌사", "지옥",
  "백혈병", "결핵", "성병", "치매", "당뇨병", "질병", "마비",
]);
const dailyPool = (dict) =>
  dict.filter((e) => presentable(e) && !HEAVY.has(e.word) && (!DAILY || DAILY.has(e.word)));
function todaysWord(dict, dateStr) {
  const pool = dailyPool(dict);
  return pool.length ? pool[dailyIndex(dateStr, pool.length)] : null;
}

function renderHome() {
  const box = document.getElementById("home");
  box.innerHTML = "";

  const e = todaysWord(DICT, today());
  if (e) {
    const head = document.createElement("p");
    head.className = "note";
    const b = document.createElement("b");
    b.textContent = "오늘의 수어";
    head.append(b, "매일 하나씩 바뀌어요.");
    box.append(head, cardRow([card(e.word, namedFingers(e.description), entryFrames(e), "", meaningOf(e, e.word))]));

    const open = document.createElement("button");
    open.className = "btn-primary"; open.textContent = `'${e.word}' 사전에서 보기`;
    open.addEventListener("click", () => showWord(e.word));
    box.appendChild(open);
  }
  // 단어장 요약 블록은 뺐다. 아래 탭이 이미 '우리'와 '연습'으로 가는 길이라,
  // 홈에 한 번 더 두면 같은 곳으로 가는 문이 두 개가 된다.
}

// 단어를 사전 화면에 띄운다. 홈에서 부른다.
function showWord(w) {
  document.getElementById("input").value = w;
  renderResults(matchSentence(w));
  GO("dict");
}

// ══ 화면 전환 ════════════════════════════════════════════════════════
let GO = () => {}; // setupTabs 가 채운다. 홈 카드에서 화면을 옮길 때 쓴다.
const SCREEN_TITLE = {
  home: ["shhh!", () => "수어로 비밀 얘기하기"],
  dict: ["사전", () => DICT_SUB],
  book: ["우리 단어장", () => ""],
  quiz: ["연습", () => "손모양 보고 뜻 맞히기"],
  // 부제는 js/auth.js 가 로그인 상태에 맞춰 갈아끼운다(로그인 안 했으면 빈 줄).
  me: ["마이", () => myPageSub()],
  settings: ["설정", () => myPageSub()],
  account: ["계정", () => myPageSub()],
};
// 탭이 없는 화면들. 헤더의 ‹ 를 누르면 어디로 돌아가는지도 여기서 정한다 —
// 화면이 늘 때마다 go() 안의 조건문이 늘지 않게.
const BACK_TO = { settings: "me", account: "settings" };
// auth.js 가 없으면(테스트·로그인 미사용) 이 문장이 그대로 뜬다.
let myPageSub = () => "설정과 계정";
function onMyPageSub(fn) { myPageSub = fn; }
function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab[data-go]")];
  let here = "home";   // 지금 화면. 헤더의 ‹ 가 어디로 돌아갈지 정하는 데만 쓴다.
  const go = (name) => {
    here = name;
    // 사전을 떠나면 키보드를 내린다. 안 내리면 폰에서 화면이 밀린 채로 다음 화면이 뜬다.
    if (name !== "dict") document.getElementById("input").blur();
    document.querySelectorAll("[data-screen]").forEach((el) => (el.hidden = el.dataset.screen !== name));
    // 설정·계정은 탭이 없다. 마이에서만 들어가므로 마이를 켜 둔 채로 둔다 —
    // 아무 탭도 안 켜지면 사용자가 어디에 있는지 놓친다.
    const tabName = BACK_TO[name] ? "me" : name;
    tabs.forEach((t) => {
      const on = t.dataset.go === tabName;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
    });
    document.getElementById("gear").hidden = name !== "me";
    document.getElementById("back").hidden = !BACK_TO[name];
    // ⚠️ 마스코트는 <svg> 다. **SVGElement 엔 `el.hidden = true` 가 안 먹는다** — hidden 은
    //    HTMLElement 의 속성이라 IDL 반영이 안 되고, JS 프로퍼티만 생기고 화면은 그대로다.
    //    toggleAttribute 는 Element 의 것이라 태그를 안 가린다.
    document.querySelector(".topbar .mascot").toggleAttribute("hidden", !!BACK_TO[name]);
    const [title, sub] = SCREEN_TITLE[name];
    document.getElementById("screen-title").firstChild.textContent = title;
    document.getElementById("screen-sub").textContent = sub();
    if (name === "home") renderHome();
    if (name === "book") renderWordbook();
    if (name === "quiz") { startQuiz(); renderPractice(); }
    // 담기 박스는 화면 전환만으로 켜지면 안 된다 — 결과가 없으면 빈 점선 상자가 남는다.
    if (name === "dict") refreshStash();
    screenShown?.(name);
  };
  tabs.forEach((t) => t.addEventListener("click", () => go(t.dataset.go)));
  document.getElementById("gear").addEventListener("click", () => go("settings"));
  document.getElementById("back").addEventListener("click", () => go(BACK_TO[here] || "me"));
  GO = go;
  return go;
}

// --- 첫 실행 안내문 ---
// 나가는 길은 둘: ✕(이번만 닫기) / "오늘 그만 보기"(오늘 날짜 기록 → 내일 다시 뜸).
// ponytail: 날짜 문자열 하나로 끝. "다시 보지 않기"는 안 만든다 — 수어 문법은 한 번 봐서 안 외워진다.
const INTRO_KEY = "shh-intro-muted";
function setupIntro() {
  const box = document.getElementById("intro");
  if (localStorage.getItem(INTRO_KEY) === today()) return;
  box.hidden = false;

  const close = () => { box.hidden = true; };
  document.getElementById("intro-close").addEventListener("click", close);
  document.getElementById("intro-ok").addEventListener("click", close);
  document.getElementById("intro-mute").addEventListener("click", () => {
    localStorage.setItem(INTRO_KEY, today());
    close();
  });
}

// 카메라·지문자 인식(6단계)은 js/camera.js 로 옮겼다 — index.html 이 로드하지 않으므로
// 여기 두면 쓰지도 않는 242줄을 매 로드마다 파싱한다. 되살리는 법은 camera.js 맨 위에 적어뒀다.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("service-worker.js").catch(() => {})
  );

  // 새 서비스워커가 제어를 넘겨받으면 **한 번만** 다시 읽는다.
  //
  // 왜 필요한가: SW 는 skipWaiting + clients.claim 으로 **이미 떠 있는 화면**의 제어를 잡는다.
  // 그런데 그 화면이 들고 있는 js/*.js 는 옛 세대다 — 새 세대의 캐시·응답 계약과 섞여 돈다.
  // 실제로 그 조합에서 친구 화면이 「불러오는 중이에요…」에 멈췄다(옛 friends.js 에는 실패 분기가 없었다).
  // 다시 읽으면 화면과 캐시가 같은 세대가 된다.
  let refreshed = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshed) return;              // 두 번째부터는 무시한다 — 새로고침 고리에 빠지지 않게
    refreshed = true;
    // ⚠️ 로그인 왕복 중에는 절대 다시 읽지 않는다. `#login=…` · `?code=…&state=…` 는 **일회용**이라
    //    다시 읽는 사이에 소모되면 로그인이 조용히 실패한다(nonce 는 한 번 쓰면 지워진다).
    if (/[#&?](login|code|state)=/.test(location.href)) return;
    location.reload();
  });
}

main();
