"use strict";

// --- API 교체 이음새 (seam) ---
// mock 사전과 실제 kcisa API 응답을 같은 내부 스키마로 정규화.
// 실제 키 발급 후에는 이 함수 하나만 바꾸면 됨. 내부 스키마:
//   { word, aliases:[], description, media: { type: "images"|"video", src } }
function normalizeEntry(raw) {
  return raw;
}

let DICT = [];
let INDEX = new Map(); // 표제어/alias(정규화) -> entry
let MAX_KEY = 1;       // 최장 키 길이 (그리디 스캔 상한)

function norm(s) {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function buildIndex(dict) {
  const idx = new Map();
  let max = 1;
  const consider = (key, e, isPrimary) => {
    const k = norm(key);
    if (!k) return;
    // 표제어는 항상 등록(고유), 별칭은 빈 자리만 채움 → 표제어 우선 + 별칭 충돌은 먼저 온 것이 이김.
    if (isPrimary || !idx.has(k)) idx.set(k, e);
    if (k.length > max) max = k.length;
  };
  for (const e of dict) consider(e.word, e, true);
  for (const e of dict) for (const a of e.aliases || []) consider(a, e, false);
  INDEX = idx;
  MAX_KEY = max;
}

async function loadDictionary() {
  const res = await fetch("data/ksl-dict.json");
  if (!res.ok) throw new Error("dict load failed: " + res.status);
  return (await res.json()).map(normalizeEntry);
}

// Step 4-B: 최장일치 그리디. 띄어쓰기 무관하게 문장을 스캔.
// 반환: [{type:"entry", entry} | {type:"unknown", text}] 순서대로.
// ponytail: 매 위치마다 최대 MAX_KEY까지 substring 조회 → O(n·MAX_KEY).
//           사전 수십 개 규모엔 충분. 커지면 트라이(trie)로 교체.
function matchSentence(text) {
  const s = norm(text);
  const out = [];
  let i = 0, unknown = "";
  const flush = () => { if (unknown) { out.push({ type: "unknown", text: unknown }); unknown = ""; } };

  while (i < s.length) {
    let hit = null, len = 0;
    for (let L = Math.min(MAX_KEY, s.length - i); L >= 1; L--) {
      const e = INDEX.get(s.slice(i, i + L));
      if (e) { hit = e; len = L; break; }
    }
    if (hit) { flush(); out.push({ type: "entry", entry: hit }); i += len; }
    else { unknown += s[i]; i += 1; }
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

function cardHTML(word, desc, cls) {
  return (
    '<div class="card' + (cls ? " " + cls : "") + '">' +
    '<p class="word">' + word + "</p>" +
    '<img class="frame" alt="' + word + ' 수형" />' +
    '<p class="desc">' + desc + "</p></div>"
  );
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

// 토큰 -> 렌더 카드 명세. frames 있으면 이미지 재생, 없으면 안내.
function toCard(token) {
  if (token.type === "entry") {
    const e = token.entry;
    return { html: cardHTML(e.word, e.description), frames: entryFrames(e) };
  }
  // 미지원 단어: 하이브리드 C — 지화 가능하면 지문자, 아니면 안내.
  const jamo = decomposeToJamo(token.text);
  if (jamo) {
    return {
      html: cardHTML(token.text, "지문자(지화): " + jamo.join(" · "), "finger"),
      frames: jamoFrames(jamo),
    };
  }
  return {
    html:
      '<div class="card unsupported"><p class="word">미지원: ' + token.text + "</p>" +
      '<p class="desc">지화로도 표현할 수 없는 문자예요.</p></div>',
    frames: null,
  };
}

function renderResults(tokens) {
  stopPlayers();
  const box = document.getElementById("result");
  if (tokens.length === 0) {
    box.innerHTML = '<p class="hint">번역할 말을 입력하면 바로 표시돼요.</p>';
    return;
  }
  const cards = tokens.map(toCard);
  box.innerHTML = cards.map((c) => c.html).join("");

  // frames 있는 카드에 순서대로 플레이어 연결.
  const imgs = box.querySelectorAll(".frame");
  let k = 0;
  for (const c of cards) if (c.frames) startPlayer(imgs[k++], c.frames);
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
    const labels = (res.handedness || []).map((h) => (h[0]?.categoryName === "Right" ? "오른손" : "왼손"));
    status.textContent = hands.length ? `손 ${hands.length}개 검출 (${labels.join(", ")}) · 21점` : "손이 보이지 않아요.";
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopHandTracking() {
  if (rafId) cancelAnimationFrame(rafId), (rafId = null);
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const video = document.getElementById("cam");
  if (video) video.srcObject = null;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("service-worker.js").catch(() => {})
  );
}

main();
