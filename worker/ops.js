// 운영 명령. **HTTP 라우트가 아니다.** 사람이 실행하고 사람이 판정한다.
//
// 왜 코드로 두나: 「증거 없이는 거부한다」가 성립하려면 증거가 **질의 가능**해야 하고,
// 거부가 사람의 기억이 아니라 실행되는 검사여야 하기 때문이다. 문서에만 있는 규칙은 잊힌다.
//
// ⚠️ 여기에는 **강제 진행 플래그가 없다.** `force`·`fallback`·`skipChecks` 를 만들지 않는다 —
//    한 번 만들면 급할 때 쓰이고, 급할 때가 정확히 쓰면 안 되는 때다.
import { activeLeases, drainState, pendingTotalCount, DELETION_KEY_VERSION, CONFIRMED_RETENTION } from "./ledger.js";

// ── 유지보수 전환 ────────────────────────────────────────────────────────
// **epoch 를 함께 올린다.** 이 순간부터 새 lease 를 딸 수 없고, 옛 epoch 의 lease 를 든
// 요청은 fencing 을 통과하지 못한다.
// **사용자 데이터 읽기가 열리는 모드.** `restore_closed` 에서 이쪽으로 가는 **모든** 길에
// 같은 재개방 검증이 걸린다.
//
// ⚠️ 2026-08-19 까지는 `restore_closed → open` 하나만 검사했다. 그런데 `maintenance` 도
//    `GET /book`·`GET /me`·`GET /friends/:id/book` 을 **허용하는 상태**다(index.js 의
//    `MAINT_READS`). 그래서 재삭제도 잔여 확인도 없이 한 칸 옆으로 옮기면 되살아난 탈퇴자의
//    단어장이 그대로 200 으로 읽혔다 — 자물쇠를 부순 것이 아니라 **옆문으로 걸어 나간** 것이다
//    (재현 R1 · 위협 43). 그래서 판정 기준을 「목적지가 open 인가」가 아니라
//    **「목적지가 사용자 데이터를 읽게 하는가」**로 바꿨다.
const READS_USER_DATA = new Set(["open", "maintenance"]);
const MODES = ["open", "maintenance", "restore_closed"];

export async function setMode(env, mode, { now = Date.now(), markFns = [] } = {}) {
  if (!MODES.includes(mode)) throw new Error("unknown mode: " + mode);
  const cur = await gateRow(env);
  if (cur && cur.mode === "restore_closed" && READS_USER_DATA.has(mode)) {
    // ⚠️ **보고서를 받아서 믿지 않는다. 여기서 다시 돌린다.** 받아서 믿으면 `{canReopen:true}`
    //    한 줄이 곧 통과다 — 검사를 인자로 우회하는 그 무늬가 정확히 restoreGate 에서
    //    고친 것이다(2026-08-19). 이제 **인자 자체가 없다**: 키 재료도 코드가 소유한다.
    const rep = await reopenReport(env, { markFns, now });
    if (!rep.canReopen)
      throw new Error("restore_closed 에서 읽기를 다시 열 수 없다 — "
        + (rep.why.join(" · ") || "canReopen 이 거짓이다"));
    // ⚠️ **`maintenance` 로 곧장 가지 않는다.** 검증을 통과했다면 갈 곳은 `open` 이고,
    //    거기서 다시 `maintenance` 로 내리면 된다. 길을 하나로 두면 「어느 길에 자물쇠가
    //    빠졌나」를 세지 않아도 된다 — 빠뜨림이 생기는 자리가 애초에 없다.
    if (mode !== "open")
      throw new Error("restore_closed 에서는 open 으로만 나간다 — "
        + `${mode} 로 가려면 open 을 거친다(읽기가 열리는 전환은 한 길뿐이다)`);
  }
  // ⚠️ **판정에 쓴 게이트가 그 사이에 바뀌었으면 쓰지 않는다(CAS).** 재개방 판정은 질의 여러
  //    번이라 그 동안 다른 운영자가 전환할 수 있고, 그러면 사람이 본 근거와 실제 상태가 갈린다.
  //    `mode` 와 `epoch` 을 함께 조건에 넣어 **닫히는 쪽으로** 실패시킨다.
  const r = await env.LEDGER.prepare(
    `UPDATE maintenance SET mode = ?, epoch = epoch + 1,
            closed_at = CASE WHEN ? = 'open' THEN NULL ELSE ? END,
            drained_at = NULL
      WHERE id = 1 AND mode = ? AND epoch = ?`)
    .bind(mode, mode, now, cur.mode, cur.epoch).run();
  if (!(r.meta && r.meta.changes))
    throw new Error("유지보수 전환이 경합했다 — 판정에 쓴 epoch 이 이미 바뀌었다. 다시 판정한다");
  return await gateRow(env);
}

