// 삭제 표식 · 유지보수 · 복원 방어. `node scripts/test-deletion-ledger.mjs`
//
// 재는 것: **지운 사람이 복원으로 되살아났을 때 다시 지울 근거가 남는가**, 그리고
// 그 근거를 만드는 절차가 **중간에 죽어도 안전한가**.
//
// ⚠️ 진짜 `time-travel restore` 를 부르지 않는다. 두 sqlite 인스턴스를 만들어
//    「지금 것」과 「복원된 과거 것」을 흉내내고, 병합은 **순수 함수**로 부른다.
//
// 설계서 §13-5 의 T1~T3 · T5 · T7 · T9~T17 · T36~T39 을 구현한다
// (T4 · T6 · T8 · T40~T43 은 HTTP 계층이라 test-friends.mjs 에 있다).
import assert from "node:assert";
import worker, { createAccountWithPolicy, newSession } from "../worker/index.js";
import {
  deletionMark, DELETION_KEY_VERSION, acquireLease, leaseAlive, releaseLease, activeLeases,
  markPending, markConfirmed, sweepConfirmed, pendingAlertCount, pendingTotalCount,
  CONFIRMED_RETENTION, PENDING_ALERT,
  drainState, rememberDeletionKey,
} from "../worker/ledger.js";
import {
  setMode, markDrained, reconcile, removeStalePending, mergeDeletions, restoreTargets,
  scanUserMarks, restoreGate, beginRestore, RESTORE_CONDITIONS, RESTORE_STATE, reopenReport,
  drainReport, restorePreflight,
} from "../worker/ops.js";
import { makeD1, makeLedger } from "./_d1.mjs";

const ORIGIN = "https://app.test";
let n = 0;
const t = (m) => { n++; return m; };
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 3)).toString("base64url");

