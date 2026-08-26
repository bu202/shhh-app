// 권리 행사 — 열람(내려받기) · 처리정지 · 재개. `node scripts/test-rights.mjs`
//
// 왜 생겼나(2026-08-26): `privacy.html` 의 권리 표가 **없는 기능**을 가리키고 있었다.
//   · 「열람」   → 마이 화면을 보라고만 했다. 내려받을 방법이 없었다
//   · 「처리정지」 → **로그아웃**을 가리켰다. 로그아웃은 세션만 끊고 계정·단어장·친구 관계·
//                  가입 기록·정리 처리는 그대로 둔다 — 멈추는 것이 하나도 없다
//   · 「계정에 못 들어갈 때」 → 이메일로 처리해 준다고 했다. 이 앱은 이메일을 **받지 않으므로**
//                  보낸 사람과 계정을 이을 방법이 없다. 그대로 두면 남의 계정을 여는 통로다
//
// 여기서 재는 것은 **그 세 기능이 실제로 그렇게 도는가**이고, 특히 다음 넷이다:
//   ① 내려받기에 남의 것이 섞이지 않는가(IDOR)
//   ② 정지가 **모든 기기**를 끊는가, 반쪽 상태가 생기지 않는가
//   ③ 로그인 성공만으로 **자동 재개되지 않는가**
//   ④ 재개 티켓이 1회용이고 replay·만료·제공자 바꿔치기가 막히는가
import "./_workers-shim.mjs";
import assert from "node:assert";
import worker, {
  createAccountWithPolicy, newSession, makeResumeTicket, takeResumeTicket, suspendAllows,
  routeFor, SESSION_DAYS, mkSessionToken,
} from "../worker/index.js";
import { makeD1, makeLedger, asRequest } from "./_d1.mjs";

const ORIGIN = "https://app.test";
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 11)).toString("base64url");
let n = 0;
const t = (m) => { n++; return m; };

const makeEnv = (extra = {}) => ({
  // ⚠️ **비밀값 fixture 를 길고 특이하게 둔다.** 「r」·「tk」 같은 짧은 값은 JSON 어디에나
  //    우연히 들어 있어서, 아래 「비밀값이 안 실렸다」 검사가 늘 실패하거나 늘 통과한다.
  APP_ORIGIN: ORIGIN, STATE_KEY: "state-key-FIXTURE-1", RL_KEY: "rl-key-FIXTURE-2",
  DEV_RATE_LIMIT: "1",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tombstone-key-FIXTURE-3",
  DELETION_KEY: "deletion-key-FIXTURE-4",
  SESSION_ENVELOPE_KEY: "envelope-key-FIXTURE-5",
  KAKAO_ID: "id", KAKAO_SECRET: "s", NAVER_ID: "id", NAVER_SECRET: "s",
  DB: makeD1(), LEDGER: makeLedger(), ...extra,
});

