// 클라이언트의 **실패 처리**를 잰다. 이 저장소에 없던 종류의 테스트다.
//
// 왜 필요한가: test-auth 는 순수 함수(syncPlan)와 소스 문자열만 보고, test-friends 는 서버만 본다.
// 그 사이에 낀 것 — 버튼을 눌렀는데 서버가 500 을 냈을 때 화면이 무슨 말을 하는가 — 을
// 재는 검사가 **하나도 없었다.** 그래서 "계정을 지웠어요"라고 말하면서 아무것도 안 지우는
// 코드가 96개 통과 상태로 살아 있었다.
//
// 방법: 정규식으로 소스를 훑지 않는다(그건 "코드가 이렇게 생겼나"이지 "이렇게 도나"가 아니다).
// index.html 과 **같은 순서로** 세 파일을 이어 붙여 실제로 실행하고, 진짜 클릭 처리기를 부른다.
// app.js 는 안 싣는다 — 여기서 재는 것은 로그인·저장·친구뿐이라 app.js 가 주는 이름은 스텁으로 둔다.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 마이크로태스크가 다 돌 때까지. sync() 처럼 await 되지 않는 호출이 있어서 필요하다.
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── 브라우저 스텁 ──────────────────────────────────────────────────────
// 진짜 DOM 이 아니라 **이 코드가 실제로 쓰는 것만** 흉내 낸다(jsdom 을 넣지 않는 이유).
function makeEl(tag = "div") {
  return {
    tagName: tag, className: "", type: "", id: "", hidden: false, value: "", maxLength: 0,
    dataset: {}, children: [], handlers: {}, attrs: {}, _text: "", _html: "",
    classList: { toggle() {}, add() {}, remove() {} },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    addEventListener(n, fn) { (this.handlers[n] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll() { return []; },
    click() { for (const fn of this.handlers.click || []) fn({ stopPropagation() {} }); },
    showModal() {}, close() {}, focus() {}, blur() {},
  };
}
const walk = (el, out = []) => { out.push(el); for (const c of el.children) walk(c, out); return out; };
const findText = (root, t) => walk(root).find((e) => e._text === t);
const allText = (root) => walk(root).map((e) => e._text + " " + e._html).join(" | ");

// store 를 **참조로** 받는다 — 같은 객체를 두 인스턴스에 주면 "한 기기의 탭 두 개"가 된다.
function loadClient({ store = {}, routes, loc = {} } = {}) {
  const calls = [];
  let route = routes || (() => ({ status: 200, body: {} }));
  let confirmAnswer = true;

  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  // loc 으로 로그인 왕복에서 돌아온 주소(`?code=…&state=…` · `#login=ok…`)를 만들 수 있다.
  const location = { origin: "https://test", pathname: "/", search: "", hash: "", href: "", ...loc };
  const history = { replaceState() {} };
  const crypto = { randomUUID: () => "nonce-fixed" };

  const fetch = async (url, opt = {}) => {
    const method = (opt.method || "GET").toUpperCase();
    const path = String(url).replace(/^\/api/, "");
    // 시간 제한이 **붙었는지**도 기록한다. 이 스텁은 진짜 타이머를 돌리지 않으므로
    // "12초 뒤에 끊기나"는 못 재지만, "끊을 수단을 들려 보냈나"는 여기서 잴 수 있다.
    calls.push({ method, path, aborts: !!opt.signal });
    const r = await route(method, path, opt);
    if (r.throw) throw new Error("offline");           // 네트워크 끊김
    // 시간 초과. **실제 타이머를 기다리지 않는다** — 12초를 세는 것은 브라우저 기능이고
    // 우리가 재려는 것은 "초과되면 화면이 뭐라고 하나"다. 그래서 결과만 흉내 낸다.
    // (12초라는 숫자 자체는 실제 느린 회선에서 사람이 확인해야 한다.)
    if (r.throwName) { const e = new Error("aborted"); e.name = r.throwName; throw e; }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => { if (r.badJson) throw new Error("bad json"); return r.body ?? {}; },
    };
  };

  const segs = ["mine", "friends"].map((b) => { const e = makeEl("button"); e.dataset.book = b; return e; });
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) { const e = makeEl(); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    createElement: (t) => makeEl(t),
    querySelectorAll: (sel) => (sel.includes("seg") ? segs : []),
  };

  // app.js 가 주는 이름들. 여기서 재는 것과 무관한 것은 빈 함수로 둔다.
  const preamble = `
    let BOOK = [];
    const replaceBook = (w) => { BOOK = w.slice(); };
    const TOASTS = [];
    const toast = (m) => TOASTS.push(String(m));
    const GO = () => {};
    const HOOKS = { ready: [] };
    const onAppReady = (fn) => HOOKS.ready.push(fn);
    const onBookChanged = (fn) => { HOOKS.bookChanged = fn; };
    const onScreenShown = (fn) => { HOOKS.screenShown = fn; };
    const onInviteLink = (fn) => { HOOKS.inviteLink = fn; };
    const onMyPageSub = () => {};
    const onSaveGuard = () => {};
    const setEntitlement = () => false;
    const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return ""; } };
    const bookItem = () => null, card = () => null, cardRow = () => null;
    const namedFingers = () => "", entryFrames = () => [], meaningOf = () => "";
    const bookCost = () => 0, requestPro = () => {};
    const FREE_LIMIT = 5, PRO_PRICE = "", BETA_NO_WALL = true;
    let isPro = false, isMaster = false;
  `;
  const src = preamble + read("js/authApi.js") + "\n" + read("js/auth.js") + "\n" + read("js/friends.js")
    + "\n; return { HOOKS, TOASTS, getBook: () => BOOK, setBook: (v) => { BOOK = v.slice(); } };";

  const inner = new Function(
    "localStorage", "location", "history", "crypto", "fetch", "document", "confirm", "addEventListener",
    src,
  )(localStorage, location, history, crypto, fetch, document, () => confirmAnswer, () => {});

  return {
    ...inner, store, calls, document, segs, location,
    setRoutes: (fn) => { route = fn; },
    setConfirm: (v) => { confirmAnswer = v; },
    deletes: (path) => calls.filter((c) => c.method === "DELETE" && c.path === path).length,
  };
}

