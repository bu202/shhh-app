// 서비스워커가 **무엇을 캐시에 넣지 않는가**. `node scripts/test-sw.mjs`
//
// 예전엔 모든 GET 을 그대로 넣었다. 그래서 네이버 로그인 왕복 주소(`?code=…&state=…`)가
// 기기의 Cache Storage 에 남았고, 404·502 같은 실패 응답이 **오프라인에서 성공처럼 되살아났다**.
// 둘 다 화면으로는 안 보이는 종류라 테스트가 없으면 영영 모른다(함정 32 와 같은 부류).
import assert from "node:assert";
import { readFileSync } from "node:fs";

// SW 는 브라우저 전역(self)을 쓰는 스크립트라 import 가 안 된다. 판정 함수만 떼어 온다 —
// scripts/test-fingers.mjs 가 app.js 에 쓰는 것과 같은 이음새다.
const src = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const block = src.match(/const SAFE_EXT[\s\S]*?\n}\n/)[0];
const API_PATH = (src.match(/const API_PATH = "([^"]+)"/) || [])[1];
assert.equal(API_PATH, "/api/", "API_PATH 가 바뀌었다 — 이 테스트가 옛 값을 재고 있다");
const self = { location: { origin: "https://shhh-app.pages.dev" } };
const { cacheable } = new Function("self", "API_PATH", `${block}; return { cacheable };`)(self, API_PATH);

const ok = { ok: true, type: "basic" };
const req = (url) => ({ url });
const yes = (url, res = ok) => assert.ok(cacheable(req(url), res), `캐시했어야 하는데 안 했다: ${url}`);
const no = (url, res = ok) => assert.ok(!cacheable(req(url), res), `캐시하면 안 되는데 했다: ${url}`);

const O = "https://shhh-app.pages.dev";

// 1. 평범한 정적 자산은 캐시한다. 이걸 잃으면 오프라인이 통째로 깨진다.
for (const u of ["/", "/index.html", "/privacy.html", "/css/style.css", "/js/app.js",
                 "/data/ksl-dict.json", "/icons/icon-192.png", "/manifest.webmanifest",
                 "/assets/fingerspelling/a.jpg"]) yes(O + u);

// 2. **로그인 왕복 주소는 절대 안 넣는다.** 네이버는 앱 주소로 code·state 를 달고 돌아온다 —
//    그 주소가 캐시에 남으면 일회용이어야 할 값이 기기에 저장된다.
for (const u of ["/?code=abc123&state=xyz", "/?state=xyz", "/?login=tok", "/?n=nonce",
                 "/?token=abc", "/?error=access_denied", "/index.html?code=abc"]) no(O + u);

// 3. 개인 응답(API)은 안 넣는다. 한 기기를 두 사람이 쓰면 앞사람 단어장이 뒷사람에게 뜬다(함정 34).
for (const u of ["/api/book", "/api/friends", "/api/health", "/api/me"]) no(O + u);

// 4. **실패 응답은 안 넣는다.** 넣으면 오프라인에서 그 오류가 성공처럼 되살아나,
//    앱이 고쳐진 뒤에도 계속 같은 오류를 본다.
for (const st of [{ ok: false, type: "basic" }, { ok: false, type: "error" }, { type: "opaqueredirect", ok: true }])
  no(O + "/index.html", st);
no(O + "/index.html", null);

// 5. 쿼리가 붙은 주소는 통째로 안 넣는다 — 캐시 키가 무한히 늘어난다
//    (개발 중 쓰는 `?t=<시각>` 하나가 방문할 때마다 새 항목을 만든다).
no(O + "/index.html?t=123");
no(O + "/data/ksl-dict.json?v=2");

// 6. ⚠️ **바깥 origin 의 수형 그림은 캐시되지 않는다.** `<img src>` 로 받으면 no-cors 라
//    브라우저가 opaque(`ok:false`·`status:0`)로 주고, opaque 는 성공인지 404 인지 알 수 없다 —
//    넣으면 오류 페이지가 성공처럼 되살아난다(이 파일이 이미 한 번 고친 결함이다).
//    2026-08-19 까지 이 자리에는 `{ok:true, type:"basic"}` 이라는 **실제로 오지 않는 응답**을
//    넣어 「캐시된다」고 통과시키는 단언이 있었다. 그건 오프라인 동작을 재는 것이 아니라
//    Node 목이 우리가 바라는 답을 하도록 시킨 것이다.
const IMG = "https://sldict.korean.go.kr/multimedia/multimedia_files/convert/20200409/IMG000227009.jpg";
const opaque = { ok: false, status: 0, type: "opaque" };
no(IMG, opaque);
no(IMG, { ok: false, status: 0, type: "error" });
// 같은 주소라도 **우리 origin 으로 옮겨 오면**(또는 CORS 로 받으면) 캐시된다 — 그때 허용
// 범위가 이미 좁아야 하므로, 호스트·경로·확장자 셋을 다 보는지는 여기서 계속 잰다.
yes(IMG);
no("https://sldict.korean.go.kr/board/notice.jpg");        // 허용 경로(/multimedia/)가 아니다
no("https://sldict.korean.go.kr/multimedia/x.php");        // 허용 확장자가 아니다
// 7. 그 밖의 바깥 주소는 안 넣는다. 아무 origin 이나 캐시하면 SW 가 남의 사이트 캐시가 된다.
for (const u of ["https://evil.example/x.js", "https://cdn.jsdelivr.net/npm/a.mjs",
                 "https://sldict.korean.go.kr/track?uid=1",
                 "https://sldict.korean.go.kr.evil.example/multimedia/a.jpg"]) no(u);