function makeEnv(extra = {}) {
  return { APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "k", RL_KEY: "r",
           SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tk", DELETION_KEY: "dk",
           DB: makeD1(), LEDGER: makeLedger(), ...extra };
}
const lrows = (env, sql, ...a) => env.LEDGER._db.prepare(sql).all(...a);
const lcount = (env, where = "") => env.LEDGER._db.prepare(`SELECT COUNT(*) n FROM deletions ${where}`).get().n;
const ucount = (env) => env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n;
let seq = 0;
const mkUser = async (env, sub = "u" + ++seq) => {
  const uid = await createAccountWithPolicy(env, "kakao", sub,
    { stateHash: "s-" + sub + Math.random(), stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  return { uid, token: await newSession(env, uid) };
};
const call = (env, token, path, method = "GET") => worker.fetch(new Request("https://api.test" + path, {
  method, headers: { Origin: ORIGIN, "Content-Type": "application/json",
                     ...(token ? { Cookie: "shh_s=" + token } : {}) },
}), env);

// ══ A. 정상 삭제와 표식 ══════════════════════════════════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env, "alpha");
  const mark = await deletionMark(env, A.uid);

  // A1. 표식은 **되돌릴 수 없고 uid 를 담지 않는다.**
  assert.ok(!mark.includes(A.uid), t("A1: 표식이 uid 를 담고 있다"));
  assert.notEqual(mark, await deletionMark({ ...env, DELETION_KEY: "other" }, A.uid),
    t("A1: 키를 바꿔도 표식이 같다 — 전용 키를 안 쓴다"));
  await assert.rejects(() => deletionMark({ ...env, DELETION_KEY: undefined }, A.uid),
    t("A1: 키 없이 표식을 만들었다 — 평문 해시로 되돌아가면 안 된다"));

  // A2. 정상 삭제 → 계정 없음 + **confirmed 표식**.
  assert.equal((await call(env, A.token, "/me", "DELETE")).status, 200, t("A2: 정상 삭제가 실패했다"));
  assert.equal(ucount(env), 0, t("A2: 계정이 안 지워졌다"));
  const row = lrows(env, "SELECT * FROM deletions")[0];
  assert.ok(row, t("A2: 표식이 안 남았다 — 복원하면 되살아나고 아무도 모른다"));
  assert.equal(row.mark, mark, t("A2: 표식 값이 다르다"));
  assert.ok(row.confirmed_at != null, t("A2: 확정 기록이 없다"));
  assert.equal(row.key_version, DELETION_KEY_VERSION, t("A2: key_version 이 없다"));
  // **expires_at 이 확정 시점 기준으로 다시 계산됐는가.** pending 때의 값은 임시값이다.
  assert.equal(row.expires_at, row.confirmed_at + CONFIRMED_RETENTION, t("A2: expires_at 을 다시 계산하지 않았다"));
  assert.equal(row.pending_alert_at, row.pending_at + PENDING_ALERT, t("A2: 경보 시각이 안 맞다"));
  // 표에 **개인정보가 없다.**
  assert.equal(Object.keys(row).sort().join(","),
    "confirmed_at,expires_at,key_version,mark,pending_alert_at,pending_at",
    t("A2: 표식 표에 컬럼이 늘었다 — 이 표에는 표식 하나만 있어야 한다"));
  // lease 는 해제됐다.
  assert.equal(await activeLeases(env), 0, t("A2: 삭제가 끝났는데 lease 가 살아 있다"));

  // A3. **ledger 나 키가 없으면 지우지 않는다.** 표식 없는 삭제가 이 설계가 막으려는 그것이다.
  const B = await mkUser(env, "beta");
  for (const miss of [{ LEDGER: undefined }, { DELETION_KEY: undefined }]) {
    const r = await call({ ...env, ...miss }, B.token, "/me", "DELETE");
    assert.equal(r.status, 503, t(`A3: ${Object.keys(miss)[0]} 없이 삭제가 진행됐다`));
  }
  assert.equal(ucount(env), 1, t("A3: 거부했는데 계정이 지워졌다"));
  // 세션이 살아 있어야 **그 자리에서 재시도**할 수 있다.
  assert.equal((await call(env, B.token, "/me")).status, 200, t("A3: 실패했는데 세션까지 죽었다"));
}

// ══ B. 실패 매트릭스 ═════════════════════════════════════════════════════
{
  // B1. pending 기록이 실패하면 **주 D1 을 건드리지 않는다.**
  const env = makeEnv();
  const A = await mkUser(env, "pfail");
  const realPrep = env.LEDGER.prepare.bind(env.LEDGER);
  env.LEDGER = { ...env.LEDGER, _db: env.LEDGER._db,
    prepare: (sql) => sql.includes("INSERT INTO deletions")
      ? { bind: () => ({ run: async () => { throw new Error("ledger down"); } }) } : realPrep(sql) };
  const r = await call(env, A.token, "/me", "DELETE");
  assert.equal(r.status, 500, t("B1: pending 이 실패했는데 성공이라 답했다"));
  assert.equal(ucount(env), 1, t("B1: pending 이 실패했는데 계정을 지웠다 — 표식 없는 삭제다"));
}
{
  // B2. 주 D1 삭제가 실패하면 **pending 은 남고 사용자는 재시도할 수 있다.**
  //     남는 쪽이 안전하다 — pending 은 어떤 경우에도 재삭제에 쓰이지 않기 때문이다.
  const env = makeEnv();
  const A = await mkUser(env, "dfail");
  const realDb = env.DB.prepare.bind(env.DB);
  env.DB = { ...env.DB, _db: env.DB._db, batch: env.DB.batch.bind(env.DB),
    prepare: (sql) => sql.startsWith("DELETE FROM users")
      ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : realDb(sql) };
  assert.equal((await call(env, A.token, "/me", "DELETE")).status, 500, t("B2: 삭제 실패를 성공이라 답했다"));
  assert.equal(ucount(env), 1, t("B2: 실패했는데 계정이 없다"));
  assert.equal(lcount(env), 1, t("B2: pending 표식이 안 남았다"));
  assert.equal(lrows(env, "SELECT * FROM deletions")[0].confirmed_at, null, t("B2: 확정으로 기록됐다"));
  assert.equal(await activeLeases(env), 0, t("B2: 실패했는데 lease 가 안 풀렸다"));
  // 세션이 살아 있어 그 화면에서 다시 누를 수 있다.
  assert.equal((await call(env, A.token, "/me")).status, 200, t("B2: 실패했는데 세션까지 죽었다"));
}
{
  // B3. **확정 기록만 실패하면 사용자에게는 성공이다.** 계정은 실제로 없다 —
  //     붙잡아 둘 이유가 없고, 나머지는 reconciliation 이 승격한다.
  const env = makeEnv();
  const A = await mkUser(env, "cfail");
  const realPrep = env.LEDGER.prepare.bind(env.LEDGER);
  env.LEDGER = { ...env.LEDGER, _db: env.LEDGER._db,
    prepare: (sql) => sql.includes("UPDATE deletions")
      ? { bind: () => ({ run: async () => { throw new Error("confirm down"); } }) } : realPrep(sql) };
  assert.equal((await call(env, A.token, "/me", "DELETE")).status, 200, t("B3: 계정이 지워졌는데 실패라 답했다"));
  assert.equal(ucount(env), 0, t("B3: 계정이 안 지워졌다"));
  assert.equal(lrows(env, "SELECT * FROM deletions")[0].confirmed_at, null, t("B3: 확정이 기록됐다"));
}

// ══ C. 유지보수 · lease · epoch (T1 · T2 · T3 · T5) ══════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env, "t1");
  const mark = await deletionMark(env, A.uid);

  // ── T1. saga 를 **주 D1 삭제 직전에 멈춘** 상태를 만든다.
  const lease = await acquireLease(env);
  assert.ok(lease, t("T1: 열려 있는데 lease 를 못 땄다"));
  assert.ok(await markPending(env, lease, mark), t("T1: pending 을 못 남겼다"));
  // 유지보수로 전환하고 epoch 를 올린다.
  const g = await setMode(env, "maintenance");
  assert.equal(g.mode, "maintenance", t("T1: 전환이 안 됐다"));
  // ★ **유지보수 전환은 in-flight 요청을 끝내지 못한다.** drain 카운트가 0이면 실패다.
  assert.equal(await activeLeases(env), 1,
    t("T1: 전환 직후 활성 lease 가 0이다 — 「막기 시작했다」를 「빠져나갔다」로 읽고 있다"));
  assert.equal(lcount(env), 1, t("T1: pending 표식이 사라졌다"));
  assert.equal(ucount(env), 1, t("T1: 계정이 이미 지워졌다"));
  assert.equal((await markDrained(env)).drained, false, t("T1: lease 가 살아 있는데 drain 됐다고 한다"));

  // ── T2. 그 상태에서 reconciliation 은 **거부된다.** 증거 없이는 실행하지 않는다.
  const rec = await reconcile(env);
  assert.equal(rec.ok, false, t("T2: 활성 lease 가 있는데 reconciliation 이 실행됐다"));
  assert.match(rec.why, /lease/, t("T2: 거부 사유가 lease 가 아니다"));
  assert.equal(lcount(env), 1, t("T2: 거부했는데 ledger 가 바뀌었다"));
  assert.equal(ucount(env), 1, t("T2: 거부했는데 계정이 바뀌었다"));

  // ── T5. ★ **옛 epoch 의 lease 로는 못 쓴다.** epoch 가 올랐으므로 fencing 이 막는다.
  assert.equal(await leaseAlive(env, lease), false,
    t("T5: 옛 epoch 의 lease 가 아직 살아 있다고 판정된다"));
  const before = JSON.stringify(lrows(env, "SELECT * FROM deletions"));
  assert.equal(await markConfirmed(env, lease, mark), false, t("T5: 옛 epoch 의 lease 로 확정이 기록됐다"));
  assert.equal(JSON.stringify(lrows(env, "SELECT * FROM deletions")), before, t("T5: ledger 가 바뀌었다"));
  // ── T5b. ★ **`maintenance` 에서는 새 임차증을 딸 수 있다. `restore_closed` 에서만 막힌다.**
  //   결정 A′(2026-08-18)로 바뀐 자리다. `maintenance` 는 **읽기를 허용하는 상태**라
  //   거기서 획득을 막으면 허용된 읽기가 추적 밖에서 돌고, 그러면 재려던 것을 못 잰다.
  //   대신 새 임차증은 **새 epoch** 를 달고 나오므로 옛 epoch 의 쓰기는 위 T5 대로 계속 막힌다.
  const midLease = await acquireLease(env);
  assert.ok(midLease, t("T5b: maintenance 인데 읽기용 임차증을 못 땄다 — 허용된 읽기가 추적 밖이 된다"));
  assert.equal(await leaseAlive(env, midLease), true, t("T5b: 새 임차증이 곧바로 죽어 있다"));
  await releaseLease(env, midLease);
  // restore_closed 에서는 **원자적으로 거부**된다 — 그래야 활성 수가 0 으로 내려간다.
  await setMode(env, "restore_closed");
  assert.equal(await acquireLease(env), null, t("T5b: restore_closed 인데 새 임차증을 땄다"));
  // ⚠️ **여기서 `setMode(env, "maintenance")` 를 부를 수 없다**(2026-08-19). `restore_closed` 에서
  //    읽기가 열리는 모드로 가는 길에는 전부 재개방 검증이 걸리고, 지금은 임차증도 pending 도
  //    남아 있어 정당하게 거부된다(재현 R1 · test-reaudit R1-b 가 그 전수 표를 잰다).
  //    이 블록이 재는 것은 임차증 획득이라, 게이트만 직접 되돌린다.
  await assert.rejects(() => setMode(env, "maintenance"), /읽기를 다시 열 수 없다/,
    t("T5b: restore_closed 에서 검증 없이 maintenance 로 옮겨졌다"));
  env.LEDGER._db.prepare("UPDATE maintenance SET mode = 'maintenance' WHERE id = 1").run();

  // ── T3. saga 를 정상 종료시킨다 → lease 해제 → reconciliation 허용.
  //   ⚠️ **T2 와 쌍으로 봐야** 「거부가 늘 거부」가 아님이 증명된다.
  await releaseLease(env, lease);
  assert.equal(await activeLeases(env), 0, t("T3: 해제했는데 lease 가 남았다"));
  const d = await markDrained(env);
  assert.equal(d.drained, true, t("T3: lease 0건인데 drain 이 아니라고 한다"));
  // 계정을 실제로 지운 뒤 승격이 일어나는지 본다(계정이 살아 있으면 승격하면 안 된다 — T37).
  env.DB._db.exec(`DELETE FROM users WHERE id = '${A.uid}'`);
  const rec2 = await reconcile(env);
  assert.equal(rec2.ok, true, t("T3: lease 0건인데 reconciliation 이 거부됐다"));
  assert.equal(rec2.promoted, 1, t("T3: 승격이 안 일어났다"));
  const row = lrows(env, "SELECT * FROM deletions")[0];
  assert.ok(row.confirmed_at != null, t("T3: 승격했는데 confirmed_at 이 없다"));
  assert.equal(row.expires_at, row.confirmed_at + CONFIRMED_RETENTION, t("T3: 승격 시 expires_at 재계산 안 했다"));
}

