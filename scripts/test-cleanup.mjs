// 정리 전용 Worker. `node scripts/test-cleanup.mjs`
//
// 재는 것: **지워도 되는 것만 지우는가.** 이 Worker 의 위험은 「못 지우는 것」이 아니라
// 「잘못 지우는 것」이다 — 못 지운 것은 다음 회차에 지우면 되지만, 잘못 지운 것은 되돌릴 수 없다.
//
// 설계서 §13-5 의 T44~T47 을 구현한다.
import assert from "node:assert";
import { runCleanup } from "../worker/cleanup/index.js";
import { DELETIONS_SWEEP_SQL } from "../worker/ledger.js";
import { makeD1, makeLedger } from "./_d1.mjs";

let n = 0;
const t = (m) => { n++; return m; };
const env0 = () => ({ DB: makeD1(), LEDGER: makeLedger() });
const lc = (env, where = "") => env.LEDGER._db.prepare(`SELECT COUNT(*) n FROM deletions ${where}`).get().n;
const dc = (env, table, where = "") => env.DB._db.prepare(`SELECT COUNT(*) n FROM ${table} ${where}`).get().n;

// 대상마다 「만료된 것 1개 · 안 만료된 것 1개」를 심는다. 만료된 것만 사라져야 한다.
function seed(env, now) {
  const L = env.LEDGER._db, D = env.DB._db;
  const del = (mark, confirmed, exp) => L.exec(
    `INSERT INTO deletions (mark, key_version, pending_at, confirmed_at, pending_alert_at, expires_at)
     VALUES ('${mark}', 1, 1, ${confirmed}, ${now - 1}, ${exp})`);
  del("conf-old", now - 10, now - 1);            // 확정 · 만료 → 지운다
  del("conf-new", now - 10, now + 60e3);         // 확정 · 아직 → 남긴다
  del("pend-old", "NULL", now - 1);              // ⛔ 확정 안 됨 · 만료 → **남긴다**
  L.exec(`INSERT INTO write_leases VALUES ('lease-done',1,1,${now - 1},${now - 1})`);   // 해제됨·만료 → 지운다
  L.exec(`INSERT INTO write_leases VALUES ('lease-stuck',1,1,${now - 1},NULL)`);        // ⛔ 안 풀림 → **남긴다**
  D.exec(`INSERT INTO consumed_signup_states VALUES ('css-old',1,${now - 1})`);
  D.exec(`INSERT INTO consumed_signup_states VALUES ('css-new',1,${now + 60e3})`);
  D.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('u1','k','1',0,0)");
  D.exec(`INSERT INTO sessions VALUES ('h-old','u1',0,${now - 1},NULL)`);
  D.exec(`INSERT INTO sessions VALUES ('h-rev','u1',0,${now + 60e3},${now - 1})`);      // 폐기됨 → 지운다
  D.exec(`INSERT INTO sessions VALUES ('h-live','u1',0,${now + 60e3},NULL)`);
  D.exec(`INSERT INTO rate_limits VALUES ('rl-old',1,${now - 1})`);
  D.exec(`INSERT INTO rate_limits VALUES ('rl-new',1,${now + 60e3})`);
}

