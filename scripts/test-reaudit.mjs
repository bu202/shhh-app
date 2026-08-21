// 2026-08-19 독립 재감사에서 **실제로 재현된 우회 5건**. `node scripts/test-reaudit.mjs`
//
// 왜 파일을 따로 두나: 이 다섯은 기존 22개 스위트가 **전부 통과하는 상태에서** 재현됐다.
// 같은 파일에 끼워 넣으면 "그 스위트가 통과한다"가 다시 근거로 쓰인다 — 무엇이 놓쳤던
// 것인지 이름으로 남겨 둔다. 번호는 R1~R5 이고 설계서의 위협 43~47 · T56~T60 과 짝이다.
//
// ⚠️ **먼저 빨갛게 만들고 고쳤다.** 각 블록 머리말의 「고치기 전」이 그때 실제로 나온 값이다.
import assert from "node:assert";
import worker, { createAccountWithPolicy, newSession } from "../worker/index.js";
import {
  deletionMark, DELETION_KEY_VERSION, acquireLease, releaseLease,
  markPending, pendingTotalCount, pendingAlertCount, PENDING_ALERT, CONFIRMED_RETENTION,
} from "../worker/ledger.js";
import { setMode, reconcile, removeStalePending, reopenReport, restorePreflight } from "../worker/ops.js";
import { makeD1, makeLedger } from "./_d1.mjs";

const ORIGIN = "https://app.test";
let n = 0;
const t = (m) => { n++; return m; };
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 3)).toString("base64url");

const makeEnv = (extra = {}) => ({
  APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "k", RL_KEY: "r",
  DEV_RATE_LIMIT: "1",   // 로컬 전용 남용 방어 스위치(위협 50). 없으면 계정 라우트가 503
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "tk", DELETION_KEY: "dk",
  DB: makeD1(), LEDGER: makeLedger(), ...extra,
});
let seq = 0;
const mkUser = async (env, sub = "u" + ++seq) => {
  const uid = await createAccountWithPolicy(env, "kakao", sub,
    { stateHash: "s-" + sub + Math.random(), stateExp: Date.now() + 600e3, occurredAt: Date.now() });
  return { uid, token: await newSession(env, uid) };
};
const call = (env, token, path, method = "GET", extra = {}) =>
  worker.fetch(new Request("https://api.test" + path, {
    method, headers: { Origin: ORIGIN, "Content-Type": "application/json",
                       ...(token ? { Cookie: "shh_s=" + token } : {}), ...extra },
  }), env);
const mode = (env) => env.LEDGER._db.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").get();

// 「복원돼서 되살아난 탈퇴자」 상태를 만든다 — 계정·단어장이 있고, 그 사람의 **확정 표식**이
// ledger 에 남아 있다. 이 상태가 곧 「다시 지워야 할 사람이 살아 있다」이다.
async function restored(env) {
  const A = await mkUser(env, "revived" + ++seq);
  env.DB._db.exec(`INSERT INTO books (user_id,words,nickname,version,updated_at) VALUES ('${A.uid}','["가"]','',0,0)`);
  const now = Date.now();
  env.LEDGER._db.prepare(
    `INSERT INTO deletions (mark, key_version, pending_at, confirmed_at, pending_alert_at, expires_at)
     VALUES (?,?,?,?,?,?)`).run(await deletionMark(env, A.uid), DELETION_KEY_VERSION,
                                now - 2000, now - 1000, now + 1e6, now + 1e6);
  // 키 검사값도 그때 함께 기록됐을 상태로 둔다(진짜 삭제가 남기는 것과 같은 모양).
  await rememberKey(env);
  return A;
}
// 실제 삭제 경로가 하는 일과 같다: 표식을 처음 남길 때 키 검사값이 기록된다.
async function rememberKey(env) {
  const lease = await acquireLease(env);
  await markPending(env, lease, "keyprobe-" + ++seq);
  env.LEDGER._db.exec("DELETE FROM deletions WHERE mark LIKE 'keyprobe-%'");
  await releaseLease(env, lease);
}

