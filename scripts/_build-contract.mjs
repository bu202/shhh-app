// **테스트 전용 어댑터** — 요청에 클라이언트 호환성 계약(위협 80)을 붙인다.
//
// 왜 있나: 2026-08-27 부터 계정 라우트는 요청이 **어느 화면 세대에서 왔는지**를 요구한다
// (`X-Shh-Build` 헤더, 로그인 시작은 `?b=`). 실제 앱에서는 `js/authApi.js` 가 한 자리에서
// 붙이는데, 회귀 스위트는 `new Request(...)` 를 직접 만드는 자리가 100곳이 넘는다.
// 그 100곳에 같은 값을 손으로 적으면 **한 곳만 빠뜨려도 그 테스트가 조용히 426 을 재게 된다.**
//
// ⚠️ **방어를 무르게 하지 않는다.** 이 파일은 `scripts/` 에만 살고 배포되지 않는다
//    (`scripts/test-dist.mjs` 가 비배포를 전수로 잰다). 서버 코드는 그대로다.
// ⚠️ **계약 자체를 재는 스위트는 이 파일을 import 하지 않는다**(`scripts/test-compat.mjs`).
//    거기서는 「헤더가 없다」·「옛 값이다」를 손으로 만들어야 하기 때문이다.
// ⚠️ 이미 헤더가 있거나 `b=` 가 있으면 **건드리지 않는다** — 테스트가 정한 값이 이긴다.
import { BUILD_ID } from "../worker/build-id.js";

const Base = globalThis.Request;
const HEADER = "x-shh-build";

class ContractRequest extends Base {
  constructor(input, init) {
    let url = typeof input === "string" ? input : (input && input.url) || "";
    // 로그인 시작은 최상위 이동이라 헤더를 못 쓴다 — 계약이 쿼리다.
    if (/\/login\/[^/?#]+/.test(url) && !/[?&]b=/.test(url))
      url += (url.includes("?") ? "&" : "?") + "b=" + encodeURIComponent(BUILD_ID);
    const next = init ? { ...init } : {};
    const h = new Headers((next.headers) || (typeof input === "object" && input ? input.headers : undefined) || {});
    if (!h.has(HEADER)) h.set(HEADER, BUILD_ID);
    next.headers = h;
    super(typeof input === "string" ? url : new Base(url, input), next);
  }
}
globalThis.Request = ContractRequest;
