// 정리 전용 Worker. `node scripts/test-cleanup.mjs`
//
// 재는 것: **지워도 되는 것만 지우는가.** 이 Worker 의 위험은 「못 지우는 것」이 아니라
// 「잘못 지우는 것」이다 — 못 지운 것은 다음 회차에 지우면 되지만, 잘못 지운 것은 되돌릴 수 없다.
//
// 설계서 §13-5 의 T44~T47 을 구현한다.
import assert from "node:assert";
import { runCleanup } from "../worker/cleanup/index.js";
import { DELETIONS_SWEEP_SQL, drainState, acquireLease, releaseLease,
         LEASE_MODES_REQUEST, LEASE_MODES_CLEANUP } from "../worker/ledger.js";
import { setMode, drainReport, restoreGate, beginRestore } from "../worker/ops.js";
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
  // ⛔ 해제되지 않은 임차증. 만료됐어도 **남긴다** — 자동으로 지우는 경로가 없어야 한다.
  L.exec(`INSERT INTO write_leases VALUES ('lease-stuck',1,1,${now - 1})`);
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
  //    해제가 행 삭제로 바뀐 뒤(결정 A′) 이 표에 남은 행은 **전부** 그 신호라, 정리 대상이
  //    아예 없어야 한다. 자기가 딴 임차증만 풀고 나간다.
  assert.deepEqual(env.LEDGER._db.prepare("SELECT lease_id FROM write_leases").all(), [{ lease_id: "lease-stuck" }],
    t("T44: 정리가 write_leases 를 건드렸다 — 남은 행은 전부 「아직 안 끝났다」의 증거다"));
  assert.ok(!/write_leases/.test(src),
    t("T44: cleanup 이 write_leases 를 지우는 문장을 갖고 있다 — stale 증거가 시간으로 사라진다"));
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