// ══ D. promote-only 와 살아 있는 계정 (T36 ~ T39) ════════════════════════
{
  // T36. pending + **계정 없음** → 승격. expires_at 은 산식으로 다시 계산한다(숫자 하드코딩 금지).
  const env = makeEnv();
  const A = await mkUser(env, "gone");
  const mark = await deletionMark(env, A.uid);
  const lease = await acquireLease(env);
  await markPending(env, lease, mark);
  await releaseLease(env, lease);
  env.DB._db.exec(`DELETE FROM users WHERE id = '${A.uid}'`);
  await setMode(env, "maintenance");
  const r = await reconcile(env);
  assert.equal(r.promoted, 1, t("T36: 계정이 없는 pending 이 승격되지 않았다"));
  const row = lrows(env, "SELECT * FROM deletions")[0];
  assert.equal(row.expires_at, row.confirmed_at + CONFIRMED_RETENTION, t("T36: expires_at 산식이 다르다"));
}
{
  // T37. ★ pending + **계정이 살아 있음** → **아무것도 하지 않는다.**
  //   살아 있는 계정의 pending 은 「실패 기록」이지 대기 중인 삭제 명령이 아니다.
  //   지우면 사용자가 「못 지웠어요」를 보고 계속 쓰던 계정이 예고 없이 사라진다.
  const env = makeEnv();
  const A = await mkUser(env, "alive");
  await call(env, A.token, "/book", "PUT");            // 실패 뒤에도 계속 쓴다
  const lease = await acquireLease(env);
  await markPending(env, lease, await deletionMark(env, A.uid));
  await releaseLease(env, lease);
  await setMode(env, "maintenance");
  const before = { l: JSON.stringify(lrows(env, "SELECT * FROM deletions")), u: ucount(env),
                   b: env.DB._db.prepare("SELECT COUNT(*) n FROM books").get().n,
                   f: env.DB._db.prepare("SELECT COUNT(*) n FROM friendships").get().n };
  const r = await reconcile(env);
  assert.equal(r.ok, true, t("T37: reconciliation 이 실행되지 않았다"));
  assert.equal(r.promoted, 0, t("T37: 살아 있는 계정의 pending 이 승격됐다"));
  assert.equal(r.kept, 1, t("T37: pending 이 그대로 남지 않았다"));
  assert.deepEqual({ l: JSON.stringify(lrows(env, "SELECT * FROM deletions")), u: ucount(env),
                     b: env.DB._db.prepare("SELECT COUNT(*) n FROM books").get().n,
                     f: env.DB._db.prepare("SELECT COUNT(*) n FROM friendships").get().n },
    before, t("T37: 살아 있는 계정의 pending 을 보고 무언가를 바꿨다"));

  // T38. ★ **옛 pending 으로 삭제 saga 를 다시 시작하는 경로가 없다.**
  //   운영 코드 어디에도 pending 을 근거로 `DELETE FROM users` 를 부르는 자리가 없어야 한다.
  const fs = await import("node:fs");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of ["worker/ops.js", "worker/cleanup/index.js", "worker/ledger.js"]) {
    const src = strip(fs.readFileSync(new URL("../" + f, import.meta.url), "utf8"));
    assert.ok(!/DELETE\s+FROM\s+users/i.test(src),
      t(`T38: ${f} 에 users 를 지우는 문장이 있다 — 새 삭제는 사용자의 새 요청으로만 시작한다`));
  }
  // 주 worker 에는 딱 하나 있고, 그건 **사용자의 DELETE /me** 안이다.
  const w = strip(fs.readFileSync(new URL("../worker/index.js", import.meta.url), "utf8"));
  assert.equal((w.match(/DELETE FROM users/g) || []).length, 1,
    t("T38: worker/index.js 에 users 삭제 문장이 하나가 아니다"));

  // T39. **조건이 빠진 수동 제거는 거부된다.**
  //   ⚠️ 「재확인 수단(mark 함수)이 없음」은 2026-08-19 부터 **경우의 수가 아니다** — 그 함수는
  //      이제 코드가 소유한다(호출자가 넘긴 함수가 삭제 증거를 정하던 것이 재현 R4 다).
  //      대신 「지금 키가 표식을 만든 키와 다름」이 새 거부 사유이고 test-reaudit R4-b 가 잰다.
  const marks = lrows(env, "SELECT mark FROM deletions").map((x) => x.mark);
  for (const [why, opts, envv] of [
    ["운영 판정 없음", { confirmedByOperator: false }, env],
    ["키가 다름", { confirmedByOperator: true }, { ...env, DELETION_KEY: "다른키" }],
  ]) {
    const rr = await removeStalePending(envv, marks, opts);
    assert.equal(rr.ok, false, t(`T39: ${why} 인데 제거가 실행됐다`));
  }
  assert.equal(lcount(env), 1, t("T39: 거부했는데 표식이 지워졌다"));
  // 조건을 다 채워도 **계정이 살아 있으면** 지운다 — 그것이 stale pending 의 정의다.
  const okRm = await removeStalePending(env, marks, { confirmedByOperator: true });
  assert.equal(okRm.removed, 1, t("T39: 조건을 다 채웠는데 제거되지 않았다"));
  // 반대로 **계정이 없으면 거부한다** — 그건 승격 대상이지 제거 대상이 아니다.
  const env2 = makeEnv();
  const C = await mkUser(env2, "vanished");
  const m2 = await deletionMark(env2, C.uid);
  const l2 = await acquireLease(env2);
  await markPending(env2, l2, m2);
  await releaseLease(env2, l2);
  env2.DB._db.exec(`DELETE FROM users WHERE id = '${C.uid}'`);
  await setMode(env2, "maintenance");
  const rr2 = await removeStalePending(env2, [m2], { confirmedByOperator: true });
  assert.equal(rr2.removed, 0, t("T39: 계정이 없는 pending 을 지웠다 — 표식 없는 삭제가 된다"));
  assert.equal(lcount(env2), 1, t("T39: 거부했는데 표식이 사라졌다"));
}

