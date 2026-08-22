// 2026-08-20 3·4단계 마감 감사에서 **독립적으로 재현된 결함 4건**. `node scripts/test-stage34-closeout.mjs`
//
// 왜 또 파일을 따로 두나: 이 넷은 23개 스위트가 **전부 통과하는 상태에서** 재현됐다(그 앞의
// 다섯이 그랬듯이). 같은 파일에 끼워 넣으면 "그 스위트가 통과한다"가 다시 완료의 근거로
// 쓰인다 — 무엇이 놓쳤던 것인지 이름으로 남겨 둔다. 번호는 T61~T64 이고 설계서의 위협 48~51 과 짝이다.
//
// ⚠️ **네 개 다 프로덕션 코드를 고치기 전에 먼저 빨갛게 만들었다.** 각 블록 머리말의
//    「고치기 전」이 그때 실제로 나온 값이다.
//
// 여기서 쓰는 도구는 하나다 — `pauseOn()` 은 특정 SQL 이 **실행되기 직전**에 그 호출을 세운다.
// 공개 디버그 라우트를 만들지 않는다: 재현을 위해 프로덕션 코드에 구멍을 뚫으면 그 구멍이
// 곧 다음 위협이다. 테스트는 셰임(`scripts/_d1.mjs`)의 `prepare` 만 감싼다.
import assert from "node:assert";
import worker, { createAccountWithPolicy, newSession } from "../worker/index.js";
import {
  deletionMark, acquireLease, releaseLease, markPending, drainState, activeLeases,
} from "../worker/ledger.js";
import { setMode, removeStalePending } from "../worker/ops.js";
import { makeD1, makeLedger } from "./_d1.mjs";

const ORIGIN = "https://app.test";
let n = 0;
const t = (m) => { n++; return m; };
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 3)).toString("base64url");

// ⚠️ `DEV_RATE_LIMIT` 은 **로컬 전용 스위치**다. 배포 가능한 설정에 들어가면 안 된다
//    (`scripts/test-config.mjs` 가 그것을 강제한다). 없으면 계정 라우트가 DB 를 만지기 전에
//    503 이다 — T63 이 그 상태를 따로 잰다.
const makeEnv = (extra = {}) => ({
  APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "k", RL_KEY: "r",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tk", DELETION_KEY: "dk", SESSION_ENVELOPE_KEY: "env-key",
  // `/ready` 진단은 운영자 키를 요구한다(2026-08-22 · 위협 56).
  READY_KEY: "closeout-ops-key",
  DEV_RATE_LIMIT: "1", DB: makeD1(), LEDGER: makeLedger(), ...extra,
});
let seq = 0;
const mkUser = async (env, sub = "u" + ++seq) => {
  const uid = await createAccountWithPolicy(env, "kakao", sub,
    { stateHash: "s-" + sub + Math.random(), stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  return { uid, token: await newSession(env, uid) };
};
const call = (env, token, path, method = "GET", extra = {}) =>
  worker.fetch(new Request("https://api.test" + path, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json",
                       ...(token ? { Cookie: "shh_s=" + token } : {}), ...extra },
  }), env);
const rows = (db, table, where = "") =>
  db._db.prepare(`SELECT COUNT(*) n FROM ${table} ${where}`).get().n;
const changes = (db) => db._db.prepare("SELECT total_changes() AS n").get().n;
const gate = (env) => env.LEDGER._db.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").get();