// ══ R1. restore_closed → maintenance 우회 ════════════════════════════════
//
// 고치기 전: `setMode()` 는 **`restore_closed → open`** 하나만 검사했다. 그런데
// `maintenance` 도 `GET /book`·`GET /me`·`GET /friends/:id/book` 을 **허용하는 상태**다
// (`MAINT_READS`). 그래서 재삭제도 잔여 확인도 없이 `maintenance` 로 한 칸 옆으로
// 옮기면 **되살아난 탈퇴자의 단어장이 그대로 200 으로 읽혔다** — 위협 36 이 막으려던
// 바로 그 결과이고, 자물쇠를 우회한 것이 아니라 **옆문으로 걸어 나간** 것이다.
{
  const env = makeEnv();
  const A = await restored(env);

  await setMode(env, "restore_closed");
  assert.equal((await call(env, A.token, "/book")).status, 503,
    t("R1: restore_closed 인데 단어장이 읽힌다"));

  // ── R1-a. ★ 재삭제·잔여 확인 없이 maintenance 로 갈 수 없다.
  await assert.rejects(() => setMode(env, "maintenance"), /살아 있다|잔여|읽기|restore_closed/,
    t("R1-a: 검증 없이 restore_closed → maintenance 로 옮겨졌다"));
  assert.equal(mode(env).mode, "restore_closed", t("R1-a: 거부했는데 모드가 바뀌었다"));
  assert.equal((await call(env, A.token, "/book")).status, 503,
    t("R1-a: maintenance 로 새어 나가 되살아난 단어장이 읽힌다"));

  // ── R1-b. ★ 3×3 전환 전수. `restore_closed` 에서 나가는 길은 **검증된 open 하나뿐**이다.
  //   (같은 모드로의 재진입은 허용한다 — epoch 만 오르고 더 닫히는 방향이라 안전하다.)
  const MODES = ["open", "maintenance", "restore_closed"];
  for (const from of MODES) {
    for (const to of MODES) {
      const e = makeEnv();
      const B = await restored(e);                    // 되살아난 사람이 늘 하나 있다
      e.LEDGER._db.prepare("UPDATE maintenance SET mode = ? WHERE id = 1").run(from);
      const guarded = from === "restore_closed" && to !== "restore_closed";
      if (guarded) {
        await assert.rejects(() => setMode(e, to), /살아 있다|잔여|읽기|restore_closed/,
          t(`R1-b: ${from} → ${to} 가 검증 없이 통과했다`));
        assert.equal(mode(e).mode, from, t(`R1-b: ${from} → ${to} 거부인데 모드가 바뀌었다`));
      } else {
        assert.equal((await setMode(e, to)).mode, to, t(`R1-b: ${from} → ${to} 가 막혔다`));
      }
      // 사용자 데이터 읽기가 열린 모드로 갔다면 되살아난 사람이 여전히 살아 있으면 안 된다.
      const readable = mode(e).mode !== "restore_closed";
      const st = (await call(e, B.token, "/book")).status;
      if (readable) {
        assert.equal(st, 200, t(`R1-b: ${mode(e).mode} 인데 정상 읽기가 막혔다`));
        assert.ok(!guarded, t(`R1-b: 검증을 거부해 놓고 ${mode(e).mode} 에서 읽기가 열렸다`));
      } else {
        assert.equal(st, 503, t("R1-b: restore_closed 인데 읽기가 열렸다"));
      }
    }
  }

  // ── R1-c. ★ 검증 직후 다른 전환이 끼어들면 **닫는 쪽으로** 실패한다(CAS).
  //   판정에 쓴 게이트가 그 사이에 바뀌었는데도 쓰면, 사람이 본 근거와 실제 상태가 갈린다.
  {
    const e = makeEnv();
    await rememberKey(e);
    e.LEDGER._db.prepare("UPDATE maintenance SET mode = 'restore_closed' WHERE id = 1").run();
    const raced = e.LEDGER.prepare;
    let armed = true;
    e.LEDGER.prepare = (sql) => {
      // 재개방 판정이 끝나고 **UPDATE 직전**에 운영자 하나가 더 전환한 상황.
      if (armed && /UPDATE maintenance SET mode/.test(sql)) {
        armed = false;
        e.LEDGER._db.prepare("UPDATE maintenance SET mode = 'restore_closed', epoch = epoch + 1 WHERE id = 1").run();
      }
      return raced.call(e.LEDGER, sql);
    };
    await assert.rejects(() => setMode(e, "open"), /전환|경합|epoch/,
      t("R1-c: 판정 뒤에 게이트가 바뀌었는데 그대로 덮어썼다"));
    e.LEDGER.prepare = raced;
  }
}

