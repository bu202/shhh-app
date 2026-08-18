// shhh! 로그인 + 단어장 동기화 (Cloudflare Pages Functions + D1)
//
// 왜 서버가 생겼나: 「안 할 것: 서버」를 깬 건 로그인 때문이 아니라 **저장소** 때문이다.
// 로그인만으로는 단어장이 여전히 기기 안에만 남아 폰을 바꾸면 사라진다 — 그러면 로그인 화면만
// 하나 늘고 사용자에겐 아무것도 안 달라진다. "나만의 단어장"은 DB 문제였다.
//
// **왜 KV 에서 D1 으로 옮겼나** (2026-08-11). 처음엔 "사용자 → 단어 배열 하나뿐이라 쿼리도 조인도
// 없다"고 판단해 KV 를 골랐다. 그 판단은 **친구 기능이 생기면서 틀린 것이 됐다** —
// 친구 관계는 두 사람에 걸친 데이터라 KV 로는 두 곳에 적어야 하고, 트랜잭션이 없어서
//   ① 첫 쓰기만 성공하면 반쪽이 남고(그 상태에서 남의 단어장이 열리지 않게 막는 코드가 따로 필요했다)
//   ② 로그아웃이 `list()` 에 기대는데 최종 일관성이라 60초 창이 닫히지 않았고
//   ③ 계정 삭제가 6번의 개별 삭제라 중간에 죽으면 반쯤 지워진 계정이 남았다.
// D1 에서는 관계가 **행 하나**, 로그아웃이 **세대 +1**, 삭제가 **CASCADE 한 문장**이라
// 그 세 가지가 증상이 아니라 원인 자체로 사라진다. 스키마는 worker/schema.sql.
//
// 받는 개인정보: **제공자가 주는 고유 번호뿐**. 이름·이메일·프로필 사진 어느 것도 요청하지 않는다.
// 그래서 카카오 비즈앱 전환도, 구글 민감 범위 심사도 필요 없다. privacy.html 이 이 사실에 맞춰져 있으니
// scope 를 늘릴 거면 그 문서를 **먼저** 고칠 것.
// 그 번호는 `users` 행 안에서만 살고 **밖으로 나가는 건 우리가 만든 무작위 id** 다.
//
// ⚠️ KV 바인딩은 아직 wrangler.jsonc 에 남아 있지만 **이 파일은 KV 를 쓰지 않는다.**
//    롤백(옛 배포로 되돌리기)이 성립하려면 그때 코드가 읽을 KV 가 있어야 해서 남겨 둔 것이다.
//    D1 이 안정되면 바인딩과 네임스페이스를 지운다(docs/D1_MIGRATION.md 의 5번).
//
// state 는 어디에도 저장하지 않는다. `/login` 은 인증이 없는 자리라 거기서 저장소를 쓰면
// `curl` 반복만으로 무료 한도를 태울 수 있다 — 서명해서 들려 보낸다(makeState).

import { POLICY_BUNDLE } from "./policies.js";
import {
  deletionMark, DELETION_KEY_VERSION, readMode, ledgerAnswers, drainState,
  acquireLease, leaseAlive, releaseLease,
  markPending, markConfirmed, sweepConfirmed, cleanupState,
} from "./ledger.js";

const P = {
  kakao: {
    auth: "https://kauth.kakao.com/oauth/authorize",
    token: "https://kauth.kakao.com/oauth/token",
    me: "https://kapi.kakao.com/v2/user/me",
    scope: "",                       // 동의항목 0개. 회원번호만 받는다.
    uid: (j) => j.id,
    // 카카오만 secret 이 선택이다 — 콘솔에서 "보안 > client_secret" 을 꺼두면 없이도 교환된다.
    // 켜 두고 값을 안 넣으면 교환이 실패하지만, 서버는 어느 쪽인지 알 수 없다(콘솔의 상태다).
    optionalSecret: true,
  },
  naver: {
    auth: "https://nid.naver.com/oauth2.0/authorize",
    token: "https://nid.naver.com/oauth2.0/token",
    me: "https://openapi.naver.com/v1/nid/me",
    scope: "",
    uid: (j) => j.response && j.response.id,
    // 네이버만 콜백이 **앱 도메인**으로 간다. 네이버는 서비스 URL 을 하나만 받으면서 콜백이 그
    // 도메인 안에 있기를 요구하는데(함정 41), 서비스 URL 은 사람이 보는 앱 주소여야 하기 때문이다.
    // 그래서 앱이 code 를 받아 /exchange/naver 로 넘긴다. 카카오·구글은 종전대로 /cb 로 직접 받는다.
    viaApp: true,
  },
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    me: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid",                 // sub 만 받는 최소 범위. profile·email 은 요청하지 않는다.
    uid: (j) => j.sub,
  },
};

// ⚠️ **`P[name]` 을 직접 진리값으로 쓰지 않는다.** 객체 인덱싱은 프로토타입 체인까지 본다 —
//    `P["__proto__"]`·`P["constructor"]` 는 **참**이라, 그 이름이 제공자 검사를 통과해 버린다.
//    그러면 아래에서 `p.auth` 가 undefined 인 채로 흘러 「없는 제공자」가 아니라 「설정이 덜 됨」
//    으로 답하게 되고(503), 실제로 없는 것을 있는데 고장 났다고 말하는 셈이 된다.
//    자기 속성만 본다.
const isProvider = (n) => typeof n === "string" && Object.prototype.hasOwnProperty.call(P, n);

// 앱 주소는 env.APP_ORIGIN 하나. 로컬 개발(localhost·LAN)은 **개발용 Worker 에서만** 연다.
//
// ⚠️ 이 함수는 CORS 와 **로그인 복귀 주소**를 둘 다 정한다. 운영에서 LAN 을 열어 두면
// `/login/kakao?return=http://192.168.1.9:8000` 로 세션 토큰이 남의 서버로 간다 —
// 같은 와이파이(카페·기숙사)에 있는 사람이 링크 하나로 남의 계정을 가져갈 수 있다.
// 켜려면 개발 Worker 에만 `wrangler secret put DEV_ORIGINS`(=1). **wrangler.jsonc 에 적지 않는다** —
// 비어 있으면 앱 주소 하나만 허용한다(기본값이 안전한 쪽).
const allowed = (env, origin) =>
  origin === env.APP_ORIGIN ||
  (env.DEV_ORIGINS === "1" && /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+):\d+$/.test(origin || ""));

// 모든 API 응답에 붙는다. `_headers` 는 **정적 자산에만** 걸려서 여기까지 오지 않는다 —
// Pages Functions 응답 헤더는 이 파일이 직접 붙여야 한다.
//   Cache-Control: 개인 단어장이 브라우저·중간 캐시에 남으면 한 기기를 두 사람이 쓸 때
//                  앞사람 응답이 뒷사람에게 뜬다(SW 는 이미 /api 를 안 캐시한다 — 그 두 번째 자물쇠).
//   Vary: Origin — CORS 헤더가 Origin 마다 달라지므로, 없으면 캐시가 다른 Origin 에 재사용한다.
const SEC = { "Cache-Control": "private, no-store", "Vary": "Origin", "X-Content-Type-Options": "nosniff" };

const cors = (env, req) => {
  const o = req.headers.get("Origin");
  return allowed(env, o)
    ? { ...SEC, "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" }
    : { ...SEC };
};

const json = (env, req, body, status = 200, extra) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...cors(env, req), ...extra } });

// 리다이렉트도 우리가 만든다. `Response.redirect` 는 헤더를 못 얹는데, 이 응답의 Location 에는
// **세션 토큰이 실려 있어서** no-store 가 가장 필요한 자리다.
const redir = (url) => new Response(null, { status: 302, headers: { Location: url, ...SEC } });

const creds = (env, provider) => ({
  id: env[provider.toUpperCase() + "_ID"],
  secret: env[provider.toUpperCase() + "_SECRET"],
});

// ── 서명·토큰·본문 ───────────────────────────────────────────────────────
const ENC = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// ⚠️ **STATE_KEY 가 없으면 던진다.** 없을 때 그냥 진행하면 `ENC.encode(undefined)` 가
// 문자열 `"undefined"` 를 서명 키로 쓴다 — 그 키는 누구나 아는 값이라 **아무나 유효한 state 를
// 만들 수 있고**, state 안에는 로그인 뒤 토큰을 실어 보낼 주소가 들어 있다. 조용히 도는 쪽이
// 안 도는 쪽보다 나쁜 자리라 실패-닫힘으로 둔다(라우트에서 503 으로 잡는다).
async function sign(env, msg) {
  if (!env.STATE_KEY) throw new Error("STATE_KEY not configured");
  const k = await crypto.subtle.importKey("raw", ENC.encode(env.STATE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, ENC.encode(msg)));
}

// 비밀값 비교는 **끝까지** 한다. 앞에서 끊으면 몇 글자가 맞았는지가 응답 시간으로 새어,
// 한 글자씩 붙여 가며 값을 알아낼 수 있다. 길이가 다르면 그 자리에서 거짓 — 길이는 비밀이 아니다.
const sameSecret = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

// ── 설정 점검 ────────────────────────────────────────────────────────────
// **값은 절대 내보내지 않는다.** 있나 없나만 본다. 이름도 그대로 쓰지 않는다 —
// 화면에 필요한 건 "어느 제공자로 로그인할 수 있나" 하나뿐이다.
// **쌍이 맞아야 제공자로 친다.** 전에는 id 만 봐서, secret 을 안 넣은 제공자의 버튼이 화면에
// 그려지고 사용자가 누르면 콜백에서 교환이 실패했다 — 배포자가 아니라 사용자가 먼저 알게 된다.
// 카카오만 예외다(위 optionalSecret 참조).
const readyProviders = (env) => Object.keys(P).filter((n) => {
  const { id, secret } = creds(env, n);
  return !!id && (!!secret || !!P[n].optionalSecret);
});
const health = (env) => {
  const providers = readyProviders(env);
  // DB 바인딩이 없으면 로그인도 단어장도 못 한다 — ready 가 아니다.
  // ⚠️ KV 는 더 이상 안 본다. 바인딩은 **롤백용으로 남겨 두지만** 새 코드는 쓰지 않는다.
  // ⚠️ RL_KEY 도 **있어야 하는 값**이다. 없으면 리미터가 세지 않는데(rlBucket 참조),
  //    그건 화면 어디에도 안 보이는 종류의 결함이라 여기서 말하지 않으면 아무도 모른다.
  //    계정 기능을 여는 날 시크릿을 빠뜨리면 /ready 가 503 으로 먼저 알려준다.
  // ⚠️ **가입 전용 키 둘도 여기 있다**(2026-08-18). 없으면 `/signup/start` 가 503 이라
  //    로그인은 되는데 **가입만 조용히 막히는** 상태가 된다 — 화면 어디에도 안 보이는 결함이라
  //    여기서 말하지 않으면 아무도 모른다. `DELETION_KEY` 도 같다(없으면 계정 삭제가 503).
  const keys = !!(env.STATE_KEY && env.RL_KEY && env.SIGNUP_STATE_KEY && env.TOMBSTONE_KEY && env.DELETION_KEY);
  return { ok: true, ready: !!(keys && env.APP_ORIGIN && env.DB && providers.length), providers,
           signupReady: !!(env.SIGNUP_STATE_KEY && env.TOMBSTONE_KEY) };
};