// ── 한 문장을 실행 직전에 세운다 ─────────────────────────────────────────
// 정규식에 처음 걸리는 `prepare()` **하나만** 잡고 곧바로 원상복구한다 — 뒤따르는 질의까지
// 물면 재려던 창이 아니라 셰임의 잠금을 재게 된다.
function pauseOn(dbs, re) {
  const list = Array.isArray(dbs) ? dbs : [dbs];
  const saved = list.map((d) => d.prepare);
  let reached, go;
  const hit = new Promise((r) => { reached = r; });
  const gate_ = new Promise((r) => { go = r; });
  let armed = true;
  const restore = () => list.forEach((d, i) => { d.prepare = saved[i]; });
  list.forEach((d, i) => {
    d.prepare = (sql) => {
      const st = saved[i].call(d, sql);
      if (armed && re.test(sql)) {
        armed = false;
        restore();
        for (const m of ["run", "first", "all"]) {
          const f = st[m].bind(st);
          st[m] = async (...a) => { reached(sql); await gate_; return f(...a); };
        }
      }
      return st;
    };
  });
  return { hit, release: () => go(), cancel: restore };
}
// 이 시점 이후 그 DB 에 던져진 SQL 을 전부 기록한다(읽기도 포함).
function spy(db) {
  const saved = db.prepare;
  const seen = [];
  db.prepare = (sql) => { seen.push(sql); return saved.call(db, sql); };
  return { seen, stop: () => { db.prepare = saved; } };
}