// 게이트 한 줄. 여러 함수가 같은 질의를 하고 있었다 — 한 곳으로 모은다.
const gateRow = (env) => env.LEDGER.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").first();

// ⚠️ **보고서에 유효기간을 두지 않는다.** 두려던 이유는 「사람이 보고서를 들고 있다가 나중에
//    쓰는 것」을 막기 위해서였는데, 그건 애초에 보고서를 **받아서 믿을 때만** 생기는 위험이다.
//    지금 `setMode` 는 보고서를 받지 않고 그 자리에서 다시 판정한다 — 낡을 값 자체가 없다.

// ── drain 확인 ───────────────────────────────────────────────────────────
// **온라인 workload 전체의 drain 이다**(2026-08-18 결정 A′ · 크론 편입). 임차증을 드는 것은
// `worker/index.js` 의 HTTP 요청 하나하나와 `worker/cleanup/` 의 정리 크론 실행이다.
// 분류표는 설계서 §10-9-6 이고, 거기 없는 것은 **B(운영 명령)** 와 **C(공개 상태 확인)** 뿐이다.
//
// ⚠️ **옛 주석은 「이것은 삭제 saga 의 drain 이다」였다.** 그때는 그게 사실이었고, 그 값을
//    「모든 쓰기가 멈췄다」로 읽은 것이 위협 32 였다. 지금은 범위가 넓어졌지만 **결론은 같다** —
//    `drained_at` 을 적는다고 주 D1 복원이 허용되지 않는다. restoreGate() 를 보라.
export async function markDrained(env, now = Date.now()) {
  const n = await activeLeases(env, now);
  if (n !== 0) return { drained: false, activeLeases: n };
  await env.LEDGER.prepare("UPDATE maintenance SET drained_at = ? WHERE id = 1").bind(now).run();
  return { drained: true, activeLeases: 0, drainedAt: now };
}

