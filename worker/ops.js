// 운영 명령. **HTTP 라우트가 아니다.** 사람이 실행하고 사람이 판정한다.
//
// 왜 코드로 두나: 「증거 없이는 거부한다」가 성립하려면 증거가 **질의 가능**해야 하고,
// 거부가 사람의 기억이 아니라 실행되는 검사여야 하기 때문이다. 문서에만 있는 규칙은 잊힌다.
//
// ⚠️ 여기에는 **강제 진행 플래그가 없다.** `force`·`fallback`·`skipChecks` 를 만들지 않는다 —
//    한 번 만들면 급할 때 쓰이고, 급할 때가 정확히 쓰면 안 되는 때다.
import { activeLeases, drainState, openPendingCount, DELETION_KEY_VERSION, CONFIRMED_RETENTION } from "./ledger.js";

// ── 유지보수 전환 ────────────────────────────────────────────────────────
// **epoch 를 함께 올린다.** 이 순간부터 새 lease 를 딸 수 없고, 옛 epoch 의 lease 를 든
// 요청은 fencing 을 통과하지 못한다.
export async function setMode(env, mode, now = Date.now()) {
  if (!["open", "maintenance", "restore_closed"].includes(mode)) throw new Error("unknown mode: " + mode);
  await env.LEDGER.prepare(
    `UPDATE maintenance SET mode = ?, epoch = epoch + 1,
            closed_at = CASE WHEN ? = 'open' THEN NULL ELSE ? END,
            drained_at = NULL
      WHERE id = 1`).bind(mode, mode, now).run();
  return await env.LEDGER.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").first();
}

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
  const gate = await env.LEDGER.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").first();
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
  const gate = await env.LEDGER.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").first();
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

// ── 주 D1 복원 금지 gate ─────────────────────────────────────────────────
// **문서가 아니라 실행되는 검사다.** 사람이 기억해야 도는 규칙은 언젠가 잊힌다.
//
// **아래 9개 조건이 전부 참일 때만** 복원 절차의 1번을 시작할 수 있다. **부분 충족은 충족이
// 아니다.** 개수를 여기 손으로 적지 않는다 — 판정은 언제나 `RESTORE_CONDITIONS` 전수다.
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

// 지금 이 순간의 drain 을 **질의해서** 상태 객체를 만든다.
// 손으로 `noActiveLeases: true` 를 적는 것을 막으려고 이 함수를 둔다 —
// 값이 코드가 아니라 DB 에서 와야 증거가 된다.
export async function drainReport(env, base = RESTORE_STATE, now = Date.now()) {
  const d = await drainState(env, now);
  return { state: { ...base, noActiveLeases: d.drained }, drain: d };
}

export function restoreGate(state = RESTORE_STATE) {
  const missing = RESTORE_CONDITIONS.filter(([k]) => !state[k]);
  return {
    allowed: missing.length === 0,
    missing: missing.map(([k, why]) => `${k}: ${why}`),
  };
}

// 복원 절차 진입. **gate 가 거부하면 여기서 끝난다.**
export function beginRestore(state = RESTORE_STATE) {
  const g = restoreGate(state);
  if (!g.allowed) {
    const e = new Error("주 D1 복원은 지금 금지다 — 미충족 " + g.missing.length + "건:\n  " + g.missing.join("\n  "));
    e.code = "RESTORE_FORBIDDEN";
    throw e;
  }
  return { ok: true };
}

// `restore_closed` 를 풀 수 있나. 다섯을 **전부** 확인한다.
// 하나라도 미달이면 읽기를 다시 열지 않는다. 「쓰기만 먼저 열자」도 하지 않는다 —
// 막으려는 것이 **읽기 노출**이기 때문이다.
export async function reopenReport(env, { targets = [], now = Date.now() } = {}) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first());
  const inList = targets.map(() => "?").join(",") || "''";
  const leftovers = {};
  for (const t of ["sessions", "books", "invite_codes"]) {
    const r = await q(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id IN (${inList})`, ...targets);
    leftovers[t] = r.n;
  }
  const fr = await q(
    `SELECT COUNT(*) AS n FROM friendships WHERE requester_id IN (${inList}) OR addressee_id IN (${inList})`,
    ...targets, ...targets);
  leftovers.friendships = fr.n;
  const alive = await q(`SELECT COUNT(*) AS n FROM users WHERE id IN (${inList})`, ...targets);
  return {
    targets: targets.length,
    stillAlive: alive.n,
    leftovers,
    openPending: await openPendingCount(env, now),
    canReopen: alive.n === 0 && Object.values(leftovers).every((n) => n === 0),
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
