// KNN 지문자 분류 자체검증 + 임계(KNN_MAX) 근거 수치. `node scripts/test-knn.mjs`
// app.js 실제 features/knnClassify를 백업샘플로 검증(로직 중복 없음).
// ⚠️ 샘플 8장이 1.8초 정지버스트라 서로 near-duplicate → LOO는 과대평가. 클래스간 거리가 진짜 신호.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const localStorage = { getItem: () => null, setItem: () => {} };
const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8").replace(/\nmain\(\);\s*$/, "\n");
const M = new Function("localStorage", src + "\n; return { features, knnClassify, KNN_MAX, set: (s) => (knnSamples = s) };")(localStorage);
const S = JSON.parse(readFileSync(new URL("../data/ksl-knn-samples.backup.json", import.meta.url), "utf8"));

// 정규화 벡터 → 가짜 랜드마크. features()가 손목원점·|p9|=1로 정규화하므로 왕복 불변.
const toLm = (f) => Array.from({ length: 21 }, (_, i) => ({ x: f[2 * i], y: f[2 * i + 1] }));
assert.deepStrictEqual(M.features(toLm(S[0].f)), S[0].f, "features 왕복 불변이 깨짐");

// LOO: 자기 자신 빼고 분류
let ok = 0;
const miss = [];
S.forEach((s, i) => {
  M.set(S.filter((_, j) => j !== i));
  const p = M.knnClassify(toLm(s.f));
  p === s.label ? ok++ : miss.push(`${s.label}→${p}`);
});
console.log(`LOO(k=3): ${ok}/${S.length} = ${((100 * ok) / S.length).toFixed(1)}%  오분류: ${miss.join(", ") || "없음"}`);
assert(ok / S.length > 0.95, "LOO 정확도 95% 미만 — 샘플/임계 확인");

// 클래스간 최소거리: 임계로 자모를 가려낼 수 있는지의 상한
const dist = (a, b) => a.reduce((t, v, i) => t + (v - b[i]) ** 2, 0);
let minOther = Infinity, pair = "";
S.forEach((a) => S.forEach((b) => {
  if (a.label === b.label) return;
  const d = dist(a.f, b.f);
  if (d < minOther) (minOther = d), (pair = `${a.label}↔${b.label}`);
}));
console.log(`다른자모 최근접: ${minOther.toFixed(2)} (${pair}) · KNN_MAX=${M.KNN_MAX}`);
assert(minOther < M.KNN_MAX, "임계가 클래스간 거리보다 작음 — 이 임계는 자모 구분용이 아니라 비자모 거부용");

// 임계 거부: 자모가 아닌 손(모든 점이 손목에 뭉친 모양)은 미인식(null)이어야
M.set(S);
assert.strictEqual(M.knnClassify(toLm(new Array(42).fill(0))), null, "비자모 손모양이 거부되지 않음");
console.log("✅ 통과");
