// 정적 화면까지 포함한 **호스트 잠금**. (2026-08-22 · 사용자 결정 0·1 · 위협 55)
//
// 왜 필요한가: WAF 레이트리밋 규칙은 **우리 존**에만 걸린다. `*.pages.dev` 는 Cloudflare 소유
// 존이라 규칙을 못 걸고, 그래서 그 주소로 오는 요청은 방어를 **통째로 건너뛴다.** API 쪽은
// `worker/index.js` 가 403 으로 막지만(같은 결정), 화면은 Pages 가 직접 주므로 여기가 아니면
// 막을 자리가 없다 — 그대로 두면 사용자가 pages.dev 에서 앱을 열고 로그인만 실패한다.
//
// ⚠️ **`EDGE_GUARD="waf"` 일 때만 돈다.** 지금처럼 선언이 없으면 아무것도 하지 않는다 —
//    커스텀 도메인이 붙기 전에 리다이렉트를 켜면 **지금 쓰는 주소가 죽는다.**
// ⚠️ GET·HEAD 만 옮긴다. 다른 method 를 리다이렉트하면 본문이 있는 요청이 두 번 나가거나
//    조용히 GET 으로 바뀐다 — 그쪽은 API 의 403 이 답한다.
// ⚠️ 308 이 아니라 **302** 다. 영구 리다이렉트는 브라우저가 오래 기억해서, 도메인 계획이
//    바뀌면 되돌릴 방법이 사용자 쪽에 없다.
export const onRequest = (ctx) => {
  const canonical = canonicalHost(ctx.env);
  const url = new URL(ctx.request.url);
  if (canonical && url.host !== canonical
      && (ctx.request.method === "GET" || ctx.request.method === "HEAD")) {
    url.host = canonical;
    url.protocol = "https:";
    url.port = "";
    return new Response(null, { status: 302, headers: { Location: url.toString() } });
  }
  return ctx.next();
};

// `worker/index.js` 의 `wafHost()` 와 **같은 규칙**이다. 여기서 다시 적는 이유는 Pages 가
// 정적 요청에 Worker 를 태우지 않기 때문이고, 두 곳이 어긋나지 않도록
// `scripts/test-dist.mjs` 가 규칙을 대조한다.
function canonicalHost(env) {
  if (env.EDGE_GUARD !== "waf") return null;
  try {
    const h = new URL(env.APP_ORIGIN).host;
    return h.endsWith(".pages.dev") ? null : h;
  } catch { return null; }
}