// ══ R2. 호출자가 넘긴 mark 함수가 삭제 증거를 정한다 ══════════════════════
//
// 고치기 전: `reopenReport(env, { markFns })` 가 **임의의 실행 함수**를 받아 그것으로
// 재삭제 대상을 만들었다. 주석은 「틀린 함수를 주면 대상이 늘어나지 줄지 않는다」고
// 적혀 있었는데 **정확히 반대**였다 — 표식이 안 맞으면 `restoreTargets()` 의 교집합이
// 비어 `targets: 0` 이 되고, 그러면 잔여도 0 · 살아 있는 계정도 0 이라 **`canReopen: true`**
// 였다. 상수를 돌려주는 함수 하나로 되살아난 탈퇴자를 못 본 척할 수 있었다.
{
  // ── R2-a. ★ 올바른 상태에서는 대상을 **찾는다**(막는 쪽만 재면 회귀를 못 잡는다).
  const env = makeEnv();
  const A = await restored(env);
  await setMode(env, "restore_closed");
  let rep = await reopenReport(env);
  assert.equal(rep.targets, 1, t("R2-a: 되살아난 탈퇴 계정을 재삭제 대상으로 못 찾았다"));
  assert.equal(rep.canReopen, false, t("R2-a: 대상이 살아 있는데 다시 열 수 있다고 한다"));

  // ── R2-b. ★ 호출자가 무엇을 넘겨도 판정이 바뀌지 않는다.
  //   상수 · 다른 키 · 버전이 뒤바뀐 함수 — 셋 다 예전에는 `targets:0 · canReopen:true` 였다.
  const other = { ...env, DELETION_KEY: "완전히-다른-키" };
  for (const [label, fns] of [
    ["상수", [() => "언제나같은값"]],
    ["다른 키", [(id) => deletionMark(other, id)]],
    ["버전 뒤바뀜", [(id) => deletionMark(env, "v2:" + id)]],
    ["빈 목록", []],
    ["함수가 아님", ["not-a-function"]],
  ]) {
    const r = await reopenReport(env, { markFns: fns });
    assert.equal(r.targets, 1, t(`R2-b: ${label} 함수로 재삭제 대상이 0 이 됐다`));
    assert.equal(r.canReopen, false, t(`R2-b: ${label} 함수로 재개방이 통과했다`));
    await assert.rejects(() => setMode(env, "open", { markFns: fns }), /살아 있다|잔여/,
      t(`R2-b: ${label} 함수로 setMode("open") 이 통과했다`));
  }

  // ── R2-c. ★ **키 자체가 틀리면 아예 판정하지 않는다.** 인자를 막아도 `env.DELETION_KEY`
  //   가 다른 배포에서는 같은 착시가 난다 — 표식이 하나도 안 맞아 「다 지워졌다」로 보인다.
  const wrongEnv = { ...env, DELETION_KEY: "돌렸는데-버전은-그대로" };
  const rw = await reopenReport(wrongEnv);
  assert.equal(rw.canReopen, false, t("R2-c: 키가 틀렸는데 재개방이 통과했다"));
  assert.ok(rw.why.some((w) => /키|key/i.test(w)), t("R2-c: 키가 틀렸다고 말하지 않는다"));
  await assert.rejects(() => setMode(wrongEnv, "open"), /키|key/i,
    t("R2-c: 키가 틀렸는데 setMode(\"open\") 이 통과했다"));

  // ── R2-d. ★ **모르는 key_version 이 하나라도 있으면 자동 판정을 거부한다.**
  //   지금 코드가 만들 수 있는 표식은 한 버전뿐이다. 문서가 여러 버전을 말한다면
  //   검증 가능한 구현이거나 여기서 멈추거나 둘 중 하나여야 한다.
  const e2 = makeEnv();
  await restored(e2);
  await setMode(e2, "restore_closed");
  e2.LEDGER._db.exec(
    `INSERT INTO deletions (mark, key_version, pending_at, confirmed_at, pending_alert_at, expires_at)
     VALUES ('mark-v9', 9, 1, 2, 3, ${Date.now() + 1e6})`);
  const r9 = await reopenReport(e2);
  assert.equal(r9.canReopen, false, t("R2-d: 모르는 key_version 이 있는데 재개방이 통과했다"));
  assert.ok(r9.why.some((w) => /key_version|키 버전/.test(w)), t("R2-d: 모르는 키 버전을 말하지 않는다"));
}

