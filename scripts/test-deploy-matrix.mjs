// **배포 구성 행렬** — 실제로 배포돼 있는 구성에서 각 문이 무엇을 돌려주나
// (2026-08-28 · 위협 87)
//
// ── 왜 별도 스위트인가 ─────────────────────────────────────────────────
// 기존 스위트의 fixture 는 전부 `DEV_RATE_LIMIT: "1"` 을 들고 있다. 그 값은 **로컬 전용**이고
// 배포 가능한 설정 파일에 넣는 것이 금지돼 있어(`scripts/test-config.mjs`) 라이브에는 **없다.**
// 그래서 그 fixture 로 재는 것은 「문이 열린 배포」의 동작이고, **지금 라이브의 동작이 아니다.**
//
// 재현(2026-08-28): 지금 라이브와 같은 구성 — `EDGE_GUARD` 없음 · `LEDGER` 없음 · OAuth
// 시크릿 없음 — 에서 옛 설치형 PWA 가 `GET /api/login/naver?b=old-build` 로 오면
// **`{"error":"계정 기능이 아직 열리지 않았어요","mode":"unknown"}` 이 화면에 그대로 그려졌다.**
// 최상위 이동이라 브라우저가 본문을 그린다 — 옛 세대에는 그 JSON 을 읽을 코드가 없다.
// 위협 83 이 만든 자립형 한국어 안내(426)는 **남용 방어 뒤에 있어서 도달하지 못했다.**
//
// 그래서 이 스위트는 구성별로 fixture 를 만들고, 그 구성에서 여섯 문을 전부 두드린다.
// ⛔ **`DEV_RATE_LIMIT` 을 쓰는 fixture 는 `dev` 행 하나뿐이고, 그 사실을 D0 이 전수로 잰다.**
import "./_workers-shim.mjs";
import assert from "node:assert";
import worker, {
  BUILD_HEADER, guardMode, appOrigin, isNavPath, makeState,
} from "../worker/index.js";
import { BUILD_ID } from "../worker/build-id.js";
import { makeD1, makeLedger } from "./_d1.mjs";

const ORIGIN = "https://app.test";
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 11)).toString("base64url");
let n = 0;
const t = (m) => { n++; return m; };

// ── 구성 조각 ────────────────────────────────────────────────────────────
const SECRETS = {
  STATE_KEY: "state-key-FIXTURE-1", RL_KEY: "rl-key-FIXTURE-2",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tombstone-key-FIXTURE-3",
  DELETION_KEY: "deletion-key-FIXTURE-4", SESSION_ENVELOPE_KEY: "envelope-key-FIXTURE-5",
  TURNSTILE_SECRET: "ts-secret-FIXTURE-6", TURNSTILE_SITE_KEY: "site",
};
const OAUTH = { KAKAO_ID: "id", KAKAO_SECRET: "s", NAVER_ID: "id", NAVER_SECRET: "s" };
const okRL = { limit: async () => ({ success: true }) };
const throwRL = { limit: async () => { throw new Error("edge down"); } };

