// **사용자 단위 fencing** — 처리정지·로그아웃·탈퇴가 완료된 뒤에, 그보다 **먼저 인증된**
// 요청이 사용자 데이터를 읽거나 쓰거나 친구에게 노출할 수 있는가.
//
// ── 왜 별도 스위트인가 ─────────────────────────────────────────────────
// `worker/fence.js` 의 fence 는 **유지보수 세대**(write_fence.epoch)를 재는 장치다. 그건
// 「지금 전체가 멈췄나」를 묻고, 「이 사람이 아직 처리를 허용했나」는 묻지 않는다.
// 처리정지는 후자다 — `POST /me/suspend` 가 `suspended_at` 을 적고 세션을 전부 지워도,
// **이미 인증을 통과한 요청**은 그 뒤에 자기 SQL 을 던진다. 요청 초입의 `whoAmI()` 한 번은
// 검사와 사용 사이에 창이 있는 TOCTOU 라 방어가 아니다(사전조회를 하나 더 붙여도 같다).
//
// 그래서 방어를 **문장 안**에 둔다: 사용자 데이터를 만지는 모든 주 D1 문장이
//   EXISTS (SELECT 1 FROM users WHERE id = ? AND suspended_at IS NULL AND session_version = ?)
// 를 함께 들고 나간다. 인증 당시의 세대를 요구하므로 정지·로그아웃·탈퇴가 **같은 원자 경계**
// 에서 막힌다.
//
// ⚠️ **여기서 재는 것은 경합이다.** 인증과 데이터 접근 사이에 결정적 배리어를 넣고 그 틈에
//    정지를 완주시킨다 — 「빠르니까 안 겹친다」로는 아무것도 증명되지 않는다.
import "./_workers-shim.mjs";
import "./_build-contract.mjs";   // 요청에 빌드 계약을 붙인다(위협 80 · 테스트 전용)
import assert from "node:assert";
import worker, { createAccountWithPolicy, newSession } from "../worker/index.js";
import { makeD1, makeLedger, asRequest } from "./_d1.mjs";

const ORIGIN = "https://app.test";
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 11)).toString("base64url");
let n = 0;
const t = (m) => { n++; return m; };

// ── 결정적 배리어 ────────────────────────────────────────────────────────
// 「이 SQL 이 처음 나가는 순간」에 멈춘다. 멈춘 사이에 다른 요청을 **완주**시키고 나서 푼다.
// 한 번만 문다(armed) — 그래야 정지 요청 자신이 자기 배리어에 걸리지 않는다.
function barrier(db, match) {
  let hit, release, armed = true;
  const hitP = new Promise((r) => { hit = r; });
  const relP = new Promise((r) => { release = r; });
  const wrapped = {
    ...db,
    prepare(sql) {
      const st = db.prepare(sql);
      if (!armed || !match(sql)) return st;
      armed = false;
      for (const k of ["first", "all", "run"]) {
        const orig = st[k].bind(st);
        st[k] = async (...a) => { hit(); await relP; return orig(...a); };
      }
      return st;
    },
  };
  return { db: wrapped, hit: hitP, release };
}

const makeEnv = (extra = {}) => ({
  APP_ORIGIN: ORIGIN, STATE_KEY: "state-key-FIXTURE-1", RL_KEY: "rl-key-FIXTURE-2",
  DEV_RATE_LIMIT: "1",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tombstone-key-FIXTURE-3",
  DELETION_KEY: "deletion-key-FIXTURE-4", SESSION_ENVELOPE_KEY: "envelope-key-FIXTURE-5",
  KAKAO_ID: "id", KAKAO_SECRET: "s", NAVER_ID: "id", NAVER_SECRET: "s",
  DB: makeD1(), LEDGER: makeLedger(), ...extra,
});