// 로그인한 채로 앱을 띄운다. 실제 순서 그대로: onAppReady → 로그인 확인 → 화면 → 동기화.
const LOGGED_IN = () => ({ "shh-via": "kakao", "shh-me": "u1", "shh-uid": "u1", "shh-dirty": "0", "shh-bookver": "3" });
const BOOK_OK = { words: [], version: 3, name: "", me: "u1", pro: false, master: false };
const FRIENDS_OK = {
  code: "invite000", friends: [{ uid: "u2", name: "친구1", count: 2 }],
  in: [{ uid: "u3", name: "친구2" }], out: [{ uid: "u4", name: "친구3" }],
};
const defaultRoutes = (m, p) => {
  if (p === "/health") return { status: 200, body: { ok: true, ready: true, providers: ["kakao", "naver", "google"] } };
  if (p === "/book" && m === "GET") return { status: 200, body: BOOK_OK };
  if (p === "/friends" && m === "GET") return { status: 200, body: FRIENDS_OK };
  return { status: 200, body: { ok: true } };
};

async function boot(o = {}) {
  const c = loadClient({ store: o.store ?? LOGGED_IN(), routes: o.routes || defaultRoutes, loc: o.loc });
  for (const fn of c.HOOKS.ready) await fn();
  await tick();
  return c;
}

// 친구 목록 화면을 실제 경로로 연다: 「우리」 화면의 갈래 버튼을 누른다.
const openFriends = (c) => { c.segs[1].click(); return c.document.getElementById("friends"); };

// 한 개가 실패해도 나머지를 끝까지 돈다. **수정 전에 무엇이 red 이고 무엇이 이미 green 인지**를
// 한 번에 봐야 하기 때문이다(하나에서 멈추면 그 목록을 못 만든다).
// 실패가 하나라도 있으면 마지막에 exit 1 — 그래야 npm test 가 여전히 초록불에 속지 않는다.
const RESULTS = [];
let n = 0;
async function T(name, fn) {
  try { await fn(); RESULTS.push([true, name]); }
  catch (e) { RESULTS.push([false, name, e.message]); }
  n++;
}

// ══ red 1~2 · 로그아웃은 서버가 확인해 줄 때만 (결정 ① = A) ══════════════
for (const [label, resp] of [["500", { status: 500 }], ["네트워크 끊김", { throw: true }],
                             ["시간 초과", { throwName: "TimeoutError" }]]) {
  await T(`로그아웃 ${label} — 화면만 로그아웃되지 않는다`, async () => {
    const c = await boot();
    c.setRoutes((m, p) => (m === "DELETE" && p === "/session" ? resp : defaultRoutes(m, p)));
    findText(c.document.getElementById("settings"), "로그아웃").click();
    await tick(12);
    assert.equal(c.store["shh-via"], "kakao", "서버가 못 끊었는데 화면만 로그아웃했다");
    assert.ok(!c.TOASTS.includes("로그아웃했어요"), "실패했는데 성공했다고 말한다");
    assert.ok(c.TOASTS.length, "아무 말도 안 한다 — 눌렀는데 왜 그대로인지 알 수 없다");
  });
}