// 배포 구성 여덟. **`full` 을 뺀 일곱은 계정 라우트가 닫혀 있어야 한다**(dev 는 예외 — 로컬).
const CONFIGS = {
  // 계정 인프라가 전부 있는 배포(아직 존재한 적 없다).
  full: () => ({ APP_ORIGIN: ORIGIN, EDGE_GUARD: "ratelimit", RL: okRL,
                 DB: makeD1(), LEDGER: makeLedger(), ...SECRETS, ...OAUTH }),
  // **지금 라이브가 이것이다**(2026-08-24 배포 `7362d2f0`).
  none: () => ({ APP_ORIGIN: ORIGIN }),
  // 엣지 방어만 빠졌다 — 2026년 9월에 붙일 A안(도메인+WAF) 전까지의 상태.
  noGuard: () => ({ APP_ORIGIN: ORIGIN, DB: makeD1(), LEDGER: makeLedger(), ...SECRETS, ...OAUTH }),
  // ledger D1 만 빠졌다(원격에 아직 만들어지지 않았다).
  noLedger: () => ({ APP_ORIGIN: ORIGIN, EDGE_GUARD: "ratelimit", RL: okRL,
                     DB: makeD1(), ...SECRETS, ...OAUTH }),
  // 시크릿이 **일부만** 있다(위협 57 의 그 상태).
  partialSecrets: () => {
    const s = { ...SECRETS }; delete s.SESSION_ENVELOPE_KEY;
    return { APP_ORIGIN: ORIGIN, EDGE_GUARD: "ratelimit", RL: okRL,
             DB: makeD1(), LEDGER: makeLedger(), ...s, ...OAUTH };
  },
  // 모르는 선언. **기본값이 안전한 쪽이어야 한다.**
  unknownGuard: () => ({ APP_ORIGIN: ORIGIN, EDGE_GUARD: "무엇인가", RL: okRL,
                         DB: makeD1(), LEDGER: makeLedger(), ...SECRETS, ...OAUTH }),
  // 바인딩이 **있는데 부르면 던진다**(위협 52).
  throwingRL: () => ({ APP_ORIGIN: ORIGIN, EDGE_GUARD: "ratelimit", RL: throwRL,
                       DB: makeD1(), LEDGER: makeLedger(), ...SECRETS, ...OAUTH }),
  // 로컬 개발 전용. **배포 가능한 설정에 넣는 것이 금지돼 있다.**
  dev: () => ({ APP_ORIGIN: ORIGIN, DEV_RATE_LIMIT: "1",
                DB: makeD1(), LEDGER: makeLedger(), ...SECRETS, ...OAUTH }),
};
// 계정 라우트가 **끝까지 열리는** 구성. 나머지는 전부 어딘가에서 닫힌다 — 어디서 닫히는지는
// 구성마다 다르지만(남용 방어 · 게이트 · 부분 시크릿) **밖에서 보는 답은 503 하나**여야 한다.
const OPENS = new Set(["full", "dev"]);
// 남용 방어 판정만 따로. 「문이 열렸다」와 「끝까지 된다」는 다른 질문이다 —
// 섞으면 어디서 닫혔는지 모르는 채로 통과하는 회귀가 생긴다.
const GUARD = {
  full: "ratelimit", none: "none", noGuard: "none", noLedger: "ratelimit",
  partialSecrets: "ratelimit", unknownGuard: "none", throwingRL: "ratelimit", dev: "dev",
};

const get = (env, url, headers = {}) =>
  worker.fetch(new Request("https://api.test/api" + url,
    { headers: { Accept: "text/html,application/xhtml+xml", ...headers } }), env);

// ══ D0. **fixture 자체가 라이브와 같은 모양인가** ══════════════════════════
// 이 스위트가 막으려는 것은 결함이 아니라 **결함을 숨기는 fixture** 다.
{
  for (const [name, mk] of Object.entries(CONFIGS)) {
    const env = mk();
    if (name === "dev") {
      assert.equal(env.DEV_RATE_LIMIT, "1", t("D0: dev fixture 에 DEV_RATE_LIMIT 이 없다"));
      continue;
    }
    assert.ok(!("DEV_RATE_LIMIT" in env),
      t(`D0: ★ ${name} fixture 에 DEV_RATE_LIMIT 이 있다 — 배포에 없는 값으로 문을 열고 있다`));
  }
  // 남용 방어 판정을 **코드가 답한 값**으로 고정한다. 모르는 선언이 열리는 회귀가 여기서 걸린다.
  for (const [name, mk] of Object.entries(CONFIGS))
    assert.equal(guardMode(mk()), GUARD[name],
      t(`D0: ${name} 의 남용 방어 판정이 ${guardMode(mk())} 다 (예상 ${GUARD[name]})`));
}

// ══ D1. **옛 클라이언트의 로그인 시작은 어느 구성에서도 사람이 읽을 화면이다** ══
// ⛔ 이것이 이번 재현이다. 폐쇄 배포에서 raw JSON 503 이었다.
{
  for (const [name, mk] of Object.entries(CONFIGS)) {
    for (const p of ["naver", "kakao"]) {
      const env = mk();
      const res = await get(env, `/login/${p}?b=old-build`);
      const ct = res.headers.get("Content-Type") || "";
      assert.equal(res.status, 426,
        t(`D1(${name}/${p}): ★ 옛 빌드의 로그인 시작이 ${res.status} 다 — 안내에 못 닿는다`));
      assert.match(ct, /^text\/html/,
        t(`D1(${name}/${p}): ★ 옛 클라이언트에게 HTML 이 아닌 것을 줬다 (${ct})`));
      const html = await res.text();
      assert.ok(/오래된|최신|업데이트/.test(html),
        t(`D1(${name}/${p}): 안내가 한국어가 아니다`));
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
      assert.ok(/오래된 판/.test(title),
        t(`D1(${name}/${p}): ★ 탭 제목이 화면과 다른 말을 한다 ("${title}")`));
      assert.match(html, new RegExp(`<a[^>]+href="${ORIGIN}/?"`),
        t(`D1(${name}/${p}): 최신 화면으로 갈 링크가 없다`));
      assert.match(res.headers.get("Cache-Control") || "", /no-store/,
        t(`D1(${name}/${p}): 안내 화면이 캐시될 수 있다`));
    }
  }
  // 빌드 자체를 안 실은 옛 세대(쿼리가 아예 없다)도 같다.
  const res = await get(CONFIGS.none(), "/login/naver");
  assert.equal(res.status, 426, t(`D1: 빌드 없는 로그인 시작이 ${res.status} 다`));
  assert.match(res.headers.get("Content-Type") || "", /^text\/html/,
    t("D1: 빌드 없는 로그인 시작이 HTML 이 아니다"));
}