// ══ T44. ⛔ 가장 중요 — confirmed 만 지운다 ══════════════════════════════
{
  const env = env0(), now = Date.now();
  seed(env, now);
  const out = await runCleanup(env, now);
  assert.equal(lc(env, "WHERE mark = 'conf-old'"), 0, t("T44: 만료된 확정 표식이 안 지워졌다"));
  assert.equal(lc(env, "WHERE mark = 'conf-new'"), 1, t("T44: 아직 안 만료된 확정 표식을 지웠다"));
  // ★ 이 한 줄이 이 파일의 존재 이유다. pending 을 시간만 보고 지우면,
  //   「삭제는 됐는데 확정 기록만 실패한」 표식이 사라져 복원 때 그 사람이 되살아난다.
  assert.equal(lc(env, "WHERE mark = 'pend-old'"), 1,
    t("T44: ⛔ 만료된 pending 표식을 지웠다 — 복원 때 탈퇴자가 되살아나고 아무도 모른다"));
  assert.equal(out.openPending, 1, t("T44: 확정 안 된 pending 을 세지 않았다"));
  assert.equal(out.counts.deletions, 1, t("T44: 지운 표식 수를 안 적었다"));

  // 소스 수준에서도 잠근다 — 지금 조건이 맞다고 다음 사람이 조건을 뺄 수 없는 것은 아니다.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker/cleanup/index.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const dels = src.match(/DELETE\s+FROM\s+deletions/gi) || [];
  assert.equal(dels.length, 0,
    t("T44: cleanup 소스가 deletions 를 직접 지운다 — 문장은 ledger.js 의 상수 하나여야 한다"));
  assert.match(DELETIONS_SWEEP_SQL, /confirmed_at IS NOT NULL/,
    t("T44: 표식 삭제 문장에 confirmed_at IS NOT NULL 이 없다"));
  assert.ok(src.includes("DELETIONS_SWEEP_SQL"), t("T44: cleanup 이 그 상수를 쓰지 않는다"));

  // ⛔ 안 풀린 lease 는 남긴다 — 「진행 중이던 작업이 죽었다」는 신호이고, 지우면 그 사실이 사라진다.
  assert.equal(env.LEDGER._db.prepare("SELECT COUNT(*) n FROM write_leases WHERE lease_id='lease-stuck'").get().n, 1,
    t("T44: 해제되지 않은 lease 를 지웠다 — 죽은 작업의 흔적이 사라진다"));
  assert.equal(env.LEDGER._db.prepare("SELECT COUNT(*) n FROM write_leases WHERE lease_id='lease-done'").get().n, 0,
    t("T44: 해제되고 만료된 lease 가 안 지워졌다"));
}

// ══ T45. 만료된 소비 표식만 ══════════════════════════════════════════════
{
  const env = env0(), now = Date.now();
  seed(env, now);
  await runCleanup(env, now);
  assert.equal(dc(env, "consumed_signup_states", "WHERE state_hash='css-old'"), 0, t("T45: 만료된 표식이 안 지워졌다"));
  // ★ 만료 **전에** 지우면 그 순간 replay 창이 다시 열린다.
  assert.equal(dc(env, "consumed_signup_states", "WHERE state_hash='css-new'"), 1,
    t("T45: 아직 안 만료된 소비 표식을 지웠다 — replay 창이 다시 열린다"));
  // 세션·리미터도 같은 규칙.
  assert.equal(dc(env, "sessions", "WHERE token_hash='h-old'"), 0, t("T45: 만료 세션이 안 지워졌다"));
  assert.equal(dc(env, "sessions", "WHERE token_hash='h-rev'"), 0, t("T45: 폐기 세션이 안 지워졌다"));
  assert.equal(dc(env, "sessions", "WHERE token_hash='h-live'"), 1, t("T45: 살아 있는 세션을 지웠다"));
  assert.equal(dc(env, "rate_limits", "WHERE bucket='rl-old'"), 0, t("T45: 만료 리미터 행이 안 지워졌다"));
  assert.equal(dc(env, "rate_limits", "WHERE bucket='rl-new'"), 1, t("T45: 살아 있는 리미터 행을 지웠다"));
  // 계정 자체는 **절대** 안 건드린다.
  assert.equal(dc(env, "users"), 1, t("T45: 정리가 계정을 지웠다"));
}

// ══ T46. 재실행 안전 ═════════════════════════════════════════════════════
{
  const env = env0(), now = Date.now();
  seed(env, now);
  const a = await runCleanup(env, now);
  const snap = () => JSON.stringify([
    env.LEDGER._db.prepare("SELECT mark FROM deletions ORDER BY mark").all(),
    env.DB._db.prepare("SELECT state_hash FROM consumed_signup_states ORDER BY state_hash").all(),
    env.DB._db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all(),
  ]);
  const after1 = snap();
  const b = await runCleanup(env, now);       // 크론은 재시도될 수 있다
  assert.equal(snap(), after1, t("T46: 두 번째 실행이 상태를 또 바꿨다"));
  assert.equal(Object.values(b.counts).reduce((x, y) => x + y, 0), 0, t("T46: 두 번째 실행이 또 지웠다"));
  assert.ok(Object.values(a.counts).reduce((x, y) => x + y, 0) > 0, t("T46: 첫 실행이 아무것도 안 지웠다"));
}

