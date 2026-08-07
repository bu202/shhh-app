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
      await env.KV.put("x:" + state, back, { expirationTtl: 600 });
      const q = new URLSearchParams({
        response_type: "code", client_id: id, redirect_uri: url.origin + "/cb/" + m[1], state,
      });
      if (p.scope) q.set("scope", p.scope);
      return Response.redirect(p.auth + "?" + q, 302);
    }

    // ── 2. 제공자가 돌려보내는 자리 ── /cb/kakao?code&state
    m = path.match(/^\/cb\/(\w+)$/);
    if (m && P[m[1]]) {
      const p = P[m[1]];
      const state = url.searchParams.get("state");
      const back = state && (await env.KV.get("x:" + state));
      if (!back) return new Response("로그인 요청이 만료됐어요. 다시 눌러 주세요.", { status: 400 });
      await env.KV.delete("x:" + state);           // state 는 1회용
      const code = url.searchParams.get("code");
      if (!code) return Response.redirect(back + "#login=denied", 302);

      const { id, secret } = creds(env, m[1]);
      const form = new URLSearchParams({
        grant_type: "authorization_code", client_id: id, code, state,
        redirect_uri: url.origin + "/cb/" + m[1],
      });
      if (secret) form.set("client_secret", secret);   // 카카오는 보안 설정을 꺼두면 없어도 된다
      const tr = await fetch(p.token, {
        method: "POST", body: form,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }).then((r) => r.json());
      if (!tr.access_token) return Response.redirect(back + "#login=fail", 302);

      const me = await fetch(p.me, { headers: { Authorization: "Bearer " + tr.access_token } }).then((r) => r.json());
      const who = p.uid(me);
      if (!who) return Response.redirect(back + "#login=fail", 302);

      const token = crypto.randomUUID();
      await env.KV.put("s:" + token, m[1] + ":" + who, { expirationTtl: 60 * 60 * 24 * 180 });
      return Response.redirect(back + "#login=" + token + "&via=" + m[1], 302);
    }

    // ── 3. 단어장 ──
    const uid = await env.KV.get("s:" + (req.headers.get("Authorization") || "").replace(/^Bearer /, ""));
    if (path === "/book" || path === "/me") {
      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);

      if (req.method === "GET") {
        const raw = await env.KV.get("b:" + uid);
        return json(env, req, raw ? JSON.parse(raw) : { words: [], updated: 0 });
      }
      if (req.method === "PUT") {
        const body = await req.json().catch(() => null);
        // 신뢰 경계다. 배열인지, 문자열인지, 터무니없이 크지 않은지 여기서 막는다.
        const words = Array.isArray(body && body.words)
          ? body.words.filter((w) => typeof w === "string" && w.length <= 100).slice(0, 500)
          : null;
        if (!words) return json(env, req, { error: "형식이 올바르지 않아요" }, 400);
        const rec = { words, updated: Date.now() };
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
