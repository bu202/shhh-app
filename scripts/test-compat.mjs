// **서버가 강제하는 클라이언트 호환성 계약** (2026-08-27 · K3 · 위협 80)
//
// ── 왜 별도 스위트인가 ─────────────────────────────────────────────────
// 이미 설치된 PWA 는 **옛 화면 코드를 계속 돌린다.** 캐시 이름이 세대별로 갈려도 이미 떠 있는
// 탭까지 바꾸지는 못한다. 2026-08-26 에 넣은 `buildMatches()` 는 그 사실을 화면에서 판정하는데,
// **옛 화면에는 그 코드 자체가 없다.** 그러니 「새 클라이언트가 검사하므로 옛 PWA 도 안전하다」는
// 성립하지 않는다 — 판정이 옛 세대에 없기 때문이다.
//
// 그래서 판정을 **서버**로 옮긴다. 계정 API·OAuth 시작·콜백은 지원되는 빌드에서 온 요청만 받고,
// 그 판정은 **인증·제공자 호출·D1/ledger 접근보다 앞**이다.
//
// ⚠️ **빌드 값은 인증이 아니다.** 공격자는 현재 값을 그대로 흉내낼 수 있다(공개 파일에 들어 있다).
//    이 계약이 막는 것은 **호환되지 않는 옛 클라이언트**이지 공격자가 아니다 — 인증·CSRF·
//    readiness·EDGE_GUARD 는 그대로 각자 막는다. 아래 C5 가 그 성질을 잰다.
// ⚠️ **정적 파일·`/health`·`/policies`·서비스워커 갱신 경로는 막지 않는다.** 막으면 옛 PWA 가
//    새 코드를 받을 길이 없어져 **영영 옛 세대에 갇힌다.**
import "./_workers-shim.mjs";
import assert from "node:assert";
import worker, {
  BUILD_HEADER, compatMode, routeTable, createAccountWithPolicy, newSession, makeState,
} from "../worker/index.js";
import { BUILD_ID } from "../worker/build-id.js";
import { makeD1, makeLedger, asRequest } from "./_d1.mjs";

const ORIGIN = "https://app.test";
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 11)).toString("base64url");
let n = 0;
const t = (m) => { n++; return m; };