let seq = 0;
const mkUser = async (env, provider = "kakao", sub = "u" + ++seq) => {
  const uid = await asRequest(env, (fe) => createAccountWithPolicy(fe, provider, sub,
    { stateHash: "s-" + sub + Math.random(), stateExp: Date.now() + 600e3, occurredAt: Date.now() }));
  return { uid, sub, provider, token: await asRequest(env, (fe) => newSession(fe, uid)) };
};
const newToken = (env, uid) => asRequest(env, (fe) => newSession(fe, uid));
const req = (env, path, { method = "GET", token, body } = {}) => {
  const h = { Cookie: token ? "shh_s=" + token : "" };
  if (method !== "GET") h.Origin = ORIGIN;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(new Request("https://api.test/api" + path,
    { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};
const row = (env, sql, ...a) => env.DB._db.prepare(sql).get(...a);
const putBook = (env, uid, words, name = "") =>
  env.DB._db.prepare("INSERT INTO books (user_id, words, nickname, version, updated_at)"
    + " VALUES (?,?,?,1,?) ON CONFLICT (user_id) DO UPDATE SET words = excluded.words")
    .run(uid, JSON.stringify(words), name, 1);

// ══ F1. 읽기 경합 — 정지가 끝난 뒤 옛 요청이 단어장을 읽는가 ═══════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["비밀단어"]);
  const other = await newToken(env, A.uid);          // 다른 기기의 세션
  const b = barrier(env.DB, (s) => /FROM books\s+WHERE user_id/.test(s));
  env.DB = b.db;

  const inflight = req(env, "/book", { token: A.token });
  await b.hit;                                        // A 는 인증을 통과하고 멈춰 있다
  const sus = await req(env, "/me/suspend", { method: "POST", token: other });
  assert.equal(sus.status, 200, t("F1: 정지 요청이 실패했다 — 경합을 재지 못한다"));
  b.release();
  const res = await inflight;
  const text = await res.text();
  assert.ok(!text.includes("비밀단어"),
    t(`F1: ★ 정지가 끝난 뒤에도 옛 요청이 단어장을 읽었다 (status ${res.status})`));
  assert.equal(res.status, 403, t(`F1: 정지된 계정의 옛 요청이 403 이 아니다 (${res.status})`));
}

// ══ F2. 쓰기 경합 — 정지가 끝난 뒤 옛 요청이 단어장을 쓰는가 ═══════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["원래"]);
  const other = await newToken(env, A.uid);
  const b = barrier(env.DB, (s) => /INSERT INTO books/.test(s));
  env.DB = b.db;

  const inflight = req(env, "/book",
    { method: "PUT", token: A.token, body: { words: ["나중에"], version: 1 } });
  await b.hit;
  assert.equal((await req(env, "/me/suspend", { method: "POST", token: other })).status, 200,
    t("F2: 정지 요청이 실패했다"));
  b.release();
  const res = await inflight;
  assert.notEqual(res.status, 200, t("F2: ★ 정지 뒤의 옛 쓰기가 200 으로 성공했다"));
  const saved = JSON.parse(row(env, "SELECT words FROM books WHERE user_id = ?", A.uid).words);
  assert.deepEqual(saved, ["원래"], t("F2: ★ 정지가 끝난 뒤에 옛 요청이 단어장을 덮어썼다"));
}

// ══ F3. 로그아웃 경합 — 세대가 올라간 뒤 옛 요청이 쓰는가 ══════════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["원래"]);
  const other = await newToken(env, A.uid);
  const b = barrier(env.DB, (s) => /INSERT INTO books/.test(s));
  env.DB = b.db;

  const inflight = req(env, "/book",
    { method: "PUT", token: A.token, body: { words: ["나중에"], version: 1 } });
  await b.hit;
  assert.equal((await req(env, "/session", { method: "DELETE", token: other })).status, 200,
    t("F3: 로그아웃이 실패했다"));
  b.release();
  const res = await inflight;
  assert.notEqual(res.status, 200, t("F3: ★ 로그아웃 뒤의 옛 쓰기가 성공했다"));
  assert.deepEqual(JSON.parse(row(env, "SELECT words FROM books WHERE user_id = ?", A.uid).words),
    ["원래"], t("F3: ★ 모든 기기 로그아웃 뒤에 옛 요청이 단어장을 덮어썼다"));
  assert.equal(row(env, "SELECT COUNT(*) n FROM sessions WHERE user_id = ?", A.uid).n, 0,
    t("F3: 로그아웃이 세션 행을 안 지웠다 — 문장 순서가 바뀌어 방어가 자기 발을 밟았다"));
}

