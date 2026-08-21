// 회원가입 · 가입 state · 정책 기록. `node scripts/test-signup.mjs`
//
// worker/index.js 를 **그대로 불러** 진짜 sqlite(D1 셰임) 위에서 돌린다.
// 여기가 틀리면 증상이 「약관을 본 적 없는 사람의 수락 기록이 남는다」라서 사람 눈에 안 보인다.
//
// 설계서 §13-5 의 T18~T21 · T23~T35 · T48 을 구현한다(T22 는 test-policies.mjs).
import assert from "node:assert";
import worker, {
  createAccountWithPolicy, findUser, newSession, requiredPolicyKinds, REQUIRED_POLICY_EVENTS,
  makeSignupState, takeSignupState, stateTombstone,
} from "../worker/index.js";
import { POLICY_BUNDLE } from "../worker/policies.js";
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
  globalThis.fetch = async (url) => {
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

// 가입 시작 → { url, state, txn }. **진짜 라우트를 지난다** — 규칙을 테스트에 베끼지 않는다.
async function startSignup(env, body = {}, headers = {}) {
  const res = await worker.fetch(new Request(ORIGIN + "/api/signup/start", {
    method: "POST",
    headers: asBrowser({ Origin: ORIGIN, "Content-Type": "application/json", ...headers }),
    body: JSON.stringify({ provider: "kakao", terms: true, age14: true, pv: POLICY_BUNDLE.pv, ...body }),
  }), env);
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

console.log(`test-signup: ${n}개 통과 — 가입 state AEAD(nonce·AAD·키 길이·키 분리) · `
  + `필수 항목 fail-closed · 정책 기록 ${REQUIRED_POLICY_EVENTS}종 원자성 · CHECK 강제 · `
  + `소비 표식(순차·동시·재소비) · 로그인 경로가 계정을 안 만듦 · 만료 정리 · 로그 0건`);
