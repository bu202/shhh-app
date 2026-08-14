// 계층: 데이터·외부 접근 (apiClient). **fetch 는 이 파일에만 나온다.**
// 화면·판단은 js/auth.js 가 한다. 서버 주소가 바뀌면 여기 API 한 줄만 고치면 된다.
// API 는 **같은 origin 의 `/api/*`** 다(Cloudflare Pages Functions). 옛 주소
// `https://shhh-api.bu202.workers.dev` 는 다른 origin 이라 쿠키를 쓸 수 없었고 CORS 가 필요했다.
const API = "/api";
// ⚠️ **세션 토큰은 이제 여기 없다.** HttpOnly 쿠키(`shh_s`)라 자바스크립트가 읽지도 쓰지도 못한다 —
//    XSS 가 나도 세션을 통째로 훔쳐 갈 수 없고, 앱이 잃어버릴 수도 없다.
//    예전엔 localStorage 의 `shh-token` 이었고 그 앞부분이 계정 id 였다.
// 여기 남는 건 **자격증명이 아니라 화면 상태**뿐이다: 로그인했는지, 어느 제공자였는지.
// 진짜 판정은 언제나 서버가 한다 — 이 값을 고쳐도 남의 것을 못 본다(401 이 온다).
const VIA_KEY = "shh-via";
const ME_KEY = "shh-me";         // 서버가 알려준 내 계정 id. 계정이 바뀐 것을 알아채는 데만 쓴다

// "로그인한 것으로 보이나". 쿠키를 못 읽으므로 이 표시로 화면을 그리고,
// 실제로 끊겼으면 첫 API 호출의 401 에서 정리된다(onAuthLost).
const authToken = () => localStorage.getItem(VIA_KEY);
const authVia = () => localStorage.getItem(VIA_KEY);
// 계정이 바뀌면 앞 계정 단어장을 새 계정에 물려주지 않는다(syncPlan 의 accountChanged).
// 예전엔 토큰 앞부분을 뜯어 알았는데 토큰이 무작위가 되면서 그 길이 사라졌다 —
// 이제 `GET /book` 이 `me` 로 알려준다.
const authUid = () => localStorage.getItem(ME_KEY) || "";
const setAuthUid = (v) => { if (v) localStorage.setItem(ME_KEY, v); };

// 세션이 죽었을 때(로그아웃·만료) 화면을 다시 그리게 하는 훅. 여기는 데이터 계층이라
// 화면을 직접 못 만진다 — 알리기만 하고 무엇을 그릴지는 js/auth.js 가 정한다.
// ⚠️ 함정 44: 지금은 주인이 하나라 단일 함수다. 두 번째 파일이 붙는 순간 배열로 바꿀 것.
let authLost = null;
function onAuthLost(fn) { authLost = fn; }
// 로그인 표시만 세우고 지운다. **세션 자체는 서버의 쿠키가 들고 있다** —
// 여기서 지워도 쿠키는 안 지워지므로, 로그아웃은 반드시 서버(`DELETE /session`)를 거쳐야 한다.
// 로그아웃·세션 만료 때 **이 계정에 딸린 로컬 값**을 같이 지운다.
// 안 지우면 한 기기를 두 사람이 쓸 때 앞사람 값이 뒷사람 화면과 서버로 새어 나간다:
//   shh-invite  — 앞사람의 초대 링크. 뒷사람이 공유 버튼을 누르면 **앞사람에게 요청이 간다**
//                 (온라인이면 목록을 새로 받아 덮이지만, 오프라인이면 옛 코드가 그대로 나간다)
//   shh-name    — 앞사람 별명. 화면에 "○○님"으로 남는다
//   shh-bookver — 앞사람 계정의 단어장 버전. 뒷사람 계정에서 뜻이 없는 숫자다
//   shh-dirty   — 지우면 기본값이 "고친 적 있음"이라 안전한 쪽으로 떨어진다
// **단어장(shh-wordbook)은 남긴다** — 로그아웃은 "이 기기에서 그만 보기"지 "지우기"가 아니다.
// **shh-uid 도 남긴다** — 다음에 다른 계정이 로그인한 것을 알아채는 근거가 이 값이다.
const ACCOUNT_KEYS = [VIA_KEY, ME_KEY, "shh-bookver", "shh-invite", "shh-name", "shh-dirty"];
const setAuth = (via) => {
  if (via) localStorage.setItem(VIA_KEY, via);
  else for (const k of ACCOUNT_KEYS) localStorage.removeItem(k);
};