// ══ T47b. ★ 정리 크론도 임차증을 든다 ════════════════════════════════════
// 재현(2026-08-18, 이 블록이 처음 빨갛게 만든 것):
//   `runCleanup()` 은 `mode='open'` 을 **읽고 나서** 주 D1 을 지웠고, 그 사이에 임차증이 없었다.
//   ① 첫 주 D1 DELETE 직전에 세운다 ② `restore_closed` 로 전환한다 ③ `drainState()` 가
//   `open:0 · drained:true` 라고 답한다 ④ 크론이 재개해 **restore_closed 인데도** 주 D1 행을 지운다.
//   즉 A′ 의 「사용자 데이터를 만지는 작업은 전부 추적된다」가 **거짓이었다** — A′ 는
//   worker/index.js 의 HTTP 요청만 봤고, Scheduled Worker 는 추적 밖에 있었다.
//
// 무엇이 옳은 동작인가: **중간에 끊는 것이 아니다.** HTTP 요청과 같다 — 이미 시작한 일은
// 끝나되, 끝날 때까지 drain 이 0 이 아니어서 **복원이 시작될 수 없어야** 한다.
{
  const env = env0(), now = Date.now();
  seed(env, now);
  // ⚠️ `seed()` 가 심는 `lease-stuck` 을 걷어낸다. 남겨 두면 활성 임차증이 **처음부터 1** 이라
  //    아래의 `open === 1` 이 크론과 무관하게 참이 되어 **아무것도 재지 못한다**(첫 작성 때 실제로
  //    그렇게 통과했다). 재현은 0 에서 시작해야 한다.
  env.LEDGER._db.exec("DELETE FROM write_leases");

  // 첫 주 D1 DELETE 를 `hold` 가 풀릴 때까지 세운다. 셰임을 고치지 않고 바깥에서 감싼다 —
  // 재려는 것은 sqlite 가 아니라 **runCleanup 의 순서**다.
  let release;
  const held = new Promise((r) => { release = r; });
  let reached; const reachedFirst = new Promise((r) => { reached = r; });
  const realDB = env.DB;
  let paused = false;
  // 주 D1 을 **처음 건드리는 순간** 임차증이 이미 있었나. 읽기·쓰기를 가리지 않고 첫 접근이다 —
  // 그래서 「지연된 읽기」를 위한 별도 테스트가 필요 없다(정리의 주 D1 접근은 전부 이 뒤에 있다).
  let leasesAtFirstTouch = null;
  env.DB = {
    ...realDB,
    prepare(sql) {
      if (leasesAtFirstTouch === null)
        leasesAtFirstTouch = env.LEDGER._db.prepare("SELECT COUNT(*) n FROM write_leases").get().n;
      const st = realDB.prepare(sql);
      if (!paused && /^\s*DELETE/i.test(sql)) {
        paused = true;
        const orig = st.run.bind(st);
        st.run = async (...a) => { reached(); await held; return orig(...a); };
      }
      return st;
    },
  };

  const running = runCleanup(env, now);
  await reachedFirst;                       // 고정 sleep 이 아니다 — 실제로 그 자리에 왔을 때만 진행한다

  // ① 주 D1 **첫 접근** 시점에 임차증이 이미 있었다. 게이트만 읽고 들어간 옛 코드는 여기서 0이다.
  assert.equal(leasesAtFirstTouch, 1,
    t("T47b: 임차증을 따기 전에 주 D1 을 건드렸다 — 그 사이의 접근은 추적 밖이다"));

  // ② 그 사이에 복원 준비로 전환한다.
  await setMode(env, "restore_closed", { now });

  // ③ ★ 여기가 재현의 심장이다. 크론이 주 D1 을 만지는 **도중인데** drain 이 0 이면
  //    운영자는 「모두 멈췄다」고 읽고 복원을 시작한다.
  const mid = await drainState(env, now);
  assert.equal(mid.open, 1,
    t("T47b: ★ 정리 크론이 주 D1 을 지우는 중인데 활성 임차증이 0이다 — drain 이 거짓말을 한다"));
  assert.equal(mid.drained, false, t("T47b: 작업이 도는 중인데 drained:true 다"));
  const rep = await drainReport(env, now);
  assert.equal(rep.state.noActiveLeases, false,
    t("T47b: 크론이 도는 중인데 noActiveLeases 가 참이다"));
  assert.throws(() => beginRestore(rep), (e) => e.code === "RESTORE_FORBIDDEN",
    t("T47b: 크론이 도는 중인데 복원 절차가 시작됐다"));
  assert.ok(restoreGate(rep).missing.some((x) => x.startsWith("noActiveLeases")),
    t("T47b: 미충족 사유에 noActiveLeases 가 없다 — 다른 조건에 가려 이 경합이 안 보인다"));

  // ④ 끝난 뒤에**만** 0 이 된다.
  release();
  await running;
  assert.equal((await drainState(env, now)).open, 0,
    t("T47b: 크론이 끝났는데 임차증이 남아 있다 — 해제가 가장 바깥 finally 에 없다"));

  // ⑤ **전환 이후에 시작하는** 크론은 주 D1 을 한 줄도 만지지 않는다.
  const before = JSON.stringify([
    env.DB._db.prepare("SELECT bucket FROM rate_limits ORDER BY bucket").all(),
    env.DB._db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all(),
  ]);
  let touched = 0;
  const env2 = { ...env, DB: { ...realDB, prepare(sql) { touched++; return realDB.prepare(sql); } } };
  const out2 = await runCleanup(env2, now);
  assert.ok(out2.skipped, t("T47b: restore_closed 인데 건너뛰지 않았다"));
  assert.equal(touched, 0,
    t("T47b: restore_closed 인데 주 D1 을 건드렸다 — 읽기 한 줄도 하면 안 된다"));
  assert.equal(JSON.stringify([
    env.DB._db.prepare("SELECT bucket FROM rate_limits ORDER BY bucket").all(),
    env.DB._db.prepare("SELECT token_hash FROM sessions ORDER BY token_hash").all(),
  ]), before, t("T47b: restore_closed 인데 주 D1 행이 바뀌었다"));
  assert.equal((await drainState(env, now)).open, 0,
    t("T47b: 임차증을 못 딴 크론이 임차증을 남겼다"));
}