// ── reconciliation — **승격만 한다(promote-only)** ───────────────────────
//
// 무엇을 하나: `confirmed_at IS NULL` 인 표식마다, 주 D1 에 대응 계정이 아직 있는지 본다.
//   계정이 **없다** → 삭제는 됐고 확정 기록만 실패한 것이다 → confirmed 로 **승격**
//   계정이 **있다** → 삭제가 실패한 것이다 → **아무것도 하지 않는다**
//
// ⚠️ **살아 있는 계정의 pending 을 지우지 않는다.** 2판 설계는 지웠고, 그 삭제가 유일한
//    위험원이었다: 훑는 도중에 그 사용자가 삭제를 성공시키면 「표식 없는 삭제」가 만들어진다.
//    승격 판정은 뒤집히지 않는다 — 계정이 없다가 다시 생기는 유일한 길은 재가입이고
//    재가입은 **새 UUID** 라 HMAC 이 다르다.
//
// ⚠️ 그래도 유지보수 모드에서만 돈다. promote-only 는 판정 자체를 안전하게 만든 것이고,
//    유지보수 요구는 그 위에 얹는 두 번째 자물쇠다. **둘 중 하나만 믿지 않는다.**
export async function reconcile(env, { mark, now = Date.now(), pageSize = 500 } = {}) {
  const gate = await gateRow(env);
  if (gate.mode === "open") return { ok: false, why: "maintenance 가 open 이다" };
  const n = await activeLeases(env, now);
  if (n !== 0) return { ok: false, why: `활성 deletion lease ${n}건 — drain 되지 않았다` };

  // `mark` 는 HMAC 이라 역산할 수 없다. 그래서 반대로 간다 — 주 D1 의 `users.id` 를
  // **페이지 단위로** 읽어 각각 HMAC 하고, 살아 있는 표식 집합을 만든다.
  const live = new Set();
  let after = "";
  for (;;) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM users WHERE id > ? ORDER BY id LIMIT ?").bind(after, pageSize).all();
    if (!results || !results.length) break;
    for (const r of results) live.add(await mark(env, r.id));
    after = results[results.length - 1].id;
    if (results.length < pageSize) break;
  }

  const { results: pend } = await env.LEDGER.prepare(
    "SELECT mark, key_version FROM deletions WHERE confirmed_at IS NULL").all();
  const promoted = [], kept = [];
  for (const row of pend || []) {
    // ⚠️ 키 버전이 다르면 **자동으로 판단하지 않는다.** 지금 키로 만든 집합과 대조할 수 없다.
    if (row.key_version !== DELETION_KEY_VERSION) { kept.push(row.mark); continue; }
    if (live.has(row.mark)) { kept.push(row.mark); continue; }   // 계정이 살아 있다 → 그대로 둔다
    promoted.push(row.mark);
  }
  for (const m of promoted) {
    await env.LEDGER.prepare(
      "UPDATE deletions SET confirmed_at = ?, expires_at = ? WHERE mark = ? AND confirmed_at IS NULL")
      .bind(now, now + CONFIRMED_RETENTION, m).run();
  }
  return { ok: true, scanned: live.size, promoted: promoted.length, kept: kept.length };
}

// ── stale pending 의 수동 제거 ───────────────────────────────────────────
// **자동 경로가 아니다.** 시간이 지났다는 이유로는 절대 지우지 않는다.
// 다섯 조건을 **전부** 만족해야 한다. 특히 ④ — 계정이 여전히 있는지 **그 자리에서 재확인**한다.
// 재확인 없이 지우면 그 사이에 삭제된 계정의 표식을 지우게 되어 「표식 없는 삭제」가 된다.
export async function removeStalePending(env, marks, { mark, now = Date.now(), confirmedByOperator = false } = {}) {
  if (!confirmedByOperator) return { ok: false, why: "운영 판정이 없다 — 자동·시간 기반 제거는 금지다" };
  const gate = await gateRow(env);
  if (gate.mode === "open") return { ok: false, why: "maintenance 가 open 이다" };
  if ((await activeLeases(env, now)) !== 0) return { ok: false, why: "활성 deletion lease 가 있다" };
  if (typeof mark !== "function") return { ok: false, why: "계정 존재 재확인 수단이 없다" };

  // ④ 지금 이 자리에서 다시 훑는다. 위 reconcile 의 결과를 물려받지 않는다 —
  //    그 사이에 상태가 바뀌었을 수 있고, 바뀌었을 때 지우면 안 되는 것이 정확히 이 표식이다.
  const live = new Set();
  const { results } = await env.DB.prepare("SELECT id FROM users").all();
  for (const r of results || []) live.add(await mark(env, r.id));

  const removed = [], refused = [];
  for (const m of marks) {
    const row = await env.LEDGER.prepare(
      "SELECT confirmed_at FROM deletions WHERE mark = ?").bind(m).first();
    // confirmed 를 이 경로로 지우지 않는다. 그건 만료로만 사라진다.
    if (!row || row.confirmed_at !== null) { refused.push(m); continue; }
    if (!live.has(m)) { refused.push(m); continue; }   // 계정이 없다 → 승격 대상이지 제거 대상이 아니다
    await env.LEDGER.prepare("DELETE FROM deletions WHERE mark = ? AND confirmed_at IS NULL").bind(m).run();
    removed.push(m);
  }
  return { ok: true, removed: removed.length, refused: refused.length };
}

