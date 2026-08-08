// 계층: 데이터·외부 접근 (apiClient). **fetch 는 이 파일에만 나온다.**
// 화면·판단은 js/auth.js 가 한다. 서버 주소가 바뀌면 여기 API 한 줄만 고치면 된다.
const API = "https://shhh-api.bu202.workers.dev";
const TOKEN_KEY = "shh-token";   // 세션 토큰. 개인정보가 아니라 무작위 문자열이다.
const VIA_KEY = "shh-via";       // 어느 걸로 로그인했는지(화면 표시용)

const authToken = () => localStorage.getItem(TOKEN_KEY);
const authVia = () => localStorage.getItem(VIA_KEY);
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
    if (res.status === 401) { setAuth(null); return null; }   // 세션 만료(180일)
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

// ── 친구 ──
// 목록은 {code, friends:[{uid,name,count}], in:[…], out:[…]}. 단어는 안 온다 — 목록엔 안 쓴다.
const apiFriends = () => apiCall("/friends");
// 초대 코드로 요청 보내기. 상대가 이미 나에게 보냈으면 서버가 그 자리에서 맺어 준다.
const apiAddFriend = (code) => apiCall("/friends", { method: "POST", body: JSON.stringify({ code }) });
const apiAcceptFriend = (uid) => apiCall("/friends/" + encodeURIComponent(uid), { method: "PUT" });
// 거절 · 요청 취소 · 친구 끊기가 전부 이 한 줄이다 — 서버에서도 "이 연결을 지운다" 하나다.
const apiRemoveFriend = (uid) => apiCall("/friends/" + encodeURIComponent(uid), { method: "DELETE" });
const apiFriendBook = (uid) => apiCall("/friends/" + encodeURIComponent(uid) + "/book");

// 마스터 코드 확인. **로그인 전에도 부른다** — 코드의 존재 이유가 "로그인 없이도 마스터"라서
// apiCall(토큰 없으면 null) 을 못 쓴다.
async function apiCheckMaster(code) {
  try {
    const res = await fetch(`${API}/master?code=${encodeURIComponent(code)}`);
    return res.ok ? (await res.json()).ok === true : false;
  } catch {
    return false;   // 오프라인 — 나중에 다시 열면 된다
  }
}

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
