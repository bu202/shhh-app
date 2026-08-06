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

// 표제어 매칭 뒤에 붙는 한글 활용 어미/일부 조사. 별도 수어로 내지 않고 흡수(미안"해"→년 오매칭 방지).
// ponytail: 형태소 분석기($0 vanilla 불가)의 대용 휴리스틱. 하다-활용 + 안전한 다음절 조사만.
//           단음절 조사(은/는/이/가…)는 단어 첫음절과 흔히 충돌해 일부러 제외. 오작동 시 이 목록만 손봄.
const ENDINGS = [
  // 하-활용
  "했습니다", "하겠습니다", "하였다", "합니다", "했어요", "하세요", "해요", "했어", "했다",
  "하니까", "하는데", "하지만", "하면서", "하려고", "하겠다", "하겠어요",
  "해서", "하고", "하는", "하지", "하게", "해도", "하면", "한다", "하다", "해",
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
  if (last === "워") { const p = jamo(head.slice(-1)); if (p && !p[2]) out.push(head.slice(0, -1) + syl(p[0], p[1], 17) + "다"); } // 고마워→고맙다
  if (last === "려") out.push(head + "리다");                                  // 기다려→기다리다
  if (last === "아" || last === "어") out.push(head + "다");                    // 괜찮아→괜찮다, 먹어→먹다
  const p = jamo(last);                                                       // 고파→고프다, 예뻐→예쁘다
  if (p && !p[2] && (p[1] === 0 || p[1] === 4)) out.push(head + syl(p[0], 18, 0) + "다");
  if (last === "자") out.push(head + "다");                                    // 놀자→놀다, 가자→가다(청유)
  if (w.endsWith("고파")) out.push(w.slice(0, -2) + "다싶다");                  // 보고파→보다싶다(=보고싶다 합성 키)
  return out;
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
      // 문장 안에서 1글자 표제어는 잡지 않는다. 1글자 키가 394개인데 를·는·의·해 같은
      // 조사·어미까지 섞여 있어 거의 언제나 오답이 된다(잘자=잘하다+사람, 힘내=기운+자신).
      // 틀린 수어를 단정하느니 지화로 떨어지는 게 낫다(⛔ 실제 수어만 보여준다).
      if (L === 1 && s.length > 1) break;
      const key = s.slice(i, i + L);
      const keys = [key, ...deconjugate(key)];
      const e = keys.reduce((h, k) => h || INDEX.get(k), null);
      if (e) { hit = { type: "entry", entries: e }; len = L; break; }
      // 같은 길이면 단일 표제어 우선. 사전에 없는 말만 합성으로 받는다.
      const c = keys.reduce((h, k) => h || COMPOUNDS.get(k), null);
      if (c) { hit = { type: "compound", combo: c }; len = L; break; }
    }
    if (hit) {
      flush();
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
function card(word, desc, frames, cls) {
  // 시안 순서: 그림 → 단어 → 설명. 손모양이 먼저 눈에 들어와야 한다.
  const el = document.createElement("div");
  el.className = "card" + (cls ? " " + cls : "");
  if (frames) {
    const img = document.createElement("img");
    img.className = "frame"; img.alt = word + " 수형"; el.appendChild(img);
    startPlayer(img, frames);
  }
  const w = document.createElement("p");
  w.className = "word"; w.textContent = word; el.appendChild(w);
  const d = document.createElement("p");
  d.className = "desc"; d.textContent = desc; el.appendChild(d);
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

// 한국수어 수형 표기의 손가락 번호는 상식과 반대다: 1지=검지 … 5지=엄지.
// 그대로 보여주면 "4지"를 약지로 읽는다(실제로는 새끼). 사전 설명의 84%가 이 표기를 쓴다.
const FINGERS = ["검지", "중지", "약지", "새끼", "엄지"];
const JOSA = { 를: "을", 는: "은", 가: "이" }; // "…손가락"은 받침으로 끝나 조사가 바뀐다
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
  const raw = namedFingers(e.description);
  const desc = noImg ? "손모양 설명: " + raw + " · (그림 없어 지화로 표시)" : raw;
  const name = !key || key === e.word ? e.word : key + " (" + e.word + ")";
  return card(name, desc, entryFrames(e), noImg ? "text-sign" : "");
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
      head.append(b, `'${word}'는 `, parts, " 하나로 표현해요. 한국어의 말끝은 수어에 없어서 떼고 찾았어요.");
    } else {
      b.textContent = `${["", "", "두", "세", "네", "다섯"][labels.length] || labels.length} 수어를 이어서 표현해요`;
      head.append(b, `'${word}'는 하나의 손짓이 아니라 `, parts, "입니다. 한국어의 말끝은 수어에 없어서 떼고 찾았어요.");
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
    return card(no + name, namedFingers(e.description), entryFrames(e), cands.length ? "unsure" : "");
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
  if (combo.verified && combo.source) {
    const src = document.createElement("p");
    src.className = "combo-src";
    const a = document.createElement("a");
    a.href = combo.source; a.target = "_blank"; a.rel = "noopener";
    a.textContent = combo.by || "영상 출처";
    src.append("영상으로 확인함 · ", a);
    group.appendChild(src);
  }
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

  // 담기 대상: 화면에 뜬 실제 표제어. 합성이면 부품을 각각 담는다(그래야 연습에 낼 수 있다).
  lastWords = [...new Set(tokens.flatMap((t) =>
    t.type === "entry" ? [pinned(t.entries[0])] : t.type === "compound" ? t.combo.parts : []))];
  refreshStash();
}

async function main() {
  const status = document.getElementById("status");
  try {
    DICT = await loadDictionary();
    buildIndex(DICT);
    await loadCompounds();
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
  const openHash = () => {
    const q = decodeURIComponent((location.hash.match(/[#&]q=([^&]*)/) || [])[1] || "");
    if (q) { input.value = q; run(); go("dict"); }
    const added = mergeFromHash(); // 사전 로드 뒤라야 lookup 이 된다
    if (added) { go("book"); toast(`링크에서 ${added}개를 단어장에 담았어요`); }
    refreshStash();
  };
  addEventListener("hashchange", openHash);
  openHash();

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
const PRO_PRICE = "₩4,900 / 월";
let isPro = localStorage.getItem(PRO_KEY) === "1";
const limit = () => (isPro ? Infinity : FREE_LIMIT);

// 개발용: ?pro=1 로 벽 너머 화면을 지금 확인할 수 있게. ?pro=0 이면 해제.
(() => {
  const v = new URLSearchParams(location.search).get("pro");
  if (v === "1" || v === "0") { isPro = v === "1"; localStorage.setItem(PRO_KEY, v); }
})();

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
const saveBook = () => localStorage.setItem(BOOK_KEY, JSON.stringify(BOOK));
const bookHas = (w) => BOOK.includes(w);

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
  if (!m) return 0;
  history.replaceState(null, "", location.pathname); // 새로고침해도 다시 합쳐지지 않게
  let added = 0;
  try {
    for (const w of decodeBook(m[1])) {
      if (!bookHas(w) && lookup(w)) { BOOK.push(w); added++; }
    }
  } catch { return 0; }
  if (added) saveBook();
  return added;
}

function renderWordbook() {
  const box = document.getElementById("wordbook");
  box.innerHTML = "";
  if (!BOOK.length) {
    box.innerHTML = '<p class="hint">아직 담은 단어가 없어요.<br>사전에서 찾아 <b>단어장에 담기</b>를 눌러보세요.</p>';
    return;
  }
  for (const w of BOOK) {
    const e = lookup(w);
    const item = document.createElement("div");
    item.className = "item";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const frames = e && entryFrames(e);
    if (frames) { const img = document.createElement("img"); img.alt = ""; startPlayer(img, frames); thumb.appendChild(img); }
    item.appendChild(thumb);

    const txt = document.createElement("div");
    const t = document.createElement("div"); t.className = "t"; t.textContent = bare(w);
    const s = document.createElement("div"); s.className = "s";
    // 사전 화면이 "(확인 안 됨)" 이라고 말한 부품이 여기서는 그냥 확정된 단어로 보였다.
    // 담기는 순간 임의의 첫 후보로 굳는 자리가 1,277곳이라 ⛔ "틀릴 수 있는 걸 단정하지 않는다"에 걸린다.
    // 판정은 사전 화면과 같은 함수(unpinnedCandidates)로 해야 두 화면의 말이 갈리지 않는다.
    const unsure = unpinnedCandidates(w);
    if (unsure.length) s.className = "s unsure";
    s.textContent = !e ? "사전에서 찾을 수 없어요"
      : unsure.length ? `수형이 ${unsure.length}개 — 아직 확인 안 됐어요`
      : e.aliases?.length ? e.aliases.join(" · ") : "국립국어원 한국수어사전";
    txt.append(t, s); item.appendChild(txt);

    const del = document.createElement("button");
    del.className = "chk"; del.type = "button";
    del.setAttribute("aria-label", bare(w) + " 빼기"); del.textContent = "✕";
    del.addEventListener("click", () => {
      BOOK = BOOK.filter((x) => x !== w); saveBook(); renderWordbook(); refreshStash();
    });
    item.appendChild(del);
    box.appendChild(item);
  }
  if (!isPro && BOOK.length >= FREE_LIMIT) box.appendChild(upsell());
}

// 벽에 닿았을 때의 안내. 한 곳에서만 만든다 — 문구가 갈리지 않게.
function upsell() {
  const lock = document.createElement("div");
  lock.className = "locked";
  const t = document.createElement("div");
  t.className = "t"; t.textContent = `무료 단어장은 ${FREE_LIMIT}개까지예요`;
  const s = document.createElement("p");
  s.className = "s"; s.textContent = "둘 중 한 명만 프로면 둘 다 무제한이에요";
  const b = document.createElement("button");
  b.className = "btn-primary sm"; b.textContent = PRO_PRICE;
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
  const full = BOOK.length + fresh.length > limit();
  label.textContent = full
    ? `자리가 ${Math.max(0, FREE_LIMIT - BOOK.length)}칸 남았어요 (이 단어는 ${fresh.length}칸)`
    : `찾은 단어 ${fresh.length}개를 우리 단어장에`;
  btn.textContent = full ? PRO_PRICE + "로 무제한" : "단어장에 담기";
  btn.disabled = false;
  box.classList.toggle("upsell", full);
  btn.onclick = full
    ? async () => { if (await requestPro()) refreshStash(); }
    : () => { for (const w of lastWords) if (!bookHas(w)) BOOK.push(w); saveBook(); refreshStash(); renderWordbook(); };
}
function setupWordbook() {
  // 담기/업그레이드 동작은 refreshStash 가 상황에 따라 btn.onclick 으로 갈아끼운다.
  document.getElementById("share-btn").addEventListener("click", async () => {
    if (!BOOK.length) return toast("담은 단어가 없어요");
    const url = shareLink();
    try {
      if (navigator.share) await navigator.share({ title: "쉿 — 우리 단어장", url });
      else { await navigator.clipboard.writeText(url); toast("링크를 복사했어요"); }
    } catch { /* 사용자가 공유를 취소함 */ }
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
const QUIZ_LEN = 5;
let quiz = null;
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

// 문제로 낼 수 있는 단어. **수형이 안 정해진 건 뺀다** — 임의로 고른 첫 후보를 '정답'이라고
// 채점하면 앱이 틀린 수어를 정답으로 가르치는 셈이라, 안 배운 걸 묻는 것보다 더 나쁘다.
// DOM 밖의 순수 함수로 둔 이유: 이 규칙이 살아 있는지를 test-compounds.mjs 가 직접 잰다.
function quizPool(book) {
  return book.filter((w) => lookup(w) && entryFrames(lookup(w)) && !unpinnedCandidates(w).length);
}

function startQuiz() {
  const pool = quizPool(BOOK);
  if (pool.length < 3) { quiz = null; return; }
  quiz = { pool, n: 0, ok: 0, q: null };
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
  if (quiz.n >= QUIZ_LEN) {
    const done = document.createElement("div");
    done.className = "note";
    done.innerHTML = `<b>${QUIZ_LEN}문제 끝!</b>${quiz.ok}개 맞혔어요.`;
    const again = document.createElement("button");
    again.className = "btn-primary"; again.textContent = "한 번 더";
    again.addEventListener("click", startQuiz);
    box.append(done, again);
    return;
  }

  const dots = document.createElement("div");
  dots.className = "dots";
  for (let i = 0; i < QUIZ_LEN; i++) {
    const d = document.createElement("i");
    if (i < quiz.n) d.className = "on";
    dots.appendChild(d);
  }
  box.appendChild(dots);

  const e = lookup(quiz.q.answer);
  const q = document.createElement("div");
  q.className = "card quiz";
  const lab = document.createElement("p");
  lab.className = "quiz-lab"; lab.textContent = "이 손, 무슨 뜻일까요?";
  const img = document.createElement("img");
  img.className = "frame"; img.alt = "수형";
  q.append(lab, img); box.appendChild(q);
  startPlayer(img, entryFrames(e));

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
        ? "<b>잘했어요!</b>" + namedFingers(e.description)
        : `<b>아쉬워요 — 정답은 '${bare(quiz.q.answer)}'</b>` + namedFingers(e.description);
      box.appendChild(fb);

      const next = document.createElement("button");
      next.className = "btn-primary";
      next.textContent = quiz.n + 1 >= QUIZ_LEN ? "결과 보기" : "다음";
      next.addEventListener("click", () => { quiz.n++; quiz.n >= QUIZ_LEN ? renderPractice() : nextQuestion(); });
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
const dailyPool = (dict) => dict.filter((e) => e.media?.src?.length && e.word.length <= 4 && /^[가-힣]+$/.test(e.word));
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
    head.append(b, "매일 하나씩 바뀌어요. 같은 날엔 둘 다 같은 단어를 봅니다.");
    box.append(head, cardRow([card(e.word, namedFingers(e.description), entryFrames(e), "")]));

    const open = document.createElement("button");
    open.className = "btn-primary"; open.textContent = `'${e.word}' 사전에서 보기`;
    open.addEventListener("click", () => showWord(e.word));
    box.appendChild(open);
  }

  // 우리 단어장 요약. 연습은 3개부터 열린다(startQuiz 와 같은 기준).
  const sum = document.createElement("div");
  sum.className = "locked";
  const t = document.createElement("div");
  t.className = "t"; t.textContent = BOOK.length ? `우리 단어장 ${BOOK.length}개` : "우리 단어장이 비어 있어요";
  const s = document.createElement("p");
  s.className = "s"; s.textContent = BOOK.length >= 3 ? "연습 문제를 낼 수 있어요" : "3개부터 연습이 열려요";
  const btn = document.createElement("button");
  btn.className = "btn-primary sm";
  btn.textContent = BOOK.length >= 3 ? "연습하러 가기" : "사전에서 단어 찾기";
  btn.addEventListener("click", () => GO(BOOK.length >= 3 ? "quiz" : "dict"));
  sum.append(t, s, btn);
  box.appendChild(sum);
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
  home: ["쉿", () => "소리 없이 말하는 법"],
  dict: ["사전", () => DICT_SUB],
  book: ["우리 단어장", () => (BOOK.length ? `둘이 같이 외우는 ${BOOK.length}개` : "아직 비어 있어요")],
  quiz: ["연습", () => "손모양 보고 뜻 맞히기"],
};
function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab[data-go]")];
  const go = (name) => {
    document.querySelectorAll("[data-screen]").forEach((el) => (el.hidden = el.dataset.screen !== name));
    tabs.forEach((t) => {
      const on = t.dataset.go === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
    });
    const [title, sub] = SCREEN_TITLE[name];
    document.getElementById("screen-title").firstChild.textContent = title;
    document.getElementById("screen-sub").textContent = sub();
    if (name === "home") renderHome();
    if (name === "book") renderWordbook();
    if (name === "quiz") { startQuiz(); renderPractice(); }
    // 담기 박스는 화면 전환만으로 켜지면 안 된다 — 결과가 없으면 빈 점선 상자가 남는다.
    if (name === "dict") refreshStash();
  };
  tabs.forEach((t) => t.addEventListener("click", () => go(t.dataset.go)));
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

// --- Phase 2 (C): 카메라 + 손 랜드마크 검출 스캐폴드 ---
// MediaPipe Hand Landmarker. ponytail: CDN 로드. 오프라인/배포용 로컬 vendoring은 배포 전 TODO.
const MP_VER = "0.10.14";
let landmarker = null, camStream = null, rafId = null, drawUtils = null, MpHand = null;

async function startHandTracking() {
  const video = document.getElementById("cam");
  const canvas = document.getElementById("overlay");
  const status = document.getElementById("cam-status");
  try {
    if (!landmarker) {
      status.textContent = "손 인식 모델 로드 중…";
      const vision = await import(
        /* @vite-ignore */ `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`
      );
      const { HandLandmarker, FilesetResolver, DrawingUtils } = vision;
      MpHand = HandLandmarker;
      const fileset = await FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`
      );
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        },
        runningMode: "VIDEO",
        numHands: 2,
      });
      drawUtils = new DrawingUtils(canvas.getContext("2d"));
    }

    status.textContent = "카메라 접근 중…";
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    video.srcObject = camStream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    status.textContent = "손을 비춰보세요.";
    loopDetect();
  } catch (e) {
    status.textContent = "카메라/모델 오류: " + (e.message || e);
  }
}

function loopDetect() {
  const video = document.getElementById("cam");
  const canvas = document.getElementById("overlay");
  const ctx = canvas.getContext("2d");
  const status = document.getElementById("cam-status");

  const tick = () => {
    if (!landmarker || !camStream) return;
    const res = landmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const hands = res.landmarks || [];
    hands.forEach((lm) => {
      drawUtils.drawConnectors(lm, MpHand.HAND_CONNECTIONS, { color: "#03c75a", lineWidth: 3 });
      drawUtils.drawLandmarks(lm, { color: "#fff", radius: 3 });
    });
    const out = document.getElementById("sign-out");
    if (hands.length) {
      lastLm = hands[0];                                  // 녹화 버튼이 쓸 최신 손
      const knn = knnClassify(lastLm);                    // 샘플 있으면 KNN
      const label = knn === undefined ? recognizeSign(lastLm) : knn; // 없으면 규칙 폴백
      const confirmed = smoothSign(label);                // undefined=대기, null=미인식, "X"=확정
      if (confirmed !== undefined) out.textContent = confirmed || "—";
      // 엣지 트리거: 미인식(재장전) 상태를 거쳐야 다음 자모 커밋. 같은 자모 연속은 손 내렸다 다시.
      if (confirmed && armed) { commitJamo(confirmed); armed = false; }
      else if (confirmed === null) armed = true;
      status.textContent = `KNN 샘플 ${knnSamples.length} · ${knnDbg ? `최근접 ${knnDbg.label} d=${knnDbg.dist.toFixed(2)} (임계 ${KNN_MAX})` : "규칙 폴백"}`;
    } else {
      signHist.length = 0;
      lastLm = null;
      armed = true;
      out.textContent = "—";
      status.textContent = "손이 보이지 않아요.";
    }
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopHandTracking() {
  if (rafId) cancelAnimationFrame(rafId), (rafId = null);
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const video = document.getElementById("cam");
  if (video) video.srcObject = null;
  signHist.length = 0;
}

// --- 한글 음절 조합기 (자모 스트림 → 완성형 문자열) ---
// 인식 방식(규칙/KNN)과 무관하게 재사용. 표준 자모 인덱스 테이블(라인 74의 지화용 CHO와 별개).
function assembleHangul(jamos) {
  const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
  const JONG = "ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"; // 인덱스+1=종성코드
  let out = "", cho = -1, jung = -1, jong = -1;
  const flush = () => {
    if (cho >= 0 && jung >= 0) out += String.fromCharCode(0xAC00 + (cho * 21 + jung) * 28 + (jong + 1));
    else if (cho >= 0) out += CHO[cho];
    else if (jung >= 0) out += JUNG[jung];
    cho = jung = jong = -1;
  };
  for (const j of jamos) {
    const ci = CHO.indexOf(j), ji = JUNG.indexOf(j), gi = JONG.indexOf(j);
    if (ji >= 0) {                      // 모음
      const moved = jong >= 0 ? CHO.indexOf(JONG[jong]) : -1; // 받침→다음 초성(연음)
      if (moved >= 0) { jong = -1; flush(); cho = moved; jung = ji; }
      else if (cho >= 0 && jung < 0) jung = ji;
      else { flush(); jung = ji; }
    } else if (ci >= 0) {               // 자음
      if (cho < 0) cho = ci;
      else if (jung < 0) { flush(); cho = ci; }   // 자음+자음
      else if (jong < 0 && gi >= 0) jong = gi;     // 받침
      else { flush(); cho = ci; }
    } else { flush(); out += j; }      // 공백 등 비자모 통과
  }
  flush();
  return out;
}

// --- 지문자 인식 (규칙기반, 손 21점 → 자모) ---
// 엔진(손가락 굽힘 판정)은 방향 무관하게 안정적. 매핑표 SIGNS는 추론값이라 [?] 표기 —
// ponytail: assets/fingerspelling/*.jpg 참조이미지로 각 자모 손모양을 보고 교정할 것.
function angleDeg(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1e-9;
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / m))) * 180) / Math.PI;
}
// [엄지,검지,중지,약지,새끼] 각 1=폄 0=굽힘. 관절각으로 판정(회전 불변).
function fingerStates(lm) {
  const bent = ([a, b, c], th) => (angleDeg(lm[a], lm[b], lm[c]) > th ? 1 : 0);
  return [
    bent([2, 3, 4], 150),   // 엄지: IP각
    bent([5, 6, 8], 150),   // 검지: PIP각 (약지·새끼가 잘 안 펴져 150으로 관대)
    bent([9, 10, 12], 150), // 중지
    bent([13, 14, 16], 150),// 약지
    bent([17, 18, 20], 150),// 새끼
  ];
}
// ㅇ(원 O): 엄지·검지 끝이 붙고 + 중지·약지·새끼가 펴짐(주먹과 구분). 손 크기로 정규화.
function isPinch(lm) {
  const hand = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1e-9;
  const touch = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / hand < 0.4;
  const rest = fingerStates(lm).slice(2).reduce((a, b) => a + b, 0); // 중지+약지+새끼
  return touch && rest >= 2;
}
// 엄지가 검지에서 벌어졌나(ㄱ vs ㄴ 구분용). 엄지방향(2→4)과 검지방향(5→8) 사잇각.
// ponytail: 임계 35°는 실손 튜닝값. 오구분 나면 이 숫자만 조정.
function thumbOut(lm) {
  const t = { x: lm[4].x - lm[2].x, y: lm[4].y - lm[2].y };
  const i = { x: lm[8].x - lm[5].x, y: lm[8].y - lm[5].y };
  const m = Math.hypot(t.x, t.y) * Math.hypot(i.x, i.y) || 1e-9;
  return (Math.acos(Math.max(-1, Math.min(1, (t.x * i.x + t.y * i.y) / m))) * 180) / Math.PI > 35;
}
// 자모 판정은 네 손가락(검지·중지·약지·새끼)만으로. 엄지는 신뢰도 낮아 ㄱ/ㄴ 구분에만 사용.
const SIGNS = { "0000": "ㅁ", "1100": "ㅅ" }; // key=검지중지약지새끼
function recognizeSign(lm) {
  if (isPinch(lm)) return "ㅇ";
  const f = fingerStates(lm).slice(1); // [검지,중지,약지,새끼]
  if (f.join("") === "1000") return thumbOut(lm) ? "ㄴ" : "ㄱ";
  if (f[0] && f[1] && f[2]) return "ㅂ"; // 검지·중지·약지 폄(새끼 무관)
  return SIGNS[f.join("")] || null;
}
// 시간 평활: 같은 라벨이 연속 N프레임 잡혀야 확정(깜빡임/오검출 억제).
const signHist = [];
const SIGN_HOLD = 6;
function smoothSign(label) {
  signHist.push(label);
  if (signHist.length > SIGN_HOLD) signHist.shift();
  if (signHist.length === SIGN_HOLD && signHist.every((s) => s === signHist[0])) return signHist[0];
  return undefined; // 아직 확정 안 됨
}

// --- KNN 지문자 분류 (손 21점 정규화 벡터 → 자모) ---
// 좌표를 통째로 특징으로 → 방향/회전 보존(방향 모음 구분 가능). 샘플은 localStorage에 사용자가 직접 학습.
// ponytail: k=3, 거리임계 KNN_MAX는 실손 튜닝값. 미인식 많으면 올리고, 오인식 많으면 내림.
const SAMPLE_KEY = "ksl-knn-samples";
// 256샘플(32자모×8) 실측: 같은자모 최근접 최대 5.32, 다른자모 최근접 최소 0.42/중앙 1.42.
// 클래스가 0.42까지 붙어있어 임계로 자모를 "가려낼" 수는 없음 — 임계의 역할은 자모 아닌 손 거부뿐.
// 자세를 바꿔 찍은(정지버스트 아닌) 샘플의 같은자모 최근접: 중앙 1.92 · 90퍼센타일 5.18 · 최대 9.16.
// 8이면 정상 자세의 ~90%를 통과시킨다.
// ⚠️ 틀릴 때 거리가 더 가깝다(라이브 오분류 d=0.43~0.97) → 임계로는 오분류를 못 거른다. 역할은 비지문자 거부뿐.
const KNN_K = 3, KNN_MAX = 8; // ponytail: 계기판(상태줄 d=)으로 실사용 중 조정. 미인식↑→올림.
let knnDbg = null; // ponytail: 실손 튜닝 계기판. {dist, label} 최근접 이웃. KNN_MAX 조정용.
let knnSamples = (() => { try { return JSON.parse(localStorage.getItem(SAMPLE_KEY)) || []; } catch { return []; } })();
const saveSamples = () => localStorage.setItem(SAMPLE_KEY, JSON.stringify(knnSamples));
// 손목 원점 이동 + 손크기 스케일 정규화. 회전은 일부러 보존(방향이 자모 구분에 필요).
function features(lm) {
  const wx = lm[0].x, wy = lm[0].y;
  const scale = Math.hypot(lm[9].x - wx, lm[9].y - wy) || 1e-9;
  const f = [];
  for (const p of lm) f.push((p.x - wx) / scale, (p.y - wy) / scale);
  return f;
}
function knnClassify(lm) {
  if (knnSamples.length < KNN_K) return undefined; // 샘플 부족 → 규칙 폴백 신호
  const f = features(lm);
  const d = knnSamples
    .map((s) => ({ label: s.label, dist: s.f.reduce((a, v, i) => a + (v - f[i]) ** 2, 0) }))
    .sort((a, b) => a.dist - b.dist);
  knnDbg = { dist: d[0].dist, label: d[0].label };
  if (d[0].dist > KNN_MAX) return null; // 너무 멀면 미인식
  const votes = {};
  d.slice(0, KNN_K).forEach((t) => (votes[t.label] = (votes[t.label] || 0) + 1));
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
}

// --- 자모 버퍼 → 한글 조합 표시 ---
let jamoBuf = [], armed = true, lastLm = null;
function renderText() {
  const t = document.getElementById("text-out");
  if (t) t.textContent = assembleHangul(jamoBuf) || "…";
}
function commitJamo(j) { jamoBuf.push(j); renderText(); }

function setupSignInput() {
  const rec = document.getElementById("btn-record");
  const label = document.getElementById("train-label");
  const count = document.getElementById("sample-count");
  const showCount = () => (count.textContent = `샘플 ${knnSamples.length}개`);
  const refBox = document.getElementById("ref-box");
  label.addEventListener("input", () => {          // 라벨 자모 → 참고 손모양 그림
    const file = JAMO_IMG[label.value.trim()];
    refBox.hidden = !file;
    if (file) refBox.querySelector("img").src = "assets/fingerspelling/" + file + ".jpg";
  });
  rec.addEventListener("click", () => {
    const j = label.value.trim();
    if (!j || !lastLm) return;
    knnSamples.push({ label: j, f: features(lastLm) });
    saveSamples(); showCount();
  });
  document.getElementById("btn-reset-samples").addEventListener("click", () => {
    if (!confirm("저장된 KNN 샘플을 모두 지울까요?")) return;
    knnSamples = []; saveSamples(); showCount();
  });
  document.getElementById("btn-space").addEventListener("click", () => { jamoBuf.push(" "); renderText(); });
  document.getElementById("btn-del").addEventListener("click", () => { jamoBuf.pop(); renderText(); });
  document.getElementById("btn-clear").addEventListener("click", () => { jamoBuf = []; renderText(); });
  showCount();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("service-worker.js").catch(() => {})
  );
}

main();