// ══ E. ledger 병합 (T9 ~ T14) ════════════════════════════════════════════
// 두 목록을 **순수 함수**로 병합한다. 진짜 restore 는 부르지 않는다.
{
  const base = (o = {}) => ({ mark: "m1", key_version: 1, pending_at: 100,
                              pending_alert_at: 200, confirmed_at: null, expires_at: 1000, ...o });
  const ok = (rows) => ({ ok: true, rows });

  // T9. confirmed_at 이 양쪽 다 있으면 **더 늦은 값**. 이른 값을 고르면 보호가 준다.
  let r = mergeDeletions(ok([base({ confirmed_at: 500, expires_at: 500 })]),
                         ok([base({ confirmed_at: 300, expires_at: 300 })]));
  assert.equal(r.rows[0].confirmed_at, 500, t("T9: confirmed_at 이 더 이른 값으로 병합됐다"));

  // T10. expires_at 은 **더 큰 값**. 보존을 짧게 하는 방향은 언제나 위험한 쪽이다.
  r = mergeDeletions(ok([base({ expires_at: 900 })]), ok([base({ expires_at: 1500 })]));
  assert.equal(r.rows[0].expires_at, 1500, t("T10: expires_at 이 더 작은 값으로 병합됐다"));

  // T11. pending_at 은 **더 이른 값**. 최초 시도 시각이 사실이고, 늦으면 경보가 밀린다.
  r = mergeDeletions(ok([base({ pending_at: 400, pending_alert_at: 500 })]),
                     ok([base({ pending_at: 100, pending_alert_at: 200 })]));
  assert.equal(r.rows[0].pending_at, 100, t("T11: pending_at 이 더 늦은 값으로 병합됐다"));
  assert.equal(r.rows[0].pending_alert_at, 200, t("T11: 경보 시각이 밀렸다"));

  // T12. ★ **key_version 이 다르면 병합하지 않고 중단한다.** 자동 판단 금지.
  r = mergeDeletions(ok([base({ key_version: 2 })]), ok([base({ key_version: 1 })]));
  assert.equal(r.ok, false, t("T12: key_version 이 다른데 병합했다"));
  assert.match(r.why, /key_version/, t("T12: 중단 사유가 key_version 이 아니다"));
  assert.equal(r.rows, undefined, t("T12: 중단했는데 결과를 돌려줬다"));

  // T13. 내보내기가 검증되지 않으면 병합하지 않는다. **검증 불가 = 복원 금지.**
  for (const bad of [{ ok: false, rows: [] }, { ok: true }, null, { rows: [base()] }]) {
    assert.equal(mergeDeletions(ok([base()]), bad).ok, false, t("T13: 검증 안 된 입력으로 병합했다"));
    assert.equal(mergeDeletions(bad, ok([base()])).ok, false, t("T13: 검증 안 된 입력으로 병합했다"));
  }

  // T14. ★ **「어떻게든 진행」 경로가 없다.** 강제 진행 플래그·기본값 병합이 소스에 없어야 한다.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../worker/ops.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const bad of [/force/i, /fallback/i, /ignoreConflict/i, /assumeSame/i]) {
    assert.ok(!bad.test(src), t(`T14: ops.js 에 강제 진행 경로 ${bad} 가 있다`));
  }
  // 인자를 더 준다고 통과하지도 않는다(있지도 않은 옵션이 조용히 먹지 않는지).
  assert.equal(mergeDeletions(ok([base({ key_version: 2 })]), ok([base({ key_version: 1 })]),
    { force: true }).ok, false, t("T14: 세 번째 인자로 강제 병합이 통했다"));

  // 병합이 실제로 쓸모 있는지도 본다(막는 쪽만 재면 「전부 막는 병합」도 통과한다).
  r = mergeDeletions(ok([base({ mark: "a" })]), ok([base({ mark: "b" })]));
  assert.equal(r.ok, true, t("T9~14: 정상 병합이 막혔다"));
  assert.deepEqual(r.rows.map((x) => x.mark), ["a", "b"], t("T9~14: 한쪽 목록이 사라졌다"));
}