// ══ T61. stale pending 수동 제거의 경합 — 「표식 없는 삭제」 ═══════════════
//
// 고치기 전: `removeStalePending()` 은 **시작할 때** 모드·임차증·키·계정 존재를 확인하고,
// 실제 `DELETE FROM deletions` 는 **아무것도 다시 확인하지 않았다.** 그래서 확인과 삭제
// 사이에 진짜 `DELETE /me` 가 끼어들면 이런 순서가 난다:
//   ① 운영자: 계정이 살아 있다 → 이 표식은 「지워도 되는 찌꺼기」다
//   ② 사용자: 계정 삭제 → 주 D1 의 users 행이 사라진다(표식은 아직 pending)
//   ③ 운영자: pending 표식을 지운다
//   ④ 사용자: 확정하려는데 지울 행이 없다 — 코드가 오류를 삼킨다
// 결과는 **`users` 0행 · `deletions` 0행** — 지워졌는데 지운 증거가 없다. 그 계정은
// 복원 뒤 재삭제 대상 목록에 **영원히 안 나온다**(위협 48).
// 기존 T39 는 두 작업을 **차례로만** 돌려서 이 창을 재지 못했다.
{
  // 되살릴 상태 하나 만들기: 계정 + 그 사람의 pending 표식(예전 삭제 시도가 남긴 모양).
  const seed = async () => {
    const env = makeEnv();
    const A = await mkUser(env, "stale" + ++seq);
    const lease = await acquireLease(env);
    const mark = await deletionMark(env, A.uid);
    await markPending(env, lease, mark);
    await releaseLease(env, lease);
    await setMode(env, "maintenance");
    return { env, A, mark };
  };

  // ── T61-a. ★ 정상 경로는 그대로 지운다. 막는 쪽만 재면 「늘 거부」로 고쳐도 통과한다.
  {
    const { env, mark } = await seed();
    const r = await removeStalePending(env, [mark], { confirmedByOperator: true });
    assert.equal(r.ok, true, t("T61-a: 정상 상태인데 stale 제거가 거부됐다"));
    assert.equal(r.removed, 1, t("T61-a: 정상 상태인데 stale 표식을 안 지웠다"));
    assert.equal(rows(env.LEDGER, "deletions"), 0, t("T61-a: 지웠다는데 표식이 남아 있다"));
  }

  // ── T61-b. ★ **핵심 불변식**: 계정이 사라졌으면 표식이 하나는 남는다.
  //   `users = 0 && deletions = 0` 은 어떤 순서로도 나올 수 없다.
  {
    const { env, A, mark } = await seed();
    const p = pauseOn(env.LEDGER, /DELETE FROM deletions/);
    const removing = removeStalePending(env, [mark], { confirmedByOperator: true });
    await p.hit;                                  // ① 계정 존재까지 다 읽고 삭제 직전

    await setMode(env, "open");                   // 그 사이 유지보수가 풀렸다
    const q = pauseOn(env.LEDGER, /UPDATE deletions SET confirmed_at/);
    const deleting = call(env, A.token, "/me", "DELETE");
    await q.hit;                                  // ② 주 D1 의 users 는 이미 지워졌다
    assert.equal(rows(env.DB, "users"), 0, t("T61-b: 준비가 틀렸다 — 계정이 아직 있다"));

    p.release();                                  // ③ 운영자의 제거가 이어서 돈다
    const rm = await removing;
    q.release();                                  // ④ 사용자의 확정이 이어서 돈다
    const res = await deleting;

    assert.equal(res.status, 200, t("T61-b: 계정 삭제가 실패했다 — 재현 상태가 아니다"));
    const left = rows(env.LEDGER, "deletions");
    assert.ok(!(rows(env.DB, "users") === 0 && left === 0),
      t("T61-b: 계정이 사라졌는데 삭제 표식이 0건이다 — 증거 없는 삭제가 만들어졌다"));
    assert.equal(rm.removed, 0,
      t(`T61-b: 삭제가 진행 중인데 운영자의 제거가 표식을 ${rm.removed}건 지웠다`));
  }

  // ── T61-c. ★ 모드만 바뀌어도 지우지 않는다(epoch 는 그대로 둔 채 재현한다).
  {
    const { env, mark } = await seed();
    const before = gate(env);
    const p = pauseOn(env.LEDGER, /DELETE FROM deletions/);
    const removing = removeStalePending(env, [mark], { confirmedByOperator: true });
    await p.hit;
    env.LEDGER._db.prepare("UPDATE maintenance SET mode = 'open' WHERE id = 1").run();
    p.release();
    const rm = await removing;
    assert.equal(gate(env).epoch, before.epoch, t("T61-c: 준비가 틀렸다 — epoch 가 움직였다"));
    assert.equal(rm.removed, 0, t("T61-c: 판정 뒤 모드가 open 으로 바뀌었는데 표식을 지웠다"));
    assert.equal(rows(env.LEDGER, "deletions"), 1, t("T61-c: 거부했다면서 표식이 사라졌다"));
  }

  // ── T61-d. ★ 모드가 같아도 **epoch 가 오르면** 지우지 않는다.
  //   같은 모드로의 재진입은 허용된 전환이라(R1-b) 모드 문자열만으로는 못 잡는다.
  {
    const { env, mark } = await seed();
    const p = pauseOn(env.LEDGER, /DELETE FROM deletions/);
    const removing = removeStalePending(env, [mark], { confirmedByOperator: true });
    await p.hit;
    await setMode(env, "maintenance");            // 모드는 같고 epoch 만 오른다
    p.release();
    const rm = await removing;
    assert.equal(gate(env).mode, "maintenance", t("T61-d: 준비가 틀렸다 — 모드가 바뀌었다"));
    assert.equal(rm.removed, 0, t("T61-d: 판정 뒤 epoch 가 올랐는데 표식을 지웠다"));
    assert.equal(rows(env.LEDGER, "deletions"), 1, t("T61-d: 거부했다면서 표식이 사라졌다"));
  }

  // ── T61-e. ★ 판정 뒤에 임차증이 하나 생겨도 지우지 않는다.
  //   모드도 epoch 도 그대로다 — 「지금 이 순간 아무 작업도 안 돌고 있다」만이 근거다.
  {
    const { env, mark } = await seed();
    const p = pauseOn(env.LEDGER, /DELETE FROM deletions/);
    const removing = removeStalePending(env, [mark], { confirmedByOperator: true });
    await p.hit;
    const lease = await acquireLease(env);        // 유지보수 중에도 읽기 요청은 임차증을 든다
    assert.ok(lease, t("T61-e: 준비가 틀렸다 — 임차증을 못 땄다"));
    assert.equal(await activeLeases(env), 1, t("T61-e: 준비가 틀렸다 — 활성 임차증이 1이 아니다"));
    p.release();
    const rm = await removing;
    assert.equal(rm.removed, 0, t("T61-e: 작업이 도는 중인데 표식을 지웠다"));
    assert.equal(rows(env.LEDGER, "deletions"), 1, t("T61-e: 거부했다면서 표식이 사라졌다"));
    await releaseLease(env, lease);
  }
}