// ── 세션 고정 방어용 일회용 값 ──
// 돌아오는 `#login=<토큰>` 은 **링크로 만들어 남에게 보낼 수 있는 문자열**이다. 그냥 받으면
// 공격자가 자기 토큰을 담은 링크로 피해자를 자기 계정에 로그인시킬 수 있고, 그 뒤 피해자가
// 담는 단어와 별명이 공격자 계정에 쌓인다(session fixation).
// 그래서 로그인을 시작할 때 무작위 값을 하나 적어 두고 서버에 들려 보낸다. 서버는 그걸 state 에
// 서명해 두었다가 그대로 돌려주고, 앱은 **적어 둔 값과 같을 때만** 토큰을 받는다.
// localStorage 인 이유: 이 왕복은 탭을 떠났다 돌아오는 길이라 shh-back 과 같은 수명이 필요하다.
const NONCE_KEY = "shh-nonce";
const newNonce = () => {
  const n = crypto.randomUUID();
  localStorage.setItem(NONCE_KEY, n);
  return n;
};
// 한 번 쓰면 지운다 — 남겨 두면 그 값을 아는 링크가 두 번째로도 통한다.
const takeNonce = () => {
  const n = localStorage.getItem(NONCE_KEY);
  localStorage.removeItem(NONCE_KEY);
  return n;
};

// 로그인은 리다이렉트다. 팝업은 폰 브라우저에서 자주 막히고, 설치된 PWA 에선 창이 아예 안 뜬다.
// return 은 지금 주소 — 서버가 이 주소를 서명한 state 로 검증하므로 아무 데로나 못 보낸다.
const loginUrl = (provider) =>
  `${API}/login/${provider}?return=${encodeURIComponent(location.origin + location.pathname)}`
  + `&n=${encodeURIComponent(newNonce())}`;

// 답이 안 오는 요청을 언제 포기하나. 예전엔 아무 데도 시간 제한이 없어서, 응답이 영원히
// 오지 않으면 버튼이 "처리 중"에 영원히 머물렀다(거짓말은 아니지만 사용자는 끝을 못 본다).
//
// 12초는 폰의 느린 회선에서 정상 응답이 도착할 시간은 주면서, 사람이 "멈췄다"고 느끼기 전에
// 끝나는 값이다. 이 숫자 자체는 테스트로 못 재고 **실제 느린 회선에서 확인해야 한다** —
// 테스트는 "시간이 초과되면 어떻게 말하나"만 잰다(타이머는 브라우저 기능이라 잴 값이 없다).
const REQUEST_TIMEOUT = 12000;
// AbortSignal.timeout 은 iOS 16 · Chrome 103 부터다. 그 아래에서 fetch 가 통째로 죽지 않게
// 폴백을 둔다 — 시간 제한을 붙이려다 옛 폰에서 앱이 안 도는 쪽이 훨씬 나쁘다.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return { signal: AbortSignal.timeout(ms), done() {} };
  }
  if (typeof AbortController === "undefined") return { signal: undefined, done() {} };
  const c = new AbortController();
  // 이름을 맞춰 둔다 — 위에서 e.name 으로 시간 초과와 오프라인을 가르기 때문이다.
  const id = setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms);
  return { signal: c.signal, done: () => clearTimeout(id) };
}