// /ready 전용. 바인딩이 **있다**와 DB 가 **답한다**는 다른 말이다 — 잘못된 database_id 로 배포하면
// 바인딩은 멀쩡히 있고 첫 질의에서만 터진다. 그 실패를 사용자의 로그인이 아니라 여기서 낸다.
// ⚠️ 오류 내용을 밖으로 내지 않는다. D1 오류 문자열에는 테이블·컬럼 이름이 섞여 나온다.
// ⚠️ 예전엔 `SELECT 1` 만 던졌다. 그건 "DB 가 살아 있나"만 답하고 **"이 코드가 쓰는 스키마가
//    거기 있나"** 는 답하지 않는다 — 원격에 이전이 안 걸린 배포는 SELECT 1 을 멀쩡히 통과하고
//    사용자의 첫 친구 요청에서 500 을 낸다. 그래서 코드가 실제로 만지는 테이블과 **컬럼까지**
//    건드려 본다(pair_key 를 조건에 넣은 이유가 그것이다: 0002·0003 이 걸렸는지 여기서 드러난다).
//    COUNT 는 작은 테이블이라 값싸고, readiness 는 자주 부르는 자리가 아니다.
const dbAnswers = async (env) => {
  if (!env.DB) return false;
  try {
    const r = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM sessions)
            + (SELECT COUNT(*) FROM books) + (SELECT COUNT(*) FROM invite_codes)
            + (SELECT COUNT(*) FROM rate_limits)
            + (SELECT COUNT(*) FROM friendships WHERE pair_key IS NOT NULL)
            + (SELECT COUNT(*) FROM policy_events WHERE document_version IS NOT NULL)
            + (SELECT COUNT(*) FROM consumed_signup_states WHERE key_version IS NOT NULL) AS n`).first();
    return typeof r?.n === "number";
  } catch {
    return false;
  }
};

// state 는 KV 가 아니라 **서명한 문자열**이다. 담는 건 종전과 같다(어느 제공자로 시작했나 ·
// 돌아갈 주소 · 언제까지).
//
// ⚠️ **서명은 암호화가 아니다.** 우리 키로 서명하므로 남이 **만들** 수 없지만, 본문은 그냥
//    Base64URL 이라 **누구나 읽을 수 있다** — 이 문자열은 제공자 URL·브라우저 기록·접근 로그를
//    평문으로 지나간다. 그래서 여기에는 **읽혀도 되는 것만** 싣는다. 지금 싣는 네 값은 전부
//    그렇다(제공자 이름·복귀 주소·만료·표 해시). 회원가입 화면이 생기면 약관 수락·연령 진술이
//    실려야 하는데 **그건 읽혀도 되는 값이 아니다** — 그때는 서명이 아니라 암호화(AEAD)와
//    전용 키가 필요하다(docs/STAGE3_SIGNUP_SECURITY_DESIGN.md §5-4).
//
// ⚠️ **1회용 보장이 없다.** 같은 state 를 두 번 낼 수 있다.
//    예전 주석은 "code 가 1회용이라 두 번째 교환은 제공자가 거부하므로 손해가 없다"고 적었는데
//    **그 결론은 좁다.** 지금 이 코드에서 순차 재사용을 실제로 막는 것은 code 가 아니라
//    아래 `clearTxn()` 이다(`:766`·`:809` — 성공하면 표를 지우므로 다음 번 `bound()` 가 거짓).
//    남는 길은 둘이다: ① 표가 지워지기 전에 **동시에** 도착한 두 요청 ② Set-Cookie 의 삭제를
//    무시하는 비표준 클라이언트. 지금 state 에는 읽혀도 되는 값만 있고 세션은 제 계정으로만
//    생기므로 그 둘을 **감수한다.** 가입 정보가 실리는 순간 감수할 수 없게 된다 —
//    한 번의 수락이 두 계정의 증거가 되기 때문이다(같은 문서 §4-B·§5-3).
//
// nonce 는 **브라우저가 만들어 준 값**이다. 돌아올 때 그대로 돌려줘서, 이 브라우저가 실제로
// 시작한 로그인인지 앱이 확인하게 한다. 다만 **그건 앱의 사후 확인일 뿐이다** —
// 서버 쪽 결속은 아래 txn 이 한다(「로그인 왕복 표」 참조).
//
// txn 은 **서버가 만들어 그 브라우저에만 심어 둔 값의 해시**다. state 에는 해시만 싣는다:
// state 는 주소에 실려 남에게 보일 수 있으므로 원본을 실으면 표를 베낄 수 있게 된다.
const makeState = async (env, provider, back, nonce, txn) => {
  const body = b64u(ENC.encode(JSON.stringify([provider, back, Date.now() + 600e3, nonce || "", txn || ""])));
  return body + "." + (await sign(env, body));
};

async function takeState(env, state) {
  if (!state || !env.STATE_KEY) return null;   // 키가 없으면 **아무 state 도 유효하지 않다**
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const body = state.slice(0, i);
  if (!sameSecret(await sign(env, body), state.slice(i + 1))) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
  const [provider, back, exp, nonce, txn] = p;
  if (!(Date.now() < exp)) return null;
  return { provider, back, nonce: nonce || "", txn: txn || "" };
}

// ── 정책 문서와 가입 기록 ────────────────────────────────────────────────
// **개수를 하드코딩하지 않는다.** 집합 하나가 원본이고 나머지는 전부 이 집합을 순회한다 —
// 숫자를 여러 곳에 적어 두면 항목이 늘어난 날 테스트가 통과하면서 하나를 빠뜨린다.
//
// ⚠️ `privacy` 가 `accepted` 가 아니라 **`presented`** 인 이유: 처리 근거를 「개인정보 보호법」
//    제15조 제1항 제4호(계약의 이행)로 두기로 했으므로 **동의를 받지 않는다.** 받지 않은 동의를
//    받았다고 기록하면 그 기록 자체가 거짓이 된다. 같은 이유로 `xborder/accepted` 도 없다
//    (국외 처리위탁·보관은 제28조의8 제1항 제3호를 근거로 삼는다).
//    ⚠️ 이것은 프로젝트가 공식 자료를 보고 내린 **운영 결정**이지 외부 법률 검토 결과가 아니다.
export const requiredPolicyKinds = [
  ["terms", "accepted"],
  ["privacy", "presented"],
  ["age14", "attested"],
];
export const REQUIRED_POLICY_EVENTS = requiredPolicyKinds.length;

// 화면이 받아 갈 번들. **경로와 해시만** 준다 — 문서 내용은 정적 파일로 따로 받는다.
const policyBundle = () => ({ pv: POLICY_BUNDLE.pv, docs: POLICY_BUNDLE.docs });

// ── 가입 state — 서명이 아니라 **암호화**한다 (AES-256-GCM) ───────────────
//
// 로그인 state 는 지금 그대로 둔다(위 makeState). 담는 네 값이 전부 **읽혀도 되는 값**이기 때문이다.
// 가입 state 는 다르다 — 약관 수락·연령 진술·행위 시각이 실리고, 그 값은 제공자 접근 로그·
// 브라우저 기록·조직 프록시를 **평문으로** 지나가게 된다. 서명은 변조를 막을 뿐 열람을 막지 않는다.
//
// 형식:  v1.<exp>.<b64u(nonce 12B)>.<b64u(암호문‖태그)>
//   ⚠️ **exp 를 헤더에 둔 것은 일부러다.** AAD 에 exp 를 넣으려면 복호화 **전에** 그 값을 알아야
//      하는데, 5판 설계는 exp 를 암호문 안에만 두면서 AAD 에도 넣으라고 적어 모순이었다.
//      exp 는 비밀이 아니므로 밖에 두고, **안쪽에도 같은 값을 넣어 대조**한다 —
//      헤더만 고치면 복호화가 실패하고(AAD 불일치), 둘이 다르면 우리가 거부한다.
const SIGNUP_V = "v1";
const SIGNUP_TTL = 600e3;          // 10분. 로그인 state 와 같다
const SIGNUP_STATE_MAX = 2048;     // URL 길이 한계와 로그 폭주를 함께 막는다

// 키는 **32바이트여야 한다.** base64 로 디코딩해 길이를 확인하고, 아니면 실패-닫힘이다.
// 짧은 키를 조용히 늘려 쓰면(패딩·해시 유도) 키 강도가 설정 실수에 좌우된다.
async function signupKey(env) {
  const raw = env.SIGNUP_STATE_KEY;
  if (typeof raw !== "string" || !raw) throw new Error("SIGNUP_STATE_KEY not configured");
  let bytes;
  try { bytes = unb64u(raw); } catch { throw new Error("SIGNUP_STATE_KEY not base64"); }
  if (bytes.length !== 32) throw new Error("SIGNUP_STATE_KEY must decode to 32 bytes");
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
// 결속. 암호문이 그대로여도 **다른 제공자·다른 목적·다른 오리진·다른 만료**에서는 복호화가 실패한다.
const signupAad = (env, provider, exp) =>
  ENC.encode(`${SIGNUP_V}|signup|${provider}|${env.APP_ORIGIN}|${exp}`);

export async function makeSignupState(env, provider, payload) {
  const exp = Date.now() + SIGNUP_TTL;
  // ⚠️ nonce 는 **요청마다 CSPRNG** 다. 카운터·시각·해시에서 유도하지 않는다 —
  //    GCM 은 같은 키로 nonce 를 두 번 쓰면 평문이 복원되고 위조까지 가능해진다.
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plain = ENC.encode(JSON.stringify({ ...payload, provider, exp }));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: signupAad(env, provider, exp) },
    await signupKey(env), plain);
  const out = `${SIGNUP_V}.${exp}.${b64u(nonce)}.${b64u(ct)}`;
  if (out.length > SIGNUP_STATE_MAX) throw new Error("signup state too long");
  return out;
}

// 실패 사유를 **가려서 알려주지 않는다.** 만료·위조·버전 불일치를 구분해 주면 그 자체가 오라클이 된다.
export async function takeSignupState(env, state, provider) {
  if (typeof state !== "string" || state.length > SIGNUP_STATE_MAX) return null;
  const parts = state.split(".");
  if (parts.length !== 4 || parts[0] !== SIGNUP_V) return null;   // 모르는 버전은 거부
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || !(Date.now() < exp)) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64u(parts[2]), additionalData: signupAad(env, provider, exp) },
      await signupKey(env), unb64u(parts[3]));
    const p = JSON.parse(new TextDecoder().decode(plain));
    // **안쪽이 진실이다.** 헤더의 exp 는 조기 거부용이고, 둘이 다르면 그 자체가 이상 신호다.
    if (p.exp !== exp || p.provider !== provider) return null;
    return p;
  } catch {
    return null;
  }
}

// ── 가입 state 1회 소비 표식 ─────────────────────────────────────────────
// 저장하는 값은 **전용 키 HMAC** 이다. 단순 SHA-256 이면 state 를 관찰할 수 있는 사람
// (제공자 접근 로그·브라우저 기록·프록시)이 그 값을 그대로 해시해 **DB 의 어느 행인지 지목**한다.
// 키를 모르면 그 계산 자체가 불가능하다.
// 키가 없으면 **가입을 처리하지 않는다.** 평문 해시로 되돌아가지 않는다.
export async function stateTombstone(env, state) {
  if (!env.TOMBSTONE_KEY) throw new Error("TOMBSTONE_KEY not configured");
  const k = await crypto.subtle.importKey("raw", ENC.encode(env.TOMBSTONE_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, ENC.encode(state)));
}
export const TOMBSTONE_KEY_VERSION = 1;

// ── 세션 ─────────────────────────────────────────────────────────────────
// 토큰은 **완전한 무작위 32바이트**다. 예전엔 `<b64u(uid)>.<무작위>` 라 앞부분이 계정을 알려줬는데,
// 그건 KV 에서 "이 계정의 세션"을 훑으려고 붙인 것이었다. D1 에는 `sessions.user_id` 가 있으니
// 토큰이 계정을 말할 이유가 사라졌다.
//
// **원본을 저장하지 않는다.** DB 가 새도 남의 세션을 쓸 수 없어야 한다 — 저장하는 건 SHA-256 뿐이고
// 원본은 브라우저의 쿠키에만 있다.
const SESSION_DAYS = 180;
const sha256 = async (s) => b64u(await crypto.subtle.digest("SHA-256", ENC.encode(s)));
const mkToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

// 쿠키. **HttpOnly** 라 자바스크립트가 못 읽는다 — XSS 가 나도 세션을 통째로 훔쳐 가지 못한다.
//   Path=/api  : 정적 자산 요청에는 안 실린다(붙일 이유가 없다)
//   SameSite=Lax: 남의 사이트에서 우리에게 보내는 POST 에는 안 실린다(CSRF 의 절반)
//   Secure     : https 에서만. 로컬(http)에서 로그인이 안 되는 건 이미 그렇다(함정 57)
const COOKIE = "shh_s";
const ATTRS = "HttpOnly; Secure; SameSite=Lax; Path=/api";
const setCookie = (token) => `${COOKIE}=${token}; ${ATTRS}; Max-Age=${SESSION_DAYS * 86400}`;
const clearCookie = () => `${COOKIE}=; ${ATTRS}; Max-Age=0`;
const readCookie = (req, name = COOKIE) => {
  const raw = req.headers.get("Cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? m[1] : "";
};

// ── 로그인 왕복 표 (OAuth transaction) ───────────────────────────────────
// **state 서명은 "우리가 만든 state 인가"만 말한다.** 누가 그 주소를 들고 왔는지는 모른다.
// 그래서 예전에는 이런 공격이 성립했다: 공격자가 자기 로그인을 시작해 아직 안 쓴
// `?code=…&state=…` 를 손에 쥐고, 그 주소를 **이미 로그인해 있는 사람**에게 보낸다.
// 서버는 서명이 맞으니 code 를 교환하고 세션을 만들어 **피해자 브라우저에 공격자 계정 쿠키를 심는다.**
// 앱은 그 뒤에야 nonce 가 다른 걸 알아채는데 이미 늦었고, 다음 동기화에서 피해자의 단어장과
// 별명이 공격자 계정으로 올라갔다.
//
// 이제 로그인을 시작할 때 **그 브라우저에만** 무작위 표를 심고, state 에는 그 해시를 서명해 둔다.
// 콜백에서 둘이 맞지 않으면 **code 교환도 세션 생성도 하기 전에** 돌려보낸다.
// 공격자는 피해자 브라우저에 쿠키를 심을 수 없으므로 그런 링크를 만들 수 없다.
//
// ponytail: 표는 쿠키 한 칸이라 **마지막으로 시작한 로그인만 유효**하다. 탭을 여럿 열어
//   두 번 시작하면 먼저 시작한 쪽이 "다시 눌러 주세요"로 실패한다 — 지금보다 엄격해지는
//   방향이라 그대로 둔다. 탭마다 살리려면 DB 테이블이 필요한데(인증 없는 자리의 쓰기),
//   그건 2026-08-11 에 일부러 없앤 것이다.
const TXN = "shh_t";
const setTxn = (t) => `${TXN}=${t}; ${ATTRS}; Max-Age=600`;
const clearTxn = () => `${TXN}=; ${ATTRS}; Max-Age=0`;
// 표가 없거나 다르면 거짓. state 에 표가 안 실린 옛 왕복도 거짓이다(10분이면 다 만료된다).
const bound = async (env, req, st) => !!st.txn && sameSecret(st.txn, await sha256(readCookie(req, TXN)));

// 새 세션 한 줄. 발급 시점의 session_version 을 같이 박아 둔다 — 그 값이 users 와 달라지는 순간
// 이 세션은 죽는다(아래 killSessions).
// export 하는 이유: scripts/test-friends.mjs 가 로그인 왕복을 흉내내지 않고 **진짜 경로로**
// 세션을 만들기 위해서다. 토큰 해시를 테스트가 직접 계산하게 두면 그 순간 로직이 두 벌이 된다.
export async function newSession(env, userId) {
  const token = mkToken();
  const u = await env.DB.prepare("SELECT session_version FROM users WHERE id = ?").bind(userId).first();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, session_version, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, u ? u.session_version : 0, now + SESSION_DAYS * 86400e3).run();
  // ⚠️ **죽은 행을 여기서 치운다.** whoAmI 는 만료를 판정에서만 걸러내고 행은 그대로 뒀다 —
  //    그래서 다시 오지 않는 사용자의 세션 행이 영원히 남았다. 방침(180일 뒤 만료)이 거짓말은
  //    아니지만, 만료된 뒤에도 보관할 이유가 없는 것을 보관하고 있었다.
  //    청소용 크론이 없으니 **로그인이라는 드문 자리**에 붙인다. 실패해도 로그인은 되어야 한다 —
  //    청소가 안 되는 것과 로그인이 안 되는 것은 무게가 다르다.
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL").bind(now),
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now),
    ]);
  } catch { /* 청소 실패는 로그인을 막지 않는다 */ }
  return token;
}

// 이 토큰이 누구인가. 한 번의 조인으로 **살아 있는 세션인지까지** 판정한다:
// 폐기 안 됐고, 안 만료됐고, 발급 당시 세대가 지금 세대와 같아야 한다.
async function whoAmI(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id AS uid FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND s.session_version = u.session_version`)
    .bind(await sha256(token), Date.now()).first();
  return row ? row.uid : null;
}

