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
    KV: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
    },
    _kv: kv,
  };
}

const env = makeEnv();
// 세션 두 개를 손으로 심는다. OAuth 왕복은 이 테스트의 관심사가 아니다.
for (const [t, u] of [["tokA", "kakao:A"], ["tokB", "kakao:B"], ["tokC", "kakao:C"]]) env._kv.set("s:" + t, u);

const call = async (token, path, method = "GET", body) => {
  const res = await worker.fetch(new Request("https://api.test" + path, {
    method, headers: { Authorization: "Bearer " + token, Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
};

// 단어장을 심어 둔다 — 친구 화면이 보여줄 것이 있어야 한다.
await call("tokA", "/book", "PUT", { words: ["사랑", "보고싶다"], name: "가" });
await call("tokB", "/book", "PUT", { words: ["고맙다"], name: "나" });

// 1. 로그인 없이는 아무것도 안 된다.
assert.equal((await worker.fetch(new Request("https://api.test/friends", { headers: { Origin: ORIGIN } }), env)).status, 401);

// 2. 내 초대 코드는 늘 같다. 바뀌면 예전에 보낸 링크가 죽는다.
const a1 = await call("tokA", "/friends");
const a2 = await call("tokA", "/friends");
assert.ok(a1.body.code && a1.body.code === a2.body.code, "초대 코드가 호출마다 바뀐다");
assert.deepEqual([a1.body.friends, a1.body.in, a1.body.out], [[], [], []]);

// 3. 자기 자신·엉뚱한 코드는 막는다.
assert.equal((await call("tokA", "/friends", "POST", { code: a1.body.code })).status, 400, "자기 자신");
assert.equal((await call("tokA", "/friends", "POST", { code: "없는코드" })).status, 404, "없는 코드");

// 4. B 가 A 의 링크를 연다 → **요청**이지 친구가 아니다. 여기가 이 기능의 핵심이다.
const sent = await call("tokB", "/friends", "POST", { code: a1.body.code });
assert.equal(sent.body.state, "sent", "링크를 열자마자 친구가 되면 안 된다");
assert.deepEqual((await call("tokB", "/friends")).body.friends, [], "보낸 쪽에 친구가 생겼다");
assert.equal((await call("tokA", "/friends")).body.in.length, 1, "받은 요청이 안 보인다");
assert.equal((await call("tokA", "/friends")).body.in[0].name, "나", "요청자 별명이 안 온다");

// 4b. 수락 전에는 **단어 개수도** 안 준다. 아직 서로 남이고, 개인정보처리방침은
//     "친구에게 보이는 것"으로만 적혀 있다 — 문서에 없는 걸 서버가 보내면 문서가 거짓말이 된다.
assert.ok(!("count" in (await call("tokA", "/friends")).body.in[0]), "받은 요청에 단어 개수가 실려 있다");
assert.ok(!("count" in (await call("tokB", "/friends")).body.out[0]), "보낸 요청에 단어 개수가 실려 있다");
assert.ok(!("count" in sent.body.friend), "요청을 보낸 응답에 단어 개수가 실려 있다");

// 5. 수락 전에는 단어장이 안 보인다. 이게 뚫리면 링크를 주운 사람이 남의 단어장을 본다.
assert.equal((await call("tokB", "/friends/kakao:A/book")).status, 403, "수락 전인데 단어장이 보인다");

// 6. 받지도 않은 요청을 수락할 수 없다 — C 가 임의로 A 를 친구로 만들면
//    A 는 보낸 적 없는 사람에게 단어장이 보이게 된다.
assert.equal((await call("tokC", "/friends/kakao:A", "PUT")).status, 400, "받은 적 없는 요청이 수락됐다");

// 7. A 가 수락 → 양쪽 다 친구. 한쪽만 되면 상대 화면에서 조용히 안 보인다.
await call("tokA", "/friends/kakao:B", "PUT");
assert.deepEqual((await call("tokA", "/friends")).body.friends.map((f) => f.uid), ["kakao:B"]);
assert.deepEqual((await call("tokB", "/friends")).body.friends.map((f) => f.uid), ["kakao:A"]);
assert.deepEqual((await call("tokA", "/friends")).body.in, [], "수락했는데 요청이 남았다");
assert.deepEqual((await call("tokB", "/friends")).body.out, [], "수락됐는데 보낸 요청이 남았다");

// 8. 이제 서로의 단어장이 보인다.
const seen = await call("tokB", "/friends/kakao:A/book");
assert.deepEqual(seen.body.words, ["사랑", "보고싶다"]);
assert.equal(seen.body.name, "가");

// 9. 친구 목록엔 단어 **개수만** 온다. 목록 화면에 안 쓰는 단어까지 실어 보내지 않는다.
assert.equal((await call("tokB", "/friends")).body.friends[0].count, 2);
assert.ok(!("words" in (await call("tokB", "/friends")).body.friends[0]), "목록에 단어가 실려 나온다");

// 10. 끊으면 양쪽에서 사라지고 단어장도 다시 막힌다.
await call("tokA", "/friends/kakao:B", "DELETE");
assert.deepEqual((await call("tokA", "/friends")).body.friends, []);
assert.deepEqual((await call("tokB", "/friends")).body.friends, [], "끊었는데 상대 목록에 남았다");
assert.equal((await call("tokB", "/friends/kakao:A/book")).status, 403, "끊었는데 단어장이 보인다");

// 11. 서로 링크를 주고받으면 수락을 기다리지 않고 맺어진다.
//     (둘 다 "수락 대기"로 멈춰 있으면 사용자는 뭘 눌러야 할지 모른다)
const bCode = (await call("tokB", "/friends")).body.code;
await call("tokA", "/friends", "POST", { code: bCode });
const mutual = await call("tokB", "/friends", "POST", { code: a1.body.code });
assert.equal(mutual.body.state, "ok", "서로 보냈는데 친구가 안 됐다");
assert.deepEqual((await call("tokA", "/friends")).body.friends.map((f) => f.uid), ["kakao:B"]);

// 12. 계정을 지우면 친구 쪽 목록에서도 사라진다. 안 그러면 이름 없는 친구가 남는다.
await call("tokA", "/me", "DELETE");
assert.deepEqual((await call("tokB", "/friends")).body.friends, [], "탈퇴한 사람이 친구 목록에 남았다");
assert.equal(env._kv.get("c:" + a1.body.code), undefined, "탈퇴했는데 초대 코드가 살아있다");

// ── 마스터 계정 ──
// 만든 사람 계정은 무료 벽에 안 걸린다. 판단은 **서버가** 한다 — 로컬에만 두면 폰을 바꾸는 순간
// 사라져서 새 기기에서 벽에 걸린다.
{
  const e2 = makeEnv();
  e2._kv.set("s:m", "kakao:BOSS");
  e2._kv.set("s:n", "kakao:NOBODY");
  const get = async (t) => (await (await worker.fetch(new Request("https://api.test/book", {
    headers: { Authorization: "Bearer " + t, Origin: ORIGIN } }), e2)).json());

  // 13. 목록이 비어 있으면 아무도 마스터가 아니다(기본값이 안전한 쪽).
  assert.equal((await get("m")).pro, false, "MASTER_UIDS 가 비었는데 프로가 켜졌다");
  assert.equal((await get("m")).master, false, "MASTER_UIDS 가 비었는데 마스터가 켜졌다");

  e2.MASTER_UIDS = " kakao:BOSS , kakao:OTHER ";
  // 14. 목록에 있으면 프로. 공백이 섞여 있어도 읽어야 한다(secret 은 사람이 손으로 넣는다).
  assert.equal((await get("m")).pro, true, "마스터인데 프로가 안 켜졌다");
  assert.equal((await get("m")).master, true, "마스터인데 master 가 안 왔다 — 화면이 '프로'라고 부르게 된다");
  assert.equal((await get("n")).pro, false, "마스터가 아닌데 프로가 켜졌다");

  // 15. pro 는 **저장되지 않는다.** 레코드에 굳으면 목록에서 빼도 옛 레코드가 계속 프로라고 말한다.
  await worker.fetch(new Request("https://api.test/book", {
    method: "PUT", headers: { Authorization: "Bearer m", Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ words: ["사랑"], name: "" }) }), e2);
  const rec = JSON.parse(e2._kv.get("b:kakao:BOSS"));
  assert.ok(!("pro" in rec) && !("master" in rec), "pro/master 가 KV 레코드에 저장됐다");
  delete e2.MASTER_UIDS;
  assert.equal((await get("m")).pro, false, "목록에서 뺐는데 옛 레코드가 프로라고 말한다");
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

console.log("test-friends: 24개 통과 — 수락 전 단어장 비공개 · 양방향 정리 · 마스터 계정 · 복귀 주소");