let seq = 0;
const mkUser = async (env, provider = "kakao", sub = "u" + ++seq) => {
  const uid = await asRequest(env, (fe) => createAccountWithPolicy(fe, provider, sub,
    { stateHash: "s-" + sub + Math.random(), stateExp: Date.now() + 600e3, occurredAt: Date.now() }));
  return { uid, sub, provider, token: await asRequest(env, (fe) => newSession(fe, uid)) };
};
const req = (env, path, { method = "GET", token, origin = ORIGIN, cookies = {}, body } = {}) => {
  const jar = { ...(token ? { shh_s: token } : {}), ...cookies };
  const h = { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") };
  if (method !== "GET") h.Origin = origin;
  if (body !== undefined) h["Content-Type"] = "application/json";
  return worker.fetch(new Request("https://api.test/api" + path,
    { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
};
const dcount = (env, table, where = "", ...a) =>
  env.DB._db.prepare(`SELECT COUNT(*) n FROM ${table} ${where}`).get(...a).n;
const cookieOf = (res, name) => (res.headers.getSetCookie()
  .find((c) => c.startsWith(name + "=")) || "").slice(name.length + 1).split(";")[0];

// ══ E1. 내려받기 — 세션의 계정만, 남의 것은 한 글자도 ══════════════════
{
  const env = makeEnv();
  const A = await mkUser(env, "kakao", "A-subject-secret");
  const B = await mkUser(env, "naver", "B-subject-secret");
  // 준비용 심기는 **fence 를 지나지 않는 raw 통로**로 한다 — 운영 코드가 아니라 fixture 다.
  const put = (sql, ...a) => env.DB._db.prepare(sql).run(...a);
  put("INSERT INTO books (user_id, words, nickname, version, updated_at) VALUES (?,?,?,1,?)",
      A.uid, JSON.stringify(["가족"]), "에이", Date.now());
  put("INSERT INTO books (user_id, words, nickname, version, updated_at) VALUES (?,?,?,1,?)",
      B.uid, JSON.stringify(["비밀단어"]), "비", Date.now());
  put("INSERT INTO friendships (requester_id, addressee_id, pair_key, status, created_at, accepted_at)"
      + " VALUES (?,?,?,'accepted',?,?)",
      A.uid, B.uid, [A.uid, B.uid].sort().join("|"), 1, 2);

  const res = await req(env, "/me/export", { token: A.token });
  assert.equal(res.status, 200, t("E1: 내 정보를 못 받는다"));
  const raw = await res.text();
  const d = JSON.parse(raw);

  // -- a. 내 것은 전부 있다(**0건과 누락을 구분한다**).
  assert.equal(d.계정.내부_계정번호, A.uid, t("E1-a: 내 계정 번호가 없다"));
  assert.equal(d.계정.제공자_회원번호, A.sub, t("E1-a: 내 제공자 회원번호가 없다 — 열람권의 대상이다"));
  assert.deepEqual(d.단어장.단어, ["가족"], t("E1-a: 내 단어장이 없다"));
  for (const k of ["친구", "초대코드", "가입기록", "세션"])
    assert.ok(Array.isArray(d[k]), t(`E1-a: ${k} 가 배열이 아니다 — 0건인지 누락인지 알 수 없다`));
  assert.equal(d.건수.가입기록, 3, t("E1-a: 가입 기록 3종이 안 실렸다"));
  assert.equal(d.건수.세션, 1, t("E1-a: 세션 메타데이터가 안 실렸다"));
  assert.equal(d.스키마, "shhh-export-1", t("E1-a: 스키마 판이 없다"));

  // -- b. ⛔ 남의 것은 한 글자도 없다. **원문 전체**를 훑는다.
  assert.ok(!raw.includes("B-subject-secret"),
    t("E1-b: ⛔ 친구의 제공자 회원번호가 실렸다"));
  assert.ok(!raw.includes("비밀단어"), t("E1-b: ⛔ 친구의 단어장이 실렸다"));
  assert.equal(d.건수.친구, 1, t("E1-b: 친구 관계 자체가 안 실렸다 — 위 단언이 헛돌았다"));
  assert.equal(d.친구[0].상대_계정번호, B.uid, t("E1-b: 상대 계정 번호가 없다"));

  // -- c. ⛔ 비밀값·세션 토큰이 지나가지 않는다.
  const tokenHash = env.DB._db.prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
    .get(A.uid).token_hash;
  for (const [label, bad] of [["세션 토큰", A.token], ["세션 토큰 해시", tokenHash],
                              ["세션 서명 키", env.SESSION_ENVELOPE_KEY],
                              ["삭제 키", env.DELETION_KEY],
                              ["표식 키", env.TOMBSTONE_KEY], ["리미터 키", env.RL_KEY],
                              ["로그인 서명 키", env.STATE_KEY],
                              ["가입 state 키", env.SIGNUP_STATE_KEY],
                              ["OAuth secret", "KAKAO_SECRET"]]) {
    assert.ok(!raw.includes(bad), t(`E1-c: ⛔ ${label} 이 내려받기에 실렸다`));
  }
  assert.ok(!raw.includes("token_hash"), t("E1-c: ⛔ token_hash 칸 이름이 실렸다"));

  // -- d. 캐시 금지 · 첨부.
  assert.match(res.headers.get("Cache-Control") || "", /no-store/,
    t("E1-d: 개인정보 전문에 no-store 가 없다"));
  assert.match(res.headers.get("Content-Disposition") || "", /attachment/,
    t("E1-d: 첨부로 안 준다"));

  // -- e. ⛔ **uid 를 입력으로 못 준다.** query·body·path 어디로도.
  for (const [label, opt] of [
    ["query", { path: "/me/export?uid=" + B.uid }],
    ["query(user)", { path: "/me/export?user=" + B.uid }],
    ["경로", { path: "/me/export/" + B.uid }],
  ]) {
    const r2 = await req(env, opt.path, { token: A.token });
    if (r2.status === 404) continue;                     // 없는 주소 = 구조적으로 불가능
    const txt = await r2.text();
    assert.ok(!txt.includes("B-subject-secret") && !txt.includes("비밀단어"),
      t(`E1-e: ⛔ ${label} 로 남의 데이터를 받았다`));
    assert.ok(txt.includes(A.uid), t(`E1-e: ${label} 요청이 내 것도 안 준다 — 판정이 헛돌았다`));
  }
  // 소스에도 uid 를 입력에서 읽는 자리가 없어야 한다.
  const src = (await import("node:fs")).readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf('path === "/me/export"'), src.indexOf('// ── 3-2. 처리정지 ──'));
  assert.ok(block.length > 200, t("E1-e: export 블록을 못 찾았다 — 검사기가 낡았다"));
  assert.ok(!/searchParams|body\.|readBody/.test(block),
    t("E1-e: ⛔ export 가 요청 입력을 읽는다 — 세션 uid 하나만 써야 한다"));

  // -- f. 세션이 없으면 401.
  assert.equal((await req(env, "/me/export")).status, 401, t("E1-f: 세션 없이 내려받아진다"));
  assert.equal((await req(env, "/me/export", { token: "junk" })).status, 401,
    t("E1-f: 위조 쿠키로 내려받아진다"));
  // ⚠️ **서명은 맞는데 세션 행이 없는 경우**를 따로 잰다(2026-08-26 · 돌연변이 M68 생존).
  //    쿠키가 없거나 위조면 **값싼 문**(envelope 검증)이 먼저 401 을 내므로, 그 둘만 재면
  //    핸들러 안의 세션 확인이 **한 번도 실행되지 않는다** — 지워도 스위트가 통과했다.
  {
    const ghost = await mkSessionToken(env, Date.now() + 600e3);   // 서명은 진짜, 행은 없다
    const r = await req(env, "/me/export", { token: ghost });
    assert.equal(r.status, 401,
      t(`E1-f: 서명만 맞는 쿠키로 내려받기가 ${r.status} 다 — 핸들러의 세션 확인이 없다`));
    const txt = await r.text();
    assert.ok(!txt.includes("스키마"), t("E1-f: 세션이 없는데 내려받기 문서 모양이 나갔다"));
  }
}

// ══ E2. 처리정지 — 로그아웃과 다르다 ═══════════════════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  const phone = await asRequest(env, (fe) => newSession(fe, A.uid));   // 다른 기기
  assert.equal(dcount(env, "sessions", "WHERE user_id = ?", A.uid), 2, t("E2: 기기 둘 준비 실패"));

  const v0 = env.DB._db.prepare("SELECT session_version v FROM users WHERE id = ?").get(A.uid).v;
  const res = await req(env, "/me/suspend", { method: "POST", token: A.token });
  assert.equal(res.status, 200, t("E2: 처리정지가 안 된다"));
  // ⚠️ **세대도 오른다.** 행 삭제만으로는 정지 **직후**에 만들어지는 세션을 못 막는다 —
  //    행이 없어도 판정은 세대가 하므로, 두 가지가 함께 있어야 「모든 기기」가 참이다.
  assert.equal(env.DB._db.prepare("SELECT session_version v FROM users WHERE id = ?").get(A.uid).v,
    v0 + 1, t("E2: 정지가 세션 세대를 올리지 않았다 — 직후에 생긴 세션이 살아남는다"));

  // -- a. **모든 기기**가 끊긴다. 현재 세션만 끊는 구현이면 여기서 걸린다.
  assert.equal(dcount(env, "sessions", "WHERE user_id = ?", A.uid), 0,
    t("E2-a: 세션 행이 남았다"));
  assert.equal((await req(env, "/book", { token: phone })).status, 401,
    t("E2-a: ⛔ 다른 기기 세션이 아직 산다 — 정지가 이름뿐이다"));

  // -- b. **데이터는 안 지운다.** 정지는 삭제가 아니다.
  assert.equal(dcount(env, "users", "WHERE id = ?", A.uid), 1, t("E2-b: 정지가 계정을 지웠다"));
  const susp = env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(A.uid).suspended_at;
  assert.ok(susp > 0, t("E2-b: suspended_at 이 안 적혔다"));

  // -- c. 멱등. 두 번 눌러도 처음 시각이 유지된다.
  const B = await mkUser(env);
  await req(env, "/me/suspend", { method: "POST", token: B.token });
  const first = env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(B.uid).suspended_at;
  env.DB._db.exec(`UPDATE users SET session_version = session_version WHERE id = '${B.uid}'`);
  const tok2 = await asRequest(env, (fe) => newSession(fe, B.uid));
  await req(env, "/me/suspend", { method: "POST", token: tok2 });
  assert.equal(env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(B.uid).suspended_at,
    first, t("E2-c: 두 번째 정지가 시각을 덮었다"));

  // -- d. CSRF. Origin 없는 정지는 안 된다.
  const C = await mkUser(env);
  const bad = await worker.fetch(new Request("https://api.test/api/me/suspend",
    { method: "POST", headers: { Cookie: "shh_s=" + C.token } }), env);
  assert.equal(bad.status, 403, t("E2-d: Origin 없는 정지가 통과했다"));
  assert.equal(env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(C.uid).suspended_at,
    null, t("E2-d: Origin 없는 요청이 계정을 정지시켰다"));
}

// ══ E2-1. 정지하면 **친구에게도 보이지 않는다** ════════════════════════
//
// ⛔ 왜 따로 재나: 정지된 사람 **자신의** 요청을 막는 것만으로는 방침의
//    「친구에게 별명·단어 개수가 더 이상 보이지 않아요」가 참이 되지 않는다.
//    그 값을 실어 나르는 것은 **친구의 요청**이기 때문이다.
{
  const env = makeEnv();
  const A = await mkUser(env, "kakao", "watcher");
  const B = await mkUser(env, "naver", "goes-quiet");
  const put = (sql, ...a) => env.DB._db.prepare(sql).run(...a);
  put("INSERT INTO books (user_id, words, nickname, version, updated_at) VALUES (?,?,?,1,?)",
      B.uid, JSON.stringify(["사랑", "친구"]), "비의별명", Date.now());
  put("INSERT INTO friendships (requester_id, addressee_id, pair_key, status, created_at, accepted_at)"
      + " VALUES (?,?,?,'accepted',?,?)",
      A.uid, B.uid, [A.uid, B.uid].sort().join("|"), 1, 2);

  // -- a. ★ 정지 전에는 보인다. **막는 쪽만 재면 회귀를 못 잡는다.**
  {
    const list = await (await req(env, "/friends", { token: A.token })).json();
    assert.equal(list.friends[0].name, "비의별명", t("E2-1-a: 정지 전인데 별명이 안 보인다"));
    assert.equal(list.friends[0].count, 2, t("E2-1-a: 정지 전인데 개수가 안 보인다"));
    const bk = await req(env, `/friends/${B.uid}/book`, { token: A.token });
    assert.equal(bk.status, 200, t("E2-1-a: 정지 전인데 친구 단어장이 안 열린다"));
  }

  // -- b. 정지 뒤에는 **서버가 값을 안 싣는다.**
  await req(env, "/me/suspend", { method: "POST", token: B.token });
  {
    const list = await (await req(env, "/friends", { token: A.token })).json();
    assert.equal(list.friends.length, 1, t("E2-1-b: 관계 자체가 사라졌다 — 정지는 탈퇴가 아니다"));
    assert.equal(list.friends[0].name, "", t("E2-1-b: ⛔ 정지된 친구의 별명이 그대로 보인다"));
    assert.equal(list.friends[0].count, 0, t("E2-1-b: ⛔ 정지된 친구의 단어 개수가 그대로 보인다"));
    const raw = JSON.stringify(list);
    assert.ok(!raw.includes("비의별명"), t("E2-1-b: ⛔ 응답 어딘가에 별명이 남았다"));
  }
  // -- c. 단어장도 열리지 않는다. **응답은 「친구가 아니에요」와 같다** —
  //       「정지했다」는 사실 자체가 그 사람에 관한 정보라 친구에게도 알리지 않는다.
  {
    const bk = await req(env, `/friends/${B.uid}/book`, { token: A.token });
    assert.equal(bk.status, 403, t("E2-1-c: ⛔ 정지된 친구의 단어장이 열린다"));
    const txt = await bk.text();
    assert.ok(!/정지|suspend/i.test(txt), t("E2-1-c: 상대의 정지 사실을 친구에게 알린다"));
    assert.ok(!txt.includes("사랑"), t("E2-1-c: ⛔ 단어가 실려 나갔다"));
  }
  // -- d. 재개하면 **되돌아온다.** 정지는 되돌릴 수 있는 상태다.
  {
    const tk = await makeResumeTicket(env, B.uid, "naver", B.sub, Date.now());
    assert.equal((await req(env, "/me/resume", { method: "POST", cookies: { shh_rz: tk } })).status,
      200, t("E2-1-d: 재개가 안 된다"));
    const list = await (await req(env, "/friends", { token: A.token })).json();
    assert.equal(list.friends[0].name, "비의별명", t("E2-1-d: 재개했는데 별명이 안 돌아온다"));
    assert.equal((await req(env, `/friends/${B.uid}/book`, { token: A.token })).status, 200,
      t("E2-1-d: 재개했는데 단어장이 안 열린다"));
  }
}

// ══ E3. 정지된 계정은 fail-closed ═════════════════════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env);
  // 세션을 **살려 둔 채** 정지시킨다 — 경합으로 살아남은 세션을 흉내 낸다.
  // (실제 경로는 세션까지 끊지만, 그 사실에 기대는 방어는 방어가 아니다.)
  env.DB._db.exec(`UPDATE users SET suspended_at = ${Date.now()} WHERE id = '${A.uid}'`);

  const CASES = [
    ["/book", "GET"], ["/book", "PUT"], ["/me", "GET"], ["/me", "PUT"], ["/me", "DELETE"],
    ["/friends", "GET"], ["/friends", "POST"], ["/friends/code/ensure", "POST"],
    ["/friends/code", "POST"], ["/me/export", "GET"], ["/me/suspend", "POST"],
  ];
  for (const [path, method] of CASES) {
    const r = await req(env, path, { method, token: A.token, body: method === "GET" ? undefined : {} });
    assert.equal(r.status, 403, t(`E3: ${method} ${path} 가 정지 상태에서 ${r.status} 다`));
    const d = await r.json();
    assert.equal(d.suspended, true, t(`E3: ${method} ${path} 가 정지를 401 과 구분해 말하지 않는다`));
    // ⛔ 내부 구조를 노출하지 않는다.
    assert.ok(!/suspended_at|users|sqlite|SELECT/i.test(d.error || ""),
      t(`E3: ${method} ${path} 응답이 내부 구조를 말한다`));
  }
  // 열어 두는 자리는 **로그아웃 하나**다.
  assert.equal((await req(env, "/session", { method: "DELETE", token: A.token })).status, 200,
    t("E3: 정지 상태에서 로그아웃까지 막혔다 — 스스로 끝낼 길이 없다"));
  assert.equal(suspendAllows("/session", "DELETE"), true, t("E3: 로그아웃이 허용 목록에 없다"));
  for (const [p, m] of CASES)
    assert.equal(suspendAllows(p, m), false, t(`E3: ${m} ${p} 가 허용 목록에 있다`));
}

// ══ E4. 재개 — **로그인만으로는 절대 안 된다** ═════════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env, "kakao", "resume-me");
  env.DB._db.exec(`UPDATE users SET suspended_at = ${Date.now()} WHERE id = '${A.uid}'`);
  const now = Date.now();

  // -- a. 티켓 없이 재개 시도 → 401, 정지 유지.
  assert.equal((await req(env, "/me/resume", { method: "POST" })).status, 401,
    t("E4-a: 티켓 없이 재개됐다"));
  assert.notEqual(env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(A.uid).suspended_at,
    null, t("E4-a: 티켓 없는 요청이 정지를 풀었다"));

  // -- b. 정상 티켓 → 재개된다(막는 쪽만 재면 「영영 안 열리는」 회귀를 못 잡는다).
  const ticket = await makeResumeTicket(env, A.uid, "kakao", A.sub, now);
  const ok = await req(env, "/me/resume", { method: "POST", cookies: { shh_rz: ticket } });
  assert.equal(ok.status, 200, t("E4-b: 정상 티켓으로 재개가 안 된다"));
  assert.equal(env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(A.uid).suspended_at,
    null, t("E4-b: 재개했는데 정지가 안 풀렸다"));
  assert.ok(cookieOf(ok, "shh_s"), t("E4-b: 재개 뒤 세션 쿠키를 안 준다"));
  assert.match(ok.headers.getSetCookie().join(" "), /shh_rz=;/,
    t("E4-b: 쓴 티켓 쿠키를 안 버린다"));

  // -- c. ⛔ **replay.** 같은 티켓을 다시 쓰면 안 된다.
  env.DB._db.exec(`UPDATE users SET suspended_at = ${Date.now()} WHERE id = '${A.uid}'`);
  const again = await req(env, "/me/resume", { method: "POST", cookies: { shh_rz: ticket } });
  assert.equal(again.status, 401, t("E4-c: ⛔ 같은 재개 티켓이 두 번 통했다"));
  assert.notEqual(env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(A.uid).suspended_at,
    null, t("E4-c: ⛔ replay 로 정지가 풀렸다"));

  // -- d. 만료된 티켓.
  const old = await makeResumeTicket(env, A.uid, "kakao", A.sub, now - 3600e3);
  assert.equal((await req(env, "/me/resume", { method: "POST", cookies: { shh_rz: old } })).status, 401,
    t("E4-d: 만료된 티켓이 통했다"));
  assert.equal(await takeResumeTicket(env, old, now), null, t("E4-d: 만료 판정이 안 된다"));

  // -- e. ⛔ **제공자·subject 바꿔치기.** 다른 계정으로 재개할 수 없다.
  const other = await mkUser(env, "naver", "other-subject");
  env.DB._db.exec(`UPDATE users SET suspended_at = ${Date.now()} WHERE id = '${other.uid}'`);
  for (const [label, tk] of [
    ["다른 uid", await makeResumeTicket(env, other.uid, "kakao", A.sub, Date.now())],
    ["다른 subject", await makeResumeTicket(env, A.uid, "kakao", "wrong-subject", Date.now())],
    ["다른 제공자", await makeResumeTicket(env, A.uid, "naver", A.sub, Date.now())],
  ]) {
    const r = await req(env, "/me/resume", { method: "POST", cookies: { shh_rz: tk } });
    assert.equal(r.status, 401, t(`E4-e: ⛔ ${label} 로 재개가 통했다`));
  }
  assert.notEqual(env.DB._db.prepare("SELECT suspended_at FROM users WHERE id = ?").get(other.uid).suspended_at,
    null, t("E4-e: ⛔ 바꿔치기로 남의 정지가 풀렸다"));

  // -- f. ⛔ **가입 state 를 재개 티켓으로 쓸 수 없다**(AAD 도메인 분리).
  const { makeSignupState } = await import("../worker/index.js");
  const st = await makeSignupState(env, "kakao", { uid: A.uid, subject: A.sub });
  assert.equal(await takeResumeTicket(env, st, Date.now()), null,
    t("E4-f: ⛔ 가입 state 가 재개 티켓으로 통했다"));

  // -- g. 위조·잘린 티켓.
  for (const junk of ["", "x", "v1.abc.def.ghi", ticket.slice(0, -4), "v2." + ticket.slice(3)])
    assert.equal(await takeResumeTicket(env, junk, Date.now()), null,
      t(`E4-g: 위조 티켓이 통했다: ${junk.slice(0, 12)}`));

  // -- h. 키가 없으면 **확인할 수 없다** → 503(통과가 아니다).
  const noKey = makeEnv({ DB: env.DB, LEDGER: env.LEDGER });
  delete noKey.SIGNUP_STATE_KEY;
  assert.equal((await req(noKey, "/me/resume",
    { method: "POST", cookies: { shh_rz: ticket } })).status, 503,
    t("E4-h: 키가 없는데 재개가 401/200 이다 — fail-closed 가 아니다"));

  // -- i. CSRF.
  env.DB._db.exec(`UPDATE users SET suspended_at = ${Date.now()} WHERE id = '${A.uid}'`);
  const tk2 = await makeResumeTicket(env, A.uid, "kakao", A.sub, Date.now());
  const noOrigin = await worker.fetch(new Request("https://api.test/api/me/resume",
    { method: "POST", headers: { Cookie: "shh_rz=" + tk2 } }), env);
  assert.equal(noOrigin.status, 403, t("E4-i: Origin 없는 재개가 통했다"));
}