// 이 계정의 로그인을 **전부** 끊는다. 로그아웃과 탈퇴가 같은 자리를 쓴다.
//
// KV 시절엔 `list()` 로 세션 키를 훑어 지웠는데, KV 목록은 최종 일관성이라 **다른 기기가 60초 안에
// 만든 세션은 목록에 없어서 못 지웠다.** 세대(session_version)를 올리면 훑을 필요가 없다 —
// 아직 목록에 안 뜬 세션도, 방금 만든 세션도, 다음 요청에서 세대가 안 맞아 그 자리에서 죽는다.
// 행 삭제는 청소일 뿐이고 **판정은 세대가 한다**(그래서 삭제가 실패해도 안전하다).
async function killSessions(env, uid) {
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").bind(uid),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(uid),
  ]);
}

// ── 레이트리밋 ───────────────────────────────────────────────────────────
// ⚠️ **Cloudflare 의 Rate Limiting 바인딩은 Pages Functions 에서 못 쓴다**(2026-08 문서 확인:
//    지원 바인딩 목록에 ratelimits 가 없다. Workers 전용). 그래서 지금 이 함수는 **아무것도 막지
//    않는다** — `env.RL` 이 없으면 늘 통과다. 되는 척하지 않으려고 그렇게 뒀다.
//
// KV 카운터로 만들지 않는 이유: 그 쓰기가 바로 2026-08-11 오전에 없앤 것이다. 무료 플랜 KV 는
//   하루 1,000 writes 라 **레이트리밋 자체가 서비스 거부 수단**이 된다. 고치는 게 아니라 옮기는 짓이다.
//
// 실제로 제한을 걸 수 있는 길은 둘뿐이고 **둘 다 코드가 아니다**(docs/SECURITY_RELEASE_CHECKLIST.md):
//   ① 커스텀 도메인을 붙이고 WAF 레이트리밋 규칙 — `*.pages.dev` 는 Cloudflare 소유 존이라
//      대시보드에서 규칙을 못 건다. 도메인이 붙는 순간 열린다. (캐시 퍼지도 같은 조건이다)
//   ② API 를 Pages Functions 에서 Worker 로 되돌리고 `ratelimits` 바인딩 — 그러면 앱과 API 의
//      origin 이 다시 갈라져 쿠키·CSP·네이버 조건을 전부 되돌려야 한다. 값보다 대가가 크다.
//
// ⚠️ **위 문단은 이제 절반만 맞다(2026-08-14).** ①·②는 그대로지만, "KV 카운터라 못 한다"는
//    결론이 D1 로 옮긴 뒤에도 남아 있었다. KV 무료는 하루 1,000 writes 라 리미터가 곧 서비스
//    거부 수단이었지만 **D1 은 하루 10만 writes** 다 — 같은 판단이 반대로 뒤집힌다.
//    그래서 지금은 D1 카운터가 **실제로 막는다.** WAF(①)는 여전히 더 좋은 답이다(엣지에서
//    끊어 볼류메트릭까지 막는다). 이건 그것이 없는 동안 **느린 남용**을 막는 것이다.
//
// 어디에 거는가 — **값이 있는 세 곳만.** 전부에 걸면 PUT /book(0.8초 자동저장)마다 D1 쓰기가
// 하나씩 늘고, 막아서 얻는 것은 없다(본문 한도 8KB 라 쌓일 것이 없다).
//   login   /exchange · /cb — 세션을 무한히 찍어내는 것을 막는다
//   friends POST /friends — **초대 코드 무차별 대입**을 막는다. 이게 유일한 열거 공격면이다
//   write   그 밖의 상태 변경 — 넉넉하게. 정상 사용이 먼저 걸리면 방어가 아니라 고장이다
const RL_WINDOW = 60_000;
// ⚠️ `login` 은 **세션을 만드는 자리**(`/cb`·`/exchange`)에만 건다. 예전엔 `/login`(시작)까지
//    같은 버킷으로 세어서, 한 번의 로그인이 두 자리를 지나 **한도 10 이 실제로는 완전한 로그인
//    5회**였다(실측). 문서에는 10 이라 적혀 있었고, 공유 IP(회사·학교·CGNAT)에서는 그 5회를
//    건물 하나가 나눠 썼다. `/login` 은 302 하나와 서명 하나뿐이고 세션도 DB 행도 안 만든다 —
//    거기를 세면 D1 쓰기가 두 배인데 막는 것은 없다.
// `rotate` 는 초대 링크 새로 만들기. 넉넉한 `write`(120)에만 묶여 있어서, 로그인한 계정
//    **하나**가 분당 240 D1 쓰기 = 하루 34만(무료 한도 10만)을 태울 수 있었다 — 그게 바닥나면
//    정상 사용자의 단어장 저장이 먼저 죽는다. 링크를 새로 만드는 것은 몇 달에 한 번 하는 일이다.
// `signup` 은 **전용 버킷**이다. `write` 에 얹으면 넉넉한 한도(120)를 그대로 물려받는데,
//    가입 시작은 세션도 계정도 안 만들지만 **제공자 인증 주소를 찍어내는 자리**라 좁아야 한다.
//    WRITE_ROUTES 에 `/signup` 을 넣지 않는 이유이기도 하다 — 넣으면 한 요청을 두 번 센다.
const RL_MAX = { login: 10, signup: 10, friends: 20, rotate: 5, write: 120 };
// 상태를 바꾸는 **실제 라우트**만. 여기 없는 경로는 세지 않고 그냥 404 로 보낸다 —
// 없는 자리를 두드리는 것으로 우리 DB 쓰기를 유발할 수 있으면 리미터가 공격 도구가 된다.
const WRITE_ROUTES = /^\/(session|book|me|friends)(\/|$)/;

// 버킷 이름을 만든다. **평문 SHA-256 이 아니라 비밀키 HMAC 이다.**
// 왜 바꿨나: IPv4 는 경우의 수가 43억뿐이라 평문 해시는 전부 넣어 보면 풀린다 — 실측에서
// `/24` 대역만 대입해 **43회 만에** 원본 IP 가 나왔다. 그러면 이 표를 읽을 수 있는 사람은
// "누가 언제 우리 서비스에 왔나"를 복원할 수 있고, privacy.html 의 "되돌릴 수 없는 요약값"이
// 거짓말이 된다. 키를 모르면 **넣어 볼 값 자체를 만들 수 없다.**
//
// ⚠️ RL_KEY 가 없으면 **평문 해시로 되돌아가지 않는다.** 조용히 약한 쪽으로 도는 것이 가장
//    나쁘다 — 아무도 못 알아채고 방침만 거짓말이 된다. 대신 세지 않고(fail-open) readiness 가
//    시끄럽게 말한다(health 의 RL_KEY 조건). 남용 방어가 서비스를 멈추는 쪽보다는
//    "지금 안 세고 있다"를 /ready 로 드러내는 쪽이 낫다.
// ⚠️ STATE_KEY·OAuth secret 을 대신 쓰지 않는다. 용도가 다른 비밀값을 겸용하면 하나를 돌릴 때
//    다른 하나가 같이 무너진다.
const rlBucket = async (env, msg) => {
  if (!env.RL_KEY) return null;
  const k = await crypto.subtle.importKey("raw", ENC.encode(env.RL_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, ENC.encode(msg)));
};

