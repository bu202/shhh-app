// shhh! 로그인 + 단어장 동기화 (Cloudflare Worker + KV)
//
// 왜 서버가 생겼나: 「안 할 것: 서버」를 깬 건 로그인 때문이 아니라 **저장소** 때문이다.
// 로그인만으로는 단어장이 여전히 기기 안에만 남아 폰을 바꾸면 사라진다 — 그러면 로그인 화면만
// 하나 늘고 사용자에겐 아무것도 안 달라진다. "나만의 단어장"은 DB 문제였다.
//
// 왜 D1 이 아니라 KV 인가: 저장하는 게 `사용자 → 단어 문자열 배열` 하나뿐이라 쿼리도 조인도
// 없다. SQL 을 쓰면 스키마 파일과 마이그레이션이 생기는데 그걸로 사는 게 없다.
//
// 받는 개인정보: **제공자가 주는 고유 번호뿐**. 이름·이메일·프로필 사진 어느 것도 요청하지 않는다.
// 그래서 카카오 비즈앱 전환도, 구글 민감 범위 심사도 필요 없다. privacy.html 이 이 사실에 맞춰져 있으니
// scope 를 늘릴 거면 그 문서를 **먼저** 고칠 것.
//
// 키:  s:<uid>:<token> → "1" (세션, 180일. **uid 로 묶는다** — 로그아웃·탈퇴가 이 계정의 모든
//                            기기에 들으려면 uid 하나로 훑어 지울 수 있어야 한다)
//      b:<uid>   → {words, name, updated} (단어장)
//      c:<code>  → uid (초대 코드 → 사람)
//      u:<uid>   → code (사람 → 초대 코드. 같은 사람은 늘 같은 링크를 준다)
//      f:<uid>   → {ok:[uid], in:[uid], out:[uid]} (수락된 친구 · 받은 요청 · 보낸 요청)
//
// x:<state> 는 **없앴다.** /login 은 인증이 없는 자리라 거기서 KV 를 쓰면 `curl` 반복만으로
// 무료 플랜의 하루치 쓰기(1,000회)를 태울 수 있었다 — 그러면 그날 남은 시간 동안 아무도
// 단어장을 저장하지 못한다. 지금은 state 를 서명해서 들려 보낸다(makeState).