// ── 주 D1 복원 사전점검 ──────────────────────────────────────────────────
// ⚠️ **이것은 「실행되는 통제」가 아니라 「실행되는 사전점검」이다.** 2026-08-19 에 표현을
//    고쳤다: 예전 주석은 「문서가 아니라 실행되는 검사다」라고만 적어, 이 함수가 복원을
//    **막는다**고 읽히게 두었다. 막지 못한다 — `wrangler d1 time-travel restore` 는 계정
//    권한으로 실행되고 이 코드를 지나지 않는다. 사람이 기억해야 도는 규칙이 잊히는 것은
//    사실이고, 그래서 조건을 코드에 두는 것은 여전히 옳다. 다만 **막는다고 말하지 않는다.**
//
// **아래 조건이 전부 참이어야** 복원 절차를 논의할 수 있다. **부분 충족은 충족이 아니다.**
// 개수를 여기 손으로 적지 않는다 — 판정은 언제나 `RESTORE_CONDITIONS` 전수다.
//
// 전역 user-data drain 은 2026-08-18 에 구현됐다(A′ · 정리 크론 포함). 그래도 지금은
// **여전히 거부**다 — `noActiveLeases`(질의해야 안다) · `oldDeployments` · `regressionTests`
// 셋이 미충족이기 때문이다. 그것이 맞는 상태다.
export const RESTORE_CONDITIONS = [
  ["globalDrain", "§10-9-6 의 온라인 workload 전부(HTTP 요청 · 정리 크론)를 포괄하는 전역 drain 이 구현됐다"],
  ["drainQueryable", "그 drain 이 질의 가능한 0/비0 값을 낸다"],
  ["restoreClosed", "restore_closed 상태가 구현됐다 — 읽기·세션 인증까지 막는다"],
  ["userDataDrain", "사용자 데이터 read/write 전체의 in-flight drain 이 0임을 질의할 수 있다"],
  // ⚠️ **이 줄만 「구현됐나」가 아니라 「지금 이 순간 0인가」다.** 구조가 있어도 요청이 돌고
  //    있으면 복원하면 안 된다. 값은 반드시 `drainReport()` 로 **질의해서** 넣는다.
  ["noActiveLeases", "지금 활성·stale 임차증이 0건이다(질의 결과여야 한다. 손으로 true 를 적지 않는다)"],
  ["reopenChecks", "재삭제·CASCADE 잔여·세션 검사 전에는 읽기를 다시 열지 않는다"],
  ["oldDeployments", "옛 배포 세대가 게이트를 무시할 수 없음이 증명됐다(D1~D12 · T8 이 「거부됨」)"],
  ["ledgerNoRestore", "ledger 가 자기 자신을 제자리 복원하지 않는 구조다"],
  ["regressionTests", "T1~T8 · T40~T47 이 통과한다"],
];

// 지금 참인 것만 적는다. **참이 아닌 것을 참으로 적지 않는다.**
export const RESTORE_STATE = {
  // ✅ 2026-08-18 결정 A′ — 주 D1 사용자 데이터를 만지는 **작업 하나에 임차증 하나**.
  //    주 D1 첫 접근 전에 따고 가장 바깥 finally 에서 푼다.
  //    ⚠️ **처음에는 HTTP 요청만 셌고, 그건 참이 아니었다** — 정리 크론이 게이트만 읽고
  //       임차증 없이 주 D1 을 지워서, 지우는 도중에 drained:true 가 나왔다(재현 · T47b).
  //       크론을 같은 임차증에 넣은 뒤에만 이 두 줄이 참이다.
  globalDrain: true,       // worker/index.js(HTTP) + worker/cleanup/(cron) 전부
  drainQueryable: true,    // drainState() 가 {open, stale, live, drained} 를 답한다
  restoreClosed: true,     // worker/index.js 의 maintenanceAllows()
  userDataDrain: true,     // 읽기 경로도 같은 임차증을 든다(T6b) · 크론의 주 D1 접근도(T47b)
  // ⛔ **기본값이 false 다. 질의 없이는 절대 참이 아니다.**
  noActiveLeases: false,
  reopenChecks: true,      // 아래 reopenReport()
  oldDeployments: false,   // 배포 삭제·Access 는 원격 작업이고 별도 승인 대상이다
  ledgerNoRestore: true,   // worker/ledger-schema.sql 머리말 · 병합으로만 다룬다
  // ⛔ **T8 이 아직 「거부됨」이 아니다** — 게이트를 읽지 않는 옛 배포 세대는 로컬 코드로 못 막는다.
  regressionTests: false,
};

