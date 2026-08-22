// **진짜 workerd 에서 도는지** 확인한다. `node scripts/test-workerd.mjs`
//
// 왜 이 파일이 따로 있나: 나머지 스위트는 `worker/index.js` 를 **Node 에서** 돌린다. 그건
// 빠르고 값싸지만 **런타임이 다르다** — Node 에 없는 API(`crypto.subtle.timingSafeEqual`)를
// 운영 코드가 부르기 시작하면, Node 쪽은 어댑터로 채워지고 **진짜 Workers 경로는 아무도 안
// 밟는다.** 그 상태가 정확히 「테스트는 통과하는데 배포하면 터진다」이다.
//
// 그래서 여기서는 어댑터를 **일부러 안 쓴다.** `node_modules` 의 workerd 바이너리를 직접
// 띄우고, 배포되는 것과 **같은 파일**(`worker/index.js`·`policies.js`·`ledger.js`)을 그대로
// 모듈로 넣어 HTTP 로 두드린다.
//
// ⚠️ **건너뛰지 않는다.** workerd 가 없으면 실패한다 — 「환경이 없어서 안 쟀다」가 조용히
//    통과하면 이 파일이 있으나 마나이고, 그게 이 저장소가 반복한 실패 무늬다.
// ⚠️ 바인딩(D1)은 넣지 않는다. 여기서 재는 것은 **DB 를 만지기 전에 끝나는 판정**뿐이다.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const t = (m) => { n++; return m; };
const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "node_modules", ".bin", "workerd");
// 자리를 옮겨 다니는 포트를 쓰지 않는다 — 같은 기기에서 스위트를 두 번 돌려도 안 부딪히게.
const PORT = 18700 + (process.pid % 900);
const READY_KEY = "workerd-operator-key-" + "x".repeat(20);

assert.ok(existsSync(bin),
  `workerd 바이너리가 없다(${bin}) — 이 검사는 건너뛰지 않는다. \`npm install\` 로 wrangler 를 설치할 것`);