// ══ green 1 · 로그아웃 성공은 그대로 ═══════════════════════════════════
await T("로그아웃 성공 — 정리하고 알린다", async () => {
  const c = await boot();
  findText(c.document.getElementById("settings"), "로그아웃").click();
  await tick(12);
  assert.equal(c.store["shh-via"], undefined, "로그아웃 성공인데 로그인 표시가 남았다");
  assert.equal(c.store["shh-name"], undefined, "로그아웃이 계정에 딸린 값을 안 지웠다");
  assert.ok(c.TOASTS.includes("로그아웃했어요"), "로그아웃 성공을 안 알린다");
});

// ══ red 3~6 · 계정 삭제가 실패하면 지웠다고 말하지 않는다 ═══════════════
for (const status of [401, 403, 429, 500]) {
  await T(`계정 삭제 ${status} — 지웠다고 말하지 않는다`, async () => {
    const c = await boot();
    c.setRoutes((m, p) => (m === "DELETE" && p === "/me" ? { status } : defaultRoutes(m, p)));
    findText(c.document.getElementById("account"), "계정 삭제").click();
    await tick(12);
    assert.ok(!c.TOASTS.includes("계정을 지웠어요"),
      '서버가 거절했는데 "지웠어요"라고 말한다 — 단어장·친구가 그대로 남아 있다');
    // 401 은 apiCall 이 세션 만료로 정리한다(정상). 그 밖의 실패는 로그인 상태를 유지해야 한다.
    if (status !== 401) assert.equal(c.store["shh-via"], "kakao", "실패인데 로그아웃시켰다");
  });
}

// ══ green 2 · 계정 삭제 성공은 그대로 ══════════════════════════════════
await T("계정 삭제 성공 — 정리하고 알린다", async () => {
  const c = await boot();
  findText(c.document.getElementById("account"), "계정 삭제").click();
  await tick(12);
  assert.equal(c.store["shh-via"], undefined, "계정 삭제 성공인데 로그인 표시가 남았다");
  assert.ok(c.TOASTS.includes("계정을 지웠어요"), "계정 삭제 성공을 안 알린다");
});

// ══ red 7~9 · 친구 거절·취소·끊기가 실패하면 목록에서 지우지 않는다 ══════
// 지금은 결과를 안 봐서 행이 사라진다 — 사용자는 "끊었다"고 믿지만 상대에겐 내 단어장이 계속 보인다.
const WITHDRAW = [["거절", "u3", "친구2"], ["취소", "u4", "친구3"], ["끊기", "u2", "친구1"]];
for (const [label, resp] of [["429", { status: 429 }], ["500", { status: 500 }], ["오프라인", { throw: true }]]) {
  for (const [btn, uid, who] of WITHDRAW) {
    await T(`친구 ${btn} ${label} — 목록에서 지우지 않는다`, async () => {
      const c = await boot();
      const box = openFriends(c);
      c.setRoutes((m, p) => (m === "DELETE" && p === `/friends/${uid}` ? resp : defaultRoutes(m, p)));
      findText(box, btn).click();
      await tick(12);
      c.segs[1].click();   // 다시 그린다 — 손에 든 목록(DATA)이 진짜로 안 바뀌었는지 본다
      assert.ok(allText(c.document.getElementById("friends")).includes(who),
        "서버가 못 지웠는데 목록에서 사라졌다 — 관계는 서버에 그대로 남아 있다");
      assert.ok(c.TOASTS.some((t) => t.includes("다시 눌러주세요")), "실패를 알리지 않는다");
    });
  }
}

// ══ green 6 · 401 만은 다르다 — 세션이 죽은 것이라 화면 전체가 로그아웃으로 돌아간다 ══
// 행이 사라지는 게 아니라 목록 자체가 닫힌다. 실패 안내를 덧붙이면 "로그아웃됐다"와
// "못 지웠다"가 겹쳐 무슨 일이 일어났는지 더 헷갈린다.
await T("친구 거절 401 — 세션 만료로 화면이 로그아웃된다", async () => {
  const c = await boot();
  const box = openFriends(c);
  c.setRoutes((m, p) => (m === "DELETE" && p === "/friends/u3" ? { status: 401 } : defaultRoutes(m, p)));
  findText(box, "거절").click();
  await tick(12);
  c.segs[1].click();
  assert.equal(c.store["shh-via"], undefined, "401 인데 로그인 표시가 남았다");
  assert.ok(allText(c.document.getElementById("friends")).includes("로그인하면"),
    "세션이 죽었는데 친구 목록을 계속 보여준다");
});

// ══ green 3 · 404 는 "이미 그런 관계가 없다" = 성공으로 수렴 ═══════════
// worker/index.js 의 DELETE /friends/:id 는 지운 행이 0개일 때 404 를 낸다.
// 이걸 실패로 묶으면 이미 사라진 관계의 유령 행을 영영 못 지운다.
await T("친구 끊기 404 — 이미 없는 관계는 목록에서도 지운다", async () => {
  const c = await boot();
  const box = openFriends(c);
  c.setRoutes((m, p) => (m === "DELETE" && p === "/friends/u2" ? { status: 404, body: { error: "친구가 아니에요" } } : defaultRoutes(m, p)));
  findText(box, "끊기").click();
  await tick(12);
  assert.ok(!allText(c.document.getElementById("friends")).includes("친구1"),
    "404(이미 관계 없음)인데 목록에 유령 행이 남았다");
});

