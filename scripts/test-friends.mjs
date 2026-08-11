// 친구(요청 → 수락) 규칙 검증. `node scripts/test-friends.mjs`
// worker/index.js 를 **그대로 불러** 가짜 KV 위에서 돌린다 — 규칙을 테스트에 베끼지 않는다.
// 여기가 틀리면 증상이 "남의 단어장이 보인다"라서 사람 눈으로는 늦게 잡힌다.
import assert from "node:assert";
import worker from "../worker/index.js";

const ORIGIN = "https://app.test";
function makeEnv() {
  const kv = new Map();
  return {
    APP_ORIGIN: ORIGIN,
    STATE_KEY: "test-signing-key",
    KV: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
      // 로그아웃·탈퇴가 세션을 훑어 지운다. 실제 KV 와 달리 여기선 즉시 일관적이다 —
      // 최종 일관성(최대 60초)은 이 테스트가 재는 것이 아니다(worker 주석에 한도로 적어 뒀다).
      list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
    _kv: kv,
  };
}

// 토큰은 `<b64u(uid)>.<무작위>` 다 — worker 의 mkToken 과 같은 모양이어야 한다.
// 모양이 어긋나면 uidOf 가 못 읽어 전부 401 이 나고, 그러면 이 파일 전체가 "로그인 실패"만 잰다.
const tok = (uid, tag) => Buffer.from(uid).toString("base64url") + "." + tag;
const [tokA, tokB, tokC] = [tok("kakao:A", "aaa"), tok("kakao:B", "bbb"), tok("kakao:C", "ccc")];

const env = makeEnv();
// 세션 세 개를 손으로 심는다. OAuth 왕복은 이 테스트의 관심사가 아니다.
for (const t of [tokA, tokB, tokC]) env._kv.set("s:" + uidOfTest(t) + ":" + t, "1");
function uidOfTest(t) { return Buffer.from(t.slice(0, t.indexOf(".")), "base64url").toString(); }