// ══ R3. 아직 경보 시각이 안 된 pending 을 안 센다 ═════════════════════════
//
// 고치기 전: `openPendingCount()` 는 `confirmed_at IS NULL AND pending_alert_at < now` 였다.
// 그 값 하나가 **경보**와 **복원 안전조건**에 같이 쓰였다. 그래서 방금 만들어진 미확정
// 표식(경보 시각 24시간 뒤)은 **어느 쪽에도 안 잡혔고**, 「미확정 삭제 0건」이라는 근거로
// 재개방과 복원 사전점검이 통과했다 — 그 표식은 「누구를 다시 지워야 하는지 아직 모른다」다.
{
  const env = makeEnv();
  await rememberKey(env);
  const now = Date.now();
  // 확정 안 됨 · 경보 시각은 **아직 안 됐다**(방금 실패한 삭제가 정확히 이 모양이다).
  env.LEDGER._db.exec(
    `INSERT INTO deletions (mark, key_version, pending_at, pending_alert_at, expires_at)
     VALUES ('fresh', ${DELETION_KEY_VERSION}, ${now}, ${now + PENDING_ALERT}, ${now + CONFIRMED_RETENTION})`);

  // ── R3-a. ★ 두 개념이 갈려 있다.
  assert.equal(await pendingTotalCount(env), 1, t("R3-a: 전체 미확정을 못 셌다"));
  assert.equal(await pendingAlertCount(env, now), 0, t("R3-a: 경보 시각 전인데 경보 대상으로 셌다"));

  // ── R3-b. ★ 경계 시각 `<` `=` `>` 를 각각 잰다. `=` 는 **아직 경보가 아니다**(엄격한 미만).
  const at = now + PENDING_ALERT;
  assert.equal(await pendingAlertCount(env, at - 1), 0, t("R3-b: 경보 시각 이전인데 셌다"));
  assert.equal(await pendingAlertCount(env, at), 0, t("R3-b: 경보 시각과 같은 순간에 이미 경보다"));
  assert.equal(await pendingAlertCount(env, at + 1), 1, t("R3-b: 경보 시각을 넘겼는데 안 셌다"));
  // 전체 개수는 시각과 무관하다 — 「아직 모른다」는 시간이 지난다고 해결되지 않는다.
  for (const w of [at - 1, at, at + 1])
    assert.equal(await pendingTotalCount(env, w), 1, t("R3-b: 전체 미확정이 시각에 따라 변한다"));

  // ── R3-c. ★ 안전 조건은 **전체 개수**를 쓴다. 재개방도 복원 사전점검도 거부다.
  await setMode(env, "restore_closed");
  const rep = await reopenReport(env);
  assert.equal(rep.openPending, 1, t("R3-c: 재개방 판정이 갓 만들어진 미확정 표식을 못 봤다"));
  assert.equal(rep.canReopen, false, t("R3-c: 미확정 표식이 있는데 읽기를 다시 연다"));
  await assert.rejects(() => setMode(env, "open"), /미확정/, t("R3-c: setMode 가 그대로 열었다"));
  const pre = await restorePreflight(env);
  assert.equal(pre.openPending, 1, t("R3-c: 복원 사전점검이 미확정 표식을 0 으로 본다"));
}