// ── 이 파일은 복원을 **막지 못한다.** 사전점검일 뿐이다 ──────────────────
//
// ⚠️ **정확히 말한다.** `wrangler d1 time-travel restore` 는 계정 권한을 가진 사람이 이 코드와
//    무관하게 실행할 수 있다. 여기 있는 함수들은 그 명령을 막지 못하고, 막는 척해서도 안 된다.
//    이것이 하는 일은 하나다 — **「지금 복원해도 되나」의 답을 질의 결과로 만들어 놓고,
//    실수로 열리지 않게 한다.** 실제 통제는 코드 밖에 있다: 계정 권한, 승인 절차, 그리고
//    옛 배포를 없애는 일(§10-8-1). 그래서 아래 보고서는 언제나 `restoreAllowed: false` 다.
const RESTORE_PREFLIGHT_ONLY =
  "이 검사는 사전점검이다. `wrangler d1 time-travel restore` 는 앱 코드가 막지 못한다 — "
  + "복원은 사고 대응으로 승격해 별도 승인을 받는다";

// **질의로만 정해지는 조건.** 나머지는 코드가 소유하고, 밖에서 넘겨받지 않는다.
// ⚠️ 예전에는 `restoreGate(state)` 가 **임의의 객체**를 받아 그대로 믿었다. 그래서 아홉을 전부
//    `true` 로 적은 객체 하나면 게이트가 열렸고, 테스트가 실제로 그렇게 통과하고 있었다 —
//    「실행되는 검사」라고 적어 놓고 검사를 인자로 우회할 수 있는 상태였다.
const QUERIED = new Set(["noActiveLeases"]);

// 지금 이 순간의 drain 을 **질의해서** 상태 객체를 만든다.
// 손으로 `noActiveLeases: true` 를 적는 것을 막으려고 이 함수를 둔다 —
// 값이 코드가 아니라 DB 에서 와야 증거가 된다.
// ⚠️ **base 인자를 받지 않는다.** 받으면 그 자리가 곧 우회로다.
export async function drainReport(env, now = Date.now()) {
  const d = await drainState(env, now);
  return { state: { ...RESTORE_STATE, noActiveLeases: d.drained }, drain: d, at: now };
}

// 판정. **코드가 소유한 조건은 인자로 못 바꾼다** — 밖에서 오는 것은 질의 결과 하나뿐이다.
export function restoreGate(report) {
  const q = (report && report.state) || {};
  const missing = RESTORE_CONDITIONS.filter(([k]) =>
    QUERIED.has(k) ? !q[k] : !RESTORE_STATE[k]);
  return {
    // 미충족이 0 이어도 **복원이 허용되지는 않는다.** 이 코드는 wrangler 를 막지 못하므로
    // 「허용」이라고 말할 자격이 없다 — 말할 수 있는 것은 「사전점검을 통과했다」까지다.
    preflightPassed: missing.length === 0,
    allowed: false,
    restoreAllowed: false,
    why: RESTORE_PREFLIGHT_ONLY,
    missing: missing.map(([k, why]) => `${k}: ${why}`),
  };
}