// 우리 origin 의 정상 응답도 opaque 로 오면 안 넣는다(있을 수 없지만 규칙은 하나여야 한다).
no(O + "/js/app.js", opaque);

// 8. 선캐시 목록에 API 나 쿼리가 섞여 들어가지 않았는지. 섞이면 install 의 addAll 이
//    통째로 실패해 SW 가 아예 안 붙는다.
const assets = [...src.matchAll(/^\s*"([^"]+)",\s*$/gm)].map((m) => m[1]);
for (const a of assets) assert.ok(!a.includes("?") && !a.startsWith("/api"), `선캐시 목록이 이상하다: ${a}`);

// 9. 캐시 버전이 올라갔는지. 안 올리면 이미 들어간 로그인 주소·오류 응답이 그대로 남는다.
const ver = (src.match(/const CACHE = PREFIX \+ "(v\d+)"/) || [])[1];
assert.ok(ver && Number(ver.slice(1)) >= 10, `캐시 버전이 안 올라갔다(${ver}) — 옛 캐시가 안 비워진다`);

// ── 10. 설치 → 활성 생명주기를 실제로 돌린다 ────────────────────────────
// 왜 필요한가: 위 검사들은 `cacheable` 이라는 **판정 함수 하나**만 봤다. 그래서 "옛 캐시가
// 실제로 지워지는가", "제어권을 언제 넘겨받는가"는 아무도 안 재고 있었고, 그 사이에
// 캐시 이름이 v10 에 멈춘 채로 자산 계약만 바뀌는 일이 실제로 벌어졌다 — 설치형 PWA 가
// v10 캐시의 **옛 friends.js** 를 계속 돌려 친구 화면이 「불러오는 중이에요…」에 멈췄다.
//
// Playwright 를 넣지 않은 이유: 여기서 재려는 것은 브라우저의 렌더링이 아니라 **이 파일의
// 생명주기 로직**이다. 실기기 확인(설치형 PWA 새로고침·오프라인)은 자동화가 대신할 수 없는
// 별개의 항목이라 사용자 체크리스트로 남긴다(.claude/rules/frontend-pwa.md).
function runSW({ existing = [], failAddAll = false, failDelete = null } = {}) {
  const store = new Map(existing.map((k) => [k, new Map()]));
  const log = [];
  const caches = {
    open: async (k) => {
      if (!store.has(k)) store.set(k, new Map());
      const m = store.get(k);
      return {
        // 진짜 Cache.addAll 은 **원자적**이다 — 하나라도 못 받으면 아무것도 안 넣고 거절한다.
        // 반쪽 세대가 생기지 않는 이유가 그것이라 셰임도 그렇게 둔다.
        addAll: async (list) => {
          if (failAddAll) { store.delete(k); throw new TypeError("Failed to fetch"); }
          for (const u of list) m.set(u, "ok");
        },
        put: async (req, res) => { m.set(req.url ?? String(req), res); },
      };
    },
    keys: async () => [...store.keys()],
    delete: async (k) => {
      if (failDelete === k) { log.push("delete-fail:" + k); throw new DOMException("QuotaExceeded"); }
      log.push("delete:" + k);
      return store.delete(k);
    },
    match: async () => undefined,
  };
  const handlers = {};
  const selfStub = {
    location: { origin: O },
    addEventListener: (n, fn) => { handlers[n] = fn; },
    skipWaiting: () => log.push("skipWaiting"),
    clients: { claim: async () => { log.push("claim"); } },
  };
  new Function("self", "caches", "fetch", src)(selfStub, caches, async () => ({ ok: true, type: "basic" }));
  return { handlers, store, log };
}
// 브라우저는 waitUntil 이 거절해도 **예외를 이벤트 밖으로 던지지 않는다**(콘솔에 적고 넘어간다).
// 셰임이 여기서 throw 하면 아래 검사가 "브라우저가 안 하는 일"을 재게 된다.
const fire = async (fn) => {
  const waits = [];
  fn({ waitUntil: (p) => waits.push(p), request: null, respondWith: () => {} });
  const rs = await Promise.allSettled(waits);
  return rs.every((r) => r.status === "fulfilled");
};

