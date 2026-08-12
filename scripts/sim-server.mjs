// 시뮬레이션 서버. `node scripts/sim-server.mjs [포트]` → http://localhost:8788
//
// 무엇을 위한 것인가: **초대 → 수락이 실제로 일어나는가**(제품 가설)와 **로그인 왕복 표가
// 진짜 브라우저에서도 막는가**(보안 수정)를 사람 없이 확인하기 위한 자리다.
// 실제 사용자를 모으기 전에 두 사람이 필요한 흐름을 혼자 걸어 볼 방법이 이것뿐이다.
//
// ⚠️ **이 파일은 배포되지 않는다.** `scripts/` 는 `scripts/build.mjs` 의 allowlist 에 없고
//    `FORBIDDEN` 이 한 번 더 막는다(`test-dist` 가 잰다). 운영 코드에 개발용 뒷문을 내지 않으려고
//    일부러 여기에 뒀다 — worker/index.js 에는 시뮬레이션용 분기가 **한 줄도 없다.**
//
// 가짜로 만드는 것은 **제공자 한 곳뿐**이다. 카카오 서버를 부를 수 없을 뿐이지,
// 우리 코드(로그인 시작 → 표 심기 → 콜백 → 결속 검사 → 세션 → 동기화 → 친구)는 전부 진짜다.
// 저장소도 진짜 sqlite 다(scripts/_d1.mjs — 제약도 트랜잭션도 실제로 일어난다).
//
// **두 사람을 어떻게 만드나**: `localhost` 와 `127.0.0.1` 은 같은 서버지만 브라우저에게는
// **쿠키가 따로 노는 다른 호스트**다. 시크릿 창을 쓰지 않고도 한 브라우저에서 두 계정을
// 동시에 열 수 있고, 두 창을 나란히 놓고 볼 수 있어 오히려 관찰이 쉽다.
//   http://localhost:8788   → 계정 A
//   http://127.0.0.1:8788   → 계정 B
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { makeD1 } from "./_d1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.argv[2]) || 8788;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};

// ── 가짜 제공자 ──────────────────────────────────────────────────────────
// worker 가 부르는 두 주소만 가로챈다. code 안에 누구인지 적어 두고(`sim-<host>`),
// 그걸 그대로 회원번호로 쓴다 — 호스트가 다르면 다른 사람이 된다.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url && url.url ? url.url : url);
  if (/kauth\.kakao\.com\/oauth\/token/.test(u)) {
    const code = new URLSearchParams(String(init && init.body)).get("code") || "sim-unknown";
    return new Response(JSON.stringify({ access_token: "tok:" + code }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (/kapi\.kakao\.com\/v2\/user\/me/.test(u)) {
    const who = String((init && init.headers && init.headers.Authorization) || "").replace(/^Bearer tok:/, "");
    return new Response(JSON.stringify({ id: who }), { headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};

const DB = makeD1();
// APP_ORIGIN 은 요청마다 그 호스트로 맞춘다. 두 호스트를 각각 "그 사람의 앱 주소"로 세우는 것이라
// 운영의 `allowed()` 규칙(앱 주소 하나만 허용)을 **그대로** 쓰면서 두 계정을 열 수 있다.
const envFor = (origin) => ({
  APP_ORIGIN: origin, APP_URL: origin + "/",
  STATE_KEY: "sim-only-signing-key", KAKAO_ID: "sim", KAKAO_SECRET: "sim",
  DB,
});

const serve = async (res, file) => {
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",   // 시뮬레이션 중 옛 JS 를 무는 일이 없게(함정 6)
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
};

createServer(async (req, res) => {
  const origin = "http://" + req.headers.host;
  const url = new URL(req.url, origin);

  // 제공자의 동의 화면 자리. 진짜 카카오라면 사람이 여기서 로그인하고 「동의」를 누른다.
  // 시뮬레이션에서는 바로 되돌려보낸다 — 재려는 것은 카카오가 아니라 **우리 콜백**이다.
  if (url.pathname === "/__sim/authorize") {
    const back = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state") || "";
    const q = new URLSearchParams({ code: "sim-" + url.hostname, state });
    res.writeHead(302, { Location: back + "?" + q, "Cache-Control": "no-store" });
    return res.end();
  }

  if (url.pathname.startsWith("/api/")) {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined
      : await new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b)); });
    const r = await worker.fetch(new Request(origin + req.url, {
      method: req.method, headers: req.headers, body,
    }), envFor(origin));
    // ⚠️ `Location` 을 아래에서 갈아끼우므로 여기서 **미리 빼 둔다.** 안 빼면 원본(`location`)과
    //    새 값(`Location`)이 둘 다 실려 브라우저가 원본을 따라가 **진짜 카카오로 나간다.**
    const h = {};
    for (const [k, v] of r.headers) {
      const lk = k.toLowerCase();
      if (lk !== "set-cookie" && lk !== "location") h[k] = v;
    }
    // ⚠️ 쿠키가 여럿이면 (세션 + 표) `headers` 로는 하나만 남는다. 반드시 배열로 넘긴다 —
    //    안 그러면 표를 지우는 헤더가 세션 헤더에 먹혀 "쓴 표가 안 지워진다".
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")])
      .filter(Boolean)
      // `Secure` 는 브라우저가 localhost 에서는 http 여도 받아 준다(보안 컨텍스트로 친다).
      // 그래서 속성을 손대지 않는다 — 손대면 **운영과 다른 것을 재게 된다.**
      ;
    let loc = r.headers.get("Location");
    // 제공자로 나가는 리다이렉트만 가짜 동의 화면으로 돌린다. 나머지는 그대로 둔다.
    if (loc && loc.startsWith("https://kauth.kakao.com/oauth/authorize"))
      loc = origin + "/__sim/authorize?" + loc.split("?")[1];
    if (loc) h.Location = loc;
    if (cookies.length) h["Set-Cookie"] = cookies;
    res.writeHead(r.status, h);
    return res.end(Buffer.from(await r.arrayBuffer()));
  }

  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  return serve(res, path.join(DIST, rel));
}).listen(PORT, () => {
  console.log(`시뮬레이션 서버: http://localhost:${PORT}  (계정 A)`);
  console.log(`                 http://127.0.0.1:${PORT}  (계정 B — 쿠키가 따로 논다)`);
  console.log(`dist/ 를 서빙한다. 코드를 고쳤으면 먼저 \`npm run build\`.`);
});