// ══ E5. 라우트 계약 ═══════════════════════════════════════════════════
{
  // 재개는 **세션이 없는 상태**로 온다 — `auth:true` 면 값싼 문에서 먼저 401 이라 못 온다.
  assert.equal(routeFor("POST", "/me/resume").auth, false,
    t("E5: 재개가 세션을 요구한다 — 정지가 세션을 끊었으므로 영영 못 온다"));
  // 셋 다 주 D1 을 만지므로 임차증을 들고, 버킷이 있어야 한다(위협 47 의 규칙).
  for (const [p, m] of [["/me/export", "GET"], ["/me/suspend", "POST"], ["/me/resume", "POST"]]) {
    const r = routeFor(m, p);
    assert.ok(r, t(`E5: ${m} ${p} 가 라우트 표에 없다`));
    assert.equal(r.lease, true, t(`E5: ${m} ${p} 가 임차증을 안 든다`));
    assert.ok(r.bucket, t(`E5: ${m} ${p} 에 레이트리밋 버킷이 없다 — 증폭 통로다`));
  }
  // 다른 method 는 없는 주소다(기본값이 안전한 쪽).
  for (const [p, m] of [["/me/export", "POST"], ["/me/suspend", "GET"], ["/me/resume", "GET"]])
    assert.equal(routeFor(m, p), null, t(`E5: ${m} ${p} 가 열려 있다`));
  assert.equal(SESSION_DAYS, 90, t("E5: 세션 상수가 바뀌었다 — 방침과 대조하는 검사가 따로 있다"));
}

