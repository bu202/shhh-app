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
// 키:  s:<token> → uid (세션, 180일)
//      b:<uid>   → {words, updated} (단어장)
//      x:<state> → 돌아갈 주소 (CSRF, 10분)

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

// 앱 주소는 env.APP_ORIGIN 하나. 로컬 개발(localhost)도 허용해야 폰 없이 확인할 수 있다.
const allowed = (env, origin) =>
  origin === env.APP_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+):\d+$/.test(origin || "");

const cors = (env, req) => {
  const o = req.headers.get("Origin");
  return allowed(env, o)
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS" }
    : {};
};

const json = (env, req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(env, req) } });

const creds = (env, provider) => ({
  id: env[provider.toUpperCase() + "_ID"],
  secret: env[provider.toUpperCase() + "_SECRET"],
});

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
  const token = crypto.randomUUID();
  await env.KV.put("s:" + token, name + ":" + who, { expirationTtl: 60 * 60 * 24 * 180 });
  return token;
}

// state 는 1회용이다. 꺼내면서 지운다 — 남겨두면 같은 code 를 두 번 쓸 수 있다.
async function takeState(env, state) {
  if (!state) return null;
  const v = await env.KV.get("x:" + state);
  if (!v) return null;
  await env.KV.delete("x:" + state);
  const i = v.indexOf("|");
  return { provider: v.slice(0, i), back: v.slice(i + 1) };
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
      // state 는 CSRF 방어다. 돌아갈 주소를 URL 이 아니라 KV 에 담는 이유도 같다 —
      // 쿼리로 실어 보내면 남이 우리 도메인을 거쳐 아무 데로나 리다이렉트시킬 수 있다.
      const back = url.searchParams.get("return") || env.APP_ORIGIN;
      if (!allowed(env, new URL(back).origin)) return new Response("허용되지 않은 주소예요", { status: 400 });
      const state = crypto.randomUUID();
      // 어느 제공자로 시작한 state 인지 같이 적는다 — 남의 제공자 자리에서 재사용하지 못하게.
      await env.KV.put("x:" + state, m[1] + "|" + back, { expirationTtl: 600 });
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

    // ── 3. 단어장 ──
    const uid = await env.KV.get("s:" + (req.headers.get("Authorization") || "").replace(/^Bearer /, ""));
    if (path === "/book" || path === "/me") {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);

      if (req.method === "GET") {
        const raw = await env.KV.get("b:" + uid);
        return json(env, req, raw ? JSON.parse(raw) : { words: [], name: "", updated: 0 });
      }
      if (req.method === "PUT") {
        const body = await req.json().catch(() => null);
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
        return json(env, req, rec);
      }
      // 탈퇴: 단어장과 지금 세션을 지운다.
      // ponytail: 다른 기기의 세션 토큰은 남는다(uid→토큰 역인덱스가 없어서). 개인정보인 단어장은
      //   지워지고 그 세션으로는 빈 단어장만 보이므로 지금은 이걸로 충분하다. 기기 목록을 보여줄
      //   일이 생기면 그때 `s:<uid>:<token>` 로 키를 바꾼다.
      if (req.method === "DELETE") {
        await env.KV.delete("b:" + uid);
        await env.KV.delete("s:" + (req.headers.get("Authorization") || "").replace(/^Bearer /, ""));
        return json(env, req, { ok: true });
      }
    }

    return new Response("shhh! api", { status: 404, headers: cors(env, req) });
  },
};
