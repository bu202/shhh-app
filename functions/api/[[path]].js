// Pages Functions 이음새. `/api/*` 로 오는 요청을 worker/index.js 에 그대로 넘긴다.
//
// **로직을 여기로 옮겨 적지 않는다.** scripts/test-friends.mjs 가 worker/index.js 를 직접 불러
// 35개를 재고 있어서, 코드가 이리로 이사하면 그 검사가 통째로 무너진다. 이 파일이 하는 일은
// Pages 의 호출 규약(onRequest)을 Worker 의 규약(fetch)으로 바꾸는 것 하나뿐이다.
//
// 왜 Worker 를 Pages 안으로 들였나: 앱과 API 가 **같은 origin** 이 되면
//   ① HttpOnly 쿠키가 성립하고 ② CSP 를 `connect-src 'self'` 로 조일 수 있고
//   ③ 네이버의 「서비스 URL 도메인 = Callback 도메인」 조건이 저절로 맞는다(함정 41 소멸).
import worker from "../../worker/index.js";

export const onRequest = (ctx) => worker.fetch(ctx.request, ctx.env);
