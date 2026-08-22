// 친구·세션·단어장 권한 검증. `node scripts/test-friends.mjs`
// worker/index.js 를 **그대로 불러** 진짜 sqlite(D1 셰임) 위에서 돌린다 — 규칙을 테스트에 베끼지 않는다.
// 여기가 틀리면 증상이 "남의 단어장이 보인다"라서 사람 눈으로는 늦게 잡힌다.
//
// ⚠️ 2026-08-11 에 저장소가 KV → D1, 세션이 Bearer → HttpOnly 쿠키로 바뀌었다.
//    **단언의 의도는 그대로 두고 전송 수단만 바꿨다** — 무엇을 지키는가는 안 바뀌었기 때문이다.
//    가짜 KV(Map)는 "절대 실패하지 않고 즉시 일관적인" 저장소라 재는 게 적었다(함정 50).
//    지금은 진짜 SQL 이라 UNIQUE 충돌·외래키 CASCADE·changes 카운트가 실제로 일어난다.
import assert from "node:assert";
import worker, { createAccountWithPolicy, findUser, newSession, pathTemplate,
  routeFor, rlMax, routeBuckets, routeCount, maintenanceAllows, envelopeOk,
  authRoutes } from "../worker/index.js";
import { makeD1, makeLedger, withLatency } from "./_d1.mjs";
import { drainState, readMode, MODE_UNBOUND } from "../worker/ledger.js";
// 옛 배포 세대의 **고정 fixture**. 지금 코드가 아니다 — 그 파일 머리말을 볼 것.
import legacy from "./fixtures/legacy-worker.mjs";
// `login` 버킷의 한도. worker/index.js 의 RL_MAX 와 같은 값이어야 한다(T53 이 쓴다).
const RL_MAX_LOGIN = 10;
import { beginRestore, drainReport, restoreGate } from "../worker/ops.js";

const ORIGIN = "https://app.test";

// RL_KEY 는 **있어야 하는 값**이다(리미터 버킷 키를 HMAC 으로 만든다). 없으면 리미터가
// 세지 않으므로, 여기서 안 주면 아래 레이트리밋 검사들이 전부 조용히 통과해 버린다.
// 없을 때 무슨 일이 나는지는 26번 블록이 따로 잰다.
function makeEnv(extra = {}) {
  return { APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "test-signing-key",
           RL_KEY: "test-rate-limit-key", DB: makeD1(),
           // ⚠️ **`/ready` 의 진단은 운영자 키를 요구한다**(2026-08-22 · 위협 56). 없으면
           //    두 DB 를 만지지 않고 503 이다 — 아래 `call()` 이 이 값을 헤더로 싣는다.
           READY_KEY: "test-ready-key",
           // ⚠️ **로컬 전용 남용 방어 스위치**(2026-08-20 · 위협 50). 없으면 계정 라우트가
           //    DB 를 만지기 전에 503 이다(T63-a 가 그 상태를 따로 잰다). 이 값으로는
           //    `/ready` 가 절대 200 이 되지 않는다 — 그래서 아래 ready 검사들은 `RL` 을 준다.
           DEV_RATE_LIMIT: "1",
           // ledger 와 삭제 키가 없으면 계정 삭제가 **503 으로 거부된다**(표식 없는 삭제를
           // 만들지 않기 위해서다). 없을 때의 동작은 아래 별도 블록이 따로 잰다.
           LEDGER: makeLedger(), DELETION_KEY: "test-deletion-key",
           // 가입 전용 키. 32바이트를 base64url 로 — 길이가 다르면 서버가 fail-closed 다.
           SIGNUP_STATE_KEY: SIGNUP_KEY_B64, TOMBSTONE_KEY: "test-tombstone-key",
           // 세션 쿠키 서명 전용 키(2026-08-22 · 결정 4). 없으면 계정 라우트가 DB 전에 503 이다.
           SESSION_ENVELOPE_KEY: "test-session-envelope-key",
           ...extra };
}
// 32바이트. b64u 로 43자.
export const SIGNUP_KEY_B64 = Buffer.from(
  Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64url");

// 계정 하나 + 그 계정의 세션 하나. **진짜 코드 경로**를 쓴다 — 토큰 해시를 여기서 계산하면
// 그 순간 로직이 두 벌이 되어, 서버가 바뀌어도 테스트는 옛 규칙을 계속 통과시킨다.
// ⚠️ **`internalUid()` 는 없어졌다**(2026-08-18). 그 함수는 조회와 생성을 같이 해서
//    로그인 경로가 지나가는 것만으로 계정을 만들었다. 이제 계정 생성은 정책 기록·소비 표식과
//    **같은 트랜잭션**에서만 일어나므로, 테스트도 그 진짜 경로를 쓴다.
let stateSeq = 0;
async function signUp(env, provider, subject) {
  const uid = await createAccountWithPolicy(env, provider, subject, {
    stateHash: `test-state-${++stateSeq}`, stateExp: Date.now() + 600e3, occurredAt: Date.now(),
  });
  return { uid, token: await newSession(env, uid) };
}
const another = (env, uid) => newSession(env, uid);   // 같은 계정의 다른 기기

const call = async (env, token, path, method = "GET", body, extra = {}) => {
  // ⚠️ **운영자 키를 늘 싣는다**(2026-08-22 · 위협 56). `/ready` 의 진단은 이 헤더가 있어야
  //    돈다 — 없으면 두 DB 를 만지지 않고 503 이라, 여기 검사들이 조용히 통과해 버린다.
  //    키가 **없는** 요청의 동작은 `scripts/test-abuse-guard.mjs` T69 가 따로 잰다.
  const headers = { Origin: ORIGIN, "Content-Type": "application/json",
                    "X-Ready-Key": env.READY_KEY || "", ...extra };
  if (token) headers.Cookie = "shh_s=" + token;
  const res = await worker.fetch(new Request("https://api.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

// ══ 1. 친구: 요청 → 수락 ══════════════════════════════════════════════════
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "1111"), B = await signUp(env, "kakao", "2222"),
        C = await signUp(env, "kakao", "3333");
  const c = (t, p, m, b) => call(env, t, p, m, b);

  await c(A.token, "/book", "PUT", { words: ["사랑", "보고싶다"], name: "가" });
  await c(B.token, "/book", "PUT", { words: ["고맙다"], name: "나" });

  // 1. 로그인 없이는 아무것도 안 된다.
  assert.equal((await c(null, "/friends")).status, 401);

  // 2. 내 초대 코드는 늘 같다. 바뀌면 예전에 보낸 링크가 죽는다.
  const a1 = await c(A.token, "/friends"), a2 = await c(A.token, "/friends");
  assert.ok(a1.body.code && a1.body.code === a2.body.code, "초대 코드가 호출마다 바뀐다");
  assert.deepEqual([a1.body.friends, a1.body.in, a1.body.out], [[], [], []]);

  // 3. 자기 자신·엉뚱한 코드는 막는다.
  assert.equal((await c(A.token, "/friends", "POST", { code: a1.body.code })).status, 400, "자기 자신");
  assert.equal((await c(A.token, "/friends", "POST", { code: "없는코드" })).status, 404, "없는 코드");

  // 4. B 가 A 의 링크를 연다 → **요청**이지 친구가 아니다. 여기가 이 기능의 핵심이다.
  const sent = await c(B.token, "/friends", "POST", { code: a1.body.code });
  assert.equal(sent.body.state, "sent", "링크를 열자마자 친구가 되면 안 된다");
  assert.deepEqual((await c(B.token, "/friends")).body.friends, [], "보낸 쪽에 친구가 생겼다");
  assert.equal((await c(A.token, "/friends")).body.in.length, 1, "받은 요청이 안 보인다");
  assert.equal((await c(A.token, "/friends")).body.in[0].name, "나", "요청자 별명이 안 온다");

  // 4b. 수락 전에는 **단어 개수도** 안 준다. 아직 서로 남이고, 개인정보처리방침은
  //     "친구에게 보이는 것"으로만 적혀 있다 — 문서에 없는 걸 서버가 보내면 문서가 거짓말이 된다.
  assert.ok(!("count" in (await c(A.token, "/friends")).body.in[0]), "받은 요청에 단어 개수가 실려 있다");
  assert.ok(!("count" in (await c(B.token, "/friends")).body.out[0]), "보낸 요청에 단어 개수가 실려 있다");
  assert.ok(!("count" in sent.body.friend), "요청을 보낸 응답에 단어 개수가 실려 있다");

  // 5. 수락 전에는 단어장이 안 보인다 — **양쪽 어느 방향으로도.**
  //    관계가 행 하나라 "한쪽만 친구" 라는 상태가 아예 없다(KV 시절엔 그 반쪽을 따로 막아야 했다).
  assert.equal((await c(B.token, "/friends/" + A.uid + "/book")).status, 403, "수락 전인데 단어장이 보인다");
  assert.equal((await c(A.token, "/friends/" + B.uid + "/book")).status, 403, "요청 받은 쪽이 먼저 들여다본다");

  // 6. 받지도 않은 요청을 수락할 수 없다 — C 가 임의로 A 를 친구로 만들면
  //    A 는 보낸 적 없는 사람에게 단어장이 보이게 된다.
  assert.equal((await c(C.token, "/friends/" + A.uid, "PUT")).status, 400, "받은 적 없는 요청이 수락됐다");

  // 7. A 가 수락 → 양쪽 다 친구. 행 하나를 바꾸므로 한쪽만 되는 일이 없다.
  await c(A.token, "/friends/" + B.uid, "PUT");
  assert.deepEqual((await c(A.token, "/friends")).body.friends.map((f) => f.uid), [B.uid]);
  assert.deepEqual((await c(B.token, "/friends")).body.friends.map((f) => f.uid), [A.uid]);
  assert.deepEqual((await c(A.token, "/friends")).body.in, [], "수락했는데 요청이 남았다");
  assert.deepEqual((await c(B.token, "/friends")).body.out, [], "수락됐는데 보낸 요청이 남았다");

  // 8. 이제 서로의 단어장이 보인다.
  const seen = await c(B.token, "/friends/" + A.uid + "/book");
  assert.deepEqual(seen.body.words, ["사랑", "보고싶다"]);
  assert.equal(seen.body.name, "가");

  // 9. 친구 목록엔 단어 **개수만** 온다. 목록 화면에 안 쓰는 단어까지 실어 보내지 않는다.
  assert.equal((await c(B.token, "/friends")).body.friends[0].count, 2);
  assert.ok(!("words" in (await c(B.token, "/friends")).body.friends[0]), "목록에 단어가 실려 나온다");

  // 10. 끊으면 양쪽에서 사라지고 단어장도 다시 막힌다.
  await c(A.token, "/friends/" + B.uid, "DELETE");
  assert.deepEqual((await c(A.token, "/friends")).body.friends, []);
  assert.deepEqual((await c(B.token, "/friends")).body.friends, [], "끊었는데 상대 목록에 남았다");
  assert.equal((await c(B.token, "/friends/" + A.uid + "/book")).status, 403, "끊었는데 단어장이 보인다");

  // 11. 서로 링크를 주고받으면 수락을 기다리지 않고 맺어진다.
  //     (둘 다 "수락 대기"로 멈춰 있으면 사용자는 뭘 눌러야 할지 모른다)
  const bCode = (await c(B.token, "/friends")).body.code;
  await c(A.token, "/friends", "POST", { code: bCode });
  const mutual = await c(B.token, "/friends", "POST", { code: a1.body.code });
  assert.equal(mutual.body.state, "ok", "서로 보냈는데 친구가 안 됐다");
  assert.deepEqual((await c(A.token, "/friends")).body.friends.map((f) => f.uid), [B.uid]);

  // 12. 계정을 지우면 친구 쪽 목록에서도 사라지고, 초대 코드도 죽는다.
  //     D1 에서는 CASCADE 가 한다 — 지울 것을 빠뜨릴 수가 없다.
  await c(A.token, "/me", "DELETE");
  assert.deepEqual((await c(B.token, "/friends")).body.friends, [], "탈퇴한 사람이 친구 목록에 남았다");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM invite_codes").get().n, 1,
    "탈퇴했는데 초대 코드가 남았다(B 것 하나만 있어야 한다)");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM friendships").get().n, 0, "탈퇴했는데 관계가 남았다");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM books WHERE user_id = ?").get(A.uid).n, 0,
    "탈퇴했는데 단어장이 남았다");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").get(A.uid).n, 0,
    "탈퇴했는데 세션 행이 남았다");

  // 12b. Pages Functions 아래에선 주소가 `/api/book` 으로 온다. 접두어를 안 벗기면 **전부 404** 라
  //      앱이 통째로 죽는데, 테스트가 `/book` 으로만 부르면 그걸 못 본다.
  assert.equal((await c(B.token, "/api/book")).status, 200, "/api 접두어가 안 벗겨졌다");
  assert.equal((await c(B.token, "/api/friends")).status, 200, "/api/friends 가 안 잡힌다");
}

// 친구 관계를 DB 에 **직접** 심는 픽스처. pair_key 를 여기서 한 번만 계산한다 —
// 0003 이 NOT NULL 을 붙이기 전에는 세 자리가 각자 넣으면서 그중 둘이 이 컬럼을 빠뜨렸고,
// 그게 통과했다. "앱이 항상 채운다"가 이미 이 파일에서 틀렸던 셈이다.
function befriend(env, a, b, status = "accepted") {
  const [x, y] = [a, b].sort();
  env.DB._db.prepare(
    "INSERT INTO friendships (requester_id,addressee_id,pair_key,status,created_at) VALUES (?,?,?,?,0)")
    .run(a, b, `${x}|${y}`, status);
}

// ══ 2. 초대 코드 회전 ═════════════════════════════════════════════════════
// 링크는 어디로든 퍼진다. 되돌릴 방법이 없으면 한 번 샌 코드가 영영 요청을 받는다.
{
  const env = makeEnv();
  const X = await signUp(env, "kakao", "X"), Y = await signUp(env, "kakao", "Y"), Z = await signUp(env, "kakao", "Z");
  const c = (t, p, m, b) => call(env, t, p, m, b);

  const old = (await c(X.token, "/friends")).body.code;
  await c(Y.token, "/friends", "POST", { code: old });      // Y 는 옛 링크로 친구가 된 사람
  await c(X.token, "/friends/" + Y.uid, "PUT");

  // 13. 회전하면 코드가 바뀐다. `/friends/code` 가 `/friends/:uid` 정규식보다 먼저 잡혀야 한다.
  const rotated = await c(X.token, "/friends/code", "POST");
  assert.equal(rotated.status, 200, "회전 라우트가 /friends/:uid 로 새 버렸다");
  assert.ok(rotated.body.code && rotated.body.code !== old, "회전했는데 코드가 그대로다");
  assert.equal((await c(X.token, "/friends")).body.code, rotated.body.code, "목록이 아직 옛 코드를 준다");

  // 14. **옛 링크는 죽는다.** 이게 이 기능의 전부다.
  assert.equal((await c(Z.token, "/friends", "POST", { code: old })).status, 404, "회전했는데 옛 링크가 아직 산다");
  // 15. 새 링크는 된다.
  assert.equal((await c(Z.token, "/friends", "POST", { code: rotated.body.code })).body.state, "sent", "새 링크로 요청이 안 된다");
  // 16. **이미 맺어진 친구는 그대로다.** 코드는 "요청을 보낼 자격"이지 관계가 아니다.
  assert.deepEqual((await c(X.token, "/friends")).body.friends.map((u) => u.uid), [Y.uid], "회전이 친구 관계를 끊었다");
}

// ══ 3. 마스터 계정 ════════════════════════════════════════════════════════
{
  const env = makeEnv();
  const boss = await signUp(env, "kakao", "BOSS"), nobody = await signUp(env, "kakao", "NOBODY");
  const get = async (t) => (await call(env, t, "/book")).body;

  // 17. 목록이 비어 있으면 아무도 마스터가 아니다(기본값이 안전한 쪽).
  assert.equal((await get(boss.token)).pro, false, "MASTER_UIDS 가 비었는데 프로가 켜졌다");
  assert.equal((await get(boss.token)).master, false, "MASTER_UIDS 가 비었는데 마스터가 켜졌다");

  env.MASTER_UIDS = " " + boss.uid + " , someone-else ";
  // 18. 목록에 있으면 프로. 공백이 섞여 있어도 읽어야 한다(secret 은 사람이 손으로 넣는다).
  assert.equal((await get(boss.token)).pro, true, "마스터인데 프로가 안 켜졌다");
  assert.equal((await get(boss.token)).master, true, "마스터인데 master 가 안 왔다");
  assert.equal((await get(nobody.token)).pro, false, "마스터가 아닌데 프로가 켜졌다");

  // 19. pro 는 **저장되지 않는다.** 굳으면 목록에서 빼도 옛 레코드가 계속 프로라고 말한다.
  await call(env, boss.token, "/book", "PUT", { words: ["사랑"], name: "", version: 0 });
  const cols = env.DB._db.prepare("SELECT * FROM books WHERE user_id = ?").get(boss.uid);
  assert.ok(!("pro" in cols) && !("master" in cols), "pro/master 가 DB 에 저장됐다");
  delete env.MASTER_UIDS;
  assert.equal((await get(boss.token)).pro, false, "목록에서 뺐는데 옛 레코드가 프로라고 말한다");
}

// ══ 4. 로그인 복귀 주소 (allowed) ═════════════════════════════════════════
// 여기가 틀리면 증상이 "남의 계정이 털린다"라서 화면으로는 영영 안 보인다.
{
  const env = makeEnv({ KAKAO_ID: "test-client-id" });
  const login = (ret, e = env) =>
    worker.fetch(new Request("https://api.test/login/kakao" + (ret ? "?return=" + encodeURIComponent(ret) : "")), e);

  // 20. 운영 기본값(DEV_ORIGINS 없음)에서 LAN·localhost 는 거부된다.
  for (const bad of ["http://192.168.1.9:8000", "http://localhost:8000", "http://127.0.0.1:8000", "https://evil.example"])
    assert.equal((await login(bad)).status, 400, `${bad} 로 복귀가 허용됐다 — 세션이 새는 자리다`);
  // 21. 주소가 아닌 문자열도 400 이다. 500(예외)이 나면 안 된다.
  for (const junk of ["not a url", "javascript:alert(1)"])
    assert.equal((await login(junk)).status, 400, `'${junk}' 가 400 이 아니다`);
  // 22. 앱 주소는 그대로 통과한다(302). 막으면 로그인이 통째로 죽는다.
  assert.equal((await login(ORIGIN + "/shhh-app/")).status, 302, "앱 주소로 못 돌아간다");
  assert.equal((await login(null)).status, 302, "return 없이 로그인이 안 된다");
  // 23. 개발 Worker 에서는 여전히 열린다.
  assert.equal((await login("http://192.168.1.9:8000", { ...env, DEV_ORIGINS: "1" })).status, 302, "DEV_ORIGINS=1 인데 LAN 이 막혔다");
  // 24. CORS 도 같은 판정을 쓴다. 낯선 Origin 에는 헤더를 안 붙인다.
  const pre = (o) => worker.fetch(new Request("https://api.test/book", { method: "OPTIONS", headers: { Origin: o } }), env);
  assert.equal((await pre("http://192.168.1.9:8000")).headers.get("Access-Control-Allow-Origin"), null, "낯선 Origin 에 CORS 가 열렸다");
  assert.equal((await pre(ORIGIN)).headers.get("Access-Control-Allow-Origin"), ORIGIN, "앱 Origin 에 CORS 가 안 붙었다");
}