// ══ D2. **현재 빌드는 구성이 정하는 답을 그대로 받는다**(계약 우회 없음) ═══
{
  for (const [name, mk] of Object.entries(CONFIGS)) {
    const env = mk();
    const res = await get(env, `/login/kakao?b=${BUILD_ID}&return=${ORIGIN}`);
    if (OPENS.has(name)) {
      assert.equal(res.status, 302,
        t(`D2(${name}): 열린 구성인데 로그인 시작이 ${res.status} 다`));
    } else {
      assert.equal(res.status, 503,
        t(`D2(${name}): ★ 닫힌 구성인데 로그인 시작이 ${res.status} 다 — fail-closed 가 깨졌다`));
      // 최상위 이동이므로 **여기도 사람이 읽을 화면**이어야 한다.
      assert.match(res.headers.get("Content-Type") || "", /^text\/html/,
        t(`D2(${name}): ★ 폐쇄 503 이 최상위 이동에 raw JSON 으로 나갔다`));
      const html = await res.text();
      assert.ok(/열리지 않았|점검/.test(html), t(`D2(${name}): 닫힌 이유 안내가 한국어가 아니다`));
      // ⚠️ **탭 제목도 그 화면의 말이어야 한다**(실브라우저에서 잡았다). 고정 문자열이면
      //    폐쇄 화면의 제목이 「앱을 업데이트해 주세요」가 되어, 사용자가 앱을 지웠다 깔았다 한다.
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
      const h1 = (html.match(/<h1>([^<]*)<\/h1>/) || [])[1] || "";
      assert.ok(h1 && title.startsWith(h1),
        t(`D2(${name}): ★ 탭 제목이 화면과 다른 말을 한다 ("${title}" vs "${h1}")`));
      // ⛔ **무엇이 없는지 말하지 않는다.**
      assert.doesNotMatch(html, /EDGE_GUARD|LEDGER|SECRET|KEY|binding/i,
        t(`D2(${name}): ★ 설정 정보가 안내 화면에 실렸다`));
    }
  }
}

// ══ D3. **fetch 로 부르는 자리는 JSON 계약을 유지한다** ═══════════════════
// 화면 코드가 받아 자기 말로 바꾸는 자리다 — HTML 을 주면 그 코드가 통째로 깨진다.
{
  for (const [name, mk] of Object.entries(CONFIGS)) {
    const env = mk();
    // 계정 API(옛 빌드)
    const api = await worker.fetch(new Request("https://api.test/api/book",
      { headers: { [BUILD_HEADER]: "old-build" } }), env);
    assert.equal(api.status, 426, t(`D3(${name}): 옛 빌드 계정 API 가 ${api.status} 다`));
    assert.match(api.headers.get("Content-Type") || "", /application\/json/,
      t(`D3(${name}): ★ 계정 API 가 JSON 이 아닌 것을 줬다 — 화면 코드가 깨진다`));
    assert.equal((await api.json()).updateRequired, true,
      t(`D3(${name}): 계정 API 426 에 갱신 표시가 없다`));
    // 가입 시작(옛 빌드)
    const su = await worker.fetch(new Request("https://api.test/api/signup/start",
      { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json",
                                   [BUILD_HEADER]: "old-build" },
        body: JSON.stringify({ provider: "kakao", terms: true, age14: true, pv: "x" }) }), env);
    assert.equal(su.status, 426, t(`D3(${name}): 옛 빌드 가입 시작이 ${su.status} 다`));
    assert.match(su.headers.get("Content-Type") || "", /application\/json/,
      t(`D3(${name}): ★ 가입 시작이 JSON 이 아닌 것을 줬다`));
    // 현재 빌드의 계정 API 도 JSON 이고, **세션 없이 200 이 나오는 구성은 없다.**
    // ⚠️ 상태코드는 구성마다 다르다 — 값싼 문(envelope 검사)이 먼저 401 을 주는 구성도 있고
    //    남용 방어·게이트가 먼저 503 을 주는 구성도 있다. 여기서 재는 것은 **모양**이다.
    const closed = await worker.fetch(new Request("https://api.test/api/book",
      { headers: { [BUILD_HEADER]: BUILD_ID } }), env);
    assert.ok([401, 503].includes(closed.status),
      t(`D3(${name}): ★ 세션 없는 계정 API 가 ${closed.status} 다`));
    assert.match(closed.headers.get("Content-Type") || "", /application\/json/,
      t(`D3(${name}): ★ 계정 API 가 HTML 을 줬다 — 화면 코드가 깨진다`));
  }
}

