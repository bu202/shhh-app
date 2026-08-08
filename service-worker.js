// network-first + 캐시 폴백. 온라인이면 항상 최신, 오프라인이면 캐시.
// (작은 정적 앱이라 cache-first의 속도 이점보다 stale 방지가 중요)
// 캐시 이름은 `PREFIX + 버전`. 주소를 /sueo-translator/ → /shhh-app/ 로 옮겼을 때 옛 경로 항목이
// 그대로 남았다(캐시는 경로가 아니라 origin 단위라 두 주소가 같은 캐시를 쓴다). 버전을 올려 통째로 비운다.
const PREFIX = "shhh-";
const CACHE = PREFIX + "v9";
// 로그인 API 는 **절대 캐시하지 않는다.** 아래 fetch 핸들러는 모든 GET 을 캐시에 넣는데,
// 그러면 한 기기를 두 사람이 쓸 때 앞사람의 단어장 응답이 캐시에 남아 뒷사람에게 보인다.
const API_HOST = "shhh-api.bu202.workers.dev";
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
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    // 우리 이름표가 붙은 것만 지운다. github.io 프로젝트 사이트는 **origin 을 다른 프로젝트와 공유**해서,
    // 이름표를 안 보면 bu202.github.io 의 다른 앱 캐시까지 이 SW 가 지워버린다.
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && (k.startsWith(PREFIX) || k.startsWith("sueo-")))
                      .map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).host === API_HOST) return;   // 로그인·단어장 응답은 캐시 밖에 둔다
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