const makeEnv = (extra = {}) => ({
  APP_ORIGIN: ORIGIN, STATE_KEY: "state-key-FIXTURE-1", RL_KEY: "rl-key-FIXTURE-2",
  DEV_RATE_LIMIT: "1",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tombstone-key-FIXTURE-3",
  DELETION_KEY: "deletion-key-FIXTURE-4", SESSION_ENVELOPE_KEY: "envelope-key-FIXTURE-5",
  TURNSTILE_SECRET: "ts-secret-FIXTURE-6", TURNSTILE_SITE_KEY: "site",
  KAKAO_ID: "id", KAKAO_SECRET: "s", NAVER_ID: "id", NAVER_SECRET: "s",
  DB: makeD1(), LEDGER: makeLedger(), ...extra,
});
let seq = 0;
const mkUser = async (env) => {
  const sub = "c" + ++seq;
  const uid = await asRequest(env, (fe) => createAccountWithPolicy(fe, "kakao", sub,
    { stateHash: "s-" + sub, stateExp: Date.now() + 600e3, occurredAt: Date.now() }));
  return { uid, token: await asRequest(env, (fe) => newSession(fe, uid)) };
};
const call = (env, path, { method = "GET", token, build = BUILD_ID, body } = {}) => {
  const h = {};
  if (token) h.Cookie = "shh_s=" + token;
  if (build !== null) h[BUILD_HEADER] = build;
  if (method !== "GET") h.Origin = ORIGIN;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(new Request("https://api.test/api" + path,
    { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};
const dbWrites = (env) =>
  env.DB._db.prepare("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM sessions)"
    + " + (SELECT COUNT(*) FROM policy_events) AS n").get().n;
const ledgerWrites = (env) =>
  env.LEDGER._db.prepare("SELECT (SELECT COUNT(*) FROM write_leases)"
    + " + (SELECT COUNT(*) FROM rate_limits) AS n").get().n;

// ══ C1. 계정 라우트는 **빌드 계약 없이는 열리지 않는다** ═══════════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  const cases = [
    ["헤더 없음", null],
    ["옛 버전", "v10-000000000000"],
    ["빈 문자열", ""],
    ["모양이 틀림", "not-a-build"],
    ["공백만", "   "],
    ["앞뒤에 값이 더 붙음", BUILD_ID + " , x"],
    ["대소문자만 다름", BUILD_ID.toUpperCase()],
    ["아주 긴 값", "v".repeat(5000)],
  ];
  for (const [label, build] of cases) {
    const before = [dbWrites(env), ledgerWrites(env)];
    const res = await call(env, "/book", { token: A.token, build });
    assert.equal(res.status, 426,
      t(`C1: ${label} 인데 ${res.status} 다 — 옛 클라이언트가 계정 API 에 닿는다`));
    const d = await res.json();
    assert.equal(d.updateRequired, true, t(`C1: ${label} 응답에 갱신 필요 표시가 없다`));
    assert.ok(!JSON.stringify(d).includes(A.uid), t(`C1: ${label} 응답에 내부값이 실렸다`));
    // ⛔ **DB 를 만지기 전에 끝난다.** 옛 클라이언트가 자원을 태우지 못한다.
    assert.deepEqual([dbWrites(env), ledgerWrites(env)], before,
      t(`C1: ${label} 인데 DB 를 만졌다 — 판정이 DB 접근보다 뒤다`));
  }
  // 양성 대조 — 맞는 값이면 그대로 열린다.
  assert.equal((await call(env, "/book", { token: A.token })).status, 200,
    t("C1: 현재 빌드인데도 막았다 — 아무도 앱을 못 쓴다"));
}

// ══ C2. 인증이 필요 없는 계정 라우트도 같다 (가입 시작 · 로그인 시작) ══════
{
  const env = makeEnv();
  const before = [dbWrites(env), ledgerWrites(env)];
  const su = await call(env, "/signup/start", { method: "POST", build: "v1-old",
    body: { provider: "kakao", terms: true, age14: true, pv: "x" } });
  assert.equal(su.status, 426, t(`C2: 옛 빌드의 가입 시작이 ${su.status} 다`));
  // 로그인 시작은 **최상위 이동**이라 헤더를 붙일 수 없다 — 계약은 쿼리다.
  const noQ = await worker.fetch(new Request("https://api.test/api/login/kakao?return=" + ORIGIN), env);
  assert.equal(noQ.status, 426, t(`C2: 빌드 없는 로그인 시작이 ${noQ.status} 다 — 제공자로 보낸다`));
  const old = await worker.fetch(
    new Request(`https://api.test/api/login/kakao?return=${ORIGIN}&b=v1-old`), env);
  assert.equal(old.status, 426, t(`C2: 옛 빌드의 로그인 시작이 ${old.status} 다`));
  assert.deepEqual([dbWrites(env), ledgerWrites(env)], before,
    t("C2: 거절하면서 DB 를 만졌다"));
  const ok = await worker.fetch(
    new Request(`https://api.test/api/login/kakao?return=${ORIGIN}&b=${BUILD_ID}`), env);
  assert.equal(ok.status, 302, t(`C2: 현재 빌드의 로그인 시작이 ${ok.status} 다`));
  assert.ok(!(ok.headers.get("Location") || "").includes("b=v1-old"), t("C2: 옛 값이 제공자로 나갔다"));
}

// ══ C3. **정적 화면·상태·정책·서비스워커 갱신 경로는 막지 않는다** ═════════
// 막으면 옛 PWA 가 새 코드를 받을 길이 없어 영영 갇힌다.
{
  const env = makeEnv();
  for (const p of ["/health", "/ready", "/policies"]) {
    const res = await worker.fetch(new Request("https://api.test/api" + p), env);
    assert.notEqual(res.status, 426,
      t(`C3: ${p} 가 426 이다 — 옛 PWA 가 자기가 낡았다는 것조차 알 수 없다`));
  }
  // `/health` 는 옛 클라이언트가 **자기 세대를 확인하는 유일한 창구**다. 빌드를 답해야 한다.
  const h = await (await worker.fetch(new Request("https://api.test/api/health"), env)).json();
  assert.equal(h.build, BUILD_ID, t("C3: /health 가 서버 세대를 안 알려준다"));
}

// ══ C4. 라우트 표 전수 — 계약이 없는 라우트가 하나도 없다 ══════════════════
{
  const rows = routeTable();
  assert.ok(rows.length >= 20, t(`C4: 라우트 표를 못 읽었다 (${rows.length})`));
  const exempt = rows.filter((r) => r.compat === null).map((r) => r.src);
  assert.equal(exempt.length, 3,
    t(`C4: 계약 면제 라우트가 ${exempt.length}개다 — 셋(health·ready·policies)이어야 한다: ${exempt}`));
  for (const r of rows)
    assert.ok(r.compat === null || ["header", "query", "state"].includes(r.compat),
      t(`C4: 모르는 계약 방식이다: ${r.src} → ${r.compat}`));
  // 함수와 표가 같은 말을 하나.
  assert.equal(compatMode("GET", "/book"), "header", t("C4: /book 계약이 헤더가 아니다"));
  assert.equal(compatMode("GET", "/login/kakao"), "query", t("C4: 로그인 시작 계약이 쿼리가 아니다"));
  assert.equal(compatMode("GET", "/cb/kakao"), "state", t("C4: 콜백 계약이 state 가 아니다"));
  assert.equal(compatMode("GET", "/health"), null, t("C4: /health 가 면제가 아니다"));
}

// ══ C5. **빌드 값은 인증이 아니다** ════════════════════════════════════════
// 맞는 값을 그대로 흉내내도 인증·CSRF 는 그대로 막는다.
{
  const env = makeEnv();
  assert.equal((await call(env, "/book")).status, 401,
    t("C5: 빌드만 맞으면 세션 없이 단어장을 준다"));
  assert.equal((await call(env, "/book", { method: "PUT", body: { words: [] } })).status, 401,
    t("C5: 빌드만 맞으면 세션 없이 저장된다"));
  const A = await mkUser(env);
  const res = await worker.fetch(new Request("https://api.test/api/book", {
    method: "PUT", headers: { Cookie: "shh_s=" + A.token, [BUILD_HEADER]: BUILD_ID,
                              Origin: "https://evil.test", "Content-Type": "application/json" },
    body: JSON.stringify({ words: [] }) }), env);
  assert.equal(res.status, 403, t("C5: 빌드가 맞으면 낯선 origin 의 쓰기가 통과한다"));
}

// ══ C6. 콜백은 **state 안의 빌드**를 제공자 호출 앞에서 본다 ════════════════
{
  const env = makeEnv();
  let hits = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { hits++; return realFetch(...a); };
  try {
    // 옛 빌드로 시작한 state 는 만들 수 없다(시작 자체가 426). 그래서 **직접 만든** 옛 state 로
    // 콜백을 두드린다 — 실제로 일어나는 경우다: 시작한 뒤에 새 배포가 나가면 그렇게 된다.
    const { makeState } = await import("../worker/index.js");
    const stale = await makeState(env, "kakao", ORIGIN, "", "x".repeat(64), "v1-old");
    const res = await worker.fetch(new Request(
      `https://api.test/api/cb/kakao?code=abc&state=${encodeURIComponent(stale)}`), env);
    assert.notEqual(res.status, 500, t("C6: 옛 state 콜백이 500 이다"));
    const loc = res.headers.get("Location") || "";
    assert.ok(res.status === 302 ? /#login=(stale|outdated)/.test(loc) : res.status === 426,
      t(`C6: 옛 빌드로 시작한 콜백이 그대로 진행됐다 (${res.status} ${loc})`));
    assert.equal(hits, 0, t(`C6: ★ 제공자 호출이 ${hits}번 나갔다 — code 가 소비된다`));
    assert.equal(dbWrites(env), 0, t("C6: 옛 빌드 콜백이 계정·세션을 만들었다"));
  } finally { globalThis.fetch = realFetch; }
}

// ══ C7. 브라우저가 그 헤더를 실제로 보낼 수 있나 ═══════════════════════════
// 커스텀 헤더 하나가 붙는 순간 **preflight 가 생긴다.** 허용 목록에 없으면 브라우저가
// `OPTIONS` 단계에서 막아, 다른 origin(개발용 localhost)에서는 계정 기능이 통째로 죽는다.
{
  const env = makeEnv({ DEV_ORIGINS: "1" });
  const res = await worker.fetch(new Request("https://api.test/api/book",
    { method: "OPTIONS", headers: { Origin: "http://localhost:8000" } }), env);
  const allow = res.headers.get("Access-Control-Allow-Headers") || "";
  assert.ok(allow.toLowerCase().includes(BUILD_HEADER),
    t(`C7: 허용 헤더 목록에 계약 헤더가 없다 — preflight 에서 막힌다: "${allow}"`));
}

// ══ C9. 안내 화면은 **APP_ORIGIN 을 모를 때도** 쓸 수 있어야 한다 ═════════
// 이 화면의 유일한 쓸모가 링크 하나다. `appOrigin()` 이 `null` 일 때 그 값을 그대로 쓰면
// `null/` 이 박혀 **누를 수는 있는데 아무 데도 안 가는 링크**가 된다.
{
  for (const bad of [{}, { APP_ORIGIN: "not a url" }, { APP_ORIGIN: "https://x.test/" }]) {
    const env = { ...makeEnv(), ...bad };
    if (!("APP_ORIGIN" in bad)) delete env.APP_ORIGIN;
    const res = await worker.fetch(new Request("https://api.test/api/login/kakao?b=old"), env);
    const html = await res.text();
    assert.equal(res.status, 426, t(`C9: ${JSON.stringify(bad)} 에서 상태가 ${res.status} 다`));
    assert.doesNotMatch(html, /"null\/?"|>null</,
      t(`C9: ★ ${JSON.stringify(bad)} 에서 화면에 null 이 박혔다`));
    assert.match(html, /<a[^>]+href="[^"]*\/"/,
      t(`C9: ★ ${JSON.stringify(bad)} 에서 누를 수 있는 링크가 사라졌다`));
  }
}

