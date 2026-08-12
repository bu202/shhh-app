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

// 실패하면 null. **로컬 단어장은 절대 건드리지 않는다** — 오프라인에서 단어장이 비면 안 된다.
async function apiCall(path, opts = {}) {
  if (!authToken()) return null;
  try {
    const res = await fetch(API + path, {
      ...opts,
      // 쿠키를 실어 보낸다. **같은 origin 에만** — 앱과 API 가 한 Pages 프로젝트라 성립한다.
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    // 세션이 죽었다 — 만료(180일)거나, 다른 기기에서 로그아웃·탈퇴했거나(세대가 올랐다).
    // 표시만 지우면 화면은 로그인 상태로 남아, 담기를 눌러도 왜 안 되는지 말해주지 않는다.
    if (res.status === 401) { setAuth(null); authLost?.(); return null; }
    // 409 는 **오류가 아니라 대답**이다: "다른 기기가 먼저 저장했다, 지금 것은 이거다."
    // 여기서 null 로 뭉개면 앱이 충돌을 못 보고 조용히 옛 상태로 남는다.
    if (res.status === 409) return { conflict: true, ...(await res.json().catch(() => ({}))) };
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;   // 오프라인
  }
}

// 별명은 단어장과 **같은 레코드**에 산다. 저장할 곳이 하나뿐이라 시각 비교(LWW)도 한 번에 끝나고,
// 별명만 따로 최신인 상태가 생기지 않는다.
// 서버가 세는 단어장 버전. **기기 시계 대신** 이 값이 "누가 먼저 저장했나"를 정한다.
// localStorage 에 두는 이유: 앱을 껐다 켜도 손에 든 버전이 남아야 첫 저장이 바로 409 가 안 난다.
const VER_KEY = "shh-bookver";
const bookVersion = () => Number(localStorage.getItem(VER_KEY)) || 0;
const setBookVersion = (v) => localStorage.setItem(VER_KEY, Number(v) || 0);

// ⚠️ **읽기는 아무것도 저장하지 않는다.** 예전엔 여기서 버전과 내 계정 id 를 바로 적었는데,
//    그 두 값이 곧 "어느 쪽이 새것인가"와 "계정이 바뀌었나"의 근거라 **판정하기도 전에
//    근거가 갈아치워졌다.** 그래서 시계가 미래인 기기가 방금 받은 최신 버전을 그대로 되보내
//    서버의 버전 검사를 통과하고 남의 기기 단어장을 덮어썼다.
//    이제 응답을 돌려주기만 하고, 무엇을 적을지는 js/auth.js 가 판정한 뒤에 정한다
//    (데이터 계층이 화면·판단의 상태를 몰래 바꾸지 않는다는 규칙이기도 하다).
const apiGetBook = () => apiCall("/book");
// 충돌이면 `{conflict:true, ...서버 레코드}` 가 온다 — 부르는 쪽(js/auth.js)이 합친다.
const apiPutBook = async (words, name) => {
  const r = await apiCall("/book", { method: "PUT", body: JSON.stringify({ words, name, version: bookVersion() }) });
  if (r && typeof r.version === "number") setBookVersion(r.version);
  return r;
};
const apiDeleteAccount = () => apiCall("/me", { method: "DELETE" });
// 로그아웃은 **서버에도** 알린다. 브라우저에서 토큰만 지우면 KV 의 세션은 180일을 더 살아서,
// 한 번 샌 토큰이 로그아웃 뒤에도 그대로 쓰인다. 이 계정에 로그인한 기기가 전부 함께 끊긴다.
const apiLogout = () => apiCall("/session", { method: "DELETE" });
// 로그인 표시가 아직 없는 상태에서 세션을 끊어야 할 때(네이버 갈래에서 nonce 가 안 맞은 경우).
// apiCall 은 표시가 없으면 그냥 null 을 내므로 이 한 자리는 직접 부른다 —
// 쿠키는 이미 심어져 있어서 **앱이 모르는 채 서버만 로그인 상태로 남는 것**을 막아야 한다.
const apiLogoutRaw = async () => {
  try { await fetch(API + "/session", { method: "DELETE", credentials: "same-origin" }); } catch { /* 오프라인 */ }
};

// ── 친구 ──
// 목록은 {code, friends:[{uid,name,count}], in:[…], out:[…]}. 단어는 안 온다 — 목록엔 안 쓴다.
const apiFriends = () => apiCall("/friends");
// 초대 코드로 요청 보내기. 상대가 이미 나에게 보냈으면 서버가 그 자리에서 맺어 준다.
const apiAddFriend = (code) => apiCall("/friends", { method: "POST", body: JSON.stringify({ code }) });
const apiAcceptFriend = (uid) => apiCall("/friends/" + encodeURIComponent(uid), { method: "PUT" });
// 거절 · 요청 취소 · 친구 끊기가 전부 이 한 줄이다 — 서버에서도 "이 연결을 지운다" 하나다.
const apiRemoveFriend = (uid) => apiCall("/friends/" + encodeURIComponent(uid), { method: "DELETE" });
const apiFriendBook = (uid) => apiCall("/friends/" + encodeURIComponent(uid) + "/book");
// 초대 링크 새로 만들기. 옛 코드는 서버에서 그 자리에 죽는다 — 링크가 어디까지 퍼졌는지
// 모르게 됐을 때 되돌릴 방법이 이것뿐이다. 이미 맺어진 친구는 그대로다.
const apiRotateCode = () => apiCall("/friends/code", { method: "POST" });

// 어느 제공자로 로그인할 수 있나. 비밀값이 안 들어간 제공자의 버튼을 그리면 사용자가
// 누르고 나서야 503 을 본다 — 화면에 보이는 것은 실제로 되는 것이어야 한다.
// 토큰이 필요 없는 호출이라 apiCall 을 안 쓴다(apiCall 은 토큰이 없으면 그냥 null 을 낸다).
// 실패하면 null — 그때는 **아무것도 숨기지 않는다**(오프라인이라고 로그인을 못 하게 만들지 않는다).
async function apiHealth() {
  try {
    const res = await fetch(API + "/health");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// 네이버 전용. 앱 주소로 돌아온 code 를 서버에 넘긴다 — 비밀키가 필요한 교환이라 브라우저에서
// 직접 못 한다. **응답에 토큰은 없다**: 서버가 Set-Cookie 로 심고 여기선 성공 여부와 n 만 받는다.
// apiCall 을 안 쓰는 이유는 아직 로그인 표시가 없는 상태의 호출이기 때문이다.
async function apiExchange(provider, code, state) {
  const q = new URLSearchParams({ code, state });
  try {
    const res = await fetch(`${API}/exchange/${provider}?${q}`, { credentials: "same-origin" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