// ══ T62. `drained:true` 라고 답한 뒤에 주 D1 에 쓴다 ══════════════════════
//
// 고치기 전 순서: 게이트 → **리미터(주 D1 `rate_limits` UPSERT)** → 임차증 → 인증.
// 리미터의 그 쓰기는 **어느 임차증에도 안 들어 있다.** UPSERT 직전에 멈춘 요청 하나를 두고
// `restore_closed` 로 전환하면 `drainState()` 가 **`drained:true`** 라고 답하고, 운영자가
// 그 답을 근거로 복원을 시작한 뒤에 그 요청이 깨어나 주 D1 에 쓴다(위협 49).
// 기존 R5-f 는 **이미 `restore_closed` 인 상태에서 시작한** 요청만 재서 이 창을 못 봤다.
{
  const env = makeEnv();
  const A = await mkUser(env, "t62");
  // 리미터 카운터가 어느 DB 에 있든 그 INSERT 직전에 선다.
  const p = pauseOn([env.DB, env.LEDGER], /INSERT INTO rate_limits/);
  const req = call(env, A.token, "/book");
  await p.hit;

  await setMode(env, "restore_closed");
  const drain = await drainState(env);
  const before = changes(env.DB), beforeL = changes(env.LEDGER);
  const s = spy(env.DB);
  p.release();
  const res = await req;
  s.stop();
  const wrote = changes(env.DB) - before, wroteL = changes(env.LEDGER) - beforeL;

  // 둘 중 하나여야 한다: ① 그 요청이 세어져서 아직 drain 이 안 됐다고 답하거나
  //                    ② drained:true 뒤에는 그 요청이 주 D1 을 한 줄도 만지지 않는다.
  assert.ok(!drain.drained || (wrote === 0 && s.seen.length === 0),
    t(`T62: drained:${drain.drained} 라고 답한 뒤 주 D1 에 쓰기 ${wrote}건 · 질의 ${s.seen.length}건이 났다`));
  assert.ok(res.status === 503 || res.status === 429,
    t(`T62: restore_closed 로 전환됐는데 요청이 ${res.status} 로 진행됐다`));
  // ★ **ledger 쪽도 0 이어야 한다.** 카운터가 ledger 로 옮겨 갔으므로(위협 49) 「주 D1 만
  //   안 건드린다」로 재면 그 방어가 **관측되지 않는 채로** 남는다 — 이 저장소는 관측할 수
  //   없는 방어를 통과 항목으로 세다가 이미 한 번 거짓 안전감을 얻었다(2026-08-19 P2).
  //   전환 뒤에 깨어난 요청은 게이트가 문장 안에 있어 **0행을 쓰고** 429 로 끝난다.
  assert.equal(wroteL, 0,
    t(`T62: drained:true 뒤에 깨어난 요청이 ledger 에 ${wroteL}행을 썼다 — 카운터가 게이트를 안 본다`));
  // 복원 전제(restore_closed · 임차증 0)가 유지되는지도 함께 본다.
  assert.equal((await drainState(env)).open, 0, t("T62: 전환 뒤 임차증이 남았다"));

  // ── T62-b. ★ **이미 있는 버킷 행을 갱신하는 갈래**도 같은 게이트를 본다.
  //   위 T62 는 첫 요청이라 INSERT 갈래만 지난다 — 그 한 갈래만 재면 `ON CONFLICT DO UPDATE`
  //   쪽 게이트가 **관측되지 않는 방어**로 남는다(같은 무늬로 한 번 속았다 · 2026-08-19 P2).
  {
    const e = makeEnv();
    const B = await mkUser(e, "t62b");
    assert.equal((await call(e, B.token, "/book")).status, 200, t("T62-b: 준비가 틀렸다 — 첫 읽기가 막혔다"));
    assert.equal(rows(e.LEDGER, "rate_limits"), 1, t("T62-b: 준비가 틀렸다 — 버킷 행이 없다"));

    const p2 = pauseOn(e.LEDGER, /INSERT INTO rate_limits/);
    const req2 = call(e, B.token, "/book");
    await p2.hit;
    await setMode(e, "restore_closed");
    const d2 = await drainState(e);
    const n0 = e.LEDGER._db.prepare("SELECT n FROM rate_limits").get().n;
    const c0 = changes(e.LEDGER), m0 = changes(e.DB);
    p2.release();
    const r2 = await req2;
    assert.ok(!d2.drained || (changes(e.LEDGER) - c0 === 0 && changes(e.DB) - m0 === 0),
      t(`T62-b: drained 뒤에 갱신 갈래가 ledger ${changes(e.LEDGER) - c0}행 · 주 D1 ${changes(e.DB) - m0}행을 썼다`));
    assert.equal(e.LEDGER._db.prepare("SELECT n FROM rate_limits").get().n, n0,
      t("T62-b: restore_closed 로 전환됐는데 카운터가 올라갔다"));
    assert.ok(r2.status === 503 || r2.status === 429, t(`T62-b: 요청이 ${r2.status} 로 진행됐다`));
  }
}