// ══ T47d. HTTP 요청과 정리 크론의 허용 모드가 섞이지 않는다 ══════════════
// 둘은 같은 임차증을 쓰지만 **같은 규칙이 아니다.** `maintenance` 는 읽기를 허용하는 상태라
// HTTP 요청은 계속 추적돼야 하고(안 그러면 허용된 읽기가 추적 밖에서 돈다), 크론은 그때
// **아예 시작하지 않는다**(급하지 않다. 다음 시간에 돌면 된다).
// 한쪽 상수를 다른 쪽에 잘못 넘기면 여기서 걸린다.
{
  const env = env0(), now = Date.now();
  seed(env, now);
  env.LEDGER._db.exec("DELETE FROM write_leases");
  env.LEDGER._db.exec("UPDATE maintenance SET mode = 'maintenance' WHERE id = 1");

  const reqLease = await acquireLease(env, LEASE_MODES_REQUEST, now);
  assert.ok(reqLease, t("T47d: maintenance 인데 HTTP 요청이 임차증을 못 딴다 — 허용된 읽기가 추적 밖에서 돈다"));
  await releaseLease(env, reqLease);
  assert.equal(await acquireLease(env, LEASE_MODES_CLEANUP, now), null,
    t("T47d: maintenance 인데 정리 크론이 임차증을 땄다 — 복원 준비 중에 크론이 주 D1 을 지운다"));

  // restore_closed 에서는 **둘 다** 거부된다. 그래야 활성 수가 0 으로 내려간다.
  env.LEDGER._db.exec("UPDATE maintenance SET mode = 'restore_closed' WHERE id = 1");
  for (const [name, modes] of [["요청", LEASE_MODES_REQUEST], ["크론", LEASE_MODES_CLEANUP]]) {
    assert.equal(await acquireLease(env, modes, now), null,
      t(`T47d: restore_closed 인데 ${name} 이 임차증을 땄다`));
  }
  assert.ok(!LEASE_MODES_REQUEST.includes("restore_closed") && !LEASE_MODES_CLEANUP.includes("restore_closed"),
    t("T47d: 허용 모드 목록에 restore_closed 가 들어갔다"));

  // 검증되지 않은 모드 문자열은 **던진다.** 조용히 통과시키면 SQL 이 아무것도 안 매치해
  // 「그냥 임차증을 못 땄다」로 보이고, 그건 오타를 정상 동작으로 만드는 길이다.
  for (const bad of [[], ["oepn"], "open", null]) {
    await assert.rejects(() => acquireLease(env, bad, now), t(`T47d: 잘못된 모드(${JSON.stringify(bad)})를 통과시켰다`));
  }

  // 호출부가 서로의 상수를 집어 들지 않았나. 정규식은 완전한 증명이 아니지만, 이름을 바꿔
  // 붙이는 실수는 위 런타임 검사 전에 여기서 먼저 걸린다.
  const { readFileSync } = await import("node:fs");
  const http = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");
  const cron = readFileSync(new URL("../worker/cleanup/index.js", import.meta.url), "utf8");
  assert.ok(http.includes("LEASE_MODES_REQUEST") && !http.includes("LEASE_MODES_CLEANUP"),
    t("T47d: worker/index.js 가 크론 규칙을 쓴다 — maintenance 중 요청이 추적 밖으로 나간다"));
  assert.ok(cron.includes("LEASE_MODES_CLEANUP") && !cron.includes("LEASE_MODES_REQUEST"),
    t("T47d: 정리 크론이 요청 규칙을 쓴다 — maintenance 중에도 주 D1 을 지운다"));
}

