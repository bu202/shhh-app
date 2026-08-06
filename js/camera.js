// 6단계 카메라 — MediaPipe 손 랜드마크 + 지문자 인식(규칙 + KNN) + 한글 조합기.
//
// ⚠️ **index.html 이 이 파일을 로드하지 않는다.** 6단계로 미뤄둔 코드라 app.js 안에 있으면
//    쓰지도 않는 242줄을 매 로드마다 파싱한다. 되살리려면 index.html 에 #cam/#overlay 마크업과
//    data-go="camera" 탭을 붙이고, 진입점에서 `await import("./camera.js")` 후 setupSignInput().
//
// ⚠️ 자모 표(JAMO_IMG·CHO·JUNG·JONG)는 지금 app.js 에도 같은 것이 있다. app.js 가 아직
//    classic script 라 import 할 수 없어 생긴 **한시적 중복**이다(계획서 B단계에서 utils.js 로 합친다).
//    그때까지는 scripts/test-assemble.mjs 가 두 벌이 같은지 매번 대조해 조용한 어긋남을 막는다.
//
// ⚠️ MediaPipe 는 CDN 동적 import 다. 오프라인/배포용 로컬 vendoring 은 아직 TODO(함정 12).

// 자모 -> Wikimedia Commons 파일명(로마자). 32장 세트에 있는 base 자모만.
export const JAMO_IMG = {
  "ㄱ":"g","ㄴ":"n","ㄷ":"d","ㄹ":"r","ㅁ":"m","ㅂ":"b","ㅅ":"s","ㅇ":"ng",
  "ㅈ":"j","ㅊ":"ch","ㅋ":"k","ㅌ":"t","ㅍ":"p","ㅎ":"h","ㅆ":"ss",
  "ㅏ":"a","ㅐ":"ae","ㅑ":"ya","ㅒ":"yae","ㅓ":"eo","ㅔ":"e","ㅕ":"yeo","ㅖ":"ye",
  "ㅗ":"o","ㅛ":"yo","ㅜ":"u","ㅠ":"yu","ㅡ":"eu","ㅣ":"i","ㅚ":"oe","ㅟ":"wi","ㅢ":"ui"
};
// 초/중/종성 인덱스 -> base 자모 문자열(된소리는 겹침, 겹받침·이중모음은 성분으로 분해).
// ponytail: 된소리 ㄲ=ㄱㄱ 근사 표기 [?] — 실제 현행 표준과 미세차이 가능.
export const CHO = ["ㄱ","ㄱㄱ","ㄴ","ㄷ","ㄷㄷ","ㄹ","ㅁ","ㅂ","ㅂㅂ","ㅅ","ㅆ","ㅇ","ㅈ","ㅈㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
export const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅗㅏ","ㅗㅐ","ㅚ","ㅛ","ㅜ","ㅜㅓ","ㅜㅔ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
export const JONG = ["","ㄱ","ㄱㄱ","ㄱㅅ","ㄴ","ㄴㅈ","ㄴㅎ","ㄷ","ㄹ","ㄹㄱ","ㄹㅁ","ㄹㅂ","ㄹㅅ","ㄹㅌ","ㄹㅍ","ㄹㅎ","ㅁ","ㅂ","ㅂㅅ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

// 문자열 -> 자모 배열. 지화 불가(이미지 없는 자모/비한글 포함) 시 null.

// --- Phase 2 (C): 카메라 + 손 랜드마크 검출 스캐폴드 ---
// MediaPipe Hand Landmarker. ponytail: CDN 로드. 오프라인/배포용 로컬 vendoring은 배포 전 TODO.
const MP_VER = "0.10.14";
let landmarker = null, camStream = null, rafId = null, drawUtils = null, MpHand = null;

export async function startHandTracking() {
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

export function stopHandTracking() {
  if (rafId) cancelAnimationFrame(rafId), (rafId = null);
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const video = document.getElementById("cam");
  if (video) video.srcObject = null;
  signHist.length = 0;
}

// --- 한글 음절 조합기 (자모 스트림 → 완성형 문자열) ---
// 인식 방식(규칙/KNN)과 무관하게 재사용. 표준 자모 인덱스 테이블(라인 74의 지화용 CHO와 별개).
export function assembleHangul(jamos) {
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
export const KNN_K = 3, KNN_MAX = 8; // ponytail: 계기판(상태줄 d=)으로 실사용 중 조정. 미인식↑→올림.
let knnDbg = null; // ponytail: 실손 튜닝 계기판. {dist, label} 최근접 이웃. KNN_MAX 조정용.
// 최상위에서 localStorage 를 읽지 않는다 — 그렇게 했다가 테스트 4개가 한꺼번에 죽었다(함정 13).
// 처음 필요할 때 한 번 읽고, 그 뒤론 메모리 것을 쓴다.
let knnSamples = null;
function samples() {
  if (knnSamples) return knnSamples;
  try { knnSamples = JSON.parse(localStorage.getItem(SAMPLE_KEY)) || []; } catch { knnSamples = []; }
  return knnSamples;
}
export const setSamples = (s) => (knnSamples = s); // 테스트가 샘플을 갈아끼울 때만 쓴다
const saveSamples = () => localStorage.setItem(SAMPLE_KEY, JSON.stringify(samples()));
// 손목 원점 이동 + 손크기 스케일 정규화. 회전은 일부러 보존(방향이 자모 구분에 필요).
export function features(lm) {
  const wx = lm[0].x, wy = lm[0].y;
  const scale = Math.hypot(lm[9].x - wx, lm[9].y - wy) || 1e-9;
  const f = [];
  for (const p of lm) f.push((p.x - wx) / scale, (p.y - wy) / scale);
  return f;
}
export function knnClassify(lm) {
  if (samples().length < KNN_K) return undefined; // 샘플 부족 → 규칙 폴백 신호
  const f = features(lm);
  const d = samples()
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

export function setupSignInput() {
  const rec = document.getElementById("btn-record");
  const label = document.getElementById("train-label");
  const count = document.getElementById("sample-count");
  const showCount = () => (count.textContent = `샘플 ${samples().length}개`);
  const refBox = document.getElementById("ref-box");
  label.addEventListener("input", () => {          // 라벨 자모 → 참고 손모양 그림
    const file = JAMO_IMG[label.value.trim()];
    refBox.hidden = !file;
    if (file) refBox.querySelector("img").src = "assets/fingerspelling/" + file + ".jpg";
  });
  rec.addEventListener("click", () => {
    const j = label.value.trim();
    if (!j || !lastLm) return;
    samples().push({ label: j, f: features(lastLm) });
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
