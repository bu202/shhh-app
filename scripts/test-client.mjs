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
    // 가입 화면이 쓰는 것들. 없으면 "함수가 아니다"로 죽는데, 그건 화면이 아니라
    // **스텁이 모자란 것**이라 진짜 결함을 가린다.
    href: "", target: "", rel: "", checked: false, disabled: false, parentNode: null,
    dataset: {}, children: [], handlers: {}, attrs: {}, _text: "", _html: "",
    classList: { toggle() {}, add() {}, remove() {} },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { for (const c of cs) { this.children.push(c); if (c) c.parentNode = this; } },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      c.parentNode = this;
      return c;
    },
    remove() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
      this.parentNode = null;
    },
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
  // ⚠️ `subtle` 은 **진짜**를 준다. 가입 화면이 정책 파일 바이트를 직접 해시해 서버 값과
  //    대조하는데, 그 해시를 흉내내면 재려던 것(해시가 다르면 가입 버튼을 안 그린다)을 못 잰다.
  const crypto = { randomUUID: () => "nonce-fixed", subtle: globalThis.crypto.subtle };

  const fetch = async (url, opt = {}) => {
    const method = (opt.method || "GET").toUpperCase();
    const path = String(url).replace(/^\/api/, "");
    // 시간 제한이 **붙었는지**도 기록한다. 이 스텁은 진짜 타이머를 돌리지 않으므로
    // "12초 뒤에 끊기나"는 못 재지만, "끊을 수단을 들려 보냈나"는 여기서 잴 수 있다.
    calls.push({ method, path, aborts: !!opt.signal, body: opt.body });
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
      // 정책 문서는 **바이트로** 받는다 — 화면이 그것을 직접 해시하기 때문이다.
      arrayBuffer: async () => new TextEncoder().encode(r.text ?? "").buffer,
    };
  };

  const segs = ["mine", "friends"].map((b) => { const e = makeEl("button"); e.dataset.book = b; return e; });
  const byId = new Map();
  // ── 사람 확인 위젯 대역 (2026-08-22 · 결정 3) ────────────────────────────
  // 가입 화면은 외부 스크립트를 `document.head` 에 붙여 받는다. 여기서는 그 붙이는 순간을
  // 가로채 **성공/실패를 골라 만든다** — 실제 네트워크를 타지 않으면서 두 갈래를 다 잰다.
  const window = { turnstile: null };
  let turnstileMode = "ok";        // "ok" · "script-fail" · "render-throw"
  const head = makeEl("head");
  head.appendChild = (c) => {
    head.children.push(c);
    if (String(c.src || "").includes("challenges.cloudflare.com")) {
      if (turnstileMode === "script-fail") {
        queueMicrotask(() => { for (const fn of c.handlers.error || []) fn({}); });
      } else {
        window.turnstile = {
          render(box, opts) {
            if (turnstileMode === "render-throw") throw new Error("no");
            // 실제 위젯처럼 **나중에** 토큰을 준다. 즉시 주면 「토큰 없이도 열린다」를 못 잡는다.
            box.__solve = (tok) => opts.callback(tok);
            box.__expire = () => opts["expired-callback"]();
            box.__error = () => opts["error-callback"]();
          },
        };
        queueMicrotask(() => { for (const fn of c.handlers.load || []) fn({}); });
      }
    }
    return c;
  };
  const document = {
    head,
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

  // window 이벤트를 붙잡아 둔다. `storage` 는 **다른 탭이 localStorage 를 고쳤을 때만** 나는
  // 이벤트라, 이 하니스처럼 인스턴스 둘이 한 store 를 공유할 때 그 상황을 그대로 만들 수 있다.
  const winHandlers = {};
  const addEventListener = (n, fn) => { (winHandlers[n] ||= []).push(fn); };

  const inner = new Function(
    "localStorage", "location", "history", "crypto", "fetch", "document", "confirm", "addEventListener",
    "window",
    src,
  )(localStorage, location, history, crypto, fetch, document, () => confirmAnswer, addEventListener, window);

  return {
    ...inner, store, calls, document, segs, location,
    fireStorage: (key, newValue) => { for (const fn of winHandlers.storage || []) fn({ key, newValue }); },
    setTurnstileMode: (m) => { turnstileMode = m; window.turnstile = null; },
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
// ⚠️ **본문을 복사해서 준다.** 안 하면 화면 코드가 손에 든 목록을 고칠 때(`DATA.code = …`,
//    `f.count = …`) **픽스처 원본이 바뀌고**, 그 오염이 다음 테스트로 넘어간다. 실제로 겪었다 —
//    회전 테스트가 `FRIENDS_OK.code` 를 "new111" 로 바꿔 놓아서, 뒤 테스트의 GET /friends 가
//    그 값을 돌려줬다. 진짜 서버는 매번 새 응답을 만든다.
const defaultRoutes = (m, p) => {
  if (p === "/health") return { status: 200, body: { ok: true, ready: true, signupReady: true, providers: ["kakao", "naver", "google"] } };
  if (p === "/book" && m === "GET") return { status: 200, body: structuredClone(BOOK_OK) };
  if (p === "/friends" && m === "GET") return { status: 200, body: structuredClone(FRIENDS_OK) };
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

// ══ P0-4 · 탭 두 개에서 계정을 바꿔도 단어장이 안 섞인다 ═════════════════
// 쿠키는 탭이 아니라 브라우저 전체가 공유한다. 그래서 탭 B 에서 계정을 바꾸면 탭 A 의 요청도
// 새 계정의 쿠키로 나간다 — 탭 A 는 그걸 모른 채 앞 계정 단어장을 저장한다.
// 문지기를 둘 둔다: ① 저장 요청이 **자기가 믿는 계정**을 말하고 서버가 대조한다(test-friends 96~100)
//                  ② 탭이 다른 탭의 계정 변경을 storage 로 알아채고 자동 저장을 멈춘다
{
  // 두 인스턴스가 같은 store 를 쓴다 = 한 브라우저의 탭 두 개.
  const twoTabs = async (routesA, routesB, store) => {
    const a = loadClient({ store, routes: routesA });
    for (const fn of a.HOOKS.ready) await fn();
    const b = loadClient({ store, routes: routesB });
    for (const fn of b.HOOKS.ready) await fn();
    await tick(12);
    return { a, b };
  };

  await T("탭 A 는 자기가 믿는 계정을 저장 요청에 실어 보낸다", async () => {
    const puts = [];
    const c = await boot({
      routes: (m, p, opt) => {
        if (m === "PUT" && p === "/book") { puts.push(JSON.parse(opt.body)); return { status: 200, body: { ok: true, version: 4 } }; }
        return defaultRoutes(m, p);
      },
    });
    c.setBook(["가"]); c.HOOKS.bookChanged(["가"]);
    await sleep(900); await tick(12);
    assert.equal(puts.length, 1, "저장이 안 나갔다 — 이 테스트의 전제가 깨졌다");
    assert.equal(puts[0].me, "u1", "저장 요청이 자기가 누구라고 믿는지 말하지 않는다 — 서버가 대조할 근거가 없다");
  });

  await T("계정이 확인되지 않은 탭은 자동 저장을 아예 안 보낸다", async () => {
    // 로그인 표시는 있는데 서버가 누구인지 아직 말해준 적이 없다(shh-me 없음).
    // 이 상태로 저장하면 **틀렸는지 맞았는지 서버도 못 가린다** — 그러면 보내지 않는 쪽이 맞다.
    const store = { "shh-via": "kakao", "shh-uid": "", "shh-dirty": "0" };
    const c = await boot({ store, routes: (m, p) => (m === "GET" && p === "/book" ? { throw: true } : defaultRoutes(m, p)) });
    c.setBook(["가"]); c.HOOKS.bookChanged(["가"]);
    await sleep(900); await tick(12);
    assert.equal(c.calls.filter((x) => x.method === "PUT" && x.path === "/book").length, 0,
      "내가 누구인지도 모르는 채로 저장을 보냈다 — 남의 계정에 쌓일 수 있다");
    assert.equal(c.store["shh-dirty"], "1", "안 보냈으면 '아직 저장 안 됨'으로 남아야 다음에 올라간다");
  });

  // 계정을 가리키는 값이 **둘**이다(`shh-me` = 서버가 말해 준 id, `shh-uid` = 마지막으로 맞춰 둔 id).
  // 실제 로그인은 둘을 잇달아 쓰지만, 그 사이에는 **하나만 바뀐 순간**이 있고 storage 이벤트는
  // 그 순간마다 따로 난다. 한쪽만 보면 그 창을 통째로 놓친다 —
  // 실제로 브라우저에서 `shh-uid` 만 바꿔 보고 이 구멍을 찾았다(단위 테스트는 둘 다 바꿔서 통과했다).
  for (const [label, keys] of [
    ["둘 다 바뀜", { "shh-uid": "u9", "shh-me": "u9" }],
    ["shh-uid 만 먼저 바뀜", { "shh-uid": "u9" }],
    ["shh-me 만 먼저 바뀜", { "shh-me": "u9" }],
    ["다른 탭이 로그아웃함", { "shh-via": null, "shh-me": null }],
  ]) {
    await T(`다른 탭의 계정 변경(${label}) — 이 탭은 자동 저장을 멈춘다`, async () => {
      const store = { ...LOGGED_IN(), "shh-dirty": "0" };
      const { a } = await twoTabs(defaultRoutes, defaultRoutes, store);
      for (const [k, v] of Object.entries(keys)) {
        if (v === null) delete store[k]; else store[k] = v;
        a.fireStorage(k, v);
      }
      await tick(4);
      const before = a.calls.filter((x) => x.method === "PUT" && x.path === "/book").length;
      a.setBook(["가"]); a.HOOKS.bookChanged(["가"]);
      await sleep(900); await tick(12);
      assert.equal(a.calls.filter((x) => x.method === "PUT" && x.path === "/book").length, before,
        "다른 탭이 계정을 바꿨는데 앞 계정 단어장을 그대로 올렸다");
      assert.equal(store["shh-dirty"], "1", "안 보냈으면 '아직 저장 안 됨'으로 남아야 한다");
    });
  }

  await T("서버가 '계정이 바뀌었다'고 하면 합치지 않고 저장 실패로 남긴다", async () => {
    const store = { ...LOGGED_IN(), "shh-dirty": "1" };
    const c = await boot({
      store,
      routes: (m, p) => (m === "PUT" && p === "/book"
        ? { status: 409, body: { error: "다른 계정으로 로그인돼 있어요", accountChanged: true } }
        : defaultRoutes(m, p)),
    });
    c.setBook(["가"]); c.HOOKS.bookChanged(["가"]);
    await sleep(900); await tick(12);
    assert.equal(c.store["shh-dirty"], "1", "저장이 거절됐는데 '저장 끝'으로 표시했다");
    assert.ok(!c.TOASTS.includes("다른 기기에서 담은 단어와 합쳤어요"),
      "계정이 바뀐 것을 기기 충돌로 오해해 **남의 단어장과 합쳤다**");
    assert.ok(c.TOASTS.some((t) => t.includes("계정")), "왜 저장이 안 됐는지 말하지 않는다");
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

// ══ P1-2 · 두 번 눌러도 한 번, 늦게 온 답이 지금 화면을 덮지 않는다 ══════
// 철회(거절·취소·끊기)에는 이미 잠금이 있었지만 **수락과 링크 회전에는 없었다.**
// 둘 다 두 번 누르면 두 번째 요청이 이미 없어진 것을 건드린다 — 수락은 404, 회전은
// **방금 만든 코드를 그 자리에서 폐기하고 화면에는 죽은 코드를 남긴다.**
{
  await T("수락 중복 클릭 — 요청은 한 번만", async () => {
    let release;
    const c = await boot();
    const box = openFriends(c);
    c.setRoutes((m, p) => (m === "PUT" && p === "/friends/u3"
      ? new Promise((r) => { release = () => r({ status: 200, body: { ok: true, friend: { count: 1 } } }); })
      : defaultRoutes(m, p)));
    const b = findText(box, "수락");
    b.click(); b.click();
    await tick();
    assert.equal(c.calls.filter((x) => x.method === "PUT" && x.path === "/friends/u3").length, 1,
      "중복 클릭이 수락을 두 번 보냈다 — 두 번째는 이미 친구인 관계를 건드린다");
    release?.();
    await tick(12);
  });

  await T("초대 링크 회전 중복 클릭 — 요청은 한 번만", async () => {
    let release;
    const c = await boot();
    const box = openFriends(c);
    c.setRoutes((m, p) => (m === "POST" && p === "/friends/code"
      ? new Promise((r) => { release = () => r({ status: 200, body: { code: "new111" } }); })
      : defaultRoutes(m, p)));
    const b = findText(box, "초대 링크 새로 만들기");
    b.click(); b.click();
    await tick();
    assert.equal(c.calls.filter((x) => x.method === "POST" && x.path === "/friends/code").length, 1,
      "회전을 두 번 보냈다 — 두 번째가 첫 번째 코드를 죽이고 화면엔 죽은 코드가 남는다");
    release?.();
    await tick(12);
    assert.equal(c.store["shh-invite"], "new111", "회전 결과가 화면·저장소에 안 남았다");
  });

  // 회전에 자기 레이트리밋(분당 5회)이 생겼다 — 이제 이 버튼은 **429 를 받을 수 있다.**
  // 그때 "연결이 안 돼요"라고 말하면 사용자는 와이파이를 확인하러 간다. 원인이 다르면
  // 할 일도 다르다: 여기서 할 일은 잠깐 기다리는 것뿐이다.
  await T("초대 링크 회전이 한도에 걸리면 연결 탓을 하지 않는다", async () => {
    const c = await boot();
    const box = openFriends(c);
    await tick(12);
    c.setRoutes((m, p) => (m === "POST" && p === "/friends/code"
      ? { status: 429, body: { error: "잠시 뒤에 다시 시도해 주세요" } }
      : defaultRoutes(m, p)));
    findText(box, "초대 링크 새로 만들기").click();
    await tick(12);
    assert.ok(!c.TOASTS.some((t) => t.includes("연결이 안 돼요")),
      `한도에 걸렸는데 연결 문제라고 말한다: ${JSON.stringify(c.TOASTS)}`);
    assert.ok(c.TOASTS.some((t) => t.includes("잠시 뒤")), `왜 안 됐는지 말하지 않는다: ${JSON.stringify(c.TOASTS)}`);
    // 그리고 **저장소의 코드를 건드리지 않는다** — 실패했는데 링크가 바뀌면 안 된다.
    assert.equal(c.store["shh-invite"], "invite000", "회전이 실패했는데 손에 든 초대 코드가 바뀌었다");
    // 버튼은 다시 눌러야 하므로 풀려 있어야 한다.
    assert.equal(findText(box, "초대 링크 새로 만들기").disabled, false, "실패했는데 버튼이 잠긴 채로 남았다");
  });

  await T("친구 A 단어장을 열고 B 를 열면, A 의 늦은 응답이 B 화면을 덮지 않는다", async () => {
    const TWO = { code: "invite000", in: [], out: [],
                  friends: [{ uid: "uA", name: "에이", count: 1 }, { uid: "uB", name: "비이", count: 1 }] };
    let releaseA;
    const c = await boot({ routes: (m, p) => (m === "GET" && p === "/friends" ? { status: 200, body: TWO } : defaultRoutes(m, p)) });
    const box = openFriends(c);
    await tick(12);
    c.setRoutes((m, p) => {
      if (p === "/friends/uA/book") return new Promise((r) => { releaseA = () => r({ status: 200, body: { words: [] } }); });
      if (p === "/friends/uB/book") return { status: 200, body: { words: ["가"] } };
      return defaultRoutes(m, p);
    });
    const [openA, openB] = walk(box).filter((e) => e._text === "단어장 보기");
    openA.click();
    await tick();
    openB.click();
    await tick(12);
    releaseA();                      // A 의 응답이 뒤늦게 도착한다
    await tick(12);
    const body = c.document.getElementById("fr-book-body");
    assert.ok(!allText(body).includes("아직 담은 단어가 없어요"),
      "A 의 늦은 응답이 지금 열려 있는 B 의 단어장 화면을 덮었다 — 남의 단어장을 보고 있게 된다");
    assert.equal(c.document.getElementById("fr-book-title")._text, "비이님의 단어장이에요!",
      "제목과 내용이 다른 사람을 가리킨다");
  });
}

// ══ 회원가입 화면 ═══════════════════════════════════════════════════════
// 왜 여기서 재나: 가입 화면은 **비동기로 여러 파일을 받아 해시까지 맞춰 보는** 화면이다.
// 이런 화면이 실패했을 때 무슨 일이 나는지는 정규식으로 소스를 훑어서는 알 수 없다 —
// 친구 목록이 「불러오는 중이에요…」에서 영영 멈췄던 것이 정확히 그 종류의 결함이었다.
await T("회원가입 화면 — 정책 해시 대조 · 필수 체크 · 실패 처리 · 연타 잠금", async () => {
  const t = (m) => m;                                  // 이 파일은 이름이 아니라 메시지로 말한다
  // ⚠️ **`tick()` 만으로는 부족하다.** 가입 화면은 `crypto.subtle.digest` 를 기다리는데
  //    그건 마이크로태스크가 아니라 **매크로태스크**로 풀린다 — tick 을 아무리 돌려도
  //    「약관을 불러오고 있어요…」에서 멈춘 것처럼 보인다. 실제 화면의 결함이 아니라
  //    기다리는 방법이 틀린 것이라, 여기서 진짜 타이머를 한 번 넘긴다.
  const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) { await tick(4); await sleep(1); } };

  const SUMMARY = "가입하시면 이렇게 됩니다.\n요약 본문.";
  const AGE14 = "만 14세 이상입니다.";
  const enc = new TextEncoder();
  const sha = async (str) => [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", enc.encode(str)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const PV = "abcdef123456";
  const docsFor = async () => ({
    terms: { path: "policies/terms-aaa.html", hash: await sha("TERMS") },
    privacy: { path: "policies/privacy-bbb.html", hash: await sha("PRIVACY") },
    age14: { path: "policies/age14-ccc.txt", hash: await sha(AGE14) },
    summary: { path: "policies/summary-ddd.txt", hash: await sha(SUMMARY) },
  });
  const bodies = { "policies/age14-ccc.txt": AGE14, "policies/summary-ddd.txt": SUMMARY,
                   "policies/terms-aaa.html": "TERMS", "policies/privacy-bbb.html": "PRIVACY" };

  // 로그아웃 상태로 앱을 띄우고 게이트를 연다.
  const openApp = async (routes, store = {}) => {
    const c = loadClient({ store, routes });
    for (const fn of c.HOOKS.ready) await fn();
    await settle();
    return c;
  };
  const gate = (c) => c.document.getElementById("gate");
  const btn = (c, text) => walk(gate(c)).find((e) => e._text === text);
  const hasText = (c, needle) => allText(gate(c)).includes(needle);

  const baseRoutes = (over = {}) => async (m, p) => {
    if (p === "/health") return { status: 200, body: { ok: true, signupReady: true,
      providers: ["kakao", "naver", "google"], turnstileSiteKey: "0xTEST" } };
    if (p === "/policies") return over.policies ?? { status: 200, body: { pv: PV, docs: await docsFor() } };
    if (p.startsWith("./policies/")) {
      const key = p.slice(2);
      if (over.docFail) return { status: 500, body: {} };
      return { status: 200, text: over.tamper && key.includes("summary") ? "고쳐진 요약" : bodies[key] };
    }
    if (p === "/signup/start") return over.signup ?? { status: 200, body: { url: "https://kauth.kakao.com/go" } };
    return { status: 200, body: { ok: true } };
  };

  // 1. **게이트의 길이 셋이다.** 예전에는 「로그인」 하나였고 그것이 곧 가입이었다.
  {
    const c = await openApp(baseRoutes());
    assert.ok(btn(c, "가입하기"), t("게이트에 가입하기가 없다"));
    assert.ok(btn(c, "이미 계정이 있어요 — 로그인"), t("게이트에 로그인이 없다"));
    assert.ok(btn(c, "로그인 없이 둘러보기"), t("게이트에 둘러보기가 없다"));
    // ★ **게이트 안에 방침·약관 링크가 있다.** 게이트가 화면을 완전히 덮으므로,
    //   여기 없으면 「무엇을 받는지」에 닿을 방법이 없다.
    const links = walk(gate(c)).filter((e) => e.attrs && e.tagName === "a");
    const hrefs = walk(gate(c)).filter((e) => e.tagName === "a").map((e) => e.href);
    assert.ok(hrefs.includes("privacy.html"), t("게이트에 개인정보처리방침 링크가 없다"));
    assert.ok(hrefs.includes("policies/"), t("게이트에 이용약관 링크가 없다"));
  }

  // 2. 가입 화면이 뜨고 **체크 전에는 제공자 버튼이 눌리지 않는다.**
  {
    const c = await openApp(baseRoutes());
    btn(c, "가입하기").click();
    await settle();
    assert.ok(hasText(c, "요약 본문"), t("요약 문서가 화면에 안 뜬다"));
    assert.ok(hasText(c, "만 14세 이상입니다"), t("연령 진술 문구가 안 뜬다"));
    const kakao = btn(c, "카카오로 가입하기");
    assert.ok(kakao, t("제공자 버튼이 안 그려졌다"));
    assert.equal(kakao.disabled, true, t("체크 전인데 가입 버튼이 눌린다"));
    // 하나만 체크해도 안 된다.
    const boxes = walk(gate(c)).filter((e) => e.type === "checkbox");
    assert.equal(boxes.length, 2, t("필수 체크박스가 2개가 아니다"));
    boxes[0].checked = true;
    for (const fn of boxes[0].handlers.change || []) fn({});
    assert.equal(kakao.disabled, true, t("하나만 체크했는데 가입 버튼이 열렸다"));
    // 둘 다 체크해도 **사람 확인 전에는 안 열린다**(2026-08-22 · 결정 3).
    boxes[1].checked = true;
    for (const fn of boxes[1].handlers.change || []) fn({});
    assert.equal(kakao.disabled, true, t("사람 확인 전인데 가입 버튼이 열렸다"));
    assert.ok(hasText(c, "사람 확인을 마쳐야"), t("왜 못 누르는지 화면이 말하지 않는다"));
    // 위젯이 토큰을 주면 열린다.
    const hv = walk(gate(c)).find((e) => e.className === "signup-human");
    assert.ok(hv, t("사람 확인 자리가 화면에 없다"));
    await settle();
    assert.ok(typeof hv.__solve === "function", t("사람 확인 위젯이 안 그려졌다"));
    hv.__solve("tok-1");
    assert.equal(kakao.disabled, false, t("사람 확인을 마쳤는데 가입 버튼이 안 열린다"));
    // 토큰이 만료되면 **다시 닫힌다.** 남겨 두면 이미 쓴 토큰으로 재시도해 서버가 거절한다.
    hv.__expire();
    assert.equal(kakao.disabled, true, t("사람 확인이 만료됐는데 버튼이 열려 있다"));
    hv.__solve("tok-2");
    // 가입 시작 본문에 **그 토큰이 실린다.**
    kakao.click();
    await settle();
    const started = c.calls.filter((x) => x.path === "/signup/start");
    assert.equal(started.length, 1, t("가입 시작이 한 번 안 갔다"));
    assert.equal(JSON.parse(started[0].body).turnstile, "tok-2", t("가입 시작이 사람 확인 토큰을 안 보냈다"));
    // 누르면 서버가 준 주소로 간다. **체크 값을 그대로 실어 보낸다.**
    kakao.click();
    await settle();
    const req = c.calls.find((x) => x.path === "/signup/start");
    assert.ok(req, t("가입 시작 요청이 안 나갔다"));
    assert.equal(c.location.href, "https://kauth.kakao.com/go", t("제공자 주소로 안 갔다"));
    // ⚠️ 가입을 그만두면 체크값이 **길게 남지 않는다.**
    assert.ok(!Object.keys(c.store).some((k) => /terms|age14|policy/i.test(k)),
      t("체크값이 localStorage 에 남았다"));
  }

  // 2-b. T72 — 사람 확인이 **없거나 고장 나면** 가입을 열지 않는다(2026-08-22 · 결정 3).
  //   ⛔ 위젯을 붙여 놓고 화면이 그 결과를 안 보면 Turnstile 은 장식이 된다. 여기서 재는 것은
  //      「화면이 토큰 없이는 진행하지 않는다」와 「왜 안 되는지 말한다」 둘이다.
  {
    // ① 스크립트를 못 받으면 이유를 말한다.
    const c = await openApp(baseRoutes());
    c.setTurnstileMode("script-fail");
    btn(c, "가입하기").click();
    await settle(); await settle();
    const boxes = walk(gate(c)).filter((e) => e.type === "checkbox");
    for (const b of boxes) { b.checked = true; for (const fn of b.handlers.change || []) fn({}); }
    assert.equal(btn(c, "카카오로 가입하기").disabled, true, t("위젯이 없는데 가입 버튼이 열렸다"));
    assert.ok(hasText(c, "사람 확인을 불러오지 못했어요"), t("위젯 실패를 화면이 말하지 않는다"));
    assert.equal(c.calls.filter((x) => x.path === "/signup/start").length, 0,
      t("사람 확인 없이 가입 시작을 보냈다"));
  }
  {
    // ② 서버가 site key 를 안 주면 위젯을 부르지도 않는다(외부 요청을 만들지 않는다).
    const c = await openApp(async (m, p) => (p === "/health"
      ? { status: 200, body: { ok: true, signupReady: true, providers: ["kakao"], turnstileSiteKey: null } }
      : baseRoutes()(m, p)));
    btn(c, "가입하기").click();
    await settle(); await settle();
    assert.ok(!c.document.head.children.some((e) => String(e.src || "").includes("challenges")),
      t("site key 도 없이 외부 스크립트를 받아 왔다"));
    assert.ok(hasText(c, "사람 확인을 불러오지 못했어요"), t("위젯을 못 그린 이유를 말하지 않는다"));
  }
  {
    // ③ 서버가 사람 확인 실패(400 humanCheck)를 주면 **다시 풀라고** 말한다.
    const c = await openApp(baseRoutes({ signup: { status: 400, body: { humanCheck: true, error: "x" } } }));
    btn(c, "가입하기").click();
    await settle(); await settle();
    const boxes = walk(gate(c)).filter((e) => e.type === "checkbox");
    for (const b of boxes) { b.checked = true; for (const fn of b.handlers.change || []) fn({}); }
    const hv = walk(gate(c)).find((e) => e.className === "signup-human");
    hv.__solve("tok");
    btn(c, "카카오로 가입하기").click();
    await settle();
    assert.ok(hasText(c, "사람 확인을 다시"), t("사람 확인 실패를 다른 오류와 같은 말로 처리했다"));
  }

  // 3. ★ **정책을 못 받으면 가입 버튼을 안 그린다(fail-closed) + 재시도가 있다.**
  //    무한 spinner 를 만들지 않는다.
  for (const [label, over, msg] of [
    ["서버 오류", { policies: { status: 500, body: {} } }, "약관을 불러오지 못했어요"],
    ["문서 파일 오류", { docFail: true }, "약관을 불러오지 못했어요"],
    ["해시 불일치", { tamper: true }, "옛 약관"],
  ]) {
    const c = await openApp(baseRoutes(over));
    btn(c, "가입하기").click();
    await settle();
    assert.ok(!btn(c, "카카오로 가입하기"), t(`${label}: 정책을 못 받았는데 가입 버튼이 그려졌다`));
    assert.ok(hasText(c, msg), t(`${label}: 이유를 말하지 않는다 — 실제 문구: ${allText(gate(c)).slice(0, 120)}`));
    assert.ok(btn(c, "다시 시도"), t(`${label}: 재시도 버튼이 없다 — 사용자가 할 수 있는 일이 없다`));
    assert.ok(!hasText(c, "불러오고 있어요…") || btn(c, "다시 시도"),
      t(`${label}: 「불러오고 있어요」에서 멈췄다`));
  }

  // 3b. ★ **로그인 가능과 가입 가능은 다른 상태다.**
  //     재현(2026-08-18): `apiHealth()` 가 `signupReady` 를 버려서, 서버가
  //     `providers:["kakao"] · signupReady:false` 를 줘도 화면은 「카카오로 가입하기」를
  //     그렸다. 누르면 `/signup/start` 가 503 이다 — 약관을 다 읽고 체크를 다 채운 사람에게만
  //     실패가 보이는, 가장 나쁜 순서였다.
  {
    const health = (body) => async (m, p) => (p === "/health" ? { status: 200, body } : baseRoutes()(m, p));

    // ① 로그인은 되는데 가입만 잠긴 상태
    const locked = await openApp(health({ ok: true, providers: ["kakao"], signupReady: false }));
    btn(locked, "가입하기").click();
    await settle();
    assert.ok(!btn(locked, "카카오로 가입하기"), t("가입이 잠겼는데 되지 않는 가입 버튼을 그렸다"));
    assert.ok(hasText(locked, "지금은 새로 가입할 수 없어요"), t("가입이 잠긴 이유를 말하지 않는다"));
    assert.ok(btn(locked, "이미 계정이 있어요 — 로그인"), t("가입이 잠겼는데 로그인으로 갈 길이 없다"));
    // 같은 상태에서 **로그인은 그대로 된다** — 기존 사용자를 같이 막지 않는다.
    btn(locked, "이미 계정이 있어요 — 로그인").click();
    await settle();
    assert.ok(btn(locked, "카카오로 로그인"), t("가입만 잠겼는데 로그인 버튼까지 사라졌다"));
    // 약관을 **받아 오지도 않는다** — 되지 않을 일에 사용자를 기다리게 하지 않는다.
    assert.ok(!locked.calls.some((x) => x.path === "/policies"), t("가입이 잠겼는데 약관을 받아 왔다"));

    // ② 제공자가 아예 없다 = 로그인도 가입도 준비 중
    const none = await openApp(health({ ok: true, providers: [], signupReady: false }));
    btn(none, "가입하기").click();
    await settle();
    assert.ok(hasText(none, "지금은 새로 가입할 수 없어요"), t("제공자가 없는데 가입 안내가 없다"));

    // ③ health 자체가 실패 = **「준비 중」이 아니라 「연결 안 됨」이라고 말한다.**
    //    사용자가 할 일이 다르다(기다리기 vs 인터넷 확인).
    const off = await openApp(async (m, p) => (p === "/health" ? { throw: true } : baseRoutes()(m, p)));
    btn(off, "가입하기").click();
    await settle();
    assert.ok(hasText(off, "서버에 연결할 수 없어"), t("연결 실패인데 연결 문제라고 말하지 않는다"));
    assert.ok(!hasText(off, "지금은 새로 가입할 수 없어요"),
      t("연결 실패를 「준비 중」이라고 말한다 — 원인이 다른데 같은 말을 한다"));
  }

  // 4. 오프라인·시간 초과는 **연결 문제라고 말한다.** 원인이 다르면 할 일도 다르다.
  {
    const c = await openApp(async (m, p) => (p === "/health"
      ? { status: 200, body: { ok: true, signupReady: true, providers: ["kakao"] } }
      : p === "/policies" ? { throw: true } : { status: 200, body: {} }));
    btn(c, "가입하기").click();
    await settle();
    assert.ok(hasText(c, "연결이 안 돼요"), t("오프라인인데 연결 문제라고 말하지 않는다"));
    assert.ok(btn(c, "다시 시도"), t("오프라인인데 재시도가 없다"));
  }

  // 5. ★ **가입 시작이 실패하면 버튼이 다시 눌린다.** 영구 disabled 를 만들지 않는다.
  {
    const c = await openApp(baseRoutes({ signup: { status: 409, body: { policyStale: true, error: "x" } } }));
    btn(c, "가입하기").click();
    await settle();
    for (const b of walk(gate(c)).filter((e) => e.type === "checkbox")) {
      b.checked = true;
      for (const fn of b.handlers.change || []) fn({});
    }
    const kakao = btn(c, "카카오로 가입하기");
    kakao.click();
    await settle();
    assert.equal(kakao.disabled, false, t("가입 시작이 실패했는데 버튼이 영구히 잠겼다"));
    assert.ok(hasText(c, "약관이 새로 바뀌었어요"), t("policyStale 을 사용자 말로 옮기지 않는다"));
    assert.notEqual(c.location.href, "https://kauth.kakao.com/go", t("실패했는데 제공자로 보냈다"));
    // 6. 두 번 눌러도 왕복이 둘로 갈라지지 않는다.
    const before = c.calls.filter((x) => x.path === "/signup/start").length;
    kakao.click(); kakao.click();
    await settle();
    assert.ok(c.calls.filter((x) => x.path === "/signup/start").length <= before + 1,
      t("가입 버튼 연타가 왕복을 여러 개 만들었다"));
  }

  // 7. ★ **로그인으로 왔는데 계정이 없으면 가입 화면으로 안내한다.** 「실패했어요」가 아니다.
  {
    const c = await openApp(baseRoutes(), {});
    // 서버가 `#login=signup_required` 로 되돌려보낸 상황을 만든다.
    const c2 = loadClient({ store: {}, routes: baseRoutes(),
                            loc: { hash: "#login=signup_required&via=kakao&n=nonce-fixed" } });
    for (const fn of c2.HOOKS.ready) await fn();
    await settle();
    assert.ok(hasText(c2, "아직 가입하지 않으셨어요"), t("가입 안 된 사람에게 가입 화면을 안 띄운다"));
    // ★ **이유가 맨 위에 있어야 한다.** 재현(2026-08-18 실브라우저): 안내를 먼저 붙였는데
    //   약관 본문이 그 **위로** 삽입되면서 안내가 화면 맨 아래(974자 중 918번째)로 밀렸다 —
    //   사용자는 왜 이 화면이 떴는지 못 읽고 긴 약관부터 만난다. Node 테스트는 「있다」만 재고
    //   「어디 있다」를 안 재서 통과하고 있었다.
    {
      const txt = allText(gate(c2));
      assert.ok(txt.indexOf("아직 가입하지 않으셨어요") < txt.indexOf("요약 본문"),
        t("안내가 약관 본문 뒤로 밀렸다 — 사용자가 이유를 못 읽는다"));
    }
    assert.ok(!c2.TOASTS.some((x) => x.includes("실패")), t("가입 안 됨을 「실패」라고 말한다"));
    assert.equal(c2.store["shh-via"], undefined, t("가입 안 됐는데 로그인 표시를 세웠다"));
  }

  // 8. 이미 쓴 가입 요청·옛 약관도 각각 다른 말을 한다.
  for (const [hash, msg] of [["#login=used", "이미 처리된 가입 요청"], ["#login=stale", "약관이 새로 바뀌었어요"]]) {
    const c = loadClient({ store: {}, routes: baseRoutes(), loc: { hash } });
    for (const fn of c.HOOKS.ready) await fn();
    await settle();
    assert.ok(hasText(c, msg), t(`${hash} 를 사용자 말로 옮기지 않는다`));
  }

  // 9. 로그인 갈래는 그대로 남아 있다(기존 사용자를 막지 않는다).
  {
    const c = await openApp(baseRoutes());
    btn(c, "이미 계정이 있어요 — 로그인").click();
    await settle();
    assert.ok(btn(c, "카카오로 로그인"), t("로그인 화면에 제공자 버튼이 없다"));
    assert.ok(btn(c, "처음 오셨나요? 가입하기"), t("로그인 화면에서 가입으로 못 돌아간다"));
    assert.ok(btn(c, "로그인 없이 둘러보기"), t("로그인 화면에 둘러보기가 없다"));
  }

  // 10. 서버에 못 물어봤으면 **가입 버튼도 안 그린다**(로그인 버튼과 같은 판단).
  {
    const c = await openApp(async (m, p) => (p === "/health" ? { status: 500, body: {} }
      : p === "/policies" ? { status: 200, body: { pv: PV, docs: await docsFor() } }
      : p.startsWith("./policies/") ? { status: 200, text: bodies[p.slice(2)] } : { status: 200, body: {} }));
    btn(c, "가입하기").click();
    await settle();
    assert.ok(!btn(c, "카카오로 가입하기"), t("서버에 못 물어봤는데 가입 버튼을 그렸다"));
    assert.ok(hasText(c, "서버에 연결할 수 없어"), t("연결 문제라고 말하지 않는다"));
  }
});

const failed = RESULTS.filter((r) => !r[0]);
for (const [pass, name, why] of RESULTS) if (!pass) console.log(`  ✗ ${name}\n      ${why}`);
if (failed.length) {
  console.log(`test-client: ${n - failed.length}/${n} 통과, ${failed.length}개 실패`);
  process.exit(1);
}
console.log(`test-client: ${n}개 통과 — 로그아웃·계정삭제·친구철회 실패 처리 · 저장 완료 판정`
  + ` · 친구 목록 로딩/실패/재시도/스키마/중복요청 · 탭 간 편집 세대 · OAuth 왕복 시간 제한`
  + ` · 가입 화면(정책 해시 대조 · 필수 체크 · 실패/재시도 · 연타 잠금 · signup_required 안내`
  + ` · T72 사람 확인 위젯: 토큰 전에는 잠김 · 만료 시 재잠금 · 본문에 토큰 · 위젯 실패 안내)`);