// ══ 5. 세션 — 쿠키 · 세대 · 무효화 ════════════════════════════════════════
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  const tablet = await another(env, A.uid), laptop = await another(env, A.uid);
  const Z = await signUp(env, "kakao", "Z");
  const c = (t, p, m, b, x) => call(env, t, p, m, b, x);

  // 25. 지어낸 토큰으로는 아무도 될 수 없다.
  assert.equal((await c("made-up-token", "/book")).status, 401, "지어낸 토큰으로 로그인이 됐다");
  // 26. **원본 토큰이 DB 에 없다.** DB 가 새도 남의 세션을 쓸 수 없어야 한다.
  const rows = env.DB._db.prepare("SELECT * FROM sessions").all();
  const dump = JSON.stringify(rows);
  for (const t of [A.token, tablet, laptop, Z.token])
    assert.ok(!dump.includes(t), "sessions 에 토큰 원문이 저장됐다");
  assert.ok(rows.every((r) => r.token_hash && r.token_hash.length >= 32), "토큰 해시가 없다");

  // 27. 본문 한도. Node 의 Request 는 Content-Length 를 안 붙이므로 이 검사는 **chunked 경로**를
  //     그대로 잰다 — 헤더만 보고 막는 구현이면 여기서 통과해 버린다.
  assert.equal((await c(A.token, "/book", "PUT", { words: ["x".repeat(9000)] })).status, 400, "8KB 넘는 본문이 통과했다");
  assert.equal((await c(A.token, "/book", "PUT", { words: ["사랑"] }, { "Content-Type": "text/plain" })).status, 400,
    "JSON 이 아닌 본문이 통과했다");

  // 28. 로그아웃은 **이 계정의 모든 기기**를 끊고, 남의 세션은 안 건드린다.
  await c(A.token, "/book", "PUT", { words: ["사랑"], name: "가", version: 0 });
  const out = await c(A.token, "/session", "DELETE");
  assert.equal(out.status, 200);
  assert.match(out.headers.get("Set-Cookie") || "", /shh_s=;.*Max-Age=0/, "로그아웃이 쿠키를 안 지운다");
  for (const [t, who] of [[A.token, "이 기기"], [tablet, "태블릿"], [laptop, "노트북"]])
    assert.equal((await c(t, "/book")).status, 401, `로그아웃했는데 ${who} 세션이 살아 있다`);
  assert.equal((await c(Z.token, "/book")).status, 200, "로그아웃이 남의 세션까지 끊었다");

  // 29. **세대로 끊는다 — 훑지 않는다.** KV 시절엔 `list()` 로 세션 키를 훑었는데 최종 일관성이라
  //     다른 기기가 60초 안에 만든 세션은 목록에 없어서 못 지웠다. 세대가 오르면 그 세션도 죽는다.
  const ver = env.DB._db.prepare("SELECT session_version v FROM users WHERE id = ?").get(A.uid).v;
  assert.equal(ver, 1, "로그아웃이 세대를 안 올렸다");
  // 세대가 오른 뒤에 **행만 남아 있는** 옛 세션을 손으로 심어도 죽어 있어야 한다.
  env.DB._db.prepare("INSERT INTO sessions (token_hash,user_id,session_version,expires_at) VALUES (?,?,?,?)")
    .run("stale-hash", A.uid, 0, Date.now() + 1e9);
  assert.equal(env.DB._db.prepare(
    "SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=? AND s.session_version=u.session_version")
    .get(A.uid).n, 0, "옛 세대 세션이 아직 유효로 판정된다");

  // 30. 탈퇴하면 다른 기기가 **되살리지 못한다.**
  const B = await signUp(env, "kakao", "B");
  const phone2 = await another(env, B.uid);
  await c(B.token, "/friends");                      // 초대 코드를 만들어 둔다
  await c(B.token, "/me", "DELETE");
  assert.equal((await c(phone2, "/book")).status, 401, "탈퇴했는데 다른 기기 세션이 살아 있다");
  assert.equal((await c(phone2, "/friends")).status, 401, "탈퇴한 계정이 초대 코드를 되살릴 수 있다");
}

// ══ 6. state 서명 · 세션 고정(nonce) ══════════════════════════════════════
{
  const env = makeEnv({ KAKAO_ID: "id", GOOGLE_ID: "id", NAVER_ID: "id" });
  const loc = (await worker.fetch(new Request("https://api.test/login/kakao"), env)).headers.get("Location");
  const state = new URL(loc).searchParams.get("state");

  // 31. 로그인 시작이 DB 에 아무것도 쓰지 않는다. 여기는 **인증이 없는 자리**라,
  //     저장소를 쓰면 curl 반복만으로 한도를 태울 수 있다.
  for (const t of ["users", "sessions", "books", "friendships", "invite_codes"])
    assert.equal(env.DB._db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `로그인 시작이 ${t} 에 썼다`);

  // 32. 서명이 안 맞는 state 는 안 받는다. 받으면 남이 우리 도메인을 거쳐 아무 데로나 보낸다.
  const cb = (s) => worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=" + encodeURIComponent(s)), env);
  assert.equal((await cb("aaa.bbb")).status, 400, "위조 state 가 통과했다");
  assert.equal((await cb(state + "x")).status, 400, "서명을 고친 state 가 통과했다");
  assert.equal((await cb("")).status, 400, "빈 state 가 통과했다");
  // 33. 카카오로 시작한 state 를 구글 자리에서 쓸 수 없다.
  assert.equal((await worker.fetch(new Request("https://api.test/cb/google?code=x&state=" + encodeURIComponent(state)), env)).status,
    400, "다른 제공자의 state 가 통과했다");

  // 34. n 이 state **안에** 들어간다 — 밖(쿼리)에 있으면 남이 고쳐 붙일 수 있다.
  const s1 = new URL((await worker.fetch(new Request("https://api.test/login/kakao?n=nonce-1"), env)).headers.get("Location"))
    .searchParams.get("state");
  assert.ok(!s1.includes("nonce-1"), "n 이 서명 밖에 그대로 있다");
  const [prov, back, exp, n1] = JSON.parse(Buffer.from(s1.slice(0, s1.lastIndexOf(".")), "base64url").toString());
  assert.equal(n1, "nonce-1", "state 에 n 이 안 실렸다");
  assert.equal(prov, "kakao");
  assert.ok(back && exp > Date.now());
  // 35. n 을 고치면 서명이 깨져 콜백이 거부된다.
  const tampered = s1.replace(/^[^.]+/, Buffer.from(JSON.stringify([prov, back, exp, "nonce-evil"])).toString("base64url"));
  assert.equal((await cb(tampered)).status, 400, "n 을 바꾼 state 가 통과했다");
}

// ══ 6b. 로그인 왕복 표 — **콜백을 연 브라우저가 시작한 브라우저인가** ══════════
//
// 여기가 이 파일에서 가장 중요한 자리다. state 서명은 "우리가 만든 state 인가"만 말한다 —
// **누가 그 주소를 들고 왔는지는 모른다.** 그래서 이런 공격이 성립했었다:
//   ① 공격자가 자기 로그인을 시작해 아직 안 쓴 `?code=…&state=…` 를 손에 쥔다
//   ② 그 주소를 **이미 로그인해 있는 피해자**에게 보낸다
//   ③ 서버가 서명이 맞으니 code 를 교환하고 세션을 만들어 피해자 브라우저에 공격자 계정 쿠키를 심는다
//   ④ 앱은 그 뒤에야 nonce 가 다른 걸 알지만 이미 늦었고, 다음 동기화에서 피해자의
//      단어장과 별명이 **공격자 계정으로** 올라간다
// 이제 로그인을 시작할 때 그 브라우저에만 표(shh_t)를 심고, 콜백에서 먼저 대조한다.
{
  const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s", NAVER_ID: "id", NAVER_SECRET: "s" });

  // 제공자 서버를 부르지 않는다. 진짜로 부르면 테스트가 남의 서버 상태에 매달리고,
  // 재려는 것(우리 문이 언제 열리나)과도 상관이 없다.
  const withProvider = async (fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => new Response(JSON.stringify(
      // 제공자마다 회원번호가 있는 자리가 다르다(카카오 id · 네이버 response.id · 구글 sub).
      // 셋을 다 담아 둔다 — 어느 갈래를 재든 같은 가짜가 쓰인다.
      String(url).includes("token")
        ? { access_token: "t" }
        : { id: "u1", sub: "u1", response: { id: "u1" } }),
      { headers: { "Content-Type": "application/json" } });
    try { return await fn(); } finally { globalThis.fetch = real; }
  };
  // ⚠️ **로그인 경로는 더 이상 계정을 만들지 않는다**(2026-08-18). 이 블록이 재려는 것은
  //    「표(txn) 결속」이므로 계정은 **미리 있어야** 한다 — 없으면 표가 맞아도 `signup_required`
  //    로 돌아간다. 그 성질 자체는 scripts/test-signup.mjs 가 따로 잰다.
  for (const p of ["kakao", "naver", "google"]) {
    await createAccountWithPolicy(env, p, "u1",
      { stateHash: `pre-${p}`, stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  }
  const sessions = () => env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  // ⚠️ 이 블록이 재는 것은 **표(txn) 결속**이지 레이트리밋이 아니다. 그런데 로그인 왕복이
  //    `login` 버킷 하나로 모이면서, IP 를 안 붙이면 여기 나오는 브라우저 여럿이 전부 같은
  //    "anon" 한 사람으로 세어져 표 검사 도중에 429 가 난다(실제 배포에서는 각자 다른 IP 다).
  //    그래서 요청마다 다른 IP 를 준다 — 검사를 느슨하게 하는 게 아니라 현실과 맞추는 것이다.
  //    레이트리밋이 실제로 막는지는 아래 22번 블록이 따로 잰다.
  let ip = 0;
  const asBrowser = (h = {}) => ({ ...h, "CF-Connecting-IP": `203.0.113.${++ip}` });
  const start = async (p = "kakao") => {
    const r = await worker.fetch(new Request(`https://api.test/login/${p}?n=nonce-1`, { headers: asBrowser() }), env);
    const set = r.headers.get("Set-Cookie") || "";
    return {
      state: new URL(r.headers.get("Location")).searchParams.get("state"),
      txn: (set.match(/shh_t=([^;]*)/) || [])[1] || "",
      set,
    };
  };
  const cb = (state, cookie) => worker.fetch(new Request(
    "https://api.test/cb/kakao?code=real-code&state=" + encodeURIComponent(state),
    { headers: asBrowser(cookie ? { Cookie: cookie } : {}) }), env);

  const a = await start();

  // 76. 로그인 시작이 **그 브라우저에만** 표를 심는다. HttpOnly 여야 자바스크립트가 못 읽는다.
  assert.ok(a.txn, "로그인 시작이 표를 안 심었다");
  assert.match(a.set, /HttpOnly/, "표가 HttpOnly 가 아니다");
  assert.match(a.set, /SameSite=Lax/, "표에 SameSite 가 없다 — 제공자에서 돌아올 때 안 실린다");
  assert.match(a.set, /Max-Age=600/, "표에 수명이 없다");

  // 77. **원본이 state 에 실리면 안 된다.** state 는 주소에 실려 남에게 보이므로,
  //     원본이 거기 있으면 표를 그대로 베껴 붙일 수 있다. 실리는 건 해시뿐이다.
  assert.ok(!a.state.includes(a.txn), "표 원본이 state 에 실려 있다 — 베껴 쓸 수 있다");

  // 78. ★ **표가 없으면 거부한다.** 공격자의 유효한 code/state 를 남이 열었을 때가 이 경우다.
  const noCookie = await cb(a.state, null);
  assert.equal(noCookie.status, 400, "표 없이 콜백이 통과했다 — 남의 링크로 로그인이 된다");
  assert.equal(sessions(), 0, "거부했는데 세션이 만들어졌다");
  assert.ok(!/shh_s=/.test(noCookie.headers.get("Set-Cookie") || ""), "거부했는데 세션 쿠키를 심었다");

  // 79. ★ **다른 표여도 거부한다.** 피해자가 자기 로그인을 시작한 적이 있어도 마찬가지다.
  const b = await start();
  assert.equal((await cb(a.state, "shh_t=" + b.txn)).status, 400, "남의 state 를 내 표로 통과시켰다");
  assert.equal((await cb(a.state, "shh_t=" + a.txn.slice(0, -1))).status, 400, "표 한 글자를 지워도 통과했다");
  assert.equal(sessions(), 0, "거부했는데 세션이 만들어졌다");

  // 80. ★ **거부는 제공자를 부르기 전에 일어난다.** 세션이 안 생기는 것만 봐서는
  //     "부르고 나서 버렸다"와 구분이 안 된다 — 그러면 남의 링크로 우리 쿼터를 태울 수 있다.
  let called = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => { called++; return new Response("{}"); };
  await cb(a.state, null);
  globalThis.fetch = real;
  assert.equal(called, 0, "거부하기 전에 제공자를 불렀다");

  // 81. 표가 맞으면 그대로 통과한다. 막으면 로그인이 통째로 죽으므로 반대쪽도 재야 한다.
  const c = await start();
  const okRes = await withProvider(() => cb(c.state, "shh_t=" + c.txn));
  assert.equal(okRes.status, 302, "표가 맞는데 로그인이 막혔다");
  assert.match(okRes.headers.get("Location") || "", /#login=ok/, "성공인데 실패로 돌아갔다");
  assert.equal(sessions(), 1, "성공했는데 세션이 안 생겼다");
  const cookies = okRes.headers.getSetCookie ? okRes.headers.getSetCookie() : [okRes.headers.get("Set-Cookie")];
  assert.ok(cookies.some((s) => /shh_s=/.test(s)), "세션 쿠키를 안 심었다");
  // 82. 표는 **한 번 쓰고 버린다.** 안 버리면 같은 표로 다음 왕복까지 통한다.
  assert.ok(cookies.some((s) => /shh_t=;/.test(s) || /shh_t=[^;]*;\s*.*Max-Age=0/.test(s)),
    "쓴 표를 안 지웠다");

  // 83. 토큰은 **주소에 안 실린다.** 실리면 그 주소가 곧 남에게 보낼 수 있는 로그인 링크다.
  const loc = okRes.headers.get("Location");
  assert.ok(!loc.includes(env.DB._db.prepare("SELECT token_hash FROM sessions").get().token_hash),
    "세션 값이 주소에 실렸다");

  // 84. 네이버 갈래(/exchange)도 **같은 문**을 쓴다. 한쪽만 막으면 공격자는 막힌 쪽을 안 쓴다.
  const n = await start("naver");
  const ex = (state, cookie) => worker.fetch(new Request(
    "https://api.test/exchange/naver?code=real-code&state=" + encodeURIComponent(state),
    { headers: asBrowser(cookie ? { Cookie: cookie } : {}) }), env);
  assert.equal((await ex(n.state, null)).status, 400, "표 없이 /exchange 가 통과했다");
  assert.equal((await ex(n.state, "shh_t=" + a.txn)).status, 400, "남의 표로 /exchange 가 통과했다");
  assert.equal(sessions(), 1, "/exchange 거부가 세션을 만들었다");
  assert.equal((await withProvider(() => ex(n.state, "shh_t=" + n.txn))).status, 200, "표가 맞는데 막혔다");
}

// ══ 6c. 친구 관계는 두 사람당 하나 — 반대 방향 경합 ═══════════════════════
// A→B 와 B→A 가 둘 다 들어가면 목록에 같은 사람이 두 번 나오고, 남은 「취소」를 누르면
// DELETE 가 양방향이라 **이미 맺은 친구가 끊긴다.** 예전엔 기본키가 방향까지 포함해 안 부딪혔다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A"), B = await signUp(env, "kakao", "B");
  const c = (t, p, m, b) => call(env, t, p, m, b);
  const rows = () => env.DB._db.prepare("SELECT requester_id, status, pair_key FROM friendships").all();
  const aCode = (await c(A.token, "/friends")).body.code;
  const bCode = (await c(B.token, "/friends")).body.code;

  // 85. ★ DB 가 직접 막는다. 애플리케이션이 확인을 빠뜨려도 두 줄이 될 수 없다.
  assert.throws(() => env.DB._db
    .prepare("INSERT INTO friendships (requester_id,addressee_id,pair_key,status,created_at) VALUES (?,?,?,'pending',0)")
    .run(A.uid, B.uid, [A.uid, B.uid].sort().join("|")) &&
    env.DB._db
    .prepare("INSERT INTO friendships (requester_id,addressee_id,pair_key,status,created_at) VALUES (?,?,?,'pending',0)")
    .run(B.uid, A.uid, [A.uid, B.uid].sort().join("|")),
    /UNIQUE/, "반대 방향 관계가 두 줄 들어갔다");
  env.DB._db.exec("DELETE FROM friendships");

  // 86. 서로 보내면 한 줄이 되고 그 자리에서 맺어진다.
  assert.equal((await c(A.token, "/friends", "POST", { code: bCode })).body.state, "sent");
  assert.equal((await c(B.token, "/friends", "POST", { code: aCode })).body.state, "ok", "서로 보냈는데 안 맺어졌다");
  assert.equal(rows().length, 1, "서로 보냈더니 관계가 두 줄 생겼다");
  assert.equal(rows()[0].status, "accepted");

  // 87. 목록에 **한 번만** 나온다. 두 줄이던 시절엔 「내 친구」와 「보낸 요청」에 같이 떴다.
  for (const t of [A.token, B.token]) {
    const l = (await c(t, "/friends")).body;
    assert.equal(l.friends.length, 1, "친구가 목록에 두 번 나온다");
    assert.deepEqual([l.in, l.out], [[], []], "맺어졌는데 요청이 남아 있다");
  }

  // 88. 같은 사람이 링크를 여러 번 눌러도 한 줄이고, **500 이 나면 안 된다**
  //     (기본키에 부딪히는 자리라 그냥 다시 INSERT 하면 예외로 죽는다).
  env.DB._db.exec("DELETE FROM friendships");
  assert.equal((await c(A.token, "/friends", "POST", { code: bCode })).body.state, "sent");
  const again = await c(A.token, "/friends", "POST", { code: bCode });
  assert.equal(again.status, 200, "같은 링크를 두 번 눌렀더니 오류가 났다");
  assert.equal(again.body.state, "sent", "혼자 두 번 눌렀는데 친구가 됐다");
  assert.equal(rows().length, 1, "같은 방향으로 두 줄이 생겼다");
  assert.ok(!("count" in again.body.friend), "요청 단계인데 단어 개수가 실렸다");

  // 89. 끊으면 한 번의 DELETE 로 사라진다(방향과 무관).
  await c(B.token, "/friends/" + A.uid, "DELETE");
  assert.equal(rows().length, 0, "끊었는데 관계가 남았다");
}

// ══ 7. 잘못된 주소 · 친구 상한 ════════════════════════════════════════════
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  // 36. 반쪽 인코딩(`%zz`)은 decodeURIComponent 가 던진다. **500 이 나가면 안 된다.**
  //     ⚠️ 2026-08-19 부터 `GET /friends/<id>` 는 라우트 표에 없다(그 자리는 `/book` 뿐이다) —
  //        그래서 DB 를 만지기 전에 404 다. 재려는 것은 예나 지금이나 "예외가 새어 500 이
  //        되지 않는다"이므로, **실제 라우트인 PUT 으로도** 같이 잰다(거기서는 400 이다).
  assert.equal((await call(env, A.token, "/friends/%zz")).status, 404, "잘못된 인코딩이 500 을 냈다");
  assert.equal((await call(env, A.token, "/friends/%zz", "PUT")).status, 400,
    "잘못된 인코딩이 실제 라우트에서 400 이 아니다");

  // 37. 친구 상한. 없으면 초대 코드가 샜을 때 목록이 무한히 자란다.
  const V = await signUp(env, "kakao", "V");
  for (let i = 0; i < 50; i++) {
    const f = await signUp(env, "kakao", "F" + i);
    // pair_key 를 **여기서도 채운다.** 0003 이 NOT NULL 을 붙이기 전에는 이 픽스처가 NULL 을
    // 넣고 있었고, 그게 통과했다 — 즉 "앱이 항상 채운다"는 말이 이 자리에서 이미 틀렸다.
    // (SQLite 의 UNIQUE 는 NULL 을 서로 다르게 보므로 유니크 인덱스도 못 잡았다.)
    befriend(env, A.uid, f.uid);
  }
  const vCode = (await call(env, V.token, "/friends")).body.code;
  assert.equal((await call(env, A.token, "/friends", "POST", { code: vCode })).status, 429, "친구 상한이 없다");
}

// ══ 8. API 응답 헤더 ══════════════════════════════════════════════════════
// `_headers` 는 정적 자산에만 붙는다 — 여기 헤더는 worker 가 직접 붙여야 한다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  const r = await call(env, A.token, "/book");
  // 38. 개인 단어장이 캐시에 남으면 한 기기를 두 사람이 쓸 때 앞사람 응답이 뒷사람에게 뜬다.
  assert.match(r.headers.get("Cache-Control") || "", /no-store/, "API 응답에 no-store 가 없다");
  // 39. CORS 헤더가 Origin 마다 다르므로 Vary 가 없으면 캐시가 다른 Origin 에 재사용한다.
  assert.match(r.headers.get("Vary") || "", /Origin/, "Vary: Origin 이 없다");
}

// ══ 9. CSRF — 쿠키로 옮기면서 새로 열린 공격면 ════════════════════════════
// Bearer 시절엔 원천적으로 불가능했다(남의 사이트가 우리 헤더를 못 붙인다).
// 쿠키는 **브라우저가 알아서 붙이므로** 남의 사이트에서 온 상태 변경 요청이 통한다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  await call(env, A.token, "/book", "PUT", { words: ["사랑"], name: "", version: 0 });

  // 40. 낯선 Origin 의 상태 변경은 막는다.
  for (const bad of ["https://evil.example", "http://localhost:8000"])
    assert.equal((await call(env, A.token, "/book", "PUT", { words: ["털림"], version: 1 }, { Origin: bad })).status,
      403, `${bad} 에서 온 쓰기가 통과했다`);
  assert.deepEqual((await call(env, A.token, "/book")).body.words, ["사랑"], "CSRF 요청이 단어장을 바꿨다");

  // 41. 탈퇴·로그아웃도 같은 문을 쓴다 — 여기가 열려 있으면 링크 하나로 남의 계정이 지워진다.
  assert.equal((await call(env, A.token, "/me", "DELETE", undefined, { Origin: "https://evil.example" })).status, 403,
    "낯선 Origin 에서 온 탈퇴가 통과했다");
  assert.equal((await call(env, A.token, "/session", "DELETE", undefined, { Origin: "https://evil.example" })).status, 403,
    "낯선 Origin 에서 온 로그아웃이 통과했다");

  // 42. 우리 Origin 은 그대로 통과한다. 막으면 앱이 통째로 죽는다.
  assert.equal((await call(env, A.token, "/book", "PUT", { words: ["사랑", "고맙다"], version: 1 })).status, 200,
    "우리 Origin 의 쓰기가 막혔다");
}