// ══ T63. 엣지 남용 방어가 없는 배포에서 익명 요청이 D1 을 태운다 ══════════
//
// 고치기 전: 리미터는 **IP·분당**으로만 센다. 서로 다른 IP 로 나눠 오면 그 한도는 곱해진다 —
// 버킷 여섯을 한 창에서 전부 두드리면 IP 하나가 주 D1·ledger 에 수백 행을 쓰고, 백 남짓한
// IP 로 D1 무료 한도(하루 10만 쓰기)가 바닥난다. 바닥나면 **정상 사용자의 저장이 먼저 죽는다.**
// 앱 코드로는 못 막는다(엣지의 일이다). 그러면 **막지 못하는 채로 계정 경로를 열지 않는다** —
// 그것이 코드가 강제할 수 있는 유일한 불변식이다(위협 50).
{
  // 버킷 전부를 익명으로 두드리는 대표 요청. `routeBuckets()` 를 전부 덮는지 아래에서 잰다.
  const SAMPLES = [
    ["login",   (ip) => new Request("https://api.test/cb/kakao?code=x&state=y", { headers: ip })],
    ["signup",  (ip) => new Request("https://api.test/signup/start", { method: "POST",
                  headers: { ...ip, Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })],
    ["read",    (ip) => new Request("https://api.test/book", { headers: ip })],
    ["write",   (ip) => new Request("https://api.test/book", { method: "PUT",
                  headers: { ...ip, Origin: ORIGIN, "Content-Type": "application/json" },
                  body: JSON.stringify({ words: ["가"], version: 0 }) })],
    ["friends", (ip) => new Request("https://api.test/friends", { method: "POST",
                  headers: { ...ip, Origin: ORIGIN, "Content-Type": "application/json" },
                  body: JSON.stringify({ code: "AAAAAA" }) })],
    ["rotate",  (ip) => new Request("https://api.test/friends/code", { method: "POST",
                  headers: { ...ip, Origin: ORIGIN } })],
  ];
  const { routeBuckets } = await import("../worker/index.js");
  assert.deepEqual([...routeBuckets()].sort(), SAMPLES.map(([b]) => b).sort(),
    t("T63: 라우트 표의 버킷과 이 측정 목록이 다르다 — 새 버킷이 측정 밖에 있다"));

  // ── T63-a. ★ **엣지 방어가 없으면 계정 경로는 DB 를 만지기 전에 닫힌다.**
  {
    const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s", DEV_RATE_LIMIT: undefined, RL: undefined });
    const d0 = changes(env.DB), l0 = changes(env.LEDGER);
    const sD = spy(env.DB), sL = spy(env.LEDGER);
    for (let ip = 0; ip < 5; ip++) {
      const h = { "CF-Connecting-IP": "198.51.100." + (10 + ip) };
      for (const [bucket, make] of SAMPLES) {
        const r = await worker.fetch(make(h), env);
        assert.equal(r.status, 503, t(`T63-a: 남용 방어가 없는데 ${bucket} 경로가 ${r.status} 로 열렸다`));
      }
      // 로그인 시작도 계정 경로다 — 열어 두면 제공자까지 갔다가 콜백에서 죽는다.
      assert.equal((await worker.fetch(new Request("https://api.test/login/kakao", { headers: h }), env)).status,
        503, t("T63-a: 남용 방어가 없는데 로그인 시작이 열렸다"));
    }
    sD.stop(); sL.stop();
    assert.equal(changes(env.DB) - d0, 0, t("T63-a: 닫혀 있다면서 주 D1 에 썼다"));
    assert.equal(changes(env.LEDGER) - l0, 0, t("T63-a: 닫혀 있다면서 ledger 에 썼다"));
    assert.equal(sD.seen.length, 0, t(`T63-a: 닫혀 있다면서 주 D1 에 질의를 ${sD.seen.length}건 던졌다`));
    assert.equal(sL.seen.length, 0, t(`T63-a: 닫혀 있다면서 ledger 에 질의를 ${sL.seen.length}건 던졌다`));

    // 상태를 보는 셋은 그대로 열려 있어야 한다 — 운영자가 무엇이 덜 됐는지 볼 수단이다.
    for (const path of ["/health", "/ready", "/policies"]) {
      const r = await worker.fetch(new Request("https://api.test" + path), env);
      assert.notEqual(r.status, 404, t(`T63-a: ${path} 가 사라졌다`));
    }
    const h = await (await worker.fetch(new Request("https://api.test/health"), env)).json();
    assert.equal(h.ready, false, t("T63-a: 남용 방어가 없는데 ready 다"));
    assert.deepEqual(h.providers, [], t("T63-a: 눌러도 503 인 로그인 버튼을 그리게 한다"));
  }

  // ── T63-b. ★ 세는 설정에서 **IP 하나가 한 창에 만드는 쓰기**를 실측하고, 무료 한도와 비교한다.
  //   숫자를 손으로 적지 않는다 — 측정값에서 유도한다.
  const D1_FREE_WRITES_PER_DAY = 100_000;   // Cloudflare 공식 문서(D1 Free plan, rows written/day)
  {
    const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
    let per = 0;
    const detail = [];
    for (const [bucket, make] of SAMPLES) {
      const h = { "CF-Connecting-IP": "198.51.100." + (100 + detail.length) };
      const d0 = changes(env.DB), l0 = changes(env.LEDGER);
      for (let i = 0; i < 400; i++) await worker.fetch(make(h), env);   // 한도를 확실히 넘긴다
      const w = (changes(env.DB) - d0) + (changes(env.LEDGER) - l0);
      detail.push([bucket, w]); per += w;
    }
    const ips = Math.ceil(D1_FREE_WRITES_PER_DAY / (per * 60 * 24));
    console.log("  T63 측정(익명 · IP 하나가 한 창에 만드는 두 DB 쓰기 합):");
    for (const [b, w] of detail) console.log(`    ${b.padEnd(8)} ${String(w).padStart(4)}`);
    console.log(`    합계 ${per}/분 → 하루 ${per * 60 * 24} · 무료 한도 ${D1_FREE_WRITES_PER_DAY} 를 IP ${ips}개가 태운다`);
    assert.ok(per > 0, t("T63-b: 세는 설정인데 쓰기가 0 이다 — 측정이 틀렸다"));
    // ★ 그래서 **이 설정은 배포 가능 상태로 보고되면 안 된다.** 남는 위험을 말로만 적어 두면
    //   다음 사람이 「테스트가 통과하니 됐다」로 읽는다.
    const h = await (await worker.fetch(new Request("https://api.test/health"), env)).json();
    assert.equal(h.ready, false,
      t(`T63-b: IP ${ips}개로 D1 한도를 태울 수 있는 설정이 ready 라고 답한다`));
    // ⚠️ 운영자 키를 들고 묻는다 — 키 없는 `/ready` 는 2026-08-22 부터 **언제나** 503 이라
    //    (위협 56) 그것만 재면 이 단언이 아무것도 확인하지 않는다.
    assert.equal((await worker.fetch(new Request("https://api.test/ready",
      { headers: { "X-Ready-Key": env.READY_KEY } }), env)).status, 503,
      t("T63-b: 같은 설정에서 /ready 가 200 이다"));
  }

  // ── T63-c. ★ 방어를 선언하고 **부를 수 있는** 바인딩이 붙으면 열린다.
  //
  // ⛔ **9판 정정(2026-08-22 · 위협 52·53).** 이 항목은 8판에서 「위협 50 을 닫았다」의 근거로
  //    쓰였다. 실제로 잰 것은 **동작하는 mock 하나를 넣으면 문이 열린다**뿐이고, 그때 코드는
  //    `env.RL` 이 truthy 이기만 하면 열었다 — 문자열도, 빈 객체도, 던지는 `limit()` 도.
  //    **가짜·고장 난 값은 `scripts/test-abuse-guard.mjs` T65 가 잰다.** 여기는 「늘 닫힘」으로
  //    고치는 회귀만 막는다.
  // ⛔ 옛 마지막 단언(「엣지 리미터가 있으면 카운터 쓰기 0」)도 **폐기했다.** 그 동작이 바로
  //    `rlMax()` 를 장식으로 만든 자리다(rotate 5/분이 20회 통과) — 이제 우리 카운터는
  //    **엣지가 있어도 돈다**(T66-b).
  {
    const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s", DEV_RATE_LIMIT: undefined,
                          EDGE_GUARD: "ratelimit", RL: { limit: async () => ({ success: true }) } });
    const A = await mkUser(env, "t63c");
    assert.equal((await call(env, A.token, "/book")).status, 200, t("T63-c: 엣지 방어가 있는데 읽기가 막혔다"));
    const h = await (await worker.fetch(new Request("https://api.test/health"), env)).json();
    assert.equal(h.ready, true, t("T63-c: 엣지 방어가 붙었는데 ready 가 아니다"));
    // 주 D1 은 여전히 카운터를 안 만진다 — 그 쓰기는 2026-08-20 에 ledger 로 갔다(위협 49).
    const d0 = changes(env.DB);
    for (let i = 0; i < 20; i++)
      await worker.fetch(new Request("https://api.test/book", { headers: { "CF-Connecting-IP": "198.51.100.9" } }), env);
    assert.equal(changes(env.DB) - d0, 0,
      t(`T63-c: 익명 요청이 주 D1 에 ${changes(env.DB) - d0}건을 썼다`));
  }
}