// 지금 상태를 **질의해서** 사전점검을 돌린다. 운영자가 부르는 것은 이것이다.
export async function restorePreflight(env, now = Date.now()) {
  const rep = await drainReport(env, now);
  const gate = restoreGate(rep);
  // ⚠️ **전체 미확정 개수다. 경보 대상 개수가 아니다**(2026-08-19 · 재현 R3). 예전에는
  //    `pending_alert_at < now` 로 걸러서, 방금 실패한 삭제가 여기서 0 으로 보였다.
  return { ...gate, drain: rep.drain, openPending: await pendingTotalCount(env), at: now };
}

// 복원 절차 진입. **언제나 거부한다.** 지금 `RESTORE_CONDITIONS` 중 셋이 코드 상수로 false 이고
// (⑦ 옛 배포 차단 · ⑨ T8 · ⑤ 는 질의값), 그 셋이 참이 되는 길은 이 저장소 안에 없다.
// ⚠️ **강제 진행 인자를 만들지 않는다.** 한 번 만들면 급할 때 쓰이고, 급할 때가 정확히 쓰면 안 되는 때다.
export function beginRestore(report) {
  const g = restoreGate(report);
  const e = new Error("주 D1 복원은 지금 금지다 — " + RESTORE_PREFLIGHT_ONLY
    + (g.missing.length ? "\n  미충족 " + g.missing.length + "건:\n  " + g.missing.join("\n  ") : ""));
  e.code = "RESTORE_FORBIDDEN";
  throw e;
}

