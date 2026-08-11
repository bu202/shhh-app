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
    env.DB._db.prepare("INSERT INTO friendships (requester_id,addressee_id,status,created_at) VALUES (?,?,'accepted',0)")
      .run(A.uid, f.uid);
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
  env.DB._db.prepare("INSERT INTO friendships (requester_id,addressee_id,status,created_at) VALUES (?,?,'accepted',0)")
    .run(B.uid, Q.uid);

  // 64. 관계가 없으면 거부한다.
  const res = await call(env, A.token, "/friends/" + B.uid, "DELETE");
  assert.equal(res.status, 404, "관계없는 타인에 대한 DELETE 가 통과했다");
  // 65. **상대의 관계가 그대로 보존된다.** 상태 코드만 보면 "거부했지만 이미 지웠다"를 놓친다.
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM friendships WHERE requester_id=?").get(B.uid).n, 1,
    "남의 친구 관계가 지워졌다");
  // 66. 진짜 관계는 지워지고, **반복해도 안전하다**(두 번째는 404, 쓰기 없음).
  env.DB._db.prepare("INSERT INTO friendships (requester_id,addressee_id,status,created_at) VALUES (?,?,'accepted',0)")
    .run(A.uid, B.uid);
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
  const full = makeEnv({ KAKAO_ID: "id", GOOGLE_ID: "id" });
  const h1 = await (await get("/health", full)).json();
  assert.deepEqual(h1.providers, ["kakao", "google"], "설정된 제공자만 오지 않는다");
  assert.equal((await get("/ready", full)).status, 200, "다 설정됐는데 /ready 가 503 이다");
  // 69. DB 바인딩이 없으면 ready 가 아니다 — 로그인도 단어장도 못 한다.
  assert.equal((await (await get("/health", { ...full, DB: undefined })).json()).ready, false, "DB 없이 ready 다");

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

console.log("test-friends: 75개 통과 — 친구 권한(행 하나) · 쿠키 세션 · 세대 무효화 · CSRF · 제공자ID 비공개 "
  + "· 버전 충돌 · 수락 트랜잭션 · 무관계 DELETE · 마스터 · 복귀 주소 · 본문 한도 · state 서명 · 코드 회전 · 상한 · 헤더");
