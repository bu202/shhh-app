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
function loadClient({ store = {}, routes } = {}) {
  const calls = [];
  let route = routes || (() => ({ status: 200, body: {} }));
  let confirmAnswer = true;

  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const location = { origin: "https://test", pathname: "/", search: "", hash: "", href: "" };
  const history = { replaceState() {} };
  const crypto = { randomUUID: () => "nonce-fixed" };

  const fetch = async (url, opt = {}) => {
    const method = (opt.method || "GET").toUpperCase();
    const path = String(url).replace(/^\/api/, "");
    calls.push({ method, path });
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
  const c = loadClient({ store: o.store ?? LOGGED_IN(), routes: o.routes || defaultRoutes });
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

const failed = RESULTS.filter((r) => !r[0]);
for (const [pass, name, why] of RESULTS) if (!pass) console.log(`  ✗ ${name}\n      ${why}`);
if (failed.length) {
  console.log(`test-client: ${n - failed.length}/${n} 통과, ${failed.length}개 실패`);
  process.exit(1);
}
console.log(`test-client: ${n}개 통과 — 로그아웃·계정삭제·친구철회 실패 처리 · 저장 완료 판정`);