// ══ red 10 · 같은 버튼을 두 번 눌러도 요청은 한 번 ═════════════════════
await T("친구 거절 중복 클릭 — 요청은 한 번만", async () => {
  const c = await boot();
  const box = openFriends(c);
  let release;
  c.setRoutes((m, p) => (m === "DELETE" && p === "/friends/u3"
    ? new Promise((r) => { release = () => r({ status: 200, body: { ok: true } }); })
    : defaultRoutes(m, p)));
  const b = findText(box, "거절");
  b.click(); b.click();
  await tick();
  assert.equal(c.deletes("/friends/u3"), 1, "중복 클릭이 요청을 두 번 보냈다 — 두 번째는 404 를 받는다");
  release?.();
});

// ══ red 11 · 두 번째 409 도 충돌이다. 저장 완료로 치면 단어가 사라진다 ══
await T("연속 409 — 두 번째도 충돌이면 저장 완료가 아니다", async () => {
  const store = { ...LOGGED_IN(), "shh-dirty": "1" };
  let puts = 0;
  const c = await boot({
    store,
    routes: (m, p) => {
      if (m === "PUT" && p === "/book") {
        puts++;
        return { status: 409, body: puts === 1 ? { words: ["나"], version: 5 } : { words: ["나", "다"], version: 7 } };
      }
      return defaultRoutes(m, p);
    },
  });
  c.setBook(["가"]);
  c.HOOKS.bookChanged(["가"]);
  await sleep(900);
  await tick(12);
  assert.equal(puts, 2, "재시도가 안 나갔다 — 이 테스트의 전제가 깨졌다");
  assert.equal(c.store["shh-dirty"], "1",
    "두 번째도 409(저장 실패)인데 '저장 끝'으로 표시했다 — 다음 동기화가 로컬을 서버 것으로 덮는다");
  assert.ok(!c.TOASTS.includes("다른 기기에서 담은 단어와 합쳤어요"),
    "저장이 안 됐는데 합쳤다고 말한다");
});

// ══ red 12 + green 4 · 저장이 날아간 뒤에 담은 단어는 아직 저장 전이다 ══
// 저장 요청이 날아간 **뒤에** 단어를 하나 더 담고, 그 다음에 첫 응답이 성공으로 도착한 상태.
// localRevision(편집 세대)과 serverVersion(서버가 센 번호)은 여기서 갈라진다.
async function staleSave() {
  const store = { ...LOGGED_IN(), "shh-dirty": "1" };
  let release;
  const c = await boot({
    store,
    routes: (m, p) => (m === "PUT" && p === "/book"
      ? new Promise((r) => { release = () => r({ status: 200, body: { ok: true, version: 4 } }); })
      : defaultRoutes(m, p)),
  });
  c.setBook(["가"]);
  c.HOOKS.bookChanged(["가"]);
  await sleep(900);          // 첫 저장이 날아가고 응답을 기다리는 중
  c.setBook(["가", "나"]);
  c.HOOKS.bookChanged(["가", "나"]);   // 응답 오기 전에 한 단어 더 담았다
  release();
  await tick(12);
  return c;
}

await T("저장 중 편집 — dirty 를 미리 지우지 않는다", async () => {
  const c = await staleSave();
  assert.equal(c.store["shh-dirty"], "1",
    "저장 중에 담은 단어가 아직 서버에 없는데 '저장 끝'으로 표시했다 — 앱을 닫으면 그 단어가 사라진다");
});

// ══ green 4 · 낡은 요청이어도 서버 버전은 반영한다 ═════════════════════
// **서버가 저장에 성공한 것은 사실**이다. 이 값을 버리면 다음 저장이 옛 번호를 들고 나가
// 반드시 409 를 맞고, 합집합 병합이 돌아 다른 기기에서 지운 단어가 되살아난다.
await T("저장 중 편집 — 그래도 서버 버전은 받아 적는다", async () => {
  const c = await staleSave();
  assert.equal(c.store["shh-bookver"], "4",
    "성공 응답의 서버 버전을 버렸다 — 다음 저장이 옛 번호로 나가 불필요한 충돌이 난다");
});

