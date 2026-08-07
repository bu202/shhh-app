// network-first + 캐시 폴백. 온라인이면 항상 최신, 오프라인이면 캐시.
// (작은 정적 앱이라 cache-first의 속도 이점보다 stale 방지가 중요)
const CACHE = "sueo-v5";
// 앱이 첫 화면을 그리는 데 쓰는 것 전부. 데이터 파일을 빼면 **첫 방문 직후 오프라인**이 깨진다 —
// 첫 로드엔 SW 가 아직 페이지를 제어하지 않아 아래 fetch 핸들러의 런타임 캐시가 안 돈다(재방문부터 돎).
const ASSETS = [
  "./",
  "index.html",
  "privacy.html",
  "css/style.css",
  "js/app.js",
  "data/ksl-dict.json",
  "data/ksl-fulldict.json",
  "data/ksl-compounds.json",
  "data/ksl-verified.json",
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
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
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
