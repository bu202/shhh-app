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

const apiGetBook = () => apiCall("/book");
const apiPutBook = (words) => apiCall("/book", { method: "PUT", body: JSON.stringify({ words }) });
const apiDeleteAccount = () => apiCall("/me", { method: "DELETE" });
