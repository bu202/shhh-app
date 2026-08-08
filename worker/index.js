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
//      b:<uid>   → {words, name, updated} (단어장)
//      x:<state> → 돌아갈 주소 (CSRF, 10분)
//      c:<code>  → uid (초대 코드 → 사람)
//      u:<uid>   → code (사람 → 초대 코드. 같은 사람은 늘 같은 링크를 준다)
//      f:<uid>   → {ok:[uid], in:[uid], out:[uid]} (수락된 친구 · 받은 요청 · 보낸 요청)

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
    ? { "Access-Control-Allow-Origin": o, "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" }
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

      // pro 는 **응답에만 얹고 레코드에는 안 넣는다.** 넣으면 KV 에 굳어서, 나중에 목록에서 빼도
      // 옛 레코드가 계속 프로라고 말한다. 판단은 언제나 지금의 MASTER_UIDS 가 한다.
      const pro = isMaster(env, uid);

      if (req.method === "GET") {
        const raw = await env.KV.get("b:" + uid);
        return json(env, req, { ...(raw ? JSON.parse(raw) : { words: [], name: "", updated: 0 }), pro });
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
        return json(env, req, { ...rec, pro });
      }
      // 탈퇴: 단어장과 지금 세션을 지운다.
      // ponytail: 다른 기기의 세션 토큰은 남는다(uid→토큰 역인덱스가 없어서). 개인정보인 단어장은
      //   지워지고 그 세션으로는 빈 단어장만 보이므로 지금은 이걸로 충분하다. 기기 목록을 보여줄
      //   일이 생기면 그때 `s:<uid>:<token>` 로 키를 바꾼다.
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
        await env.KV.delete("s:" + (req.headers.get("Authorization") || "").replace(/^Bearer /, ""));
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
        const body = await req.json().catch(() => null);
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
