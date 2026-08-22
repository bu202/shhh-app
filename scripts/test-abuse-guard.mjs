// 2026-08-22 남용 방어 재감사에서 **독립적으로 재현된 결함 5건**. `node scripts/test-abuse-guard.mjs`
//
// 왜 또 파일을 따로 두나: 이 다섯은 **스위트 24개가 전부 통과하는 상태에서** 재현됐다(그 앞의
// 아홉이 그랬듯이). 8판은 「남용 방어가 **없을 때** 닫힌다」를 확인하고 그것을 위협 50 의 완료
// 근거로 썼는데, **「있다」고 판정되는 조건**은 아무도 재지 않았다 — 문자열도, 빈 객체도,
// 던지는 `limit()` 도 전부 `abuseReady:true` 였다. 번호는 T65~T69 이고 위협 52~56 과 짝이다.
//
// ⚠️ **다섯 다 프로덕션 코드를 고치기 전에 먼저 빨갛게 만들었다.** 각 블록 머리말의
//    「고치기 전」이 그때 실제로 나온 값이다.
//
// ⛔ **공개 디버그 라우트를 만들지 않는다.** 재현을 위해 프로덕션에 뚫은 구멍이 곧 다음 위협이다.
//    측정은 셰임(`scripts/_d1.mjs`)의 `prepare` 를 감싸서만 한다.
import assert from "node:assert";
import worker, { rlMax, routeBuckets, routeCount, guardMode } from "../worker/index.js";
import { makeD1, makeLedger } from "./_d1.mjs";

const ORIGIN = "https://app.test";
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 7)).toString("base64url");
let n = 0;
const t = (m) => { n++; return m; };

// 엣지 리미터 mock. **한도는 설정에 사는 값이라 인자로 못 바꾼다**(공식 문서) — 그래서 mock 도
// 생성할 때 한도를 받는다. 이것이 위협 53 의 핵심이다.
const edgeRL = (limit = 1e9) => {
  const seen = new Map();
  return { calls: 0,
    limit(o) { this.calls++; const k = String(o && o.key); const c = (seen.get(k) || 0) + 1;
               seen.set(k, c); return Promise.resolve({ success: c <= limit }); } };
};
const makeEnv = (extra = {}) => ({
  APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "k", RL_KEY: "r",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tk", DELETION_KEY: "dk", READY_KEY: "operator-key",
  KAKAO_ID: "kid", DB: makeD1(), LEDGER: makeLedger(), ...extra,
});
const base = (env) => env.APP_ORIGIN || ORIGIN;
const call = (env, path, { method = "GET", ip = "1.2.3.4", host, headers = {} } = {}) =>
  worker.fetch(new Request((host ? "https://" + host : base(env)) + path, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json",
                       "CF-Connecting-IP": ip, ...headers },
  }), env);
const changes = (db) => db._db.prepare("SELECT total_changes() AS n").get().n;
// 이 시점 이후 그 DB 에 던져진 SQL 을 전부 기록한다(읽기 포함).
function spy(db) {
  const saved = db.prepare;
  const seen = [];
  db.prepare = (sql) => { seen.push(sql); return saved.call(db, sql); };
  return { seen, stop: () => { db.prepare = saved; } };
}
// 두 저장소의 질의·쓰기를 한꺼번에 잰다.
async function measure(env, fn) {
  const sd = spy(env.DB), sl = spy(env.LEDGER);
  const w0 = { db: changes(env.DB), l: changes(env.LEDGER) };
  const out = await fn();
  sd.stop(); sl.stop();
  return { out, dbQ: sd.seen.length, lQ: sl.seen.length,
           dbW: changes(env.DB) - w0.db, lW: changes(env.LEDGER) - w0.l };
}
// 버킷 하나를 실제로 두드릴 수 있는 대표 라우트. **`routeBuckets()` 와 대조**해서 쓴다 —
// 새 버킷이 표에 생기고 여기 없으면 그 버킷만 측정 밖에 남는다.
const BUCKET_ROUTE = {
  login: ["/api/cb/kakao", "GET"],
  signup: ["/api/signup/start", "POST"],
  friends: ["/api/friends", "POST"],
  rotate: ["/api/friends/code", "POST"],
  read: ["/api/book", "GET"],
  write: ["/api/book", "PUT"],
};
// 응답에 새면 안 되는 것들. 인증 없이 열린 자리이거나 운영 정보다.
const LEAKS = ["EDGE_GUARD", "RL_KEY", "READY_KEY", "RL", "ratelimit", "binding", "limit",
               "rate_limits", "maintenance", "SELECT", "TypeError", "boom", "undefined"];