{
  const CACHE = "shhh-" + ver;
  // 옛 세대 캐시 · 더 옛날 이름 · **다른 앱의 캐시**(origin 을 공유하는 경우)를 함께 둔다.
  const sw = runSW({ existing: ["shhh-v10", "sueo-v3", "someone-elses-app"] });

  await fire(sw.handlers.install);
  assert.deepEqual([...sw.store.get(CACHE).keys()].sort(), [...assets].sort(),
    "install 이 선캐시 목록을 통째로 담지 않았다 — 반쪽짜리 세대가 생긴다");

  await fire(sw.handlers.activate);
  assert.deepEqual([...sw.store.keys()].sort(), [CACHE, "someone-elses-app"].sort(),
    "옛 세대 캐시가 남았거나 남의 앱 캐시를 지웠다");
  // **순서가 중요하다.** claim 이 지우기보다 먼저 오면, 제어권을 넘겨받은 순간에도 옛 세대
  // 캐시가 살아 있어 그 사이 요청이 어느 세대를 받을지 정해져 있지 않다.
  const claimAt = sw.log.indexOf("claim");
  const lastDelete = sw.log.map((x, i) => [x, i]).filter(([x]) => x.startsWith("delete:")).pop()?.[1] ?? -1;
  assert.ok(claimAt > lastDelete, "옛 캐시를 다 지우기 전에 제어권을 넘겨받았다");
  assert.ok(sw.log.includes("skipWaiting"), "새 세대가 기다리기만 하고 안 올라온다");

  // 이 세대의 캐시에는 **핵심 스크립트 네 개가 함께** 들어 있다. 하나라도 빠지면 온라인이
  // 흔들릴 때 옛 세대와 새 세대가 섞여 돈다.
  for (const js of ["js/app.js", "js/authApi.js", "js/auth.js", "js/friends.js"])
    assert.ok(sw.store.get(CACHE).has(js), `${js} 가 이 세대 캐시에 없다 — 세대가 섞일 수 있다`);
}

// ── 11. 선캐시가 실패하면 이 세대는 **아예 안 선다** ─────────────────────
// 자산 하나를 못 받았는데 install 이 성공하면 반쪽 세대가 캐시에 앉는다 — 그러면 오프라인에서
// 어떤 화면은 열리고 어떤 화면은 안 열린다. 그럴 바엔 **옛 세대가 그대로 도는 쪽**이 낫다
// (사용자는 옛 앱을 쓰지, 반쯤 깨진 앱을 쓰지 않는다).
{
  const sw = runSW({ existing: ["shhh-v10"], failAddAll: true });
  const okInstall = await fire(sw.handlers.install);
  assert.equal(okInstall, false, "선캐시가 실패했는데 install 이 성공했다 — 반쪽 세대가 선다");
  assert.ok(sw.store.has("shhh-v10"), "install 이 실패했는데 옛 세대 캐시가 사라졌다");
  assert.ok(!sw.store.has("shhh-" + ver), "실패한 install 이 반쪽 캐시를 남겼다");
}

// ── 12. 옛 캐시 하나를 못 지워도 **제어권은 넘겨받는다** ─────────────────
// 왜 이걸 재는가: 전에는 `Promise.all` 이었다. 지우기 하나가 거절하면 그 거절이 claim 까지
// 건너뛰어, **새 세대가 활성인데 떠 있는 탭은 계속 옛 세대**로 남는다 — 우리가 이미 겪은
// 「세대 혼합」이 이 경로로 그대로 재발한다. 못 지운 캐시는 이름이 달라 어차피 안 읽히지만,
// 제어권을 못 넘겨받는 것은 바로 화면에 나타난다.
{
  const CACHE = "shhh-" + ver;
  const sw = runSW({ existing: ["shhh-v10", "sueo-v3"], failDelete: "shhh-v10" });
  await fire(sw.handlers.install);
  await fire(sw.handlers.activate);
  assert.ok(sw.log.includes("delete-fail:shhh-v10"), "테스트가 지우기 실패를 못 일으켰다");
  assert.ok(sw.log.includes("claim"), "옛 캐시 하나를 못 지웠다고 제어권을 안 넘겨받았다 — 세대가 섞인다");
  assert.ok(!sw.store.has("sueo-v3"), "한 번 실패했다고 나머지 청소를 멈췄다");
  assert.ok(sw.store.has(CACHE), "새 세대 캐시가 없다");
}

console.log(`test-sw: 통과 — 로그인 왕복·API·실패 응답 미캐시, 정적 자산 ${assets.length}개 선캐시, 캐시 ${ver}, install→activate 세대 교체 · 선캐시 실패 · 청소 실패에도 claim`);