// ══ T47c. ledger 가 대답을 못 하면 주 D1 을 만지지 않는다 ═════════════════
// 「모른다」를 「열림」으로 읽지 않는다. 게이트를 읽을 수 없거나 임차증을 딸 수 없으면
// 정리는 **아무것도 하지 않고** 끝난다 — 지우지 못한 것은 다음 회차에 지우면 된다.
{
  const env = env0(), now = Date.now();
  seed(env, now);
  let touched = 0;
  const realDB = env.DB;
  const env2 = { DB: { ...realDB, prepare(sql) { touched++; return realDB.prepare(sql); } },
                 LEDGER: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("boom"); },
                                                            first: async () => { throw new Error("boom"); } }),
                                             first: async () => { throw new Error("boom"); } }) } };
  await assert.rejects(() => runCleanup(env2, now), t("T47c: ledger 가 죽었는데 정리가 성공했다고 답한다"));
  assert.equal(touched, 0, t("T47c: ledger 오류인데 주 D1 을 건드렸다"));
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
  // ⚠️ `Promise.all` 이 아니다 — 이제 실패한 회차는 **의도적으로 거부된다**(T49). `all` 로 받으면
  //    그 거부가 여기서 테스트를 통째로 끝내 아래 상태 검사가 실행되지 않는다.
  await Promise.allSettled(w2);
  const run2 = env.LEDGER._db.prepare("SELECT * FROM cleanup_runs WHERE id = 1").get();
  assert.equal(run2.fail_streak, 1, t("실패했는데 연속 실패가 안 올랐다"));
  assert.ok(run2.last_error && run2.last_error.length <= 120, t("오류 문자열을 안 자르거나 안 적었다"));
}