// 요청을 보내고 **결과를 구분해서** 돌려준다. 이 파일에서 실제로 fetch 하는 자리는 여기 하나다.
//
// ⚠️ 왜 이 함수가 생겼나: 예전엔 403·404·429·5xx·오프라인·본문 파싱 실패가 **전부 null 하나**로
//    돌아왔다. 부르는 쪽은 "서버가 거절했다"와 "물어보지 않았다"를 가릴 수가 없어서 결국
//    아무도 결과를 안 봤고, 로그아웃·계정 삭제·친구 끊기가 서버 실패에도 성공한 척했다.
//
//   ok      2xx 였나
//   status  HTTP 상태. 네트워크가 끊겨 상태 자체가 없으면 0 (있는 척하지 않는다)
//   kind    unauthenticated | forbidden | not_found | conflict | rate_limited | server
//           | network | timeout | invalid_response
//   data    응답 본문(없으면 null). 서버가 준 사람용 문구는 data.error 에 있다
//
// **로컬 단어장은 절대 건드리지 않는다** — 오프라인에서 단어장이 비면 안 된다.
async function request(path, opts = {}) {
  // 로그인 표시가 없으면 아예 안 보낸다. 상태코드가 없으므로 0.
  if (!authToken()) return { ok: false, status: 0, kind: "unauthenticated", data: null };
  let res;
  const t = timeoutSignal(REQUEST_TIMEOUT);
  try {
    res = await fetch(API + path, {
      ...opts,
      signal: t.signal,
      // 쿠키를 실어 보낸다. **같은 origin 에만** — 앱과 API 가 한 Pages 프로젝트라 성립한다.
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    // 시간 초과와 오프라인을 가른다. 화면에는 둘 다 "연결이 안 돼요"로 말하지만,
    // 답이 영원히 안 오는 경우와 처음부터 못 보낸 경우는 다른 일이다.
    const kind = e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network";
    return { ok: false, status: 0, kind, data: null };
  } finally {
    t.done();
  }
  // 세션이 죽었다 — 만료(180일)거나, 다른 기기에서 로그아웃·탈퇴했거나(세대가 올랐다).
  // 표시만 지우면 화면은 로그인 상태로 남아, 담기를 눌러도 왜 안 되는지 말해주지 않는다.
  if (res.status === 401) {
    setAuth(null); authLost?.();
    return { ok: false, status: 401, kind: "unauthenticated", data: null };
  }
  const data = await res.json().catch(() => null);
  // 2xx 인데 본문이 JSON 이 아니다 — 프록시나 오류 페이지가 200 으로 돌아온 경우다.
  // 성공으로 치면 화면이 빈 값을 진짜 응답으로 받아들인다.
  if (res.ok) return data === null
    ? { ok: false, status: res.status, kind: "invalid_response", data: null }
    : { ok: true, status: res.status, kind: "", data };
  // 409 는 **오류가 아니라 대답**이다: "다른 기기가 먼저 저장했다, 지금 것은 이거다."
  const kind = { 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited" }[res.status] || "server";
  return { ok: false, status: res.status, kind, data };
}

// 별명은 단어장과 **같은 레코드**에 산다. 저장할 곳이 하나뿐이라 시각 비교(LWW)도 한 번에 끝나고,
// 별명만 따로 최신인 상태가 생기지 않는다.
// 서버가 세는 단어장 버전. **기기 시계 대신** 이 값이 "누가 먼저 저장했나"를 정한다.
// localStorage 에 두는 이유: 앱을 껐다 켜도 손에 든 버전이 남아야 첫 저장이 바로 409 가 안 난다.
const VER_KEY = "shh-bookver";
const bookVersion = () => Number(localStorage.getItem(VER_KEY)) || 0;
const setBookVersion = (v) => localStorage.setItem(VER_KEY, Number(v) || 0);
// 저장 응답으로 받은 번호는 **되돌리지 않는다.** 같은 기기의 탭 두 개는 이 localStorage 를
// 공유하는데, 저장 요청이 겹치면 응답이 뒤집혀 도착한다 — 그냥 대입하면 번호가 뒤로 가고
// 다음 저장이 옛 번호로 나가 반드시 충돌한다(그러면 합집합 병합이 돌아 지운 단어가 되살아난다).
//
// ⚠️ setBookVersion 자체를 단조 증가로 만들면 안 된다. js/auth.js 의 sync 는 **계정이 바뀐**
//    직후에도 이 값을 적는데, 새 계정의 버전은 앞 계정보다 작을 수 있어 그때는 내려가야 한다.
const advanceBookVersion = (v) => {
  const n = Number(v);
  if (Number.isFinite(n) && n > bookVersion()) setBookVersion(n);
};

// ⚠️ **읽기는 아무것도 저장하지 않는다.** 예전엔 여기서 버전과 내 계정 id 를 바로 적었는데,
//    그 두 값이 곧 "어느 쪽이 새것인가"와 "계정이 바뀌었나"의 근거라 **판정하기도 전에
//    근거가 갈아치워졌다.** 그래서 시계가 미래인 기기가 방금 받은 최신 버전을 그대로 되보내
//    서버의 버전 검사를 통과하고 남의 기기 단어장을 덮어썼다.
//    이제 응답을 돌려주기만 하고, 무엇을 적을지는 js/auth.js 가 판정한 뒤에 정한다
//    (데이터 계층이 화면·판단의 상태를 몰래 바꾸지 않는다는 규칙이기도 하다).
const apiGetBook = () => request("/book");
// 결과를 그대로 돌려준다 — 충돌(kind:"conflict")이면 r.data 에 서버 레코드가 있고,
// 부르는 쪽(js/auth.js)이 합친다. **충돌은 저장 성공이 아니다.**
const apiPutBook = async (words, name) => {
  const r = await request("/book", { method: "PUT", body: JSON.stringify({ words, name, version: bookVersion() }) });
  // 성공이든 충돌이든 서버가 말한 번호는 사실이다. 낡은 요청의 응답이어도 받아 적는다 —
  // 버리면 다음 저장이 옛 번호로 나가 불필요한 충돌을 만든다. 되돌리지만 않으면 된다.
  advanceBookVersion(r.data && r.data.version);
  return r;
};
const apiDeleteAccount = () => request("/me", { method: "DELETE" });
// 로그아웃은 **서버에도** 알린다. 브라우저에서 토큰만 지우면 KV 의 세션은 180일을 더 살아서,
// 한 번 샌 토큰이 로그아웃 뒤에도 그대로 쓰인다. 이 계정에 로그인한 기기가 전부 함께 끊긴다.
const apiLogout = () => request("/session", { method: "DELETE" });
// 로그인 표시가 아직 없는 상태에서 세션을 끊어야 할 때(네이버 갈래에서 nonce 가 안 맞은 경우).
// request 는 표시가 없으면 아예 안 보내므로 이 한 자리는 fetch 를 직접 부른다 —
// 쿠키는 이미 심어져 있어서 **앱이 모르는 채 서버만 로그인 상태로 남는 것**을 막아야 한다.
const apiLogoutRaw = async () => {
  try { await fetch(API + "/session", { method: "DELETE", credentials: "same-origin" }); } catch { /* 오프라인 */ }
};

// ── 친구 ──
// 목록은 {code, friends:[{uid,name,count}], in:[…], out:[…]}. 단어는 안 온다 — 목록엔 안 쓴다.
const apiFriends = () => request("/friends");
// 초대 코드로 요청 보내기. 상대가 이미 나에게 보냈으면 서버가 그 자리에서 맺어 준다.
const apiAddFriend = (code) => request("/friends", { method: "POST", body: JSON.stringify({ code }) });
const apiAcceptFriend = (uid) => request("/friends/" + encodeURIComponent(uid), { method: "PUT" });
// 거절 · 요청 취소 · 친구 끊기가 전부 이 한 줄이다 — 서버에서도 "이 연결을 지운다" 하나다.
// 결과를 그대로 돌려준다: 서버가 지웠는지(2xx), 이미 없었는지(404), 못 지웠는지(그 밖)를
// 부르는 쪽이 가려야 목록에서 지울지 말지 정할 수 있다.
const apiRemoveFriend = (uid) => request("/friends/" + encodeURIComponent(uid), { method: "DELETE" });
const apiFriendBook = (uid) => request("/friends/" + encodeURIComponent(uid) + "/book");
// 초대 링크 새로 만들기. 옛 코드는 서버에서 그 자리에 죽는다 — 링크가 어디까지 퍼졌는지
// 모르게 됐을 때 되돌릴 방법이 이것뿐이다. 이미 맺어진 친구는 그대로다.
const apiRotateCode = () => request("/friends/code", { method: "POST" });

// 어느 제공자로 로그인할 수 있나. 비밀값이 안 들어간 제공자의 버튼을 그리면 사용자가
// 누르고 나서야 503 을 본다 — 화면에 보이는 것은 실제로 되는 것이어야 한다.
// 로그인 표시가 필요 없는 호출이라 request 를 안 쓴다(request 는 표시가 없으면 안 보낸다).
//
// ⚠️ **"못 물어봤다"와 "제공자가 없다"를 가려서 돌려준다.** 예전엔 둘 다 null 이었고, 화면은
//    null 을 "아직 모르니 셋 다 그린다"로 읽었다 — 그래서 서버에 못 닿을 때 오히려 눌러도
//    안 되는 버튼 세 개가 떴다. 지금은 ok 로 가른다: ok:false 면 연결 문제, providers:[] 면
//    서버가 아직 아무 제공자도 못 쓴다는 뜻이다(문구가 달라야 사용자가 할 일이 달라진다).
async function apiHealth() {
  const t = timeoutSignal(REQUEST_TIMEOUT);
  try {
    const res = await fetch(API + "/health", { signal: t.signal });
    if (!res.ok) return { ok: false, providers: [] };
    const d = await res.json().catch(() => null);
    return d && Array.isArray(d.providers) ? { ok: true, providers: d.providers } : { ok: false, providers: [] };
  } catch {
    return { ok: false, providers: [] };
  } finally {
    t.done();
  }
}

// 네이버 전용. 앱 주소로 돌아온 code 를 서버에 넘긴다 — 비밀키가 필요한 교환이라 브라우저에서
// 직접 못 한다. **응답에 토큰은 없다**: 서버가 Set-Cookie 로 심고 여기선 성공 여부와 n 만 받는다.
// request 를 안 쓰는 이유는 아직 로그인 표시가 없는 상태의 호출이기 때문이다.
async function apiExchange(provider, code, state) {
  const q = new URLSearchParams({ code, state });
  try {
    const res = await fetch(`${API}/exchange/${provider}?${q}`, { credentials: "same-origin" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