// ══ T47. 유지보수·복원 중에는 아무것도 안 한다 ═══════════════════════════
{
  for (const mode of ["maintenance", "restore_closed"]) {
    const env = env0(), now = Date.now();
    seed(env, now);
    env.LEDGER._db.exec(`UPDATE maintenance SET mode = '${mode}' WHERE id = 1`);
    const before = JSON.stringify([
      env.LEDGER._db.prepare("SELECT mark FROM deletions ORDER BY mark").all(),
      env.DB._db.prepare("SELECT state_hash FROM consumed_signup_states ORDER BY state_hash").all(),
      env.DB._db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all(),
      env.DB._db.prepare("SELECT bucket FROM rate_limits ORDER BY bucket").all(),
    ]);
    const out = await runCleanup(env, now);
    // ★ 복원 중 정리가 겹치면 reconciliation 과 경합한다. 그 자리에서 끝낸다.
    assert.equal(out.skipped, mode, t(`T47: ${mode} 인데 건너뛰지 않았다`));
    assert.equal(out.counts, undefined, t(`T47: ${mode} 인데 무언가를 지웠다`));
    assert.equal(JSON.stringify([
      env.LEDGER._db.prepare("SELECT mark FROM deletions ORDER BY mark").all(),
      env.DB._db.prepare("SELECT state_hash FROM consumed_signup_states ORDER BY state_hash").all(),
      env.DB._db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all(),
      env.DB._db.prepare("SELECT bucket FROM rate_limits ORDER BY bucket").all(),
    ]), before, t(`T47: ${mode} 인데 상태가 바뀌었다`));
  }
}