const P = {
  kakao: {
    auth: "https://kauth.kakao.com/oauth/authorize",
    token: "https://kauth.kakao.com/oauth/token",
    me: "https://kapi.kakao.com/v2/user/me",
    scope: "",                       // 동의항목 0개. 회원번호만 받는다.
    uid: (j) => j.id,
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

const cors = (env, req) => {
  const o = req.headers.get("Origin");
  return allowed(env, o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" }
    : {};
};

const json = (env, req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(env, req) } });

const creds = (env, provider) => ({
  id: env[provider.toUpperCase() + "_ID"],
  secret: env[provider.toUpperCase() + "_SECRET"],
});

// ── 서명·토큰·본문 ───────────────────────────────────────────────────────
const ENC = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sign(env, msg) {
  const k = await crypto.subtle.importKey("raw", ENC.encode(env.STATE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, ENC.encode(msg)));
}

// state 는 KV 가 아니라 **서명한 문자열**이다. 담는 건 종전과 같다(어느 제공자로 시작했나 ·
// 돌아갈 주소 · 언제까지). 우리 키로 서명하므로 남이 만들 수 없다.
//
// ponytail: KV 를 안 쓰니 **1회용 보장이 사라진다** — 같은 state 를 두 번 낼 수 있다.
//   그래도 손해가 없는 이유는 code 쪽이 1회용이기 때문이다: 두 번째 교환은 제공자가 거부해
//   "로그인에 실패했어요"로 끝난다. 재사용 자체를 막아야 할 일이 생기면 그때 KV 로 되돌린다.
const makeState = async (env, provider, back) => {
  const body = b64u(ENC.encode(JSON.stringify([provider, back, Date.now() + 600e3])));
  return body + "." + (await sign(env, body));
};

async function takeState(env, state) {
  if (!state) return null;
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const body = state.slice(0, i);
  if ((await sign(env, body)) !== state.slice(i + 1)) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
  const [provider, back, exp] = p;
  if (!(Date.now() < exp)) return null;
  return { provider, back };
}

// 세션 토큰은 `<uid>.<무작위>` 다. uid 를 담는 이유는 하나뿐 — 로그아웃·탈퇴가 **이 계정의 모든
// 기기**를 끊으려면 키를 uid 로 묶어 한 번에 훑어야 하는데, 토큰만으로는 어느 계정인지 모른다.
// 담긴 uid 는 **주장일 뿐**이다: `s:<uid>:<token>` 이 KV 에 실제로 있어야 로그인으로 친다.
const mkToken = (uid) => b64u(ENC.encode(uid)) + "." + crypto.randomUUID().replace(/-/g, "");
const uidOf = (token) => {
  const i = token.indexOf(".");
  if (i < 1) return null;
  try { return new TextDecoder().decode(unb64u(token.slice(0, i))); } catch { return null; }
};

// 이 계정의 세션을 전부 지운다. 로그아웃과 탈퇴가 같은 자리를 쓴다 —
// "이 계정의 로그인을 끊는다" 하나라서 경로를 둘로 만들지 않았다.
//
// ponytail: KV list 는 최종 일관성이라 **방금 만든 세션이 목록에 없을 수 있다**(최대 60초).
//   그 창에 로그인한 기기는 안 끊긴다. 종전(아무것도 안 지움)보다는 훨씬 낫고, 정확히 하려면
//   레코드에 버전을 두고 매 요청 대조해야 하는데 그건 요청마다 KV 읽기가 하나 는다.
async function killSessions(env, uid) {
  const { keys } = await env.KV.list({ prefix: "s:" + uid + ":" });
  await Promise.all(keys.map((k) => env.KV.delete(k.name)));
  return keys.length;
}

// 신뢰 경계. 무료 플랜 Worker 는 메모리가 128MB 인데 요청 본문 한도는 100MB 라,
// 안 막으면 한 번의 요청으로 밀어붙일 수 있다.
//
// **Content-Length 만 보면 방어가 안 된다** — 공격자는 그 헤더 없이(chunked) 보내면 그만이다.
// 그래서 스트림을 읽으면서 한도를 넘는 순간 끊는다. 헤더가 있으면 읽기도 전에 자르는 지름길로만 쓴다.
const MAX_BODY = 8192;
async function readBody(req) {
  if (!(req.headers.get("Content-Type") || "").includes("application/json")) return null;
  const len = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(len) && len > MAX_BODY) return null;
  const reader = req.body && req.body.getReader();
  if (!reader) return null;
  const buf = new Uint8Array(MAX_BODY);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > MAX_BODY) { await reader.cancel(); return null; }
    buf.set(value, n);
    n += value.length;
  }
  try { return JSON.parse(new TextDecoder().decode(buf.subarray(0, n))); } catch { return null; }
}

// 제공자가 code 를 어디로 돌려보내는가. 여기서 만든 값과 **똑같은 문자열**을 토큰 교환에도 보내야
// 한다 — 한 글자만 달라도 제공자가 거부한다. 그래서 두 곳이 이 함수 하나를 부른다.
const redirectUri = (env, origin, name) =>
  P[name].viaApp ? env.APP_URL : origin + "/cb/" + name;

// code → 세션 토큰. /cb(카카오·구글)와 /exchange(네이버) 둘 다 이 함수를 쓴다 —
// 흐름이 갈려도 **토큰 교환과 사용자 판별은 한 곳**이어야 한쪽만 고치는 실수가 안 난다.
async function exchange(env, origin, name, code, state) {
  const p = P[name];
  const { id, secret } = creds(env, name);
  const form = new URLSearchParams({
    grant_type: "authorization_code", client_id: id, code, state,
    redirect_uri: redirectUri(env, origin, name),
  });
  if (secret) form.set("client_secret", secret);   // 카카오는 보안 설정을 꺼두면 없어도 된다
  const tr = await fetch(p.token, {
    method: "POST", body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }).then((r) => r.json());
  if (!tr.access_token) {
    console.log("[exchange] token fail", name, JSON.stringify(tr).slice(0, 300));
    return null;
  }
  const me = await fetch(p.me, { headers: { Authorization: "Bearer " + tr.access_token } }).then((r) => r.json());
  const who = p.uid(me);
  if (!who) {
    console.log("[exchange] me fail", name, JSON.stringify(me).slice(0, 300));
    return null;
  }
  const uid = name + ":" + who;
  const token = mkToken(uid);
  await env.KV.put("s:" + uid + ":" + token, "1", { expirationTtl: 60 * 60 * 24 * 180 });
  return token;
}

