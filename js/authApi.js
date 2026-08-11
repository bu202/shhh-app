// 계층: 데이터·외부 접근 (apiClient). **fetch 는 이 파일에만 나온다.**
// 화면·판단은 js/auth.js 가 한다. 서버 주소가 바뀌면 여기 API 한 줄만 고치면 된다.
const API = "https://shhh-api.bu202.workers.dev";
const TOKEN_KEY = "shh-token";   // 세션 토큰. 개인정보가 아니라 무작위 문자열이다.
const VIA_KEY = "shh-via";       // 어느 걸로 로그인했는지(화면 표시용)

const authToken = () => localStorage.getItem(TOKEN_KEY);
const authVia = () => localStorage.getItem(VIA_KEY);
// 토큰은 `<base64url(uid)>.<무작위>` 다(worker 의 mkToken). 어느 계정인지 알아야
// **계정이 바뀐 것**을 알아채고 앞 계정 단어장을 새 계정에 물려주지 않을 수 있다.
// 서버에 묻지 않는 이유: 이미 손에 든 문자열로 알 수 있고, 판정에 쓰지 않는다(표시·비교용).
const authUid = () => {
  const t = authToken() || "";
  const i = t.indexOf(".");
  if (i < 1) return "";
  try { return atob(t.slice(0, i).replace(/-/g, "+").replace(/_/g, "/")); } catch { return ""; }
};

// 세션이 죽었을 때(로그아웃·만료) 화면을 다시 그리게 하는 훅. 여기는 데이터 계층이라
// 화면을 직접 못 만진다 — 알리기만 하고 무엇을 그릴지는 js/auth.js 가 정한다.
// ⚠️ 함정 44: 지금은 주인이 하나라 단일 함수다. 두 번째 파일이 붙는 순간 배열로 바꿀 것.
let authLost = null;
function onAuthLost(fn) { authLost = fn; }
const setAuth = (token, via) => {
  if (token) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(VIA_KEY, via || ""); }
  else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(VIA_KEY); }
};

// 로그인은 리다이렉트다. 팝업은 폰 브라우저에서 자주 막히고, 설치된 PWA 에선 창이 아예 안 뜬다.
// return 은 지금 주소 — 서버가 이 주소를 KV 의 state 로 검증하므로 아무 데로나 못 보낸다.
const loginUrl = (provider) =>
  `${API}/login/${provider}?return=${encodeURIComponent(location.origin + location.pathname)}`;

// 실패하면 null. **로컬 단어장은 절대 건드리지 않는다** — 오프라인에서 단어장이 비면 안 된다.
async function apiCall(path, opts = {}) {
  const t = authToken();
  if (!t) return null;
  try {
    const res = await fetch(API + path, {
      ...opts,
      headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
    });
    // 세션이 죽었다 — 만료(180일)거나, 다른 기기에서 로그아웃·탈퇴했거나.
    // 토큰만 지우면 화면은 로그인 상태로 남아, 담기를 눌러도 왜 안 되는지 말해주지 않는다.
    if (res.status === 401) { setAuth(null); authLost?.(); return null; }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;   // 오프라인
  }
}

// 별명은 단어장과 **같은 레코드**에 산다. 저장할 곳이 하나뿐이라 시각 비교(LWW)도 한 번에 끝나고,
// 별명만 따로 최신인 상태가 생기지 않는다.
const apiGetBook = () => apiCall("/book");
const apiPutBook = (words, name) =>
  apiCall("/book", { method: "PUT", body: JSON.stringify({ words, name }) });
const apiDeleteAccount = () => apiCall("/me", { method: "DELETE" });
// 로그아웃은 **서버에도** 알린다. 브라우저에서 토큰만 지우면 KV 의 세션은 180일을 더 살아서,
// 한 번 샌 토큰이 로그아웃 뒤에도 그대로 쓰인다. 이 계정에 로그인한 기기가 전부 함께 끊긴다.
const apiLogout = () => apiCall("/session", { method: "DELETE" });

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

// 네이버 전용. 앱 주소로 돌아온 code 를 서버에 넘겨 세션 토큰으로 바꾼다 —
// 비밀키가 필요한 교환이라 브라우저에서 직접 못 한다. apiCall 을 안 쓰는 이유는
// **아직 토큰이 없는 상태**의 호출이기 때문(apiCall 은 토큰이 없으면 그냥 null 을 낸다).
async function apiExchange(provider, code, state) {
  const q = new URLSearchParams({ code, state });
  try {
    const res = await fetch(`${API}/exchange/${provider}?${q}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
