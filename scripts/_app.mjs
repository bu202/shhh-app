// app.js 를 통째로 평가해 원하는 이름만 꺼낸다. 로직을 테스트에 복사하지 않기 위한 이음새.
// app.js 는 브라우저 전역(localStorage·location)을 최상위에서 건드리므로 최소 스텁을 넘긴다.
// 스텁이 없으면 테스트 전부가 ReferenceError 로 죽는다 — 실제로 한 번 그랬다.
import { readFileSync } from "node:fs";

// app.js 의 fetch("data/…") 를 디스크 읽기로 바꾼다. 이걸 붙여야 도구가 앱과 **같은 사전**을 본다.
// 안 붙였을 땐 verify.mjs 가 자기 사전을 따로 만들어 써서 '고마워'를 "사전에 없음"이라 답했다(앱은 고맙다로 푼다).
const fileFetch = async (p) => {
  try {
    const text = readFileSync(new URL("../" + p, import.meta.url), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404, json: async () => null };
  }
};

export function loadApp(returns, store = {}) {
  const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8")
    .replace(/\nmain\(\);\s*$/, "\n");
  const localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => (store[k] = String(v)),
    removeItem: (k) => delete store[k],
  };
  const location = { search: "", hash: "", pathname: "/", origin: "http://test" };
  return new Function("localStorage", "location", "fetch", `${src}\n; return { ${returns} };`)(localStorage, location, fileFetch);
}

// 앱이 실제로 쓰는 상태(진짜 사전 + 합성 + 검증 대장)를 그대로 세워서 돌려준다.
// 도구들이 사전을 각자 다시 병합하지 않게 하는 이음새 — 두 번째 진실을 만들지 않기 위해서.
export async function loadAppState(returns) {
  // INDEX 는 buildIndex 가 통째로 갈아끼우므로(재바인딩) 값이 아니라 함수로 꺼낸다.
  // 값으로 받으면 buildIndex 전의 빈 Map 을 잡고 있게 된다.
  const M = loadApp(`${returns}, buildIndex, loadDictionary, loadCompounds, index: () => INDEX`);
  M.buildIndex(await M.loadDictionary());
  await M.loadCompounds();
  return M;
}