// ── 친구 ────────────────────────────────────────────────────────────────
// 게임의 친구 추가와 같다: 링크를 받은 사람이 요청을 보내고, **받은 사람이 수락해야** 이어진다.
// 링크만으로 바로 이어지게 하면 링크가 어디로 퍼졌는지 모르는 채 내 단어장이 남에게 보인다.
//
// ponytail: KV 에는 트랜잭션이 없다. 두 사람의 f: 레코드를 잇달아 쓰므로, 둘이 **같은 순간**
//   서로에게 요청하면 한쪽 목록만 갱신되는 창이 있다. 실제 사용(둘이서 쓰는 앱)에서 그 창은
//   사실상 안 열리고, 증상도 "다시 눌러보세요"로 끝난다. 문제가 되면 Durable Object 로 옮긴다.
const FR = { ok: [], in: [], out: [] };
const getFr = async (env, uid) => ({ ...FR, ...JSON.parse((await env.KV.get("f:" + uid)) || "{}") });
const putFr = (env, uid, v) => env.KV.put("f:" + uid, JSON.stringify(v));
// 세 목록 어디에서든 그 사람을 뺀다. 거절·취소·끊기가 전부 "이 연결을 지운다" 하나라서
// 각각 다른 경로를 만들지 않았다 — 지우는 자리가 하나면 반쪽만 지워지는 상태가 안 생긴다.
const drop = (f, uid) => ({ ok: f.ok.filter((x) => x !== uid), in: f.in.filter((x) => x !== uid), out: f.out.filter((x) => x !== uid) });

// 내 초대 코드. 없으면 만들어 둔다 — 같은 사람에게 늘 같은 링크가 나가야
// 예전에 보낸 링크가 죽지 않는다.
async function myCode(env, uid) {
  const had = await env.KV.get("u:" + uid);
  if (had) return had;
  const code = crypto.randomUUID().replace(/-/g, "").slice(0, 12); // 48비트 — 찍어서 못 맞힌다
  await env.KV.put("u:" + uid, code);
  await env.KV.put("c:" + code, uid);
  return code;
}

// ── 마스터 계정 ──────────────────────────────────────────────────────────
// 만든 사람의 계정은 무료 벽에 걸리지 않는다. **어느 기기에서 로그인해도** 그래야 하므로
// 브라우저(localStorage)가 아니라 서버가 정한다 — 폰을 바꾸면 로컬 표시는 그냥 사라진다.
//
// 목록은 `wrangler secret put MASTER_UIDS` 로 넣는다(쉼표 구분). **wrangler.jsonc 에 적지 않는다** —
// 그 파일은 공개 레포에 올라가고, 값이 제공자 계정 식별자라 밖에 나가면 안 된다.
// 비어 있으면 아무도 마스터가 아니다(기본값이 안전한 쪽).
const isMaster = (env, uid) =>
  String(env.MASTER_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean).includes(uid);