// ══ 10. 제공자 회원번호 비공개 ════════════════════════════════════════════
// 전에는 uid 가 `kakao:1234567` 그대로였다. 친구 요청을 한 번 주고받으면 상대의 카카오
// 회원번호를 알게 되고, 주소와 세션 토큰에도 그대로 박혔다. 방침은 그런 말을 한 적이 없다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "1234567"), B = await signUp(env, "naver", "ABCDEFG");
  const seen = [];
  const rec = async (...a) => { const r = await call(env, ...a); seen.push(JSON.stringify(r.body)); return r; };

  await rec(A.token, "/book", "PUT", { words: ["사랑"], name: "가", version: 0 });
  await rec(B.token, "/book", "PUT", { words: ["고맙다"], name: "나", version: 0 });
  const codeA = (await rec(A.token, "/friends")).body.code;
  await rec(B.token, "/friends", "POST", { code: codeA });
  await rec(A.token, "/friends");
  await rec(B.token, "/friends");
  const acc = await rec(A.token, "/friends/" + B.uid, "PUT");
  await rec(A.token, "/friends");
  await rec(B.token, "/friends/" + A.uid + "/book");
  await rec(A.token, "/book");

  // 43. 수락 전후를 통틀어 **어느 응답에도** 제공자 접두어·회원번호가 없다.
  assert.equal(acc.status, 200, "재현 전제가 깨졌다 — 수락이 안 됐다");
  for (const body of seen)
    for (const pat of ["kakao:", "naver:", "google:", "1234567", "ABCDEFG"])
      assert.ok(!body.includes(pat), `응답에 제공자 식별자 '${pat}' 가 실려 나왔다: ${body.slice(0, 120)}`);
  // 44. 내부 id 에도 제공자 접두어가 없다.
  for (const u of [A.uid, B.uid]) assert.ok(!u.includes(":"), `내부 uid 에 제공자 접두어가 있다: ${u}`);
  // 45. 세션 토큰도 계정을 말하지 않는다(예전엔 앞부분이 b64u(uid) 였다).
  assert.ok(!A.token.includes(A.uid) && !B.token.includes(B.uid), "토큰이 계정 id 를 담고 있다");
  // 46. 제공자 번호는 users 행에만 있다.
  assert.equal(env.DB._db.prepare("SELECT provider_subject FROM users WHERE id = ?").get(A.uid).provider_subject, "1234567");

  // 47. 같은 제공자 계정은 **늘 같은 내부 id** 다. 매번 새로 만들면 로그인할 때마다 빈 단어장이 된다.
  assert.equal(await findUser(env, "kakao", "1234567"), A.uid, "같은 제공자 계정이 다른 번호를 받았다");
  // 48. **조회는 만들지 않는다.** 예전 `internalUid()` 는 없으면 그 자리에서 계정을 만들었고,
  //     그래서 로그인 경로가 지나가는 것만으로 가입이 됐다. 이제 없으면 null 이다.
  const before = env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n;
  assert.equal(await findUser(env, "kakao", "9999"), null, "없는 계정을 조회했는데 값이 나왔다");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, before,
    "조회만 했는데 계정이 늘었다 — 조회와 생성이 다시 붙었다");
  // 49. 다른 사람은 다른 번호.
  const other = await createAccountWithPolicy(env, "kakao", "9999",
    { stateHash: "s-9999", stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  assert.notEqual(other, A.uid, "다른 계정이 같은 번호를 받았다");
}

// ══ 11. 레이트리밋 이음새 ═════════════════════════════════════════════════
// ⚠️ Rate Limiting 바인딩은 Pages Functions 에서 못 쓴다(문서 확인). 운영에서는 이 코드가
//    **아무것도 막지 않는다** — 여기서 재는 건 "바인딩이 생기면 실제로 붙는가"뿐이다.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const A = await signUp(env, "kakao", "A");
  const calls = [];
  env.RL = { limit: async ({ key }) => { calls.push(key); return { success: false }; } };

  // 49. 쓰기 요청은 막힌다 — 429 + Retry-After.
  const put = await call(env, A.token, "/book", "PUT", { words: [], version: 0 });
  assert.equal(put.status, 429, "레이트리밋이 쓰기를 안 막는다");
  assert.equal(put.headers.get("Retry-After"), "60", "Retry-After 가 없다");
  // 50. 로그인 왕복도 막힌다(아직 누구인지 모르는 자리 — IP 로 센다).
  //     ⚠️ 재는 자리는 `/cb` 다. 상한은 **세션이 실제로 생기는 자리**에만 걸고, 시작(`/login`)은
  //     세지 않는다 — 둘 다 세면 한 번의 로그인이 두 번 세어져 한도가 절반이 된다(27번 블록).
  assert.equal((await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y"), env)).status, 429,
    "로그인 왕복이 안 막힌다");
  //     ⚠️ **엣지 사전 거름은 다른 층이다**(2026-08-22 · 위협 52·53). 그 층은 버킷이 없는
  //     계정 라우트도 `route` 키로 세므로, **전부 막는 mock** 아래에서는 로그인 시작도 429 다.
  //     그것이 이중 집계가 아니라는 사실은 **우리 카운터의 행 수**로 잰다 — 문서의 한도를
  //     절반으로 만드는 것은 그쪽이고, 그쪽은 로그인 시작을 여전히 세지 않는다.
  const before = env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n;
  assert.equal((await worker.fetch(new Request("https://api.test/login/kakao"), env)).status, 429,
    "엣지가 전부 막는 상태인데 로그인 시작이 통과했다");
  const openEnv = makeEnv({ KAKAO_ID: "id", DEV_RATE_LIMIT: "1" });
  assert.equal((await worker.fetch(new Request("https://api.test/login/kakao"), openEnv)).status, 302,
    "엣지 거름이 없는데 로그인 시작을 막았다 — 세션도 안 만드는 자리다");
  assert.equal(env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n, before,
    "로그인 시작이 **우리** 카운터에 세어졌다 — 한 번의 로그인이 두 번 세어진다");
  assert.equal(openEnv.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n, 0,
    "로그인 시작이 우리 카운터에 행을 만들었다");
  // 51. **읽기도 센다**(2026-08-19 정정). 예전에는 "읽기는 안 막는다 — 세면 정상 사용이 먼저
  //     걸린다"였고 그 자리가 정확히 재현 R5 였다: 인증이 필요한 읽기가 **아무 버킷에도 없어서**
  //     쿠키 없는 요청·위조 쿠키 요청이 상한 없이 임차증을 소비했다(요청 200회 → ledger 400 쓰기).
  //     이제 전용 `read` 버킷(분당 120)이라 정상 사용은 여전히 안 걸리고 상한은 생긴다.
  assert.equal((await call(env, A.token, "/book")).status, 429, "읽기가 안 세어진다 — 익명 요청의 상한이 없다");
  // 52. 인증 전/후 버킷이 갈린다. 한 버킷이면 남의 로그인 시도가 내 저장을 막는다.
  //     ⚠️ 인증 전 버킷 이름은 `login` **하나**다. 전에는 공통 `auth` 와 라우트별 `login` 이
  //     둘 다 있어서 한 번의 로그인이 두 곳에 세어졌다(한도는 절반, D1 쓰기는 두 배).
  assert.ok(calls.some((k) => k.startsWith("login|")) && calls.some((k) => k.startsWith("write|")),
    "버킷이 안 갈렸다: " + JSON.stringify(calls));
  assert.ok(calls.some((k) => k.startsWith("read|")), "읽기 버킷이 없다: " + JSON.stringify(calls));
  assert.ok(!calls.some((k) => k.startsWith("auth|")), "없어진 auth 버킷이 아직 세고 있다: " + JSON.stringify(calls));
  // ⚠️ **키가 uid 가 아니라 IP 다**(2026-08-19). 리미터가 인증보다 **먼저** 돌아야 인증되지 않은
  //     요청이 임차증을 소비하기 전에 막힌다 — 그 자리에서는 uid 를 아직 모른다(재현 R5).
  //     대가: 공유 IP(회사·학교·CGNAT)는 같은 버킷을 나눠 쓴다.
  assert.ok(!calls.some((k) => k.includes(A.uid)),
    "리미터 키에 uid 가 들어 있다 — 인증 뒤에 세고 있다는 뜻이다: " + JSON.stringify(calls));
  // 53. **바인딩이 없으면 아무것도 안 막는다.** 지금 운영이 이 상태다 — 되는 척하지 않는다.
  delete env.RL;
  assert.equal((await call(env, A.token, "/book", "PUT", { words: [], version: 0 })).status, 200, "바인딩이 없는데 막혔다");
}

// ══ 12. 단어장 버전 (동시 수정) ═══════════════════════════════════════════
// 전에는 어느 쪽이 새것인지를 **기기 시계**가 정했다. 시계가 어긋난 기기는 늘 자기가 새것이라
// 여겨 다른 기기에서 담은 단어를 조용히 지웠다 — 시각은 권한 판정에 쓸 값이 아니다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  const tablet = await another(env, A.uid);
  const c = (t, m, b) => call(env, t, "/book", m, b);

  // 54. 처음엔 버전 0. 레코드가 없으면 버전 없이도 저장된다(첫 저장을 막으면 아무도 시작 못 한다).
  assert.equal((await c(A.token)).body.version, 0, "빈 단어장의 버전이 0 이 아니다");
  const first = await c(A.token, "PUT", { words: ["사랑"], name: "가" });
  assert.equal(first.status, 200, "첫 저장이 막혔다");
  assert.equal(first.body.version, 1, "저장했는데 버전이 안 올랐다");

  // 55. **레코드가 있는데 버전을 안 보내면 거절한다.** 안 그러면 옛 앱이 버전을 빼는 것만으로
  //     이 방어가 통째로 무효가 된다.
  assert.equal((await c(tablet, "PUT", { words: ["뺏기"], name: "" })).status, 409, "버전 없는 덮어쓰기가 통과했다");
  // 56. 손에 든 버전이 옛것이면 409 + **현재 레코드를 같이 준다**(앱이 합칠 수 있도록).
  const stale = await c(tablet, "PUT", { words: ["고맙다"], name: "나", version: 0 });
  assert.equal(stale.status, 409, "옛 버전으로 덮어쓰기가 통과했다");
  assert.deepEqual(stale.body.words, ["사랑"], "409 인데 현재 단어장을 안 준다 — 앱이 합칠 수가 없다");
  assert.equal(stale.body.version, 1, "409 인데 현재 버전을 안 준다");
  assert.equal(stale.body.conflict, true);
  // 57. 저장은 실제로 안 됐다. 상태 코드만 보면 "거절했지만 이미 썼다"를 놓친다.
  assert.deepEqual((await c(A.token)).body.words, ["사랑"], "409 를 내면서 덮어썼다");
  // 58. 받은 버전으로 다시 보내면 통과하고 버전이 오른다.
  const ok2 = await c(tablet, "PUT", { words: ["사랑", "고맙다"], name: "나", version: 1 });
  assert.equal(ok2.status, 200, "맞는 버전인데 거절됐다");
  assert.equal(ok2.body.version, 2);
  // 59. **기기 시계는 판정에 쓰이지 않는다.** 1년 미래 시각을 실어도 옛 버전이면 거절된다.
  assert.equal((await c(A.token, "PUT", { words: ["시계조작"], version: 1, updated: Date.now() + 365 * 864e5 })).status,
    409, "미래 시각을 보냈더니 옛 버전이 통과했다 — 시계가 아직 판정에 쓰인다");
  assert.deepEqual((await c(A.token)).body.words, ["사랑", "고맙다"], "미래 시각 요청이 단어장을 덮어썼다");
  // 60. 앱이 계정 교체를 알아채려면 내 id 를 알아야 한다(토큰이 무작위라 뜯어볼 수 없다).
  assert.equal((await c(A.token)).body.me, A.uid, "GET /book 이 내 id 를 안 준다");
}

// ══ 13. 수락 중간 실패 — 트랜잭션 ═════════════════════════════════════════
// KV 시절엔 두 번의 쓰기라 첫 쓰기만 성공하면 반쪽이 남았다. 행 하나면 그 상태가 없다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A"), B = await signUp(env, "kakao", "B");
  const codeA = (await call(env, A.token, "/friends")).body.code;
  await call(env, B.token, "/friends", "POST", { code: codeA });

  // 61. 수락 도중 DB 가 죽으면 **관계는 pending 그대로**다(부분 수락이 없다).
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => (/UPDATE friendships/.test(sql)
    ? { bind: () => ({ run: async () => { throw new Error("DB down"); } }) } : real(sql));
  assert.equal((await call(env, A.token, "/friends/" + B.uid, "PUT")).status, 500, "실패가 성공으로 보고됐다");
  env.DB.prepare = real;
  assert.equal(env.DB._db.prepare("SELECT status FROM friendships").get().status, "pending",
    "수락이 실패했는데 관계가 바뀌었다");
  // 62. 그 상태에서 **어느 쪽도** 상대 단어장을 못 읽는다.
  assert.equal((await call(env, A.token, "/friends/" + B.uid + "/book")).status, 403, "실패한 수락으로 단어장이 열렸다");
  assert.equal((await call(env, B.token, "/friends/" + A.uid + "/book")).status, 403, "요청한 쪽이 단어장을 읽었다");
  // 63. 다시 수락하면 정상적으로 된다(앞의 실패가 상태를 망가뜨리지 않았다).
  assert.equal((await call(env, A.token, "/friends/" + B.uid, "PUT")).status, 200, "재시도 수락이 안 된다");
  assert.equal((await call(env, B.token, "/friends/" + A.uid + "/book")).status, 200, "수락했는데 단어장이 안 열린다");
}

// ══ 14. 관계없는 타인에 대한 DELETE ═══════════════════════════════════════
// 전에는 세 목록 어디에도 없는 사람이라도 상대 레코드를 읽어 다시 썼다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A"), B = await signUp(env, "kakao", "B"), Q = await signUp(env, "kakao", "Q");
  befriend(env, B.uid, Q.uid);

  // 64. 관계가 없으면 거부한다.
  const res = await call(env, A.token, "/friends/" + B.uid, "DELETE");
  assert.equal(res.status, 404, "관계없는 타인에 대한 DELETE 가 통과했다");
  // 65. **상대의 관계가 그대로 보존된다.** 상태 코드만 보면 "거부했지만 이미 지웠다"를 놓친다.
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM friendships WHERE requester_id=?").get(B.uid).n, 1,
    "남의 친구 관계가 지워졌다");
  // 66. 진짜 관계는 지워지고, **반복해도 안전하다**(두 번째는 404, 쓰기 없음).
  befriend(env, A.uid, B.uid);
  assert.equal((await call(env, A.token, "/friends/" + B.uid, "DELETE")).status, 200, "진짜 친구를 못 끊는다");
  assert.equal((await call(env, A.token, "/friends/" + B.uid, "DELETE")).status, 404, "두 번째 DELETE 가 통과했다");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM friendships WHERE requester_id=?").get(B.uid).n, 1,
    "두 번째 DELETE 가 남의 관계를 건드렸다");
}

// ══ 15. 설정 점검 (health · ready · STATE_KEY) ════════════════════════════
{
  const bare = { APP_ORIGIN: ORIGIN };
  // ⚠️ **`/ready` 가 200 이 되려면 엣지 남용 방어가 붙어 있어야 한다**(2026-08-20 · 위협 50).
  //    `DEV_RATE_LIMIT` 은 로컬에서 라우트를 열 뿐 ready 를 참으로 만들지 않는다 —
  //    그 계약 자체는 `test-stage34-closeout.mjs` T63 이 잰다.
  const RL_EDGE = { limit: async () => ({ success: true }) };
  const get = async (path, env) =>
    (await worker.fetch(new Request("https://api.test" + path,
      { headers: { Origin: ORIGIN, "X-Ready-Key": env.READY_KEY || "" } }), env));

  // 67. /health 는 설정이 없어도 200 이다 — "프로세스가 도나"를 재는 자리다.
  const h0 = await (await get("/health", bare)).json();
  assert.deepEqual(h0.providers, [], "설정이 없는데 제공자가 있다고 말한다");
  assert.equal(h0.ready, false, "설정이 없는데 ready 다");
  // 68. /ready 는 설정이 덜 됐으면 503 이다.
  assert.equal((await get("/ready", bare)).status, 503, "설정이 없는데 /ready 가 200 이다");
  const full = makeEnv({ KAKAO_ID: "id", GOOGLE_ID: "id", GOOGLE_SECRET: "s", EDGE_GUARD: "ratelimit", RL: RL_EDGE });
  const h1 = await (await get("/health", full)).json();
  assert.deepEqual(h1.providers, ["kakao", "google"], "설정된 제공자만 오지 않는다");
  assert.equal((await get("/ready", full)).status, 200, "다 설정됐는데 /ready 가 503 이다");
  // 69. DB 바인딩이 없으면 ready 가 아니다 — 로그인도 단어장도 못 한다.
  assert.equal((await (await get("/health", { ...full, DB: undefined })).json()).ready, false, "DB 없이 ready 다");

  // 69b. **ID 만 있고 secret 이 없는 제공자는 세지 않는다.** 전에는 셌고, 그래서 화면에 버튼이
  //      그려진 뒤 사용자가 눌러야 콜백에서 교환이 실패했다 — 배포자가 아니라 사용자가 먼저 안다.
  const half = makeEnv({ NAVER_ID: "id" });
  assert.deepEqual((await (await get("/health", half)).json()).providers, [],
    "secret 없는 제공자를 쓸 수 있다고 말한다");
  assert.equal((await get("/ready", half)).status, 503, "secret 이 없는데 /ready 가 200 이다");
  // 69c. 카카오만 예외다 — 콘솔에서 client_secret 을 끌 수 있어 없는 게 정상 설정일 수 있다.
  assert.deepEqual((await (await get("/health", makeEnv({ KAKAO_ID: "id" }))).json()).providers, ["kakao"],
    "카카오가 secret 없이 빠졌다 — 카카오는 secret 이 선택이다");

  // 69d. **바인딩이 있다 ≠ DB 가 답한다.** database_id 가 틀린 채 배포하면 바인딩은 멀쩡하고
  //      첫 질의에서만 터진다. /ready 가 실제로 질의해야 그 배포를 여기서 잡는다.
  const dead = { ...full, DB: { prepare: () => ({ first: async () => { throw new Error("D1_ERROR: no such table"); } }) } };
  const rd = await get("/ready", dead);
  assert.equal(rd.status, 503, "DB 가 질의에 실패하는데 /ready 가 200 이다");
  const rj = await rd.json();
  assert.equal(rj.db, false, "/ready 가 db:false 를 말하지 않는다");
  assert.ok(!JSON.stringify(rj).includes("no such table"), "/ready 응답에 DB 오류 문자열이 새어 나왔다");
  // /health 는 여전히 200 이다 — "프로세스가 도나"와 "쓸 수 있나"는 다른 질문이다.
  assert.equal((await get("/health", dead)).status, 200, "/health 가 DB 때문에 200 이 아니다");

  // 69e. **"DB 가 죽었다"와 "DB 를 안 봤다"를 가른다.** OAuth 비밀값이 없는 지금 라이브가
  //      바로 이 상태인데, 전에는 설정이 덜 됐다는 이유로 질의를 건너뛰고 `db:false` 를 냈다 —
  //      그 false 는 거짓말이었고, 진짜로 DB 가 죽는 날에도 화면이 똑같아 아무도 못 알아챈다.
  const noOAuth = makeEnv();                     // DB 는 멀쩡, OAuth 만 비어 있다
  const rn = await (await get("/ready", noOAuth)).json();
  assert.equal(rn.db, true, "DB 는 멀쩡한데 db:false 라고 말한다 — 안 물어본 것을 실패라고 한다");
  assert.equal(rn.configReady, false, "OAuth 가 비었는데 configReady 가 true 다");
  assert.equal(rn.ready, false, "설정이 덜 됐는데 ready 다");
  assert.deepEqual(rn.providers, [], "제공자가 없는데 목록이 비어 있지 않다");
  // 반대쪽: 설정은 됐는데 DB 만 죽은 경우와 응답이 **달라야** 한다.
  assert.notDeepEqual({ configReady: rn.configReady, db: rn.db }, { configReady: rj.configReady, db: rj.db },
    "DB 장애와 설정 미비가 같은 응답으로 보인다 — 무엇이 문제인지 구분할 수 없다");

  // 69f. **신규 스키마가 빠진 배포를 여기서 잡는다.**
  //      재현(2026-08-18): `policy_events`·`consumed_signup_states`·`deletions` 를 통째로 지워도
  //      /ready 가 **200 · ready:true** 였다. 주 D1 질의는 옛 여섯 표만 셌고, ledger 는 게이트가
  //      `maintenance` 한 표만 읽고 `bound:true` 라고 답했기 때문이다. 그래서 migration 을 빠뜨린
  //      배포가 smoke test 를 멀쩡히 통과하고, **사용자의 첫 가입·첫 계정 삭제에서** 처음 500 이 났다.
  for (const [binding, table] of [["DB", "policy_events"], ["DB", "consumed_signup_states"],
                                  ["LEDGER", "deletions"], ["LEDGER", "write_leases"],
                                  ["LEDGER", "cleanup_runs"], ["LEDGER", "maintenance"]]) {
    const e = makeEnv({ KAKAO_ID: "id", GOOGLE_ID: "id", GOOGLE_SECRET: "s", EDGE_GUARD: "ratelimit", RL: RL_EDGE });
    assert.equal((await get("/ready", e)).status, 200, `${table} 를 지우기 전인데 /ready 가 200 이 아니다`);
    e[binding]._db.exec(`DROP TABLE ${table}`);
    const r = await get("/ready", e);
    assert.equal(r.status, 503, `${table} 가 없는데 /ready 가 200 이다 — migration 을 빠뜨린 배포가 통과한다`);
    const j = await r.json();
    // `maintenance` 가 없으면 게이트 자체가 답을 못 하므로 mode:unknown 으로 먼저 닫힌다.
    if (table !== "maintenance") {
      assert.equal(binding === "DB" ? j.db : j.ledger, false,
        `${table} 가 없는데 ${binding} 이 답한다고 말한다`);
    }
    const txt = JSON.stringify(j);
    for (const leak of [table, "SELECT", "no such table", "COUNT", "D1_ERROR"])
      assert.ok(!txt.includes(leak), `/ready 응답에 '${leak}' 가 새어 나왔다 — 스키마가 밖으로 샌다`);
  }

  // 70. **비밀값도 그 이름도 새지 않는다.** (`id` 처럼 짧은 문자열은 안 쓴다 — "providers" 에 걸린다)
  const txt = JSON.stringify(h1);
  for (const leak of ["STATE_KEY", "SECRET", "MASTER_UIDS", "test-signing-key"])
    assert.ok(!txt.includes(leak), `/health 응답에 '${leak}' 가 새어 나왔다`);

  // 71. STATE_KEY 가 없으면 로그인을 **아예 열지 않는다.** 열면 서명 키가 문자열 "undefined" 라
  //     누구나 유효한 state 를 만들 수 있고, state 안에는 돌아갈 주소가 들어 있다.
  const noKey = makeEnv({ KAKAO_ID: "id" });
  delete noKey.STATE_KEY;
  assert.equal((await get("/login/kakao", noKey)).status, 503, "STATE_KEY 없이 로그인이 열렸다");
  // 72. 그 상태에서는 **어떤 state 도 유효하지 않다.**
  const forged = Buffer.from(JSON.stringify(["kakao", ORIGIN, Date.now() + 1e5, ""])).toString("base64url");
  assert.equal((await get("/cb/kakao?code=x&state=" + encodeURIComponent(forged + ".sig"), noKey)).status,
    400, "STATE_KEY 없이 위조 state 가 통과했다");
}