const noLeak = (body, where) => {
  for (const s of LEAKS) assert.ok(!body.includes(s), t(`${where}: 응답에 "${s}" 가 새어 나왔다`));
};

// ══ T65. 가짜·고장 난 방어가 readiness 와 계정 경로를 통과한다 ═══════════
//
// 고치기 전(2026-08-22 실측 · HEAD 3a12dd9): `abuseGuard()` 가 `env.RL` 의 **truthy 여부만**
// 봤다. 문자열 · 빈 객체 · 던지는 `limit()` · reject 하는 `limit()` 넷 다
//   /ready 200 · abuseReady:true · 익명 GET /book 이 진행 · **ledger 쓰기 2건**
// 이었고, 반환값이 이상한 다섯째(`{nope:1}`)는 반대로 **전부 429** 가 되어 고장이 곧 서비스
// 거부였다 — 그때도 /ready 는 200 이었다.
{
  const FAKES = [
    ["문자열", "configured-but-not-a-binding"],
    ["빈 객체", {}],
    ["limit 이 없음", { nope: 1 }],
    ["limit 이 함수가 아님", { limit: "yes" }],
    ["동기 예외", { limit: () => { throw new Error("boom"); } }],
    ["reject", { limit: async () => { throw new Error("boom"); } }],
    ["success 가 boolean 이 아님", { limit: async () => ({ success: "yes" }) }],
  ];
  for (const [name, RL] of FAKES) {
    const env = makeEnv({ EDGE_GUARD: "ratelimit", RL });

    // ── a. 계정 경로는 **두 DB 를 만지기 전에** 닫힌다.
    const m = await measure(env, () => call(env, "/api/book"));
    assert.equal(m.out.status, 503, t(`T65-a[${name}]: 계정 경로가 안 닫혔다`));
    assert.equal(m.dbQ, 0, t(`T65-a[${name}]: 닫혔다면서 주 D1 에 질의 ${m.dbQ}건`));
    assert.equal(m.lQ, 0, t(`T65-a[${name}]: 닫혔다면서 ledger 에 질의 ${m.lQ}건`));
    assert.equal(m.dbW + m.lW, 0, t(`T65-a[${name}]: 닫혔다면서 쓰기 ${m.dbW + m.lW}건`));
    noLeak(await m.out.text(), `T65-a[${name}]`);

    // ── b. 인증 없는 `/ready` 는 **DB 를 안 만지고** 503 이다(위협 56 과 같은 자리).
    const pub = await measure(env, () => call(env, "/api/ready"));
    assert.equal(pub.out.status, 503, t(`T65-b[${name}]: 공개 /ready 가 200 이다`));
    assert.equal(pub.dbQ + pub.lQ, 0, t(`T65-b[${name}]: 공개 /ready 가 DB 를 만졌다`));

    // ── c. 운영자 키로 물어보면 **abuseReady 가 거짓**이고 ready 가 아니다.
    const rd = await call(env, "/api/ready", { headers: { "X-Ready-Key": "operator-key" } });
    const body = await rd.text();
    const j = JSON.parse(body);
    assert.equal(j.abuseReady, false, t(`T65-c[${name}]: abuseReady 가 참이다 — 부를 수 없는 바인딩이다`));
    assert.equal(j.ready, false, t(`T65-c[${name}]: ready 가 참이다`));
    assert.equal(rd.status, 503, t(`T65-c[${name}]: /ready 가 200 이다`));
    noLeak(body, `T65-c[${name}]`);

    // ── d. `/health` 도 버튼을 그리라고 말하지 않는다.
    const h = await (await call(env, "/api/health")).json();
    assert.deepEqual(h.providers, [], t(`T65-d[${name}]: 눌러도 503 인 버튼을 그리라고 한다`));
    assert.equal(h.abuseReady, false, t(`T65-d[${name}]: /health 의 abuseReady 가 참이다`));
  }

  // ── e. ★ **정상 바인딩은 열린다.** 막는 쪽만 재면 「늘 거부」로 고쳐도 통과한다.
  {
    const env = makeEnv({ EDGE_GUARD: "ratelimit", RL: edgeRL() });
    const r = await call(env, "/api/book");
    assert.equal(r.status, 401, t("T65-e: 정상 바인딩인데 계정 경로가 안 열렸다"));
    const j = await (await call(env, "/api/ready", { headers: { "X-Ready-Key": "operator-key" } })).json();
    assert.equal(j.abuseReady, true, t("T65-e: 정상 바인딩인데 abuseReady 가 거짓이다"));
  }
}