// ══ red 13 · 탭 두 개. 늦게 온 응답이 서버 버전을 되돌리면 안 된다 ══════
// 같은 기기의 탭 두 개는 localStorage 를 공유한다(= 아래 store 하나). 단일 요청 큐는 탭 안에서만
// 들기 때문에 이 경합은 큐로 막히지 않는다. 버전은 **더 큰 값만** 받아야 한다.
await T("탭 두 개 — 늦게 온 응답이 서버 버전을 되돌리지 않는다", async () => {
  const store = { ...LOGGED_IN(), "shh-dirty": "1" };
  let releaseA;
  const routesA = (m, p) => (m === "PUT" && p === "/book"
    ? new Promise((r) => { releaseA = () => r({ status: 200, body: { ok: true, version: 4 } }); })
    : defaultRoutes(m, p));
  const routesB = (m, p) => (m === "PUT" && p === "/book"
    ? { status: 200, body: { ok: true, version: 7 } }
    : defaultRoutes(m, p));

  const a = loadClient({ store, routes: routesA });
  for (const fn of a.HOOKS.ready) await fn();
  const b = loadClient({ store, routes: routesB });
  for (const fn of b.HOOKS.ready) await fn();
  await tick();

  a.setBook(["가"]); a.HOOKS.bookChanged(["가"]);
  await sleep(900);                       // A 의 저장이 날아갔다(응답 대기)
  b.setBook(["가", "나"]); b.HOOKS.bookChanged(["가", "나"]);
  await sleep(900);
  await tick(12);
  assert.equal(store["shh-bookver"], "7", "이 테스트의 전제가 깨졌다 — B 의 저장이 안 끝났다");
  releaseA();
  await tick(12);
  assert.equal(store["shh-bookver"], "7",
    "늦게 온 응답이 서버 버전을 되돌렸다 — 다음 저장이 옛 번호로 나가 충돌한다");
});

// ══ green 5 · 서버가 제공자를 하나도 안 준다면 버튼을 그리지 않는다 ══════
// 지금 라이브가 이 상태다(providers: []). 반환 형태를 건드리는 이번 작업이 이 판정을
// 소리 없이 뒤집기 쉬워서 못 박아 둔다.
await T("providers 가 비면 로그인 버튼을 그리지 않는다", async () => {
  const c = await boot({
    store: {},
    routes: (m, p) => (p === "/health"
      ? { status: 200, body: { ok: true, ready: false, providers: [] } }
      : defaultRoutes(m, p)),
  });
  const box = c.document.getElementById("mypage");
  assert.ok(!findText(box, "카카오로 로그인"), "설정된 제공자가 없는데 로그인 버튼을 그렸다");
  assert.ok(allText(box).includes("로그인을 준비 중"), "버튼도 안 그리고 이유도 안 말한다");
});

// ══ red · 서버에 못 물어봤으면 되는 척하지 않는다(fail-closed) ══════════
// 예전에는 이 경우 오히려 버튼 셋을 다 그렸다("아직 모르니 숨기지 말자") — 사용자가 얻는 것은
// 눌러도 503 만 나는 버튼이었다. **문구는 providers:[] 와 달라야 한다**: 원인이 다르면
// 사용자가 할 일도 다르다(다시 시도할 일 vs 기다릴 일).
for (const [label, resp] of [["연결 실패", { throw: true }], ["시간 초과", { throwName: "TimeoutError" }],
                             ["503", { status: 503 }]]) {
  await T(`/health ${label} — 로그인 버튼을 그리지 않고 이유를 말한다`, async () => {
    const c = await boot({ store: {}, routes: (m, p) => (p === "/health" ? resp : defaultRoutes(m, p)) });
    const box = c.document.getElementById("mypage");
    for (const k of ["카카오", "네이버", "구글"]) {
      assert.ok(!findText(box, `${k}로 로그인`), `서버에 못 물어봤는데 ${k} 버튼을 그렸다`);
    }
    const t = allText(box);
    assert.ok(t.includes("연결할 수 없어"), "왜 로그인이 안 되는지 말하지 않는다");
    assert.ok(!t.includes("로그인을 준비 중"), "연결 실패를 '준비 중'이라고 말한다 — 원인이 다르다");
    assert.ok(t.includes("사전과 연습은 그대로"), "로그인만 닫는다는 걸 안 알린다 — 앱이 죽은 줄 안다");
  });
}