// ══ F4. 탈퇴 경합 — 계정이 사라진 뒤 옛 요청이 읽는가 ═════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["비밀단어"]);
  const other = await newToken(env, A.uid);
  const b = barrier(env.DB, (s) => /FROM books\s+WHERE user_id/.test(s));
  env.DB = b.db;

  const inflight = req(env, "/book", { token: A.token });
  await b.hit;
  const del = await req(env, "/me", { method: "DELETE", token: other });
  assert.equal(del.status, 200, t(`F4: 탈퇴가 실패했다 (${del.status}) — 배리어가 삭제를 막았다`));
  b.release();
  const res = await inflight;
  assert.ok(!(await res.text()).includes("비밀단어"),
    t("F4: ★ 계정이 지워진 뒤에도 옛 요청이 단어장을 읽었다"));
}

// ══ F5. 정상 0행을 정지로 오판하지 않는다 ═════════════════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env), B = await mkUser(env);
  // 단어장이 아예 없는 계정의 읽기 — 0행이지만 정상이다.
  const empty = await req(env, "/book", { token: A.token });
  assert.equal(empty.status, 200, t("F5: 단어장이 없는 계정의 읽기가 200 이 아니다"));
  assert.deepEqual((await empty.json()).words, [], t("F5: 빈 단어장이 안 왔다"));
  // 친구가 아닌 사람 끊기 — 0행이지만 정상 404 다.
  const gone = await req(env, "/friends/" + B.uid, { method: "DELETE", token: A.token });
  assert.equal(gone.status, 404, t(`F5: 친구가 아닌 사람 끊기가 404 가 아니다 (${gone.status})`));
  // ★ **양성 대조.** 술어가 SQL 을 깨뜨리면 위 「쓰기가 실패했다」 검사들이 **틀린 이유로**
  //   통과한다. 정상 쓰기가 실제로 200 인지 여기서 잰다(실제로 한 번 그렇게 깨졌다).
  const put = await req(env, "/book",
    { method: "PUT", token: A.token, body: { words: ["정상"], version: 0 } });
  assert.equal(put.status, 200, t(`F5: ★ 정상 저장이 200 이 아니다 (${put.status}) — 술어가 SQL 을 깨뜨렸다`));
  assert.deepEqual(JSON.parse(row(env, "SELECT words FROM books WHERE user_id = ?", A.uid).words),
    ["정상"], t("F5: ★ 정상 저장이 DB 에 안 남았다"));
  const again = await req(env, "/book", { token: A.token });
  assert.deepEqual((await again.json()).words, ["정상"], t("F5: 저장한 단어장을 다시 못 읽는다"));
  // 친구 요청·목록도 정상 경로가 살아 있어야 한다.
  const code = await req(env, "/friends/code/ensure", { method: "POST", token: B.token });
  assert.equal(code.status, 200, t("F5: 초대 코드 생성이 깨졌다"));
  const add = await req(env, "/friends",
    { method: "POST", token: A.token, body: { code: (await code.json()).code } });
  assert.equal(add.status, 200, t(`F5: 친구 요청이 깨졌다 (${add.status})`));
  const list = await req(env, "/friends", { token: A.token });
  assert.equal(list.status, 200, t("F5: 친구 목록이 깨졌다"));
  assert.equal((await list.json()).out.length, 1, t("F5: 보낸 친구 요청이 목록에 없다"));
}