const dir = mkdtempSync(join(tmpdir(), "shhh-workerd-"));
let proc = null;
try {
  // 배포되는 것과 **같은 파일**을 넣는다. 이름을 `worker/*.js` 로 두면 `./policies.js` 같은
  // 상대 import 가 그대로 풀린다 — 번들러를 끼우지 않는 이유다(끼우면 그 번들이 또 다른 갈래다).
  mkdirSync(join(dir, "worker"));
  for (const f of ["index.js", "policies.js", "ledger.js"])
    copyFileSync(join(root, "worker", f), join(dir, "worker", f));
  // ⚠️ **진입 모듈을 따로 둔다.** workerd 는 진입 모듈의 **named export 를 전부 엔트리포인트
  //    후보로 훑는데**, `worker/index.js` 는 테스트가 쓰라고 상수·함수를 여럿 내보낸다
  //    (`REQUIRED_POLICY_EVENTS` 같은 숫자에서 「function or ExportedHandler 가 아니다」로 죽는다).
  //    실제 Pages 에서는 `functions/api/[[path]].js` 가 같은 자리를 하므로, 여기서도 같은
  //    모양으로 감싼다 — **감싸는 것만 다르고 도는 코드는 배포되는 것과 같은 파일**이다.
  writeFileSync(join(dir, "entry.js"),
    'import worker from "./worker/index.js";\nexport default worker;\n');

  writeFileSync(join(dir, "config.capnp"), `
using Workers = import "/workerd/workerd.capnp";
const config :Workers.Config = (
  services = [ (name = "main", worker = .mainWorker) ],
  sockets = [ ( name = "http", address = "*:${PORT}", http = (), service = "main" ) ]
);
const mainWorker :Workers.Worker = (
  modules = [
    (name = "entry.js", esModule = embed "entry.js"),
    (name = "worker/index.js", esModule = embed "worker/index.js"),
    (name = "worker/policies.js", esModule = embed "worker/policies.js"),
    (name = "worker/ledger.js", esModule = embed "worker/ledger.js"),
  ],
  compatibilityDate = "2026-08-07",
  bindings = [
    (name = "APP_ORIGIN", text = "https://app.test"),
    (name = "APP_URL", text = "https://app.test/"),
    (name = "READY_KEY", text = "${READY_KEY}"),
  ],
);
`);

  proc = spawn(bin, ["serve", "config.capnp"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });

  const base = `http://127.0.0.1:${PORT}`;
  // 뜰 때까지 기다린다. 안 뜨면 **로그를 보여주고 실패한다** — 조용한 타임아웃은 원인을 숨긴다.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (proc.exitCode !== null) break;
    try { await fetch(base + "/api/health"); up = true; } catch { /* 아직 */ }
  }
  assert.ok(up, `workerd 가 안 떴다 (exit=${proc.exitCode})\n${log.slice(0, 1200)}`);

  // ── W1. 런타임이 실제로 그 API 를 준다. 없으면 아래 판정은 전부 의미가 없다.
  {
    assert.ok(!/timingSafeEqual is not a function|TypeError/.test(log),
      t("W1: 부팅 로그에 런타임 오류가 있다"));
  }

  // ── W2. ★ **맞는 키만 진단을 본다** — `sameSecret()` 이 workerd 에서 실제로 도는 자리다.
  //   Node 어댑터가 아니라 런타임 구현이 판정한다.
  {
    const ok = await fetch(base + "/api/ready", { headers: { "X-Ready-Key": READY_KEY } });
    const j = await ok.json();
    assert.equal(j.diagnostics, true, t("W2: 맞는 키인데 진단이 안 나왔다 — 안전 비교가 안 돈다"));
    // 바인딩이 없으니 ready 는 거짓이어야 한다(그게 정확한 보고다).
    assert.equal(j.ready, false, t("W2: 바인딩도 없는데 ready 라고 답한다"));
  }

  // ── W3. ★ 틀린 키는 **길이가 같든 다르든** 전부 같은 답이다.
  //   ⚠️ 길이가 다른 경우가 핵심이다 — 원문을 그대로 `timingSafeEqual` 에 넣는 구현이면
  //      여기서 **예외로 500** 이 난다(workerd 는 길이가 다르면 TypeError 다).
  {
    const WRONG = [
      ["빈 값", ""],
      ["한 글자", "x"],
      ["한 글자 짧다", READY_KEY.slice(0, -1)],
      ["한 글자 길다", READY_KEY + "y"],
      ["끝만 다르다", READY_KEY.slice(0, -1) + "Z"],
      ["아주 길다", "a".repeat(300)],
    ];
    const shapes = new Set();
    for (const [why, key] of WRONG) {
      const r = await fetch(base + "/api/ready", { headers: { "X-Ready-Key": key } });
      assert.equal(r.status, 503, t(`W3[${why}]: 틀린 키가 ${r.status} 를 받았다`));
      const j = await r.json();
      assert.equal(j.diagnostics, false, t(`W3[${why}]: 틀린 키가 진단을 봤다`));
      shapes.add(Object.keys(j).sort().join(","));
    }
    // 헤더가 아예 없는 경우도 같은 답이어야 한다.
    const none = await fetch(base + "/api/ready");
    assert.equal(none.status, 503, t("W3: 키 없는 호출이 503 이 아니다"));
    shapes.add(Object.keys(await none.json()).sort().join(","));
    assert.equal(shapes.size, 1,
      t(`W3: 거절 응답의 모양이 ${shapes.size}가지다 — 길이가 맞았는지가 새어 나간다`));
  }

  // ── W4. ★ 500 이 하나도 없어야 한다. 예외가 나면 workerd 로그에 남는다.
  {
    assert.ok(!/Uncaught|internal error|exception/i.test(log),
      t(`W4: workerd 로그에 예외가 있다\n${log.slice(0, 600)}`));
  }

  // ── W5. 같은 런타임에서 **로그인 왕복 표 서명**도 돈다(`sameSecret` 의 다른 호출부).
  //   `/login/kakao` 는 설정이 없으므로 503 이어야 하고, 그 판정이 예외 없이 나와야 한다.
  {
    const r = await fetch(base + "/api/login/kakao", { redirect: "manual" });
    assert.ok(r.status === 503 || r.status === 403,
      t(`W5: 설정이 없는데 /login/kakao 가 ${r.status} 다`));
  }

  // ── W6. ★ **어댑터 없이 돌았다.** 이 프로세스에 `_workers-shim` 은 들어가지 않았다.
  {
    assert.ok(typeof globalThis.crypto.subtle.timingSafeEqual !== "function",
      t("W6: 이 Node 프로세스에 어댑터가 실려 있다 — workerd 검사가 오염됐다"));
  }
} finally {
  if (proc) { try { proc.kill("SIGKILL"); } catch { /* 이미 죽었다 */ } }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`test-workerd: ${n}개 통과 — 진짜 workerd 에서 timing-safe 비밀값 비교(맞는 키·`
  + `길이가 다른 틀린 키 6종·헤더 없음 · 응답 모양 하나 · 예외 0건 · 어댑터 미사용)`);