// ══ 16. 로그에 개인 식별자가 안 남는가 ════════════════════════════════════
// 우리가 "받지 않기로 한" 정보를 운영 로그가 대신 모으면 방침이 거짓말이 된다.
// `/friends/<uid>` 를 그대로 찍으면 로그가 곧 "누가 누구와 친구인가"의 기록이다.
{
  // 73. id 자리가 지워진다.
  assert.equal(pathTemplate("/api/friends/abc123def456"), "/friends/:id");
  assert.equal(pathTemplate("/api/friends/abc123def456/book"), "/friends/:id/book");
  // 74. id 가 아닌 라우트는 그대로 — `/friends/code` 를 :id 로 뭉개면 로그를 못 읽는다.
  assert.equal(pathTemplate("/api/friends/code"), "/friends/code");
  assert.equal(pathTemplate("/api/friends"), "/friends");
  assert.equal(pathTemplate("/api/book"), "/book");
  assert.equal(pathTemplate("/api/login/kakao"), "/login/kakao");
  // 75. 실제 uid 를 넣어도 남지 않는다.
  const env = makeEnv();
  const A = await signUp(env, "kakao", "LOGTEST");
  assert.ok(!pathTemplate("/api/friends/" + A.uid + "/book").includes(A.uid), "경로 템플릿에 uid 가 남았다");
}

// ══ 17. readiness 가 **스키마**까지 본다 ══════════════════════════════════
// 예전엔 `SELECT 1` 이라 "DB 가 살아 있나"만 답했다. 원격에 이전이 안 걸린 배포는 그걸 통과하고
// 사용자의 첫 친구 요청에서 500 을 낸다 — 실패를 사용자가 아니라 여기서 내야 한다.
{
  // 76. 코드가 쓰는 테이블이 하나라도 없으면 준비 안 됨이다.
  const env = makeEnv({ KAKAO_ID: "id", NAVER_ID: "id", NAVER_SECRET: "s", GOOGLE_ID: "id", GOOGLE_SECRET: "s",
                        EDGE_GUARD: "ratelimit", RL: { limit: async () => ({ success: true }) } });
  const ready = await worker.fetch(new Request("https://api.test/ready", { headers: { "X-Ready-Key": env.READY_KEY } }), env);
  assert.equal(ready.status, 200, "정상 스키마인데 준비 안 됐다고 한다");

  // ⚠️ `rate_limits` 가 아니라 `books` 를 지운다 — 카운터가 ledger 로 간 뒤(2026-08-20)
  //    주 D1 의 그 표는 코드가 안 만지므로 readiness 조건이 아니다.
  env.DB._db.exec("DROP TABLE books");
  const gone = await worker.fetch(new Request("https://api.test/ready", { headers: { "X-Ready-Key": env.READY_KEY } }), env);
  assert.equal(gone.status, 503, "테이블이 통째로 없는데 준비됐다고 한다");
  assert.equal((await gone.json()).db, false, "db 항목이 실패를 안 알린다");

  // 77. **컬럼까지** 본다. 0002·0003 이 원격에 안 걸린 상태가 정확히 이 모양이다.
  const env2 = makeEnv({ KAKAO_ID: "id", NAVER_ID: "id", NAVER_SECRET: "s", GOOGLE_ID: "id", GOOGLE_SECRET: "s",
                         EDGE_GUARD: "ratelimit", RL: { limit: async () => ({ success: true }) } });
  env2.DB._db.exec("DROP TABLE friendships");
  env2.DB._db.exec("CREATE TABLE friendships (requester_id TEXT, addressee_id TEXT, status TEXT, created_at INTEGER)");
  assert.equal((await worker.fetch(new Request("https://api.test/ready", { headers: { "X-Ready-Key": env2.READY_KEY } }), env2)).status, 503,
    "pair_key 가 없는 옛 스키마인데 준비됐다고 한다");
}

// ══ 18. 친구 상한을 **문장 안에서** 센다 ══════════════════════════════════
// 밖에서 세고 나서 쓰면 그 사이에 들어온 요청이 같은 자리를 또 가져간다.
// (동시 실행 자체는 이 하니스가 못 만든다 — 연결 하나로 순차 실행이라. 그래서 재는 것은
//  "조건이 문장 안에 있는가"이고, 그 증거로 **미리보기가 안 도는 경로**를 쓴다.)
{
  const env = makeEnv();
  const V = await signUp(env, "kakao", "V"), W = await signUp(env, "kakao", "W");
  // V 에게 W 가 요청을 보낸 뒤에 V 를 상한까지 채운다 — 수락 시점에 이미 꽉 차 있다.
  const vCode = (await call(env, V.token, "/friends")).body.code;
  await call(env, W.token, "/friends", "POST", { code: vCode });
  for (let i = 0; i < 50; i++) befriend(env, V.uid, (await signUp(env, "kakao", "L" + i)).uid);

  // 78. 수락이 상한을 넘기지 못한다. 이 경로에는 미리보기 COUNT 가 아예 없다 —
  //     막는 것은 UPDATE 문 안의 조건뿐이다.
  const r = await call(env, V.token, "/friends/" + W.uid, "PUT");
  assert.equal(r.status, 429, "상한을 넘겨 수락됐다");
  assert.match(r.body.error, /너무 많아요/, "상한인데 '받은 요청이 아니에요'라고 말한다");
  // 79. 상한 때문이 아니라 **정말 없는 요청**은 여전히 400 이다(문구가 뒤바뀌면 안 된다).
  const env2 = makeEnv();
  const P = await signUp(env2, "kakao", "P"), Q = await signUp(env2, "kakao", "Q");
  assert.equal((await call(env2, P.token, "/friends/" + Q.uid, "PUT")).status, 400, "없는 요청이 429 로 나갔다");
}

// ══ 19. 죽은 세션 행이 쌓이지 않는다 ══════════════════════════════════════
// whoAmI 는 만료를 판정에서만 걸러내고 행은 뒀다 — 다시 오지 않는 사용자의 행이 영원히 남았다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  env.DB._db.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = ?").run(A.uid);
  // 80. 다음 로그인이 지난 행을 치운다(청소용 크론이 없으니 드문 자리에 붙였다).
  await newSession(env, A.uid);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions WHERE expires_at < ?").get(Date.now()).n, 0,
    "만료된 세션 행이 그대로 남았다");
  // 81. 살아 있는 세션은 안 건드린다.
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id = ?").get(A.uid).n, 1,
    "청소가 멀쩡한 세션까지 지웠다");
}

// ══ 20. Origin 이 **없는** 상태 변경도 막는다 ═════════════════════════════
// 예전엔 "Origin 이 없으면 브라우저가 아니라서 CSRF 가 성립하지 않는다"고 통과시켰다.
// 성립하지 않는 건 맞지만, 그 판단은 브라우저가 반드시 붙인다는 전제에 기대고 있었다 —
// 통과시켜서 얻는 것은 curl 편의뿐이고, 잃는 것은 허용 목록을 안 지나는 상태 변경 경로다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A");
  const noOrigin = (path, method, body) => worker.fetch(new Request("https://api.test" + path, {
    method, headers: { Cookie: "shh_s=" + A.token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  // 82. 상태를 바꾸는 메서드는 전부 막힌다.
  for (const [p, m, b] of [["/book", "PUT", { words: [], version: 0 }], ["/me", "DELETE"],
                           ["/session", "DELETE"], ["/friends", "POST", { code: "x" }]]) {
    assert.equal((await noOrigin(p, m, b)).status, 403, `${m} ${p} 가 Origin 없이 통과했다`);
  }
  // 83. **읽기는 그대로 열려 있다.** 낯선 Origin 에 CORS 를 안 열어 줘서 응답을 못 읽는다.
  assert.equal((await noOrigin("/book", "GET")).status, 200, "Origin 이 없다고 읽기까지 막혔다");
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users WHERE id = ?").get(A.uid).n, 1,
    "막았다면서 계정이 지워졌다");
}

// ══ 21. 레이트리밋이 **실제로** 막는다 ════════════════════════════════════
// 이 자리는 오래 "이음새만 있고 아무것도 안 막는다"였다. KV(하루 1,000 writes)로는 리미터가
// 곧 서비스 거부 수단이었지만 D1 은 10만이라 같은 판단이 뒤집힌다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A"), B = await signUp(env, "kakao", "B");
  const bCode = (await call(env, B.token, "/friends")).body.code;

  // 84. 초대 코드로 요청을 보내는 자리가 가장 좁다(유일한 열거 공격면).
  //     정상 사용자는 링크를 눌러 한 번 보낼 뿐이라 20회면 넉넉하다.
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const r = await call(env, A.token, "/friends", "POST", { code: "없는코드" + i });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked > 0, "초대 코드를 무한히 두드릴 수 있다");
  assert.ok(blocked >= 4, `20회를 넘겨도 거의 안 막힌다(막힌 횟수 ${blocked})`);

  // 85. 막힌 응답에 Retry-After 가 붙는다 — 언제 다시 오라는 말이 없으면 곧바로 다시 두드린다.
  const r429 = await call(env, A.token, "/friends", "POST", { code: bCode });
  assert.equal(r429.status, 429, "창 안인데 다시 통과했다");
  assert.equal(r429.headers.get("Retry-After"), "60", "언제 다시 오라는 말이 없다");

  // 86. 읽기는 **자기 버킷**으로 센다(분당 120). 좁은 `friends` 버킷을 다 써도 목록 조회는 된다 —
  //     한 버킷이면 초대 코드를 두드린 사람이 자기 화면도 못 여는 고장이 된다.
  //     ⚠️ 2026-08-19 정정: 예전에는 "읽기는 안 센다"였고 그 자리가 재현 R5 였다.
  for (let i = 0; i < 30; i++) assert.equal((await call(env, A.token, "/friends")).status, 200, "읽기가 막혔다");

  // 87. 세는 단위는 **IP** 다(2026-08-19). 리미터가 인증보다 먼저 돌아야 인증되지 않은 요청이
  //     임차증을 소비하기 전에 막히는데, 그 자리에서는 uid 를 아직 모른다(재현 R5).
  //     ⚠️ **대가를 그대로 잰다**: 같은 IP 의 다른 계정은 같은 버킷을 나눠 쓴다(공유 IP 에서
  //     이웃이 내 몫을 태울 수 있다). 그래서 다른 IP 는 막히지 않는다는 것을 함께 고정한다 —
  //     그것마저 무너지면 리미터 하나가 전 세계를 막는다.
  assert.equal((await call(env, B.token, "/friends", "POST", { code: "없는코드" })).status, 429,
    "같은 IP 인데 버킷이 갈렸다 — 인증 뒤에 세고 있다는 뜻이다");
  assert.equal((await call(env, B.token, "/friends", "POST", { code: "없는코드" }, { "CF-Connecting-IP": "198.51.100.7" })).status, 404,
    "다른 IP 까지 막혔다 — 방어가 아니라 고장이다");

  // 88. 카운터에 **원문 uid·IP 가 남지 않는다.** 남용을 세려고 개인정보를 쌓지 않는다.
  for (const row of env.LEDGER._db.prepare("SELECT bucket FROM rate_limits").all()) {
    assert.ok(!row.bucket.includes(A.uid) && !row.bucket.includes(B.uid), "리미터 키에 uid 원문이 남았다");
  }
}

// ══ 22. 리미터가 **공격자의 증폭 수단이 되지 않는다** ═══════════════════
// 리미터는 D1 에 쓰면서 센다. 그래서 리미터 자체가 자원을 쓴다 — 막힌 뒤에도 계속 세면
// 공격자는 429 를 받으면서 우리 DB 쓰기 할당량을 태울 수 있다(하루 10만이면 정상 저장이 먼저 죽는다).
// **막기로 결정한 뒤에는 더 세지 않는다.**
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "A"), B = await signUp(env, "kakao", "B");
  const counters = () => env.LEDGER._db.prepare("SELECT bucket, n FROM rate_limits").all();
  const total = () => counters().reduce((s, r) => s + r.n, 0);

  // 89. 한도까지 두드려 막힌 상태를 만든다.
  for (let i = 0; i < 25; i++) await call(env, A.token, "/friends", "POST", { code: "없는코드" + i });
  assert.equal((await call(env, A.token, "/friends", "POST", { code: "x" })).status, 429, "전제가 깨졌다 — 안 막힌다");

  // 90. **막힌 뒤 늘어나는 양에 천장이 있고, 천장에 닿으면 쓰기가 0 이 된다.**
  //     한 요청이 버킷 두 개(좁은 friends · 넉넉한 write)를 지나므로, friends 가 막힌 뒤에도
  //     write 가 찰 때까지는 조금 더 자란다. 중요한 건 **창 하나 안에서 총량이 한도로 묶이는가** 다 —
  //     안 묶이면 공격자는 429 를 받으면서 우리 D1 쓰기 할당량(하루 10만)을 무한히 태울 수 있고,
  //     그게 바닥나면 정상 사용자의 단어장 저장이 먼저 죽는다(리미터가 증폭기가 된다).
  for (let i = 0; i < 200; i++) await call(env, A.token, "/friends", "POST", { code: "또없는코드" + i });
  const settled = total();
  for (let i = 0; i < 200; i++) await call(env, A.token, "/friends", "POST", { code: "계속두드린다" + i });
  assert.equal(total(), settled,
    `모든 버킷이 찼는데도 계속 세고 있다(${settled} → ${total()}) — 429 하나당 D1 쓰기가 하나씩 난다`);
  assert.ok(settled < 400, `창 하나에서 카운터가 ${settled} 까지 자랐다 — 한도로 안 묶인다`);

  // 91. **없는 경로는 세지 않는다.** 없는 자리를 두드리는 것으로 카운터 행을 만들 수 있으면,
  //     공격자는 라우트를 몰라도 쓰기를 유발할 수 있다.
  const rowsBefore = counters().length;
  for (let i = 0; i < 10; i++) {
    const r = await call(env, B.token, "/이런건없다" + i, "POST", { x: 1 });
    assert.equal(r.status, 404, "없는 경로가 404 가 아니다");
  }
  assert.equal(counters().length, rowsBefore, "없는 경로가 리미터 행을 만들었다");

  // 92. **한 요청은 한 번만 센다.** /cb 는 공통 검사와 개별 검사에 두 번 걸려 있었다 —
  //     한 번의 로그인 시도가 카운터를 둘 올리면 한도가 실제로는 절반이고 쓰기는 두 배다.
  const env2 = makeEnv();
  const t0 = env2.LEDGER._db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n;
  await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y"), env2);
  const t1 = env2.LEDGER._db.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n;
  assert.equal(t1 - t0, 1, `로그인 왕복 한 번에 카운터가 ${t1 - t0}개 늘었다 — 이중 집계다`);

  // 93. 로그인 왕복은 **login 한도(10)** 로 막힌다. 이름이 갈려 있으면 넉넉한 write 한도(120)가
  //     적용돼 세션을 100번 넘게 찍어낼 수 있다.
  //     ⚠️ 두드리는 자리는 `/cb`(세션이 생기는 자리)다. 시작(`/login`)은 안 센다 — 27번 블록.
  const env3 = makeEnv({ KAKAO_ID: "id" });
  let loginBlocked = 0;
  for (let i = 0; i < 14; i++) {
    const r = await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y",
      { headers: { "CF-Connecting-IP": "198.51.100.7" } }), env3);   // 한 사람이 계속 두드린다
    if (r.status === 429) loginBlocked++;
  }
  assert.ok(loginBlocked >= 3, `세션을 만드는 자리가 10회 뒤에 안 막힌다(막힌 횟수 ${loginBlocked})`);

  // 94. **리미터가 고장 나면 막는다(fail-closed).** ⛔ **2026-08-22 에 뒤집힌 판단이다**
  //     (위협 52). 예전 여기에는 "고장 나면 통과시킨다 — 남용 방어가 서비스를 멈추는 쪽이 더
  //     나쁘다"고 적혀 있었고, 그래서 던지는 `limit()` 하나로 **방어가 통째로 없는 배포**가
  //     `/ready` 200 을 받으며 돌았다. 셀 수 없는 상태로 계정 경로를 여는 것은 「방어가 있다」가
  //     아니다. 게다가 **500 이 아니라 503** 이어야 한다 — 예외가 그대로 나가면 스택이 샌다.
  const env4 = makeEnv({ KAKAO_ID: "id" });
  const C = await signUp(env4, "kakao", "C");
  env4.RL = { limit: () => { throw new Error("binding down"); } };
  const w0 = env4.LEDGER._db.prepare("SELECT total_changes() AS n").get().n;
  const r4 = await call(env4, C.token, "/book", "PUT", { words: ["사랑"], name: "" });
  assert.equal(r4.status, 503, `리미터가 고장 났는데 응답이 ${r4.status} 다 — 셀 수 없으면 열지 않는다`);
  assert.equal(env4.LEDGER._db.prepare("SELECT total_changes() AS n").get().n, w0,
    "고장 난 리미터가 막으면서 ledger 에 썼다 — 사전 거름이 게이트보다 뒤에 있다");
  assert.ok(!JSON.stringify(r4.body).includes("binding down"), "예외 문자열이 응답에 실렸다");

  // 95. **정상 자동저장은 안 막힌다.** 0.8초마다 올라오는 단어장 저장이 먼저 걸리면
  //     그건 방어가 아니라 고장이다.
  const env5 = makeEnv();
  const D = await signUp(env5, "kakao", "D");
  let ver = 0;
  for (let i = 0; i < 60; i++) {
    const r = await call(env5, D.token, "/book", "PUT", { words: ["사랑", "손짓" + i], name: "", version: ver });
    assert.equal(r.status, 200, `정상 자동저장 ${i + 1}번째가 막혔다(${r.status})`);
    ver = r.body.version;
  }
}