// ══ T66. 문서의 버킷별 한도를 **누가** 집행하나 ═══════════════════════════
//
// 고치기 전: 엣지 바인딩이 있으면 우리 카운터를 **통째로 건너뛰었고**, 엣지에는 버킷별 한도를
// 전달할 방법이 없다(`limit()` 인자는 `key` 뿐 · 한도는 설정에 고정). 실측: 한도 100 짜리
// 바인딩에서 `rotate`(문서상 **5/분**)가 **20회 연속 통과**했다.
{
  // ── a. 표의 버킷이 전부 한도를 갖고, 대표 라우트가 전부 있다.
  const buckets = routeBuckets();
  assert.deepEqual([...buckets].sort(), Object.keys(BUCKET_ROUTE).sort(),
    t("T66-a: ROUTES 의 버킷과 측정 대상 목록이 다르다 — 새 버킷이 측정 밖에 있다"));
  for (const b of buckets) assert.equal(typeof rlMax(b), "number", t(`T66-a: ${b} 한도가 없다`));
  assert.ok(routeCount() >= buckets.length, t("T66-a: 라우트 표가 비었다 — 검사기가 낡았다"));

  // ── b. ★ **엣지가 전부 허용해도 우리 카운터가 막는다.** 가짜 mock 으로는 통과 못 한다.
  for (const b of buckets) {
    const [path, method] = BUCKET_ROUTE[b];
    const max = rlMax(b);
    const rl = edgeRL();                                  // 언제나 success:true
    const env = makeEnv({ EDGE_GUARD: "ratelimit", RL: rl });
    const codes = [];
    for (let i = 0; i < max + 1; i++)
      codes.push((await call(env, path, { method, ip: "7.7.7.7" })).status);
    const first = codes.slice(0, max), last = codes[max];
    assert.ok(!first.includes(429), t(`T66-b[${b}]: 한도(${max}) 안인데 ${first.indexOf(429) + 1}번째가 429`));
    assert.equal(last, 429, t(`T66-b[${b}]: 한도+1(${max + 1})인데 ${last} — 엣지 mock 이 전부 허용했고 우리 카운터는 안 셌다`));
    assert.ok(rl.calls > 0, t(`T66-b[${b}]: 엣지 바인딩을 한 번도 안 불렀다`));
  }

  // ── c. **한 요청이 두 버킷에 세어지지 않는다.** 카운터 행 수로 잰다.
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    await call(env, "/api/friends", { method: "POST" });
    const rows = env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n;
    assert.equal(rows, 1, t(`T66-c: 요청 하나가 카운터 행 ${rows}개를 만들었다 — 이중 집계다`));
  }

  // ── d. 엣지 한도가 우리 한도보다 좁으면 **문서의 숫자가 거짓**이 된다.
  //    설정 쪽 계약은 `scripts/test-config.mjs` 가 보고, 여기서는 그 상황의 동작을 고정한다.
  {
    const env = makeEnv({ EDGE_GUARD: "ratelimit", RL: edgeRL(2) });   // 엣지가 2/창
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call(env, "/api/book", { ip: "8.8.8.8" })).status);
    assert.equal(codes[2], 429, t("T66-d: 엣지 사전 거름이 막지 않았다"));
    const l = env.LEDGER._db.prepare("SELECT COUNT(*) n FROM write_leases").get().n;
    assert.equal(l, 0, t("T66-d: 엣지가 막은 요청이 임차증을 땄다 — 사전 거름이 뒤에 있다"));
  }
}