// ══ P1-3 · 로그인 왕복 요청도 언젠가 끝난다 ═══════════════════════════════
// apiExchange 와 apiLogoutRaw 만 공통 request() 를 안 거친다(아직 로그인 표시가 없는 자리라서).
// 그래서 이 둘만 **시간 제한이 없었다.** 응답이 영원히 안 오면 onAppReady 가 끝나지 않고,
// 그러면 로그인·친구·동기화가 통째로 안 붙은 채 화면만 떠 있다.
{
  const CODE_BACK = { search: "?code=test-code&state=test-state" };

  // 시간 초과와 진짜 4xx/5xx 는 **다른 일**이다 — 하나는 다시 시도할 일, 하나는 기다릴 일이다.
  for (const [label, resp, want] of [
    ["시간 초과", { throwName: "TimeoutError" }, "연결"],
    ["네트워크 끊김", { throw: true }, "연결"],
    ["502", { status: 502 }, "로그인에 실패"],
  ]) {
    await T(`OAuth 교환 ${label} — 끝나고, 원인에 맞게 말한다`, async () => {
      const done = await Promise.race([
        boot({ store: {}, loc: CODE_BACK, routes: (m, p) => (p.startsWith("/exchange") ? resp : defaultRoutes(m, p)) }),
        sleep(3000).then(() => null),
      ]);
      assert.ok(done, "OAuth 교환이 안 끝나 앱 초기화가 멈췄다");
      assert.ok(done.TOASTS.some((t) => t.includes(want)),
        `${label} 인데 안 맞는 말을 한다: ${JSON.stringify(done.TOASTS)}`);
      assert.equal(done.store["shh-via"], undefined, "교환이 실패했는데 로그인 표시를 세웠다");
    });
  }

  // nonce 가 안 맞으면 서버에 세션을 끊으라고 알린다. 그 요청이 안 끝나면 앱 전체가 멈춘다 —
  // **로그아웃 요청 하나 때문에 앱이 안 뜨는 것**이 가장 나쁜 결과다.
  const nonceMismatch = (routes) => boot({
    store: { "shh-nonce": "내가-적어둔-값" },
    loc: { hash: "#login=ok&via=kakao&n=남이-보낸-값" },
    routes,
  });

  await T("nonce 불일치 뒤 raw 로그아웃이 시간 초과여도 앱 초기화는 끝난다", async () => {
    const done = await Promise.race([
      nonceMismatch((m, p) => (m === "DELETE" && p === "/session" ? { throwName: "TimeoutError" } : defaultRoutes(m, p))),
      sleep(3000).then(() => null),
    ]);
    assert.ok(done, "raw 로그아웃이 안 끝나 앱 초기화가 영원히 멈췄다");
    assert.equal(done.store["shh-via"], undefined, "nonce 가 안 맞는데 로그인 표시를 세웠다");
    assert.ok(done.TOASTS.some((t) => t.includes("맞지 않아요")), "왜 로그인이 안 됐는지 말하지 않는다");
  });

  // 위 검사는 "시간이 초과되면 어떻게 되나"를 잰다. **초과될 수단이 실제로 붙어 있는지**는
  // 따로 봐야 한다 — 스텁은 진짜 12초를 세지 않으므로 둘을 한 검사로 묶으면 한쪽이 빈다.
  await T("로그인 왕복 요청에도 끊을 수단(AbortSignal)이 붙는다", async () => {
    const c = await nonceMismatch(defaultRoutes);
    const raw = c.calls.find((x) => x.method === "DELETE" && x.path === "/session");
    assert.ok(raw, "nonce 가 안 맞는데 서버 세션을 안 끊었다 — 화면만 로그아웃이고 서버는 로그인이다");
    assert.ok(raw.aborts, "raw 로그아웃에 시간 제한이 없다 — 응답이 안 오면 앱이 안 뜬다");
    const ex = (await boot({
      store: {}, loc: { search: "?code=test-code&state=test-state" },
      routes: (m, p) => (p.startsWith("/exchange") ? { status: 502 } : defaultRoutes(m, p)),
    })).calls.find((x) => x.path.startsWith("/exchange"));
    assert.ok(ex && ex.aborts, "OAuth 교환에 시간 제한이 없다 — 영원히 기다릴 수 있다");
  });
}

// ══ P0-3 · 탭 두 개. 내 저장 성공이 **다른 탭의 편집**을 지우지 않는다 ═══
// `shh-dirty` 는 localStorage 라 탭이 함께 쓰는데, "그 사이에 또 고쳤나"를 재는 편집 세대는
// 탭 안의 변수였다. 그래서 A 의 저장이 성공하면 A 는 **자기 편집만** 보고 공용 dirty 를 0 으로
// 만들었다 — 그 사이 B 가 담은 단어는 아직 서버에 없는데 "저장 끝"이 된다.
// B 의 저장이 실패(오프라인)하면 그 단어는 다음 동기화에서 pull 로 덮여 **사라진다.**
await T("탭 두 개 — 다른 탭의 편집을 내 저장 성공이 지우지 않는다", async () => {
  const store = { ...LOGGED_IN(), "shh-dirty": "0" };
  let releaseA;
  const a = loadClient({
    store,
    routes: (m, p) => (m === "PUT" && p === "/book"
      ? new Promise((r) => { releaseA = () => r({ status: 200, body: { ok: true, version: 4 } }); })
      : defaultRoutes(m, p)),
  });
  // B 는 오프라인이다 — B 가 자기 편집을 스스로 올려 dirty 를 지우면 이 경합이 안 보인다.
  const b = loadClient({
    store,
    routes: (m, p) => (m === "PUT" && p === "/book" ? { throw: true } : defaultRoutes(m, p)),
  });
  for (const fn of a.HOOKS.ready) await fn();
  for (const fn of b.HOOKS.ready) await fn();
  await tick();

  a.setBook(["가"]); a.HOOKS.bookChanged(["가"]);
  await sleep(900);                                    // A 의 저장이 날아갔다(응답 대기)
  b.setBook(["가", "나"]); b.HOOKS.bookChanged(["가", "나"]);   // 다른 탭이 한 단어 더 담았다
  await tick(4);
  assert.equal(store["shh-dirty"], "1", "이 테스트의 전제가 깨졌다 — B 의 편집이 dirty 를 안 세웠다");
  releaseA();
  await sleep(900);
  await tick(12);
  assert.equal(store["shh-dirty"], "1",
    "다른 탭이 담은 단어가 아직 서버에 없는데 '저장 끝'으로 표시했다 — 그 탭을 닫으면 그 단어가 사라진다");
});