// ══ 관측과 안전 요구사항 ═════════════════════════════════════════════════
{
  const env = env0(), now = Date.now();
  seed(env, now);
  // 실패해도 **보상성 대량 삭제를 하지 않는다.** 정리 로직의 버그가 곧 데이터 손실이 되면 안 된다.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker/cleanup/index.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // 모든 삭제 문장에 시각 조건이 있다. 조건 없는 DELETE 는 하나도 없어야 한다.
  for (const stmt of src.match(/DELETE\s+FROM\s+\w+[^`]*/gi) || []) {
    assert.match(stmt, /WHERE/i, t(`조건 없는 DELETE 가 있다: ${stmt.slice(0, 60)}`));
    assert.match(stmt, /LIMIT/i, t(`LIMIT 없는 DELETE 가 있다 — 10ms CPU 한도를 넘을 수 있다: ${stmt.slice(0, 60)}`));
  }
  // 보안 난수에 Math.random 을 쓰지 않는다. passThroughOnException 도 쓰지 않는다.
  assert.ok(!/Math\.random/.test(src), t("cleanup 이 Math.random 을 쓴다"));
  assert.ok(!/passThroughOnException/.test(src), t("cleanup 이 passThroughOnException 을 쓴다"));
  // 요청별 상태를 모듈 전역 가변 변수에 두지 않는다(크론은 같은 인스턴스에서 여러 번 돈다).
  assert.ok(!/^\s*let\s+\w+\s*=/m.test(src.replace(/^\s*let .* of .*$/gm, "")),
    t("cleanup 에 모듈 전역 가변 변수가 있다"));
  // 계정 생성·세션 발급 코드가 없다.
  for (const bad of [/INSERT INTO users/i, /INSERT INTO sessions/i, /INSERT INTO books/i]) {
    assert.ok(!bad.test(src), t(`cleanup 에 ${bad} 가 있다 — 정리 Worker 가 데이터를 만들면 안 된다`));
  }
  // 오류 로그에 개인정보가 실리지 않는다(자르고, 값이 아니라 이유만 남긴다).
  assert.match(src, /slice\(0,\s*\d+\)/, t("cleanup 이 오류 문자열을 안 자른다"));

  // scheduled() 가 Promise 를 추적한다 — 안 하면 잠들면서 쓰기가 중간에 끊긴다.
  assert.match(src, /ctx\.waitUntil\(/, t("scheduled 가 ctx.waitUntil 로 추적하지 않는다"));

  // 실행 기록. 「돌았나」를 사람이 볼 수 있어야 한다 — 기록이 없으면 안 돈 것과 구분되지 않는다.
  const { default: cleanup } = await import("../worker/cleanup/index.js");
  const waits = [];
  await cleanup.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const run = env.LEDGER._db.prepare("SELECT * FROM cleanup_runs WHERE id = 1").get();
  assert.ok(run.last_ok_at, t("마지막 성공 시각을 안 적었다"));
  assert.equal(run.fail_streak, 0, t("성공했는데 연속 실패가 0이 아니다"));
  assert.ok(JSON.parse(run.last_counts).sessions >= 0, t("대상별 삭제 행 수를 안 적었다"));

  // 실패하면 연속 실패가 오르고, **아무것도 지우지 않는다.**
  const bad = { DB: env.DB, LEDGER: { ...env.LEDGER, _db: env.LEDGER._db,
    prepare: (sql) => sql.includes("cleanup_runs")
      ? env.LEDGER.prepare(sql)
      : { bind: () => ({ run: async () => { throw new Error("boom"); },
                         first: async () => { throw new Error("boom"); } }),
          first: async () => { throw new Error("boom"); } } } };
  const w2 = [];
  await cleanup.scheduled({}, bad, { waitUntil: (p) => w2.push(p) });
  await Promise.all(w2);
  const run2 = env.LEDGER._db.prepare("SELECT * FROM cleanup_runs WHERE id = 1").get();
  assert.equal(run2.fail_streak, 1, t("실패했는데 연속 실패가 안 올랐다"));
  assert.ok(run2.last_error && run2.last_error.length <= 120, t("오류 문자열을 안 자르거나 안 적었다"));
}

// ══ 정리 Worker 는 인터넷에 아무것도 열지 않는다 ══════════════════════════
// 재현(2026-08-18): `fetch` 핸들러의 `/status` 가 인증 없이 `cleanup_runs` 를 통째로 돌려줬다 —
// 최근 실패 사유·대상별 삭제 건수·미확정 pending 수·마지막 실행 시각이 전부 나갔다.
// 게다가 설정에 route 도 `workers_dev:false` 도 없었고 `workers_dev` 의 기본값은 `true` 다.
{
  const { readFileSync } = await import("node:fs");
  const cleanup = await import("../worker/cleanup/index.js");
  assert.equal(typeof cleanup.default.fetch, "undefined",
    t("정리 Worker 에 fetch 핸들러가 생겼다 — cron 전용 Worker 는 HTTP 를 열지 않는다"));
  assert.equal(typeof cleanup.default.scheduled, "function", t("scheduled 핸들러가 없어졌다"));
  const cfg = readFileSync(new URL("../worker/cleanup/wrangler.jsonc", import.meta.url), "utf8");
  assert.match(cfg, /"workers_dev"\s*:\s*false/,
    t("wrangler 설정에 workers_dev:false 가 없다 — 기본값 true 로 workers.dev 주소가 열린다"));
  assert.ok(!/"routes?"\s*:/.test(cfg), t("정리 Worker 에 route 가 생겼다 — HTTP 를 열지 않기로 했다"));
  // 소스에도 HTTP 응답을 만드는 자리가 없어야 한다(주석은 뺀다 — 규칙을 적어 둔 것까지 벌하지 않는다).
  const src = readFileSync(new URL("../worker/cleanup/index.js", import.meta.url), "utf8")
    .split("\n").filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join("\n");
  assert.ok(!/new Response\(/.test(src), t("정리 Worker 가 Response 를 만든다 — 응답할 상대가 없다"));
}

console.log(`test-cleanup: ${n}개 통과 — confirmed 만 삭제(pending 보존) · 만료 전 소비 표식 보존 · `
  + `안 풀린 lease 보존 · 재실행 안전 · maintenance/restore_closed 즉시 종료 · `
  + `LIMIT·조건 전수 · 실행 기록과 연속 실패 · HTTP 미공개(fetch 핸들러·workers_dev·route 없음)`);