// ══ T67. 여러 IP 의 최초 요청 — 문서가 약속한 범위와 대조 ═════════════════
//
// 고치기 전: IP 100개 × 익명 `GET /book` 1회 → 429 **0건** · 401 100건 · ledger 쓰기 **200건**.
// 이 블록은 **막았다고 주장하는 칸이 0 인지**와 **못 막는다고 적은 칸이 실제로 늘어나는지**를
// 함께 잰다. 뒤쪽이 없으면 문서가 과장인지 거짓인지 구분되지 않는다(§12-3-3).
{
  const ip = (i) => `10.0.${(i / 256) | 0}.${i % 256}`;

  // ── a. 방어가 선언되지 않은 상태(지금 이 저장소): 분산이든 아니든 **비용 0**.
  {
    const env = makeEnv();
    const m = await measure(env, async () => {
      const c = { 503: 0, other: 0 };
      for (let i = 0; i < 100; i++) {
        const r = await call(env, "/api/book", { ip: ip(i) });
        r.status === 503 ? c[503]++ : c.other++;
      }
      return c;
    });
    assert.equal(m.out[503], 100, t("T67-a: 방어 없는데 열린 요청이 있다"));
    assert.equal(m.dbQ + m.lQ + m.dbW + m.lW, 0, t("T67-a: 닫힌 상태에서 DB 를 만졌다"));
  }

  // ── b. 열린 상태 · 같은 IP 반복: **한도에서 멈춘다**(§12-3-3 「막는다」 칸).
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    let blocked = 0;
    for (let i = 0; i < rlMax("read") + 20; i++)
      if ((await call(env, "/api/book", { ip: "9.9.9.9" })).status === 429) blocked++;
    assert.equal(blocked, 20, t(`T67-b: 한도를 넘긴 20건 중 ${blocked}건만 막혔다`));
  }

  // ── c. 열린 상태 · IP 100개 × 1회: **막지 못한다.** 문서와 같은 수가 나와야 한다.
  //    요청당 ledger 쓰기 = 카운터 1 + 임차증 2 = **3**.
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    const m = await measure(env, async () => {
      const c = { 429: 0, 401: 0, other: 0 };
      for (let i = 0; i < 100; i++) {
        const r = await call(env, "/api/book", { ip: ip(i) });
        c[r.status] === undefined ? c.other++ : c[r.status]++;
      }
      return c;
    });
    assert.equal(m.out[429], 0, t("T67-c: 분산 요청이 막혔다 — 문서가 「못 막는다」고 적었다"));
    assert.equal(m.out[401], 100, t("T67-c: 401 이 100건이 아니다"));
    assert.equal(m.lW, 300, t(`T67-c: 요청 100건에 ledger 쓰기 ${m.lW}건 — 문서는 요청당 3건이라 적었다`));
    assert.equal(m.dbW, 0, t(`T67-c: 인증도 안 된 요청이 주 D1 에 ${m.dbW}건을 썼다`));
  }

  // ── d. IP 100개 × 2회: 같은 비율로 는다(= 상한이 없다).
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    const m = await measure(env, async () => {
      for (let round = 0; round < 2; round++)
        for (let i = 0; i < 100; i++) await call(env, "/api/book", { ip: ip(i) });
    });
    assert.equal(m.lW, 500, t(`T67-d: 200 요청에 ledger 쓰기 ${m.lW}건 — 카운터는 IP 당 한 번만 INSERT 다(100 + 200×2)`));
  }

  // ── e. 버킷 여섯 전부 같은 성질이다 — 하나라도 빠지면 그 경로가 측정 밖이다.
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    for (const b of routeBuckets()) {
      const [path, method] = BUCKET_ROUTE[b];
      const m = await measure(env, async () => {
        for (let i = 0; i < 5; i++) await call(env, path, { method, ip: ip(500 + i) });
      });
      assert.ok(m.lW > 0, t(`T67-e[${b}]: 분산 요청이 ledger 를 하나도 안 썼다 — 측정이 라우트를 못 탄다`));
      assert.ok(m.lW <= 5 * 3, t(`T67-e[${b}]: 요청 5건에 ledger 쓰기 ${m.lW}건 — 요청당 3건을 넘는다`));
    }
  }
}

