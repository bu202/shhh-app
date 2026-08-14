// 친구·세션·단어장 권한 검증. `node scripts/test-friends.mjs`
// worker/index.js 를 **그대로 불러** 진짜 sqlite(D1 셰임) 위에서 돌린다 — 규칙을 테스트에 베끼지 않는다.
// 여기가 틀리면 증상이 "남의 단어장이 보인다"라서 사람 눈으로는 늦게 잡힌다.
//
// ⚠️ 2026-08-11 에 저장소가 KV → D1, 세션이 Bearer → HttpOnly 쿠키로 바뀌었다.
//    **단언의 의도는 그대로 두고 전송 수단만 바꿨다** — 무엇을 지키는가는 안 바뀌었기 때문이다.
//    가짜 KV(Map)는 "절대 실패하지 않고 즉시 일관적인" 저장소라 재는 게 적었다(함정 50).
//    지금은 진짜 SQL 이라 UNIQUE 충돌·외래키 CASCADE·changes 카운트가 실제로 일어난다.
import assert from "node:assert";
import worker, { internalUid, newSession, pathTemplate } from "../worker/index.js";
import { makeD1 } from "./_d1.mjs";

const ORIGIN = "https://app.test";

function makeEnv(extra = {}) {
  return { APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "test-signing-key", DB: makeD1(), ...extra };
}

// 계정 하나 + 그 계정의 세션 하나. **진짜 코드 경로**를 쓴다 — 토큰 해시를 여기서 계산하면
// 그 순간 로직이 두 벌이 되어, 서버가 바뀌어도 테스트는 옛 규칙을 계속 통과시킨다.
async function signUp(env, provider, subject) {
  const uid = await internalUid(env, provider, subject);
  return { uid, token: await newSession(env, uid) };
}
const another = (env, uid) => newSession(env, uid);   // 같은 계정의 다른 기기