// ══ D4. **콜백** — 최상위 이동은 화면, 앱이 부르는 자리는 JSON ════════════
{
  for (const [name, mk] of Object.entries(CONFIGS)) {
    const env = mk();
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = async () => { hits++; return new Response("{}"); };
    try {
      // `/cb/:p` 는 제공자가 브라우저를 되돌려보내는 자리 = **최상위 이동**이다.
      // 어디서 막히든(남용 방어 · 게이트 · state 검증) 사용자가 보는 것은 **사람이 읽을 화면**
      // 이거나 앱으로 돌려보내는 302 여야 한다. raw JSON·평문은 둘 다 실패다.
      const cb = await get(env, "/cb/kakao?code=zzz&state=made-up");
      assert.ok(cb.status !== 200, t(`D4(${name}): 위조 state 콜백이 200 이다`));
      if (cb.status !== 302) {
        assert.match(cb.headers.get("Content-Type") || "", /^text\/html; ?charset=utf-8/i,
          t(`D4(${name}): ★ 콜백 응답이 사람이 읽을 화면이 아니다 `
            + `(${cb.status} ${cb.headers.get("Content-Type")})`));
        const html = await cb.text();
        assert.match(html, /<a[^>]+href="[^"]*\/"/,
          t(`D4(${name}): ★ 콜백 실패 화면에 앱으로 돌아갈 링크가 없다`));
        assert.doesNotMatch(html, /zzz|code=|state=/,
          t(`D4(${name}): ★ 콜백 안내 화면에 OAuth 값이 실렸다`));
      }
      assert.equal(hits, 0, t(`D4(${name}): 닫힌·거절 갈래에서 제공자를 ${hits}번 불렀다`));
      // `/exchange/:p` 는 앱이 fetch 로 부른다 — **JSON 이어야 한다**.
      const ex = await worker.fetch(new Request(
        "https://api.test/api/exchange/naver?code=zzz&state=made-up"), env);
      assert.match(ex.headers.get("Content-Type") || "", /application\/json/,
        t(`D4(${name}): ★ /exchange 가 JSON 이 아닌 것을 줬다 (${ex.status})`));
    } finally { globalThis.fetch = realFetch; }
  }
}

// ══ D5. 옛 빌드로 시작한 콜백은 구성과 무관하게 **읽을 수 있는 화면** ═════
{
  for (const name of ["full", "dev"]) {
    const env = CONFIGS[name]();
    const st = await makeState(env, "kakao", ORIGIN, "n", "txn", "old-build");
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = async () => { hits++; return new Response("{}"); };
    try {
      const res = await get(env, `/cb/kakao?code=zzz&state=${encodeURIComponent(st)}`);
      assert.equal(res.status, 426, t(`D5(${name}): 옛 빌드 콜백이 ${res.status} 다`));
      assert.match(res.headers.get("Content-Type") || "", /^text\/html/,
        t(`D5(${name}): ★ 옛 빌드 콜백이 HTML 안내를 안 준다`));
      assert.equal(hits, 0, t(`D5(${name}): 안내를 주면서 제공자를 ${hits}번 불렀다`));
    } finally { globalThis.fetch = realFetch; }
  }
}

// ══ D6. **거절은 어느 DB 도 만지지 않는다** ════════════════════════════════
{
  const env = CONFIGS.full();
  const before = () => env.DB._db.prepare(
    "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM sessions) AS n").get().n
    + env.LEDGER._db.prepare("SELECT (SELECT COUNT(*) FROM write_leases)"
      + " + (SELECT COUNT(*) FROM rate_limits) AS n").get().n;
  const a = before();
  await get(env, "/login/naver?b=old-build");
  await worker.fetch(new Request("https://api.test/api/book",
    { headers: { [BUILD_HEADER]: "old" } }), env);
  assert.equal(before(), a,
    t("D6: ★ 옛 클라이언트를 거절하면서 DB 에 썼다 — 판정이 자원 소비보다 뒤다"));
}