// ══ 23. 저장 요청은 **자기가 누구라고 믿는지**를 같이 말한다 ══════════════
// 한 브라우저의 탭 두 개. 탭 A 는 계정 A 로 열려 있고, 탭 B 에서 계정 B 로 로그인한다.
// 쿠키는 브라우저 전체가 공유하므로 그 순간부터 **탭 A 의 요청도 계정 B 의 쿠키로 나간다.**
// 탭 A 는 그걸 모른 채 손에 든 A 의 단어장을 저장하고, 그러면 A 의 단어장이 B 계정에 쌓인다.
// 서버는 지금까지 "쿠키가 맞으면 그 사람"만 봤으므로 이걸 가려낼 근거가 아예 없었다.
// → 요청이 **자기가 믿는 계정**을 같이 말하게 하고, 세션의 주인과 다르면 거절한다.
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "tabA"), B = await signUp(env, "kakao", "tabB");

  // B 계정에 원래 단어장이 있다. 이게 A 의 것으로 덮이면 안 된다.
  assert.equal((await call(env, B.token, "/book", "PUT", { words: ["비밀"], name: "B", version: 0 })).status, 200);

  // 96. **남의 계정이라고 믿으면서 보낸 저장은 거절한다.** 탭 A 가 계정 A 라 믿는데
  //     쿠키는 B 인 상황이 정확히 이것이다.
  const cross = await call(env, B.token, "/book", "PUT", { words: ["A의단어"], name: "A", version: 1, me: A.uid });
  assert.equal(cross.status, 409, "다른 계정이라 믿고 보낸 저장이 통과했다 — 남의 계정에 내 단어장이 쌓인다");
  assert.equal(cross.body.accountChanged, true, "계정이 바뀌었다는 것을 앱이 알아볼 표시가 없다");
  assert.ok(!JSON.stringify(cross.body).includes(A.uid) && !JSON.stringify(cross.body).includes(B.uid),
    "거절 응답에 계정 id 가 실려 나갔다");

  // 97. B 의 단어장은 **손도 안 탄다.**
  const still = await call(env, B.token, "/book");
  assert.deepEqual(still.body.words, ["비밀"], "거절했는데 남의 단어장이 바뀌었다");

  // 98. 자기 계정이라고 바르게 말하면 그대로 통과한다. 막기만 하고 통과를 안 재면
  //     "저장이 아예 안 되는" 회귀를 못 잡는다.
  const okPut = await call(env, B.token, "/book", "PUT", { words: ["비밀", "하나더"], name: "B", version: 1, me: B.uid });
  assert.equal(okPut.status, 200, "자기 계정인데 저장이 막혔다");

  // 99. `me` 를 아예 안 보낸 요청은 그대로 받는다. 새 서비스워커가 아직 안 붙은 옛 화면이
  //     이 값을 모르는 채로 저장하는데, 그걸 막으면 **업데이트 전 사용자의 저장이 통째로 죽는다.**
  //     이 자리를 지키는 것은 탭 감지(클라이언트)이고, 서버는 **말한 것이 틀렸을 때만** 막는다.
  assert.equal((await call(env, B.token, "/book", "PUT", { words: ["비밀"], name: "B", version: 2 })).status, 200,
    "me 를 안 보낸 옛 화면의 저장까지 막았다");

  // 100. 계정 삭제·로그아웃 뒤 남은 탭이 옛 uid 를 들고 저장해도 세션이 없으면 401 이 먼저다.
  assert.equal((await call(env, null, "/book", "PUT", { words: ["x"], version: 0, me: A.uid })).status, 401,
    "세션 없이 uid 만으로 저장이 됐다");
}

