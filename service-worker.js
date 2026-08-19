// network-first + 캐시 폴백. 온라인이면 항상 최신, 오프라인이면 캐시.
// (작은 정적 앱이라 cache-first의 속도 이점보다 stale 방지가 중요)
// 캐시 이름은 `PREFIX + 버전`. 주소를 /sueo-translator/ → /shhh-app/ 로 옮겼을 때 옛 경로 항목이
// 그대로 남았다(캐시는 경로가 아니라 origin 단위라 두 주소가 같은 캐시를 쓴다). 버전을 올려 통째로 비운다.
const PREFIX = "shhh-";
// ⚠️ v10 으로 올린 이유: 옛 정책이 **로그인 왕복 주소(`?code=…&state=…`)와 오류 응답까지**
//    캐시에 넣고 있었다. 이름을 안 바꾸면 이미 들어간 그것들이 그대로 남는다.
//    버전을 올리면 activate 가 옛 캐시를 통째로 지운다(아래).
// ⚠️ **배포본의 이 이름은 빌드가 다시 쓴다.** `scripts/build.mjs` 가 선캐시 자산 전체의 해시를
//    뒤에 붙여 `shhh-v11-<해시12>` 로 만든다. 여기 숫자를 사람이 올려 주기를 기다리는 방식은
//    **실제로 잊었다**: friends.js·authApi.js 의 응답 계약을 바꾼 뒤에도 이름이 v10 그대로라,
//    설치형 PWA 가 v10 캐시의 옛 friends.js 를 계속 돌렸다(그 세대엔 실패 분기가 없어서
//    친구 화면이 「불러오는 중이에요…」에서 영영 멈췄다). 이제 자산이 바뀌면 이름이 자동으로 갈린다.
//    이 줄의 `v11` 은 사람이 읽는 앞자리일 뿐이고, `scripts/serve.py` 로 여는 로컬 개발용 값이다.
const CACHE = PREFIX + "v11";
// 로그인 API 는 **절대 캐시하지 않는다.** 아래 fetch 핸들러는 모든 GET 을 캐시에 넣는데,
// 그러면 한 기기를 두 사람이 쓸 때 앞사람의 단어장 응답이 캐시에 남아 뒷사람에게 보인다.
//
// ⚠️ 전에는 **호스트**로 걸렀다(`shhh-api.bu202.workers.dev`). API 가 같은 origin 의 `/api/*` 로
// 들어오면서 그 조건은 영영 거짓이 된다 — 고치지 않으면 조용히 함정 34 가 재발한다.
// 경로로 판정하는 이유도 같다: 호스트는 이제 앱과 구분되지 않는다.
const API_PATH = "/api/";
// 앱이 첫 화면을 그리는 데 쓰는 것 전부. 데이터 파일을 빼면 **첫 방문 직후 오프라인**이 깨진다 —
// 첫 로드엔 SW 가 아직 페이지를 제어하지 않아 아래 fetch 핸들러의 런타임 캐시가 안 돈다(재방문부터 돎).
const ASSETS = [
  "./",
  "index.html",
  "privacy.html",
  "css/style.css",
  "js/app.js",
  "js/authApi.js",
  "js/auth.js",
  "js/friends.js",
  "data/ksl-dict.json",
  "data/ksl-fulldict.json",
  "data/ksl-compounds.json",
  "data/ksl-verified.json",
  "data/ksl-meanings.json",
  "data/ksl-daily.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "manifest.webmanifest",
  // 정책 문서 번들. **지금 번들만** 넣는다 — 지난 판까지 선캐시하면 캐시가 계속 자라고,
  // 가입 화면이 옛 문서를 렌더하면서 서버는 새 해시를 기록하는 상태가 생긴다.
  // 이 사이의 줄은 `scripts/policies.mjs` 가 다시 쓴다. 손으로 고치지 않는다.
  // policies:begin — scripts/policies.mjs 가 다시 쓴다
  "policies/manifest.json",
  "policies/index.html",
  "policies/age14-2303810b39a1.txt",
  "policies/privacy-1d3d2d870876.html",
  "policies/summary-d474a58df31c.txt",
  "policies/terms-245e3ae48884.html",
  // policies:end
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  // ⚠️ **지우기와 claim 을 한 waitUntil 안에 둔다.** 예전엔 claim 이 밖에 있어서, 옛 캐시를 다
  // 지우기 전에 제어권이 넘어왔다 — 그 틈에 들어온 요청은 어느 세대를 받을지 정해져 있지 않았다.
  // 지운 뒤 claim 하면 새 SW 가 제어를 잡는 순간 남아 있는 캐시는 이 세대 하나뿐이다.
  e.waitUntil((async () => {
    // 우리 이름표가 붙은 것만 지운다. github.io 프로젝트 사이트는 **origin 을 다른 프로젝트와 공유**해서,
    // 이름표를 안 보면 bu202.github.io 의 다른 앱 캐시까지 이 SW 가 지워버린다.
    // ⚠️ **allSettled 다.** `Promise.all` 이면 옛 캐시 하나를 못 지웠을 때 그 거절이
    //    아래 claim 까지 통째로 건너뛴다 — 새 세대가 활성인데 **떠 있는 탭은 계속 옛 세대**가
    //    되고, 그게 정확히 우리가 이미 겪은 「세대 혼합」 증상이다. 못 지운 캐시는 이름이
    //    달라 어차피 안 읽히지만, 제어권을 못 넘겨받는 것은 바로 화면에 나타난다.
    //    청소 실패보다 세대 혼합이 무겁다.
    const keys = await caches.keys();
    await Promise.allSettled(keys.filter((k) => k !== CACHE && (k.startsWith(PREFIX) || k.startsWith("sueo-")))
                                 .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── 무엇을 캐시하나 ──────────────────────────────────────────────────────
// 예전엔 **모든 GET 을 그대로 캐시**했다. 그래서 두 가지가 새고 있었다:
//   ① 로그인 왕복 주소. 네이버는 앱 주소로 `?code=…&state=…` 를 달고 돌아오는데, 그 주소가
//      Cache Storage 에 남으면 **일회용이어야 할 code 와 state 가 기기에 저장된다.**
//      `#login=<토큰>` 은 해시라 요청에 안 실리지만, 쿼리 갈래는 실린다.
//   ② 실패 응답. 404·500·503 을 캐시에 넣으면 **오프라인에서 그 오류가 성공처럼 되살아난다** —
//      한 번 502 를 받은 사람은 앱이 고쳐진 뒤에도 계속 502 를 본다.
//
// 이제는 넣을 것만 적는다(allowlist). 새 요청 종류의 기본값이 "안 넣음"이 된다.
const SAFE_EXT = /\.(html|css|js|json|png|jpg|jpeg|svg|webmanifest|woff2?)$/i;
// 로그인 왕복에 쓰이는 이름들. 하나라도 있으면 그 주소는 캐시에 넣지 않는다.
const AUTH_PARAMS = ["code", "state", "login", "n", "token", "error"];

// 우리가 그림을 받아 오는 곳. **호스트 하나뿐이고 경로도 본다.**
const IMG_ORIGIN = "https://sldict.korean.go.kr";
const IMG_PATH = /^\/multimedia\//;

function cacheable(req, res) {
  if (!res) return false;
  // ⚠️ **opaque 를 캐시하지 않는다**(2026-08-19 에 이유를 적었다). `<img src>` 로 받는 바깥
  //    origin 응답은 no-cors 라 브라우저가 `type:"opaque"`·`ok:false`·`status:0` 으로 준다 —
  //    **성공인지 404 인지 우리가 알 수 없다.** 넣으면 오류 페이지가 성공처럼 캐시되어,
  //    이 파일이 이미 한 번 고친 「실패 응답이 오프라인에서 되살아난다」가 그대로 재발한다.
  //    (`!res.ok` 만으로도 걸리지만, 그러면 **왜** 안 넣는지가 코드에 없다.)
  // ⚠️ 그래서 **바깥 origin 의 수형 그림은 오프라인에서 안 뜬다.** 예전 주석은 반대로 적혀
  //    있었는데, 그건 이 조건이 생기기 전의 이야기가 아니라 **한 번도 참인 적이 없었다** —
  //    `ok:false` 는 처음부터 여기서 걸렸고, 테스트만 `{ok:true, type:"basic"}` 이라는
  //    실제로 오지 않는 응답을 넣어 통과시키고 있었다. 고치려면 그림을 우리 origin 으로
  //    옮기거나(같은 origin 이면 `basic` 이라 상태를 읽을 수 있다) CORS 를 요청해야 한다 —
  //    둘 다 이번 범위 밖이라 **지금 사실을 그대로 적어 둔다**(docs/OPS_RUNBOOK.md 「남은 것」).
  if (res.type === "opaque" || res.type === "opaqueredirect") return false;
  if (!res.ok) return false;                                            // 실패 응답은 안 넣는다
  const u = new URL(req.url);
  if (u.origin === self.location.origin) {
    if (u.pathname.startsWith(API_PATH)) return false;                  // 개인 응답
    if (AUTH_PARAMS.some((p) => u.searchParams.has(p))) return false;   // 로그인 왕복 주소
    if (u.search) return false;                                         // 그 밖의 쿼리도 안 넣는다(캐시가 무한히 는다)
    return u.pathname === "/" || u.pathname.endsWith("/") || SAFE_EXT.test(u.pathname);
  }
  // 수형 그림만 바깥 origin 예외다. 공개된 사전 이미지라 개인정보가 아니고, 주소에 우리
  // 사용자 정보가 실리지도 않는다. **호스트·경로·확장자 셋 다** 봐야 통과한다 —
  // 같은 호스트의 추적 주소(`/track?uid=…`)까지 넣지 않기 위해서다.
  // ⚠️ 위 opaque 조건 때문에 `<img>` 로 온 응답은 여기까지 오지 않는다. 이 갈래가 살아 있는
  //    이유는 언젠가 CORS 로 받거나 우리 origin 으로 옮겼을 때 **허용 범위가 이미 좁아야**
  //    하기 때문이다. 그때 「일단 다 넣고 나중에 좁히자」가 되면 SW 가 남의 사이트 캐시가 된다.
  return u.origin === IMG_ORIGIN && IMG_PATH.test(u.pathname) && SAFE_EXT.test(u.pathname);
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  // API 는 아예 손대지 않는다(가로채지도 않는다) — 두 번째 자물쇠.
  if (u.origin === self.location.origin && u.pathname.startsWith(API_PATH)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (cacheable(e.request, res)) {
          const copy = res.clone();
          // waitUntil 로 붙들어야 응답을 돌려준 뒤에도 쓰기가 끝까지 간다.
          // 안 붙들면 SW 가 잠들면서 캐시 쓰기가 중간에 끊길 수 있다.
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
