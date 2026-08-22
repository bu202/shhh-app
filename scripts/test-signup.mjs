// 회원가입 · 가입 state · 정책 기록. `node scripts/test-signup.mjs`
//
// worker/index.js 를 **그대로 불러** 진짜 sqlite(D1 셰임) 위에서 돌린다.
// 여기가 틀리면 증상이 「약관을 본 적 없는 사람의 수락 기록이 남는다」라서 사람 눈에 안 보인다.
//
// 설계서 §13-5 의 T18~T21 · T23~T35 · T48 을 구현한다(T22 는 test-policies.mjs).
// ⚠️ **가장 먼저 온다.** 운영 코드는 `crypto.subtle.timingSafeEqual()` 을 부르는데
//    Node 에는 그 메서드가 없다 — 어댑터는 `scripts/` 에만 살고 배포되지 않는다.
import "./_workers-shim.mjs";
import assert from "node:assert";
import worker, {
  createAccountWithPolicy, findUser, newSession, requiredPolicyKinds, REQUIRED_POLICY_EVENTS,
  makeSignupState, takeSignupState, stateTombstone,
} from "../worker/index.js";
import { POLICY_BUNDLE } from "../worker/policies.js";
import { TURNSTILE_ACTION, providerPossible } from "../worker/index.js";
import { makeD1, makeLedger, withLatency } from "./_d1.mjs";
import { createHash } from "node:crypto";

// 서버가 state 에 싣는 표 해시와 **같은 계산**이다(b64u(SHA-256(txn))).
// 여기서 다르게 계산하면 규칙이 두 벌이 되어, 서버가 바뀌어도 테스트는 옛 규칙을 통과시킨다.
const txnHash = (txn) => createHash("sha256").update(txn).digest("base64url");

const ORIGIN = "https://app.test";
// 32바이트. 길이가 다르면 서버가 fail-closed 다(아래 A 묶음이 잰다).
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 7)).toString("base64url");
let n = 0;
const t = (m) => { n++; return m; };

function makeEnv(extra = {}) {
  return {
    APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/",
    STATE_KEY: "test-signing-key", RL_KEY: "test-rl-key",
    // ⚠️ **로컬 전용 남용 방어 스위치**(2026-08-20 · 위협 50). 없으면 계정 라우트가 DB 를
    //    만지기 전에 503 이다 — 그 상태는 `test-stage34-closeout.mjs` T63-a 가 따로 잰다.
    //    이 값으로는 `/ready` 가 **절대** 200 이 되지 않는다(엣지 바인딩이라야 ready 다).
    DEV_RATE_LIMIT: "1",
    SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "test-tombstone-key", DELETION_KEY: "test-deletion-key",
    SESSION_ENVELOPE_KEY: "test-session-envelope-key",
    // 사람 확인(2026-08-22 · 결정 3). 없으면 가입이 503 이다 — 그 상태는 F 블록이 따로 잰다.
    TURNSTILE_SECRET: "test-turnstile-secret", TURNSTILE_SITE_KEY: "0xTEST",
    KAKAO_ID: "id", KAKAO_SECRET: "s", NAVER_ID: "id", NAVER_SECRET: "s",
    DB: makeD1(), LEDGER: makeLedger(), ...extra,
  };
}
const rows = (env, sql, ...a) => env.DB._db.prepare(sql).all(...a);
const count = (env, table, where = "", ...a) =>
  env.DB._db.prepare(`SELECT COUNT(*) n FROM ${table} ${where}`).get(...a).n;

// 제공자 서버를 부르지 않는다. **부른 횟수를 센다** — 「거부가 외부 호출 앞에서 일어났나」가
// 여러 테스트의 핵심 단언이라, 세지 않으면 "부르고 나서 버렸다"와 구분이 안 된다.
let providerCalls = 0;
const withProvider = async (subject, fn) => {
  const real = globalThis.fetch;
  providerCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("challenges.cloudflare.com")) {
      turnstile.calls++;
      return new Response(JSON.stringify(turnstile.answer), { headers: { "Content-Type": "application/json" } });
    }
    providerCalls++;
    return new Response(JSON.stringify(String(url).includes("token")
      ? { access_token: "tok" }
      : { id: subject, sub: subject, response: { id: subject } }),
      { headers: { "Content-Type": "application/json" } });
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
};

let ip = 0;
const asBrowser = (h = {}) => ({ ...h, "CF-Connecting-IP": `203.0.113.${(++ip % 250) + 1}` });

// Turnstile 검증 서버 대역. **부른 횟수와 마지막 본문을 기록한다** — 「거부가 외부 호출 앞에서
// 일어났나」와 「토큰을 실제로 보냈나」가 여러 단언의 핵심이다.
// ⚠️ 기본 답은 **실제 성공 응답의 모양**이다 — `success` 만 있는 답을 기본으로 두면
//    「action·hostname 을 안 보는 서버」가 그대로 통과한다(공식 문서: Validate the action
//    and hostname when specified). 그 둘이 빠지거나 어긋난 답은 아래 T70-b 가 넣어 본다.
export const TURNSTILE_HOST = new URL(ORIGIN).hostname;
export const turnstile = { calls: 0, last: null,
  answer: { success: true, action: "signup", hostname: TURNSTILE_HOST } };
const withTurnstile = (fn) => async (url, init) => {
  if (!String(url).includes("challenges.cloudflare.com")) return fn(url, init);
  turnstile.calls++;
  turnstile.last = String(init && init.body);
  return new Response(JSON.stringify(turnstile.answer), { headers: { "Content-Type": "application/json" } });
};

// 가입 시작 → { url, state, txn }. **진짜 라우트를 지난다** — 규칙을 테스트에 베끼지 않는다.
async function startSignup(env, body = {}, headers = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = withTurnstile(real);
  const res = await worker.fetch(new Request(ORIGIN + "/api/signup/start", {
    method: "POST",
    headers: asBrowser({ Origin: ORIGIN, "Content-Type": "application/json", ...headers }),
    body: JSON.stringify({ provider: "kakao", terms: true, age14: true, pv: POLICY_BUNDLE.pv,
                           turnstile: "test-token", ...body }),
  }), env).finally(() => { globalThis.fetch = real; });
  const set = res.headers.get("Set-Cookie") || "";
  const j = await res.json().catch(() => null);
  return {
    status: res.status, body: j,
    state: j && j.url ? new URL(j.url).searchParams.get("state") : null,
    txn: (set.match(/shh_t=([^;]*)/) || [])[1] || "",
  };
}