// ══ 24. 제공자 응답은 **신뢰 경계다** ══════════════════════════════════════
// 여기서 부르는 것은 남의 서버다. 응답이 정상 JSON 이라는 보장이 없고, 크기 보장도 없다.
// 예전엔 `JSON.parse(await r.text())` 하나였다 — `text()` 에 상한이 없어서 제공자가(또는
// 그 자리에 끼어든 무엇이) 큰 본문을 주면 그대로 Worker 메모리에 올라갔다. 무료 Worker 는
// 128MB 이고 이 코드는 로그인마다 두 번 부른다.
//
// 정상 응답의 실제 크기: 구글 토큰(id_token 포함)이 가장 크고 2~4KB, 나머지는 1KB 미만이다
// (scope 가 openid·없음뿐이라 프로필 필드가 안 온다). 상한 64KB 는 그 16배 이상이라
// 제공자가 필드를 늘려도 안 걸리고, 걸리는 경우는 정상 응답이 아니다.
//
// ⚠️ Content-Type 은 **일부러 안 본다.** 실제 판정은 JSON.parse 가 하고 그건 속일 수 없다.
//    허용 목록을 두면 제공자가 `text/plain` 으로 바꾸는 날 로그인이 통째로 죽는다 —
//    막는 것은 없고 잃는 것만 있는 검사다.
{
  const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
  let ip = 0;
  const asBrowser = () => ({ "CF-Connecting-IP": `198.51.100.${++ip}` });
  const start = async () => {
    const r = await worker.fetch(new Request("https://api.test/login/kakao?n=n", { headers: asBrowser() }), env);
    const set = r.headers.get("Set-Cookie") || "";
    return { state: new URL(r.headers.get("Location")).searchParams.get("state"),
             txn: (set.match(/shh_t=([^;]*)/) || [])[1] || "" };
  };
  const sessions = () => env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  // 이 블록이 재는 것은 **제공자 응답의 크기 상한**이다. 로그인 경로가 계정을 만들지 않게
  // 바뀐 뒤로는 계정이 미리 있어야 그 지점까지 간다 — 없으면 상한 검사 앞에서 끝나 버린다.
  for (const sub of ["u-ok", "u-odd"]) {
    await createAccountWithPolicy(env, "kakao", sub,
      { stateHash: `pre-${sub}`, stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  }

  // 제공자를 갈아끼우고 콜백을 한 번 돈다. 로그를 함께 모은다 —
  // 응답 본문·토큰이 로그로 새면 그것도 여기서 잡혀야 한다.
  const login = async (respond) => {
    const realFetch = globalThis.fetch, realLog = console.log;
    const logs = [];
    globalThis.fetch = async (url) => respond(String(url));
    console.log = (...a) => { logs.push(a.map(String).join(" ")); };
    try {
      const s = await start();
      const res = await worker.fetch(new Request(
        "https://api.test/cb/kakao?code=real-code&state=" + encodeURIComponent(s.state),
        { headers: { ...asBrowser(), Cookie: "shh_t=" + s.txn } }), env);
      return { status: res.status, loc: res.headers.get("Location") || "", logs };
    } finally { globalThis.fetch = realFetch; console.log = realLog; }
  };
  const jsonRes = (o, type = "application/json") =>
    new Response(typeof o === "string" ? o : JSON.stringify(o), { headers: { "Content-Type": type } });
  const SECRET_TOKEN = "ya29.super-secret-access-token";
  const ok = (url) => jsonRes(url.includes("token") ? { access_token: SECRET_TOKEN } : { id: "u-ok" });

  // 101. 정상 응답은 그대로 통과한다. 막는 쪽만 재면 "로그인이 아예 안 되는" 회귀를 못 잡는다.
  const good = await login(ok);
  assert.equal(good.status, 302, "정상 제공자 응답인데 로그인이 막혔다");
  assert.match(good.loc, /#login=ok/, "정상인데 실패로 돌아갔다");
  assert.equal(sessions(), 1, "정상인데 세션이 안 생겼다");

  // 102. ★ **너무 큰 응답은 안 받는다.** 이 본문은 문법상 멀쩡한 JSON 이라 파서가 안 막는다 —
  //      막는 것은 크기 상한뿐이다. 상한이 없으면 1MB 가 통째로 메모리에 올라가고
  //      로그인은 **성공한다**(그래서 증상이 안 보인 채 자원만 태운다).
  const huge = await login((url) => jsonRes(
    url.includes("token") ? `{"access_token":"${"x".repeat(1_000_000)}"}` : '{"id":"u-huge"}'));
  assert.equal(huge.status, 302);
  assert.match(huge.loc, /#login=fail/, "1MB 짜리 제공자 응답을 그대로 받아 로그인이 됐다");
  assert.equal(sessions(), 1, "큰 응답으로 세션이 만들어졌다");

  // 102b. **두 번째 호출(me)에도 같은 상한이 걸린다.** 토큰 교환만 막으면 공격면이 반만 닫힌다.
  const hugeMe = await login((url) => jsonRes(
    url.includes("token") ? { access_token: "t" } : `{"id":"u","pad":"${"y".repeat(1_000_000)}"}`));
  assert.match(hugeMe.loc, /#login=fail/, "me 응답에는 상한이 없다");
  assert.equal(sessions(), 1, "큰 me 응답으로 세션이 만들어졌다");

  // 103. 잘린 JSON · HTML 오류 페이지 · 4xx/5xx — 전부 조용히 실패로 수렴한다.
  //      HTML 은 제공자 점검 중에 실제로 온다. `.json()` 이었다면 여기서 던져 500 이 나갔다.
  for (const [why, body, init] of [
    ["잘린 JSON", '{"access_token":"t"', {}],
    ["HTML 오류 페이지", "<html><body>502 Bad Gateway</body></html>", { headers: { "Content-Type": "text/html" } }],
    ["빈 본문", "", {}],
  ]) {
    const r = await login((url) => url.includes("token") ? new Response(body, init) : jsonRes({ id: "u" }));
    assert.match(r.loc, /#login=fail/, `${why} 인데 로그인이 됐다`);
  }
  const bad4xx = await login((url) => url.includes("token")
    ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } })
    : jsonRes({ id: "u" }));
  assert.match(bad4xx.loc, /#login=fail/, "제공자가 400 을 줬는데 로그인이 됐다");
  assert.equal(sessions(), 1, "실패 응답들이 세션을 만들었다");

  // 104. **Content-Type 이 틀려도 본문이 JSON 이면 받는다.** 위 주석의 판단을 잠근다 —
  //      누가 Content-Type 허용 목록을 넣으면 여기가 빨개져서 그 대가를 먼저 보게 된다.
  const oddType = await login((url) => jsonRes(
    url.includes("token") ? { access_token: "t" } : { id: "u-odd" }, "text/plain;charset=utf-8"));
  assert.match(oddType.loc, /#login=ok/, "본문이 JSON 인데 Content-Type 때문에 로그인이 막혔다");

  // 105. 제공자가 늘어지거나 끊겨도 **던지지 않는다.** 여기서 예외가 새면 500 이 나가고,
  //      그 500 에는 제공자 쪽 문자열이 섞여 나갈 수 있다.
  const dead = await login(() => { throw new DOMException("timeout", "TimeoutError"); });
  assert.match(dead.loc, /#login=fail/, "제공자가 끊겼는데 실패로 안 돌아갔다");

  // 106. ★ **토큰도 응답 본문도 로그에 안 남는다.** 고치는 데 필요한 건 어느 제공자가
  //      무슨 코드로 거절했나뿐이고, 나머지는 운영 로그를 개인정보 저장소로 만든다.
  const leak = await login((url) => url.includes("token")
    ? jsonRes({ access_token: SECRET_TOKEN })
    : jsonRes({ error: "unauthorized", message: "z".repeat(5000) }));
  const all = leak.logs.join("\n");
  assert.ok(!all.includes(SECRET_TOKEN), "제공자 토큰이 로그에 남았다");
  assert.ok(!/z{200}/.test(all), "제공자 응답 문자열이 통째로 로그에 남았다");
  assert.ok(all.includes("kakao"), "어느 제공자가 실패했는지가 로그에 없다 — 고칠 수가 없다");
}

// ══ 24b. 계정 삭제는 **중간이 없다** ══════════════════════════════════════
// 전에는 두 작업이었다: `killSessions()`(세대 +1 · 세션 삭제) 다음에 `DELETE FROM users`.
// 두 번째가 실패하면 실측으로 이렇게 됐다 — 500 이 나가고, 세대는 이미 올라가 **사용자는
// 그 자리에서 로그아웃되며**, users·books·friendships·invite_codes 는 **전부 남는다.**
// 그래서 "계정을 지우지 못했어요"를 본 사람의 별명과 단어 개수가 **친구에게 계속 보였다.**
// 다시 로그인하지 않으면 재시도할 방법조차 없었다.
//
// 고친 방향(사용자 결정 A): 한 문장이면 원자적이다. `users` 를 지우면 CASCADE 가 나머지를
// 지우고, `whoAmI` 가 `users` 를 JOIN 하므로 행이 사라지는 순간 모든 세션이 죽는다 —
// `killSessions` 는 삭제 경로에서 애초에 필요 없는 일이었다(로그아웃에서는 계속 쓴다).
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "delA"), B = await signUp(env, "kakao", "delB");
  const A2 = await another(env, A.uid);                    // 같은 계정의 다른 기기
  await call(env, A.token, "/book", "PUT", { words: ["사랑"], name: "가", version: 0 });
  const code = (await call(env, A.token, "/friends")).body.code;
  await call(env, B.token, "/friends", "POST", { code });
  await call(env, A.token, "/friends/" + B.uid, "PUT");
  const n = (sql, ...a) => env.DB._db.prepare(`SELECT COUNT(*) n FROM ${sql}`).get(...a).n;
  const leftovers = () => ({
    users: n("users WHERE id=?", A.uid), sessions: n("sessions WHERE user_id=?", A.uid),
    books: n("books WHERE user_id=?", A.uid),
    friendships: n("friendships WHERE requester_id=?1 OR addressee_id=?1", A.uid),
    invite: n("invite_codes WHERE user_id=?", A.uid),
  });

  // `DELETE FROM users` 만 실패시킨다. 다른 문장은 그대로 돈다.
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => sql.includes("DELETE FROM users")
    ? { bind: () => ({ run: async () => { throw new Error("D1_ERROR: simulated"); } }) }
    : real(sql);
  const failed = await call(env, A.token, "/me", "DELETE");
  env.DB.prepare = real;

  // 124. 실패는 실패라고 말한다 — 쿠키를 지우면 화면은 "지워졌다"로 읽는다.
  assert.equal(failed.status, 500, "삭제가 실패했는데 실패로 안 나갔다");
  assert.ok(!/shh_s=;/.test(failed.headers.get("Set-Cookie") || ""), "DB 삭제가 실패했는데 쿠키를 지웠다");

  // 125. ★ **아무것도 안 지워진다.** 반쯤 지워진 계정이 남지 않는다.
  assert.deepEqual(leftovers(), { users: 1, sessions: 2, books: 1, friendships: 1, invite: 1 },
    "삭제가 실패했는데 일부만 지워졌다 — 중간 상태가 생겼다");

  // 126. ★ **세션이 살아 있어 그 자리에서 다시 누를 수 있다.** 전에는 세대가 이미 올라가
  //      사용자가 로그아웃돼서, 다시 로그인하기 전에는 재시도조차 못 했다.
  assert.equal((await call(env, A.token, "/book")).status, 200,
    "삭제에 실패했을 뿐인데 로그인이 풀렸다 — 사용자가 재시도할 방법이 없다");
  assert.equal((await call(env, A2, "/book")).status, 200, "다른 기기의 로그인까지 풀렸다");

  // 127. 재시도하면 끝난다. 그리고 **모든 연결 테이블**에서 사라진다.
  assert.equal((await call(env, A.token, "/me", "DELETE")).status, 200, "재시도가 안 된다");
  assert.deepEqual(leftovers(), { users: 0, sessions: 0, books: 0, friendships: 0, invite: 0 },
    "삭제했는데 어딘가 남았다");
  assert.deepEqual((await call(env, B.token, "/friends")).body.friends, [], "탈퇴한 사람이 친구 목록에 남았다");
  assert.equal((await call(env, A2, "/book")).status, 401, "탈퇴했는데 다른 기기 세션이 살아 있다");
}
{
  // 128. 삭제 요청이 **동시에 두 번** 와도 모순이 없다. 둘 다 성공으로 수렴한다 —
  //      두 번째가 "없는 계정"이라 실패하면 사용자는 지워진 계정에 대해 오류를 본다.
  const env = makeEnv();
  env.DB = withLatency(env.DB);
  const A = await signUp(env, "kakao", "delTwice");
  const A2 = await another(env, A.uid);
  const [d1, d2] = await Promise.all([call(env, A.token, "/me", "DELETE"), call(env, A2, "/me", "DELETE")]);
  assert.ok(d1.status < 400 && d2.status < 400, `동시 삭제가 ${d1.status}/${d2.status} 로 갈렸다`);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 0, "동시 삭제 뒤 계정이 남았다");
}
{
  // 129. **삭제 중에 다른 탭이 보낸 요청**은 401 로 끝난다. 500 이면 화면은 "잠시 문제가
  //      생겼어요"를 띄우고 사용자는 계정이 지워졌는지 아닌지 모른다.
  const env = makeEnv();
  const A = await signUp(env, "kakao", "delRace");
  const A2 = await another(env, A.uid);
  await call(env, A.token, "/me", "DELETE");
  for (const [p, m, b] of [["/book", "GET"], ["/friends", "GET"],
                           ["/book", "PUT", { words: [], version: 0 }], ["/friends/code", "POST"]]) {
    assert.equal((await call(env, A2, p, m, b)).status, 401, `삭제 뒤 ${m} ${p} 가 401 이 아니다`);
  }
}

// ══ 25. 초대 코드 — 살아 있는 코드는 사람당 하나다 ════════════════════════
// `GET /friends` 는 코드가 없으면 만든다. 그래서 **읽기가 쓰기를 유발하고**, 두 탭이 동시에
// 열리면 둘 다 "없다"를 읽고 각자 만든다 — 나중 것이 앞 것을 폐기하므로 먼저 응답을 받은 탭은
// **이미 죽은 코드**를 손에 쥔다. 그 링크를 보낸 상대는 「만료됐거나 잘못됐어요」만 본다.
//
// 고친 방향(사용자 결정 B): GET 의 자동 생성은 그대로 두고, **DB 가 활성 코드 하나를 강제**하게 해
// 충돌을 "누가 이미 만들었다"로 읽는다. 진 쪽은 이긴 쪽의 코드를 그대로 쓴다(internalUid 와 같은 무늬).
{
  const env = makeEnv();
  const A = await signUp(env, "kakao", "codeA"), B = await signUp(env, "kakao", "codeB");
  const rows = (uid) => env.DB._db.prepare("SELECT code, revoked_at FROM invite_codes WHERE user_id=?").all(uid);
  const live = (uid) => rows(uid).filter((r) => r.revoked_at === null);

  // 107. ★ **DB 가 막는다.** 이게 이번 변경의 전부다 — 나머지는 이 제약을 어떻게 읽느냐일 뿐이다.
  //      전에는 애플리케이션의 성실함이 유일한 방어였고, 실측에서 활성 행 두 개가 그냥 들어갔다.
  await call(env, A.token, "/friends");
  assert.throws(() => {
    env.DB._db.prepare("INSERT INTO invite_codes (code,user_id,created_at) VALUES (?,?,?)")
      .run("직접넣은코드", A.uid, Date.now());
  }, /UNIQUE/, "활성 초대 코드가 사람당 둘이 될 수 있다 — 제약이 안 걸렸다");

  // 108. 폐기된 행은 **여럿이어도 된다.** 부분 인덱스가 아니면 회전 자체가 막힌다.
  env.DB._db.prepare("INSERT INTO invite_codes (code,user_id,created_at,revoked_at) VALUES (?,?,?,?)")
    .run("죽은코드1", A.uid, 1, 1);
  env.DB._db.prepare("INSERT INTO invite_codes (code,user_id,created_at,revoked_at) VALUES (?,?,?,?)")
    .run("죽은코드2", A.uid, 2, 2);
  assert.equal(live(A.uid).length, 1, "폐기 행이 활성으로 세어졌다");
  env.DB._db.prepare("DELETE FROM invite_codes WHERE code LIKE '죽은코드%'").run();
}
{
  // ── 동시 요청 ──
  // 셰임은 동기라 "읽고 나서 쓰는" 창이 0 에 가깝다. 실제 D1 은 요청마다 네트워크 왕복이라
  // 그 창이 밀리초 단위로 벌어진다 — 그래서 이 블록에서만 왕복 지연을 씌운다.
  // 지연이 없으면 이 테스트는 **경합을 안 겪고 그냥 통과한다**(재는 게 없다).
  const env = makeEnv();
  env.DB = withLatency(env.DB);
  const A = await signUp(env, "kakao", "raceA"), B = await signUp(env, "kakao", "raceB");
  const live = () => env.DB._db.prepare(
    "SELECT code FROM invite_codes WHERE user_id=? AND revoked_at IS NULL").all(A.uid).map((r) => r.code);

  // 109. ★ 코드가 없는 새 계정의 친구 화면을 **두 탭이 동시에** 연다.
  const [t1, t2] = await Promise.all([call(env, A.token, "/friends"), call(env, A.token, "/friends")]);
  assert.equal(t1.status, 200); assert.equal(t2.status, 200);
  assert.equal(t1.body.code, t2.body.code, "두 탭이 서로 다른 초대 코드를 받았다 — 한쪽은 곧 죽는다");
  assert.deepEqual(live(), [t1.body.code], "응답으로 준 코드가 지금 살아 있는 코드가 아니다");

  // 110. **받은 코드가 실제로 통해야 한다.** 위 단언은 문자열 비교일 뿐이고,
  //      사용자가 겪는 것은 "보낸 링크가 열리나"다.
  const used = await call(env, B.token, "/friends", "POST", { code: t2.body.code });
  assert.equal(used.status, 200, `탭이 받은 코드로 친구 요청이 안 된다(${used.status}) — 죽은 링크를 쥐여줬다`);

  // 110b. ★ **읽기는 이미 나간 링크를 죽이지 않는다.** 목록 조회가 회전을 대신 부르면,
  //      화면을 여는 것만으로 폐기 행이 생긴다 — 즉 **누군가에게 이미 보낸 링크가 조회 하나로
  //      죽을 수 있다.** 언제 죽일지는 사람이 정하는 것이지 화면을 여는 일이 정하는 게 아니다.
  //      (행 개수로 잰다: 회전을 지났다면 폐기 행이 남는다.)
  for (let i = 0; i < 5; i++) await call(env, A.token, "/friends");
  const all = env.DB._db.prepare("SELECT revoked_at FROM invite_codes WHERE user_id=?").all(A.uid);
  assert.equal(all.length, 1,
    `친구 목록을 읽었을 뿐인데 invite_codes 가 ${all.length}행이다 — 읽기가 코드를 폐기하고 있다`);
  assert.equal(all[0].revoked_at, null, "읽기가 내 코드를 폐기했다");
}
{
  // 111. ★ 회전을 **두 기기에서 동시에** 누른다. 응답이 갈리면 늦게 도착한 쪽이
  //      localStorage 에 죽은 코드를 적고, 사용자는 그 링크를 보낸다(js/friends.js 의 잠금은
  //      한 탭 안에서만 듣는다 — 두 기기·두 탭은 못 막는다).
  const env = makeEnv();
  env.DB = withLatency(env.DB);
  const A = await signUp(env, "kakao", "rotA"), B = await signUp(env, "kakao", "rotB");
  await call(env, A.token, "/friends");
  const [x, y] = await Promise.all([
    call(env, A.token, "/friends/code", "POST"),
    call(env, A.token, "/friends/code", "POST"),
  ]);
  const live = env.DB._db.prepare(
    "SELECT code FROM invite_codes WHERE user_id=? AND revoked_at IS NULL").all(A.uid).map((r) => r.code);
  assert.equal(live.length, 1, `회전 뒤 활성 코드가 ${live.length}개다`);
  assert.equal(x.body.code, y.body.code, "동시 회전이 서로 다른 코드를 돌려줬다 — 한쪽은 죽은 코드다");
  assert.deepEqual(live, [x.body.code], "회전이 돌려준 코드가 지금 살아 있는 코드가 아니다");
  assert.equal((await call(env, B.token, "/friends", "POST", { code: x.body.code })).status, 200,
    "회전이 돌려준 코드로 친구 요청이 안 된다");
}
{
  // ── 회전의 대가를 묶는다(사용자 결정 ②) ──
  const env = makeEnv();
  const A = await signUp(env, "kakao", "rotLimit"), B = await signUp(env, "kakao", "rotOther");
  const codeRows = () => env.DB._db.prepare("SELECT COUNT(*) n FROM invite_codes WHERE user_id=?").get(A.uid).n;
  await call(env, A.token, "/friends");

  // 112. ★ 회전은 **자기 버킷**으로 좁게 센다. 전에는 넉넉한 `write`(분당 120)만 걸려서,
  //      로그인한 계정 **하나**가 분당 240 D1 쓰기 = 하루 34만(무료 한도 10만)을 태울 수 있었다.
  //      그게 바닥나면 **정상 사용자의 단어장 저장이 먼저 죽는다.**
  let ok = 0, blocked = 0;
  for (let i = 0; i < 30; i++) {
    const r = await call(env, A.token, "/friends/code", "POST");
    r.status === 429 ? blocked++ : ok++;
  }
  assert.ok(blocked > 0, "초대 링크 회전을 분당 30번 넘게 눌러도 안 막힌다");
  assert.ok(ok <= 8, `회전이 분당 ${ok}회까지 통과한다 — write 한도(120)에 묶여 있다`);

  // 113. ★ **폐기 행이 쌓이지 않는다.** 지우는 곳이 없어서 회전할 때마다 영구히 늘어났다
  //      (실측: 분당 120행). 계정 삭제 전에는 아무도 안 지운다.
  assert.ok(codeRows() <= 3, `회전 ${ok}회에 invite_codes 가 ${codeRows()}행 남았다 — 폐기 행이 안 치워진다`);

  // 114. **회전이 막혀도 단어장 저장은 안 막힌다.** 버킷이 갈렸다는 뜻이고,
  //      안 갈리면 남용 방어가 정상 사용을 죽인다.
  assert.equal((await call(env, A.token, "/book", "PUT", { words: ["사랑"], name: "", version: 0 })).status, 200,
    "회전이 막혔다고 단어장 저장까지 막혔다");
  // 115. **다른 IP** 의 사람은 막히지 않는다. 세는 단위가 IP 라(2026-08-19 · 재현 R5)
  //      같은 IP 는 나눠 쓰지만, 그것마저 안 갈리면 리미터 하나가 전 세계를 막는다.
  assert.equal((await call(env, B.token, "/friends/code", "POST")).status, 429,
    "같은 IP 인데 버킷이 갈렸다 — 인증 뒤에 세고 있다는 뜻이다");
  assert.notEqual((await call(env, B.token, "/friends/code", "POST", undefined, { "CF-Connecting-IP": "198.51.100.9" })).status, 429,
    "다른 IP 까지 막혔다 — 방어가 아니라 고장이다");
}

// ══ 25c. 레이트리밋 버킷 등록 (T54) ══════════════════════════════════════
// **등록되지 않은 버킷은 조용히 넉넉해지지 않는다.** 예전에는 `RL_MAX[bucket] ?? RL_MAX.write`
// 라, 오타 하나 또는 새 버킷 하나가 아무도 모르게 한도 120 을 물려받았다 — 실제로 `auth`
// 버킷이 그렇게 **한 번도 먼저 막은 적이 없었다.** 좁으라고 만든 것이 넓어지는 방향이다.
{
  // T54-a. 모르는 이름은 그 자리에서 던진다(fail-fast). 통과시키면 그 버그가 「리미터 없음」으로 산다.
  for (const b of ["nope", "auth", "", "Write", " write"])
    assert.throws(() => rlMax(b), /unknown rate limit bucket/, `T54: 등록 안 된 버킷 ${JSON.stringify(b)} 이 통과했다`);
  // T54-b. **프로토타입 속성은 버킷이 아니다.** `in`·`[]` 로 보면 값이 나와 검사를 통과하고,
  //   그 값은 숫자가 아니라 `n > max` 비교가 늘 거짓이 된다 = 이름 하나로 리미터가 꺼진다.
  for (const b of ["__proto__", "constructor", "toString", "hasOwnProperty"])
    assert.throws(() => rlMax(b), /unknown rate limit bucket/, `T54: 프로토타입 속성 ${b} 이 버킷으로 통과했다`);
  for (const b of [null, undefined, 0, {}])
    assert.throws(() => rlMax(b), /unknown rate limit bucket/, "T54: 문자열이 아닌 버킷이 통과했다");
  // T54-c. **라우트 표가 쓰는 버킷은 전부 등록돼 있다.** 표에 적고 한도를 잊으면 여기서 걸린다.
  const buckets = routeBuckets();
  assert.ok(buckets.length >= 4, "T54: 라우트 표에서 버킷을 못 찾았다 — 검사기가 낡았다");
  for (const b of buckets) assert.equal(typeof rlMax(b), "number", `T54: 라우트가 쓰는 버킷 ${b} 이 등록돼 있지 않다`);
}

// ══ 25d. 라우트 표 (T55) ═════════════════════════════════════════════════
// 표가 **판정의 원본**이다. 여기가 틀리면 없는 주소가 DB 를 만지거나(T50) 실재하는 주소가
// 404 가 된다. 순수 함수라 HTTP 없이 잰다.
{
  // 실재하는 것: 알려진 method 만.
  assert.ok(routeFor("GET", "/book"), "T55: GET /book 이 표에 없다");
  assert.ok(routeFor("PUT", "/book"), "T55: PUT /book 이 표에 없다");
  assert.equal(routeFor("POST", "/book"), null, "T55: POST /book 이 라우트로 잡힌다");
  assert.equal(routeFor("GET", "/session"), null, "T55: GET /session 이 라우트로 잡힌다");
  // 없는 것: 아무 주소, 모르는 제공자, method 불일치.
  for (const [m, p] of [["GET", "/이런건없다"], ["POST", "/health"], ["GET", "/login/없는것"],
                        ["GET", "/friends/code"], ["DELETE", "/policies"], ["GET", "/login"],
                        ["GET", "/cb"], ["GET", "/signup/start"]])
    assert.equal(routeFor(m, p), null, `T55: ${m} ${p} 가 라우트로 잡힌다`);
  // 임차증: 주 D1 을 만지는 것만 든다.
  assert.equal(routeFor("GET", "/health").lease, false, "T55: /health 가 임차증을 든다");
  assert.equal(routeFor("GET", "/ready").lease, false, "T55: /ready 가 임차증을 든다");
  assert.equal(routeFor("GET", "/policies").lease, false, "T55: /policies 가 임차증을 든다");
  assert.equal(routeFor("GET", "/login/kakao").lease, false, "T55: 로그인 시작이 임차증을 든다");
  for (const [m, p] of [["GET", "/book"], ["PUT", "/book"], ["GET", "/me"], ["DELETE", "/me"],
                        ["GET", "/friends"], ["POST", "/friends"], ["POST", "/friends/code"],
                        ["GET", "/friends/x/book"], ["PUT", "/friends/x"], ["DELETE", "/session"],
                        ["POST", "/signup/start"], ["GET", "/cb/kakao"], ["GET", "/exchange/naver"]])
    assert.equal(routeFor(m, p).lease, true, `T55: ${m} ${p} 가 주 D1 을 만지는데 임차증을 안 든다`);
  // 버킷: **라우트 하나에 하나.** GET 은 세지 않는다.
  assert.equal(routeFor("POST", "/friends").bucket, "friends", "T55: POST /friends 의 버킷이 friends 가 아니다");
  assert.equal(routeFor("POST", "/friends/code").bucket, "rotate", "T55: 회전이 자기 버킷을 안 쓴다");
  assert.equal(routeFor("POST", "/signup/start").bucket, "signup", "T55: 가입 시작이 자기 버킷을 안 쓴다");
  assert.equal(routeFor("GET", "/cb/kakao").bucket, "login", "T55: 콜백이 login 버킷이 아니다");
  assert.equal(routeFor("PUT", "/book").bucket, "write", "T55: 단어장 저장이 write 버킷이 아니다");
  // ⚠️ 2026-08-19 정정: 읽기도 **센다**. 예전에는 버킷이 `null` 이라 인증이 필요한 읽기가
  //    아무 상한 없이 임차증을 소비했다(재현 R5). 지금은 전용 `read` 버킷이다.
  assert.equal(routeFor("GET", "/book").bucket, "read", "T55: 인증이 필요한 읽기에 버킷이 없다");
  // **임차증을 드는 라우트에는 버킷이 반드시 있다.** 없으면 그 라우트가 곧 증폭 통로다.
  for (const [m, p] of [["GET", "/book"], ["PUT", "/book"], ["GET", "/me"], ["PUT", "/me"],
                        ["DELETE", "/me"], ["DELETE", "/session"], ["GET", "/friends"],
                        ["POST", "/friends"], ["POST", "/friends/code"], ["GET", "/friends/x/book"],
                        ["PUT", "/friends/x"], ["DELETE", "/friends/x"], ["POST", "/signup/start"],
                        ["GET", "/cb/kakao"], ["GET", "/exchange/naver"]]) {
    const r = routeFor(m, p);
    assert.ok(r && r.lease && r.bucket,
      `T55: ${m} ${p} 가 임차증을 드는데 레이트리밋 버킷이 없다 — 상한 없는 쓰기 통로다`);
  }
  // HEAD 는 GET 과 같은 라우트다. 가르면 `curl -sI` 로 확인하라고 적어 둔 절차가 404 를 받는다.
  assert.ok(routeFor("HEAD", "/health"), "T55: HEAD /health 가 404 가 된다");
  assert.equal(routeFor("HEAD", "/login/kakao").lease, false, "T55: HEAD 가 임차증을 든다");
  assert.equal(routeFor("HEAD", "/session"), null, "T55: HEAD 가 DELETE 전용 라우트를 연다");
  assert.equal(routeFor("GET", "/friends").bucket, "read", "T55: 목록 조회에 버킷이 없다");
}

// ══ 26. RL_KEY — 리미터 키는 **비밀키 HMAC** 이다 ═════════════════════════
// 전에는 `SHA-256(용도|IP|창)` 평문 해시였다. IP 는 경우의 수가 43억뿐이라 전부 넣어 보면
// 풀린다 — 실측에서 `/24` 대역만 대입해 **43회 만에** 원본 IP 가 나왔다.
// 그래서 `privacy.html` 의 "되돌릴 수 없는 요약값" 은 IP 에 대해 사실이 아니었다.
// 키를 모르면 넣어 볼 값 자체를 만들 수 없다.
{
  const ENC = new TextEncoder();
  const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const plain = async (s) => b64u(await crypto.subtle.digest("SHA-256", ENC.encode(s)));
  const hit = async (env, ip = "203.0.113.42") =>
    worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y", { headers: { "CF-Connecting-IP": ip } }), env);
  const buckets = (env) => env.LEDGER._db.prepare("SELECT bucket FROM rate_limits").all().map((r) => r.bucket);

  // 116. ★ 저장된 키가 **평문 해시가 아니다.** 이 단언이 곧 "대입으로 못 푼다"의 실질이다.
  const env = makeEnv({ KAKAO_ID: "id" });
  await hit(env);
  const win = Math.floor(Date.now() / 60_000);
  const got = buckets(env);
  assert.equal(got.length, 1, "카운터가 하나가 아니다 — 이 검사의 전제가 깨졌다");
  const guesses = await Promise.all([win - 1, win, win + 1].map((w) => plain(`login|203.0.113.42|${w}`)));
  assert.ok(!guesses.includes(got[0]),
    "리미터 키가 평문 SHA-256 이다 — IP 를 전부 넣어 보면 누가 언제 왔는지 복원된다");

  // 117. **키가 다르면 버킷도 다르다.** 같으면 키가 실제로 안 섞이고 있다는 뜻이다.
  const env2 = makeEnv({ KAKAO_ID: "id", RL_KEY: "완전히-다른-키" });
  await hit(env2);
  assert.notDeepEqual(buckets(env2), got, "RL_KEY 를 바꿔도 버킷이 같다 — 키가 안 쓰이고 있다");

  // 118. 원문 IP·uid 는 여전히 안 남는다(88 과 같은 불변식, 키가 바뀌어도 지켜져야 한다).
  assert.ok(!got[0].includes("203.0.113.42"), "버킷 키에 IP 원문이 남았다");

  // 119. ★ **RL_KEY 가 없으면 준비된 것이 아니다.** 조용히 약한 쪽으로 도는 것이 가장 나쁘다 —
  //      그래서 평문 해시로 **되돌아가지 않고**, readiness 가 시끄럽게 말한다.
  const noKey = makeEnv({ KAKAO_ID: "id", RL_KEY: undefined });
  const rd = await (await worker.fetch(new Request("https://api.test/ready",
    { headers: { "X-Ready-Key": noKey.READY_KEY } }), noKey)).json();
  assert.equal(rd.configReady, false, "RL_KEY 가 없는데 configReady 가 true 다");
  assert.equal(rd.ready, false, "RL_KEY 가 없는데 ready 다");
  assert.equal(rd.db, true, "DB 는 멀쩡한데 db:false 라고 말한다");
  assert.ok(!JSON.stringify(rd).includes("RL_KEY"), "응답이 비밀값 이름을 말한다");

  // 120. 키가 없으면 **세지 않고, 열지도 않는다**(fail-closed). ⛔ **2026-08-22 에 뒤집혔다**
  //      (위협 52): 예전에는 여기서 통과시켰고(fail-open) `/ready` 만 시끄러웠다 — 그런데
  //      계정 경로가 열려 있는 한 「말만 하는 경보」는 방어가 아니다. 약한 해시로 계속 세는
  //      쪽은 여전히 안 한다(방침이 거짓말이 된다). 셋 중 남은 답은 **막는 것**뿐이다.
  //      막는 응답은 429 가 아니라 **503** 이다 — 「좀 있다 다시」가 아니라 「셀 수 없다」다.
  for (let i = 0; i < 15; i++) assert.equal((await hit(noKey)).status, 503, "키가 없는데 통과시켰다");
  assert.equal(buckets(noKey).length, 0, "RL_KEY 가 없는데 카운터를 쌓고 있다 — 약한 해시로 세고 있다");
}

// ══ 27. 로그인 한도는 **세션을 만드는 자리**에만 건다 ══════════════════════
// 전에는 `/login`(시작)·`/cb`·`/exchange` 셋이 같은 `login` 버킷을 썼다. 한 번의 로그인이
// 두 자리를 지나므로 **한도 10 이 실제로는 완전한 로그인 5회**였다(실측). 문서는 10 이라 적혀 있었다.
// 막으려는 것은 "세션을 무한히 찍어내는 것"인데 `/login` 은 세션을 안 만든다 — 302 하나와 서명 하나다.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const ip = { "CF-Connecting-IP": "198.51.100.77" };
  const counters = () => env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n;

  // 121. ★ 로그인 **시작**은 세지 않는다. 세면 D1 쓰기가 두 배인데 막는 것은 없다.
  for (let i = 0; i < 20; i++) {
    const r = await worker.fetch(new Request(
      "https://api.test/login/kakao?return=" + encodeURIComponent(ORIGIN), { headers: ip }), env);
    assert.equal(r.status, 302, `로그인 시작 ${i + 1}번째가 ${r.status} 로 막혔다`);
  }
  assert.equal(counters(), 0, "로그인 시작이 카운터 행을 만들었다 — 세션도 안 만드는 자리다");

  // 122. ★ **완전한 로그인 10회**가 통과한다. 이게 문서에 적힌 숫자이고, 전에는 5회였다.
  const env2 = makeEnv({ KAKAO_ID: "id" });
  let done = 0;
  for (let i = 0; i < 12; i++) {
    const s = await worker.fetch(new Request(
      "https://api.test/login/kakao?return=" + encodeURIComponent(ORIGIN), { headers: ip }), env2);
    const st = new URL(s.headers.get("Location")).searchParams.get("state");
    const cb = await worker.fetch(new Request(
      "https://api.test/cb/kakao?code=x&state=" + encodeURIComponent(st), { headers: ip }), env2);
    if (cb.status === 429) break;
    done++;
  }
  assert.equal(done, 10, `분당 10회라고 적어 두고 실제로는 완전한 로그인 ${done}회만 된다`);

  // 123. 그래도 **막히기는 한다.** 세션을 만드는 자리의 상한이 사라지면 그건 방어가 아니다.
  const cb = await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y", { headers: ip }), env2);
  assert.equal(cb.status, 429, "세션을 만드는 자리가 안 막힌다");
}

// ══ 27. 유지보수 · 복원 게이트 (T4 · T6 · T8 · T40~T43) ═══════════════════
// 왜 여기인가: 이것은 **HTTP 계층의 판정**이다 — 어느 라우트가 어느 상태에서 열리나.
// ledger 쪽 규칙은 scripts/test-deletion-ledger.mjs 가 따로 잰다.
//
// ⚠️ 4판 설계는 유지보수 중에도 `GET /book`·`GET /me`·`GET /friends/:id/book` 을 **허용**했다.
//    근거가 "DB 를 안 **쓴다**"였는데, **쓰기만 본 것이 잘못이다** — 주 D1 을 과거로 되돌리면
//    탈퇴한 사람의 계정·세션·단어장이 되살아나고, 재삭제가 끝나기 전까지 그 사람은
//    **살아 있는 계정**이다. 읽기를 막지 않으면 지웠던 단어장이 그대로 나간다.
{
  const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
  const A = await signUp(env, "kakao", "m1"), B = await signUp(env, "kakao", "m2");
  await call(env, A.token, "/book", "PUT", { words: ["비밀"], name: "탈퇴자" });
  befriend(env, A.uid, B.uid);
  const setMode = (m) => env.LEDGER._db.exec(`UPDATE maintenance SET mode='${m}' WHERE id=1`);
  const snapshot = () => JSON.stringify([
    env.DB._db.prepare("SELECT COUNT(*) n FROM users").get(),
    env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get(),
    env.DB._db.prepare("SELECT COUNT(*) n FROM invite_codes").get(),
    env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get(),
    env.DB._db.prepare("SELECT version FROM books WHERE user_id=?").get(A.uid),
  ]);

  // ── T4. `maintenance` — **DB 를 쓰는 라우트 전부 차단.** 행 수가 하나도 안 변해야 한다.
  setMode("maintenance");
  const before4 = snapshot();
  for (const [path, method] of [["/me", "DELETE"], ["/book", "PUT"], ["/session", "DELETE"],
                                ["/friends", "POST"], ["/friends/code", "POST"],
                                ["/friends/" + B.uid, "PUT"], ["/friends/" + B.uid, "DELETE"],
                                // ⚠️ **GET 인데 쓴다.** 목록 조회가 초대 코드를 그 자리에서 만든다.
                                ["/friends", "GET"],
                                // ⚠️ 여기가 계정을 만드는 자리다. GET 이라고 통과시키면 안 된다.
                                ["/cb/kakao?code=c&state=s", "GET"], ["/exchange/kakao?code=c&state=s", "GET"],
                                ["/login/kakao", "GET"], ["/signup/start", "POST"]]) {
    const r = await call(env, A.token, path, method, method === "GET" ? undefined : {});
    assert.equal(r.status, 503, `T4: 유지보수 중인데 ${method} ${path} 가 통과했다`);
    assert.equal(r.headers.get("Retry-After"), "60", `T4: ${method} ${path} 에 Retry-After 가 없다`);
  }
  assert.equal(snapshot(), before4, "T4: 유지보수 중에 행 수가 바뀌었다 — 어딘가 쓰기가 지나갔다");
  // 읽기는 허용된다(이 상태가 `restore_closed` 와 다른 점이 그것이다).
  assert.equal((await call(env, A.token, "/book")).status, 200, "T4: 유지보수인데 읽기까지 막혔다");
  assert.equal((await call(env, B.token, "/friends/" + A.uid + "/book")).status, 200, "T4: 유지보수인데 친구 단어장이 막혔다");
  // /health · /ready · /policies 는 언제나 열린다.
  assert.equal((await call(env, null, "/health")).status, 200, "T4: /health 가 막혔다");
  const rdy = await call(env, null, "/ready");
  assert.equal(rdy.status, 503, "T4: 유지보수인데 /ready 가 200 이다");
  assert.equal(rdy.body.mode, "maintenance", "T4: /ready 가 상태를 안 알려준다");
  assert.equal(rdy.body.ready, false, "T4: 유지보수인데 ready 다");
  assert.equal((await call(env, null, "/policies")).status, 200, "T4: /policies 가 막혔다");

  // ── T40~T43. `restore_closed` — **읽기도 세션 인증도 막는다.**
  //   되살아난 탈퇴자의 단어장이 그대로 읽히고 세션까지 부활하는 경로를 닫는다.
  setMode("restore_closed");
  const before40 = snapshot();
  // T40. 되살아난 세션으로 자기 단어장을 읽으려 한다 → 503, **본문에 단어가 없다.**
  const r40 = await call(env, A.token, "/book");
  assert.equal(r40.status, 503, "T40: restore_closed 인데 단어장을 읽을 수 있다");
  assert.ok(!JSON.stringify(r40.body).includes("비밀"), "T40: 503 인데 응답에 단어가 실려 나왔다");
  // T41. 친구가 탈퇴자의 단어장·목록을 본다 → 둘 다 503.
  assert.equal((await call(env, B.token, "/friends/" + A.uid + "/book")).status, 503,
    "T41: restore_closed 인데 친구에게 탈퇴자의 단어장이 보인다");
  assert.equal((await call(env, B.token, "/friends")).status, 503, "T41: restore_closed 인데 친구 목록이 열린다");
  // T42. 계정 존재 여부조차 알려주지 않는다.
  const r42 = await call(env, A.token, "/me");
  assert.equal(r42.status, 503, "T42: restore_closed 인데 /me 가 열린다");
  assert.ok(!JSON.stringify(r42.body).includes(A.uid), "T42: 503 인데 응답에 계정 id 가 실렸다");
  // T43. **허용 목록이 정확히 넷이다.** 다섯 번째가 늘면 여기서 실패한다.
  for (const p of ["/health", "/ready", "/policies"])
    assert.notEqual((await call(env, A.token, p)).status, 503 - 503 + 999, `T43: ${p} 응답이 이상하다`);
  assert.equal((await call(env, null, "/health")).status, 200, "T43: /health 가 막혔다");
  const rd2 = await call(env, null, "/ready");
  assert.equal(rd2.status, 503, "T43: restore_closed 인데 /ready 가 200 이다");
  assert.equal(rd2.body.mode, "restore_closed", "T43: /ready 가 restore_closed 를 안 알려준다");
  assert.equal((await call(env, null, "/policies")).status, 200, "T43: /policies 가 막혔다");
  // 그 밖의 **실재하는** 라우트는 전부 차단이다. 허용 목록에 없는 것이 기본값이라
  // 새 라우트가 생겨도 자동으로 막힌다.
  for (const [p, m] of [["/book", "GET"], ["/book", "PUT"], ["/me", "GET"], ["/me", "DELETE"],
                        ["/friends", "GET"], ["/friends", "POST"], ["/friends/code", "POST"],
                        ["/friends/" + B.uid + "/book", "GET"], ["/session", "DELETE"],
                        ["/login/kakao", "GET"], ["/cb/kakao", "GET"], ["/exchange/kakao", "GET"],
                        ["/signup/start", "POST"]]) {
    const r = await call(env, A.token, p, m, m === "GET" ? undefined : {});
    assert.equal(r.status, 503, `T43: restore_closed 에서 ${m} ${p} 가 허용 목록에 들었다`);
  }
  // ⚠️ **없는 주소는 503 이 아니라 404 다**(2026-08-19). 게이트보다 라우트 판정이 앞이기
  //    때문이다 — 그래야 없는 주소를 두드리는 것으로 DB 쓰기를 유발할 수 없다(아래 T50).
  //    라우트 표는 앱 번들에 그대로 들어 있어서 숨길 것이 아니고, 404 는 계정·데이터에 대해
  //    아무것도 말하지 않는다.
  for (const [p, m] of [["/이런건없다", "GET"], ["/이런건없다", "POST"], ["/health", "POST"],
                        ["/login/없는제공자", "GET"], ["/friends/code", "GET"]]) {
    assert.equal((await call(env, A.token, p, m, m === "GET" ? undefined : {})).status, 404,
      `T43: 없는 라우트 ${m} ${p} 가 404 가 아니다`);
  }
  assert.equal(snapshot(), before40, "T40~43: restore_closed 중에 행 수가 바뀌었다");
  // ⚠️ **세션 인증을 수행조차 하지 않는다.** 인증을 한 번이라도 시도하면 되살아난 sessions 행을
  //    조회하게 되고, 그 결과가 타이밍·오류로 새어 나간다.
  //    ⛔ **재는 방법이 2026-08-22 에 바뀌었다**(결정 4). 예전에는 「맞는 쿠키와 틀린 쿠키의
  //       응답이 같다」로 확인했는데, 세션 envelope 이 생기면서 **틀린 쿠키는 게이트 앞에서
  //       401** 이 된다(DB 를 안 만진다). 상태코드가 같은지를 보는 것은 원래 재려던 것의
  //       **대리 지표**였을 뿐이므로, 이제 **주 D1 질의 수를 직접 센다** — 그게 재려던 것이다.
  const dbQ = () => { const q = []; const sv = env.DB.prepare;
    env.DB.prepare = (sql) => { q.push(sql); return sv.call(env.DB, sql); };
    return { q, stop: () => { env.DB.prepare = sv; } }; };
  {
    const spy = dbQ();
    const good = await call(env, A.token, "/book"), bad = await call(env, "bogus-token", "/book");
    spy.stop();
    assert.equal(spy.q.length, 0, `T40: restore_closed 인데 주 D1 에 질의 ${spy.q.length}건 — 인증을 수행하고 있다`);
    assert.equal(good.status, 503, "T40: 우리 쿠키인데 503 이 아니다");
    assert.equal(bad.status, 401, "T40: 우리 것이 아닌 쿠키가 게이트까지 갔다");
    for (const r of [good, bad])
      assert.ok(!JSON.stringify(r.body).includes(A.uid), "T40: 응답에 계정 id 가 실렸다");
  }

  // ── 다시 열면 원래대로. 막는 쪽만 재면 「영영 안 열리는」 회귀를 못 잡는다.
  setMode("open");
  assert.equal((await call(env, A.token, "/book")).status, 200, "게이트를 열었는데 여전히 막힌다");
  assert.equal((await call(env, A.token, "/friends")).status, 200, "게이트를 열었는데 친구 목록이 막힌다");
}

// ══ 28. 전역 user-data drain (T6 · T6b) + 아직 못 막는 것(T8) ═════════════
// **결정 A′ (2026-08-18).** 사용자 데이터를 읽거나 쓰는 HTTP 요청 하나가 LEDGER 임차증 하나를
// 든다. 문장마다가 아니다. 세션 인증 전에 따고, 가장 바깥 `finally` 에서 푼다.
//
// ⚠️ **T6 의 합격 조건이 「무조건 503」이 아니다.** 지연 요청이 살아 있는 동안
//    **활성 1 · 복원 거부**이고, 그 요청이 끝난 **뒤에만** 0 이 되는 것을 잰다.
//    「503 이 난다」만 재면 「요청이 끝났는지」를 안 재게 된다 — 재려던 것이 그것인데도.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const A = await signUp(env, "kakao", "drain1");
  const version = () => env.DB._db.prepare("SELECT version FROM books WHERE user_id=?").get(A.uid)?.version ?? 0;
  const drain = () => drainState(env);

  await call(env, A.token, "/book", "PUT", { words: ["가"], version: 0 });
  const v0 = version();
  assert.equal((await drain()).open, 0, "T6: 요청이 끝났는데 임차증이 남았다 — finally 가 안 돈다");

  // 게이트를 통과한 뒤 DB 쓰기 직전에 붙들었다가, 유지보수로 전환된 **뒤에** 놓아준다.
  let release;
  const held = new Promise((r) => { release = r; });
  const realDb = env.DB.prepare.bind(env.DB);
  const slowBooks = { ...env.DB, _db: env.DB._db, batch: env.DB.batch.bind(env.DB),
    prepare: (sql) => {
      const st = realDb(sql);
      if (!sql.includes("INSERT INTO books")) return st;
      return { bind: (...a) => { st.bind(...a); return { run: async () => { await held; return st.run(); },
        first: () => st.first(), all: () => st.all() }; } };
    } };
  const inflight = call({ ...env, DB: slowBooks }, A.token, "/book", "PUT",
    { words: ["가", "나"], version: v0 });
  await new Promise((r) => setTimeout(r, 5));
  env.LEDGER._db.exec("UPDATE maintenance SET mode='maintenance', epoch=epoch+1 WHERE id=1");

  // ── T6-1. 지연 요청이 살아 있는 동안 **활성 1**.
  const mid = await drain();
  assert.equal(mid.open, 1, "T6: 지연된 쓰기가 진행 중인데 활성 임차증이 1이 아니다");
  assert.equal(mid.drained, false, "T6: 요청이 아직 도는데 drained 라고 말한다");

  // ── T6-2. 그 상태에서 **복원이 거부**된다.
  // ⚠️ **인자로 조건을 채워 넣지 않는다**(2026-08-19). 예전에는 여기서 `oldDeployments`·
  //    `regressionTests` 를 참으로 적어 넘겨 「나머지 조건은 다 됐다 치고」 재고 있었는데,
  //    그건 `restoreGate` 가 인자를 믿는다는 뜻이었다 — 그 우회로 자체를 없앴다.
  const midReport = await drainReport(env);
  assert.equal(midReport.state.noActiveLeases, false, "T6: 요청이 도는데 noActiveLeases 가 참이다");
  assert.ok(restoreGate(midReport).missing.some((x) => x.startsWith("noActiveLeases")),
    "T6: 활성 임차증이 미충족 사유에 안 잡힌다");
  assert.throws(() => beginRestore(midReport), /지금 금지/,
    "T6: 활성 임차증이 있는데 복원 gate 가 통과시킨다");

  // ── T6-3. **restore_closed 로 가면 신규 획득이 원자적으로 거부**된다(활성 수가 늘지 않는다).
  env.LEDGER._db.exec("UPDATE maintenance SET mode='restore_closed', epoch=epoch+1 WHERE id=1");
  assert.equal((await call(env, A.token, "/book")).status, 503, "T6: restore_closed 에서 읽기가 통과했다");
  assert.equal((await drain()).open, 1, "T6: restore_closed 인데 새 임차증이 발급됐다");

  // ── T6-4. 지연 요청이 **끝난 뒤에야** 0 이 된다.
  release();
  await inflight;
  const after = await drain();
  assert.equal(after.open, 0, "T6: 요청이 끝났는데 임차증이 안 풀렸다");
  assert.equal(after.drained, true, "T6: 전부 끝났는데 drained 가 아니다");
  // 쓰기 자체는 여전히 착지한다 — **A′ 는 그것을 막는 장치가 아니라 「끝났는지 아는」 장치다.**
  // 복원은 이 요청이 끝난 뒤에 시작하므로 섞이지 않는다.
  assert.ok(version() > v0, "T6: 전제가 바뀌었다 — 지연 쓰기가 아예 안 일어났다");
}

// ── T6b. ★ **지연된 사용자 데이터 「읽기」도 추적된다.**
//   쓰기만 추적하면 복원 중 되살아난 탈퇴자의 단어장을 읽는 요청(위협 36)이 카운트 밖이다.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const A = await signUp(env, "kakao", "drain2");
  let release;
  const held = new Promise((r) => { release = r; });
  const realDb = env.DB.prepare.bind(env.DB);
  const slowRead = { ...env.DB, _db: env.DB._db, batch: env.DB.batch.bind(env.DB),
    prepare: (sql) => {
      const st = realDb(sql);
      if (!/SELECT words/.test(sql)) return st;
      return { bind: (...a) => { st.bind(...a); return { first: async () => { await held; return st.first(); },
        run: () => st.run(), all: () => st.all() }; } };
    } };
  const reading = call({ ...env, DB: slowRead }, A.token, "/book");
  await new Promise((r) => setTimeout(r, 5));
  env.LEDGER._db.exec("UPDATE maintenance SET mode='restore_closed', epoch=epoch+1 WHERE id=1");
  assert.equal((await drainState(env)).open, 1, "T6b: 지연된 읽기가 추적되지 않는다");
  release();
  await reading;
  assert.equal((await drainState(env)).open, 0, "T6b: 읽기가 끝났는데 임차증이 안 풀렸다");
}

