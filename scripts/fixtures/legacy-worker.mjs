// **옛 배포 세대의 고정 fixture.** 운영 코드가 아니고, 운영 코드에서 import 하지 않는다.
//
// 왜 있나: T8 은 "게이트 로직이 **없는** 배포 세대는 유지보수·복원을 무시한다"를 재는 시험이다.
// 2026-08-19 까지 그 시험은 **지금 코드에 `LEDGER: undefined` 를 넣어** 200 이 나오는 것을
// 옛 세대라고 불렀다. 그건 옛 세대가 아니라 **지금 코드의 fail-open** 이었고, 그래서 시험이
// 결함 하나를 「전제」로 굳혀 놓고 있었다. 지금 코드는 그 자리에서 503 이다(T8-a).
//
// 이 파일은 그 대신 **2026-08-14 세대의 모양을 얼어붙여 둔 것**이다. 그 세대에는 ledger 도,
// 유지보수 게이트도, 임차증도 없었다 — `worker/index.js` 에 그 줄이 아예 없었다.
// 여기서 재는 사실은 하나다: **바인딩은 프로젝트 단위라 옛 배포에도 같은 주 D1 이 붙어 있고,
// 게이트는 그 코드가 실행될 때만 작동한다.** 그래서 옛 배포를 지우거나 닿지 못하게 하기
// 전에는(설계서 §10-8-1 D1~D12) 주 D1 복원 금지가 유지된다.
//
// ⚠️ **이 파일을 「고치지」 않는다.** 옛 세대의 동작이 지금 코드에 맞춰 바뀌는 일은 없다.
//    현재 코드의 방어를 재는 것은 T8-a 이고, 그건 `worker/index.js` 를 그대로 부른다.

const ENC = new TextEncoder();
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async (s) => b64u(await crypto.subtle.digest("SHA-256", ENC.encode(s)));

const readCookie = (req) => {
  const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)shh_s=([^;]*)/);
  return m ? m[1] : "";
};

export default {
  // 옛 세대의 `/book`. 게이트도, 임차증도, `LEDGER` 도 모르는 코드다.
  async fetch(req, env) {
    const path = new URL(req.url).pathname.replace(/^\/api/, "");
    if (path !== "/book") return new Response("legacy fixture: only /book", { status: 404 });
    const row = await env.DB.prepare(
      `SELECT s.user_id AS uid FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
          AND s.session_version = u.session_version`)
      .bind(await sha256(readCookie(req)), Date.now()).first();
    if (!row) return new Response(JSON.stringify({ error: "로그인이 필요해요" }), { status: 401 });
    if (req.method === "GET") {
      const b = await env.DB.prepare("SELECT words FROM books WHERE user_id = ?").bind(row.uid).first();
      return new Response(JSON.stringify({ words: b ? JSON.parse(b.words) : [] }), { status: 200 });
    }
    if (req.method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const words = JSON.stringify(Array.isArray(body.words) ? body.words : []);
      await env.DB.prepare(
        `INSERT INTO books (user_id, words, nickname, version, updated_at) VALUES (?1, ?2, '', 1, ?3)
         ON CONFLICT (user_id) DO UPDATE SET words = ?2, version = books.version + 1, updated_at = ?3`)
        .bind(row.uid, words, Date.now()).run();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("legacy fixture", { status: 405 });
  },
};