// 콜백. 카카오 갈래(302)와 네이버 갈래(200 JSON)를 둘 다 쓸 수 있게.
const cb = (env, state, txn, code = "c" + Math.random(), provider = "kakao") =>
  worker.fetch(new Request(
    `https://api.test/cb/${provider}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: asBrowser(txn ? { Cookie: "shh_t=" + txn } : {}) }), env);

const hashOf = (loc) => (String(loc).split("#")[1] || "");

// ══ A. 가입 state 자체 (AES-256-GCM) ═════════════════════════════════════
{
  const env = makeEnv();
  const s1 = await makeSignupState(env, "kakao", { back: ORIGIN, pv: "p", occurredAt: 1, terms: true, age14: true });
  const s2 = await makeSignupState(env, "kakao", { back: ORIGIN, pv: "p", occurredAt: 1, terms: true, age14: true });

  // A1. **형식**을 고정한다. exp 가 헤더에 있어야 복호화 **전에** AAD 를 재구성할 수 있다 —
  //     5판 설계는 exp 를 암호문 안에만 두면서 AAD 에도 넣으라고 적어 모순이었다.
  assert.match(s1, /^v1\.\d+\.[\w-]+\.[\w-]+$/, t("A1: 가입 state 형식이 v1.<exp>.<nonce>.<ct> 가 아니다"));
  // A2. **로그인 state 와 접두사로 갈린다.** 콜백이 이 하나로 두 형식을 가른다.
  const login = new URL((await worker.fetch(new Request(
    "https://api.test/login/kakao?n=x", { headers: asBrowser() }), env)).headers.get("Location"))
    .searchParams.get("state");
  assert.ok(!login.startsWith("v1."), t("A2: 로그인 state 가 v1. 로 시작한다 — 두 형식을 못 가른다"));
  assert.ok(s1.startsWith("v1."), t("A2: 가입 state 가 v1. 로 시작하지 않는다"));

  // A3. ★ **평문이 들어 있지 않다.** 서명뿐이던 예전 방식이면 여기서 걸린다 —
  //     b64u 는 인코딩이지 암호화가 아니라, 약관 수락·연령 진술이 그대로 읽혔다.
  const decoded = Buffer.from(s1.split(".")[3].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
  for (const leak of ["age14", "terms", "occurredAt", POLICY_BUNDLE.pv, "true"])
    assert.ok(!decoded.includes(leak), t(`A3: 암호문에서 '${leak}' 가 읽힌다 — 암호화가 아니라 인코딩이다`));

  // A4. ★ **nonce 는 요청마다 다르다.** 같은 키로 nonce 를 두 번 쓰면 GCM 은 평문이 복원되고
  //     위조까지 가능해진다. 100개를 뽑아 전부 다른지 본다.
  const nonces = new Set();
  for (let i = 0; i < 100; i++) nonces.add((await makeSignupState(env, "kakao", { back: ORIGIN })).split(".")[2]);
  assert.equal(nonces.size, 100, t("A4: nonce 가 겹친다 — CSPRNG 가 아니거나 유도된 값이다"));
  assert.notEqual(s1, s2, t("A4: 같은 입력이 같은 암호문을 낸다"));

  // A5. 정상 복호화. 실은 값이 그대로 나온다.
  const p = await takeSignupState(env, s1, "kakao");
  assert.equal(p.pv, "p", t("A5: 복호화한 값이 다르다"));
  assert.equal(p.occurredAt, 1, t("A5: occurredAt 이 안 실렸다"));

  // A6. ★ **AAD 결속.** 암호문이 그대로여도 다른 제공자에서는 복호화가 실패한다.
  assert.equal(await takeSignupState(env, s1, "naver"), null, t("A6: 다른 제공자에서 가입 state 가 열렸다"));
  // 다른 오리진(= 다른 배포)에서도 안 열린다.
  assert.equal(await takeSignupState({ ...env, APP_ORIGIN: "https://evil.test" }, s1, "kakao"), null,
    t("A6: 다른 오리진에서 가입 state 가 열렸다"));

  // A7. ★ **헤더 exp 를 고치면 열리지 않는다.** AAD 에 exp 가 들어 있어서, 만료를 늘리려는
  //     시도가 그 자리에서 복호화 실패가 된다(안쪽 exp 와의 대조는 그 다음 방어다).
  const parts = s1.split(".");
  const stretched = [parts[0], String(Number(parts[1]) + 60e3), parts[2], parts[3]].join(".");
  assert.equal(await takeSignupState(env, stretched, "kakao"), null, t("A7: exp 를 늘렸는데 열렸다"));

  // A8. 모르는 버전·잘린 값·너무 긴 값은 거부.
  assert.equal(await takeSignupState(env, "v2." + parts.slice(1).join("."), "kakao"), null, t("A8: 모르는 버전이 통과했다"));
  assert.equal(await takeSignupState(env, parts.slice(0, 3).join("."), "kakao"), null, t("A8: 조각이 모자란데 통과했다"));
  assert.equal(await takeSignupState(env, "v1.1.a." + "x".repeat(4000), "kakao"), null, t("A8: 2048자 넘는 값이 통과했다"));
  assert.ok(s1.length <= 2048, t("A8: 우리가 만든 state 가 이미 2048자를 넘는다"));

  // A9. ★ **키가 32바이트가 아니면 fail-closed.** 짧은 키를 조용히 늘려 쓰면 키 강도가
  //     설정 실수에 좌우된다. 「어떻게든 돈다」가 가장 나쁜 자리다.
  for (const bad of ["short", Buffer.alloc(16).toString("base64url"), Buffer.alloc(64).toString("base64url")]) {
    await assert.rejects(() => makeSignupState({ ...env, SIGNUP_STATE_KEY: bad }, "kakao", {}),
      t(`A9: ${bad.length}자 키로 state 를 만들었다`));
  }
  await assert.rejects(() => makeSignupState({ ...env, SIGNUP_STATE_KEY: undefined }, "kakao", {}),
    t("A9: 키 없이 state 를 만들었다"));

  // A10. **키가 다르면 못 연다.** 다른 용도의 키를 겸용하고 있지 않은지 여기서 드러난다.
  const other = Buffer.alloc(32, 9).toString("base64url");
  assert.equal(await takeSignupState({ ...env, SIGNUP_STATE_KEY: other }, s1, "kakao"), null,
    t("A10: 다른 키로 가입 state 가 열렸다"));

  // A11. 소비 표식은 **전용 키 HMAC** 이고, 단순 SHA-256 이 아니다.
  const h1 = await stateTombstone(env, s1);
  const plainSha = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s1)))
    .toString("base64url");
  assert.notEqual(h1, plainSha, t("A11: 소비 표식이 평문 SHA-256 이다 — state 를 본 사람이 행을 지목할 수 있다"));
  assert.notEqual(h1, await stateTombstone({ ...env, TOMBSTONE_KEY: "other" }, s1),
    t("A11: 키를 바꿔도 표식이 같다"));
  await assert.rejects(() => stateTombstone({ ...env, TOMBSTONE_KEY: undefined }, s1),
    t("A11: TOMBSTONE_KEY 없이 표식을 만들었다 — 평문 해시로 되돌아가면 안 된다"));
}

// ══ B. `POST /signup/start` 입력 검증 ════════════════════════════════════
{
  const env = makeEnv();
  // B1. 정상.
  const good = await startSignup(env);
  assert.equal(good.status, 200, t("B1: 정상 가입 시작이 막혔다"));
  assert.ok(good.state && good.txn, t("B1: state 나 표가 안 왔다"));
  assert.ok(good.body.url.startsWith("https://kauth.kakao.com/"), t("B1: 제공자 주소가 아니다"));

  // B2. ★ **필수 항목이 없거나 false 면 거부.** 「값이 있으면 통과」로 만들면 `age14: 0` 이 지나간다.
  for (const bad of [{ terms: false }, { age14: false }, { terms: undefined }, { age14: undefined },
                     { terms: "true" }, { age14: 1 }, { age14: "y" }]) {
    const r = await startSignup(env, bad);
    assert.equal(r.status, 400, t(`B2: ${JSON.stringify(bad)} 로 가입이 시작됐다`));
    assert.equal(r.body.url, undefined, t("B2: 거부했는데 제공자 주소를 돌려줬다"));
  }
  // B3. **거부는 아무것도 만들지 않는다.**
  assert.equal(count(env, "users"), 0, t("B3: 가입 시작만으로 계정이 생겼다"));
  assert.equal(count(env, "policy_events"), 0, t("B3: 가입 시작만으로 정책 기록이 생겼다"));
  assert.equal(count(env, "sessions"), 0, t("B3: 가입 시작만으로 세션이 생겼다"));
  assert.equal(count(env, "consumed_signup_states"), 0, t("B3: 가입 시작만으로 소비 표식이 생겼다"));

  // B4. Origin 이 없거나 남의 것이면 거부. (CSRF — 남의 사이트가 우리 가입을 시작시키지 못한다)
  for (const h of [{ Origin: undefined }, { Origin: "https://evil.test" }]) {
    const res = await worker.fetch(new Request(ORIGIN + "/api/signup/start", {
      method: "POST", headers: asBrowser({ "Content-Type": "application/json", ...h }),
      body: JSON.stringify({ provider: "kakao", terms: true, age14: true, pv: POLICY_BUNDLE.pv }),
    }), env);
    assert.equal(res.status, 403, t(`B4: Origin ${h.Origin} 으로 가입이 시작됐다`));
  }
  // B5. Content-Type 이 JSON 이 아니면 본문을 안 읽는다 → 필수 항목 없음으로 거부된다.
  const badCt = await startSignup(env, {}, { "Content-Type": "text/plain" });
  assert.equal(badCt.status, 400, t("B5: JSON 이 아닌 본문으로 가입이 시작됐다"));
  // B6. 없는 제공자.
  assert.equal((await startSignup(env, { provider: "facebook" })).status, 400, t("B6: 없는 제공자가 통과했다"));
  assert.equal((await startSignup(env, { provider: "__proto__" })).status, 400, t("B6: __proto__ 가 제공자로 통과했다"));
  // B7. ★ **정책 번들이 다르면 여기서 끝난다.** 제공자까지 갔다가 콜백에서 막으면 헛걸음이다.
  const stale = await startSignup(env, { pv: "0000deadbeef" });
  assert.equal(stale.status, 409, t("B7: 옛 pv 로 가입이 시작됐다"));
  assert.equal(stale.body.policyStale, true, t("B7: policyStale 을 안 알려준다"));
  // B8. 키가 없으면 가입을 **열지 않는다**(503). 이유는 밖으로 말하지 않는다.
  for (const k of ["SIGNUP_STATE_KEY", "TOMBSTONE_KEY"]) {
    const r = await startSignup({ ...env, [k]: undefined });
    assert.equal(r.status, 503, t(`B8: ${k} 없이 가입이 시작됐다`));
    assert.ok(!JSON.stringify(r.body).includes(k), t(`B8: 응답에 ${k} 이름이 새어 나왔다`));
  }
  // B9. 복귀 주소는 허용된 오리진만.
  assert.equal((await startSignup(env, { back: "https://evil.test/x" })).status, 400, t("B9: 남의 주소로 복귀가 허용됐다"));
  // B10. `/signup` 은 WRITE_ROUTES 에 없어서 **이중으로 세지 않는다**(전용 버킷 하나만 쓴다).
  //     ⚠️ 카운터는 **ledger** 다(2026-08-20 · 위협 49). 주 D1 을 세면 이제 언제나 0 이라
  //        「둘 이상 만들지 않았다」가 저절로 참이 되어 아무것도 재지 않는다.
  const rl = () => env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n;
  const buckets = rl();
  await startSignup(env);
  assert.equal(rl() - buckets, 1, t(`B10: 가입 시작 한 번이 리미터 행을 ${rl() - buckets}개 만들었다`));
}

// ══ C. 정상 가입과 정책 기록 (T18 · T24 · T48) ═══════════════════════════
{
  const env = makeEnv();
  const s = await startSignup(env);
  const res = await withProvider("kko-1", () => cb(env, s.state, s.txn));

  // T18. 계정 1행 + 정책 기록 **N행**. 각 원소가 **정확히 한 번씩**.
  assert.equal(res.status, 302, t("T18: 정상 가입이 실패했다"));
  assert.match(hashOf(res.headers.get("Location")), /login=ok/, t("T18: 성공인데 실패로 돌아갔다"));
  assert.match(hashOf(res.headers.get("Location")), /new=1/, t("T18: 새 가입인데 알려주지 않는다"));
  assert.equal(count(env, "users"), 1, t("T18: 계정이 1행이 아니다"));
  assert.equal(count(env, "policy_events"), REQUIRED_POLICY_EVENTS, t("T18: 정책 기록이 N행이 아니다"));
  const ev = rows(env, "SELECT kind, action, document_version, occurred_at, recorded_at FROM policy_events");
  for (const [kind, action] of requiredPolicyKinds) {
    const hit = ev.filter((e) => e.kind === kind && e.action === action);
    assert.equal(hit.length, 1, t(`T18: ${kind}/${action} 이 정확히 한 번이 아니다(${hit.length}회)`));
    assert.equal(hit[0].document_version, POLICY_BUNDLE.docs[kind].hash,
      t(`T18: ${kind} 의 document_version 이 서버 상수와 다르다`));
  }
  // 집합 밖 이벤트 0.
  const allowed = new Set(requiredPolicyKinds.map(([k, a]) => k + "/" + a));
  for (const e of ev) assert.ok(allowed.has(e.kind + "/" + e.action), t(`T18: 집합 밖 이벤트 ${e.kind}/${e.action}`));
  // **두 시각이 다르다.** 하나로 뭉개면 「체크한 때」와 「기록된 때」를 나중에 복원할 수 없다.
  assert.ok(ev.every((e) => e.occurred_at <= e.recorded_at), t("T18: occurred_at 이 recorded_at 보다 늦다"));

  // T24. 소비 표식 1행 · 세션 1행. **표식이 정상 가입을 막지 않는다**(대조군).
  assert.equal(count(env, "consumed_signup_states"), 1, t("T24: 소비 표식이 1행이 아니다"));
  assert.equal(count(env, "sessions"), 1, t("T24: 세션이 안 생겼다"));
  // 표식에 **raw state 도 provider 정보도 없다.**
  const tomb = rows(env, "SELECT * FROM consumed_signup_states")[0];
  assert.equal(Object.keys(tomb).sort().join(","), "expires_at,key_version,state_hash",
    t("T24: 소비 표식 표에 컬럼이 늘었다 — 이 표는 누가 가입했는지 몰라야 한다"));
  assert.ok(!s.state.includes(tomb.state_hash) && !tomb.state_hash.includes(s.state.slice(0, 20)),
    t("T24: 표식이 raw state 를 담고 있다"));

  // T48. ★ **서로 무관한 정상 가입 두 건**이 같은 pv · **같은 occurred_at** 을 가져도 둘 다 성공한다.
  //      실패하면 누군가 `UNIQUE(pv, occurred_at)` 류의 제약을 넣었다는 뜻이고, 그 순간
  //      **같은 순간에 가입한 두 번째 사람이 막힌다.**
  const t0 = Date.now();
  for (const sub of ["same-ms-A", "same-ms-B"]) {
    const uid = await createAccountWithPolicy(env, "naver", sub,
      { stateHash: "tomb-" + sub, stateExp: t0 + 600e3, occurredAt: t0, now: t0 });
    assert.ok(uid, t(`T48: ${sub} 가입이 실패했다 — 같은 순간의 두 번째 가입이 막힌다`));
  }
  assert.equal(count(env, "users"), 3, t("T48: 계정이 3행이 아니다"));
  assert.equal(count(env, "policy_events"), REQUIRED_POLICY_EVENTS * 3, t("T48: 정책 기록이 3N행이 아니다"));
  // 스키마에 그런 인덱스가 **아예 없는지**도 함께 본다(테스트가 통과해도 인덱스가 생길 수 있다).
  for (const idx of env.DB._db.prepare("PRAGMA index_list(policy_events)").all()) {
    assert.equal(idx.unique, 0, t(`T48: policy_events 에 UNIQUE 인덱스가 있다: ${idx.name}`));
  }
}

// ══ D. 원자성 (T19 · T21 · T28) ══════════════════════════════════════════
// 문장 하나를 실패시켜 **batch 전체가 롤백되는지** 잰다. D1 의 batch 가 단일 트랜잭션이라는
// 전제를 문서로 믿지 않고 실제로 잰다 — 이 전제가 깨지면 「계정은 있는데 약관 기록이 없다」가 된다.
function failOn(db, needle) {
  const real = db.prepare.bind(db);
  return {
    ...db, _db: db._db,
    prepare: (sql) => {
      const st = real(sql);
      if (!sql.includes(needle)) return st;
      return { ...st, bind: (...a) => { st.bind(...a); return { run: async () => { throw new Error("injected"); },
        first: () => st.first(), all: () => st.all() }; } };
    },
    batch: db.batch.bind(db),
  };
}
{
  // T19 · T28. 정책 이벤트 하나를 강제 실패 → users 0 · policy_events 0 · 소비 표식 0.
  //   ⚠️ 표식만 남고 계정이 없으면 **사용자가 영영 그 state 로 가입하지 못한다.**
  const env = makeEnv();
  env.DB = failOn(env.DB, "INSERT INTO policy_events");
  await assert.rejects(() => createAccountWithPolicy(env, "kakao", "atomic-1",
    { stateHash: "tomb-atomic", stateExp: Date.now() + 600e3, occurredAt: Date.now() }),
    t("T19: 이벤트가 실패했는데 예외가 안 났다"));
  assert.equal(count(env, "users"), 0, t("T19: 이벤트가 실패했는데 계정이 남았다"));
  assert.equal(count(env, "policy_events"), 0, t("T19: 부분 성공한 이벤트가 남았다"));
  assert.equal(count(env, "consumed_signup_states"), 0, t("T28: 계정은 없는데 소비 표식만 남았다"));
}
{
  // T21. 허용되지 않은 (kind, action) 조합은 **스키마 CHECK 가** 막는다.
  //      문서에만 있는 제약이 아니라 실제로 강제되는지 본다.
  const env = makeEnv();
  const db = env.DB._db;
  db.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('u1','k','1',0,0)");
  for (const [kind, action] of [["age14", "accepted"], ["privacy", "accepted"], ["xborder", "accepted"],
                                ["terms", "presented"], ["terms", "withdrawn"]]) {
    assert.throws(() => db.exec(
      `INSERT INTO policy_events (user_id,kind,action,document_version,occurred_at,recorded_at)
       VALUES ('u1','${kind}','${action}','h',1,1)`),
      /CHECK/, t(`T21: ${kind}/${action} 이 들어갔다 — CHECK 가 안 걸렸다`));
  }
  assert.equal(count(env, "policy_events"), 0, t("T21: CHECK 위반 뒤에 행이 남았다"));
  // 허용된 셋은 들어간다(막는 쪽만 재면 「전부 막는 CHECK」도 통과한다).
  for (const [kind, action] of requiredPolicyKinds) {
    db.exec(`INSERT INTO policy_events (user_id,kind,action,document_version,occurred_at,recorded_at)
             VALUES ('u1','${kind}','${action}','h',1,1)`);
  }
  assert.equal(count(env, "policy_events"), REQUIRED_POLICY_EVENTS, t("T21: 허용된 조합이 막혔다"));
}
{
  // T20(적응). 원문 명세는 「같은 kind 를 두 번 담아 보낸다」인데, 이 구현에는 클라이언트가
  //   kind 를 보내는 자리가 **아예 없다** — 서버가 자기 집합을 순회한다. 그러므로 재는 것을 바꾼다:
  //   ① 서버 집합에 중복이 없다 ② 본문에 kind·이벤트를 끼워 넣어도 기록이 늘지 않는다.
  assert.equal(new Set(requiredPolicyKinds.map(([k]) => k)).size, requiredPolicyKinds.length,
    t("T20: 서버의 필수 정책 집합에 같은 kind 가 둘 있다"));
  const env = makeEnv();
  const s = await startSignup(env, {
    kinds: ["terms", "terms", "age14"], events: [{ kind: "terms", action: "accepted" }],
    policy_events: [{ kind: "xborder", action: "accepted" }],
  });
  await withProvider("inject-1", () => cb(env, s.state, s.txn));
  assert.equal(count(env, "policy_events"), REQUIRED_POLICY_EVENTS,
    t("T20: 본문에 끼워 넣은 항목이 기록에 반영됐다"));
  assert.equal(count(env, "policy_events", "WHERE kind = 'xborder'"), 0, t("T20: xborder 가 기록됐다"));
}

// ══ E. state 재사용 (T23 · T25~T31 · T35) ════════════════════════════════
{
  // T23. state 를 받은 뒤 **정책 번들이 바뀌면** 기록하지 않는다.
  const env = makeEnv();
  const s = await startSignup(env);
  // 서버 상수를 바꿀 수는 없으니, 반대로 **옛 pv 가 든 state** 를 직접 만들어 같은 상황을 만든다.
  const oldState = await makeSignupState(env, "kakao", {
    back: ORIGIN, pv: "0000staleaa", occurredAt: Date.now(), terms: true, age14: true, txn: txnHash(s.txn),
  });
  const r = await withProvider("stale-1", () => cb(env, oldState, s.txn));
  assert.equal(providerCalls, 0, t("T23: 옛 pv 인데 제공자를 불렀다 — 검사가 code 교환 뒤에 있다"));
  assert.match(hashOf(r.headers.get("Location")), /login=(stale|denied)/, t("T23: 옛 pv 가 통과했다"));
  assert.equal(count(env, "users"), 0, t("T23: 옛 pv 로 계정이 생겼다"));
  assert.equal(count(env, "policy_events"), 0, t("T23: 옛 pv 로 정책 기록이 생겼다"));
}
{
  // T25. **순차 재사용은 쿠키 삭제로 막힌다** — 소비 표식이 없어도 여기까지는 막혔다.
  //      그래서 T26·T27(동시)이 진짜 시험대다.
  const env = makeEnv();
  const s = await startSignup(env);
  await withProvider("seq-1", () => cb(env, s.state, s.txn));
  const before = { u: count(env, "users"), e: count(env, "policy_events"),
                   ss: count(env, "sessions"), c: count(env, "consumed_signup_states") };
  const again = await withProvider("seq-1", () => cb(env, s.state, ""));   // 표가 지워진 정상 브라우저
  assert.equal(providerCalls, 0, t("T25: 표 없이 왔는데 제공자를 불렀다"));
  assert.equal(again.status, 400, t("T25: 표 없는 재사용이 통과했다"));
  assert.deepEqual({ u: count(env, "users"), e: count(env, "policy_events"),
                     ss: count(env, "sessions"), c: count(env, "consumed_signup_states") }, before,
    t("T25: 순차 재사용이 무언가를 바꿨다"));

  // T29. 쿠키를 **수동으로 되돌려** bound() 를 통과시켜도 소비 표식이 막는다. fail-closed 다.
  const r = await withProvider("seq-1", () => cb(env, s.state, s.txn));
  assert.equal(r.status, 302, t("T29: 응답 형태가 바뀌었다"));
  assert.match(hashOf(r.headers.get("Location")), /login=used/, t("T29: 이미 쓴 state 가 다시 통했다"));
  assert.deepEqual({ u: count(env, "users"), e: count(env, "policy_events"),
                     c: count(env, "consumed_signup_states") },
    { u: before.u, e: before.e, c: before.c }, t("T29: 재소비가 무언가를 만들었다"));
}
{
  // T30. **다른 브라우저**(표 없음/불일치)는 400 이고, code 교환 **전**이라 표식도 안 생긴다.
  const env = makeEnv();
  const s = await startSignup(env);
  const other = await startSignup(env);
  for (const txn of ["", other.txn]) {
    const r = await withProvider("other-1", () => cb(env, s.state, txn));
    assert.equal(providerCalls, 0, t("T30: 표가 안 맞는데 제공자를 불렀다"));
    assert.equal(r.status, 400, t("T30: 남의 표로 통과했다"));
  }
  assert.equal(count(env, "consumed_signup_states"), 0, t("T30: 인증 전에 소비 표식이 생겼다"));
  assert.equal(count(env, "users"), 0, t("T30: 인증 전에 계정이 생겼다"));
}
{
  // T31. **만료가 먼저 걸린다.** 만료된 state 는 표식을 보지도 않고 거부된다.
  const env = makeEnv();
  const s = await startSignup(env);
  const real = Date.now;
  Date.now = () => real() + 600e3 + 1000;     // 10분 + 1초
  const r = await withProvider("exp-1", () => cb(env, s.state, s.txn));
  Date.now = real;
  assert.equal(providerCalls, 0, t("T31: 만료된 state 인데 제공자를 불렀다"));
  assert.equal(r.status, 400, t("T31: 만료된 state 가 통과했다"));
  assert.equal(count(env, "consumed_signup_states"), 0, t("T31: 만료된 state 가 표식을 만들었다"));
}
{
  // T26 · T27. ★ **동시 재사용** — 이 묶음이 4판의 핵심이다.
  //   두 요청을 겹치게 띄운다. 둘 다 같은 `shh_t` 를 싣고 **서로 다른 새 code** 를 쓴다.
  //   T27 은 **서로 다른 제공자 회원번호**다 — `UNIQUE(provider, provider_subject)` 가
  //   여기서 아무것도 막지 못한다. 막는 것은 소비 표식뿐이다.
  for (const [label, subA, subB, users] of [["T26", "con-same", "con-same", 1],
                                            ["T27", "con-a", "con-b", 1]]) {
    const env = makeEnv();
    const s = await startSignup(env);
    env.DB = withLatency(env.DB, 3);          // 셰임은 동기라 지연을 넣어야 실제로 겹친다
    const mk = (sub) => {
      const real = globalThis.fetch;
      return async () => {
        globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("token")
          ? { access_token: "t" } : { id: sub, sub, response: { id: sub } }),
          { headers: { "Content-Type": "application/json" } });
        try { return await cb(env, s.state, s.txn, "code-" + sub + Math.random()); }
        finally { globalThis.fetch = real; }
      };
    };
    const [r1, r2] = await Promise.all([mk(subA)(), mk(subB)()]);
    const locs = [r1, r2].map((r) => hashOf(r.headers.get("Location")));
    assert.equal(locs.filter((l) => /login=ok/.test(l)).length, 1,
      t(`${label}: 성공이 정확히 하나가 아니다 — ${locs.join(" / ")}`));
    assert.equal(locs.filter((l) => /login=used/.test(l)).length, 1,
      t(`${label}: 거부가 stateUsed 가 아니다 — ${locs.join(" / ")}`));
    assert.equal(count(env, "users"), users, t(`${label}: 계정이 ${users}행이 아니다`));
    assert.equal(count(env, "policy_events"), REQUIRED_POLICY_EVENTS,
      t(`${label}: 정책 기록이 N행이 아니다 — 하나의 정책 행위가 두 곳에 귀속됐다`));
    assert.equal(count(env, "consumed_signup_states"), 1, t(`${label}: 소비 표식이 1행이 아니다`));
  }
}
{
  // T35. **로그인 state 는 동시 재사용을 감수한다** — 실린 증거가 없기 때문이다.
  //   붙이면 인증 없는 자리의 쓰기가 되살아나 DoS 표면이 커진다.
  //   ⚠️ 이 테스트가 「실패」로 바뀌면 그건 **설계 변경**이지 버그 수정이 아니다.
  const env = makeEnv();
  await createAccountWithPolicy(env, "kakao", "login-1",
    { stateHash: "pre-login", stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  const before = { u: count(env, "users"), e: count(env, "policy_events") };
  const r = await worker.fetch(new Request("https://api.test/login/kakao?n=x", { headers: asBrowser() }), env);
  const state = new URL(r.headers.get("Location")).searchParams.get("state");
  const txn = ((r.headers.get("Set-Cookie") || "").match(/shh_t=([^;]*)/) || [])[1];
  env.DB = withLatency(env.DB, 3);
  const [a, b] = await Promise.all([
    withProvider("login-1", () => cb(env, state, txn, "c1")),
    withProvider("login-1", () => cb(env, state, txn, "c2")),
  ]);
  assert.equal(count(env, "users"), before.u, t("T35: 로그인이 계정을 만들었다"));
  assert.equal(count(env, "policy_events"), before.e, t("T35: 로그인이 정책 기록을 만들었다"));
  assert.ok([a, b].every((x) => x.status === 302), t("T35: 로그인 응답 형태가 바뀌었다"));
}

// ══ F. 로그인 경로가 계정을 만들지 않는다 ════════════════════════════════
{
  const env = makeEnv();
  const r = await worker.fetch(new Request("https://api.test/login/kakao?n=x", { headers: asBrowser() }), env);
  const state = new URL(r.headers.get("Location")).searchParams.get("state");
  const txn = ((r.headers.get("Set-Cookie") || "").match(/shh_t=([^;]*)/) || [])[1];
  const res = await withProvider("newbie", () => cb(env, state, txn));
  // ★ 이번 단계의 핵심 변경. 예전에는 이 자리가 곧 가입이었다.
  assert.match(hashOf(res.headers.get("Location")), /login=signup_required/,
    t("F1: 로그인 경로로 신규 사용자가 통과했다 — 가입 화면을 우회한다"));
  assert.equal(count(env, "users"), 0, t("F1: 로그인 경로가 계정을 만들었다"));
  assert.equal(count(env, "policy_events"), 0, t("F1: 로그인 경로가 정책 기록을 만들었다"));
  assert.equal(count(env, "sessions"), 0, t("F1: 로그인 경로가 세션을 만들었다"));
  // 네이버 갈래도 같은 문을 쓴다. 한쪽만 막으면 공격자는 막힌 쪽을 안 쓴다.
  const r2 = await worker.fetch(new Request("https://api.test/login/naver?n=x", { headers: asBrowser() }), env);
  const st2 = new URL(r2.headers.get("Location")).searchParams.get("state");
  const tx2 = ((r2.headers.get("Set-Cookie") || "").match(/shh_t=([^;]*)/) || [])[1];
  const ex = await withProvider("newbie", () => worker.fetch(new Request(
    "https://api.test/exchange/naver?code=c&state=" + encodeURIComponent(st2),
    { headers: asBrowser({ Cookie: "shh_t=" + tx2 }) }), env));
  assert.equal(ex.status, 404, t("F2: /exchange 로 신규 사용자가 통과했다"));
  assert.equal((await ex.json()).signupRequired, true, t("F2: signupRequired 를 안 알려준다"));
  assert.equal(count(env, "users"), 0, t("F2: /exchange 가 계정을 만들었다"));

  // F3. **이미 계정이 있는 사람이 가입 state 로 와도** 계정이 늘지 않는다(세션만 발급).
  await createAccountWithPolicy(env, "kakao", "already",
    { stateHash: "pre-already", stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  const evBefore = count(env, "policy_events"), tombBefore = count(env, "consumed_signup_states");
  const s = await startSignup(env);
  const dup = await withProvider("already", () => cb(env, s.state, s.txn));
  assert.match(hashOf(dup.headers.get("Location")), /login=ok/, t("F3: 기존 계정이 가입 화면으로 오면 막힌다"));
  assert.ok(!/new=1/.test(hashOf(dup.headers.get("Location"))), t("F3: 기존 계정에 「가입했다」고 말한다"));
  assert.equal(count(env, "users"), 1, t("F3: 기존 계정이 있는데 계정이 늘었다"));
  assert.equal(count(env, "policy_events"), evBefore, t("F3: 기존 계정에 정책 기록이 또 쌓였다"));
  assert.equal(count(env, "consumed_signup_states"), tombBefore + 1,
    t("F3: 기존 계정 경로가 표식을 안 남겼다 — 그 state 를 다시 쓸 수 있게 된다"));
}

// ══ G. 표식 정리 (T33 · T34) ═════════════════════════════════════════════
{
  const env = makeEnv();
  const now = Date.now();
  const db = env.DB._db;
  db.exec(`INSERT INTO consumed_signup_states VALUES ('fresh',1,${now + 600e3})`);
  db.exec(`INSERT INTO consumed_signup_states VALUES ('stale',1,${now - 1000})`);
  // 가입이 성공하면 그 끝에서 만료된 것만 치운다.
  const s = await startSignup(env);
  await withProvider("sweep-1", () => cb(env, s.state, s.txn));
  // T33. **만료 전에 지우면 그 순간 replay 창이 다시 열린다.**
  assert.equal(count(env, "consumed_signup_states", "WHERE state_hash = 'fresh'"), 1,
    t("T33: 아직 안 만료된 표식을 지웠다 — replay 창이 다시 열린다"));
  // T34. 만료된 것만 사라지고, 새 가입은 정상 성공한다.
  assert.equal(count(env, "consumed_signup_states", "WHERE state_hash = 'stale'"), 0,
    t("T34: 만료된 표식이 안 지워졌다"));
  assert.equal(count(env, "users"), 1, t("T34: 정리가 정상 가입을 방해했다"));
}

// ══ H. 로그 (T32) ════════════════════════════════════════════════════════
{
  // ★ **raw state · state_hash · pv · provider_subject 가 로그에 0회.**
  //   운영 로그가 「누가 언제 무엇에 동의했는가」의 사본이 되면 안 된다.
  const env = makeEnv();
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  let s, hash;
  try {
    s = await startSignup(env);
    hash = await stateTombstone(env, s.state);
    await withProvider("log-subject-xyz", () => cb(env, s.state, s.txn));
    // 실패 경로도 함께 지난다 — 오류 자리가 가장 흔한 유출 지점이다.
    await withProvider("log-subject-xyz", () => cb(env, s.state, s.txn));
    await withProvider("log-subject-xyz", () => cb(env, "v1.1.a.b", s.txn));
    await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=bogus",
      { headers: asBrowser() }), env);
  } finally { console.log = realLog; }
  const joined = logs.join("\n");
  for (const [what, v] of [["raw state", s.state], ["state_hash", hash],
                           ["pv", POLICY_BUNDLE.pv], ["provider_subject", "log-subject-xyz"],
                           ["표 원본", s.txn]]) {
    assert.ok(!joined.includes(v), t(`T32: 로그에 ${what} 가 남았다`));
  }
  // 소스에도 없어야 한다 — 지금 안 찍는다고 다음 사람이 안 찍는 것은 아니다.
  const src = (await import("node:fs")).readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  for (const bad of [/console\.log\([^)]*\bstate\b/, /console\.log\([^)]*stateHash/,
                     /console\.log\([^)]*provider_subject/, /console\.log\([^)]*\bsubject\b/]) {
    assert.ok(!bad.test(src), t(`T32: worker 소스에 ${bad} 형태의 로그가 있다`));
  }
}

// ══ I. 우회로가 없는가 (R8) ══════════════════════════════════════════════
{
  // 「어떻게든 통과」 경로가 소스에 없어야 한다. 한 번 만들면 급할 때 쓰이고,
  // 급할 때가 정확히 쓰면 안 되는 때다.
  const fs = await import("node:fs");
  // ⚠️ **주석을 지우고 본다.** 「이런 우회로를 만들지 않는다」고 적은 주석 자체가 걸리면,
  //    검사를 통과시키려고 그 설명을 지우게 된다 — 규칙을 적는 것이 벌이 되면 안 된다.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of ["worker/index.js", "worker/ops.js", "worker/ledger.js", "worker/cleanup/index.js"]) {
    const src = strip(fs.readFileSync(new URL("../" + f, import.meta.url), "utf8"));
    for (const bad of [/\bforce\s*[:=]\s*true/i, /skipChecks/i, /ignoreTombstone/i,
                       /allowStale/i, /bypass/i, /pending_signups/]) {
      assert.ok(!bad.test(src), t(`I1: ${f} 에 우회 경로 ${bad} 가 있다`));
    }
  }
}

// ══ J. T70 — Turnstile 은 공개 회원가입에만, 그리고 **서버가 결과를 본다** ══
//
// 사용자 결정 3(2026-08-22). ⛔ 이 블록이 없으면 Turnstile 은 **화면 장식**이 된다 —
// 위젯을 붙여 놓고 서버가 그 결과를 한 번도 안 보는 구성이 가장 흔한 실패다.
{
  const st = (extra) => ({ ...extra });

  // ── T70-a. ★ 토큰이 없거나 비면 가입이 시작되지 않는다.
  {
    const env = makeEnv();
    for (const tk of [undefined, "", null, 123, {}, "x".repeat(2049)]) {
      turnstile.calls = 0;
      const r = await startSignup(env, { turnstile: tk });
      assert.equal(r.status, 400, t(`T70-a: turnstile=${JSON.stringify(tk)} 로 가입이 시작됐다`));
      assert.equal(r.body.humanCheck, true, t("T70-a: 사람 확인 실패를 화면이 구분할 수 없다"));
      assert.equal(r.state, null, t("T70-a: 거부했는데 state 를 줬다"));
      // 모양이 틀린 토큰은 **외부 호출도 안 나간다** — 그 호출 자체가 우리 비용이다.
      if (tk !== "x".repeat(2049) && tk !== undefined && tk !== "" && tk !== null)
        assert.equal(turnstile.calls, 0, t(`T70-a: 모양이 틀린 토큰(${typeof tk})으로 외부를 불렀다`));
    }
  }

  // ── T70-b. ★ 검증 서버가 거절하면 가입이 안 된다(위조·재사용·만료가 전부 여기로 온다).
  {
    const env = makeEnv();
    for (const ans of [{ success: false, "error-codes": ["invalid-input-response"] },
                       { success: false, "error-codes": ["timeout-or-duplicate"] },
                       { success: "true" }, { ok: true }, {}]) {
      turnstile.answer = ans;
      const r = await startSignup(env);
      assert.equal(r.status, 400, t(`T70-b: ${JSON.stringify(ans)} 인데 가입이 시작됐다`));
      assert.ok(!JSON.stringify(r.body).includes("timeout-or-duplicate"),
        t("T70-b: Cloudflare 오류 코드가 사용자 응답에 실렸다"));
    }
    turnstile.answer = { success: true, action: "signup", hostname: TURNSTILE_HOST };
  }

  // ── T70-c. ★ 검증 서버가 죽으면(네트워크 오류) **통과시키지 않는다.**
  {
    const env = makeEnv();
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) =>
      String(url).includes("challenges.cloudflare.com") ? Promise.reject(new Error("down")) : real(url, init);
    const res = await worker.fetch(new Request(ORIGIN + "/api/signup/start", {
      method: "POST", headers: asBrowser({ Origin: ORIGIN, "Content-Type": "application/json" }),
      body: JSON.stringify({ provider: "kakao", terms: true, age14: true, pv: POLICY_BUNDLE.pv,
                             turnstile: "tok" }),
    }), env).finally(() => { globalThis.fetch = real; });
    assert.equal(res.status, 400, t("T70-c: 검증 서버가 죽었는데 가입이 시작됐다 — fail-open 이다"));
  }

  // ── T70-d. ★ 시크릿이 없으면 **가입 자체가 열리지 않는다**(503, readiness 도 거짓).
  {
    const env = makeEnv({ TURNSTILE_SECRET: undefined });
    const r = await startSignup(env);
    assert.equal(r.status, 503, t("T70-d: TURNSTILE_SECRET 없이 가입이 시작됐다"));
    const h = await (await worker.fetch(new Request("https://api.test/health"), env)).json();
    assert.equal(h.signupReady, false, t("T70-d: 시크릿이 없는데 가입 준비됨이라고 말한다"));
    const h2 = await (await worker.fetch(new Request("https://api.test/health"),
      makeEnv({ TURNSTILE_SITE_KEY: undefined }))).json();
    assert.equal(h2.signupReady, false, t("T70-d: site key 가 없는데 가입 준비됨이라고 말한다"));
    assert.equal(h2.turnstileSiteKey, null, t("T70-d: 없는 site key 를 있다고 말한다"));
  }

  // ── T70-e. ★ **서버가 실제로 토큰을 보냈나.** 「검증했다」를 흉내만 내면 여기서 걸린다.
  {
    const env = makeEnv();
    turnstile.calls = 0; turnstile.last = null;
    await startSignup(env, { turnstile: "the-token" });
    assert.equal(turnstile.calls, 1, t(`T70-e: 검증 서버를 ${turnstile.calls}번 불렀다`));
    assert.ok(turnstile.last.includes("response=the-token"), t("T70-e: 사용자 토큰을 안 보냈다"));
    assert.ok(turnstile.last.includes("secret=test-turnstile-secret"), t("T70-e: 시크릿을 안 보냈다"));
  }

  // ── T70-f. ★ **콜백이 그 결과를 본다.** state 에 `hv` 가 없으면 계정이 안 만들어진다.
  //   Turnstile 을 지나지 않고 만든 state(= 가입 시작을 건너뛴 경로)를 그대로 흉내낸다.
  {
    const env = makeEnv();
    const txn = "txn-" + Math.random();
    const forged = await makeSignupState(env, "kakao", {
      back: ORIGIN, pv: POLICY_BUNDLE.pv, occurredAt: Date.now(), terms: true, age14: true,
      // 워커와 같은 방식으로 표 해시를 만든다(b64url SHA-256).
      n: "", txn: createHash("sha256").update(txn).digest("base64url"),   // hv 가 없다
    });
    const r = await withProvider("no-hv", () => cb(env, forged, txn));
    assert.notEqual(r.status, 302, t("T70-f: 사람 확인을 안 지난 state 로 가입이 끝났다"));
    assert.equal(count(env, "users"), 0, t("T70-f: 사람 확인 없이 계정이 만들어졌다"));
    assert.equal(providerCalls, 0, t("T70-f: 거부가 제공자 호출 뒤에 일어났다"));
  }

  // ── T70-g. ★ **정상 가입은 끝까지 간다.** 막는 쪽만 재면 「늘 거부」로 고쳐도 통과한다.
  {
    const env = makeEnv();
    const good = await startSignup(env);
    const r = await withProvider("hv-ok", () => cb(env, good.state, good.txn));
    assert.equal(r.status, 302, t(`T70-g: 사람 확인을 지난 정상 가입이 ${r.status} 로 끝났다`));
    assert.equal(count(env, "users"), 1, t("T70-g: 정상 가입인데 계정이 안 생겼다"));
  }

  // ── T70-h. 로그인과 인증된 읽기·쓰기에는 **적용하지 않는다**(결정 3: 초기 출시 범위).
  //   여기를 넓히는 날 이 단언을 **의도적으로** 고치게 만드는 자리다.
  {
    const env = makeEnv();
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("challenges.cloudflare.com")) { called++; }
      return real(url, init);
    };
    try {
      await worker.fetch(new Request("https://api.test/login/kakao"), env);
    } finally { globalThis.fetch = real; }
    assert.equal(called, 0, t("T70-h: 로그인 시작이 Turnstile 을 부른다 — 결정 3 의 범위 밖이다"));
  }
}

// ══ K. T73 — **부분 시크릿에서는 가입이 시작조차 되지 않는다** (2026-08-22) ══
//
// ⛔ 재현(고치기 전): `SESSION_ENVELOPE_KEY` 만 빠진 makeEnv 에서 `signupReady` 가 **참**이었고,
//    `/signup/start` 가 200 을 냈고, 콜백이 **users 1행 · policy_events 3행 · sessions 1행**을
//    만들고 제공자를 2번 불렀다. 그렇게 만든 세션은 다음 요청부터 전부 503 이라 **쓸 수 없는
//    계정**이 남는다 — 지우려면 `DELETION_KEY` 가 또 있어야 한다.
//    ⚠️ 이것은 「배포자가 조심하면 된다」가 아니다. 시크릿 12개를 손으로 넣는 절차에서
//       하나 빠지는 것은 **정상 범위의 사고**이고, 그때 사용자 데이터가 생기면 안 된다.
{
  // 뺐을 때 **가입이 열려서는 안 되는** 값 전부. 하나씩 빼고 세 자리를 같이 잰다.
  const REQUIRED = ["STATE_KEY", "RL_KEY", "SIGNUP_STATE_KEY", "TOMBSTONE_KEY",
                    "DELETION_KEY", "SESSION_ENVELOPE_KEY", "TURNSTILE_SECRET", "TURNSTILE_SITE_KEY"];

  // ── T73-a. 화면이 **버튼을 그리지 않는다.** `/health` 가 준비됐다고 말하면 사용자가 먼저 안다.
  for (const key of REQUIRED) {
    const env = makeEnv({ [key]: undefined });
    const h = await (await worker.fetch(new Request("https://api.test/health"), env)).json();
    assert.equal(h.signupReady, false, t(`T73-a: ${key} 가 없는데 가입 준비됨이라고 말한다`));
  }
  // 세션 서명 키가 없으면 **로그인 버튼도** 안 그린다 — 눌러도 쓸 수 없는 세션을 받는다.
  {
    const h = await (await worker.fetch(new Request("https://api.test/health"),
      makeEnv({ SESSION_ENVELOPE_KEY: undefined }))).json();
    assert.deepEqual(h.providers, [], t("T73-a: 세션 서명 키가 없는데 로그인 버튼을 그린다"));
  }
  // 반대쪽도 잰다 — 전부 있으면 참이어야 한다. 안 그러면 「늘 거짓」으로 고쳐도 통과한다.
  {
    const h = await (await worker.fetch(new Request("https://api.test/health"), makeEnv())).json();
    assert.equal(h.signupReady, true, t("T73-a: 전부 갖췄는데 가입 준비가 안 됐다고 말한다"));
    assert.ok(h.providers.length > 0, t("T73-a: 전부 갖췄는데 제공자가 비었다"));
  }

  // ── T73-b. ★ `/signup/start` 가 **503** 이다. 200 이면 그 뒤가 전부 열린다.
  for (const key of REQUIRED) {
    const env = makeEnv({ [key]: undefined });
    turnstile.calls = 0;
    const r = await startSignup(env);
    assert.equal(r.status, 503, t(`T73-b: ${key} 없이 가입 시작이 ${r.status} 로 열렸다`));
    assert.equal(r.state, null, t(`T73-b: ${key} 없이 state 를 발급했다`));
    // 설정이 덜 된 상태에서 **외부 호출을 내보내지 않는다** — 그 호출부터가 우리 비용이다.
    assert.equal(turnstile.calls, 0, t(`T73-b: ${key} 없이 검증 서버를 불렀다`));
  }

  // ── T73-c. ★★ 콜백까지 갔을 때 **어느 표에도 한 줄이 안 생긴다.**
  //   state 는 **온전한 env** 로 만들고(= 가입 시작은 지났던 왕복), 콜백만 시크릿이 빠진
  //   배포에서 처리한다. 배포 도중 시크릿이 지워진 상황이 정확히 이 모양이다.
  for (const key of REQUIRED) {
    const full = makeEnv();
    const good = await startSignup(full);
    assert.ok(good.state, t("T73-c: 준비용 정상 가입 시작이 실패했다"));
    // 같은 DB·ledger 를 쓰되 시크릿만 뺀다 — 행이 생기는지 봐야 하므로 저장소는 공유한다.
    const crippled = { ...full, [key]: undefined };
    const r = await withProvider("partial-" + key, () => cb(crippled, good.state, good.txn));
    assert.ok(!String(r.headers.get("Location") || "").includes("#login=ok"),
      t(`T73-c: ${key} 가 없는데 가입이 끝났다`));
    assert.equal(count(full, "users"), 0, t(`T73-c: ${key} 없이 계정이 만들어졌다`));
    assert.equal(count(full, "policy_events"), 0, t(`T73-c: ${key} 없이 정책 기록이 남았다`));
    assert.equal(count(full, "sessions"), 0, t(`T73-c: ${key} 없이 세션이 만들어졌다`));
    assert.equal(count(full, "consumed_signup_states"), 0,
      t(`T73-c: ${key} 없이 소비 표식이 남았다`));
    assert.equal(providerCalls, 0, t(`T73-c: ${key} 가 없는데 제공자를 ${providerCalls}번 불렀다`));
  }

  // ── T73-d. ★ **로그인도 같다.** 기존 사용자가 눌러도 쓸 수 없는 세션을 받으면 안 된다.
  {
    const full = makeEnv();
    const good = await startSignup(full);
    await withProvider("login-base", () => cb(full, good.state, good.txn));
    assert.equal(count(full, "users"), 1, t("T73-d: 준비용 가입이 안 됐다"));
    const before = count(full, "sessions");
    // 세션 서명 키만 빼고 **로그인** 왕복을 돈다.
    const crippled = { ...full, SESSION_ENVELOPE_KEY: undefined };
    const start = await worker.fetch(new Request("https://api.test/login/kakao"), crippled);
    assert.equal(start.status, 503, t(`T73-d: 세션 서명 키 없이 로그인 시작이 ${start.status} 였다`));
    // 시작을 막아도 **옛 링크가 콜백으로 직접 올 수 있다.** 거기서도 세션이 안 생겨야 한다.
    const lg = await worker.fetch(new Request("https://api.test/login/kakao"), full);
    const lstate = new URL(lg.headers.get("Location")).searchParams.get("state");
    const ltxn = (lg.headers.get("Set-Cookie").match(/shh_t=([^;]*)/) || [])[1];
    const r = await withProvider("login-partial", () => cb(crippled, lstate, ltxn));
    // ⚠️ 실패도 302 다(앱으로 되돌려보낸다). **상태 코드가 아니라 어디로 보내는지**를 본다.
    assert.ok(!String(r.headers.get("Location") || "").includes("#login=ok"),
      t("T73-d: 세션 서명 키 없이 로그인 콜백이 성공했다"));
    assert.equal(r.headers.get("Set-Cookie") === null
      || !/shh_s=[^;]+/.test(r.headers.get("Set-Cookie")), true,
      t("T73-d: 세션 서명 키 없이 세션 쿠키를 심었다"));
    assert.equal(count(full, "sessions"), before, t("T73-d: 세션 서명 키 없이 세션 행이 늘었다"));
    assert.equal(providerCalls, 0, t("T73-d: 거부가 제공자 호출 뒤에 일어났다"));
  }

  // ── T73-e. ★ 서명 함수 자체가 **없는 키로 조용히 돌지 않는다.**
  //   ⚠️ 이 단언은 **명시 검사가 없어도 통과한다** — `TextEncoder.encode(undefined)` 는 길이 0
  //      바이트라 `importKey` 가 거기서 던지기 때문이다(돌연변이 M6 이 살아남는 이유이고,
  //      그 사실을 보고서에 그대로 적었다). 그래도 재는 이유는 「없는 키로 세션이 만들어지지
  //      않는다」가 지켜야 할 성질이기 때문이다 — 나중에 서명 방식을 바꿔 길이 0 이 통과하는
  //      원시함수를 쓰게 되면 이 단언이 먼저 깨진다.
  {
    await assert.rejects(() => newSession({ ...makeEnv(), SESSION_ENVELOPE_KEY: undefined }, "u1"),
      t("T73-e: 세션 서명 키가 없는데 토큰이 만들어졌다"));
    n += 1;
  }
}

// ══ L. T74 — Turnstile 응답의 **action 과 hostname 까지** 본다 (2026-08-22) ══
//
// ⛔ 재현(고치기 전): `turnstileOk` 가 `success === true` 하나만 봤다. 그래서
//    ① 다른 자리(문의 폼 등)에 붙인 위젯의 토큰을 가입에 그대로 쓸 수 있고
//    ② 다른 도메인에 우리 site key 로 붙인 위젯에서 푼 토큰도 통과했다.
//    공식 문서는 「Validate the action and hostname when specified」라고 적는다.
{
  const HOST = TURNSTILE_HOST;
  const good = { success: true, action: "signup", hostname: HOST };

  // ── T74-a. ★ action 이 다르거나 없으면 거부다.
  for (const ans of [{ ...good, action: "contact" }, { ...good, action: "" },
                     { success: true, hostname: HOST }]) {
    turnstile.answer = ans;
    const r = await startSignup(makeEnv());
    assert.equal(r.status, 400, t(`T74-a: action=${JSON.stringify(ans.action)} 인데 가입이 시작됐다`));
  }

  // ── T74-b. ★ hostname 이 다르거나 없으면 거부다.
  for (const ans of [{ ...good, hostname: "evil.test" }, { ...good, hostname: "" },
                     { success: true, action: "signup" }]) {
    turnstile.answer = ans;
    const r = await startSignup(makeEnv());
    assert.equal(r.status, 400, t(`T74-b: hostname=${JSON.stringify(ans.hostname)} 인데 가입이 시작됐다`));
  }

  // ── T74-c. ★ 기준은 **`APP_ORIGIN`** 이지 **요청이 도착한 주소**가 아니다.
  //   같은 코드가 여러 주소로 뜬다(프로덕션 별칭 · `<해시>.pages.dev` · preview alias).
  //   도착 주소를 기준으로 삼으면 그중 아무 데서나 푼 토큰이 통과한다 — 호스트 잠금이
  //   막으려는 것과 같은 종류의 우회로다(위협 55).
  {
    const env = makeEnv();
    turnstile.answer = { ...good, hostname: "preview.example" };
    const real = globalThis.fetch;
    globalThis.fetch = withTurnstile(real);
    // 요청은 **다른 호스트**로 도착하지만 Origin 은 우리 것이다(같은 코드의 다른 별칭).
    const res = await worker.fetch(new Request("https://preview.example/api/signup/start", {
      method: "POST", headers: asBrowser({ Origin: ORIGIN, "Content-Type": "application/json" }),
      body: JSON.stringify({ provider: "kakao", terms: true, age14: true, pv: POLICY_BUNDLE.pv,
                             turnstile: "tok" }),
    }), env).finally(() => { globalThis.fetch = real; });
    assert.equal(res.status, 400,
      t("T74-c: 요청이 도착한 주소를 기준으로 삼아 다른 별칭에서 푼 토큰이 통과했다"));
    turnstile.answer = good;
  }

  // ── T74-c2. ★★ **`success` 를 독립적으로 잰다** (2026-08-22 · 돌연변이 M10 생존).
  //   ⛔ 왜 생겼나: T70-b 가 넣던 실패 응답에는 `action`·`hostname` 이 **없었다.** 그래서
  //      `success` 검사를 통째로 지워도 action/hostname 검사가 대신 막아 **스위트가 통과했다** —
  //      즉 「거절을 통과로 바꾸지 않는다」가 실제로는 다른 두 필드에 얹혀 있었다.
  //      세 필드는 각각 다른 것을 막으므로 **각각 재야 한다.**
  //   ⚠️ 여기 넣는 응답은 **셋 중 success 만 거짓**이다. 나머지 둘은 우리 값과 같다.
  for (const ans of [
    { success: false, action: "signup", hostname: HOST },
    { success: false, action: "signup", hostname: HOST, "error-codes": ["timeout-or-duplicate"] },
    { action: "signup", hostname: HOST },                       // success 자체가 없다
    { success: "true", action: "signup", hostname: HOST },      // 문자열은 참이 아니다
    { success: 1, action: "signup", hostname: HOST },           // 숫자도 아니다
  ]) {
    turnstile.answer = ans;
    const r = await startSignup(makeEnv());
    assert.equal(r.status, 400,
      t(`T74-c2: success=${JSON.stringify(ans.success)} 인데 가입이 시작됐다 — 나머지 필드에 얹혀 있다`));
  }
  turnstile.answer = good;

  // ── T74-d. ★ 정상 응답은 통과한다. 막는 쪽만 재면 「늘 거부」로 고쳐도 통과한다.
  {
    turnstile.answer = good;
    const r = await startSignup(makeEnv());
    assert.equal(r.status, 200, t(`T74-d: 정상 사람 확인이 ${r.status} 로 막혔다`));
  }

  // ── T74-e. ★ `APP_ORIGIN` 이 주소가 아니면 **부르지도 않고** 거부한다.
  {
    turnstile.answer = good;
    turnstile.calls = 0;
    const r = await startSignup(makeEnv({ APP_ORIGIN: "not-a-url" }));
    assert.notEqual(r.status, 200, t("T74-e: 대조 기준이 없는데 가입이 시작됐다"));
    assert.equal(turnstile.calls, 0, t("T74-e: 대조 기준도 없이 검증 서버를 불렀다"));
    turnstile.answer = good;
  }

  // ── T74-f. 화면과 서버가 **같은 action 문자열**을 쓴다. 다르면 정상 가입이 전부 막힌다.
  {
    const client = (await import("node:fs")).readFileSync(new URL("../js/auth.js", import.meta.url), "utf8");
    const m = client.match(/TURNSTILE_ACTION\s*=\s*"([^"]+)"/);
    assert.ok(m, t("T74-f: 화면 코드에 action 상수가 없다 — 위젯이 action 을 안 싣는다"));
    assert.equal(m[1], TURNSTILE_ACTION,
      t(`T74-f: 화면 action(${m && m[1]}) 과 서버 action(${TURNSTILE_ACTION}) 이 다르다`));
    assert.ok(/action:\s*TURNSTILE_ACTION/.test(client),
      t("T74-f: 화면이 위젯에 action 을 안 넘긴다"));
    n += 3;
  }
}

// ══ M. T77 — **제공자별 부분 시크릿도 fail-closed** (2026-08-22 · 위협 61) ══
//
// ⛔ 재현(고치기 전 · 실제 라우트 호출): `NAVER_ID` 만 있고 `NAVER_SECRET` 이 없는 배포에서
//      /health          providers=[]  signupReady=false   ← 여기는 **맞게** 답했다
//      POST /signup/start   **200** · Turnstile 검증 **1회 호출** · 네이버 OAuth 주소 발급
//      GET  /login/naver    **302** — 제공자까지 보냈다
//    구글도 같았다. 즉 「쌍이 맞아야 제공자로 친다」는 규칙이 **화면에만** 있었고 실제 문에는
//    없었다. 사용자는 제공자 화면까지 갔다가 토큰 교환에서 실패하고, 우리는 그 왕복만큼
//    외부 호출과 리미터를 태운다.
//
// ⚠️ **소스를 훑는 검사로 대신하지 않는다.** 위 재현이 정확히 「코드에 규칙은 있는데 그 자리에서
//    안 부른다」였다 — 문자열 검색은 그 상태를 통과시킨다. 여기서는 전부 **진짜 라우트**를 부른다.
{
  const BASE = { KAKAO_ID: undefined, KAKAO_SECRET: undefined, NAVER_ID: undefined,
                 NAVER_SECRET: undefined, GOOGLE_ID: undefined, GOOGLE_SECRET: undefined };
  // [이름, 제공자, env, 열려야 하나]
  const CASES = [
    ["naver: ID 만",            "naver",  { NAVER_ID: "id" }, false],
    ["naver: SECRET 만",        "naver",  { NAVER_SECRET: "s" }, false],
    ["naver: 둘 다",            "naver",  { NAVER_ID: "id", NAVER_SECRET: "s" }, true],
    ["google: ID 만",           "google", { GOOGLE_ID: "id" }, false],
    ["google: SECRET 만",       "google", { GOOGLE_SECRET: "s" }, false],
    ["google: 둘 다",           "google", { GOOGLE_ID: "id", GOOGLE_SECRET: "s" }, true],
    // 카카오만 secret 이 선택이다(콘솔에서 끌 수 있다). **기존 정책을 그대로 유지한다.**
    ["kakao: ID 만(정책상 허용)", "kakao",  { KAKAO_ID: "id" }, true],
    ["kakao: SECRET 만",        "kakao",  { KAKAO_SECRET: "s" }, false],
    ["kakao: 둘 다",            "kakao",  { KAKAO_ID: "id", KAKAO_SECRET: "s" }, true],
  ];

  for (const [name, prov, creds, open] of CASES) {
    const env = makeEnv({ ...BASE, ...creds });

    // ── T77-a. `/health` 가 잘못 구성된 제공자를 목록에 넣지 않는다.
    const h = await (await worker.fetch(new Request("https://api.test/health"), env)).json();
    assert.equal(h.providers.includes(prov), open,
      t(`T77-a[${name}]: /health providers=${JSON.stringify(h.providers)}`));

    // ── T77-b. ★ `/signup/start` — **Turnstile 검증 앞에서** 끝난다.
    turnstile.calls = 0;
    const r = await startSignup(env, { provider: prov });
    if (open) {
      assert.equal(r.status, 200, t(`T77-b[${name}]: 정상 구성인데 가입 시작이 ${r.status} 다`));
      assert.ok(r.state, t(`T77-b[${name}]: 정상 구성인데 state 가 없다`));
    } else {
      assert.equal(r.status, 503, t(`T77-b[${name}]: 가입 시작이 ${r.status} 로 열렸다`));
      assert.equal(r.state, null, t(`T77-b[${name}]: 막았다면서 state 를 줬다`));
      assert.equal(turnstile.calls, 0,
        t(`T77-b[${name}]: 설정이 덜 됐는데 검증 서버를 ${turnstile.calls}번 불렀다`));
    }

    // ── T77-c. ★ `/login/:provider` — 302 로 제공자까지 보내지 않는다.
    const lg = await worker.fetch(new Request(`https://api.test/login/${prov}`,
      { headers: asBrowser() }), env);
    assert.equal(lg.status, open ? 302 : 503,
      t(`T77-c[${name}]: /login/${prov} 가 ${lg.status} 다`));

    // ── T77-d. ★ 막힌 경우 **어느 표에도 한 줄이 안 생긴다.**
    if (!open) {
      for (const tb of ["users", "sessions", "policy_events", "consumed_signup_states"])
        assert.equal(count(env, tb), 0, t(`T77-d[${name}]: ${tb} 에 행이 생겼다`));
    }
  }

  // ── T77-e. ★★ **콜백 시점에 secret 만 사라진 경우.** 시작을 막아도 옛 링크는 콜백으로
  //   직접 온다. 거기서 통과하면 `code` 를 태우고 교환에서 실패한다 — 되돌릴 수 없는 실패다.
  {
    const full = makeEnv({ ...BASE, NAVER_ID: "id", NAVER_SECRET: "s" });
    const good = await startSignup(full, { provider: "naver" });
    assert.ok(good.state, t("T77-e: 준비용 정상 가입 시작이 실패했다"));
    const crippled = { ...full, NAVER_SECRET: undefined };
    const res = await withProvider("naver-partial", () => cb(crippled, good.state, good.txn, "c1", "naver"));
    assert.ok(!String(res.headers.get("Location") || "").includes("#login=ok"),
      t("T77-e: secret 이 사라졌는데 콜백이 성공했다"));
    assert.equal(providerCalls, 0, t(`T77-e: 거부가 제공자 호출 ${providerCalls}회 뒤에 일어났다`));
    assert.equal(count(full, "users"), 0, t("T77-e: 계정이 만들어졌다"));
    assert.equal(count(full, "sessions"), 0, t("T77-e: 세션이 만들어졌다"));
    assert.equal(count(full, "consumed_signup_states"), 0, t("T77-e: 소비 표식이 남았다"));
  }

  // ── T77-f. ★ 반대쪽 — 온전한 구성에서는 **끝까지 간다.** 「늘 거부」로 고치면 여기서 걸린다.
  {
    const full = makeEnv({ ...BASE, NAVER_ID: "id", NAVER_SECRET: "s" });
    const good = await startSignup(full, { provider: "naver" });
    const res = await withProvider("naver-ok", () => cb(full, good.state, good.txn, "c2", "naver"));
    assert.equal(count(full, "users"), 1,
      t(`T77-f: 정상 구성인데 계정이 안 생겼다 (status ${res.status})`));
  }

  // ── T77-g. 모르는 제공자 이름은 어느 자리에서도 참이 아니다.
  {
    const env = makeEnv();
    for (const bad of ["__proto__", "constructor", "toString", "", "kakao2"])
      assert.equal(providerPossible(env, bad), false,
        t(`T77-g: providerPossible(${JSON.stringify(bad)}) 가 참이다`));
    // 그리고 실제 라우트에서도 404(표에 없는 경로)다.
    const r = await worker.fetch(new Request("https://api.test/login/__proto__",
      { headers: asBrowser() }), env);
    assert.equal(r.status, 404, t(`T77-g: /login/__proto__ 가 ${r.status} 다`));
  }
}

console.log(`test-signup: ${n}개 통과 — 가입 state AEAD(nonce·AAD·키 길이·키 분리) · `
  + `필수 항목 fail-closed · 정책 기록 ${REQUIRED_POLICY_EVENTS}종 원자성 · CHECK 강제 · `
  + `소비 표식(순차·동시·재소비) · 로그인 경로가 계정을 안 만듦 · 만료 정리 · 로그 0건 · `
  + `T70 Turnstile(토큰 없음·위조·재사용·만료·검증 실패·시크릿 부재·콜백 대조·범위) · `
  + `T73 부분 시크릿(화면·시작·콜백·로그인에서 행 0건) · T74 action·hostname 대조 · `
  + `T77 제공자별 시크릿 쌍(9경우 · 카카오 선택 정책 유지 · 외부 호출 0)`);