// 화면에 뿌릴 최소 정보. **단어 목록은 여기서 안 준다** — 목록 화면엔 안 쓰는데 친구 수만큼
// 레코드를 읽게 되고, 아직 수락 안 한 사람의 단어까지 실려 나간다.
//
// 개수(count)는 **수락된 친구에게만** 준다. 아직 요청 단계인 사이는 서로 남이라,
// 별명 말고는 알려 줄 게 없다. 개인정보처리방침도 "친구에게 보이는 것"으로만 적혀 있다 —
// 문서에 없는 것을 서버가 보내면 문서가 거짓말이 된다.
async function brief(env, uid, withCount) {
  const rec = JSON.parse((await env.KV.get("b:" + uid)) || "{}");
  const out = { uid, name: rec.name || "" };
  if (withCount) out.count = (rec.words || []).length;
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, req) });

    // ── 1. 로그인 시작 ── /login/kakao?return=<앱 주소>
    let m = path.match(/^\/login\/(\w+)$/);
    if (m && P[m[1]]) {
      const p = P[m[1]];
      const { id } = creds(env, m[1]);
      if (!id) return new Response(m[1] + " 로그인이 아직 설정되지 않았어요", { status: 503 });
      // state 는 CSRF 방어다. 돌아갈 주소를 **서명 안에** 넣는 이유도 같다 — 서명 없이 쿼리로
      // 실어 보내면 남이 우리 도메인을 거쳐 아무 데로나 리다이렉트시킬 수 있다.
      const back = url.searchParams.get("return") || env.APP_ORIGIN;
      // 아무 문자열이나 올 수 있는 자리다. new URL 이 던지면 그대로 500 이 나가므로 여기서 받는다.
      // 파싱이 안 되는 것도 "허용되지 않은 주소"다 — allowed(null) 은 어차피 거짓이다.
      let backOrigin = null;
      try { backOrigin = new URL(back).origin; } catch { /* 주소가 아니면 아래에서 400 */ }
      if (!allowed(env, backOrigin)) return new Response("허용되지 않은 주소예요", { status: 400 });
      // 어느 제공자로 시작한 state 인지 같이 서명한다 — 남의 제공자 자리에서 재사용하지 못하게.
      const state = await makeState(env, m[1], back);
      const q = new URLSearchParams({
        response_type: "code", client_id: id, redirect_uri: redirectUri(env, url.origin, m[1]), state,
      });
      if (p.scope) q.set("scope", p.scope);
      return Response.redirect(p.auth + "?" + q, 302);
    }

    // ── 2a. 앱이 code 를 넘겨 주는 자리(네이버) ── /exchange/naver?code&state
    // 네이버는 콜백이 앱 도메인으로 가므로 정적 페이지가 code 를 받는다. 비밀키가 필요한 교환만
    // 여기서 한다 — code 는 이 한 번의 교환에만 쓰이고 세션 토큰으로 바뀐다.
    m = path.match(/^\/exchange\/(\w+)$/);
    if (m && P[m[1]]) {
      const st = await takeState(env, url.searchParams.get("state"));
      if (!st || st.provider !== m[1]) return json(env, req, { error: "로그인 요청이 만료됐어요" }, 400);
      const code = url.searchParams.get("code");
      if (!code) return json(env, req, { error: "취소됐어요" }, 400);
      const token = await exchange(env, url.origin, m[1], code, url.searchParams.get("state"));
      return token ? json(env, req, { token }) : json(env, req, { error: "로그인에 실패했어요" }, 502);
    }

    // ── 2b. 제공자가 우리에게 직접 돌려보내는 자리(카카오·구글) ── /cb/kakao?code&state
    m = path.match(/^\/cb\/(\w+)$/);
    if (m && P[m[1]]) {
      const state = url.searchParams.get("state");
      const st = await takeState(env, state);
      if (!st || st.provider !== m[1]) return new Response("로그인 요청이 만료됐어요. 다시 눌러 주세요.", { status: 400 });
      // 심층 방어: state 는 우리가 서명했지만 back 은 **리다이렉트 목적지**라 한 번 더 본다.
      // allowed 가 좁아진 직후 옛 state 가 돌아오는 경우가 여기서 걸린다 — 서명이 유효해도
      // 지금 규칙에서 허용되지 않으면 토큰을 실어 보내지 않는다.
      let backOrigin = null;
      try { backOrigin = new URL(st.back).origin; } catch { /* 아래에서 400 */ }
      if (!allowed(env, backOrigin)) return new Response("허용되지 않은 주소예요", { status: 400 });
      const back = st.back;
      const code = url.searchParams.get("code");
      if (!code) {
        console.log("[cb] no code", m[1], url.searchParams.get("error"), url.searchParams.get("error_description"));
        return Response.redirect(back + "#login=denied", 302);
      }
      const token = await exchange(env, url.origin, m[1], code, state);
      if (!token) return Response.redirect(back + "#login=fail", 302);
      return Response.redirect(back + "#login=" + token + "&via=" + m[1], 302);
    }

    // ⚠️ `/master?code=…` 는 **지웠다**(2026-08-08). 로그인 없이 브라우저를 마스터로 만드는
    //    코드였는데, 링크가 새면 받은 사람도 마스터가 된다 — 마스터는 **만든 사람 계정 하나**여야 한다.
    //    로그인 안 한 상태에서 벽에 걸리는 건 감수한다(앱 출시 기준에선 로그인이 기본이다).
    //    되살릴 일이 생기면 커밋 1b68a90 에 있다. 시크릿 MASTER_CODE 도 같이 지웠다.

    // ── 3. 단어장 ──
    // 토큰에 담긴 uid 는 **주장**이다. `s:<uid>:<token>` 이 KV 에 실제로 있어야 로그인으로 친다 —
    // 없는 키를 지어내도 조회가 비므로 남의 계정을 주장할 수 없다.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const claimed = token && uidOf(token);
    const uid = claimed && (await env.KV.get("s:" + claimed + ":" + token)) ? claimed : null;

    // 로그아웃 — 이 계정의 세션을 **전부** 끊는다. 브라우저에서 토큰만 지우면 KV 의 세션은
    // 180일을 더 살아서, 한 번 샌 토큰이 로그아웃 뒤에도 그대로 쓰인다.
    if (path === "/session" && req.method === "DELETE") {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);
      return json(env, req, { ok: true, killed: await killSessions(env, uid) });
    }

    if (path === "/book" || path === "/me") {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);

      // 응답에만 얹고 레코드에는 안 넣는다. 넣으면 KV 에 굳어서, 나중에 목록에서 빼도
      // 옛 레코드가 계속 마스터라고 말한다. 판단은 언제나 지금의 MASTER_UIDS 가 한다.
      //
      // master 와 pro 를 갈라 보낸다. 지금은 마스터만 pro 지만 결제가 붙으면 **산 사람도 pro** 가
      // 된다 — 그때 화면이 "마스터"와 "프로"를 구분해 말하려면 이름이 둘이어야 한다.
      const master = isMaster(env, uid), pro = master;

      if (req.method === "GET") {
        const raw = await env.KV.get("b:" + uid);
        return json(env, req, { ...(raw ? JSON.parse(raw) : { words: [], name: "", updated: 0 }), pro, master });
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        // 신뢰 경계다. 배열인지, 문자열인지, 터무니없이 크지 않은지 여기서 막는다.
        const words = Array.isArray(body && body.words)
          ? body.words.filter((w) => typeof w === "string" && w.length <= 100).slice(0, 500)
          : null;
        if (!words) return json(env, req, { error: "형식이 올바르지 않아요" }, 400);
        // 별명은 **사용자가 지어 넣는 말**이지 제공자에게 받은 이름이 아니다. 그래서 아무 말이나 될 수
        // 있고, 그만큼 길이만 막으면 된다. 빈 문자열은 "지웠다"는 뜻이라 그대로 저장한다.
        const name = typeof (body && body.name) === "string" ? body.name.trim().slice(0, 20) : "";
        const rec = { words, name, updated: Date.now() };
        await env.KV.put("b:" + uid, JSON.stringify(rec));
        return json(env, req, { ...rec, pro, master });
      }
      // 탈퇴: 단어장·친구·초대코드와 **이 계정의 모든 세션**을 지운다.
      // 지금 기기 세션만 지우면 다른 기기가 살아남아 `myCode()` 로 초대 코드를,
      // `PUT /book` 으로 단어장을 **되살린다** — privacy.html 의 "그 자리에서 지워집니다"가 거짓이 된다.
      if (req.method === "DELETE") {
        // 친구 쪽 목록에서도 나를 뺀다. 안 빼면 상대 화면에 이름 없는 친구가 남고,
        // 그 사람의 단어장을 열면 빈 화면이 뜬다.
        const f = await getFr(env, uid);
        for (const other of [...f.ok, ...f.in, ...f.out]) await putFr(env, other, drop(await getFr(env, other), uid));
        const code = await env.KV.get("u:" + uid);
        if (code) await env.KV.delete("c:" + code);
        await env.KV.delete("u:" + uid);
        await env.KV.delete("f:" + uid);
        await env.KV.delete("b:" + uid);
        await killSessions(env, uid);
        return json(env, req, { ok: true });
      }
    }

    // ── 4. 친구 ──
    if (path.startsWith("/friends")) {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);
      const f = await getFr(env, uid);

      // 목록 + 내 초대 코드
      if (path === "/friends" && req.method === "GET") {
        const [ok, incoming, outgoing] = await Promise.all(
          [[f.ok, true], [f.in, false], [f.out, false]].map(([l, c]) => Promise.all(l.map((u) => brief(env, u, c)))));
        return json(env, req, { code: await myCode(env, uid), friends: ok, in: incoming, out: outgoing });
      }

      // 요청 보내기 — 초대 코드로. 상대가 이미 나에게 보냈으면 그 자리에서 맺어진다
      // (서로 링크를 주고받았는데 둘 다 수락 버튼을 기다리는 상태가 안 생기게).
      if (path === "/friends" && req.method === "POST") {
        const body = await readBody(req);
        const code = typeof (body && body.code) === "string" ? body.code.trim().slice(0, 64) : "";
        const other = code && (await env.KV.get("c:" + code));
        if (!other) return json(env, req, { error: "초대 링크가 만료됐거나 잘못됐어요" }, 404);
        if (other === uid) return json(env, req, { error: "자기 자신은 추가할 수 없어요" }, 400);
        if (f.ok.includes(other)) return json(env, req, { state: "ok", friend: await brief(env, other, true) });

        const g = await getFr(env, other);
        if (f.in.includes(other)) {   // 상대가 먼저 보냈다 → 바로 친구
          await putFr(env, uid, { ...drop(f, other), ok: [...f.ok, other] });
          await putFr(env, other, { ...drop(g, uid), ok: [...g.ok, uid] });
          return json(env, req, { state: "ok", friend: await brief(env, other, true) });
        }
        if (f.out.includes(other)) return json(env, req, { state: "sent", friend: await brief(env, other, false) });
        await putFr(env, uid, { ...f, out: [...f.out, other] });
        await putFr(env, other, { ...g, in: [...g.in.filter((x) => x !== uid), uid] });
        return json(env, req, { state: "sent", friend: await brief(env, other, false) });
      }

      // 초대 링크 새로 만들기. 옛 코드는 그 자리에서 죽는다 — 링크가 어디까지 퍼졌는지
      // 모르게 됐을 때 되돌릴 방법이 이것뿐이다(코드에 만료를 두지 않는 이유이기도 하다:
      // 언제 죽일지는 사람이 정한다. 자동 만료는 멀쩡한 링크까지 조용히 끊는다).
      //
      // **이미 맺어진 친구는 그대로다.** 코드는 "요청을 보낼 자격"이지 관계 자체가 아니다.
      // 아래 m2 정규식이 `/friends/code` 도 잡으므로 **이 라우트가 먼저** 와야 한다.
      if (path === "/friends/code" && req.method === "POST") {
        const old = await env.KV.get("u:" + uid);
        if (old) await env.KV.delete("c:" + old);
        const code = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        await env.KV.put("u:" + uid, code);
        await env.KV.put("c:" + code, uid);
        return json(env, req, { code });
      }

      const m2 = path.match(/^\/friends\/([^/]+)(\/book)?$/);
      if (m2) {
        const other = decodeURIComponent(m2[1]);
        // 친구 단어장 보기. **수락된 친구만** — 요청만 보낸 사이에서는 안 보인다.
        if (m2[2]) {
          if (req.method !== "GET") return json(env, req, { error: "안 되는 요청이에요" }, 405);
          if (!f.ok.includes(other)) return json(env, req, { error: "친구가 아니에요" }, 403);
          const rec = JSON.parse((await env.KV.get("b:" + other)) || "{}");
          return json(env, req, { uid: other, name: rec.name || "", words: rec.words || [] });
        }
        // 수락. 내가 **받은** 요청에만 쓴다 — 없는 요청을 수락해 친구가 되면
        // 상대는 보낸 적 없는 사람에게 단어장이 보인다.
        if (req.method === "PUT") {
          if (!f.in.includes(other)) return json(env, req, { error: "받은 요청이 아니에요" }, 400);
          const g = await getFr(env, other);
          await putFr(env, uid, { ...drop(f, other), ok: [...f.ok, other] });
          await putFr(env, other, { ...drop(g, uid), ok: [...g.ok.filter((x) => x !== uid), uid] });
          return json(env, req, { state: "ok", friend: await brief(env, other, true) });
        }
        // 거절 · 요청 취소 · 친구 끊기 — 전부 "이 연결을 지운다" 하나다. 양쪽에서 지운다.
        if (req.method === "DELETE") {
          await putFr(env, uid, drop(f, other));
          await putFr(env, other, drop(await getFr(env, other), uid));
          return json(env, req, { ok: true });
        }
      }
    }

    return new Response("shhh! api", { status: 404, headers: cors(env, req) });
  },
};
