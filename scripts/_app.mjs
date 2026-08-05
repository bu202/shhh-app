// app.js 를 통째로 평가해 원하는 이름만 꺼낸다. 로직을 테스트에 복사하지 않기 위한 이음새.
// app.js 는 브라우저 전역(localStorage·location)을 최상위에서 건드리므로 최소 스텁을 넘긴다.
// 스텁이 없으면 테스트 전부가 ReferenceError 로 죽는다 — 실제로 한 번 그랬다.
import { readFileSync } from "node:fs";

export function loadApp(returns, store = {}) {
  const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8")
    .replace(/\nmain\(\);\s*$/, "\n");
  const localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => (store[k] = String(v)),
    removeItem: (k) => delete store[k],
  };
  const location = { search: "", hash: "", pathname: "/", origin: "http://test" };
  return new Function("localStorage", "location", `${src}\n; return { ${returns} };`)(localStorage, location);
}