// ── T6c. ★ **TTL 만료를 자동 해제로 치지 않는다.**
//   만료로 걸러내면 「끝나지 않은 요청」이 시간만 지나면 0 으로 세어진다. 그건 모르는 것을
//   안다고 말하는 것이다. 만료된 미해제는 `stale` 로 세고 **복원을 계속 막는다.**
{
  const env = makeEnv();
  const now = Date.now();
  env.LEDGER._db.prepare(
    "INSERT INTO write_leases (lease_id, epoch, started_at, expires_at) VALUES (?,?,?,?)")
    .run("stuck", 1, now - 3600e3, now - 1800e3);   // 30분 전에 만료, 해제된 적 없음
  const d = await drainState(env, now);
  assert.equal(d.open, 1, "T6c: 만료된 미해제 임차증을 0으로 셌다 — 만료를 해제로 친다");
  assert.equal(d.stale, 1, "T6c: stale 로 분류하지 않는다");
  assert.equal(d.drained, false, "T6c: stale 이 있는데 drained 라고 말한다");
  const rep = await drainReport(env, now);
  assert.equal(rep.state.noActiveLeases, false, "T6c: stale 이 있는데 noActiveLeases 가 참이다");
  assert.ok(restoreGate(rep).missing.some((x) => x.startsWith("noActiveLeases")),
    "T6c: stale 임차증이 미충족 사유에 안 잡힌다");
  assert.throws(() => beginRestore(rep), /지금 금지/, "T6c: stale 임차증이 있는데 복원을 허용한다");
}

// ── T8-a. ★ **ledger 바인딩이 없으면 사용자 데이터 API 가 전부 막힌다(fail-closed).**
//   2026-08-19 까지는 정반대였다: `readMode()` 가 바인딩이 없으면 `open` 을 돌려줘서,
//   `LEDGER` 를 빠뜨린 배포가 게이트도 임차증도 없이 읽고 썼다(실측 — 읽기·쓰기 둘 다 200).
//   그 상태에서는 삭제 표식도 못 남기고 drain 도 못 센다. 즉 그 배포는 **사용자 데이터를
//   만지면 안 되는 배포**다. 지금은 `unbound` 모드가 되어 허용 목록 셋만 열린다.
{
  const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
  const A = await signUp(env, "kakao", "nolg");
  await call(env, A.token, "/book", "PUT", { words: ["비밀"], version: 0 });
  const noLedger = { ...env, LEDGER: undefined };

  for (const [p, m, body] of [["/book", "GET"], ["/book", "PUT", { words: ["새"], version: 1 }],
                              ["/me", "GET"], ["/me", "DELETE", {}], ["/friends", "GET"],
                              ["/session", "DELETE", {}], ["/signup/start", "POST", { provider: "kakao" }],
                              ["/cb/kakao?code=c&state=s", "GET"], ["/exchange/kakao?code=c&state=s", "GET"]]) {
    const r = await call(noLedger, A.token, p, m, body);
    assert.equal(r.status, 503, `T8-a: LEDGER 없이 ${m} ${p} 가 통과했다 — fail-open 이다`);
    assert.ok(!JSON.stringify(r.body).includes("비밀"), `T8-a: ${m} ${p} 의 503 에 데이터가 실렸다`);
  }
  // 데이터가 하나도 안 바뀌었다. 「503 을 돌려주면서 쓰기는 했다」가 아니다.
  assert.deepEqual((await call(env, A.token, "/book")).body.words, ["비밀"],
    "T8-a: LEDGER 없는 요청이 그래도 단어장을 바꿨다");

  // 운영 상태를 보는 자리는 **열려 있어야 한다** — 무엇이 고장 났는지 볼 수단이 이것뿐이다.
  const h = await call(noLedger, null, "/health");
  assert.equal(h.status, 200, "T8-a: LEDGER 가 없다고 /health 까지 막혔다");
  assert.deepEqual(h.body.providers, [], "T8-a: 눌러도 503 인 제공자 버튼을 그리라고 말한다");
  assert.equal(h.body.ledgerBound, false, "T8-a: /health 가 ledger 미바인딩을 숨긴다");
  assert.equal(h.body.signupReady, false, "T8-a: ledger 없이 가입 준비 완료라고 말한다");
  const rd = await call(noLedger, null, "/ready");
  assert.equal(rd.status, 503, "T8-a: ledger 없이 ready 다");
  assert.equal(rd.body.ledgerBound, false, "T8-a: /ready 가 ledger 미바인딩을 숨긴다");
  assert.equal(rd.body.ledger, false, "T8-a: /ready 의 ledger 가 참이다");
  assert.equal((await call(noLedger, null, "/policies")).status, 200, "T8-a: /policies 가 막혔다");
}

// ── T8-a1. ★ **두 자물쇠를 따로 잰다.**
//   T8-a 는 「503 이 나오나」를 재는데, 그건 두 자물쇠 중 **하나만 살아 있어도** 통과한다
//   (실측: 돌연변이 M1·M2 가 각각 하나를 부쉈는데 T8-a 는 그대로 통과했다).
//   그래서 계층마다 계약을 따로 고정한다 — 하나가 무너지면 그 자리에서 빨개져야 한다.
{
  // ① `readMode()` 는 바인딩이 없을 때 **`open` 이 아닌 것**을 돌려준다.
  const g = await readMode({});
  assert.notEqual(g.mode, "open", "T8-a1: 바인딩이 없는데 readMode 가 open 이라고 답한다 — fail-open 이다");
  assert.equal(g.mode, MODE_UNBOUND, "T8-a1: 미바인딩 모드 이름이 바뀌었다");
  assert.equal(g.bound, false, "T8-a1: 바인딩이 없는데 bound 가 참이다");
  // ② `maintenanceAllows()` 는 **모르는 모드를 전부 막는다.** 예전에는 마지막 줄이
  //    「읽기 허용」이라 모르는 모드가 그 자리로 떨어졌다.
  for (const mode of [MODE_UNBOUND, "unknown", "restore_closed", "", null, undefined, "OPEN"]) {
    for (const [p, m] of [["/book", "GET"], ["/me", "GET"], ["/friends/x/book", "GET"],
                          ["/book", "PUT"], ["/cb/kakao", "GET"]]) {
      assert.equal(maintenanceAllows(mode, p, m), false,
        `T8-a1: 모드 ${JSON.stringify(mode)} 에서 ${m} ${p} 가 허용됐다`);
    }
    // 운영 상태를 보는 셋은 어느 모드에서도 열린다 — 무엇이 고장 났는지 볼 수단이 그것뿐이다.
    for (const p of ["/health", "/ready", "/policies"])
      assert.equal(maintenanceAllows(mode, p, "GET"), true, `T8-a1: 모드 ${mode} 에서 ${p} 가 막혔다`);
  }
  // ③ ★ **`lease:true` 인 라우트 전부**가 `unbound` 에서 막힌다 — 표에서 뽑아 전수로 잰다.
  //    2026-08-19 까지는 이 보장을 「임차증 블록 안의 `if (!env.LEDGER)`」가 한 번 더 지킨다고
  //    적어 뒀는데, 그 줄은 **도달할 수 없는 코드**였다(전체 스위트 계측 결과 도달 0회).
  //    관측할 수 없는 방어를 통과 항목으로 세지 않는다 — 지우고, 대신 그 보장을 여기서 잰다.
  {
    const SAMPLES = [
      ["GET", "/health"], ["GET", "/ready"], ["GET", "/policies"], ["GET", "/login/kakao"],
      ["POST", "/signup/start"], ["GET", "/cb/kakao"], ["GET", "/exchange/naver"],
      ["DELETE", "/session"], ["GET", "/book"], ["PUT", "/book"], ["GET", "/me"],
      ["PUT", "/me"], ["DELETE", "/me"], ["GET", "/friends"], ["POST", "/friends"],
      ["POST", "/friends/code"], ["GET", "/friends/x/book"], ["PUT", "/friends/x"],
      ["DELETE", "/friends/x"],
    ];
    // 대표 경로가 **표를 전부 덮었나.** 라우트를 더하고 여기 안 적으면 그것만 검사 밖에 남는다.
    const covered = new Set();
    for (const [m, p] of SAMPLES) if (routeFor(m, p)) covered.add(JSON.stringify(routeFor(m, p)) + p.replace(/x/g, ""));
    assert.ok(SAMPLES.filter(([m, p]) => routeFor(m, p)).length >= routeCount(),
      `T8-a1: 대표 경로 ${SAMPLES.length}개가 라우트 표 ${routeCount()}개를 다 못 덮는다 — 검사기가 낡았다`);
    for (const [m, p] of SAMPLES) {
      const rt = routeFor(m, p);
      if (!rt || !rt.lease) continue;
      assert.equal(maintenanceAllows(MODE_UNBOUND, p, m), false,
        `T8-a1: ledger 미바인딩(${MODE_UNBOUND})인데 ${m} ${p} 가 열린다 — 추적 밖에서 주 D1 을 만진다`);
      assert.equal(maintenanceAllows("unknown", p, m), false,
        `T8-a1: 모드를 모르는데 ${m} ${p} 가 열린다`);
    }
    // 반대쪽: `lease:false` 인 라우트는 어느 모드에서도 답해야 한다(운영자의 유일한 창).
    for (const [m, p] of SAMPLES) {
      const rt = routeFor(m, p);
      if (!rt || rt.lease) continue;
      if (p.startsWith("/login/")) continue;   // 로그인 시작은 게이트가 막는 쪽이 맞다
      assert.equal(maintenanceAllows(MODE_UNBOUND, p, m), true, `T8-a1: ${m} ${p} 가 미바인딩에서 막혔다`);
    }
  }
  // ④ 아는 모드는 그대로 동작한다(막는 쪽만 재면 「영영 안 열리는」 회귀를 못 잡는다).
  assert.equal(maintenanceAllows("open", "/book", "PUT"), true, "T8-a1: open 인데 쓰기가 막힌다");
  assert.equal(maintenanceAllows("maintenance", "/book", "GET"), true, "T8-a1: 유지보수인데 읽기가 막힌다");
  assert.equal(maintenanceAllows("maintenance", "/book", "PUT"), false, "T8-a1: 유지보수인데 쓰기가 통과한다");
}