// ══ R4. 잘못된 키로 **살아 있는 계정**의 표식이 승격된다 ═══════════════════
//
// 고치기 전: `reconcile(env, { mark })` 도 호출자 함수를 받았다. 그 함수(또는 `env` 의 키)가
// 틀리면 살아 있는 사용자들의 표식 집합이 통째로 어긋나, 실제로는 **계정이 멀쩡히 있는**
// pending 이 「계정이 없다 → 삭제는 됐고 기록만 실패했다」로 읽혀 **confirmed 로 승격**됐다.
// 승격은 되돌릴 수 없다: 그 뒤로 그 사람은 「지워진 사람」이고, 복원 절차는 그를 다시 지운다.
{
  const env = makeEnv();
  const A = await mkUser(env, "alive");
  const lease = await acquireLease(env);
  const mark = await deletionMark(env, A.uid);
  assert.ok(await markPending(env, lease, mark), t("R4: pending 을 못 남겼다"));
  await releaseLease(env, lease);
  await setMode(env, "maintenance");

  const pending = () => env.LEDGER._db.prepare(
    "SELECT COUNT(*) n FROM deletions WHERE confirmed_at IS NULL").get().n;
  assert.equal(pending(), 1, t("R4: 준비 상태가 틀렸다"));
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 1, t("R4: 사용자가 없다"));

  // ── R4-a. ★ 호출자가 넘긴 함수로는 승격 판정을 바꿀 수 없다.
  for (const [label, fn] of [
    ["상수", () => "언제나같은값"],
    ["다른 키", (e, id) => deletionMark({ ...e, DELETION_KEY: "다른키" }, id)],
    ["빈 문자열", () => ""],
  ]) {
    const r = await reconcile(env, { mark: fn });
    assert.equal(pending(), 1, t(`R4-a: ${label} 함수로 살아 있는 계정의 표식이 승격됐다`));
    assert.equal(r.promoted || 0, 0, t(`R4-a: ${label} 함수가 승격을 보고했다`));
  }

  // ── R4-b. ★ `env` 의 키가 틀린 배포에서는 **아예 실행되지 않는다.**
  const wrong = { ...env, DELETION_KEY: "돌렸는데-버전은-그대로" };
  const rw = await reconcile(wrong);
  assert.equal(rw.ok, false, t("R4-b: 키가 틀린데 reconciliation 이 실행됐다"));
  assert.match(String(rw.why), /키|key/i, t("R4-b: 거부 사유가 키가 아니다"));
  assert.equal(pending(), 1, t("R4-b: 키가 틀린 채로 승격됐다"));
  // 같은 규칙이 stale pending 제거에도 걸린다 — 거기도 「계정이 있나」로 판정한다.
  const rm = await removeStalePending(wrong, [mark], { confirmedByOperator: true });
  assert.equal(rm.ok, false, t("R4-b: 키가 틀린데 stale pending 제거가 실행됐다"));

  // ── R4-c. ★ 올바른 키에서는 **계정이 살아 있는 한 승격하지 않는다**(promote-only 의 본뜻).
  const good = await reconcile(env);
  assert.equal(good.ok, true, t("R4-c: 올바른 키인데 reconciliation 이 거부됐다"));
  assert.equal(good.promoted, 0, t("R4-c: 계정이 살아 있는데 승격했다"));
  assert.equal(pending(), 1, t("R4-c: 살아 있는 계정의 표식이 사라졌다"));
  // 계정이 실제로 사라지면 그때 승격한다 — 「늘 거부」가 아님을 함께 잰다.
  env.DB._db.exec(`DELETE FROM users WHERE id = '${A.uid}'`);
  assert.equal((await reconcile(env)).promoted, 1, t("R4-c: 계정이 없는데 승격하지 않았다"));
}