// ══ F6. 오류 계약 — 정지는 403, 세대 불일치는 401. 내부값은 안 나간다 ══════
//
// ⚠️ **정지가 끝난 뒤의 「다음 요청」은 401 이다** — 정지가 세션을 전부 지웠으므로 인증 자체가
//    안 된다. 403 이 나오는 자리는 **경합으로 살아남은 요청** 하나뿐이고, 그래서 여기서도
//    배리어로 그 상태를 만들어 잰다(안 만들면 이 검사는 아무것도 안 재는 401 검사가 된다).
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["비밀단어"]);
  const other = await newToken(env, A.uid);
  const b = barrier(env.DB, (s) => /FROM books\s+WHERE user_id/.test(s));
  env.DB = b.db;
  const inflight = req(env, "/book", { token: A.token });
  await b.hit;
  await req(env, "/me/suspend", { method: "POST", token: other });
  b.release();
  const res = await inflight;
  assert.equal(res.status, 403, t(`F6: 경합으로 살아남은 정지 계정 요청이 403 이 아니다 (${res.status})`));
  const body = await res.text();
  assert.ok(JSON.parse(body).suspended === true, t("F6: 403 인데 suspended 표시가 없다"));
  assert.ok(!body.includes(A.uid), t("F6: 응답에 내부 계정 번호가 실렸다"));
  assert.ok(!/suspended_at|session_version|users|write_fence/.test(body),
    t("F6: 응답에 DB 구조가 실렸다"));
}

// ══ F7. 로그아웃 경합의 답은 **401** 이다 (정지와 갈라 말한다) ═════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["비밀단어"]);
  const other = await newToken(env, A.uid);
  const b = barrier(env.DB, (s) => /FROM books\s+WHERE user_id/.test(s));
  env.DB = b.db;
  const inflight = req(env, "/book", { token: A.token });
  await b.hit;
  await req(env, "/session", { method: "DELETE", token: other });
  b.release();
  const res = await inflight;
  assert.equal(res.status, 401,
    t(`F7: 로그아웃 경합이 401 이 아니다 (${res.status}) — 정지가 아닌데 「정지 중」이라 말한다`));
  assert.ok(!(await res.text()).includes("비밀단어"), t("F7: ★ 로그아웃 뒤에 단어장이 읽혔다"));
}

// ══ F8. 정지된 친구의 값은 **친구의 요청**으로도 안 나간다 (같은 문장 안) ══
{
  const env = makeEnv();
  const A = await mkUser(env), B = await mkUser(env);
  putBook(env, B.uid, ["비밀단어"], "비");
  env.DB._db.prepare("INSERT INTO friendships (requester_id, addressee_id, pair_key, status,"
    + " created_at, accepted_at) VALUES (?,?,?,'accepted',?,?)")
    .run(A.uid, B.uid, [A.uid, B.uid].sort().join("|"), 1, 2);
  const before = await req(env, `/friends/${B.uid}/book`, { token: A.token });
  assert.equal(before.status, 200, t("F8: 정지 전에 친구 단어장을 못 본다 — 검사가 헛돈다"));
  await req(env, "/me/suspend", { method: "POST", token: B.token });
  const after = await req(env, `/friends/${B.uid}/book`, { token: A.token });
  assert.ok(!(await after.text()).includes("비밀단어"),
    t("F8: ★ 정지된 친구의 단어장이 친구의 요청으로 나갔다"));
}

// ══ F9. 정지 뒤의 옛 요청은 **탈퇴도** 못 한다 ════════════════════════════
// 탈퇴는 되돌릴 수 없다. 정지된 계정이 「스스로 멈춘 상태」인데 그 사이 옛 요청 하나가
// 계정을 지워 버리면, 사용자가 재개하려 돌아왔을 때 계정이 없다.
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["비밀단어"]);
  const other = await newToken(env, A.uid);
  const b = barrier(env.DB, (s) => /DELETE FROM users/.test(s));
  env.DB = b.db;

  const inflight = req(env, "/me", { method: "DELETE", token: A.token });
  await b.hit;
  assert.equal((await req(env, "/me/suspend", { method: "POST", token: other })).status, 200,
    t("F9: 정지 요청이 실패했다"));
  b.release();
  const res = await inflight;
  assert.notEqual(res.status, 200, t(`F9: ★ 정지 뒤의 옛 요청이 계정을 지웠다 (${res.status})`));
  assert.equal(row(env, "SELECT COUNT(*) n FROM users WHERE id = ?", A.uid).n, 1,
    t("F9: ★ 정지된 계정이 옛 요청으로 지워졌다 — 되돌릴 수 없는 손실이다"));
  assert.equal(row(env, "SELECT COUNT(*) n FROM books WHERE user_id = ?", A.uid).n, 1,
    t("F9: 단어장이 CASCADE 로 함께 지워졌다"));
}