// ══ E6. 정지된 계정의 OAuth 콜백은 **세션을 만들지 않는다** ═════════════
{
  const env = makeEnv();
  const A = await mkUser(env, "kakao", "cb-suspended");
  env.DB._db.exec(`UPDATE users SET suspended_at = ${Date.now()} WHERE id = '${A.uid}'`);
  env.DB._db.exec("DELETE FROM sessions");

  // 제공자 응답을 가로챈다. 여기서 재는 것은 **콜백이 세션을 심는가**뿐이다.
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("kauth") || String(url).includes("kapi"))
      return new Response(JSON.stringify({ access_token: "at", id: "cb-suspended" }),
        { headers: { "Content-Type": "application/json" } });
    return real(url);
  };
  try {
    const start = await req(env, "/login/kakao?return=" + encodeURIComponent(ORIGIN + "/") + "&n=abc");
    assert.equal(start.status, 302, t("E6: 로그인 시작이 안 된다"));
    const st = new URL(start.headers.get("Location")).searchParams.get("state");
    const txn = cookieOf(start, "shh_t");
    const cb = await worker.fetch(new Request(
      `https://api.test/api/cb/kakao?code=c&state=${encodeURIComponent(st)}`,
      { headers: { Cookie: "shh_t=" + txn } }), env);

    assert.equal(dcount(env, "sessions"), 0,
      t("E6: ⛔ 정지된 계정으로 로그인했더니 세션이 생겼다 — 자동 재개다"));
    const setc = cb.headers.getSetCookie().join(" ");
    assert.ok(!/(^|\s)shh_s=[^;]/.test(setc), t("E6: ⛔ 세션 쿠키를 심었다"));
    assert.match(cb.headers.get("Location") || "", /#login=suspended/,
      t("E6: 정지 상태를 화면에 알리지 않는다"));
    const rz = cookieOf(cb, "shh_rz");
    assert.ok(rz, t("E6: 재개 티켓을 안 준다 — 사용자가 다시 시작할 길이 없다"));
    // ⛔ 주소에 제공자 회원번호도 티켓도 없다.
    const loc = cb.headers.get("Location") || "";
    assert.ok(!loc.includes("cb-suspended") && !loc.includes(rz),
      t("E6: ⛔ 복귀 주소에 회원번호나 티켓이 실렸다"));
    // 그 티켓으로는 재개된다 — 티켓이 진짜인지 확인한다.
    const done = await req(env, "/me/resume", { method: "POST", cookies: { shh_rz: rz } });
    assert.equal(done.status, 200, t("E6: 콜백이 준 티켓으로 재개가 안 된다"));
  } finally {
    globalThis.fetch = real;
  }
}

console.log(`test-rights: ${n}개 통과 — 내려받기(세션 uid 만 · 남의 subject·단어 0건 · 비밀값 0건 · `
  + `no-store · 입력 uid 자리 없음) · 처리정지(모든 기기 · 데이터 보존 · 멱등 · CSRF) · `
  + `정지 fail-closed(11경로 403 · 로그아웃만 허용) · 재개(1회용 · replay · 만료 · 제공자/subject `
  + `바꿔치기 · 가입 state 겸용 불가 · 키 없으면 503 · CSRF) · 정지된 친구는 별명·개수·단어장이 안 나가고 재개하면 돌아온다 · 콜백은 세션을 만들지 않는다`);