// ══ D6-1. **호스트 잠금은 그대로 산다** (waf 모드) ═════════════════════════
// 계약 검사를 남용 방어 앞으로 옮겼으므로, 그 앞에서 무언가가 조용히 열리지 않았는지 잰다.
// ⚠️ WAF 규칙은 우리 존에만 걸리므로 `*.pages.dev` 로 오는 요청은 규칙을 통째로 건너뛴다 —
//    그 우회로가 막혀 있어야 「WAF 를 붙였다」가 계정 API 에 대해 참이 된다(위협 55).
{
  const env = { APP_ORIGIN: "https://shhh.example", EDGE_GUARD: "waf",
                DB: makeD1(), LEDGER: makeLedger(), ...SECRETS, ...OAUTH };
  assert.equal(guardMode(env), "waf", t("D6-1: fixture 가 waf 모드가 아니다"));
  const call = (host, build) => worker.fetch(new Request(
    `https://${host}/api/book`, { headers: { [BUILD_HEADER]: build } }), env);
  // 현재 빌드 · 잘못된 호스트 → **403 그대로**. 계약 검사가 이 자물쇠를 지나치지 않았다.
  assert.equal((await call("shhh-app.pages.dev", BUILD_ID)).status, 403,
    t("D6-1: ★ 현재 빌드가 호스트 잠금을 우회했다 — WAF 를 건너뛰는 주소가 열렸다"));
  // 옛 빌드는 그 앞에서 426 이다(둘 다 거절이고, 어느 쪽도 DB 를 안 만진다).
  assert.equal((await call("shhh-app.pages.dev", "old")).status, 426,
    t("D6-1: 옛 빌드가 호스트 잠금 응답을 받는다 — 갱신 안내에 못 닿는다"));
  // 맞는 호스트 · 현재 빌드 → 자물쇠를 지나 그 뒤 방어로 떨어진다(세션이 없으니 401).
  assert.equal((await call("shhh.example", BUILD_ID)).status, 401,
    t("D6-1: 맞는 호스트인데 계정 API 가 열리지 않는다"));
}

// ══ D7. 「최상위 이동인가」의 판정은 **경로 하나**가 소유한다 ══════════════
// 헤더로 판정하면 클라이언트가 응답 형식을 고를 수 있고, 라우트마다 적으면 갈라진다.
{
  for (const p of ["/login/kakao", "/login/naver", "/cb/kakao", "/cb/naver"])
    assert.equal(isNavPath(p), true, t(`D7: ${p} 가 최상위 이동으로 안 잡힌다`));
  for (const p of ["/exchange/naver", "/book", "/me", "/health", "/ready", "/policies",
                   "/signup/start", "/friends", "/session"])
    assert.equal(isNavPath(p), false, t(`D7: ${p} 가 최상위 이동으로 잡힌다`));
}

// ══ D8. `appOrigin` 을 모르는 폐쇄 배포에서도 안내가 깨지지 않는다 ═════════
{
  for (const bad of [{}, { APP_ORIGIN: "not a url" }, { APP_ORIGIN: "https://x.test/" }]) {
    const env = { ...CONFIGS.none(), ...bad };
    if (!("APP_ORIGIN" in bad)) delete env.APP_ORIGIN;
    assert.equal(appOrigin(env), null, t("D8: fixture 가 잘못된 APP_ORIGIN 이 아니다"));
    for (const url of ["/login/kakao?b=old", `/login/kakao?b=${BUILD_ID}`]) {
      const res = await get(env, url);
      const html = await res.text();
      assert.doesNotMatch(html, /"null\/?"|>null</,
        t(`D8: ★ ${url} 안내 화면에 null 이 박혔다`));
      assert.match(html, /<a[^>]+href="[^"]*\/"/,
        t(`D8: ★ ${url} 에서 누를 수 있는 링크가 사라졌다`));
    }
  }
}

console.log(`test-deploy-matrix: ${n}개 통과 — 배포 구성 8종 × 로그인 시작·콜백·교환·계정 API·`
  + `가입 시작 · 폐쇄 배포에서도 옛 PWA 가 읽을 화면 · 현재 빌드는 fail-closed 유지`);
