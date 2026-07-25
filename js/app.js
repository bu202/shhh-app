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
  return (await res.json()).map(normalizeEntry);
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
    .replace(/싶어요|싶어/g, "싶다");   // 싶다 활용 정규화
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
      const e = INDEX.get(s.slice(i, i + L));
      if (e) { hit = e; len = L; break; }
    }
    if (hit) {
      flush();
      out.push({ type: "entry", entries: hit, text: s.slice(i, i + len) });
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
  const el = document.createElement("div");
  el.className = "card" + (cls ? " " + cls : "");
  const w = document.createElement("p");
  w.className = "word"; w.textContent = word; el.appendChild(w);
  if (frames) {
    const img = document.createElement("img");
    img.className = "frame"; img.alt = word + " 수형"; el.appendChild(img);
    startPlayer(img, frames);
  }
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
  return entry.media.type === "images" ? entry.media.src : [entry.media.src];
}
function jamoFrames(jamo) {
  return jamo.map((j) => "assets/fingerspelling/" + JAMO_IMG[j] + ".jpg");
}

const entryCard = (e) => card(e.word, e.description, entryFrames(e));

// 토큰 -> DOM 노드. 동음이의는 첫 후보를 대표로, 나머지는 "다른 뜻 N개" 안에.
function renderToken(token) {
  if (token.type === "entry") {
    const [primary, ...alts] = token.entries;
    const group = document.createElement("div");
    group.className = "token-group";
    group.appendChild(entryCard(primary));
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
      for (const a of alts) det.appendChild(entryCard(a));
      group.appendChild(det);
    }
    return group;
  }
  // 미지원 단어: 하이브리드 — 지화 가능하면 지문자, 아니면 안내.
  const jamo = decomposeToJamo(token.text);
  if (jamo) return card(token.text, "지문자(지화): " + jamo.join(" · "), jamoFrames(jamo), "finger");
  return card("미지원: " + token.text, "지화로도 표현할 수 없는 문자예요.", null, "unsupported");
}

function renderResults(tokens) {
  stopPlayers();
  const box = document.getElementById("result");
  box.innerHTML = "";
  if (tokens.length === 0) {
    box.innerHTML = '<p class="hint">번역할 말을 입력하면 바로 표시돼요.</p>';
    return;
  }
  for (const t of tokens) box.appendChild(renderToken(t));
}

async function main() {
  const status = document.getElementById("status");
  try {
    DICT = await loadDictionary();
    buildIndex(DICT);
    status.textContent = "사전 " + DICT.length + "개 로드됨";
  } catch (e) {
    status.textContent = "사전 로드 실패: " + e.message;
    return;
  }

  const input = document.getElementById("input");
  const btn = document.getElementById("translate");
  const run = () => renderResults(matchSentence(input.value));
  const debouncedRun = debounce(run, 250);

  btn.addEventListener("click", run);
  // 실시간(A): 입력 즉시 변환. IME 조합 중(e.isComposing)엔 건너뛰고 조합 완료 시 실행.
  input.addEventListener("input", (e) => { if (!e.isComposing) debouncedRun(); });
  input.addEventListener("compositionend", debouncedRun);

  setupModes();
  setupSignInput();
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// --- 모드 전환 (텍스트→수어 / 수어→텍스트) ---
function setupModes() {
  const t2s = document.getElementById("mode-t2s");
  const s2t = document.getElementById("mode-s2t");
  const textSections = [document.querySelector(".io"), document.getElementById("result")];
  const cam = document.getElementById("camera");

  const setMode = (isCamera) => {
    t2s.classList.toggle("active", !isCamera);
    s2t.classList.toggle("active", isCamera);
    t2s.setAttribute("aria-selected", String(!isCamera));
    s2t.setAttribute("aria-selected", String(isCamera));
    textSections.forEach((el) => (el.hidden = isCamera));
    cam.hidden = !isCamera;
    if (isCamera) startHandTracking(); else stopHandTracking();
  };
  t2s.addEventListener("click", () => setMode(false));
  s2t.addEventListener("click", () => setMode(true));
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
      status.textContent = `손 검출 · KNN 샘플 ${knnSamples.length}`;
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
const KNN_K = 3, KNN_MAX = 1.2;
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
  rec.addEventListener("click", () => {
    const j = (label.value || "").trim();
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