// ══ F. 재삭제 대상 산출 (T15 ~ T17) ══════════════════════════════════════
{
  // 키를 돌린 뒤에는 같은 사람에게 v1·v2 표식이 둘 다 있을 수 있다.
  // ★ **표식 개수로 세면 정상 상황이 실패로 판정된다.** 세는 단위는 고유 UID 다.
  const userMarks = [
    { uid: "U1", marks: ["m-v1-U1", "m-v2-U1"] },   // T15: v1 pending + v2 confirmed
    { uid: "U2", marks: ["m-v1-U2"] },              // T16: confirmed + pending 같은 UID
    { uid: "U3", marks: ["m-v1-U3"] },              // T17: pending 만 있다
    { uid: "U4", marks: ["m-v1-U4"] },              // 표식 없음
  ];
  const ledger = [
    { mark: "m-v1-U1", key_version: 1, confirmed_at: null },       // pending
    { mark: "m-v2-U1", key_version: 2, confirmed_at: 111 },        // confirmed
    { mark: "m-v1-U2", key_version: 1, confirmed_at: 222 },        // confirmed
    { mark: "m-extra-U2", key_version: 1, confirmed_at: null },    // 같은 사람의 pending
    { mark: "m-v1-U3", key_version: 1, confirmed_at: null },       // pending 만
  ];
  const targets = restoreTargets(userMarks, ledger);
  // T15. 표식 수는 2인데 대상은 **1명**이다.
  assert.ok(targets.includes("U1"), t("T15: 키 회전으로 표식이 둘인 사람이 대상에서 빠졌다"));
  assert.equal(targets.filter((x) => x === "U1").length, 1, t("T15: 같은 사람이 두 번 세어졌다"));
  // T16. confirmed 가 pending 을 이긴다.
  assert.ok(targets.includes("U2"), t("T16: pending 이 confirmed 를 무효화했다"));
  // T17. ★ pending-only 는 **대상이 아니다.** 그것으로 지우면 살아 있는 계정을 지운다.
  assert.ok(!targets.includes("U3"), t("T17: pending 만 있는 사람이 재삭제 대상이 됐다"));
  assert.ok(!targets.includes("U4"), t("T17: 표식이 없는 사람이 대상이 됐다"));
  assert.equal(targets.length, 2, t("T17: 대상 수가 2가 아니다"));
  // 검증식: **지운 users 행 수 == 고유 UID 수**.
  assert.equal(new Set(targets).size, targets.length, t("T17: 대상 목록에 중복이 있다"));

  // 실제 DB 를 훑는 쪽도 같은 답을 내는가.
  const env = makeEnv();
  const A = await mkUser(env, "scan-a"), B = await mkUser(env, "scan-b");
  const marks = await scanUserMarks(env, [(uid) => deletionMark(env, uid)]);
  assert.equal(marks.length, 2, t("F: 스캔이 계정을 다 못 읽었다"));
  const hit = restoreTargets(marks, [{ mark: await deletionMark(env, A.uid), confirmed_at: 1 }]);
  assert.deepEqual(hit, [A.uid], t("F: 스캔 결과로 대상을 못 골랐다"));
  assert.ok(!hit.includes(B.uid), t("F: 표식이 없는 계정이 대상이 됐다"));
}