// ══ T64. 삭제 키가 어긋난 배포가 `/ready` 200 이다 ════════════════════════
//
// 고치기 전: `deletionEvidenceUsable()` 은 어긋남을 **정확히 잡아냈지만**, `/ready` 는 그것을
// 아예 부르지 않았다 — 주 D1 스키마와 ledger 표 존재만 봤다. 그래서 `DELETION_KEY` 를 잘못
// 넣고 배포해도 smoke test 가 통과하고, 그 배포는 **살아 있는 계정의 pending 을 승격**시킬 수
// 있는 상태로 사용자에게 열린다(위협 46 의 조건이 그대로 선다 · 위협 51).
{
  const full = (extra = {}) => makeEnv({ KAKAO_ID: "id", GOOGLE_ID: "id", GOOGLE_SECRET: "s",
                                         EDGE_GUARD: "ratelimit",
                                         RL: { limit: async () => ({ success: true }) }, ...extra });
  const ready = async (env) => {
    const r = await worker.fetch(new Request("https://api.test/ready",
      { headers: { Origin: ORIGIN, "X-Ready-Key": env.READY_KEY || "" } }), env);
    return { status: r.status, body: await r.json() };
  };

  // ── T64-a. ★ 빈 ledger 로 시작한 첫 배포는 막히지 않는다. 표식도 키 기록도 아직 없다.
  {
    const env = full();
    const r = await ready(env);
    assert.equal(r.status, 200, t("T64-a: 빈 ledger 인데 /ready 가 200 이 아니다 — 첫 배포가 막힌다"));
    assert.equal(r.body.ready, true, t("T64-a: 빈 ledger 인데 ready 가 아니다"));
    assert.equal(r.body.deletionEvidence, true, t("T64-a: 빈 ledger 인데 삭제 증거를 못 쓴다고 한다"));
  }

  // ── T64-b. ★ **키가 어긋난 배포는 503 이다.**
  {
    const env = full();
    // 진짜 삭제 경로가 남기는 것과 같은 모양: 표식 하나 + 그때의 키 검사값.
    const A = await mkUser(env, "t64");
    const lease = await acquireLease(env);
    await markPending(env, lease, await deletionMark(env, A.uid));
    await releaseLease(env, lease);
    assert.equal((await ready(env)).status, 200, t("T64-b: 준비가 틀렸다 — 맞는 키인데 503 이다"));

    const wrong = { ...env, DELETION_KEY: "돌렸는데-버전은-그대로" };
    const r = await ready(wrong);
    assert.equal(r.status, 503, t("T64-b: DELETION_KEY 가 어긋났는데 /ready 가 200 이다"));
    assert.equal(r.body.ready, false, t("T64-b: 키가 어긋났는데 ready:true 다"));
    assert.equal(r.body.deletionEvidence, false, t("T64-b: 삭제 증거를 쓸 수 있다고 답한다"));
    // ⛔ 값·검사값·표식·표 이름·오류 문자열은 나가지 않는다. 참/거짓 하나만 나간다.
    const txt = JSON.stringify(r.body);
    for (const leak of ["돌렸는데", "dk", "DELETION_KEY", "key_check", "deletion_keys",
                        "deletions", "key_version", "SELECT", "mismatch", "표식"])
      assert.ok(!txt.includes(leak), t(`T64-b: /ready 응답에 '${leak}' 가 새어 나왔다`));
  }

  // ── T64-c. ★ 모르는 key_version 이 섞여 있어도 같다 — 그 표식은 대조할 수 없다.
  {
    const env = full();
    env.LEDGER._db.exec(
      `INSERT INTO deletions (mark, key_version, pending_at, pending_alert_at, expires_at)
       VALUES ('mark-v9', 9, 1, 2, ${Date.now() + 1e6})`);
    const r = await ready(env);
    assert.equal(r.status, 503, t("T64-c: 모르는 key_version 이 있는데 /ready 가 200 이다"));
    assert.equal(r.body.deletionEvidence, false, t("T64-c: 대조할 수 없는 표식이 있는데 쓸 수 있다고 한다"));
  }

  // ── T64-d. ★ 다른 이유(스키마·바인딩)와 **구분되어 나간다.** 한 값으로 뭉치면
  //   무엇을 고쳐야 하는지 알 수 없다.
  {
    const env = full();
    const ok = (await ready(env)).body;
    assert.equal(ok.ledger, true, t("T64-d: 준비가 틀렸다"));
    const env2 = full();
    env2.LEDGER._db.exec("DROP TABLE deletion_keys");
    const r2 = await ready(env2);
    assert.equal(r2.status, 503, t("T64-d: deletion_keys 표가 없는데 200 이다"));
    assert.equal(r2.body.ledger, false, t("T64-d: 표가 없는 것을 ledger:false 로 말하지 않는다"));
  }
}

console.log(`test-stage34-closeout: ${n}개 통과 — T61 stale 제거 경합(펜스 3종) · `
  + `T62 drain 밖 주 D1 쓰기 · T63 엣지 방어 없는 배포의 계정 경로 · T64 삭제 키 어긋남의 readiness`);