// ══ P0-1 · 친구 목록이 「불러오는 중」에서 멈추지 않는다 ══════════════════
// 사용자가 실제로 겪은 증상이다: 「우리 → 친구」에서 `불러오는 중이에요…` 만 계속 남고
// 오류도 재시도도 없었다. 원인은 308ea43 세대의 renderFriends 다 —
//   apiFriends().then((d) => { if (d) { … } });
// **else 도 catch 도 finally 도 없다.** 그 세대의 apiCall 은 401·5xx·오프라인·파싱 실패를
// 전부 null 하나로 돌려줬으므로, 실패하면 화면이 영원히 로딩에 머문다.
// 그 세대가 아직 도는 이유는 P0-2(서비스워커 캐시 세대)다.
//
// 아래는 **어떤 실패에서도 로딩이 끝나고 사람이 할 수 있는 다음 행동이 남는지**를 잰다.
const FRIENDS_GETS = (c) => c.calls.filter((x) => x.method === "GET" && x.path === "/friends").length;
const LOADING = "불러오는 중";
const FRIENDS_EMPTY = { code: "invite000", friends: [], in: [], out: [] };

for (const [label, resp] of [
  ["401", { status: 401, body: { error: "로그인이 필요해요" } }],
  ["403", { status: 403 }], ["429", { status: 429 }], ["500", { status: 500 }],
  ["네트워크 끊김", { throw: true }], ["시간 초과", { throwName: "TimeoutError" }],
  ["JSON 파싱 실패", { status: 200, badJson: true }],
]) {
  await T(`친구 목록 ${label} — 로딩에서 멈추지 않는다`, async () => {
    const c = await boot({ routes: (m, p) => (m === "GET" && p === "/friends" ? resp : defaultRoutes(m, p)) });
    const box = openFriends(c);
    await tick(12);
    const t = allText(box);
    assert.ok(!t.includes(LOADING), `${label} 인데 '불러오는 중'에 멈춰 있다 — 사용자가 끝을 못 본다`);
    // 401 은 세션이 죽은 것이라 화면 전체가 로그인 안내로 돌아간다(재시도가 아니라 로그인이 할 일이다).
    if (label === "401") {
      assert.ok(t.includes("로그인하면"), "세션이 죽었는데 친구 화면을 그대로 둔다");
      assert.equal(c.store["shh-invite"], undefined, "세션이 죽었는데 앞 계정 초대 코드가 남았다");
    } else {
      assert.ok(findText(box, "다시 시도"), `${label} 인데 다시 시도할 방법이 없다`);
    }
  });
}

// 서버가 2xx 를 줬어도 **모양이 다르면 목록이 아니다.** 경계에서 안 보면 화면을 그리다
// 도중에 예외가 나고, 그러면 로딩 문구가 지워지지도 채워지지도 않은 채 남는다.
for (const [label, body] of [
  ["friends 누락", { code: "c1", in: [], out: [] }],
  ["in 이 배열이 아님", { code: "c1", friends: [], in: "nope", out: [] }],
  ["out 이 null", { code: "c1", friends: [], in: [], out: null }],
  ["code 가 문자열이 아님", { code: 7, friends: [], in: [], out: [] }],
  ["본문이 배열", []],
  ["본문이 빈 객체", {}],
]) {
  await T(`친구 목록 스키마 위반(${label}) — 목록으로 받아들이지 않는다`, async () => {
    const c = await boot({ routes: (m, p) => (m === "GET" && p === "/friends" ? { status: 200, body } : defaultRoutes(m, p)) });
    const box = openFriends(c);
    await tick(12);
    const t = allText(box);
    assert.ok(!t.includes(LOADING), "이상한 응답을 받고 로딩에 멈춰 있다");
    assert.ok(findText(box, "다시 시도"), "이상한 응답인데 다시 시도할 방법이 없다");
    assert.ok(!c.store["shh-invite"] || typeof c.store["shh-invite"] === "string" && c.store["shh-invite"] !== "undefined",
      "코드가 아닌 값을 초대 코드로 저장했다 — 그 링크는 아무 데도 안 닿는다");
  });
}