// ══ F10. 「정지되지 않았다」는 **세대와 독립으로** 재어야 한다 ═════════════
//
// ⚠️ 왜 따로 재나(2026-08-27 · 돌연변이 M90 생존): `POST /me/suspend` 는 정지 표시와 **세대
//    증가**를 함께 하므로, 위 F1·F2 는 두 조건 중 **세대 하나만으로도** 통과한다. 그래서
//    술어에서 `suspended_at IS NULL` 을 빼도 테스트가 전부 초록이었다.
//    「정지된 계정의 데이터는 읽지도 쓰지도 않는다」가 **두 번째 장치(세대)에 얹혀 있으면**,
//    세대를 안 올리는 정지 경로가 하나 생기는 날 방어가 통째로 사라진다.
// 그래서 여기서는 **세대를 그대로 둔 채** 정지 표시만 세운다 — 운영자 조치·미래의 관리 경로·
// 복원 직후처럼 실제로 있을 수 있는 모양이다.
{
  const env = makeEnv();
  const A = await mkUser(env);
  putBook(env, A.uid, ["비밀단어"]);
  const b = barrier(env.DB, (s) => /FROM books\s+WHERE user_id/.test(s));
  env.DB = b.db;

  const inflight = req(env, "/book", { token: A.token });
  await b.hit;
  // ★ 세대는 **그대로** 둔다. 정지 표시만 세운다.
  env.DB._db.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").run(Date.now(), A.uid);
  b.release();
  const res = await inflight;
  const text = await res.text();
  assert.ok(!text.includes("비밀단어"),
    t(`F10: ★ 세대가 같으면 정지된 계정의 단어장이 읽힌다 (${res.status}) — 술어가 세대에만 기대고 있다`));
  assert.equal(res.status, 403, t(`F10: 정지 표시만 세운 계정의 응답이 403 이 아니다 (${res.status})`));

  // 쓰기도 같다.
  const env2 = makeEnv();
  const B = await mkUser(env2);
  putBook(env2, B.uid, ["원래"]);
  const b2 = barrier(env2.DB, (s) => /INSERT INTO books/.test(s));
  env2.DB = b2.db;
  const w = req(env2, "/book", { method: "PUT", token: B.token, body: { words: ["나중에"], version: 1 } });
  await b2.hit;
  env2.DB._db.prepare("UPDATE users SET suspended_at = ? WHERE id = ?").run(Date.now(), B.uid);
  b2.release();
  assert.notEqual((await w).status, 200, t("F10: 정지 표시만 세웠는데 옛 쓰기가 성공했다"));
  assert.deepEqual(JSON.parse(row(env2, "SELECT words FROM books WHERE user_id = ?", B.uid).words),
    ["원래"], t("F10: ★ 정지 표시만 세운 계정의 단어장이 덮어써졌다"));
}