const call = async (token, path, method = "GET", body) => {
  const res = await worker.fetch(new Request("https://api.test" + path, {
    method, headers: { Authorization: "Bearer " + token, Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
};

// 단어장을 심어 둔다 — 친구 화면이 보여줄 것이 있어야 한다.
await call(tokA, "/book", "PUT", { words: ["사랑", "보고싶다"], name: "가" });
await call(tokB, "/book", "PUT", { words: ["고맙다"], name: "나" });

// 1. 로그인 없이는 아무것도 안 된다.
assert.equal((await worker.fetch(new Request("https://api.test/friends", { headers: { Origin: ORIGIN } }), env)).status, 401);

// 2. 내 초대 코드는 늘 같다. 바뀌면 예전에 보낸 링크가 죽는다.
const a1 = await call(tokA, "/friends");
const a2 = await call(tokA, "/friends");
assert.ok(a1.body.code && a1.body.code === a2.body.code, "초대 코드가 호출마다 바뀐다");
assert.deepEqual([a1.body.friends, a1.body.in, a1.body.out], [[], [], []]);

// 3. 자기 자신·엉뚱한 코드는 막는다.
assert.equal((await call(tokA, "/friends", "POST", { code: a1.body.code })).status, 400, "자기 자신");
assert.equal((await call(tokA, "/friends", "POST", { code: "없는코드" })).status, 404, "없는 코드");

// 4. B 가 A 의 링크를 연다 → **요청**이지 친구가 아니다. 여기가 이 기능의 핵심이다.
const sent = await call(tokB, "/friends", "POST", { code: a1.body.code });
assert.equal(sent.body.state, "sent", "링크를 열자마자 친구가 되면 안 된다");
assert.deepEqual((await call(tokB, "/friends")).body.friends, [], "보낸 쪽에 친구가 생겼다");
assert.equal((await call(tokA, "/friends")).body.in.length, 1, "받은 요청이 안 보인다");
assert.equal((await call(tokA, "/friends")).body.in[0].name, "나", "요청자 별명이 안 온다");

// 4b. 수락 전에는 **단어 개수도** 안 준다. 아직 서로 남이고, 개인정보처리방침은
//     "친구에게 보이는 것"으로만 적혀 있다 — 문서에 없는 걸 서버가 보내면 문서가 거짓말이 된다.
assert.ok(!("count" in (await call(tokA, "/friends")).body.in[0]), "받은 요청에 단어 개수가 실려 있다");
assert.ok(!("count" in (await call(tokB, "/friends")).body.out[0]), "보낸 요청에 단어 개수가 실려 있다");
assert.ok(!("count" in sent.body.friend), "요청을 보낸 응답에 단어 개수가 실려 있다");

// 5. 수락 전에는 단어장이 안 보인다. 이게 뚫리면 링크를 주운 사람이 남의 단어장을 본다.
assert.equal((await call(tokB, "/friends/kakao:A/book")).status, 403, "수락 전인데 단어장이 보인다");

// 6. 받지도 않은 요청을 수락할 수 없다 — C 가 임의로 A 를 친구로 만들면
//    A 는 보낸 적 없는 사람에게 단어장이 보이게 된다.
assert.equal((await call(tokC, "/friends/kakao:A", "PUT")).status, 400, "받은 적 없는 요청이 수락됐다");

// 7. A 가 수락 → 양쪽 다 친구. 한쪽만 되면 상대 화면에서 조용히 안 보인다.
await call(tokA, "/friends/kakao:B", "PUT");
assert.deepEqual((await call(tokA, "/friends")).body.friends.map((f) => f.uid), ["kakao:B"]);
assert.deepEqual((await call(tokB, "/friends")).body.friends.map((f) => f.uid), ["kakao:A"]);
assert.deepEqual((await call(tokA, "/friends")).body.in, [], "수락했는데 요청이 남았다");
assert.deepEqual((await call(tokB, "/friends")).body.out, [], "수락됐는데 보낸 요청이 남았다");

// 8. 이제 서로의 단어장이 보인다.
const seen = await call(tokB, "/friends/kakao:A/book");
assert.deepEqual(seen.body.words, ["사랑", "보고싶다"]);
assert.equal(seen.body.name, "가");

// 9. 친구 목록엔 단어 **개수만** 온다. 목록 화면에 안 쓰는 단어까지 실어 보내지 않는다.
assert.equal((await call(tokB, "/friends")).body.friends[0].count, 2);
assert.ok(!("words" in (await call(tokB, "/friends")).body.friends[0]), "목록에 단어가 실려 나온다");

// 10. 끊으면 양쪽에서 사라지고 단어장도 다시 막힌다.
await call(tokA, "/friends/kakao:B", "DELETE");
assert.deepEqual((await call(tokA, "/friends")).body.friends, []);
assert.deepEqual((await call(tokB, "/friends")).body.friends, [], "끊었는데 상대 목록에 남았다");
assert.equal((await call(tokB, "/friends/kakao:A/book")).status, 403, "끊었는데 단어장이 보인다");

// 11. 서로 링크를 주고받으면 수락을 기다리지 않고 맺어진다.
//     (둘 다 "수락 대기"로 멈춰 있으면 사용자는 뭘 눌러야 할지 모른다)
const bCode = (await call(tokB, "/friends")).body.code;
await call(tokA, "/friends", "POST", { code: bCode });
const mutual = await call(tokB, "/friends", "POST", { code: a1.body.code });
assert.equal(mutual.body.state, "ok", "서로 보냈는데 친구가 안 됐다");
assert.deepEqual((await call(tokA, "/friends")).body.friends.map((f) => f.uid), ["kakao:B"]);

// 12. 계정을 지우면 친구 쪽 목록에서도 사라진다. 안 그러면 이름 없는 친구가 남는다.
await call(tokA, "/me", "DELETE");
assert.deepEqual((await call(tokB, "/friends")).body.friends, [], "탈퇴한 사람이 친구 목록에 남았다");
assert.equal(env._kv.get("c:" + a1.body.code), undefined, "탈퇴했는데 초대 코드가 살아있다");

// ── 마스터 계정 ──
// 만든 사람 계정은 무료 벽에 안 걸린다. 판단은 **서버가** 한다 — 로컬에만 두면 폰을 바꾸는 순간
// 사라져서 새 기기에서 벽에 걸린다.
{
  const e2 = makeEnv();
  const [m, n] = [tok("kakao:BOSS", "mmm"), tok("kakao:NOBODY", "nnn")];
  e2._kv.set("s:kakao:BOSS:" + m, "1");
  e2._kv.set("s:kakao:NOBODY:" + n, "1");
  const get = async (t) => (await (await worker.fetch(new Request("https://api.test/book", {
    headers: { Authorization: "Bearer " + t, Origin: ORIGIN } }), e2)).json());

  // 13. 목록이 비어 있으면 아무도 마스터가 아니다(기본값이 안전한 쪽).
  assert.equal((await get(m)).pro, false, "MASTER_UIDS 가 비었는데 프로가 켜졌다");
  assert.equal((await get(m)).master, false, "MASTER_UIDS 가 비었는데 마스터가 켜졌다");

  e2.MASTER_UIDS = " kakao:BOSS , kakao:OTHER ";
  // 14. 목록에 있으면 프로. 공백이 섞여 있어도 읽어야 한다(secret 은 사람이 손으로 넣는다).
  assert.equal((await get(m)).pro, true, "마스터인데 프로가 안 켜졌다");
  assert.equal((await get(m)).master, true, "마스터인데 master 가 안 왔다 — 화면이 '프로'라고 부르게 된다");
  assert.equal((await get(n)).pro, false, "마스터가 아닌데 프로가 켜졌다");

  // 15. pro 는 **저장되지 않는다.** 레코드에 굳으면 목록에서 빼도 옛 레코드가 계속 프로라고 말한다.
  await worker.fetch(new Request("https://api.test/book", {
    method: "PUT", headers: { Authorization: "Bearer " + m, Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ words: ["사랑"], name: "" }) }), e2);
  const rec = JSON.parse(e2._kv.get("b:kakao:BOSS"));
  assert.ok(!("pro" in rec) && !("master" in rec), "pro/master 가 KV 레코드에 저장됐다");
  delete e2.MASTER_UIDS;
  assert.equal((await get(m)).pro, false, "목록에서 뺐는데 옛 레코드가 프로라고 말한다");
}

// ── 로그인 복귀 주소 (allowed) ──────────────────────────────────────────
// 여기가 틀리면 증상이 "남의 계정이 털린다"라서 화면으로는 영영 안 보인다.
// allowed() 는 CORS 와 복귀 주소를 **둘 다** 정하므로 두 축을 같이 잰다.
{
  const e3 = makeEnv();
  e3.KAKAO_ID = "test-client-id";   // 없으면 503 에서 멈춰 리다이렉트까지 못 간다
  const login = (ret, env = e3) =>
    worker.fetch(new Request("https://api.test/login/kakao" + (ret ? "?return=" + encodeURIComponent(ret) : "")), env);

  // 16. 운영 기본값(DEV_ORIGINS 없음)에서 LAN·localhost 는 거부된다.
  //     열려 있으면 `?return=http://192.168.x.x:8000` 으로 세션 토큰이 남의 서버로 간다.
  for (const bad of ["http://192.168.1.9:8000", "http://localhost:8000", "http://127.0.0.1:8000", "https://evil.example"])
    assert.equal((await login(bad)).status, 400, `${bad} 로 복귀가 허용됐다 — 세션 토큰이 새는 자리다`);

  // 17. 주소가 아닌 문자열도 400 이다. 500(예외)이 나면 안 된다.
  //     빈 문자열은 여기 없다 — "return 을 안 줬다"와 같아서 앱 주소로 폴백하는 게 맞다.
  for (const junk of ["not a url", "javascript:alert(1)"])
    assert.equal((await login(junk)).status, 400, `'${junk}' 가 400 이 아니다`);

  // 18. 앱 주소는 그대로 통과한다(302). 막으면 로그인이 통째로 죽는다.
  assert.equal((await login(ORIGIN + "/shhh-app/")).status, 302, "앱 주소로 못 돌아간다");
  assert.equal((await login(null)).status, 302, "return 없이(기본값 APP_ORIGIN) 로그인이 안 된다");

  // 19. 개발 Worker 에서는 여전히 열린다 — 폰 없이 확인하는 길을 막지 않았는지.
  assert.equal((await login("http://192.168.1.9:8000", { ...e3, DEV_ORIGINS: "1" })).status, 302, "DEV_ORIGINS=1 인데 LAN 이 막혔다");

  // 20. CORS 도 같은 판정을 쓴다. 낯선 Origin 에는 헤더를 안 붙인다.
  const pre = (o, env = e3) => worker.fetch(new Request("https://api.test/book", { method: "OPTIONS", headers: { Origin: o } }), env);
  assert.equal((await pre("http://192.168.1.9:8000")).headers.get("Access-Control-Allow-Origin"), null, "낯선 Origin 에 CORS 가 열렸다");
  assert.equal((await pre(ORIGIN)).headers.get("Access-Control-Allow-Origin"), ORIGIN, "앱 Origin 에 CORS 가 안 붙었다");
}

// ── 세션 무효화 · 본문 한도 ──────────────────────────────────────────────
// 로그아웃이 서버에 안 닿으면 KV 의 세션은 180일을 더 산다. 한 번 샌 토큰이
// 로그아웃 뒤에도 그대로 쓰인다는 뜻이라, 화면으로는 영영 안 보이는 종류의 구멍이다.
{
  const e4 = makeEnv();
  const phone = tok("kakao:A", "phone"), tablet = tok("kakao:A", "tablet"), other = tok("kakao:Z", "z");
  for (const [t, u] of [[phone, "kakao:A"], [tablet, "kakao:A"], [other, "kakao:Z"]]) e4._kv.set("s:" + u + ":" + t, "1");
  const c = async (t, path, method = "GET", body, headers = {}) => {
    const res = await worker.fetch(new Request("https://api.test" + path, {
      method,
      headers: { Authorization: "Bearer " + t, Origin: ORIGIN, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), e4);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // 21. 토큰에 담긴 uid 는 **주장**이다. KV 에 그 키가 없으면 남의 계정이 되지 않는다.
  assert.equal((await c(tok("kakao:A", "forged"), "/book")).status, 401, "지어낸 토큰으로 로그인이 됐다");

  // 22. 본문 한도. Node 의 Request 는 Content-Length 를 안 붙이므로 이 검사는 **chunked 경로**를
  //     그대로 잰다 — 헤더만 보고 막는 구현이면 여기서 통과해 버린다.
  assert.equal((await c(phone, "/book", "PUT", { words: ["x".repeat(9000)], name: "" })).status, 400, "8KB 넘는 본문이 통과했다");
  assert.equal((await c(phone, "/book", "PUT", { words: ["사랑"] }, { "Content-Type": "text/plain" })).status, 400, "JSON 이 아닌 본문이 통과했다");

  // 23. 로그아웃은 **이 계정의 모든 기기**를 끊고, 남의 세션은 안 건드린다.
  await c(phone, "/book", "PUT", { words: ["사랑"], name: "가" });
  assert.equal((await c(phone, "/session", "DELETE")).body.killed, 2, "로그아웃이 이 계정 세션을 다 안 끊었다");
  assert.equal((await c(tablet, "/book")).status, 401, "로그아웃했는데 다른 기기가 살아 있다");
  assert.equal((await c(other, "/book")).status, 200, "로그아웃이 남의 세션까지 끊었다");

  // 24. 탈퇴하면 다른 기기가 **되살리지 못한다.** 세션이 남으면 myCode() 가 초대 코드를,
  //     PUT /book 이 단어장을 다시 만들어 privacy.html 의 "그 자리에서 지워집니다"가 거짓이 된다.
  const back = tok("kakao:A", "back"), survivor = tok("kakao:A", "survivor");
  for (const t of [back, survivor]) e4._kv.set("s:kakao:A:" + t, "1");
  await c(back, "/friends");                 // 초대 코드를 만들어 둔다
  await c(back, "/me", "DELETE");
  assert.equal((await c(survivor, "/book")).status, 401, "탈퇴했는데 다른 기기 세션이 살아 있다");
  assert.equal((await c(survivor, "/friends")).status, 401, "탈퇴한 계정이 초대 코드를 되살릴 수 있다");
  assert.equal(e4._kv.get("b:kakao:A"), undefined, "탈퇴했는데 단어장이 남았다");
}

// ── state 서명 ───────────────────────────────────────────────────────────
{
  const e5 = makeEnv();
  e5.KAKAO_ID = "id"; e5.GOOGLE_ID = "id";
  const loc = (await worker.fetch(new Request("https://api.test/login/kakao"), e5)).headers.get("Location");
  const state = new URL(loc).searchParams.get("state");

  // 25. 로그인 시작이 KV 에 아무것도 쓰지 않는다. 여기는 **인증이 없는 자리**라,
  //     KV 를 쓰면 curl 반복만으로 무료 플랜의 하루치 쓰기(1,000회)를 태울 수 있다 —
  //     그러면 그날 남은 시간 동안 아무도 단어장을 저장하지 못한다.
  assert.equal(e5._kv.size, 0, "로그인 시작이 KV 에 썼다 — 인증 없이 하루치 쓰기를 태울 수 있다");

  // 26. 서명이 안 맞는 state 는 안 받는다. 받으면 남이 우리 도메인을 거쳐 아무 데로나 보낸다.
  const cb = (s) => worker.fetch(new Request("https://api.test/cb/kakao?code=x&state=" + encodeURIComponent(s)), e5);
  assert.equal((await cb("aaa.bbb")).status, 400, "위조 state 가 통과했다");
  assert.equal((await cb(state + "x")).status, 400, "서명을 고친 state 가 통과했다");
  assert.equal((await cb("")).status, 400, "빈 state 가 통과했다");

  // 27. 카카오로 시작한 state 를 구글 자리에서 쓸 수 없다.
  assert.equal((await worker.fetch(new Request("https://api.test/cb/google?code=x&state=" + encodeURIComponent(state)), e5)).status,
    400, "다른 제공자의 state 가 통과했다");
}

console.log("test-friends: 31개 통과 — 단어장 비공개 · 마스터 · 복귀 주소 · 세션 무효화 · 본문 한도 · state 서명");