const call = async (env, token, path, method = "GET", body, extra = {}) => {
  const headers = { Origin: ORIGIN, "Content-Type": "application/json", ...extra };
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
  const sessions = () => env.DB._db.prepare("SELECT COUNT(*) n FROM sessions").get().n;
  const start = async (p = "kakao") => {
    const r = await worker.fetch(new Request(`https://api.test/login/${p}?n=nonce-1`), env);
    const set = r.headers.get("Set-Cookie") || "";
    return {
      state: new URL(r.headers.get("Location")).searchParams.get("state"),
      txn: (set.match(/shh_t=([^;]*)/) || [])[1] || "",
      set,
    };
  };
  const cb = (state, cookie) => worker.fetch(new Request(
    "https://api.test/cb/kakao?code=real-code&state=" + encodeURIComponent(state),
    cookie ? { headers: { Cookie: cookie } } : undefined), env);

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
    cookie ? { headers: { Cookie: cookie } } : undefined), env);
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
  // 36. 반쪽 인코딩(`%zz`)은 decodeURIComponent 가 던진다. 500 이 나가면 안 된다.
  assert.equal((await call(env, A.token, "/friends/%zz")).status, 400, "잘못된 인코딩이 500 을 냈다");

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
  assert.equal(await internalUid(env, "kakao", "1234567"), A.uid, "같은 제공자 계정이 다른 번호를 받았다");
  // 48. 다른 사람은 다른 번호.
  assert.notEqual(await internalUid(env, "kakao", "9999"), A.uid, "다른 계정이 같은 번호를 받았다");
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
  assert.equal((await worker.fetch(new Request("https://api.test/login/kakao"), env)).status, 429, "로그인 왕복이 안 막힌다");
  // 51. **읽기는 안 막는다.** 세면 정상 사용이 먼저 걸린다.
  assert.equal((await call(env, A.token, "/book")).status, 200, "읽기까지 막았다");
  // 52. 인증 전/후 버킷이 갈린다. 한 버킷이면 남의 로그인 시도가 내 저장을 막는다.
  assert.ok(calls.some((k) => k.startsWith("auth|")) && calls.some((k) => k.startsWith("write|")),
    "버킷이 안 갈렸다: " + JSON.stringify(calls));
  assert.ok(calls.includes("write|" + A.uid), "쓰기 키가 uid 기준이 아니다");
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
  const get = async (path, env) =>
    (await worker.fetch(new Request("https://api.test" + path, { headers: { Origin: ORIGIN } }), env));

  // 67. /health 는 설정이 없어도 200 이다 — "프로세스가 도나"를 재는 자리다.
  const h0 = await (await get("/health", bare)).json();
  assert.deepEqual(h0.providers, [], "설정이 없는데 제공자가 있다고 말한다");
  assert.equal(h0.ready, false, "설정이 없는데 ready 다");
  // 68. /ready 는 설정이 덜 됐으면 503 이다.
  assert.equal((await get("/ready", bare)).status, 503, "설정이 없는데 /ready 가 200 이다");
  const full = makeEnv({ KAKAO_ID: "id", GOOGLE_ID: "id", GOOGLE_SECRET: "s" });
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
  const env = makeEnv({ KAKAO_ID: "id", NAVER_ID: "id", NAVER_SECRET: "s", GOOGLE_ID: "id", GOOGLE_SECRET: "s" });
  const ready = await worker.fetch(new Request("https://api.test/ready"), env);
  assert.equal(ready.status, 200, "정상 스키마인데 준비 안 됐다고 한다");

  env.DB._db.exec("DROP TABLE rate_limits");
  const gone = await worker.fetch(new Request("https://api.test/ready"), env);
  assert.equal(gone.status, 503, "테이블이 통째로 없는데 준비됐다고 한다");
  assert.equal((await gone.json()).db, false, "db 항목이 실패를 안 알린다");

  // 77. **컬럼까지** 본다. 0002·0003 이 원격에 안 걸린 상태가 정확히 이 모양이다.
  const env2 = makeEnv({ KAKAO_ID: "id", NAVER_ID: "id", NAVER_SECRET: "s", GOOGLE_ID: "id", GOOGLE_SECRET: "s" });
  env2.DB._db.exec("DROP TABLE friendships");
  env2.DB._db.exec("CREATE TABLE friendships (requester_id TEXT, addressee_id TEXT, status TEXT, created_at INTEGER)");
  assert.equal((await worker.fetch(new Request("https://api.test/ready"), env2)).status, 503,
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

  // 86. **읽기는 안 센다.** 남용해도 남는 게 없고, 세면 정상 사용이 먼저 걸린다.
  for (let i = 0; i < 30; i++) assert.equal((await call(env, A.token, "/friends")).status, 200, "읽기가 막혔다");

  // 87. 세는 단위는 사람이다 — 한 사람이 막혔다고 다른 사람까지 막히면 그건 방어가 아니라 고장이다.
  assert.equal((await call(env, B.token, "/friends", "POST", { code: "없는코드" })).status, 404,
    "남이 두드렸다고 이 사람까지 막혔다");

  // 88. 카운터에 **원문 uid·IP 가 남지 않는다.** 남용을 세려고 개인정보를 쌓지 않는다.
  for (const row of env.DB._db.prepare("SELECT bucket FROM rate_limits").all()) {
    assert.ok(!row.bucket.includes(A.uid) && !row.bucket.includes(B.uid), "리미터 키에 uid 원문이 남았다");
  }
}

console.log("test-friends: 109개 통과 — 로그인 왕복 표(브라우저 결속) · 친구 쌍 유일성 · 친구 권한(행 하나) · 쿠키 세션 · 세대 무효화 · CSRF(Origin 필수) · 제공자ID 비공개 "
  + "· 버전 충돌 · 수락 트랜잭션(상한 포함) · 무관계 DELETE · 마스터 · 복귀 주소 · 본문 한도 · state 서명 · 코드 회전 · 상한 · 헤더 · readiness(스키마 실질의) · 세션 청소 · 레이트리밋");