// ── 재개방 판정 — **증거를 이 함수가 직접 만든다** ───────────────────────
//
// ⚠️ 예전에는 `reopenReport(env, { targets })` 가 **호출자가 준 목록**을 그대로 셌다.
//    그래서 `targets: []` 를 넘기면 잔여도 0, 살아 있는 계정도 0 이라 **`canReopen: true`** 가
//    나왔다 — 아무것도 확인하지 않고 읽기를 다시 여는 길이다. 목록을 인자로 받는 한, 그
//    인자를 검증하는 새 규칙을 아무리 얹어도 **결국 인자를 믿는 함수**다.
//    그래서 인자를 없앴다: 대상 집합은 여기서 **주 D1 과 ledger 를 직접 읽어** 만든다.
//
// 밖에서 받는 것은 `markFns` 하나뿐이고, 그건 목록이 아니라 **키 재료**다(HMAC 함수).
// 키는 env 에 있고 이 파일은 그것을 모르므로 받을 수밖에 없다 — 그리고 이것으로는
// 판정을 유리하게 바꿀 수 없다: 틀린 함수를 주면 대상이 **늘어나지 줄지 않는다**
// (표식이 안 맞으면 confirmed 집합과 대조되지 않아 잔여가 남은 채로 거부된다).
export async function reopenReport(env, { markFns = [], now = Date.now() } = {}) {
  const gate = await gateRow(env);
  const why = [];
  // ① 지금 모드가 `restore_closed` 인가. open·maintenance 에서 「다시 연다」는 말은 뜻이 없다.
  if (gate.mode !== "restore_closed") why.push(`지금 모드가 ${gate.mode} 다 — restore_closed 에서만 판정한다`);
  // ② 계정 존재를 다시 확인할 수단이 있나. 없으면 판정하지 않는다(removeStalePending 과 같은 규칙).
  const usable = Array.isArray(markFns) && markFns.length > 0 && markFns.every((f) => typeof f === "function");
  if (!usable) why.push("계정 존재 재확인 수단(markFns)이 없다 — 대상 집합을 만들 수 없다");
  // ③ 지금 이 순간 임차증이 0 인가. **stale 도 0 이어야 한다**(만료는 해제가 아니다).
  const drain = await drainState(env, now);
  if (!drain.drained) why.push(`임차증 ${drain.open}건(stale ${drain.stale}) — 아직 도는 작업이 있다`);
  // ④ 확정되지 않은 삭제 표식이 남아 있나. 남았다면 누구를 다시 지워야 하는지가 아직 미정이다.
  //    ⚠️ **전체 개수다.** 경보 시각(`pending_alert_at`)은 여기서 안 본다 — 방금 실패한 삭제도
  //       「누구를 다시 지워야 하는지 모른다」이고, 그건 시간이 지난다고 해결되지 않는다(재현 R3).
  const openPending = await pendingTotalCount(env);
  if (openPending > 0) why.push(`미확정 삭제 표식 ${openPending}건 — 사람이 판정해야 한다`);

  // ⑤ 재삭제 대상. **여기서 만든다.** 확정 표식은 ledger 에서 직접 읽고, 계정은 주 D1 을
  //    페이지 단위로 훑어 키 버전마다 HMAC 해서 대조한다(restoreTargets).
  let targets = [], scanned = 0;
  if (usable) {
    const { results } = await env.LEDGER.prepare(
      "SELECT mark, key_version, confirmed_at FROM deletions WHERE confirmed_at IS NOT NULL").all();
    const userMarks = await scanUserMarks(env, markFns);
    scanned = userMarks.length;
    targets = restoreTargets(userMarks, results || []);
  }

  const inList = targets.map(() => "?").join(",") || "''";
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first());
  const leftovers = {};
  for (const t of ["sessions", "books", "invite_codes"]) {
    const r = await q(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id IN (${inList})`, ...targets);
    leftovers[t] = r.n;
  }
  const fr = await q(
    `SELECT COUNT(*) AS n FROM friendships WHERE requester_id IN (${inList}) OR addressee_id IN (${inList})`,
    ...targets, ...targets);
  leftovers.friendships = fr.n;
  // ⑥ 대상이 남아 있다 = 재삭제가 아직 안 끝났다. **대상 수와 삭제 결과 수가 맞아야 한다** —
  //    그 검증식이 곧 「targets 가 전부 사라졌나」다(설계서 §10-8 6번).
  const alive = await q(`SELECT COUNT(*) AS n FROM users WHERE id IN (${inList})`, ...targets);
  if (alive.n !== 0) why.push(`재삭제 대상 ${alive.n}명이 아직 살아 있다`);
  for (const [t, n] of Object.entries(leftovers)) if (n !== 0) why.push(`${t} 에 잔여 ${n}행`);

  return {
    epoch: gate.epoch, at: now, mode: gate.mode,
    targets: targets.length, scannedUsers: scanned,
    stillAlive: alive.n, leftovers, openPending, drain,
    canReopen: why.length === 0,
    why,
  };
}

// ── ledger 병합 — **제자리 복원을 하지 않기 위한 장치** ──────────────────
//
// 표식 DB 는 과거로 되돌리지 않는다. 되돌리면 게이트(`maintenance`)·epoch·lease 가 **함께**
// 과거로 가서, 「지금 유지보수 중인가」를 판정하는 근거 자체가 뒤집힌다.
// 그래서 복구가 필요하면 ① 지금 것을 내보내고 ② 과거 것을 **별도 인스턴스**로 읽어
// ③ 두 목록을 병합한 결과를 **새로 쓴다.**
//
// 이 함수는 **순수 함수**다 — DB 도, 시각도, 난수도 만지지 않는다. 그래야 테스트가
// 진짜 `time-travel restore` 를 부르지 않고도 병합 규칙을 잴 수 있다.
//
// ⚠️ **강제 진행 경로가 없다.** 판단할 수 없으면 `ok:false` 를 돌려주고 끝이다.
//    「어떻게든 진행」 플래그를 만들면 급할 때 쓰이고, 급할 때가 정확히 쓰면 안 되는 때다.
export function mergeDeletions(cur, old) {
  // ① 두 내보내기가 **검증됐는가.** 해시가 안 맞거나 내보내기가 실패했으면 병합하지 않는다 —
  //    검증할 수 없는 입력으로 만든 결과는 그 자체가 새로운 사실이 되어 버린다.
  for (const [name, side] of [["cur", cur], ["old", old]]) {
    if (!side || side.ok !== true) return { ok: false, why: `${name} 내보내기가 검증되지 않았다` };
    if (!Array.isArray(side.rows)) return { ok: false, why: `${name} 행 목록이 없다` };
  }
  const out = new Map();
  const put = (r) => out.set(r.mark, { ...r });
  for (const r of cur.rows) put(r);
  for (const r of old.rows) {
    const a = out.get(r.mark);
    if (!a) { put(r); continue; }
    // ② **키 버전이 다르면 자동으로 판단하지 않는다.** 같은 표식이 다른 키에서 나왔다는 것은
    //    충돌이거나 오염이고, 어느 쪽이든 사람이 봐야 한다.
    if (a.key_version !== r.key_version)
      return { ok: false, why: `key_version 충돌: mark ${String(r.mark).slice(0, 8)}… (${a.key_version} vs ${r.key_version})` };
    // ③ 방향은 **언제나 보호가 길어지는 쪽**이다.
    //    · confirmed_at 은 **더 늦은 값** — 이른 값을 고르면 expires_at 이 짧아져 보호가 준다
    //    · expires_at  은 **더 큰 값** — 보존을 짧게 하는 방향은 언제나 위험한 쪽
    //    · pending_at  은 **더 이른 값** — 최초 시도 시각이 사실이다. 늦은 값을 쓰면
    //      pending_alert_at 이 밀려 경보가 늦는다
    const later = (x, y) => (x == null ? y : y == null ? x : Math.max(x, y));
    const earlier = (x, y) => (x == null ? y : y == null ? x : Math.min(x, y));
    a.confirmed_at = later(a.confirmed_at, r.confirmed_at);
    a.expires_at = Math.max(a.expires_at, r.expires_at);
    a.pending_at = earlier(a.pending_at, r.pending_at);
    a.pending_alert_at = earlier(a.pending_alert_at, r.pending_alert_at);
  }
  return { ok: true, rows: [...out.values()].sort((x, y) => String(x.mark).localeCompare(String(y.mark))) };
}

// ── 복원 후 재삭제 대상 산출 ─────────────────────────────────────────────
//
// `mark` 는 HMAC 이라 역산할 수 없다. 그래서 반대로 간다 — 복원된 `users.id` 를 읽어
// **키 버전마다** HMAC 하고, 확정 표식 집합에 있는지 본다.
//
// ⚠️ **표식 개수로 세지 않는다.** 키를 돌린 뒤에는 같은 사람에게 v1·v2 표식이 둘 다 있을 수
//    있어서, 개수로 검증하면 **정상 상황이 실패로 판정**된다. 세는 단위는 **고유 UID** 다.
// ⚠️ **pending 은 재삭제 근거가 아니다.** pending 은 「삭제를 시도했다」이지 「삭제됐다」가
//    아니다 — 그것으로 지우면 실패 응답을 받고 계속 쓰던 사람의 계정을 예고 없이 지운다.
//    confirmed 만 대상이다.
export function restoreTargets(userMarks, ledgerRows) {
  const confirmed = new Set(ledgerRows.filter((r) => r.confirmed_at != null).map((r) => r.mark));
  const targets = [];
  for (const { uid, marks } of userMarks) {
    if (marks.some((m) => confirmed.has(m))) targets.push(uid);
  }
  // 고유 UID 목록. 「지운 users 행 수 == 이 길이」가 복원 절차의 검증식이다.
  return [...new Set(targets)];
}

// 복원된 주 D1 을 훑어 위 함수에 넘길 입력을 만든다. **페이지 단위**로 읽는다 —
// 한 번에 다 읽으면 계정이 늘었을 때 그 자리에서 터진다.
export async function scanUserMarks(env, markFns, pageSize = 500) {
  const out = [];
  let after = "";
  for (;;) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM users WHERE id > ? ORDER BY id LIMIT ?").bind(after, pageSize).all();
    if (!results || !results.length) break;
    for (const r of results) {
      const marks = [];
      // **여러 key version 을 전부 시도한다.** 하나만 보면 회전 이전에 지워진 사람이 빠진다.
      for (const fn of markFns) marks.push(await fn(r.id));
      out.push({ uid: r.id, marks });
    }
    after = results[results.length - 1].id;
    if (results.length < pageSize) break;
  }
  return out;
}