await T("친구 목록 200 정상 — 목록이 나온다", async () => {
  const c = await boot();
  const box = openFriends(c);
  await tick(12);
  const t = allText(box);
  assert.ok(!t.includes(LOADING), "성공했는데 로딩이 남아 있다");
  assert.ok(t.includes("친구1"), "목록이 안 나온다");
});

await T("친구 목록 200 빈 목록 — 로딩이 아니라 안내를 보여준다", async () => {
  const c = await boot({ routes: (m, p) => (m === "GET" && p === "/friends" ? { status: 200, body: FRIENDS_EMPTY } : defaultRoutes(m, p)) });
  const box = openFriends(c);
  await tick(12);
  const t = allText(box);
  assert.ok(!t.includes(LOADING), "빈 목록인데 로딩에 멈춰 있다");
  assert.ok(t.includes("아직 친구가 없어요"), "빈 목록 안내가 없다 — 고장인지 빈 건지 알 수 없다");
});

await T("badge 갱신과 목록 열기가 겹쳐도 GET 은 한 번", async () => {
  let release;
  const c = loadClient({
    store: LOGGED_IN(),
    routes: (m, p) => (m === "GET" && p === "/friends"
      ? new Promise((r) => { release = () => r({ status: 200, body: FRIENDS_OK }); })
      : defaultRoutes(m, p)),
  });
  c.HOOKS.ready.forEach((fn) => fn());   // await 하지 않는다 — 응답이 아직 안 왔을 때를 만든다
  await tick();
  openFriends(c);                        // 화면 진입도 같은 목록을 원한다
  await tick();
  assert.equal(FRIENDS_GETS(c), 1, "같은 목록을 두 번 물어봤다 — 열 때마다 요청이 늘어난다");
  release();
  await tick(12);
  assert.ok(allText(c.document.getElementById("friends")).includes("친구1"), "하나로 합친 응답이 화면에 안 닿았다");
});

await T("실패 뒤 다시 시도 — 성공하면 목록이 나온다", async () => {
  let fail = true;
  const c = await boot({
    routes: (m, p) => (m === "GET" && p === "/friends"
      ? (fail ? { status: 500 } : { status: 200, body: FRIENDS_OK })
      : defaultRoutes(m, p)),
  });
  const box = openFriends(c);
  await tick(12);
  const retry = findText(box, "다시 시도");
  assert.ok(retry, "재시도 버튼이 없다");
  fail = false;
  retry.click();
  await tick(12);
  const t = allText(c.document.getElementById("friends"));
  assert.ok(t.includes("친구1"), "다시 시도했는데 목록이 안 나온다 — 실패가 영구히 붙었다");
  assert.ok(!t.includes(LOADING), "다시 시도 뒤에도 로딩이 남아 있다");
});

await T("친구 갈래를 떠난 뒤 늦게 온 응답이 내 단어장 화면을 덮지 않는다", async () => {
  let release;
  const c = loadClient({
    store: LOGGED_IN(),
    routes: (m, p) => (m === "GET" && p === "/friends"
      ? new Promise((r) => { release = () => r({ status: 200, body: FRIENDS_OK }); })
      : defaultRoutes(m, p)),
  });
  c.HOOKS.ready.forEach((fn) => fn());
  await tick();
  openFriends(c);            // 친구 갈래 — 로딩
  await tick();
  c.segs[0].click();         // 내 단어장으로 떠난다
  await tick();
  release();
  await tick(12);
  assert.ok(c.document.getElementById("friends").hidden, "떠났는데 늦게 온 응답이 친구 화면을 다시 열었다");
  assert.ok(!c.document.getElementById("wordbook").hidden, "늦게 온 응답이 내 단어장을 가렸다");
});

const failed = RESULTS.filter((r) => !r[0]);
for (const [pass, name, why] of RESULTS) if (!pass) console.log(`  ✗ ${name}\n      ${why}`);
if (failed.length) {
  console.log(`test-client: ${n - failed.length}/${n} 통과, ${failed.length}개 실패`);
  process.exit(1);
}
console.log(`test-client: ${n}개 통과 — 로그아웃·계정삭제·친구철회 실패 처리 · 저장 완료 판정`
  + ` · 친구 목록 로딩/실패/재시도/스키마/중복요청 · 탭 간 편집 세대 · OAuth 왕복 시간 제한`);