// ══ C8. 옛 설치형 PWA 가 **읽을 수 있는 화면** ═════════════════════════════
// 426 을 상태코드로만 돌려주면 top-level navigation 에서는 브라우저가 그 본문을 그대로
// 그린다 — 옛 클라이언트에는 그것을 해석할 코드가 없다. 사용자가 보는 것은 회색 화면에
// 적힌 영문 오류이거나, 콜백에서는 **아무 설명도 없는 `#login=outdated` 조각**이다.
// 그래서 이 두 자리는 **Worker 가 직접 만든 자립형 한국어 HTML** 을 준다.
//
// ⚠️ 자립형이란: 새 JS·CSS·서비스워커·외부 자원을 **하나도** 불러오지 않는다는 뜻이다.
//    옛 PWA 는 그것들을 못 받거나 옛 판을 캐시에서 꺼낸다.
{
  const env = makeEnv();
  const pages = [];
  for (const provider of ["naver", "kakao"]) {
    // ── a. 로그인 시작(top-level navigation)
    const res = await worker.fetch(new Request(
      `https://api.test/api/login/${provider}?b=old-build`,
      { headers: { Accept: "text/html,application/xhtml+xml" } }), env);
    assert.equal(res.status, 426, t(`C8-a(${provider}): 상태가 426 이 아니다 (${res.status})`));
    assert.match(res.headers.get("Content-Type") || "", /^text\/html; ?charset=utf-8$/i,
      t(`C8-a(${provider}): ★ 옛 클라이언트에게 HTML 이 아닌 것을 줬다`
        + ` (${res.headers.get("Content-Type")})`));
    assert.match(res.headers.get("Cache-Control") || "", /no-store/,
      t(`C8-a(${provider}): 안내 화면이 캐시될 수 있다`));
    pages.push(await res.text());
  }

  // ── b. 콜백 세대 불일치도 같은 화면이다(옛 판은 조각을 못 읽는다)
  {
    const st = await makeState(env, "kakao", ORIGIN, "n", "txn", "old-build");
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = async () => { hits++; return new Response("{}"); };
    try {
      const res = await worker.fetch(new Request(
        `https://api.test/api/cb/kakao?code=zzz&state=${encodeURIComponent(st)}`,
        { headers: { Accept: "text/html" } }), env);
      assert.equal(res.status, 426,
        t(`C8-b: ★ 콜백 불일치가 옛 조각 redirect 로 끝났다 (${res.status} `
          + `${res.headers.get("Location") || ""})`));
      assert.match(res.headers.get("Content-Type") || "", /text\/html/,
        t("C8-b: ★ 콜백 불일치가 HTML 안내를 안 준다"));
      assert.equal(hits, 0, t(`C8-b: 안내 화면을 주면서 제공자를 ${hits}번 불렀다`));
      pages.push(await res.text());
    } finally { globalThis.fetch = realFetch; }
  }

  // ── c. 화면이 실제로 쓸모가 있나 — 자립·한국어·최신 앱으로 가는 길
  for (const [i, html] of pages.entries()) {
    const w = t(`C8-c[${i}]`);
    assert.match(html, /<html[^>]*lang="ko"/, w + ": lang=ko 가 없다");
    assert.match(html, /<meta[^>]+name="viewport"/, w + ": viewport 가 없다 — 390px 에서 깨진다");
    assert.ok(/오래된|최신|업데이트/.test(html), w + ": ★ 한국어 설명이 없다");
    // ⚠️ **주소가 글자로 있는 것과 「누를 수 있는 것」은 다르다**(돌연변이 M127 이 처음에
    //    살아남았다 — 링크를 지워도 본문에 주소가 남아 있어 통과했다).
    assert.match(html, new RegExp(`<a[^>]+href="${ORIGIN}/?"`),
      w + ": ★ 최신 앱으로 갈 수 있는 링크가 없다");
    assert.ok(html.includes(ORIGIN), w + ": ★ 최신 앱으로 가는 주소가 없다");
    // 자립: 바깥 자원을 부르지 않는다.
    assert.doesNotMatch(html, /<script/i, w + ": ★ 스크립트를 넣었다 — 옛 PWA 에서 안 돈다");
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i, w + ": ★ 바깥 CSS 를 불렀다");
    assert.doesNotMatch(html, /<img|<iframe/i, w + ": ★ 바깥 자원을 불렀다");
    assert.doesNotMatch(html, /http-equiv="refresh"/i, w + ": ★ 자동 새로고침을 넣었다 — 고리가 된다");
    // 민감값 0건.
    assert.doesNotMatch(html, /zzz|code=|state=|shh_s|shh_t/, w + ": ★ OAuth 값이 화면에 실렸다");
  }
}

console.log(`test-compat: ${n}개 통과 — 계정 API·가입·로그인 시작·콜백의 빌드 계약 · `
  + `DB 접근 앞에서 거절 · 정적/상태/정책은 열림 · 라우트 표 전수 · 빌드는 인증이 아니다`);