// ══ F11. batch 는 **전부 막히거나 전부 통과한다** ═════════════════════════
//
// ⚠️ 왜 생겼나(2026-08-27 · 독립 검토 H1): `suspendAccount` 가 세션 삭제(`{FENCE_ONLY}`)와
//    정지 표시(`{FENCE}`)를 **한 batch 에 섞어** 보내고 있었다. batch 의 판별은 「하나라도
//    바뀌었으면 술어는 통과한 것」인데, 그 성질은 **문장이 같은 술어를 들 때만** 참이다.
//    그래서 그 사이에 다른 기기가 로그아웃하면 — 세대가 올라 정지 표시는 0행이 되는데
//    세션 삭제는 술어가 약해 그대로 써서 — **세션만 지워지고 정지는 안 된 채 `{ok:true}`**
//    가 나갔다. 사용자는 「멈췄다」고 들었는데 친구에게는 그대로 보인다.
//
// ⚠️ **이 블록은 HTTP 왕복이 아니라 batch 를 직접 부른다.** 셰임은 D1 처럼 쓰기를 한 줄로
//    세우므로, batch 안에서 멈춘 채로 다른 요청을 보내면 그 요청이 트랜잭션 뒤에서 대기한다 —
//    즉 **HTTP 로는 이 틈을 만들 수 없다.** 재려는 것은 batch 의 판별 규칙 자체다.
{
  const { withFence, bindActor, ActorGone } = await import("../worker/fence.js");
  const { acquireLease } = await import("../worker/ledger.js");

  // ── a. 자리표시자를 섞은 batch 는 **던진다**(구조적으로 막는다).
  {
    const env = makeEnv();
    const A = await mkUser(env);
    const lease = await acquireLease(env);
    const fe = withFence(env, lease);
    bindActor(fe, { uid: A.uid, gen: 0 });
    await assert.rejects(
      () => fe.DB.batch([
        fe.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND {FENCE_ONLY}").bind(A.uid),
        fe.DB.prepare("UPDATE users SET suspended_at = 1 WHERE id = ? AND {FENCE}").bind(A.uid),
      ]),
      /mixes/,
      t("F11-a: ★ 자리표시자를 섞은 batch 가 통과했다 — 판별 규칙의 전제가 깨진다"));
    assert.equal(row(env, "SELECT COUNT(*) n FROM sessions WHERE user_id = ?", A.uid).n, 1,
      t("F11-a: 섞인 batch 가 던지기 전에 이미 썼다"));
  }

  // ── b. 같은 술어를 든 batch 는 **행위자가 사라지면 전부 0행**이고 던진다.
  {
    const env = makeEnv();
    const A = await mkUser(env);
    const lease = await acquireLease(env);
    const fe = withFence(env, lease);
    bindActor(fe, { uid: A.uid, gen: 0 });
    // 다른 기기가 로그아웃했다 — 세대가 오른다.
    env.DB._db.prepare("UPDATE users SET session_version = 1 WHERE id = ?").run(A.uid);
    await assert.rejects(
      () => fe.DB.batch([
        fe.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND {FENCE}").bind(A.uid),
        fe.DB.prepare(
          "UPDATE users SET suspended_at = 1, session_version = session_version + 1"
          + " WHERE id = ? AND {FENCE}").bind(A.uid),
      ]),
      (e) => e instanceof ActorGone && e.reason === "stale",
      t("F11-b: ★ 세대가 바뀐 뒤의 batch 가 조용히 끝났다"));
    const u = row(env, "SELECT suspended_at AS s, session_version AS v FROM users WHERE id = ?", A.uid);
    assert.ok(u.s === null || u.s === undefined, t("F11-b: ★ 막혔어야 할 batch 가 정지를 적었다"));
    assert.equal(Number(u.v), 1, t("F11-b: ★ 막혔어야 할 batch 가 세대를 올렸다"));
    assert.equal(row(env, "SELECT COUNT(*) n FROM sessions WHERE user_id = ?", A.uid).n, 1,
      t("F11-b: ★ 정지도 못 했으면서 세션을 지웠다 — 이유 없는 로그아웃이다"));
  }

  // ── c. 양성 대조 — 행위자가 살아 있으면 둘 다 쓴다.
  {
    const env = makeEnv();
    const A = await mkUser(env);
    const res = await req(env, "/me/suspend", { method: "POST", token: A.token });
    assert.equal(res.status, 200, t(`F11-c: 정상 정지가 ${res.status} 다`));
    const u = row(env, "SELECT suspended_at AS s FROM users WHERE id = ?", A.uid);
    assert.ok(u.s, t("F11-c: 정지 표시가 안 적혔다"));
    assert.equal(row(env, "SELECT COUNT(*) n FROM sessions WHERE user_id = ?", A.uid).n, 0,
      t("F11-c: 세션이 안 지워졌다"));
  }
}

console.log(`test-actor-fence: ${n} assertions ok`);