// ══ F2. 임차증 수명 — 해제는 지우고, 미해제는 남긴다 ══════════════════════
// A′ 로 요청마다 행이 하나씩 생긴다. 표시만 남기면 정리 크론(시간당 200행)보다 빨리 쌓여
// **표가 영원히 자란다.** 그래서 해제는 DELETE 다. 대신 **미해제 행은 절대 안 지운다.**
{
  const env = makeEnv();
  const rows = () => env.LEDGER._db.prepare("SELECT COUNT(*) n FROM write_leases").get().n;
  const l1 = await acquireLease(env);
  assert.equal(rows(), 1, t("F2: 임차증을 땄는데 행이 없다"));
  await releaseLease(env, l1);
  assert.equal(rows(), 0, t("F2: 해제했는데 행이 남았다 — 요청마다 쌓이면 표가 무한히 자란다"));
  assert.equal(await leaseAlive(env, l1), false, t("F2: 지운 임차증이 살아 있다고 판정된다"));

  // 미해제(죽은 요청) 행은 만료돼도 남고, 정리 크론도 안 지운다.
  const now = Date.now();
  env.LEDGER._db.prepare(
    "INSERT INTO write_leases (lease_id, epoch, started_at, expires_at) VALUES (?,?,?,?)")
    .run("dead", 1, now - 7200e3, now - 3600e3);
  const { runCleanup } = await import("../worker/cleanup/index.js");
  await runCleanup({ DB: env.DB, LEDGER: env.LEDGER }, now);
  assert.equal(rows(), 1, t("F2: 정리 크론이 미해제 임차증을 지웠다 — stale 증거가 사라진다"));
  assert.equal((await drainState(env, now)).stale, 1, t("F2: 정리 뒤에도 stale 로 세어져야 한다"));
}