// ══ R5. 인증 없는 요청의 지속 저장소 쓰기 증폭 ════════════════════════════
//
// 고치기 전: 임차증을 **인증보다 먼저, 리미터보다도 먼저** 땄다. 그래서 쿠키 없는 요청,
// 아무렇게나 만든 위조 쿠키, 틀린 OAuth 콜백이 **하나에 ledger 쓰기 2회**(INSERT+DELETE)를
// 냈고 요청 수에 상한이 없었다 — 즉 쓰기에도 상한이 없었다. 옛 T53 은 「요청당 정확히 둘」을
// 확인하고 **「유한한 상한」이라고 적었다.** 요청 수가 무제한이면 요청당 상수는 상한이 아니다.
//
// 지금 재는 것은 **총량 불변식**이다: 인증 없는 요청을 아무리 반복해도 두 저장소의
// rows-written 합계가 IP·분당 상한을 넘지 않는다.
{
  const env = makeEnv({ KAKAO_ID: "id", KAKAO_SECRET: "s" });
  // 두 저장소 모두 **행 수가 아니라 총 변경 수**로 센다 — 지웠다 다시 쓴 것도 쓰기다.
  const dbW = () => env.DB._db.prepare("SELECT total_changes() AS n").get().n;
  const ledW = () => env.LEDGER._db.prepare("SELECT total_changes() AS n").get().n;
  // ⚠️ 측정마다 **다른 IP** 를 쓴다. 같은 IP 를 쓰면 앞 측정이 버킷을 이미 소진해서
  //    뒤 측정이 「0 쓰기」로 통과해 버린다 — 그건 방어가 아니라 측정 오류다.
  let ipSeq = 0;
  const measure = async (label, N, make) => {
    const ip = { "CF-Connecting-IP": "203.0.113." + (10 + ++ipSeq) };
    const d0 = dbW(), l0 = ledW();
    for (let i = 0; i < N; i++) await worker.fetch(make(i, ip), env);
    return { label, N, db: dbW() - d0, ledger: ledW() - l0 };
  };
  // 가장 넉넉한 버킷(120)이라도 쓰기는 **요청 수가 아니라 한도**가 정한다:
  // 주 D1 은 한도+1 회(넘긴 뒤로는 UPDATE 가 아예 안 걸린다), ledger 는 통과한 요청당 둘.
  const CAP = 120 * 3 + 2;
  const report = [];
  const CASES = [
    // ── R5-a. ★ 쿠키 없이 인증 필요 경로를 반복한다.
    ["쿠키 없음 GET /book", (i, ip) => new Request("https://api.test/book", { headers: ip })],
    // ── R5-b. ★ **매번 다른** 위조 쿠키. 값을 바꿔도 상한이 늘면 안 된다.
    ["위조 쿠키 GET /book",
     (i, ip) => new Request("https://api.test/book", { headers: { ...ip, Cookie: "shh_s=forged-" + i } })],
    ["위조 쿠키 PUT /book",
     (i, ip) => new Request("https://api.test/book", {
       method: "PUT", headers: { ...ip, Origin: ORIGIN, "Content-Type": "application/json",
                                 Cookie: "shh_s=forged-" + i },
       body: JSON.stringify({ words: ["가"], version: 0 }) })],
    // ── R5-c. ★ 틀린 OAuth 콜백.
    ["잘못된 콜백 GET /cb",
     (i, ip) => new Request("https://api.test/cb/kakao?code=x" + i + "&state=y", { headers: ip })],
    // 없는 주소는 라우트 판정에서 끝난다 — 어느 DB 도 안 만진다(T50 과 같은 성질).
    ["없는 주소 POST", (i, ip) => new Request("https://api.test/이런건없다" + i, { method: "POST", headers: ip })],
  ];

  // ── R5-a~c. ★ **총량 불변식**: 요청 수를 2배로 늘려도 쓰기는 같아야 한다.
  //   옛 T53 은 「요청당 정확히 둘」을 확인하고 그것을 「유한한 상한」이라 적었다 —
  //   요청 수가 무제한이면 요청당 상수는 상한이 아니다. 그래서 **N 을 바꿔 가며 잰다.**
  for (const [label, make] of CASES) {
    const a = await measure(label, 200, make);
    const b = await measure(label, 400, make);
    report.push(a, b);
    assert.equal(b.db, a.db,
      t(`R5: ${label} — 요청을 2배로 늘리니 주 D1 쓰기가 ${a.db} → ${b.db} 로 늘었다`));
    assert.equal(b.ledger, a.ledger,
      t(`R5: ${label} — 요청을 2배로 늘리니 ledger 쓰기가 ${a.ledger} → ${b.ledger} 로 늘었다`));
    assert.ok(a.db + a.ledger <= CAP,
      t(`R5: ${label} — 쓰기 ${a.db + a.ledger}회가 한도에서 유도되는 상한 ${CAP} 을 넘는다`));
  }

  // ── R5-d. ★ 429 를 받은 뒤에도 100회 이상 계속 두드린다. **여기서 쓰기가 0 이어야 한다.**
  {
    const ip = { "CF-Connecting-IP": "203.0.113.200" };
    for (let i = 0; i < 200; i++)   // 확실히 한도를 넘긴 상태로 만든다
      await worker.fetch(new Request("https://api.test/book", { headers: ip }), env);
    const r = await worker.fetch(new Request("https://api.test/book", { headers: ip }), env);
    assert.equal(r.status, 429, t("R5-d: 200회를 두드렸는데 막히지 않는다"));
    const d0 = dbW(), l0 = ledW();
    for (let i = 0; i < 150; i++)
      await worker.fetch(new Request("https://api.test/book", { headers: ip }), env);
    const after = { label: "429 이후 150회", N: 150, db: dbW() - d0, ledger: ledW() - l0 };
    assert.equal(after.db, 0, t(`R5-d: 429 이후에도 주 D1 쓰기가 났다(${after.db}) — 리미터가 증폭기다`));
    assert.equal(after.ledger, 0, t(`R5-d: 429 이후에도 ledger 쓰기가 났다(${after.ledger}) — 임차증이 리미터보다 앞선다`));
    report.push(after);
  }

  console.log("  R5 측정(익명 요청당 rows-written · 측정마다 새 IP):");
  for (const r of report)
    console.log(`    ${r.label.padEnd(22)} 요청 ${String(r.N).padStart(3)}회 → 주 D1 ${String(r.db).padStart(3)} · ledger ${String(r.ledger).padStart(3)}`);

  // ── R5-e. ★ 정상 사용자는 그대로 된다. 상한이 서비스를 죽이면 방어가 아니라 고장이다.
  const env2 = makeEnv();
  const A = await mkUser(env2, "normal");
  assert.equal((await call(env2, A.token, "/book")).status, 200, t("R5-e: 정상 읽기가 막혔다"));
  const put = await worker.fetch(new Request("https://api.test/book", {
    method: "PUT", headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: "shh_s=" + A.token },
    body: JSON.stringify({ words: ["가"], version: 0 }) }), env2);
  assert.equal(put.status, 200, t("R5-e: 정상 저장이 막혔다"));

  // ── R5-f. ★ `restore_closed` 에서는 리미터도 주 D1 을 안 만진다.
  //   리미터가 임차증보다 앞이라 그 쓰기만은 추적 밖이다 — 그래서 **복원 직전 상태에서는
  //   그 창 자체가 없다**는 것을 여기서 고정한다(복원 전제는 restore_closed + 임차증 0 이다).
  const env3 = makeEnv();
  await setMode(env3, "restore_closed");
  const d0 = env3.DB._db.prepare("SELECT total_changes() AS n").get().n;
  const l0 = env3.LEDGER._db.prepare("SELECT total_changes() AS n").get().n;
  for (let i = 0; i < 50; i++)
    assert.equal((await worker.fetch(new Request("https://api.test/book",
      { headers: { "CF-Connecting-IP": "203.0.113.201", Cookie: "shh_s=forged" } }), env3)).status, 503, t("R5-f: restore_closed 인데 503 이 아니다"));
  assert.equal(env3.DB._db.prepare("SELECT total_changes() AS n").get().n, d0,
    t("R5-f: restore_closed 인데 리미터가 주 D1 에 썼다"));
  assert.equal(env3.LEDGER._db.prepare("SELECT total_changes() AS n").get().n, l0,
    t("R5-f: restore_closed 인데 임차증을 땄다"));
}

console.log(`test-reaudit: ${n}개 통과 — R1 모드 전환 우회(3×3 전수 · CAS) · R2 삭제 증거의 키 소유권 · `
  + `R3 pending 안전조건과 경보의 분리 · R4 잘못된 키로 살아 있는 계정 승격 · R5 익명 쓰기 증폭 총량 불변식`);