// ══ T68. 고른 모드가 코드에서 실제로 문을 여나 ════════════════════════════
//
// 고치기 전: 코드가 아는 것은 `env.RL` 하나뿐이라 **A(WAF)·C(Turnstile)를 실제로 구성해도**
// 계정 경로는 503 이었다. 실측: `TURNSTILE_SECRET`·`WAF` 가 설정된 env 에서 guard=none.
{
  const CUSTOM = "https://shhh.example.com";

  // ── a. waf: 커스텀 도메인이면 열린다.
  {
    const env = makeEnv({ EDGE_GUARD: "waf", APP_ORIGIN: CUSTOM, APP_URL: CUSTOM + "/" });
    assert.equal(guardMode(env), "waf", t("T68-a: WAF 를 선언했는데 모드가 waf 가 아니다"));
    const r = await call(env, "/api/book", { headers: { Origin: CUSTOM } });
    assert.equal(r.status, 401, t(`T68-a: WAF 모드인데 계정 경로가 ${r.status} 다 — 골라도 문이 안 열린다`));
    const j = await (await call(env, "/api/ready", { headers: { "X-Ready-Key": "operator-key" } })).json();
    assert.equal(j.abuseReady, true, t("T68-a: WAF 모드인데 abuseReady 가 거짓이다"));
  }

  // ── b. waf: `*.pages.dev` 로 온 계정 API 는 **403**. WAF 규칙을 지나지 않는 경로다.
  {
    const env = makeEnv({ EDGE_GUARD: "waf", APP_ORIGIN: CUSTOM, APP_URL: CUSTOM + "/" });
    const m = await measure(env, () => call(env, "/api/book",
      { host: "shhh-app.pages.dev", headers: { Origin: CUSTOM } }));
    assert.equal(m.out.status, 403, t(`T68-b: pages.dev 우회가 ${m.out.status} 로 통과했다`));
    assert.equal(m.dbQ + m.lQ, 0, t("T68-b: 막으면서 DB 를 만졌다"));
    noLeak(await m.out.text(), "T68-b");
  }

  // ── c. waf 인데 `APP_ORIGIN` 이 아직 `*.pages.dev` 면 **선언해도 none** 이다.
  {
    const env = makeEnv({ EDGE_GUARD: "waf", APP_ORIGIN: "https://shhh-app.pages.dev",
                          APP_URL: "https://shhh-app.pages.dev/" });
    assert.equal(guardMode(env), "none", t("T68-c: pages.dev 에 WAF 를 걸 수 있다고 판정했다"));
    const r = await call(env, "/api/book", { headers: { Origin: "https://shhh-app.pages.dev" } });
    assert.equal(r.status, 503, t("T68-c: WAF 를 걸 수 없는 조합인데 계정 경로가 열렸다"));
  }

  // ── d. Turnstile 만으로는 열리지 않는다(보조이지 모드가 아니다).
  for (const env of [makeEnv({ TURNSTILE_SECRET: "x" }), makeEnv({ EDGE_GUARD: "turnstile" })]) {
    assert.equal(guardMode(env), "none", t("T68-d: Turnstile 단독이 모드로 인정됐다"));
    assert.equal((await call(env, "/api/book")).status, 503, t("T68-d: Turnstile 단독인데 계정 경로가 열렸다"));
  }

  // ── e. 모르는 선언은 `none` 이다(기본값이 안전한 쪽).
  for (const v of ["WAF", "true", "1", "edge", "ratelimits"]) {
    assert.equal(guardMode(makeEnv({ EDGE_GUARD: v })), "none", t(`T68-e: 모르는 선언 "${v}" 가 모드로 인정됐다`));
  }

  // ── f. `dev` 는 라우트를 열지만 **ready 는 절대 참이 아니다**(8판에서 정한 그대로).
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    assert.equal(guardMode(env), "dev", t("T68-f: DEV_RATE_LIMIT 가 dev 모드가 아니다"));
    const j = await (await call(env, "/api/ready", { headers: { "X-Ready-Key": "operator-key" } })).json();
    assert.equal(j.abuseReady, false, t("T68-f: dev 인데 abuseReady 가 참이다 — 배포해도 된다고 읽힌다"));
  }
}