// ══ G. 복원 금지 gate (T7) ═══════════════════════════════════════════════
{
  // T7. ★ 전역 drain 이 없는 상태에서 **복원 절차 진입이 거부된다.**
  //   금지 gate 가 문서가 아니라 **실행되는 검사**로 존재해야 한다 —
  //   사람이 기억해야 도는 규칙은 언젠가 잊힌다.
  const g = restoreGate();
  assert.equal(g.allowed, false, t("T7: 아직 미충족이 남았는데 복원이 허용된다"));
  assert.equal(g.restoreAllowed, false, t("T7: 앱 코드가 복원을 허용한다고 말한다"));
  assert.match(g.why, /사전점검|막지 못한다/, t("T7: 이 검사가 무엇인지(사전점검) 말하지 않는다"));
  assert.throws(() => beginRestore(), /RESTORE_FORBIDDEN|금지/, t("T7: 복원 절차가 시작됐다"));

  // ── T7-b. ★ **임의의 상태 객체로는 통과할 수 없다.**
  //   2026-08-19 까지 여기에는 정반대의 단언이 있었다: 아홉을 전부 true 로 적은 객체를 넘겨
  //   `allowed === true` 가 되는 것을 「gate 가 열린다」고 확인하고 있었다. 그건 gate 가
  //   **인자로 우회된다**는 뜻이고, 「실행되는 검사」라는 설명과 정면으로 어긋난다.
  //   코드가 소유한 조건은 밖에서 못 바꾼다 — 밖에서 오는 것은 질의 결과 하나뿐이다.
  const allTrue = Object.fromEntries(RESTORE_CONDITIONS.map(([k]) => [k, true]));
  for (const forged of [{ state: allTrue }, allTrue, { state: { ...allTrue, extra: true } },
                        { state: allTrue, allowed: true, restoreAllowed: true }]) {
    const r = restoreGate(forged);
    assert.equal(r.preflightPassed, false, t("T7-b: 손으로 만든 상태 객체로 사전점검을 통과했다"));
    assert.equal(r.restoreAllowed, false, t("T7-b: 손으로 만든 상태 객체로 복원이 허용됐다"));
    assert.throws(() => beginRestore(forged), /RESTORE_FORBIDDEN|금지/,
      t("T7-b: 손으로 만든 상태 객체로 복원 절차가 시작됐다"));
  }
  // 밖에서 온 값이 **덮는 것은 질의 조건 하나뿐**이고, 그것도 거짓 쪽으로만 쓰인다.
  assert.ok(restoreGate({ state: allTrue }).missing.some((x) => x.startsWith("oldDeployments")),
    t("T7-b: 코드가 소유한 미충족 조건이 인자로 지워졌다"));
  assert.equal(RESTORE_CONDITIONS.length, 9, t("T7: 금지 해제 조건이 9개가 아니다"));
  // 지금 상태에서 참이라고 적힌 것만 참이다. **참이 아닌 것을 참으로 적지 않는다.**
  // ✅ 결정 A′ 로 drain 3종은 구현됐다.
  for (const k of ["globalDrain", "drainQueryable", "userDataDrain"]) {
    assert.equal(RESTORE_STATE[k], true, t(`T7: ${k} 이 구현됐는데 false 로 적혀 있다`));
  }
  // ⛔ 남은 셋. **이것들이 지금 복원을 막는 이유 전부다.**
  assert.equal(RESTORE_STATE.noActiveLeases, false,
    t("T7: 질의하지 않고 noActiveLeases 가 참으로 적혀 있다 — 이 값은 코드가 아니라 DB 에서 와야 한다"));
  assert.equal(RESTORE_STATE.oldDeployments, false, t("T7: 옛 배포 차단이 증명됐다고 적혀 있다"));
  assert.equal(RESTORE_STATE.regressionTests, false, t("T7: T8 이 아직 「거부됨」이 아닌데 통과로 적혀 있다"));
  for (const k of ["noActiveLeases", "oldDeployments", "regressionTests"]) {
    assert.ok(g.missing.some((x) => x.startsWith(k)), t(`T7: 미충족 사유에 ${k} 가 없다`));
  }
  // ★ **질의 결과로만 참이 된다.** 임차증이 0건이면 참, 하나라도 있으면 거짓.
  {
    const e2 = makeEnv();
    assert.equal((await drainReport(e2)).state.noActiveLeases, true,
      t("T7: 임차증이 0건인데 noActiveLeases 가 거짓이다"));
    const l = await acquireLease(e2);
    assert.equal((await drainReport(e2)).state.noActiveLeases, false,
      t("T7: 임차증이 살아 있는데 noActiveLeases 가 참이다"));
    await releaseLease(e2, l);
    assert.equal((await drainReport(e2)).state.noActiveLeases, true, t("T7: 해제 뒤에도 거짓이다"));
  }
}