// ══ T49. 실패는 실패로 끝나고, 밖으로 나가는 신호는 boolean 하나다 ═══════
// 재현(2026-08-18): `tick()` 이 실패를 잡아 `cleanup_runs` 에 적은 뒤 **예외를 삼켰다.**
//   3회 연속 실패를 주입해도 `ctx.waitUntil()` 의 Promise 는 셋 다 `fulfilled` 였다 —
//   Cloudflare 는 그 Promise 의 거부로 Cron Trigger 실패를 적으므로, 대시보드의 Past Events 에는
//   실패가 **성공 세 줄**로 남는다. 그리고 `/api/ready` 는 `fail_streak`·`open_pending` 을
//   읽고도 버려서, D1 을 직접 조회하지 않는 한 아무 데서도 보이지 않았다.
//   즉 C6 의 「지우지 않는다. 세어서 알린다」 중 **「센다」만** 구현된 상태였다.
{
  const { default: worker } = await import("../worker/index.js");
  const { default: cleanup } = await import("../worker/cleanup/index.js");
  const ORIGIN = "https://app.test";
  const ready = async (env) => await (await worker.fetch(
    new Request("https://api.test/ready", { headers: { Origin: ORIGIN } }),
    { APP_ORIGIN: ORIGIN, ...env })).json();
  // 크론 한 회차. **결과를 삼키지 않고 돌려준다** — 재려는 것이 바로 그 Promise 의 상태다.
  const run = async (env) => {
    const w = [];
    await cleanup.scheduled({}, env, { waitUntil: (p) => w.push(p) });
    assert.equal(w.length, 1, t("T49: scheduled 가 ctx.waitUntil 로 추적하는 Promise 가 하나가 아니다"));
    return (await Promise.allSettled(w))[0];
  };
  const row = (env) => env.LEDGER._db.prepare("SELECT * FROM cleanup_runs WHERE id = 1").get();
  // `cleanup_runs` 만 답하고 나머지는 터지는 ledger = 「정리가 실패했다」. 기록은 되어야
  // fail_streak 을 잴 수 있다(기록조차 못 하는 경우는 아래에서 따로 잰다).
  const boom = () => { throw new Error("boom: no such table deletions"); };
  const failing = (env) => ({ DB: env.DB, LEDGER: { ...env.LEDGER, _db: env.LEDGER._db,
    prepare: (sql) => sql.includes("cleanup_runs") ? env.LEDGER.prepare(sql)
      : { bind: () => ({ run: boom, first: boom }), first: boom } } });

  // ① 정상. **pending 을 심지 않는다** — 심으면 경보가 켜져서 아래 임계값 검사가 가려진다.
  const env = env0();
  assert.equal((await run(env)).status, "fulfilled", t("T49: 정상 실행인데 Cron Promise 가 거부됐다"));
  {
    const r = await ready(env);
    assert.equal(r.cleanupStale, false, t("T49: 방금 성공했는데 cleanupStale 이다"));
    assert.equal(r.cleanupAlert, false, t("T49: 정상인데 경보가 켜져 있다 — 경보가 늘 켜져 있으면 아무도 안 본다"));
  }

  // ② 1·2·3회 연속 실패. **임계값은 3이다** — 1~2회는 D1 의 일시 오류로도 난다.
  const f = failing(env);
  for (const k of [1, 2, 3]) {
    const res = await run(f);
    assert.equal(res.status, "rejected",
      t(`T49: ★ ${k}회째 실패인데 Cron Promise 가 성공으로 끝났다 — 대시보드에 실패가 안 남는다`));
    const why = String(res.reason && res.reason.message);
    for (const leak of ["boom", "no such table", "SELECT", "deletions", "cleanup_runs"])
      assert.ok(!why.includes(leak), t(`T49: 밖으로 던진 오류에 '${leak}' 가 실렸다`));
    assert.equal(row(env).fail_streak, k, t(`T49: ${k}회 실패인데 연속 실패가 ${row(env).fail_streak} 이다`));
    assert.ok(row(env).last_error.length <= 120, t("T49: 기록한 오류 문자열을 안 잘랐다"));
    // ★ off-by-one. 2회에서 켜지면 임계값이 2고, 3회에서 안 켜지면 4다.
    assert.equal((await ready(env)).cleanupAlert, k >= 3,
      t(`T49: 연속 실패 ${k}회의 경보가 틀렸다 — 임계값이 3이 아니다`));
  }

  // ③ 기록조차 못 해도 **실행은 실패로 끝난다.** 기록 실패를 이유로 성공 처리하면
  //    ledger 가 통째로 죽은 날 크론은 계속 「성공」이라고 답한다.
  {
    const dead = { DB: env.DB, LEDGER: { prepare: () => ({ bind: () => ({ run: boom, first: boom }), first: boom }) } };
    assert.equal((await run(dead)).status, "rejected",
      t("T49: 기록에 실패하니 실행이 성공으로 끝났다 — ledger 가 죽은 날 크론이 정상으로 보인다"));
  }

  // ④ **성공이 pending 문제를 덮지 않는다.** 크론은 성공했고, 표식은 그대로 있고, 경보는 켜진다.
  const env2 = env0(), now2 = Date.now();
  seed(env2, now2);
  assert.equal((await run(env2)).status, "fulfilled", t("T49: pending 이 있다고 실행이 실패했다"));
  assert.equal(row(env2).fail_streak, 0, t("T49: 성공했는데 연속 실패가 0이 아니다"));
  assert.equal(row(env2).open_pending, 1, t("T49: 확정 안 된 표식을 안 셌다"));
  assert.equal(lc(env2, "WHERE mark = 'pend-old'"), 1, t("T49: 확정 안 된 표식을 지웠다"));
  {
    const r = await ready(env2);
    assert.equal(r.cleanupStale, false, t("T49: 방금 성공했는데 cleanupStale 이다"));
    assert.equal(r.cleanupAlert, true,
      t("T49: ★ 확정 안 된 표식이 있는데 경보가 없다 — 「센다」만 하고 「알린다」가 빠졌다"));
    // ⛔ 공개 응답에 운영 정보가 실리지 않는다. 이 응답은 인증 없이 열려 있다.
    const txt = JSON.stringify(r);
    for (const leak of ["open_pending", "fail_streak", "last_error", "last_counts",
                        "pend-old", "deletions", "cleanup_runs", "boom", "SELECT"])
      assert.ok(!txt.includes(leak), t(`T49: /ready 응답에 '${leak}' 가 새어 나왔다`));
  }
  // 다시 성공해도 그대로 켜져 있다 — 사람이 판정할 때까지 꺼지지 않는다.
  assert.equal((await run(env2)).status, "fulfilled", t("T49: 두 번째 정상 실행이 실패했다"));
  assert.equal((await ready(env2)).cleanupAlert, true,
    t("T49: 성공 한 번에 pending 경보가 꺼졌다 — 크론 성공이 삭제 문제 해결로 읽힌다"));

  // ⑤ 복구. 실패가 멈추고 pending 이 없으면 경보도 꺼진다(안 꺼지면 아무도 안 본다).
  assert.equal((await run(env)).status, "fulfilled", t("T49: 복구 실행이 실패했다"));
  assert.equal(row(env).fail_streak, 0, t("T49: 복구했는데 연속 실패가 안 내려갔다"));
  assert.equal(row(env).last_error, null, t("T49: 복구했는데 마지막 오류가 남아 있다"));
  assert.equal((await ready(env)).cleanupAlert, false, t("T49: 복구했는데 경보가 안 꺼진다"));

  // ⑥ **「모른다」를 「괜찮다」로 읽지 않는다.** ledger 는 붙어 있는데 상태를 못 읽으면 경보다.
  const env3 = env0();
  const blind = { ...env3, LEDGER: { ...env3.LEDGER, _db: env3.LEDGER._db,
    prepare: (sql) => /FROM cleanup_runs/.test(sql)
      ? { bind: () => ({ first: boom }), first: boom } : env3.LEDGER.prepare(sql) } };
  assert.equal((await ready(blind)).cleanupAlert, true,
    t("T49: 정리 상태를 못 읽는데 경보가 꺼져 있다 — 표가 깨진 배포가 정상으로 보인다"));
  const env4 = env0();
  env4.LEDGER._db.exec("DELETE FROM cleanup_runs");
  assert.equal((await ready(env4)).cleanupAlert, true,
    t("T49: 실행 기록 행이 아예 없는데 경보가 꺼져 있다 — 한 번도 안 돈 크론이 정상으로 보인다"));
  // ledger 바인딩 자체가 없으면 말할 것이 없다(`cleanupStale` 과 같은 규칙).
  const noLedger = await ready({ ...env0(), LEDGER: undefined });
  assert.equal(noLedger.cleanupAlert, false, t("T49: ledger 바인딩이 없는데 정리 경보를 낸다"));
  assert.equal(noLedger.cleanupStale, false, t("T49: ledger 바인딩이 없는데 cleanupStale 이다"));
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
  const cfg = readFileSync(new URL("../worker/cleanup/wrangler.example.jsonc", import.meta.url), "utf8");
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
  + `크론도 임차증(주 D1 첫 접근 전 획득 · 도는 중 drained:false · 끝난 뒤에만 0) · `
  + `허용 모드 분리(요청/크론) · ledger 오류 시 주 D1 접근 0건 · `
  + `LIMIT·조건 전수 · 실행 기록과 연속 실패 · HTTP 미공개(fetch 핸들러·workers_dev·route 없음) · `
  + `실패한 회차의 Cron Promise 거부 · 연속 실패 3회 경보 · pending 경보는 성공이 안 덮음 · `
  + `정리 상태를 못 읽으면 fail-closed · /ready 는 boolean 만(개수·오류 비공개)`);