// ══ T69. 공개 readiness 남용 ══════════════════════════════════════════════
//
// 고치기 전: `/ready` 는 인증 없이 열려 있고 한 번 부를 때마다 주 D1 **1 질의**(7개 표 COUNT)와
// ledger **5 질의**를 냈다. 실측 10회 → 10 · 50. 요청 수에 상한이 없으니 비용에도 없다.
{
  // ── a. 키 없이 반복해도 **두 DB 를 안 만진다.**
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    const m = await measure(env, async () => {
      const out = [];
      for (let i = 0; i < 20; i++) out.push(await call(env, "/api/ready", { ip: "3.3.3.3" }));
      return out;
    });
    assert.equal(m.dbQ, 0, t(`T69-a: 키 없는 /ready 20회가 주 D1 에 질의 ${m.dbQ}건`));
    assert.equal(m.lQ, 0, t(`T69-a: 키 없는 /ready 20회가 ledger 에 질의 ${m.lQ}건`));
    assert.equal(m.dbW + m.lW, 0, t("T69-a: 키 없는 /ready 가 쓰기를 냈다"));
    for (const r of m.out) assert.equal(r.status, 503, t("T69-a: 키 없는 /ready 가 200 이다"));
    const body = await m.out[0].text();
    const j = JSON.parse(body);
    assert.equal(j.diagnostics, false, t("T69-a: 진단을 안 했는데 그 사실을 말하지 않는다"));
    for (const k of ["configReady", "db", "ledger", "signupReady", "providers", "cleanupAlert", "mode"])
      assert.equal(j[k], undefined, t(`T69-a: 인증 없는 응답이 ${k} 를 말한다`));
    noLeak(body, "T69-a");
  }

  // ── b. 틀린 키도 같다(비교에 DB 가 끼지 않는다).
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    const m = await measure(env, () => call(env, "/api/ready", { headers: { "X-Ready-Key": "wrong" } }));
    assert.equal(m.out.status, 503, t("T69-b: 틀린 키가 200 을 받았다"));
    assert.equal(m.dbQ + m.lQ, 0, t("T69-b: 틀린 키로도 DB 를 만졌다"));
  }

  // ── c. ★ 맞는 키는 **실제로 진단한다**(「늘 503」으로 고치면 여기서 잡힌다).
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    const m = await measure(env, () => call(env, "/api/ready", { headers: { "X-Ready-Key": "operator-key" } }));
    assert.ok(m.dbQ > 0 && m.lQ > 0, t("T69-c: 운영자 키인데 아무것도 안 물어봤다"));
    const j = JSON.parse(await m.out.text());
    assert.equal(j.diagnostics, true, t("T69-c: 진단했는데 그 사실을 말하지 않는다"));
    assert.equal(j.db, true, t("T69-c: 주 D1 이 답하지 않았다"));
    assert.equal(j.ledger, true, t("T69-c: ledger 가 답하지 않았다"));
  }

  // ── d. `READY_KEY` 가 없는 배포에서는 **진단이 불가**다(전부 공개로 안 돌아간다).
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1", READY_KEY: undefined });
    const m = await measure(env, () => call(env, "/api/ready", { headers: { "X-Ready-Key": "" } }));
    assert.equal(m.out.status, 503, t("T69-d: READY_KEY 가 없는데 200 이다"));
    assert.equal(m.dbQ + m.lQ, 0, t("T69-d: READY_KEY 가 없는데 DB 를 만졌다"));
  }

  // ── e. `/health` 는 여전히 DB 를 안 만진다.
  {
    const env = makeEnv({ DEV_RATE_LIMIT: "1" });
    const m = await measure(env, () => call(env, "/api/health"));
    assert.equal(m.out.status, 200, t("T69-e: /health 가 200 이 아니다"));
    assert.equal(m.dbQ + m.lQ, 0, t("T69-e: /health 가 DB 를 만졌다"));
  }
}

console.log(`test-abuse-guard: ${n}개 통과 — T65 가짜·고장 난 바인딩 fail-closed · `
  + `T66 버킷별 한도의 집행자 · T67 다중 IP 실측과 문서 대조 · T68 모드별 활성화 경로 · `
  + `T69 공개 readiness 남용`);