// ══ H. 재개방 판정 · 정리 ════════════════════════════════════════════════
{
  const env = makeEnv();
  const A = await mkUser(env, "reopen-a");
  const uid = A.uid;
  // 되살아난 상태를 흉내낸다 — 계정과 딸린 행이 전부 있고, 그 사람의 **확정 표식**이 ledger 에 있다.
  env.DB._db.exec(`INSERT INTO books (user_id,words,nickname,version,updated_at) VALUES ('${uid}','[]','',0,0)`);
  const mark = await deletionMark(env, uid);
  env.LEDGER._db.exec(
    `INSERT INTO deletions (mark, key_version, pending_at, confirmed_at, pending_alert_at, expires_at)
     VALUES ('${mark}', 1, 1, ${Date.now() - 1000}, ${Date.now() + 1e6}, ${Date.now() + 1e6})`);
  // 진짜 삭제 경로는 표식과 **키 검사값**을 함께 남긴다(ledger.js `markPending`). 표식만 손으로
  // 넣으면 「지금 키가 그때 그 키인지 모른다」가 되어 정당하게 거부된다(2026-08-19 · 재현 R4).
  await rememberDeletionKey(env);
  // 복원 중이라는 뜻의 상태. 여기서만 「다시 열어도 되나」가 뜻을 갖는다.
  await setMode(env, "restore_closed");

  // ── H1. 계정이 살아 있으면 열 수 없다. 대상 집합은 **보고서가 직접 만든다.**
  let rep = await reopenReport(env);
  assert.equal(rep.targets, 1, t("H1: 확정 표식이 있는 되살아난 계정을 재삭제 대상으로 못 찾았다"));
  assert.equal(rep.canReopen, false, t("H1: 계정이 살아 있는데 읽기를 열 수 있다고 한다"));
  assert.equal(rep.stillAlive, 1, t("H1: 살아 있는 계정을 못 셌다"));
  await assert.rejects(() => setMode(env, "open"), /살아 있다|잔여/,
    t("H1: 재삭제가 안 끝났는데 setMode 가 읽기를 열었다"));

  // ── H1-b. ★ **손으로 만든 판정으로는 열 수 없다.**
  //   예전에는 `reopenReport(env, { targets: [] })` 하나면 잔여 0 · 살아 있는 계정 0 이라
  //   **canReopen: true** 가 나왔다 — 아무것도 확인하지 않고 읽기를 다시 여는 길이다.
  //   지금 `setMode` 는 보고서를 **받지 않는다**: 그 자리에서 다시 판정한다.
  //   ⚠️ 2026-08-19 에 한 겹 더 벗겼다: `markFns` 인자도 없앴다. 남아 있던 동안에는
  //      **상수를 돌려주는 함수 하나**로 재삭제 대상이 0 이 되어 그대로 열렸다(재현 R2 ·
  //      test-reaudit R2 가 그 전수 표를 잰다). 여기서는 「무엇을 넘겨도 무시된다」만 고정한다.
  for (const forged of [{ canReopen: true }, { canReopen: true, epoch: rep.epoch, at: Date.now() },
                        { reopen: { canReopen: true } }, { targets: [] }, { targets: [uid] },
                        { markFns: [] }, { markFns: [() => "언제나같은값"] }]) {
    await assert.rejects(() => setMode(env, "open", forged),
      /살아 있다|잔여/, t("H1-b: 손으로 만든 판정·빈 목록으로 읽기가 열렸다"));
    assert.equal((await reopenReport(env, forged)).canReopen, false,
      t("H1-b: 호출자가 넘긴 인자로 재개방 판정이 통과했다"));
  }

  // ── H1-c. 미확정 표식이 남아 있으면 열 수 없다. **개수가 아니라 존재가 판정이다.**
  env.LEDGER._db.exec(
    `INSERT INTO deletions (mark, key_version, pending_at, pending_alert_at, expires_at)
     VALUES ('m-open', 1, 1, 1, ${Date.now() + 1e6})`);
  env.DB._db.exec(`DELETE FROM users WHERE id = '${uid}'`);
  rep = await reopenReport(env);
  assert.equal(rep.openPending, 1, t("H1-c: 미확정 표식을 못 셌다"));
  assert.equal(rep.canReopen, false, t("H1-c: 미확정 표식이 남았는데 읽기를 연다"));
  await assert.rejects(() => setMode(env, "open"), /미확정/, t("H1-c: setMode 가 그대로 열었다"));
  env.LEDGER._db.exec("DELETE FROM deletions WHERE mark = 'm-open'");

  // ── H1-d. stale 임차증이 있으면 열 수 없다(만료는 해제가 아니다).
  env.LEDGER._db.prepare(
    "INSERT INTO write_leases (lease_id, epoch, started_at, expires_at) VALUES (?,?,?,?)")
    .run("stale-reopen", 1, Date.now() - 3600e3, Date.now() - 1800e3);
  rep = await reopenReport(env);
  assert.equal(rep.canReopen, false, t("H1-d: stale 임차증이 있는데 읽기를 연다"));
  assert.ok(rep.why.some((w) => /임차증/.test(w)), t("H1-d: 이유에 임차증이 없다"));
  env.LEDGER._db.exec("DELETE FROM write_leases WHERE lease_id = 'stale-reopen'");

  // ── H1-e. 전부 정리되면 열린다. **막는 쪽만 재면 「영영 안 열리는」 회귀를 못 잡는다.**
  rep = await reopenReport(env);
  assert.equal(rep.canReopen, true, t("H1-e: 다 지웠는데 읽기를 못 연다: " + rep.why.join(" · ")));
  assert.deepEqual(rep.leftovers, { sessions: 0, books: 0, invite_codes: 0, friendships: 0 },
    t("H1-e: CASCADE 잔여가 남았다"));
  assert.equal((await setMode(env, "open")).mode, "open",
    t("H1-e: 사전점검을 통과했는데 setMode 가 안 열었다"));
  // ⚠️ `maintenance` → `open` 은 이 자물쇠와 무관하다. 막으려는 것은 **읽기 노출**이지
  //    유지보수 해제가 아니다.
  await setMode(env, "maintenance");
  assert.equal((await setMode(env, "open")).mode, "open", t("H1-e: 유지보수 해제까지 막혔다"));

  // 만료 정리는 **confirmed 만** 지운다. 조건이 빠지면 여기서 걸린다.
  const now = Date.now();
  const ins = (mark, confirmed) => env.LEDGER._db.exec(
    `INSERT INTO deletions (mark, key_version, pending_at, confirmed_at, pending_alert_at, expires_at)
     VALUES ('${mark}', 1, 1, ${confirmed}, ${now - 1}, ${now - 1})`);
  ins("m-old", now - 2);      // 확정됨 · 만료됨 → 지운다
  ins("m-pend", "NULL");      // 확정 안 됨 · 만료됨 → ⛔ 지우지 않는다
  const removed = await sweepConfirmed(env, now);
  assert.equal(removed, 1, t("H2: 만료된 confirmed 가 안 지워졌다"));
  assert.equal(lcount(env, "WHERE mark = 'm-pend'"), 1,
    t("H2: ⛔ 만료된 pending 을 지웠다 — 복원 때 그 사람이 되살아나고 아무도 모른다"));
  assert.equal(await pendingAlertCount(env, now), 1, t("H2: 확정 안 된 pending 을 못 셌다"));
}

console.log(`test-deletion-ledger: ${n}개 통과 — 표식 HMAC · saga 실패 매트릭스 · lease/epoch fencing · `
  + `promote-only reconciliation · stale pending 5조건 · ledger 병합(방향·충돌·검증) · `
  + `재삭제 대상 고유 UID · 복원 금지 gate 9조건(질의로만 참이 되는 noActiveLeases 포함) · confirmed 만 정리`);