// 고정 창. **세는 것과 판정이 UPSERT 한 문장 안에서 끝난다** — 읽고 나서 쓰면 동시 요청이
// 창 하나를 여러 번 통과한다(친구 상한이 겪은 것과 같은 종류의 경합이다).
// 리미터가 고장 나면 통과시킨다(fail-open): 남용 방어가 서비스를 멈추는 쪽이 더 나쁘고,
// 진짜 방어선은 WAF 다. 이 선택을 아는 채로 한다.
async function limited(env, req, uid, bucket) {
  // 바인딩이 생기는 날(Workers 로 돌아가는 등) 그쪽을 먼저 쓴다 — 엣지가 더 값싸다.
  // ⚠️ **여기도 fail-open 이다.** 전에는 이 갈래만 try 밖에 있어서, 바인딩이 흔들리면
  //    리미터가 요청을 통과시키는 게 아니라 **500 으로 죽였다** — 남용 방어가 서비스 거부가 된다.
  if (env.RL) {
    try {
      const who = uid || req.headers.get("CF-Connecting-IP") || "anon";
      const { success } = await env.RL.limit({ key: bucket + "|" + who });
      return !success;
    } catch {
      return false;
    }
  }
  if (!env.DB) return false;
  const now = Date.now();
  // ⚠️ 키에 uid·IP **원문을 넣지 않는다.** 남용을 세려고 개인정보를 쌓는 건 목적에 비해 과하다.
  //    (로그에도 남기지 않는다 — 아래 어디에서도 console.log 하지 않는다.)
  const who = uid || req.headers.get("CF-Connecting-IP") || "anon";
  const max = RL_MAX[bucket] ?? RL_MAX.write;
  const key = await rlBucket(env, `${bucket}|${who}|${Math.floor(now / RL_WINDOW)}`);
  // 키를 못 만들었다 = RL_KEY 가 없다. **평문 해시로 되돌아가지 않고** 세지 않는다(위 rlBucket).
  if (!key) return false;
  try {
    // ⚠️ **막기로 정한 뒤에는 더 세지 않는다.** 전에는 한도를 넘긴 뒤에도 UPSERT 가 계속
    //    n+1 을 썼다 — 공격자는 429 를 받으면서 우리 D1 쓰기 할당량(하루 10만)을 태울 수 있었고,
    //    그게 바닥나면 **정상 사용자의 단어장 저장이 먼저 죽는다**(리미터가 증폭기가 된 셈).
    //    DO UPDATE 의 WHERE 가 거짓이면 SQLite 는 행을 건드리지 않고 RETURNING 도 비운다 —
    //    그 "빈 결과"가 곧 "이미 한도를 넘었다"는 뜻이다.
    const r = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, n, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT (bucket) DO UPDATE SET n = rate_limits.n + 1
         WHERE rate_limits.n <= ?3
       RETURNING n`).bind(key, now + RL_WINDOW * 2, max).first();
    if (!r) return true;      // 갱신을 건너뛰었다 = 이미 넘겼다. 쓰기도 안 났다.
    return r.n > max;
  } catch {
    return false;
  }
}
const tooMany = (env, req) =>
  new Response(JSON.stringify({ error: "잠시 뒤에 다시 시도해 주세요" }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60", ...cors(env, req) } });

// 신뢰 경계. 무료 플랜 Worker 는 메모리가 128MB 인데 요청 본문 한도는 100MB 라,
// 안 막으면 한 번의 요청으로 밀어붙일 수 있다.
//
// **Content-Length 만 보면 방어가 안 된다** — 공격자는 그 헤더 없이(chunked) 보내면 그만이다.
// 그래서 스트림을 읽으면서 한도를 넘는 순간 끊는다. 헤더가 있으면 읽기도 전에 자르는 지름길로만 쓴다.
const MAX_BODY = 8192;

// 스트림을 한도까지만 읽는다. 넘으면 그 자리에서 끊고 null 을 준다(자른 앞부분을 쓰지 않는다 —
// 잘린 JSON 은 어차피 못 읽고, 읽히기라도 하면 그게 더 나쁘다).
// **요청 본문과 제공자 응답이 같은 함수를 쓴다.** 둘 다 우리가 만들지 않은 바이트이고,
// 막는 이유도 같다: 한 번의 응답으로 128MB Worker 를 밀어붙일 수 있으면 안 된다.
async function readCapped(body, max) {
  const reader = body && body.getReader();
  if (!reader) return null;
  const buf = new Uint8Array(max);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) { await reader.cancel(); return null; }
    buf.set(value, n);
    n += value.length;
  }
  return new TextDecoder().decode(buf.subarray(0, n));
}

// Content-Length 는 **지름길로만** 쓴다. 없으면(chunked) 위 스트림이 막는다.
const tooBig = (headers, max) => {
  const len = Number(headers.get("Content-Length"));
  return Number.isFinite(len) && len > max;
};

async function readBody(req) {
  if (!(req.headers.get("Content-Type") || "").includes("application/json")) return null;
  if (tooBig(req.headers, MAX_BODY)) return null;
  const text = await readCapped(req.body, MAX_BODY);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// 제공자가 code 를 어디로 돌려보내는가. 여기서 만든 값과 **똑같은 문자열**을 토큰 교환에도 보내야
// 한다 — 한 글자만 달라도 제공자가 거부한다. 그래서 두 곳이 이 함수 하나를 부른다.
const redirectUri = (env, origin, name) =>
  P[name].viaApp ? env.APP_URL : origin + "/api/cb/" + name;

// code → 세션 토큰. /cb(카카오·구글)와 /exchange(네이버) 둘 다 이 함수를 쓴다 —
// 흐름이 갈려도 **토큰 교환과 사용자 판별은 한 곳**이어야 한쪽만 고치는 실수가 안 난다.
// 남의 서버를 부르는 자리. **응답이 JSON 이라고 믿지 않는다** — 제공자가 점검 중이면 HTML
// 오류 페이지가 오고, `.json()` 이 그대로 던져 500 이 나간다. 타임아웃도 여기 있다: 없으면
// 제공자가 늘어질 때 우리 요청이 같이 매달린다.
//
// ⚠️ **크기 상한이 없으면 `text()` 는 오는 대로 다 받는다.** 무료 Worker 는 메모리가 128MB 인데
//    이 함수는 로그인 한 번에 두 번 불린다 — 상한이 없으면 남의 서버가 우리 메모리를 정한다.
//    실제 정상 응답은 구글 토큰(id_token 포함)이 가장 크고 2~4KB, 나머지는 1KB 미만이다
//    (scope 가 openid·없음뿐이라 프로필 필드가 안 온다). 64KB 는 그 16배 이상이라
//    제공자가 필드를 늘려도 안 걸리고, 걸리는 응답은 정상 응답이 아니다.
// ⚠️ Content-Type 은 **일부러 안 본다.** 실제 판정은 JSON.parse 가 하고 그건 속일 수 없다.
//    허용 목록을 두면 제공자가 `text/plain` 으로 바꾸는 날 로그인이 통째로 죽는다 —
//    막는 것은 없고 잃는 것만 있는 검사다(scripts/test-friends.mjs 104 가 이 판단을 잠근다).
const MAX_PROVIDER_BODY = 65536;
const jsonFetch = async (url, init) => {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    if (tooBig(r.headers, MAX_PROVIDER_BODY)) { await r.body?.cancel(); return null; }
    const text = await readCapped(r.body, MAX_PROVIDER_BODY);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};

async function verifyProvider(env, origin, name, code, state) {
  const p = P[name];
  const { id, secret } = creds(env, name);
  const form = new URLSearchParams({
    grant_type: "authorization_code", client_id: id, code, state,
    redirect_uri: redirectUri(env, origin, name),
  });
  if (secret) form.set("client_secret", secret);   // 카카오는 보안 설정을 꺼두면 없어도 된다
  const tr = await jsonFetch(p.token, {
    method: "POST", body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  // 로그에는 **제공자가 준 오류 코드까지만** 남긴다. 응답 본문을 통째로 찍으면 토큰·회원번호가
  // 운영 로그로 새는데, 고치는 데 필요한 건 어느 제공자가 무슨 코드로 거절했나뿐이다.
  // ⚠️ 오류 코드도 **제공자가 쓴 문자열**이다. 길이를 우리가 정하지 않으면 남의 서버가
  //    우리 로그 한 줄의 크기를 정한다 — 고치는 데 필요한 건 앞부분뿐이다.
  const why = (o, ...keys) => String(keys.map((k) => o && o[k]).find(Boolean) || "no-json").slice(0, 80);
  if (!tr || !tr.access_token) {
    console.log("[exchange] token fail", name, why(tr, "error", "error_code"));
    return null;
  }
  const me = await jsonFetch(p.me, { headers: { Authorization: "Bearer " + tr.access_token } });
  const who = me && p.uid(me);
  if (!who) {
    console.log("[exchange] me fail", name, why(me, "error", "message"));
    return null;
  }
  // ⚠️ **여기서 계정을 만들지 않는다.** 예전에는 이 자리가 곧 가입이었다 —
  //    로그인 버튼 한 번이 약관도 연령 확인도 없이 계정을 만들었다.
  //    이제 판별만 하고, 계정을 만들지 말지는 부르는 쪽이 정한다(§5-2).
  //    ⚠️ 이 함수는 로컬 DB 를 안 쓰지만 **되돌릴 수 없다** — 외부 호출 2회가 나갔고
  //       `code` 가 소비됐다. 그래서 검사할 수 있는 것은 전부 이 함수 **앞**에서 한다.
  return { provider: name, subject: String(who) };
}

// ── 우리 안에서 쓰는 계정 번호 ───────────────────────────────────────────
// 전에는 uid 가 **`kakao:1234567`** 그대로였다. 그러면 제공자가 준 회원번호가
//   ① 친구 목록 응답에 실려 나가고 ② `/friends/kakao:1234567` 처럼 주소에 박히고
//   ③ 세션 토큰 앞부분에도 들어가 localStorage 에 남았다.
// 친구 요청을 한 번 주고받은 사람은 상대의 카카오 회원번호를 그대로 알게 된다.
// (예전 주석은 "그 번호는 앱마다 다른 값이라 다른 서비스에서 그 사람을 찾는 데는 못 쓴다"고
//  적었는데, **셋을 하나로 일반화한 것이라 근거가 없다.** 구글 공식 문서는 `sub` 를
//  "unique among all Google Accounts and never reused" 라고만 하고 **클라이언트별로 갈린다고
//  말하지 않는다**. 카카오·네이버는 공식 문서를 직접 확인하지 못했다. 그러므로 여기서는
//  "다른 서비스와 대조할 수 없다"에 기대지 않고, **애초에 밖으로 내보내지 않는 것**만 근거로 삼는다.)
//
// 이제 제공자 번호는 **`users` 행 안에서만** 산다. 밖으로 나가는 건 우리가 만든 무작위 번호다.
//
// ⚠️ **`internalUid()` 는 없앴다**(2026-08-18). 그 함수는 「조회」와 「생성」을 같이 했고,
//    그래서 로그인 경로가 지나가는 것만으로 계정이 생겼다 — 약관도 연령 확인도 없이.
//    남겨 두면 누군가 다시 부른다. 아래 둘로 갈랐다: 조회는 부작용이 없고, 생성은
//    **정책 기록과 같은 트랜잭션**에서만 일어난다.

// 조회만 한다. 없으면 null — **만들지 않는다.**
export async function findUser(env, provider, subject) {
  const r = await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_subject = ?")
    .bind(provider, subject).first();
  return r ? r.id : null;
}

// 계정 + 필수 정책 기록 + 가입 state 소비 표식을 **한 batch** 로 만든다.
//
// D1 의 `batch` 는 하나의 트랜잭션이고 중간 실패는 전체 롤백이다. 그래서 아래 세 가지 중
// 하나라도 실패하면 **셋 다 없다** — 「계정은 생겼는데 약관 기록이 없다」는 상태가 존재할 수 없다.
//
// 문장 순서가 곧 방어다:
//   ⓪ 소비 표식이 **맨 앞**이다. PRIMARY KEY 충돌이면 batch 전체가 롤백되므로 ①②가 실행조차
//      안 된다. 이것이 「같은 가입 state 로 **다른 제공자 계정** 두 개를 만드는」 길을 닫는다 —
//      ①의 UNIQUE(provider, provider_subject) 는 subject 가 다르면 아무것도 막지 못한다.
//   ① 계정은 `DO NOTHING`. 같은 사람이 두 기기에서 동시에 눌러도 진 쪽이 예외로 죽지 않는다.
//   ② 정책 기록은 **내가 실제로 이겼을 때만**(`WHERE EXISTS`) 들어간다 — 중복 기록이 안 생긴다.
//
// ⚠️ `document_version` 과 두 시각은 **전부 서버가 만든다.** 클라이언트가 보낸 해시나 시각을
//    그대로 적는 자리는 어디에도 없다.
export async function createAccountWithPolicy(env, provider, subject, opts) {
  const { stateHash, stateExp, occurredAt, bundle = POLICY_BUNDLE, now = Date.now() } = opts;
  const id = crypto.randomUUID().replace(/-/g, "");
  const stmts = [
    env.DB.prepare("INSERT INTO consumed_signup_states (state_hash, key_version, expires_at) VALUES (?, ?, ?)")
      .bind(stateHash, TOMBSTONE_KEY_VERSION, stateExp),
    env.DB.prepare(
      `INSERT INTO users (id, provider, provider_subject, session_version, created_at)
       VALUES (?, ?, ?, 0, ?) ON CONFLICT (provider, provider_subject) DO NOTHING`)
      .bind(id, provider, subject, now),
  ];
  for (const [kind, action] of requiredPolicyKinds) {
    const doc = bundle.docs[kind];
    // 번들에 없는 종류를 기록하지 않는다. 여기서 막지 않으면 `undefined` 가 해시 자리에 들어간다.
    if (!doc) throw new Error("policy bundle missing kind: " + kind);
    stmts.push(env.DB.prepare(
      `INSERT INTO policy_events (user_id, kind, action, document_version, occurred_at, recorded_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`)
      .bind(id, kind, action, doc.hash, occurredAt, now, id));
  }
  await env.DB.batch(stmts);
  // **DB 에 다시 묻는다.** 내가 넣었는지 동시에 온 다른 요청이 넣었는지 가릴 이유가 없다.
  return await findUser(env, provider, subject);
}

// 이미 계정이 있는 사람이 가입 state 를 들고 왔을 때. 계정도 기록도 만들지 않지만
// **표식은 남긴다** — 같은 state 가 두 번 통하면 안 되는 것은 이 경우에도 같다.
export async function consumeSignupState(env, stateHash, stateExp) {
  await env.DB.prepare("INSERT INTO consumed_signup_states (state_hash, key_version, expires_at) VALUES (?, ?, ?)")
    .bind(stateHash, TOMBSTONE_KEY_VERSION, stateExp).run();
}

// 만료된 표식만 지운다. **만료 전에 지우면 그 순간 replay 창이 다시 열린다.**
// 실패를 삼킨다 — 청소가 안 되는 것과 가입이 안 되는 것은 무게가 다르다.
async function sweepSignupStates(env, now) {
  try {
    await env.DB.prepare("DELETE FROM consumed_signup_states WHERE expires_at < ?").bind(now).run();
  } catch { /* 청소 실패는 가입을 막지 않는다 */ }
}

// ── 단어장 ───────────────────────────────────────────────────────────────
// 단어를 행으로 쪼개지 않는다. 통째로 읽고 통째로 쓰는 게 전부라 조인할 일이 없어서,
// JSON 한 칸이 맞다(쪼개면 저장할 때마다 지우고 다시 넣는 짓을 하게 된다).
async function getBook(env, uid) {
  const r = await env.DB.prepare("SELECT words, nickname, version, updated_at FROM books WHERE user_id = ?")
    .bind(uid).first();
  if (!r) return { words: [], name: "", updated: 0, version: 0 };
  let words = [];
  try { words = JSON.parse(r.words) || []; } catch { /* 깨진 행은 빈 단어장으로 본다 */ }
  return { words, name: r.nickname || "", updated: r.updated_at, version: r.version };
}

// ── 친구 ────────────────────────────────────────────────────────────────
// 게임의 친구 추가와 같다: 링크를 받은 사람이 요청을 보내고, **받은 사람이 수락해야** 이어진다.
// 링크만으로 바로 이어지게 하면 링크가 어디로 퍼졌는지 모르는 채 내 단어장이 남에게 보인다.
//
// **관계 하나 = 행 하나.** 이게 D1 으로 옮긴 이유의 전부다.
// KV 시절엔 두 사람의 `f:` 레코드에 각각 적었고, 첫 쓰기만 성공하면 반쪽이 남았다 —
// 그 반쪽에서 남의 단어장이 열리지 않게 막는 코드(양쪽 확인)가 따로 필요했다.
// 행이 하나면 **반쪽이라는 상태가 존재하지 않아서** 그 방어가 필요 없어진다.
//
// 상한은 그대로 50. 이유는 바뀌었다 — 이제 목록이 쿼리 하나라 느려지지 않지만,
// 초대 코드가 샜을 때 목록이 무한히 자라는 것 자체가 증상이라 상한은 남긴다.
const MAX_FRIENDS = 50;

// 두 사람의 쌍 이름. **정렬해서** 이어 붙이므로 A→B 와 B→A 가 같은 값이 된다 —
// 이 값에 UNIQUE 가 걸려 있어서 "두 사람 사이에 관계 하나"가 DB 규칙이 된다(schema.sql).
const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

// 내 목록. **쿼리 하나**로 세 갈래(수락됨·받은 요청·보낸 요청)를 다 만든다.
// 예전엔 친구 수만큼 KV 를 읽었다(brief 를 사람마다 불렀다).
// 상대 별명·단어는 books 를 LEFT JOIN 해서 같이 가져온다 — 없는 사람도 목록에 나와야 하므로 LEFT.
async function friendRows(env, uid) {
  const { results } = await env.DB.prepare(
    `SELECT f.requester_id AS req, f.addressee_id AS adr, f.status AS status,
            b.nickname AS name, b.words AS words
       FROM friendships f
       LEFT JOIN books b
         ON b.user_id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id = ?1 OR f.addressee_id = ?1`).bind(uid).all();
  return results || [];
}

// 목록 한 줄로 바꾼다. **단어 목록은 안 준다** — 목록 화면엔 안 쓰는데 통째로 실려 나간다.
// 개수(count)는 **수락된 친구에게만**. 아직 요청 단계인 사이는 서로 남이라 별명 말고 알려 줄 게 없다
// (개인정보처리방침이 "친구에게 보이는 것"으로만 적혀 있다 — 문서에 없는 걸 보내면 문서가 거짓말이 된다).
function briefRow(row, uid, withCount) {
  const other = row.req === uid ? row.adr : row.req;
  const out = { uid: other, name: row.name || "" };
  if (withCount) {
    let n = 0;
    try { n = (JSON.parse(row.words || "[]") || []).length; } catch { /* 깨진 행은 0 */ }
    out.count = n;
  }
  return out;
}

const newCode = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12); // 48비트 — 찍어서 못 맞힌다
// 지금 살아 있는 코드. 사람당 하나라는 것은 **DB 가 강제한다**(0004 의 부분 유니크 인덱스).
const liveCode = (env, uid) => env.DB.prepare(
  "SELECT code FROM invite_codes WHERE user_id = ? AND revoked_at IS NULL").bind(uid).first();

// 내 초대 코드. 없으면 만들어 둔다 — 같은 사람에게 늘 같은 링크가 나가야
// 예전에 보낸 링크가 죽지 않는다. 회전(`POST /friends/code`)은 옛 행에 revoked_at 을 적는다.
//
// ⚠️ **읽고 나서 쓰는 사이가 열려 있었다.** 두 탭이 동시에 친구 화면을 열면 둘 다 "없다"를
//    읽고 각자 만들었고, 나중 것이 앞 것을 폐기하므로 **먼저 응답을 받은 탭은 이미 죽은 코드를
//    손에 쥐었다** — 그 링크를 받은 사람은 「만료됐거나 잘못됐어요」만 본다.
//    이제 그 경합은 UNIQUE 충돌이 되고, 충돌은 곧 "누가 이미 만들었다"는 신호다.
//    진 쪽은 이긴 쪽의 코드를 그대로 쓴다 — internalUid 가 첫 로그인 경합에 쓰는 것과 같은 무늬다.
async function myCode(env, uid) {
  const had = await liveCode(env, uid);
  if (had) return had.code;
  await env.DB.prepare(
    "INSERT INTO invite_codes (code, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(newCode(), uid, Date.now()).run();
  // **DB 에 다시 묻는다.** 내가 넣었는지 남이 넣었는지 가릴 이유가 없다 — 답은 하나뿐이다.
  return (await liveCode(env, uid)).code;
}

async function rotateCode(env, uid) {
  const now = Date.now();
  await env.DB.batch([
    // ⚠️ **지난 회전의 찌꺼기를 여기서 치운다.** 폐기 행을 지우는 자리가 어디에도 없어서
    //    회전할 때마다 영구히 쌓였다(실측: 분당 120행까지). 폐기된 코드로 할 수 있는 일은
    //    아무것도 없다 — 조회가 전부 `revoked_at IS NULL` 이라 있으나 없으나 404 다.
    env.DB.prepare("DELETE FROM invite_codes WHERE user_id = ? AND revoked_at IS NOT NULL").bind(uid),
    env.DB.prepare("UPDATE invite_codes SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(now, uid),
    env.DB.prepare("INSERT INTO invite_codes (code, user_id, created_at) VALUES (?, ?, ?)")
      .bind(newCode(), uid, now),
  ]);
  // ⚠️ **내가 만든 코드가 아니라 지금 살아 있는 코드를 돌려준다.** 두 기기에서 동시에 회전을
  //    누르면 나중 문장이 앞 문장의 코드를 폐기하는데, 그때 각자 자기 코드를 답하면
  //    한쪽은 죽은 코드를 localStorage 에 적고 그 링크를 남에게 보낸다.
  //    (js/friends.js 의 버튼 잠금은 한 탭 안에서만 듣는다 — 두 기기는 못 막는다.)
  return (await liveCode(env, uid)).code;
}

// ── 마스터 계정 ──────────────────────────────────────────────────────────
// 만든 사람의 계정은 무료 벽에 걸리지 않는다. **어느 기기에서 로그인해도** 그래야 하므로
// 브라우저(localStorage)가 아니라 서버가 정한다 — 폰을 바꾸면 로컬 표시는 그냥 사라진다.
//
// 목록은 `wrangler pages secret put MASTER_UIDS` 로 넣는다(쉼표 구분).
// **wrangler.jsonc 에 적지 않는다** — 그 파일은 공개 레포에 올라간다.
// 비어 있으면 아무도 마스터가 아니다(기본값이 안전한 쪽).
//
// ⚠️ 값이 **내부 uid** 로 바뀌었다(예전엔 `kakao:1234567`). 옛 값을 그대로 두면 아무도 마스터가
//    아닌 상태로 조용히 바뀐다. 내 uid 를 찾는 법:
//    `npx wrangler d1 execute shhh-db --remote --command "SELECT id, created_at FROM users"`
const isMaster = (env, uid) =>
  String(env.MASTER_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(uid);

// 상대 한 사람의 최소 정보(요청을 보낸 직후 등, 목록 조회 없이 한 명만 필요할 때).
async function briefOne(env, other, withCount) {
  const b = await getBook(env, other);
  const out = { uid: other, name: b.name };
  if (withCount) out.count = b.words.length;
  return out;
}

// ── 유지보수 게이트 ──────────────────────────────────────────────────────
// **허용 목록으로 판정한다.** 차단 목록으로 만들면 새 라우트의 기본값이 「통과」가 되어
// 다음 사고가 예약된다(scripts/build.mjs 의 allowlist 와 같은 판단).
//
// 상태가 셋인 이유는 **읽기와 쓰기를 따로 막아야 하기 때문**이다. 주 D1 을 과거로 되돌리면
// 탈퇴한 사람의 `users`·`sessions`·`books`·`friendships` 가 전부 되살아나고, 재삭제가 끝나기
// 전까지 그 사람은 **살아 있는 계정**이다. 그러면 되살아난 세션으로 로그인 상태가 부활하고
// `GET /book` 이 지웠던 단어장을 그대로 돌려준다 — **쓰기를 막는 것만으로는 하나도 못 막는다.**
//
//   maintenance     DB 를 **쓰는** 라우트 전부 차단. 읽기는 허용
//   restore_closed  **넷만 허용**: /health · /ready · /policies · (정적 정책 파일은 Worker 를 안 지난다)
//
// ⚠️ `GET /friends` 가 `maintenance` 에서도 차단인 이유: 목록 조회가 초대 코드가 없으면
//    **그 자리에서 만든다**(myCode). GET 이라고 읽기인 것이 아니다.
const MAINT_READS = [
  [/^\/book$/, "GET"], [/^\/me$/, "GET"], [/^\/friends\/[^/]+\/book$/, "GET"],
];
const ALWAYS_OPEN = [/^\/health$/, /^\/ready$/, /^\/policies$/];

export function maintenanceAllows(mode, path, method) {
  if (mode === "open") return true;
  if (ALWAYS_OPEN.some((re) => re.test(path))) return true;
  if (mode === "restore_closed") return false;             // 허용 목록은 위 셋뿐이다
  return MAINT_READS.some(([re, m]) => m === method && re.test(path));
}

// 로그에 남길 경로. **id 자리를 지운다.** `/friends/<uid>` 를 그대로 찍으면 운영 로그가
// "누가 누구와 친구인가"의 기록이 된다 — 우리가 안 받기로 한 정보를 로그가 대신 모으는 꼴이다.
// export 하는 이유는 테스트가 이 규칙을 직접 재기 위해서다.
export const pathTemplate = (p) =>
  p.replace(/^\/api/, "").replace(/^\/friends\/(?!code$)[^/]+/, "/friends/:id");

// 임차증을 **따지 않는** 경로. 여기 넣는 근거는 셋을 다 만족해야 한다:
//   ① 사용자 데이터를 읽지도 쓰지도 않는다(행 내용을 만지지 않는다)
//   ② 복원 중에도 답해야 한다 — 운영자가 상태를 볼 수단이 이것뿐이다
//   ③ 읽기 전용이라 복원본을 오염시킬 수 없다
//
//   /health    설정이 있나 없나만. DB 를 아예 안 본다
//   /ready     `COUNT(*)` 집계만 본다. **행 내용을 읽지 않는다.** 여기서 임차증을 따면
//              `restore_closed` 에서 획득이 거부돼 운영자가 상태를 못 보게 된다
//   /policies  우리가 빌드에 박은 상수. DB 를 안 본다
//
// ⚠️ `rate_limits` 는 사용자 데이터가 아니라 **운영 메타데이터**지만 제외 목록에 넣지 않았다.
//    `limited()` 는 위 셋 말고는 모든 경로에서 불리므로, 임차증을 게이트 **바로 뒤**에 두면
//    자동으로 함께 추적된다. 굳이 빼서 「추적 안 되는 쓰기」를 하나 만들 이유가 없다.
const LEASE_FREE = [/^\/health$/, /^\/ready$/, /^\/policies$/];

export default {
  // 전역 예외 그물. 아래 어디서 던져도 제공자 응답·스택이 사용자에게 새지 않고 500 한 줄로 끝난다.
  //
  // **요청 임차증의 수명이 여기 있다**(결정 A′, 2026-08-18). 라우트 안이 아니라 여기인 이유:
  // 라우트에는 `return` 이 수십 개고, 그중 하나라도 해제를 빠뜨리면 활성 수가 영원히 0 이 안 된다.
  // 가장 바깥 `finally` 하나면 던져서 나가든 일찍 돌아가든 반드시 지나간다.
  async fetch(req, env) {
    const url = new URL(req.url);
    // Pages Functions 아래에선 주소가 `/api/book` 으로 온다. **접두어만 여기서 벗기고**
    // 라우트 문자열은 `/book` 그대로 둔다 — scripts/test-friends.mjs 가 그 이름으로 부른다.
    const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, req) });

    // ── 0-1. 유지보수 게이트 ──
    // **`limited()` 보다 먼저** 온다. 뒤에 두면 리미터가 rate_limits 에 쓴다.
    // **세션 인증(`whoAmI`)보다도 먼저** 온다 — `restore_closed` 에서 인증을 한 번이라도
    // 시도하면 되살아난 `sessions` 행을 조회하게 되고, 그 결과가 타이밍·오류로 새어 나간다.
    // ⚠️ ledger 질의가 **실패하면 막는다.** 그건 「열려 있다」가 아니라 「모른다」이고,
    //    모를 때 게이트를 여는 것은 게이트가 없는 것과 같다.
    let gate;
    try {
      gate = await readMode(env);
    } catch {
      return json(env, req, { error: "잠시 점검 중이에요", mode: "unknown" }, 503,
        { "Retry-After": "60" });
    }
    if (!maintenanceAllows(gate.mode, path, req.method)) {
      // 무엇을·왜 복원하는지는 말하지 않는다. 「지금 안 된다」와 「언제 다시 와라」만 말한다.
      return json(env, req, { error: "잠시 점검 중이에요. 조금 뒤에 다시 열어주세요", mode: gate.mode },
        503, { "Retry-After": "60" });
    }

    // ── 0-1-1. 요청 임차증 ──
    // 세션 인증보다 **먼저** 딴다. 인증이 먼저 지나가면 `sessions`·`users` 조회가 추적 밖이다.
    // ledger 바인딩이 없으면 딸 수 없다 — 그때는 `/api/ready` 가 `ledger:false` 로 시끄럽게 말하고,
    // 복원은 어차피 금지다(`restoreGate`). 없는 것을 있는 척하지 않는다.
    let lease = null;
    if (env.LEDGER && !LEASE_FREE.some((re) => re.test(path))) {
      try {
        lease = await acquireLease(env);
      } catch {
        return json(env, req, { error: "잠시 점검 중이에요", mode: "unknown" }, 503,
          { "Retry-After": "60" });
      }
      if (!lease)
        return json(env, req, { error: "잠시 점검 중이에요. 조금 뒤에 다시 열어주세요", mode: gate.mode },
          503, { "Retry-After": "60" });
    }

    try {
      return await route(req, env, { url, path, gate, lease });
    } catch (e) {
      // ⚠️ **경로를 그대로 찍지 않는다.** `/friends/<uid>` 에는 계정 id 가 들어 있어서
      //    운영 로그가 곧 "누가 누구와 친구인가"의 기록이 된다. 고치는 데 필요한 건 어느 **종류**의
      //    요청이 죽었나뿐이라 id 자리를 `:id` 로 바꿔 찍는다. 예외 메시지도 200자에서 자른다
      //    (제공자 응답이 통째로 실려 오는 경우가 있다).
      console.log("[error]", pathTemplate(new URL(req.url).pathname), String(e && e.message).slice(0, 200));
      return json(env, req, { error: "잠시 문제가 생겼어요" }, 500);
    } finally {
      // ⚠️ **여기가 유일한 해제 자리다.** 해제에 실패해도 삼킨다 — 사용자 응답을 바꿀 이유가 없고,
      //    남은 행은 만료 뒤 `stale` 로 세어져 **복원을 계속 막는다**(그게 맞는 실패 방향이다).
      if (lease) { try { await releaseLease(env, lease); } catch { /* stale 로 남아 복원을 막는다 */ } }
    }
  },
};

async function route(req, env, rc) {
    const { url, path, gate, lease } = rc;

    // ── 0. 살아있나 · 설정이 됐나 ──
    // /health 는 **늘 200** 이다(프로세스가 도나). /ready 는 설정이 덜 됐으면 503 이다 —
    // 배포 뒤 "로그인이 503" 을 사용자가 눌러 보고서야 알게 되는 걸 막는 자리다.
    // 앱은 /health 의 providers 로 **설정 안 된 제공자의 버튼을 아예 안 그린다.**
    // ⚠️ 값도, 비밀값 이름도 내보내지 않는다. 있나 없나만.
    // 앱이 이 응답으로 **실제로 되는 버튼만** 그린다. 값도, 비밀값 이름도 나가지 않는다.
    if (path === "/health") return json(env, req, health(env));
    if (path === "/ready") {
      const h = health(env);
      // ⚠️ **설정이 덜 됐어도 DB 는 실제로 물어본다.** 전에는 `h.ready &&` 로 건너뛰어서,
      //    OAuth 비밀값이 없는 지금 같은 상태에서 `db:false` 가 나왔다 — 그런데 그 false 는
      //    "DB 가 죽었다"가 아니라 "안 물어봤다"였다. 두 가지를 한 값으로 말하면, 진짜로 DB 가
      //    죽은 날에도 화면이 똑같아서 **아무도 알아채지 못한다.**
      //    이제 바인딩이 있으면 OAuth 설정과 무관하게 스키마까지 확인한다(dbAnswers).
      //    ⚠️ 오류 문자열·테이블 이름·SQL 은 응답에 싣지 않는다 — 참/거짓만 나간다.
      const db = await dbAnswers(env);
      // ⚠️ **ledger 도 같은 이유로 실제 질의한다.** 게이트(`readMode`)가 통과하는 것은
      //    `maintenance` 한 표뿐이라, 나머지 표가 없어도 게이트는 멀쩡히 답한다 —
      //    그 상태로 배포하면 **첫 계정 삭제에서만** 터진다. `db` 와 같은 규칙이다:
      //    바인딩이 없는 것과 스키마가 없는 것을 한 값으로 말한다(둘 다 「못 쓴다」이고,
      //    무엇이 없는지는 응답이 아니라 runbook 이 답한다 — 표 이름을 내보내지 않는다).
      const ledger = await ledgerAnswers(env);
      // configReady = 설정이 갖춰졌나(비밀값·주소·바인딩·제공자). db = DB 가 실제로 답하나.
      // 둘을 갈라 두면 배포 뒤 "무엇이 덜 됐나"를 한 번에 읽을 수 있다.
      // ⚠️ **한 값이 여러 가지를 말하면 진짜 장애를 아무도 못 알아챈다.** 그래서 이유별로 가른다:
      //    configReady 설정이 갖춰졌나 · db 주 D1 이 답하나 · ledger 삭제 표식 저장소가 붙었나
      //    · mode 유지보수 상태 · cleanupStale 정리 크론이 제 시간에 돌고 있나
      const cl = await cleanupState(env).catch(() => null);
      // 마지막 성공이 **주기의 2배**보다 오래됐으면 낡은 것으로 본다. 조용히 멈춘 크론은
      // 없는 크론보다 나쁘다 — 있다고 믿게 만들기 때문이다.
      const cleanupStale = !!env.LEDGER && (!cl || !cl.last_ok_at || Date.now() - cl.last_ok_at > 2 * 3600e3);
      // ⚠️ **`cleanupStale` 은 `ready` 를 내리지 않는다.** 정리가 밀린 것은 보유기간 문제이지
      //    사용자가 앱을 못 쓰는 상태가 아니다 — 크론 하나가 멈췄다고 사이트를 503 으로 내리면
      //    고치려던 것보다 큰 고장을 만든다(리미터를 fail-open 으로 둔 것과 같은 판단).
      //    대신 **응답에는 반드시 실린다** — 조용히 멈춘 크론은 없는 크론보다 나쁘고,
      //    배포 후 smoke test 와 출시 체크리스트가 이 값을 직접 본다.
      const r = {
        ok: true, mode: gate.mode, configReady: h.ready, db, ledger,
        signupReady: h.signupReady, providers: h.providers, cleanupStale,
        ready: h.ready && db && ledger && gate.mode === "open",
      };
      return json(env, req, r, r.ready ? 200 : 503);
    }

    // ── 0-2. 지금 쓰이는 정책 문서 ──
    // **경로와 해시만** 준다. 내용은 정적 파일로 따로 받는다 — 그래야 화면이 자기가 렌더할
    // 바이트를 직접 해시해 대조할 수 있다(옛 서비스워커 캐시가 남아 있어도 걸린다).
    // 로그인 없이 부를 수 있다. 사용자를 가리키는 값이 요청에도 응답에도 실리지 않는다.
    if (path === "/policies") return json(env, req, policyBundle());

    // ── 0-3. 회원가입 시작 ──
    // **GET 링크로 대신하지 않는다.** `/login/kakao?pv=…` 같은 모양이면 남이 보낸 링크 하나가
    // 약관 수락과 연령 진술을 만들어낸다 — 사용자는 가입 화면을 본 적이 없는데 기록에는
    // "수락함"이 남는다. POST 는 아래 Origin 검사에 자동으로 걸린다.
    if (path === "/signup/start") {
      if (req.method !== "POST") return json(env, req, { error: "안 되는 요청이에요" }, 405);
      // Origin 검사. 상태 변경 검사는 아래(3번)에 있지만 그건 세션을 읽은 뒤라 여기까지 안 온다.
      const o = req.headers.get("Origin");
      if (!o || !allowed(env, o)) return json(env, req, { error: "허용되지 않은 요청이에요" }, 403);
      // 전용 버킷. `write` 와 이중으로 세지 않는다 — WRITE_ROUTES 에 `/signup` 이 없다.
      if (await limited(env, req, null, "signup")) return tooMany(env, req);
      const body = await readBody(req);          // Content-Type 이 JSON 이 아니면 null 이다
      const provider = body && typeof body.provider === "string" ? body.provider : "";
      if (!isProvider(provider)) return json(env, req, { error: "그런 로그인 방식이 없어요" }, 400);
      const { id } = creds(env, provider);
      // 설정이 덜 된 채로 조용히 돌지 않는다. 셋 다 없으면 가입 자체를 열지 않는다.
      if (!id || !env.SIGNUP_STATE_KEY || !env.TOMBSTONE_KEY)
        return json(env, req, { error: "회원가입이 아직 준비되지 않았어요" }, 503);
      // ⚠️ **`true` 만 받는다.** 없거나 `false` 거나 `"true"` 문자열이면 거부다 —
      //    「값이 있으면 통과」로 만들면 `age14: 0` 같은 값이 지나간다.
      if (body.terms !== true || body.age14 !== true)
        return json(env, req, { error: "필수 항목을 확인해 주세요", needed: ["terms", "age14"] }, 400);
      // 화면이 본 문서와 우리가 기록할 문서가 같은가. 다르면 **여기서** 끝난다 —
      // 제공자까지 갔다가 콜백에서 막으면 사용자가 헛걸음을 한다.
      if (body.pv !== POLICY_BUNDLE.pv)
        return json(env, req, { error: "약관이 새로 바뀌었어요. 앱을 새로고침해 주세요",
                                policyStale: true, pv: POLICY_BUNDLE.pv }, 409);
      const back = typeof body.back === "string" && body.back ? body.back : env.APP_ORIGIN;
      let backOrigin = null;
      try { backOrigin = new URL(back).origin; } catch { /* 아래에서 400 */ }
      if (!allowed(env, backOrigin)) return json(env, req, { error: "허용되지 않은 주소예요" }, 400);
      // 행위 시각. **서버가 찍는다** — 클라이언트가 보낸 시각을 쓰면 그 값이 곧 위조 가능한 증거가 된다.
      const occurredAt = Date.now();
      const txn = mkToken();
      let state;
      try {
        state = await makeSignupState(env, provider, {
          back, pv: POLICY_BUNDLE.pv, occurredAt, terms: true, age14: true,
          n: String(body.n || "").slice(0, 64), txn: await sha256(txn),
        });
      } catch {
        // 키 설정 문제. **사유를 밖으로 말하지 않는다.**
        return json(env, req, { error: "회원가입이 아직 준비되지 않았어요" }, 503);
      }
      const q = new URLSearchParams({
        response_type: "code", client_id: id,
        redirect_uri: redirectUri(env, url.origin, provider), state,
      });
      if (P[provider].scope) q.set("scope", P[provider].scope);
      const r = json(env, req, { url: P[provider].auth + "?" + q });
      r.headers.append("Set-Cookie", setTxn(txn));
      return r;
    }

    // ⚠️ 여기 있던 공통 `auth` 버킷을 지웠다. `/login`·`/cb`·`/exchange` 는 **각자 `login` 버킷으로**
    //    이미 세고 있어서, 이 줄은 같은 요청을 한 번 더 세는 일만 했다(요청 하나당 D1 쓰기 두 번).
    //    게다가 `auth` 는 RL_MAX 에 없어서 write 기본값 120 이 적용됐다 — login 한도 10 보다
    //    훨씬 느슨해 **한 번도 먼저 막은 적이 없다.** 막지도 못하면서 쓰기만 두 배였다.

    // ── 1. 로그인 시작 ── /login/kakao?return=<앱 주소>
    let m = path.match(/^\/login\/(\w+)$/);
    if (m && isProvider(m[1])) {
      const p = P[m[1]];
      const { id } = creds(env, m[1]);
      // 설정이 덜 된 채로 **조용히 돌지 않는다.** STATE_KEY 가 없으면 state 서명이 아무나
      // 만들 수 있는 값이 되므로 로그인 자체를 열지 않는다(sign 이 던지는 것의 앞단 방어).
      if (!id || !env.STATE_KEY) return new Response(m[1] + " 로그인이 아직 설정되지 않았어요", { status: 503 });
      // ⚠️ **여기서는 세지 않는다.** 예전엔 `/cb`·`/exchange` 와 같은 `login` 버킷으로 셌는데,
      //    한 번의 로그인이 두 자리를 지나므로 **한도 10 이 실제로는 완전한 로그인 5회**였다
      //    (실측). 공유 IP(회사·학교·모바일 CGNAT)에서는 그 5회를 건물 하나가 나눠 쓴다.
      //    막으려는 것은 "세션을 무한히 찍어내는 것"인데 이 자리는 세션도, DB 행도 만들지
      //    않는다 — 302 하나와 서명 하나다. 세면 D1 쓰기만 두 배가 되고 막는 것은 없다.
      //    상한은 실제로 세션이 생기는 `/cb`·`/exchange` 가 든다.
      // state 는 CSRF 방어다. 돌아갈 주소를 **서명 안에** 넣는 이유도 같다 — 서명 없이 쿼리로
      // 실어 보내면 남이 우리 도메인을 거쳐 아무 데로나 리다이렉트시킬 수 있다.
      const back = url.searchParams.get("return") || env.APP_ORIGIN;
      // 아무 문자열이나 올 수 있는 자리다. new URL 이 던지면 그대로 500 이 나가므로 여기서 받는다.
      // 파싱이 안 되는 것도 "허용되지 않은 주소"다 — allowed(null) 은 어차피 거짓이다.
      let backOrigin = null;
      try { backOrigin = new URL(back).origin; } catch { /* 주소가 아니면 아래에서 400 */ }
      if (!allowed(env, backOrigin)) return new Response("허용되지 않은 주소예요", { status: 400 });
      // 어느 제공자로 시작한 state 인지 같이 서명한다 — 남의 제공자 자리에서 재사용하지 못하게.
      // n 은 브라우저가 만든 값이다. 그대로 돌려주기만 하고 서버는 뜻을 모른다 — 판정은 앱이 한다.
      // txn 은 **서버가 만들어 이 브라우저에만 심는 표**다. state 에는 해시만 실린다(위 「로그인 왕복 표」).
      const txn = mkToken();
      const state = await makeState(env, m[1], back, (url.searchParams.get("n") || "").slice(0, 64), await sha256(txn));
      const q = new URLSearchParams({
        response_type: "code", client_id: id, redirect_uri: redirectUri(env, url.origin, m[1]), state,
      });
      if (p.scope) q.set("scope", p.scope);
      const r = redir(p.auth + "?" + q);
      r.headers.append("Set-Cookie", setTxn(txn));
      return r;
    }

    // ── 2a·2b. 돌아오는 자리 ──
    //   /exchange/:provider  앱이 code 를 넘겨 준다(네이버). JSON 으로 답한다
    //   /cb/:provider        제공자가 우리에게 직접 돌려보낸다(카카오·구글). 302 로 답한다
    //
    // **두 갈래가 같은 판정을 쓴다.** 흐름이 갈려도 「누가 왔나·계정을 만들 자격이 있나」는
    // 한 곳이어야 한쪽만 고치는 실수가 안 난다. 아래 finishAuth() 가 그 한 곳이다.
    //
    // ⚠️ 검사 순서가 곧 방어다. **외부 호출(code 교환) 앞에서 할 수 있는 것은 전부 앞에서 한다** —
    //    한도 · state 복호화/서명 · 제공자 일치 · 브라우저 결속(shh_t) · 정책 번들 일치 · 키 설정.
    //    뒤로 미루면 위조 state 하나가 제공자 호출 두 번을 유발하고, `code` 는 되돌릴 수 없다.
    {
      const mx = path.match(/^\/(exchange|cb)\/(\w+)$/);
      if (mx && isProvider(mx[2])) {
        const viaApp = mx[1] === "exchange", name = mx[2];
        // 응답 모양이 갈린다. /exchange 는 앱이 fetch 하므로 JSON, /cb 는 브라우저가 직접
        // 도착하므로 사람이 읽는 글이거나 리다이렉트다.
        const fail = (msg, status, hash) => {
          const r = viaApp ? json(env, req, { error: msg }, status)
                           : (hash ? redir(hash) : new Response(msg, { status, headers: { ...SEC } }));
          r.headers.append("Set-Cookie", clearTxn());
          return r;
        };
        // 세션을 찍어내는 자리다. GET 이라 아래 write 계수에 안 걸리므로 여기서 직접 센다.
        if (await limited(env, req, null, "login")) return tooMany(env, req);

        const raw = url.searchParams.get("state");
        // 가입 state 는 `v1.` 로 시작한다. 로그인 state 는 b64u(JSON 배열)이라 그렇게 시작할 수
        // 없다 — 두 형식을 **접두사 하나로** 가른다(scripts/test-signup.mjs 가 이 성질을 잠근다).
        const isSignup = typeof raw === "string" && raw.startsWith("v1.");
        const st = isSignup ? await takeSignupState(env, raw, name) : await takeState(env, raw);
        if (!st || (!isSignup && st.provider !== name))
          return fail("로그인 요청이 만료됐어요. 다시 눌러 주세요.", 400);
        // **표를 먼저 본다.** 공격자가 자기 code/state 링크를 남에게 보내도 여기서 끝난다 —
        // 그 사람 브라우저에는 우리가 심은 표가 없다. code 교환·세션 생성 **이전**이라
        // 실패해도 남는 것이 없다(제공자 호출도 안 나간다).
        if (!(await bound(env, req, st)))
          return fail("이 기기에서 시작한 로그인이 아니에요. 앱에서 다시 로그인해 주세요.", 400);
        // 복귀 주소는 서명·암호문 안에 있지만 **리다이렉트 목적지**라 한 번 더 본다 —
        // allowed 가 좁아진 직후 옛 state 가 돌아오는 경우가 여기서 걸린다.
        let backOrigin = null;
        try { backOrigin = new URL(st.back).origin; } catch { /* 아래에서 400 */ }
        if (!allowed(env, backOrigin)) return fail("허용되지 않은 주소예요", 400);

        if (isSignup) {
          // 화면이 본 문서와 우리가 기록할 문서가 다르면 **기록하지 않는다.**
          if (st.pv !== POLICY_BUNDLE.pv)
            return viaApp
              ? json(env, req, { error: "약관이 새로 바뀌었어요. 다시 가입해 주세요", policyStale: true }, 409)
              : fail(null, 302, st.back + "#login=stale");
          if (!env.TOMBSTONE_KEY) return fail("회원가입이 아직 준비되지 않았어요", 503);
        }

        const code = url.searchParams.get("code");
        if (!code) {
          if (!viaApp) console.log("[cb] no code", name, url.searchParams.get("error"));
          return viaApp ? fail("취소됐어요", 400) : fail(null, 302, st.back + "#login=denied");
        }

        // ── 여기서부터는 되돌릴 수 없다 — 외부 호출 2회가 나가고 code 가 소비된다 ──
        const who = await verifyProvider(env, url.origin, name, code, raw);
        if (!who) return viaApp ? fail("로그인에 실패했어요", 502) : fail(null, 302, st.back + "#login=fail");

        const existing = await findUser(env, name, who.subject);
        let uid = existing;
        if (!existing && !isSignup) {
          // **로그인 경로는 계정을 만들지 않는다.** 이것이 이번 단계의 핵심 변경이다 —
          // 예전에는 이 자리가 곧 가입이었고, 버튼 한 번이 약관도 연령 확인도 없이 계정을 만들었다.
          return viaApp
            ? json(env, req, { error: "아직 가입하지 않으셨어요", signupRequired: true }, 404)
            : fail(null, 302, st.back + "#login=signup_required");
        }
        if (isSignup) {
          // 소비 표식은 **제공자 검증이 끝난 뒤에만** 쓴다 — 위조 state 반복만으로 DB 쓰기가
          // 일어나지 않게(2026-08-11 에 없앤 「인증 없는 자리의 쓰기」를 되살리지 않는다).
          let hash;
          try { hash = await stateTombstone(env, raw); }
          catch { return fail("회원가입이 아직 준비되지 않았어요", 503); }
          try {
            // 이미 계정이 있으면 표식만 남기고, 없으면 표식·계정·정책 기록을 **한 batch** 로.
            uid = existing
              ? (await consumeSignupState(env, hash, st.exp), existing)
              : await createAccountWithPolicy(env, name, who.subject,
                  { stateHash: hash, stateExp: st.exp, occurredAt: st.occurredAt });
          } catch {
            // PRIMARY KEY 충돌 = 이 state 는 이미 쓰였다. batch 전체가 롤백됐으므로
            // 계정도 정책 기록도 **하나도 안 생겼다**. fallback 으로 통과시키지 않는다.
            return viaApp
              ? json(env, req, { error: "이미 처리된 가입 요청이에요. 다시 시작해 주세요", stateUsed: true }, 409)
              : fail(null, 302, st.back + "#login=used");
          }
          if (!uid) return viaApp ? fail("가입에 실패했어요", 500) : fail(null, 302, st.back + "#login=fail");
          await sweepSignupStates(env, Date.now());
        }

        // 세션은 **batch 가 성공한 뒤에만** 만든다.
        const token = await newSession(env, uid);
        // 토큰을 **주소에도 본문에도 싣지 않는다.** 쿠키로 심는다 — 앱이 손에 쥐지 않으면
        // 「남에게 보낼 수 있는 로그인 링크」라는 것 자체가 만들어지지 않는다.
        const okRes = viaApp
          ? json(env, req, { ok: true, n: st.nonce || st.n || "", signedUp: isSignup && !existing })
          : redir(st.back + "#login=ok&via=" + name + "&n=" + encodeURIComponent(st.nonce || st.n || "")
                  + (isSignup && !existing ? "&new=1" : ""));
        okRes.headers.append("Set-Cookie", setCookie(token));
        okRes.headers.append("Set-Cookie", clearTxn());   // 표는 한 번 쓰고 버린다
        return okRes;
      }
    }

    // ⚠️ `/master?code=…` 는 **지웠다**(2026-08-08). 로그인 없이 브라우저를 마스터로 만드는
    //    코드였는데, 링크가 새면 받은 사람도 마스터가 된다 — 마스터는 **만든 사람 계정 하나**여야 한다.
    //    로그인 안 한 상태에서 벽에 걸리는 건 감수한다(앱 출시 기준에선 로그인이 기본이다).
    //    되살릴 일이 생기면 커밋 1b68a90 에 있다. 시크릿 MASTER_CODE 도 같이 지웠다.

    // ── 3. 누구인가 ──
    // 토큰은 **쿠키에서만** 온다. Authorization 헤더는 더 이상 안 받는다 — 두 길을 다 열어 두면
    // 잠금은 약한 쪽을 따르고, 앱이 토큰을 손에 쥐는 길(localStorage)이 살아남는다.
    // 토큰 자체는 아무 정보도 안 담는다(완전 무작위). 누구인지는 sessions 행이 말한다.
    const token = readCookie(req);
    const uid = await whoAmI(env, token);

    // ── CSRF ──
    // 쿠키는 **브라우저가 알아서 붙인다.** 그래서 남의 사이트가 우리에게 보내는 요청에도 실린다 —
    // Bearer 헤더 시절엔 원천적으로 불가능하던 공격면이 쿠키로 옮기면서 새로 열린다.
    // SameSite=Lax 가 대부분 막지만 그건 브라우저의 선의라, 서버도 직접 본다.
    // 읽기(GET)는 안 본다: 낯선 Origin 에는 CORS 를 안 열어 줘서 응답을 읽지 못한다.
    if (req.method !== "GET" && req.method !== "OPTIONS") {
      const o = req.headers.get("Origin");
      // ⚠️ **없는 것도 막는다.** 예전엔 "Origin 이 없으면 브라우저가 아니라서 CSRF 가 성립하지
      //    않는다"고 통과시켰다. 성립하지 않는다는 것 자체는 맞지만, 그 판단은 **브라우저가
      //    반드시 Origin 을 붙인다**는 전제에 기대고 있었다. 우리 앱의 상태 변경은 전부
      //    같은 origin 의 fetch 이고 브라우저는 GET·HEAD 가 아닌 요청에 Origin 을 **항상**
      //    붙이므로, 없다는 건 우리 앱이 보낸 것이 아니라는 뜻이다. 통과시켜서 얻는 것은
      //    curl 편의뿐이고, 잃는 것은 "허용 목록을 지나지 않는 상태 변경 경로"의 존재다.
      if (!o || !allowed(env, o)) return json(env, req, { error: "허용되지 않은 요청이에요" }, 403);
    }

    // ② 상태를 바꾸는 요청. 읽기는 세지 않는다 — 남용해도 남는 게 없고, 세면 정상 사용이
    //    먼저 걸린다. 로그인한 사람은 uid 로, 아니면 IP 로 센다.
    //    **초대 코드로 요청을 보내는 자리는 따로 더 좁게 센다**(아래 POST /friends) —
    //    거기가 유일하게 남의 것을 맞혀 볼 수 있는 자리다.
    //    ⚠️ **실제로 있는 라우트에만 건다.** 전에는 인증만 통과하면 어느 경로든 셌다 —
    //       `/이런건없다` 로 POST 를 퍼부으면 404 를 받으면서 D1 쓰기를 유발할 수 있었다.
    //       리미터가 자원을 쓰는 이상, 리미터를 부를지 말지도 방어의 일부다.
    if (req.method !== "GET" && WRITE_ROUTES.test(path) && (await limited(env, req, uid, "write")))
      return tooMany(env, req);

    // 로그아웃 — 이 계정의 로그인을 **전부** 끊는다(세대를 올린다). 쿠키도 그 자리에서 지운다.
    if (path === "/session" && req.method === "DELETE") {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);
      await killSessions(env, uid);
      const r = json(env, req, { ok: true });
      r.headers.append("Set-Cookie", clearCookie());
      return r;
    }

    if (path === "/book" || path === "/me") {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);

      // 응답에만 얹고 레코드에는 안 넣는다. 넣으면 books 행에 굳어서, 나중에 목록에서 빼도
      // 옛 레코드가 계속 마스터라고 말한다. 판단은 언제나 지금의 MASTER_UIDS 가 한다.
      //
      // master 와 pro 를 갈라 보낸다. 지금은 마스터만 pro 지만 결제가 붙으면 **산 사람도 pro** 가
      // 된다 — 그때 화면이 "마스터"와 "프로"를 구분해 말하려면 이름이 둘이어야 한다.
      const master = isMaster(env, uid), pro = master;

      if (req.method === "GET") {
        // `me` 를 같이 준다. 앱이 **계정이 바뀐 것**을 알아채는 데 쓴다(앞 계정 단어장을 새 계정에
        // 물려주지 않기 위해). 예전엔 토큰 앞부분을 뜯어 알았는데, 토큰이 무작위가 되면서
        // 그 길이 사라졌다 — 서버가 말해 주는 편이 정직하기도 하다.
        return json(env, req, { ...(await getBook(env, uid)), me: uid, pro, master });
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        // ── 이 요청은 **자기가 누구라고 믿고** 보낸 것인가 ──
        // 쿠키는 탭이 아니라 **브라우저 전체**가 공유한다. 그래서 탭 하나에서 계정을 바꾸면
        // 그 순간부터 다른 탭의 요청도 새 계정의 쿠키로 나간다. 그 탭은 그걸 모른 채 손에 든
        // 앞 계정 단어장을 저장하고, 그러면 **남의 계정에 내 단어장이 쌓인다.**
        // 쿠키만 보는 서버에는 이걸 가려낼 근거가 아예 없었다 — 쿠키는 진짜로 맞기 때문이다.
        // 그래서 앱이 "저는 이 계정으로 알고 있습니다"를 같이 말하게 하고, 세션의 주인과
        // 다르면 거절한다. 클라이언트의 탭 감지만 믿지 않는 이유는, 그 탭이 늦게 알아채거나
        // 아예 못 알아채는 경우(계정 확인 요청이 실패한 채로 편집)가 실재하기 때문이다.
        //
        // 값을 **안 보낸** 요청은 그대로 받는다. 새 화면이 아직 안 붙은 기기가 이 값을 모르는
        // 채로 저장하는데, 그것까지 막으면 업데이트 전 사용자의 저장이 통째로 죽는다.
        // 서버는 **말한 것이 틀렸을 때만** 막는다.
        // ⚠️ 응답에 계정 id 를 되싣지 않는다 — 실으면 이 자리가 "내 uid 가 뭐냐"를 알려주는
        //    신탁이 된다. 앱이 알아야 하는 것은 "바뀌었다"는 사실뿐이다.
        if (typeof (body && body.me) === "string" && body.me && body.me !== uid)
          return json(env, req, { error: "다른 계정으로 로그인돼 있어요. 앱을 새로고침해 주세요",
                                  accountChanged: true }, 409);
        // 신뢰 경계다. 배열인지, 문자열인지, 터무니없이 크지 않은지 여기서 막는다.
        const words = Array.isArray(body && body.words)
          ? body.words.filter((w) => typeof w === "string" && w.length <= 100).slice(0, 500)
          : null;
        if (!words) return json(env, req, { error: "형식이 올바르지 않아요" }, 400);
        // 별명은 **사용자가 지어 넣는 말**이지 제공자에게 받은 이름이 아니다. 그래서 아무 말이나 될 수
        // 있고, 그만큼 길이만 막으면 된다. 빈 문자열은 "지웠다"는 뜻이라 그대로 저장한다.
        const name = typeof (body && body.name) === "string" ? body.name.trim().slice(0, 20) : "";

        // ── 버전 확인 ──
        // 전에는 무조건 덮어썼고, 어느 쪽이 새것인지는 **기기 시계**가 정했다(앱의 syncPlan 이
        // `remote.updated > localAt` 으로 비교). 시계가 어긋난 기기는 늘 자기가 새것이라 여겨
        // 다른 기기에서 담은 단어를 조용히 지웠다 — 시각은 권한 판정에 쓸 값이 아니다.
        // 이제 버전은 **서버가 센다.** 손에 든 버전이 지금 것과 다르면 409 로 거절하고 현재
        // 레코드를 같이 준다. 앱은 그걸 받아 합쳐서 다시 올린다(어느 쪽도 조용히 안 버린다).
        const prev = await env.DB.prepare("SELECT version FROM books WHERE user_id = ?").bind(uid).first();
        const now = prev ? prev.version : 0;
        // 버전을 안 보낸 요청은 **처음 저장할 때만** 받는다. 레코드가 이미 있으면 거절한다 —
        // 안 그러면 옛 앱이 버전을 빼고 보내는 것만으로 이 방어가 통째로 무효가 된다.
        const sent = typeof (body && body.version) === "number" ? body.version : null;
        if (prev && sent !== now)
          return json(env, req, { error: "다른 기기에서 먼저 저장했어요", conflict: true,
                                  ...(await getBook(env, uid)), pro, master }, 409);

        const updated = Date.now();
        // ⚠️ `WHERE version = ?` 을 조건에 넣는다. 위에서 읽고 여기서 쓰는 사이에 다른 기기가
        //    먼저 저장하면 위 검사만으로는 못 막는다 — 조건을 문장 안에 넣어야 원자적이다.
        const upd = await env.DB.prepare(
          `INSERT INTO books (user_id, words, nickname, version, updated_at) VALUES (?1, ?2, ?3, 1, ?4)
           ON CONFLICT (user_id) DO UPDATE SET words = ?2, nickname = ?3,
             version = books.version + 1, updated_at = ?4 WHERE books.version = ?5`)
          .bind(uid, JSON.stringify(words), name, updated, now).run();
        if (!upd.meta || upd.meta.changes === 0)
          return json(env, req, { error: "다른 기기에서 먼저 저장했어요", conflict: true,
                                  ...(await getBook(env, uid)), pro, master }, 409);
        return json(env, req, { words, name, updated, version: now + 1, pro, master });
      }
      // 탈퇴. **한 문장이면 끝난다** — users 를 지우면 sessions·books·friendships·invite_codes 가
      // 외래키 CASCADE 로 같이 사라진다. KV 시절엔 6번의 개별 삭제였고 중간에 죽으면 반쯤 지워진
      // 계정이 남았다(그리고 지울 것을 하나 빠뜨리면 아무도 몰랐다).
      //
      // ⚠️ **여기서 killSessions 를 부르지 않는다.** 부르던 시절엔 작업이 둘이었고, 두 번째가
      //    실패하면 실측으로 이렇게 됐다: 500 이 나가는데 세대는 이미 올라가 **사용자는 그 자리에서
      //    로그아웃되고**, users·books·friendships·invite_codes 는 **전부 남는다.** 그래서 "지우지
      //    못했어요"를 본 사람의 별명과 단어 개수가 친구에게 계속 보였고, 다시 로그인하기 전에는
      //    재시도할 방법조차 없었다. 한 문장이면 그 중간 상태가 **존재할 수 없다.**
      //    세대를 안 올려도 안전한 이유: whoAmI 가 `JOIN users` 라 행이 사라지는 순간
      //    이 계정의 모든 세션이 그 자리에서 죽는다(세대는 로그아웃에서만 필요하다).
      //    실패하면 아무것도 안 지워지고 세션도 살아 있어, 사용자가 **그 화면에서 다시 누르면 된다.**
      //
      // 지운 행이 0 이어도 성공이다 — 다른 탭이 방금 지웠다는 뜻이고, 사용자가 원한 결과는
      // 이미 이뤄졌다(친구 끊기의 404 를 성공으로 수렴시키는 것과 같은 판단).
      //
      // ⚠️ **2026-08-18: 한 문장 앞뒤로 표식이 붙었다.** 이유는 삭제가 안전해서가 아니라
      //    **지운 뒤에 되살아날 수 있기 때문**이다 — D1 의 Time Travel 은 끌 수 없고, 운영자가
      //    과거 시점으로 복원하면 탈퇴한 계정·단어장·친구 관계가 그대로 돌아온다.
      //    그때 「누구를 다시 지워야 하는지」를 아는 근거가 이 표식뿐이다.
      //    표식은 **주 D1 이 아니라 별도 ledger** 에 남는다 — 같은 DB 에 두면 복원이 표식까지
      //    함께 과거로 보내서, 아는 방법이 사라진다.
      //
      // 순서: lease → pending → (fencing 재확인) → DELETE → 부재 확인 → confirmed → lease 해제
      //   · pending 이 실패하면 **주 D1 을 건드리지 않는다**(세션 유지 → 그 화면에서 재시도)
      //   · confirmed 만 실패하면 사용자에게는 **성공**이다(계정은 실제로 없다). 나머지는
      //     reconciliation 이 승격한다 — 사용자를 붙잡아 둘 이유가 없다.
      if (req.method === "DELETE") {
        // ledger 나 키가 없으면 **지우지 않는다.** 표식 없는 삭제가 이 설계가 막으려는 바로 그것이다.
        // 「일단 지우고 표식은 나중에」로 두면 복원 한 번에 되살아나고 아무도 알아채지 못한다.
        if (!env.LEDGER || !env.DELETION_KEY)
          return json(env, req, { error: "지금은 계정을 지울 수 없어요. 잠시 뒤에 다시 시도해 주세요" }, 503,
            { "Retry-After": "60" });
        const failDelete = () =>
          json(env, req, { error: "계정을 지우지 못했어요. 다시 시도해 주세요" }, 500);
        // ⚠️ **여기서 임차증을 새로 따지 않는다**(결정 A′). 이 요청은 이미 하나를 들고 있다 —
        //    두 개를 들면 요청 하나가 활성 수 2 로 세어지고, 하나만 해제돼도 drain 이 0 이 안 된다.
        //    삭제 saga 가 필요로 하는 것은 **fencing**(`leaseAlive`)이고, 그건 어느 임차증이든 된다.
        try {
          const now = Date.now();
          const mark = await deletionMark(env, uid);
          if (!lease)
            return json(env, req, { error: "잠시 점검 중이에요. 조금 뒤에 다시 시도해 주세요" }, 503,
              { "Retry-After": "60" });
          if (!(await markPending(env, lease, mark, now))) return failDelete();
          // 주 D1 을 지우기 **직전에** 한 번 더 본다. 두 DB 사이에 공통 트랜잭션이 없어서
          // 이 확인과 아래 DELETE 사이의 틈을 코드로 없앨 수는 없다 — 그래서 표식이
          // 1차 방어이고(지워지지 않으므로) lease 는 2차다. 어느 하나만으로 안전하지 않다.
          if (!(await leaseAlive(env, lease, now)))
            return json(env, req, { error: "잠시 점검 중이에요. 조금 뒤에 다시 시도해 주세요" }, 503,
              { "Retry-After": "60" });
          // **한 문장.** users 를 지우면 sessions·books·friendships·invite_codes·policy_events 가
          // 외래키 CASCADE 로 같이 사라진다 — 중간 상태가 존재할 수 없다.
          await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid).run();
          // 지운 행이 0 이어도 성공이다(다른 탭이 먼저 지웠다). 확인하는 것은 **부재**다.
          const still = await env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ?").bind(uid).first();
          if (still) return failDelete();          // 있을 수 없는 상태. 재시도 + 조사 대상
          // 여기부터는 **계정이 실제로 없다.** 아래가 실패해도 사용자에게는 성공이다.
          try {
            await markConfirmed(env, lease, mark, Date.now());
            await sweepConfirmed(env, Date.now());
          } catch { /* 확정 기록 실패는 reconciliation 이 승격한다 */ }
        } catch {
          return failDelete();
        }
        // 해제는 가장 바깥 `finally`(`export default.fetch`) 하나가 맡는다.
        const r = json(env, req, { ok: true });
        r.headers.append("Set-Cookie", clearCookie());
        return r;
      }
    }

    // ── 4. 친구 ──
    if (path.startsWith("/friends")) {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);

      // 목록 + 내 초대 코드
      if (path === "/friends" && req.method === "GET") {
        const rows = await friendRows(env, uid);
        return json(env, req, {
          code: await myCode(env, uid),
          friends: rows.filter((r) => r.status === "accepted").map((r) => briefRow(r, uid, true)),
          in: rows.filter((r) => r.status === "pending" && r.adr === uid).map((r) => briefRow(r, uid, false)),
          out: rows.filter((r) => r.status === "pending" && r.req === uid).map((r) => briefRow(r, uid, false)),
        });
      }

      // 요청 보내기 — 초대 코드로. 상대가 이미 나에게 보냈으면 그 자리에서 맺어진다
      // (서로 링크를 주고받았는데 둘 다 수락 버튼을 기다리는 상태가 안 생기게).
      if (path === "/friends" && req.method === "POST") {
        // **여기가 유일한 열거 공격면이다.** 초대 코드를 맞히면 남에게 요청을 보낼 수 있다
        // (수락은 여전히 상대가 하지만, 무차별 대입은 그 자체로 스팸이 된다).
        // 위 "write" 보다 좁게 센다 — 정상 사용자는 링크를 눌러 한 번 보낼 뿐이다.
        if (await limited(env, req, uid, "friends")) return tooMany(env, req);
        const body = await readBody(req);
        const code = typeof (body && body.code) === "string" ? body.code.trim().slice(0, 64) : "";
        const owner = code && (await env.DB.prepare(
          "SELECT user_id FROM invite_codes WHERE code = ? AND revoked_at IS NULL").bind(code).first());
        const other = owner && owner.user_id;
        if (!other) return json(env, req, { error: "초대 링크가 만료됐거나 잘못됐어요" }, 404);
        if (other === uid) return json(env, req, { error: "자기 자신은 추가할 수 없어요" }, 400);

        // 지금 이 둘 사이에 무엇이 있나. **쌍 이름으로** 찾는다 — 방향을 신경 쓸 자리가 없어진다.
        const key = pairKey(uid, other);
        const rel = await env.DB.prepare(
          "SELECT requester_id AS req, status FROM friendships WHERE pair_key = ?").bind(key).first();
        if (rel && rel.status === "accepted")
          return json(env, req, { state: "ok", friend: await briefOne(env, other, true) });
        // **내가 이미 보낸 요청이면 아무것도 쓰지 않는다.** 같은 사람이 링크를 두 번 눌렀을 뿐이다.
        // (여기서 다시 INSERT 하면 방향까지 같아 기본키에 부딪히는데, 그건 아래 ON CONFLICT 가
        //  받는 충돌이 아니라서 예외로 죽는다. 반대 방향 경합만 아래가 받는다.)
        if (rel && rel.req === uid)
          return json(env, req, { state: "sent", friend: await briefOne(env, other, false) });

        // 상한. 내 쪽만 보는 게 아니라 **상대 쪽도** 본다 — 안 그러면 여러 계정이 한 사람에게
        // 요청을 몰아 그 사람 목록만 무한히 키울 수 있다. (이미 관계가 있으면 셀 이유가 없다)
        //
        // ⚠️ 이 미리보기는 **문구를 위한 것**이고 방어가 아니다. 세고 나서 넣는 사이에 다른
        //    요청이 들어오면 둘 다 통과한다(pair_key 가 겪은 것과 같은 종류의 경합이다).
        //    진짜 방어는 아래 INSERT 의 WHERE 안에 있다 — 거기서 막히면 행이 안 생기고,
        //    그걸 아래에서 "행이 없다"로 알아채 429 를 낸다.
        if (!rel) {
          const cnt = await env.DB.prepare(
            `SELECT (SELECT COUNT(*) FROM friendships WHERE requester_id = ?1 OR addressee_id = ?1) AS mine,
                    (SELECT COUNT(*) FROM friendships WHERE requester_id = ?2 OR addressee_id = ?2) AS theirs`)
            .bind(uid, other).first();
          if (cnt.mine >= MAX_FRIENDS || cnt.theirs >= MAX_FRIENDS)
            return json(env, req, { error: "친구가 너무 많아요" }, 429);
        }

        // ⚠️ **읽고 나서 쓰는 사이**에 상대가 반대 방향으로 보낼 수 있다. 그래서 판정을
        //    전부 이 한 문장 안에 넣는다: 같은 쌍이면 UNIQUE 에 부딪히고, 그 부딪힘이 곧
        //    "서로 보냈다"는 신호라 그 자리에서 accepted 가 된다.
        //    WHERE 가 막는 것 — 이미 accepted 인 행(그대로 둔다)과 **내가 보낸 pending**
        //    (같은 사람이 두 번 눌렀을 뿐이라 친구로 만들면 안 된다).
        // 상한도 **이 문장 안에서** 센다(SELECT … WHERE 형태라야 조건을 걸 수 있다).
        // 그래서 동시 요청 두 개가 마지막 한 자리를 나눠 갖는 일이 생기지 않는다.
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO friendships (requester_id, addressee_id, pair_key, status, created_at)
           SELECT ?1, ?2, ?3, 'pending', ?4
            WHERE (SELECT COUNT(*) FROM friendships WHERE requester_id = ?1 OR addressee_id = ?1) < ?5
              AND (SELECT COUNT(*) FROM friendships WHERE requester_id = ?2 OR addressee_id = ?2) < ?5
           ON CONFLICT (pair_key) DO UPDATE SET status = 'accepted', accepted_at = ?4
             WHERE friendships.status = 'pending' AND friendships.requester_id = ?2`)
          .bind(uid, other, key, now, MAX_FRIENDS).run();

        // 무엇이 됐는지는 **DB 에 다시 묻는다.** 위 문장이 넣었는지 고쳤는지 아무것도 안 했는지를
        // changes 로 갈라 보면 세 갈래가 또 생긴다 — 결과 한 줄이면 충분하다.
        const made = await env.DB.prepare("SELECT status FROM friendships WHERE pair_key = ?").bind(key).first();
        // 행이 없다 = 위 WHERE 가 상한에서 막았다는 뜻이다. 여기서 잡지 않으면
        // "요청을 보냈어요"라고 말해놓고 아무것도 안 보낸 화면이 나온다.
        if (!made) return json(env, req, { error: "친구가 너무 많아요" }, 429);
        const ok = made.status === "accepted";
        return json(env, req, { state: ok ? "ok" : "sent", friend: await briefOne(env, other, ok) });
      }

      // 초대 링크 새로 만들기. 옛 코드는 그 자리에서 죽는다 — 링크가 어디까지 퍼졌는지
      // 모르게 됐을 때 되돌릴 방법이 이것뿐이다(코드에 만료를 두지 않는 이유이기도 하다:
      // 언제 죽일지는 사람이 정한다. 자동 만료는 멀쩡한 링크까지 조용히 끊는다).
      //
      // **이미 맺어진 친구는 그대로다.** 코드는 "요청을 보낼 자격"이지 관계 자체가 아니다.
      // 아래 m2 정규식이 `/friends/code` 도 잡으므로 **이 라우트가 먼저** 와야 한다.
      //
      // ⚠️ **자기 버킷으로 좁게 센다.** 넉넉한 `write`(분당 120)만 걸려 있을 때는 로그인한
      //    계정 하나가 분당 240 D1 쓰기 = 하루 34만(무료 한도 10만)을 태울 수 있었다 —
      //    그게 바닥나면 **정상 사용자의 단어장 저장이 먼저 죽는다**(리미터가 아니라 이 라우트가
      //    증폭기였다). 링크를 새로 만드는 것은 몇 달에 한 번 하는 일이라 분당 5회면 넘친다.
      if (path === "/friends/code" && req.method === "POST") {
        if (await limited(env, req, uid, "rotate")) return tooMany(env, req);
        return json(env, req, { code: await rotateCode(env, uid) });
      }

      const m2 = path.match(/^\/friends\/([^/]+)(\/book)?$/);
      if (m2) {
        // `%zz` 같은 반쪽 인코딩은 decodeURIComponent 가 던진다 — 잡지 않으면 500 이 나간다.
        let other;
        try { other = decodeURIComponent(m2[1]); } catch { return json(env, req, { error: "잘못된 주소예요" }, 400); }
        // 친구 단어장 보기. **수락된 친구만** — 요청만 보낸 사이에서는 안 보인다.
        //
        // 관계가 **행 하나**라 "한쪽만 친구인 상태"가 존재하지 않는다. KV 시절엔 두 사람 레코드에
        // 각각 적어서 반쪽이 남을 수 있었고, 그래서 양쪽을 다 확인하는 코드가 따로 필요했다.
        // 여기서는 조인 하나가 곧 권한 판정이다.
        if (m2[2]) {
          if (req.method !== "GET") return json(env, req, { error: "안 되는 요청이에요" }, 405);
          const row = await env.DB.prepare(
            `SELECT b.words AS words, b.nickname AS name FROM friendships f
               LEFT JOIN books b ON b.user_id = ?2
              WHERE f.status = 'accepted'
                AND ((f.requester_id = ?1 AND f.addressee_id = ?2)
                  OR (f.requester_id = ?2 AND f.addressee_id = ?1))`).bind(uid, other).first();
          if (!row) return json(env, req, { error: "친구가 아니에요" }, 403);
          let words = [];
          try { words = JSON.parse(row.words || "[]") || []; } catch { /* 깨진 행은 빈 단어장 */ }
          return json(env, req, { uid: other, name: row.name || "", words });
        }
        // 수락. 내가 **받은** 요청에만 쓴다 — 없는 요청을 수락해 친구가 되면
        // 상대는 보낸 적 없는 사람에게 단어장이 보인다.
        //
        // 조건이 전부 **UPDATE 문 안에** 있다: 상대가 requester 이고, 나에게 온 것이고, 아직 pending.
        // 하나라도 아니면 changes 가 0 이다 — 읽고 나서 쓰는 사이에 상태가 바뀌어도 안전하다.
        if (req.method === "PUT") {
          // 상한을 **UPDATE 안에서** 센다 — 밖에서 세면 요청 두 개가 동시에 마지막 자리를
          // 채워 51번째 친구가 생긴다. 세는 것은 accepted 만이다(pending 은 아직 친구가 아니다).
          const r = await env.DB.prepare(
            `UPDATE friendships SET status = 'accepted', accepted_at = ?1
              WHERE requester_id = ?2 AND addressee_id = ?3 AND status = 'pending'
                AND (SELECT COUNT(*) FROM friendships f2
                      WHERE (f2.requester_id = ?3 OR f2.addressee_id = ?3)
                        AND f2.status = 'accepted') < ?4`)
            .bind(Date.now(), other, uid, MAX_FRIENDS).run();
          // changes 가 0 인 이유가 둘이다: 받은 요청이 아니거나, 상한에 걸렸거나.
          // **실패한 뒤에만** 한 번 더 세어 문구를 가른다(정상 경로에는 질의를 늘리지 않는다).
          if (!r.meta || r.meta.changes === 0) {
            const cnt = await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM friendships WHERE (requester_id = ?1 OR addressee_id = ?1) AND status = 'accepted'")
              .bind(uid).first();
            return cnt.n >= MAX_FRIENDS
              ? json(env, req, { error: "친구가 너무 많아요" }, 429)
              : json(env, req, { error: "받은 요청이 아니에요" }, 400);
          }
          return json(env, req, { state: "ok", friend: await briefOne(env, other, true) });
        }
        // 거절 · 요청 취소 · 친구 끊기 — 전부 "이 연결을 지운다" 하나다.
        // **행이 하나라 한 번의 DELETE 로 끝난다.** 관계가 없으면 changes 가 0 이고,
        // 그때는 아무것도 안 쓴 것이다(반복해도 안전하다).
        if (req.method === "DELETE") {
          const r = await env.DB.prepare(
            `DELETE FROM friendships
              WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`)
            .bind(uid, other).run();
          if (!r.meta || r.meta.changes === 0) return json(env, req, { error: "친구가 아니에요" }, 404);
          return json(env, req, { ok: true });
        }
      }
    }

    return new Response("shhh! api", { status: 404, headers: cors(env, req) });
}