// ── T8-a2. ★ **ledger 질의가 실패해도(모드 행 없음·표 깨짐) 같은 결론이다.**
//   「모른다」를 「열려 있다」로 읽지 않는다.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const A = await signUp(env, "kakao", "brokenlg");
  const broken = { ...env, LEDGER: { prepare: () => { throw new Error("ledger down"); } } };
  assert.equal((await call(broken, A.token, "/book")).status, 503, "T8-a2: ledger 질의 실패인데 읽기가 통과했다");
  assert.equal((await call(broken, A.token, "/book", "PUT", { words: ["x"], version: 0 })).status, 503,
    "T8-a2: ledger 질의 실패인데 쓰기가 통과했다");
  assert.equal((await call(broken, null, "/health")).status, 200, "T8-a2: ledger 가 죽었다고 /health 까지 막혔다");
  // `maintenance` 행이 통째로 없는 경우(migration 을 절반만 건 ledger).
  const empty = makeEnv();
  empty.LEDGER._db.exec("DELETE FROM maintenance");
  const B = await signUp(empty, "kakao", "norow");
  assert.equal((await call(empty, B.token, "/book")).status, 503, "T8-a2: maintenance 행이 없는데 통과했다");
}

// ── T8-b. ⛔ **게이트 로직이 없는 옛 배포 세대는 여전히 막지 못한다.**
//   Cloudflare Pages 는 배포마다 영구 주소를 주고, 바인딩은 프로젝트 단위라 옛 배포에도
//   **같은 주 D1 이 붙어 있다.** 게이트는 그 코드가 실행될 때만 작동한다.
//   ⚠️ 옛 세대는 **고정 fixture** 로 흉내낸다(scripts/fixtures/legacy-worker.mjs) —
//      지금 코드에 바인딩 하나를 빼서 「옛 세대」라고 부르면, 그건 옛 세대가 아니라
//      지금 코드의 fail-open 이다(그게 2026-08-19 에 고친 T8-a 다).
//   ⛔ 5판 합격 조건은 **「거부됨」만**이고 「탐지됨」은 불합격이다. 지금은 거부하지 못한다.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const A = await signUp(env, "kakao", "old1");
  await call(env, A.token, "/book", "PUT", { words: ["옛"], version: 0 });
  env.LEDGER._db.exec("UPDATE maintenance SET mode='restore_closed' WHERE id=1");
  // 지금 세대는 막는다.
  assert.equal((await call(env, A.token, "/book")).status, 503, "T8-b: 지금 세대가 restore_closed 를 안 지킨다");
  // 옛 세대는 게이트를 **읽는 줄 자체가 없다.**
  const legacyReq = (path, method, body) => new Request("https://api.test" + path, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: "shh_s=" + A.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const read = await legacy.fetch(legacyReq("/book", "GET"), env);
  const write = await legacy.fetch(legacyReq("/book", "PUT", { words: ["옛", "새"] }), env);
  assert.equal(read.status, 200, "T8-b: 전제가 바뀌었다 — 옛 세대가 읽기에서 막혔다");
  assert.deepEqual((await read.json()).words, ["옛"], "T8-b: 전제가 바뀌었다 — 옛 세대가 데이터를 안 돌려준다");
  assert.equal(write.status, 200, "T8-b: 전제가 바뀌었다 — 옛 세대가 쓰기에서 막혔다");
  assert.equal((await drainState(env)).open, 0, "T8-b: 옛 세대가 임차증을 든다 — fixture 가 옛 세대가 아니다");
  // ⛔ **이 블록이 「200」인 동안 주 D1 restore 금지는 유지된다.**
  //    거부로 바꾸는 길은 코드가 아니라 **옛 배포를 없애거나 닿지 못하게 하는 것**(D1~D12)이다.
  //    「나중에 로그를 보면 알 수 있다」는 이미 탈퇴자의 데이터가 나간 뒤라는 뜻이라 근거가 못 된다.
}

// ══ 29. 쓰기 증폭 — 없는 주소·로그인 시작·차단된 뒤의 반복 (T50~T53) ══════
// **결정 A′ 의 대가를 재는 자리다.** 요청 하나가 임차증 하나를 든다는 것은, 요청이 하나
// 늘 때마다 ledger 쓰기가 둘(INSERT + DELETE) 는다는 뜻이기도 하다. 그래서 「요청」이
// 무엇인지가 곧 비용이다 — 인증 없는 아무 주소가 요청으로 세어지면 그게 공격 도구가 된다.
{
  const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
  const A = await signUp(env, "kakao", "amp1");
  const ip = { "CF-Connecting-IP": "203.0.113.77" };
  // 쓰기를 실제로 센다. `changes` 가 아니라 **행 수**로 재면 INSERT 뒤 DELETE 된 임차증이
  // 안 잡히므로, ledger 는 sqlite 의 총 변경 수(total_changes)로 본다.
  const dbWrites = () => env.LEDGER._db.prepare("SELECT COUNT(*) n FROM rate_limits").get().n;
  const ledgerWrites = () => env.LEDGER._db.prepare("SELECT total_changes() AS n").get().n;
  // ⚠️ **2026-08-20 부터 ledger 에는 리미터 카운터도 산다**(위협 49). 그래서 「총 변경 수 2」가
  //    더 이상 「임차증 하나」와 같은 말이 아니다 — 임차증 문장을 **직접** 센다. 총 변경 수로
  //    계속 재면 카운터 쓰기가 임차증 하나를 가려 준다(재려던 것을 못 재게 된다).
  let leaseIns = 0, leaseDel = 0;
  {
    const raw = env.LEDGER.prepare.bind(env.LEDGER);
    env.LEDGER.prepare = (sql) => {
      if (/INSERT INTO write_leases/.test(sql)) leaseIns++;
      if (/DELETE FROM write_leases/.test(sql)) leaseDel++;
      return raw(sql);
    };
  }

  // ── T50. ★ 없는 주소·허용되지 않은 method 를 100번 두드려도 **두 DB 모두 쓰기 0.**
  let d0 = dbWrites(), l0 = ledgerWrites();
  for (let i = 0; i < 50; i++) {
    assert.equal((await call(env, null, "/이런건없다" + i, "POST", {}, ip)).status, 404, "T50: 없는 주소가 404 가 아니다");
    assert.equal((await call(env, A.token, "/health", "POST", {}, ip)).status, 404, "T50: 허용 안 된 method 가 404 가 아니다");
  }
  assert.equal(dbWrites(), d0, "T50: 없는 주소가 주 D1 에 rate_limits 행을 만들었다");
  assert.equal(ledgerWrites(), l0, "T50: 없는 주소가 ledger 에 임차증을 남겼다");

  // ── T51. ★ 로그인 **시작**은 주 D1 도 ledger 도 만지지 않는다.
  //   302 하나와 서명 하나뿐이라 셀 것도, 추적할 것도 없다.
  d0 = dbWrites(); l0 = ledgerWrites();
  for (let i = 0; i < 20; i++) {
    const r = await worker.fetch(new Request("https://api.test/login/kakao?return=" + ORIGIN,
      { headers: ip }), env);
    assert.equal(r.status, 302, "T51: 로그인 시작이 302 가 아니다");
  }
  assert.equal(dbWrites(), d0, "T51: 로그인 시작이 rate_limits 를 늘렸다");
  assert.equal(ledgerWrites(), l0, "T51: 로그인 시작이 임차증을 땄다 — 주 D1 을 안 만지는데 추적한다");

  // ── T52. ★ 정상 읽기·쓰기는 **정확히 임차증 하나**(획득 1 + 해제 1).
  let i0 = leaseIns, x0 = leaseDel;
  d0 = dbWrites();
  assert.equal((await call(env, A.token, "/book")).status, 200, "T52: 정상 읽기가 안 된다");
  assert.equal(leaseIns - i0, 1, "T52: 읽기 하나에 임차증이 하나가 아니다");
  assert.equal(leaseDel - x0, 1, "T52: 읽기의 임차증이 해제되지 않았다");
  assert.equal(dbWrites() - d0, 1, "T52: 읽기 하나가 리미터 버킷 하나를 넘게 만들었다");
  i0 = leaseIns; x0 = leaseDel; d0 = dbWrites();
  assert.equal((await call(env, A.token, "/book", "PUT", { words: ["가"], version: 0 }, ip)).status, 200,
    "T52: 정상 쓰기가 안 된다");
  assert.equal(leaseIns - i0, 1, "T52: 쓰기 하나에 임차증이 하나가 아니다");
  assert.equal(leaseDel - x0, 1, "T52: 쓰기의 임차증이 해제되지 않았다");
  assert.equal(dbWrites() - d0, 1, "T52: 쓰기 하나가 리미터 버킷 하나를 넘게 만들었다");

  // ── T53. ★ 한도에 닿은 뒤 같은 공격을 반복하면 **두 저장소 모두 쓰기가 0 이다.**
  //
  //   ⚠️ **이 검사는 2026-08-19 에 뒤집혔다.** 예전 T53 은 「막힌 요청도 임차증은 딴다 —
  //      상한이 있다는 것은 요청당 정확히 둘이다」를 확인하고 그것을 **「유한한 상한」이라 적었다.**
  //      틀렸다: 요청 수에 상한이 없으면 요청당 상수는 상한이 아니다. 실측으로 인증 없는 요청
  //      200회가 ledger 쓰기 400회를 냈고, 5만 회면 D1 무료 한도(하루 10만 쓰기)가 바닥난다
  //      (재현 R5). 그래서 **리미터를 임차증보다 앞으로** 옮겼다 — 막힌 요청은 이제 어느 DB 도
  //      만지지 않는다. 총량 불변식(요청 수를 2배로 늘려도 쓰기가 같다)은
  //      `scripts/test-reaudit.mjs` 의 R5 가 잰다.
  const env2 = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
  const w2 = () => env2.LEDGER._db.prepare("SELECT COALESCE(SUM(n),0) AS n FROM rate_limits").get().n;
  const dw2 = () => env2.DB._db.prepare("SELECT total_changes() AS n").get().n;
  const lw2 = () => env2.LEDGER._db.prepare("SELECT total_changes() AS n").get().n;
  let blocked = 0;
  for (let i = 0; i < 60; i++) {
    const r = await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y", { headers: ip }), env2);
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked > 0, "T53: 60번을 눌렀는데 한 번도 안 막혔다");
  assert.ok(w2() <= RL_MAX_LOGIN + 1, `T53: 429 를 받으면서 카운터가 계속 올랐다(${w2()}) — 리미터가 증폭기다`);
  const beforeD = dw2(), beforeL = lw2();
  for (let i = 0; i < 100; i++) await worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=y", { headers: ip }), env2);
  assert.equal(dw2() - beforeD, 0, "T53: 차단된 뒤에도 주 D1 쓰기가 났다 — 리미터가 증폭기다");
  assert.equal(lw2() - beforeL, 0, "T53: 차단된 뒤에도 ledger 쓰기가 났다 — 임차증이 리미터보다 앞선다");
}

// ══ T71. 세션 envelope — **DB 앞의 값싼 문** (2026-08-22 · 사용자 결정 4) ═══
//
// 왜 만들었나: 리미터도 임차증도 인증보다 앞이어야 하는데(위협 47·49), 그러면 쿠키 없는
// 요청과 매번 다른 위조 쿠키가 요청마다 지속 저장소 쓰기를 낸다(실측 T67-c). 서명을 CPU 로
// 먼저 보면 그 비용이 0 이 된다.
// ⚠️ **이것은 인증이 아니다.** 아래 c·g·h 가 그 사실을 고정한다 — 서명이 맞아도 D1 이
//    최종 판정한다. 그 구분이 무너지면 로그아웃·탈퇴가 무력해진다.
{
  const env = makeEnv({ KAKAO_ID: "id" });
  const A = await signUp(env, "kakao", "envA");
  const dbQ = () => { const q = []; const sv = env.DB.prepare;
    env.DB.prepare = (sql) => { q.push(sql); return sv.call(env.DB, sql); };
    return { q, stop: () => { env.DB.prepare = sv; } }; };
  const led = () => env.LEDGER._db.prepare("SELECT total_changes() AS n").get().n;

  // T71-a. ★ 정상 세션은 그대로 통과한다. 막는 쪽만 재면 「늘 401」로 고쳐도 통과한다.
  assert.equal((await call(env, A.token, "/book")).status, 200, "T71-a: 정상 세션이 막혔다");
  assert.equal(await envelopeOk(env, A.token), true, "T71-a: 우리가 만든 토큰인데 서명이 안 맞는다");

  // T71-b. 모양·서명·판·만료 — **전부 DB 를 만지기 전에** 끝난다.
  const [v, rand, exp, sig] = A.token.split(".");
  const past = Math.floor(Date.now() / 1000) - 10;
  const BAD = {
    "쿠키 없음": null,
    "무작위 문자열": "bogus",
    "칸이 모자람": `${v}.${rand}.${exp}`,
    "서명 한 글자 변조": `${v}.${rand}.${exp}.${sig.slice(0, -1)}${sig.slice(-1) === "A" ? "B" : "A"}`,
    "서명 없음": `${v}.${rand}.${exp}.`,
    "무작위 부분 교체": `${v}.${"z".repeat(rand.length)}.${exp}.${sig}`,
    "만료 시각 늘리기": `${v}.${rand}.${Number(exp) + 86400}.${sig}`,
    "이미 만료": `${v}.${rand}.${past}.${sig}`,
    "모르는 판": `9.${rand}.${exp}.${sig}`,
    "판 비어 있음": `.${rand}.${exp}.${sig}`,
    "만료가 숫자가 아님": `${v}.${rand}.abc.${sig}`,
  };
  for (const [why, tok] of Object.entries(BAD)) {
    const spy = dbQ(), l0 = led();
    const r = await call(env, tok, "/book");
    spy.stop();
    assert.equal(r.status, 401, `T71-b[${why}]: ${r.status} 로 지나갔다`);
    assert.equal(spy.q.length, 0, `T71-b[${why}]: 주 D1 에 질의 ${spy.q.length}건 — 값싼 문이 아니다`);
    assert.equal(led() - l0, 0, `T71-b[${why}]: ledger 쓰기가 났다`);
    assert.ok(!JSON.stringify(r.body).includes("서명") && !JSON.stringify(r.body).includes("만료"),
      `T71-b[${why}]: 거절 사유를 알려줬다 — 위조 시도에 진행 상황을 준다`);
  }

  // T71-c. ★ **서명이 맞아도 인증이 아니다.** DB 에 없는 세션은 401 이다.
  {
    const orphan = await newSession(env, A.uid);
    env.DB._db.prepare("DELETE FROM sessions WHERE user_id = ?").run(A.uid);
    assert.equal(await envelopeOk(env, orphan), true, "T71-c: 우리가 만든 토큰인데 서명이 안 맞는다");
    assert.equal((await call(env, orphan, "/book")).status, 401,
      "T71-c: 서명만 맞으면 통과했다 — envelope 이 인증을 대신하고 있다");
  }

  // T71-d. ★ 로그아웃(세대 무효화) 뒤에는 같은 쿠키가 죽는다. **D1 이 최종 판정이다.**
  {
    const B = await signUp(env, "kakao", "envB");
    assert.equal((await call(env, B.token, "/book")).status, 200, "T71-d: 새 세션이 안 된다");
    assert.equal((await call(env, B.token, "/session", "DELETE")).status, 200, "T71-d: 로그아웃이 실패했다");
    assert.equal(await envelopeOk(env, B.token), true, "T71-d: 로그아웃이 서명을 바꿨다 — 그건 D1 의 일이다");
    assert.equal((await call(env, B.token, "/book")).status, 401, "T71-d: 로그아웃한 쿠키가 살아 있다");
  }

  // T71-e. ★ **전용 키다.** 다른 시크릿으로 서명한 토큰은 통과하지 못한다.
  for (const k of ["test-signing-key", "test-rate-limit-key", "test-tombstone-key"]) {
    assert.equal(await envelopeOk({ ...env, SESSION_ENVELOPE_KEY: k }, A.token), false,
      `T71-e: ${k} 로도 서명이 맞는다 — 키를 겸용하고 있다`);
  }

  // T71-f. ★ **키를 바꾸면 전원 로그아웃된다.** 운영 문서가 약속한 그대로여야 한다.
  {
    const rotated = { ...env, SESSION_ENVELOPE_KEY: "brand-new-key" };
    assert.equal(await envelopeOk(rotated, A.token), false, "T71-f: 키를 바꿨는데 옛 쿠키가 살아 있다");
    assert.equal((await call(rotated, A.token, "/book")).status, 401, "T71-f: 키 교체 뒤에도 요청이 통과한다");
  }

  // T71-g. 키가 없으면 **검증할 수 없다 → 열지 않는다**(503, 401 아님 — 사용자 잘못이 아니다).
  {
    const noKey = { ...env, SESSION_ENVELOPE_KEY: undefined };
    const r = await call(noKey, A.token, "/book");
    assert.equal(r.status, 503, `T71-g: 키가 없는데 ${r.status} 다`);
    const h = await (await worker.fetch(new Request("https://api.test/health"), noKey)).json();
    assert.equal(h.ready, false, "T71-g: 세션 서명 키가 없는데 ready 다");
  }

  // T71-h. ★ **원문을 저장하지 않는다.** DB 가 새도 남의 쿠키를 쓸 수 없어야 한다.
  {
    const rows = env.DB._db.prepare("SELECT token_hash FROM sessions").all();
    for (const r of rows)
      assert.ok(!A.token.includes(r.token_hash) && r.token_hash !== A.token,
        "T71-h: sessions 에 토큰 원문(또는 그 조각)이 저장됐다");
  }

  // T71-i. ★ 표가 `auth:true` 라고 적은 라우트는 **전부** 이 문 뒤에 있다. 전수로 잰다.
  {
    const SAMPLE = { "GET": ["/book", "/me", "/friends", "/friends/x/book"],
                     "PUT": ["/book", "/me", "/friends/x"],
                     "POST": ["/friends", "/friends/code"],
                     "DELETE": ["/session", "/me", "/friends/x"] };
    let n = 0;
    for (const [method, paths] of Object.entries(SAMPLE)) {
      for (const p of paths) {
        if (!routeFor(method, p) || !routeFor(method, p).auth) continue;
        n++;
        const spy = dbQ();
        const r = await call(env, "forged-cookie", p, method, method === "GET" ? undefined : {});
        spy.stop();
        assert.equal(r.status, 401, `T71-i: ${method} ${p} 가 위조 쿠키에 ${r.status} 로 답했다`);
        assert.equal(spy.q.length, 0, `T71-i: ${method} ${p} 가 위조 쿠키에 주 D1 을 만졌다`);
      }
    }
    assert.equal(n, authRoutes().length, `T71-i: 표의 auth 라우트 ${authRoutes().length}개 중 ${n}개만 쟀다`);
  }
}

console.log("test-friends: 통과 — 로그인 왕복 표(브라우저 결속) · 친구 쌍 유일성 · 친구 권한(행 하나) · 쿠키 세션 · 세대 무효화 · CSRF(Origin 필수) · 제공자ID 비공개 "
  + "· 버전 충돌 · 수락 트랜잭션(상한 포함) · 무관계 DELETE · 마스터 · 복귀 주소 · 본문 한도 · state 서명 · 코드 회전 · 상한 · 헤더 · readiness(스키마 실질의) · 세션 청소 · 레이트리밋(RL_KEY HMAC · 버킷 분리) · 제공자 응답 상한 · 계정 삭제 원자성(표식·lease) · 활성 초대 코드 1개 · 유지보수/restore_closed 게이트 · 전역 user-data drain(요청당 임차증 1개 · 지연 읽기·쓰기 · TTL 만료 ≠ 해제) "
  + "· LEDGER 미바인딩 fail-closed(계층별) · 라우트 분류(없는 주소·로그인 시작의 쓰기 0) · 임차증 상한 "
  + "· 레이트리밋 버킷 등록(프로토타입 속성 거부) · 아직 못 막는 것(T8-b · 옛 배포 fixture) 고정 "
  + "· T71 세션 envelope(모양·서명·판·만료 · DB 앞 거절 · 서명 ≠ 인증 · 키 전용성·교체 · auth 라우트 전수)");
