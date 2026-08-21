// 삭제 표식 저장소(ledger D1) 접근. **주 D1 과 다른 데이터베이스다.**
//
// 왜 이 파일이 따로 있나: 같은 표를 세 곳이 만진다 — 요청 처리(worker/index.js) ·
// 운영 명령(worker/ops.js) · 정리 크론(worker/cleanup/index.js). SQL 이 세 벌이 되면
// 「confirmed 만 지운다」 같은 규칙이 한 곳에서만 지켜지는 상태가 생긴다.
//
// ⚠️ 여기에는 **사용자 데이터가 없다.** 들어가는 것은 되돌릴 수 없게 변환한 표식 하나뿐이다.

const ENC = new TextEncoder();
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// 표식 하나. **전용 키다** — RL_KEY·STATE_KEY·SIGNUP_STATE_KEY·TOMBSTONE_KEY·OAuth secret 어느
// 것도 겸용하지 않는다. 겸용하면 하나를 교체할 때 다른 하나가 같이 무너진다.
// 키가 없으면 **던진다.** 평문 해시로 되돌아가지 않는다 — 조용히 약한 쪽으로 도는 것이 가장 나쁘다.
export async function deletionMark(env, uid) {
  if (!env.DELETION_KEY) throw new Error("DELETION_KEY not configured");
  const k = await crypto.subtle.importKey("raw", ENC.encode(env.DELETION_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, ENC.encode(uid)));
}
// 키를 돌리면 이 숫자를 올리고 새 표식만 새 키로 만든다. 옛 표식은 보유기간 동안 그대로 둔다.
export const DELETION_KEY_VERSION = 1;

// ── 표식을 만드는 함수의 **레지스트리** ──────────────────────────────────
//
// ⚠️ 2026-08-19 까지는 `reopenReport(env, { markFns })`·`reconcile(env, { mark })` 가 **호출자가
//    넘긴 임의의 실행 함수**로 삭제 증거를 만들었다. 주석에는 「틀린 함수를 주면 대상이 늘어나지
//    줄지 않는다」고 적혀 있었는데 **정확히 반대**였다: 표식이 안 맞으면 확정 표식 집합과의
//    교집합이 비어 재삭제 대상이 **0** 이 되고, 잔여도 0 · 살아 있는 계정도 0 이라
//    `canReopen: true` 가 나왔다. 상수를 돌려주는 함수 하나로 되살아난 탈퇴자를 못 본 척할 수 있었다.
//
// 그래서 **코드가 키 재료를 소유한다.** 밖에서 받는 것은 아무것도 없다.
// 키 회전을 미래를 위해 미리 만들지 않는다 — 지금 지원하는 버전은 **하나뿐**이고,
// ledger 에 그 밖의 버전이 하나라도 있으면 자동 판정은 **거부**한다(아래 evidenceUsable).
export const DELETION_MARKERS = new Map([[DELETION_KEY_VERSION, deletionMark]]);

// ── 키가 그때 그 키인가 ──────────────────────────────────────────────────
//
// 인자를 막아도 **`env.DELETION_KEY` 자체가 다른 배포**에서는 같은 착시가 난다: 표식이 하나도
// 안 맞아 「다 지워졌다」로 보이고, reconciliation 은 **살아 있는 계정의 pending 을 승격**한다
// (재현 R4). HMAC 은 역산할 수 없으니 표식으로는 키를 검증할 수 없다 — 그래서 표식을 처음
// 남길 때 **키 검사값**을 함께 적어 두고, 나중에 그것과 대조한다.
//
// ⚠️ 검사값은 uid 를 담지 않는다. 고정 문자열 하나의 HMAC 이라 여기서 새는 개인정보가 없다.
const KEY_CHECK_MSG = "shhh!/deletion-key-check/v";
const keyCheck = async (env, version = DELETION_KEY_VERSION) => {
  if (!env.DELETION_KEY) throw new Error("DELETION_KEY not configured");
  const k = await crypto.subtle.importKey("raw", ENC.encode(env.DELETION_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, ENC.encode(KEY_CHECK_MSG + version)));
};

// 처음 쓰는 키면 적어 두고(TOFU), 이미 적혀 있으면 **같은 키인지 확인한다.**
// 다르면 **던진다** — 옛 증거와 어긋나는 키로 새 표식을 남기면 그 두 벌은 영원히 대조되지 않는다.
export async function rememberDeletionKey(env, now = Date.now()) {
  const want = await keyCheck(env);
  await env.LEDGER.prepare(
    "INSERT OR IGNORE INTO deletion_keys (key_version, key_check, created_at) VALUES (?, ?, ?)")
    .bind(DELETION_KEY_VERSION, want, now).run();
  const row = await env.LEDGER.prepare(
    "SELECT key_check FROM deletion_keys WHERE key_version = ?").bind(DELETION_KEY_VERSION).first();
  if (!row || row.key_check !== want) throw new Error("DELETION_KEY mismatch");
}

// **자동 판정을 해도 되는 상태인가.** 셋을 본다. 하나라도 아니면 사람이 봐야 한다.
//   ① ledger 의 key_version 이 전부 레지스트리에 있다   ② 표식이 있으면 키 검사값이 적혀 있다
//   ③ 지금 env 의 키가 그 검사값과 같다
// 표식이 하나도 없으면 판정할 것도 없으므로 통과다(빈 ledger 로 시작한 배포가 여기서 막히면
// 유지보수 명령을 아예 못 쓴다).
export async function deletionEvidenceUsable(env) {
  const why = [];
  const { results } = await env.LEDGER.prepare(
    "SELECT DISTINCT key_version AS v FROM deletions").all();
  const versions = (results || []).map((r) => r.v);
  const unknown = versions.filter((v) => !DELETION_MARKERS.has(v));
  if (unknown.length) why.push(`모르는 삭제 key_version ${unknown.join(",")} 이 있다 — 그 표식은 대조할 수 없다`);
  let want = null;
  try { want = await keyCheck(env); } catch { /* 아래에서 판정한다 */ }
  // ⚠️ **표식이 0건이어도 키 기록이 있으면 대조한다**(2026-08-20 · T64). 예전에는 `deletions`
  //    가 비면 통째로 건너뛰어서, 확정 표식이 전부 만료된 뒤 **키가 어긋난 배포가 「쓸 수 있다」로
  //    보였다.** 그 배포는 다음 삭제에서 `markPending` 이 던질 때까지 아무 신호도 안 낸다.
  const row = await env.LEDGER.prepare(
    "SELECT key_check FROM deletion_keys WHERE key_version = ?").bind(DELETION_KEY_VERSION).first();
  if (!row) {
    // 기록이 아예 없다 = 아직 아무것도 안 지운 배포다. 표식이 있는데 없으면 그건 이상하다.
    if (versions.length) why.push("삭제 키 검사값이 기록돼 있지 않다 — 지금 키가 그때 그 키인지 알 수 없다");
  } else if (want === null) why.push("DELETION_KEY 가 없다 — 기록된 검사값과 대조할 수 없다");
  else if (row.key_check !== want) why.push("지금 DELETION_KEY 가 표식을 만든 키와 다르다");
  return { ok: why.length === 0, why };
}

// pending 이 이 시간을 넘도록 확정되지 않으면 **경보**다. 지우는 시각이 아니다.
export const PENDING_ALERT = 24 * 3600e3;
// 확정된 표식을 얼마나 들고 있나. **기술적 보수 계산값이고 법정 보유기간이 아니다** —
//   max(가정한 Time Travel 30일, 수동 백업 규칙 7일) + 안전 여유 7일 = 37일.
// 요금제의 실제 복원 가능 기간과 백업 규칙이 확정되면 다시 계산한다. privacy.html 에는
// 이 숫자를 **법정 보유기간으로 적지 않는다**(확정 전에는 숫자 자체를 적지 않는다).
export const CONFIRMED_RETENTION = 37 * 86400e3;
// ponytail: lease 수명은 Worker 의 최대 실행시간보다 길어야 한다 — 짧으면 살아 있는 요청의
//   lease 가 먼저 만료돼 **drain 이 거짓으로 0** 이 된다. 120초는 실측이 아니라 여유값이다.
//   실제 p95 를 재서 좁힐 것(설계서 §10-9-5 Q6).
export const LEASE_TTL = 120e3;

// ── 유지보수 게이트 ──────────────────────────────────────────────────────
// 게이트의 진실 원본은 **이 행 하나**다. 환경변수가 아닌 이유: 환경변수는 배포 세대마다
// 다르게 전파되고, 이 저장소는 프로덕션 별칭이 배포 직후 약 1분간 옛 응답을 주는 것을 실측했다.
// 바인딩이 아예 없을 때 돌려주는 모드. **`open` 이 아니다.**
// ⚠️ 2026-08-19 까지는 여기서 `open` 을 돌려줬고, 그것이 fail-open 이었다: `LEDGER` 를 빠뜨린
//    배포가 게이트도 임차증도 없이 사용자 데이터를 읽고 썼다(재현 — `GET /book`·`PUT /book`
//    둘 다 200). 「게이트는 복원 중에만 뜻이 있다」는 근거는 **드러난 뒤에야** 참이다:
//    바인딩이 없으면 삭제 표식도 못 남기고 drain 도 못 세므로, 그 배포는 애초에 사용자
//    데이터를 만지면 안 된다. 지금은 `unbound` 를 돌려주고 `maintenanceAllows()` 가 막는다.
export const MODE_UNBOUND = "unbound";

export async function readMode(env) {
  if (!env.LEDGER) return { mode: MODE_UNBOUND, epoch: 0, bound: false };
  // ⚠️ 바인딩이 **있는데 질의가 실패**하면 열림으로 떨어지지 않는다. 그건 「모른다」이고,
  //    모를 때 게이트를 여는 것은 게이트가 없는 것과 같다.
  const r = await env.LEDGER.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").first();
  if (!r) throw new Error("maintenance row missing");
  return { mode: r.mode, epoch: r.epoch, bound: true };
}

// ── 작업 임차증(lease) ───────────────────────────────────────────────────
// **주 D1 의 사용자 데이터를 만지는 작업 하나에 임차증 하나다**(2026-08-18 결정 A′).
// SQL 문장마다가 아니다 — 문장 단위로 따면 한 작업이 여러 개를 들고, 그중 하나만 해제돼도
// drain 이 거짓으로 0 이 된다.
//
// **「작업」은 HTTP 요청만이 아니다.** 2026-08-18 재현: 정리 크론(`worker/cleanup/`)이
// `mode='open'` 을 읽은 뒤 임차증 없이 주 D1 을 지웠고, 그 사이에 `restore_closed` 로 전환하면
// `drainState()` 가 **`open:0 · drained:true`** 라고 답했다 — 크론이 아직 지우는 중인데
// 운영자는 「모두 멈췄다」로 읽는다. 그래서 크론도 같은 임차증을 든다.
//
// **허용 모드는 호출부가 인자로 말한다.** 예전에는 `mode <> 'restore_closed'` 가 여기 박혀
// 있었고, 그래서 「HTTP 요청의 규칙」이 곧 「모든 작업의 규칙」이 됐다 — 정리 크론이 이 함수를
// 쓰기 시작하면 유지보수 중에도 지우게 된다. 둘은 다른 규칙이므로 이름을 갈라 둔다.
//
//   REQUEST  `maintenance` 는 읽기를 허용하는 상태다(§10-7). 거기서 임차증을 거부하면 허용된
//            읽기가 추적 밖에서 돌게 되어 **재려던 것을 못 잰다.** 쓰기는 라우트 허용 목록이 막는다
//   CLEANUP  크론은 급하지 않다. 유지보수 중에는 **아예 시작하지 않는다** — 다음 시간에 돌면 된다
//
// ⚠️ 어느 목록에도 `restore_closed` 는 없다. 그 상태에서 신규 획득을 **원자적으로** 거부해야
//    활성 수가 0 으로 내려간다.
export const LEASE_MODES_REQUEST = ["open", "maintenance"];
export const LEASE_MODES_CLEANUP = ["open"];
const LEASABLE_MODES = new Set([...LEASE_MODES_REQUEST, ...LEASE_MODES_CLEANUP]);

// 게이트 확인과 INSERT 가 **한 문장**이다. 읽고 나서 쓰면 전환 직후의 작업이 창을 빠져나간다.
// 행이 안 생기면 = 지금 이 모드에서는 새 작업을 받지 않는다.
//
// 언제 딴다: **주 D1 의 사용자 데이터에 처음 닿기 전.** 세션 인증(`sessions`·`users` 조회)도
// 그 안에 든다 — 인증이 먼저 지나가면 그 조회는 추적 밖에서 일어난다.
// 언제 푼다: 그 작업의 **모든 DB 작업이 끝난 뒤**, 가장 바깥 `finally` 에서.
export async function acquireLease(env, modes = LEASE_MODES_REQUEST, now = Date.now()) {
  // ⚠️ 모드 문자열은 **신뢰된 상수만** 통과한다. 통과한 뒤에도 SQL 에 보간하지 않고
  //    placeholder 로만 넣는다 — 검증과 파라미터화 중 하나만 믿지 않는다.
  if (!Array.isArray(modes) || !modes.length) throw new Error("lease modes missing");
  for (const m of modes) if (!LEASABLE_MODES.has(m)) throw new Error("unknown lease mode");
  const id = crypto.randomUUID();
  const marks = modes.map((_, i) => `?${i + 4}`).join(",");
  const r = await env.LEDGER.prepare(
    `INSERT INTO write_leases (lease_id, epoch, started_at, expires_at)
     SELECT ?1, m.epoch, ?2, ?3 FROM maintenance m WHERE m.mode IN (${marks})`)
    .bind(id, now, now + LEASE_TTL, ...modes).run();
  return r.meta && r.meta.changes ? id : null;
}

// fencing. 이 조각을 **모든 ledger 쓰기의 WHERE 에** 붙인다 — 유지보수로 전환된 뒤에도
// 살아 있던 요청이 계속 쓰는 것을 막는다. 옛 epoch 의 lease 도 여기서 걸린다.
const FENCE = `EXISTS (SELECT 1 FROM write_leases l JOIN maintenance m ON m.id = 1
                        WHERE l.lease_id = ?LEASE
                          AND l.expires_at > ?NOW AND l.epoch = m.epoch)`;
const fenced = (sql) => sql.replace(/\?LEASE/g, "?").replace(/\?NOW/g, "?");

export async function leaseAlive(env, lease, now = Date.now()) {
  const r = await env.LEDGER.prepare(`SELECT 1 AS ok WHERE ${fenced(FENCE)}`).bind(lease, now).first();
  return !!r;
}

// 해제는 **행을 지운다.** UPDATE 로 표시만 남기지 않는 이유가 셋이다.
//   ① 요청마다 행이 하나씩 쌓이는데, 정리 크론은 한 시간에 200행씩만 지운다 —
//      요청이 시간당 200건을 넘으면 **표가 영원히 자란다**(A′ 로 바뀌면서 생긴 실제 위험이다).
//   ② 남겨서 읽는 곳이 없다. `drainState`·`FENCE` 는 **남아 있는 행만** 본다.
//   ③ 끝난 요청의 기록을 안 남기는 쪽이 개인정보 면에서도 낫다(요청 시각의 나열이 된다).
// ⚠️ **미해제 행은 여전히 안 지운다** — 그게 「끝났는지 모른다」의 유일한 증거다(stale).
//    그래서 이 표에 **남아 있다 = 아직 안 끝났다**이고, `released_at` 컬럼은 없다(2026-08-18).
export async function releaseLease(env, lease) {
  await env.LEDGER.prepare("DELETE FROM write_leases WHERE lease_id = ?").bind(lease).run();
}

// drain 상태. **이것이 「모든 사용자 데이터 요청이 끝났나」의 유일한 답이다.**
//
// ⚠️ **TTL 만료를 자동 해제로 치지 않는다.** 예전 `activeLeases` 는 `expires_at > now` 로 걸러서,
//    끝나지 않은 요청의 임차증이 **시간만 지나면 세지 않았다.** 그건 「끝났다」가 아니라
//    「모른다」이고, 모르는 것을 0 으로 세면 drain 증거가 곧 거짓말이 된다.
//    그래서 만료된 미해제 임차증은 **`stale` 로 따로 세고, 복원은 계속 막는다.**
export async function drainState(env, now = Date.now()) {
  const r = await env.LEDGER.prepare(
    `SELECT COUNT(*) AS open,
            COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS stale
       FROM write_leases`).bind(now).first();
  const open = Number(r && r.open) || 0, stale = Number(r && r.stale) || 0;
  //  live  아직 살아 있는 요청       stale  만료됐는데 해제되지 않은 것(= 죽은 요청일 수도 있다)
  //  drained  **둘 다 0** 일 때만 참이다
  return { open, stale, live: open - stale, drained: open === 0 };
}

// 옛 이름. **의미가 바뀌었다** — 만료로 걸러내지 않는다.
export async function activeLeases(env, now = Date.now()) {
  return (await drainState(env, now)).open;
}

// ── 삭제 표식 ────────────────────────────────────────────────────────────
// pending 을 남긴다. 같은 사람이 두 번 눌러도 행은 하나다.
export async function markPending(env, lease, mark, now = Date.now()) {
  // **키 검사값을 먼저 세운다.** 표식을 남기기 전에 「지금 키가 그때 그 키인가」를 확정해 둬야
  // 나중에 reconciliation 이 그 표식을 믿고 판정할 수 있다. 다르면 던진다 — 어긋나는 키로
  // 표식을 더하면 두 벌의 증거가 영원히 대조되지 않는다(위협 44).
  await rememberDeletionKey(env, now);
  await env.LEDGER.prepare(
    `INSERT INTO deletions (mark, key_version, pending_at, pending_alert_at, expires_at)
     SELECT ?, ?, ?, ?, ? WHERE ${fenced(FENCE)}
     ON CONFLICT (mark) DO NOTHING`)
    .bind(mark, DELETION_KEY_VERSION, now, now + PENDING_ALERT, now + CONFIRMED_RETENTION, lease, now).run();
  // **넣었는지 다시 묻는다.** 내가 넣었는지 앞선 시도가 넣었는지 가릴 이유가 없다 —
  // 필요한 답은 「지금 표식이 있나」 하나뿐이다.
  return !!(await env.LEDGER.prepare("SELECT 1 AS ok FROM deletions WHERE mark = ?").bind(mark).first());
}

// 확정. **expires_at 을 확정 시점 기준으로 다시 계산한다** — pending 때의 값은 임시값이다.
export async function markConfirmed(env, lease, mark, now = Date.now()) {
  const r = await env.LEDGER.prepare(
    `UPDATE deletions SET confirmed_at = ?, expires_at = ?
      WHERE mark = ? AND confirmed_at IS NULL AND ${fenced(FENCE)}`)
    .bind(now, now + CONFIRMED_RETENTION, mark, lease, now).run();
  return !!(r.meta && r.meta.changes);
}

// 정리. **이 파일에서 `deletions` 를 지우는 문장은 이것 하나뿐이고, `confirmed_at IS NOT NULL`
// 이 빠지면 안 된다.** 빠지면 「삭제는 됐는데 확정 기록만 실패한」 표식이 사라져 복원 때 그
// 사람이 되살아나고 아무도 알아채지 못한다. scripts/test-deletion-ledger.mjs 가 이 문장을 잰다.
export const DELETIONS_SWEEP_SQL =
  "DELETE FROM deletions WHERE confirmed_at IS NOT NULL AND expires_at < ?";

export async function sweepConfirmed(env, now = Date.now(), limit = 500) {
  const r = await env.LEDGER.prepare(
    `${DELETIONS_SWEEP_SQL} AND mark IN (SELECT mark FROM deletions
       WHERE confirmed_at IS NOT NULL AND expires_at < ? LIMIT ${Number(limit) | 0})`)
    .bind(now, now).run();
  return (r.meta && r.meta.changes) || 0;
}

// ── 미확정 표식을 세는 **두 가지** 질문 ──────────────────────────────────
//
// ⚠️ 2026-08-19 까지는 `openPendingCount()` 하나가 둘을 겸했고, 그 값은 **경보 정의**였다
//    (`pending_alert_at < now`). 그래서 방금 실패한 삭제(경보 시각은 24시간 뒤)가 **어느 쪽에도
//    안 잡혔고**, 「미확정 삭제 0건」이라는 근거로 재개방과 복원 사전점검이 통과했다(재현 R3).
//    「아직 경보할 때가 아니다」와 「아직 아무 문제 없다」는 다른 말이다.
//
//   pendingTotalCount  **안전 조건**이 쓴다. 확정 안 된 표식이 하나라도 있으면 누구를 다시
//                      지워야 하는지가 미정이다 — 시간이 지난다고 해결되지 않으므로 시각을 안 본다
//   pendingAlertCount  **경보**가 쓴다. 사람이 봐야 할 것이 쌓였나. `<` 는 엄격한 미만이다
//                      (경보 시각과 같은 순간은 아직 경보가 아니다)
export async function pendingTotalCount(env) {
  const r = await env.LEDGER.prepare(
    "SELECT COUNT(*) AS n FROM deletions WHERE confirmed_at IS NULL").first();
  return r.n;
}

export async function pendingAlertCount(env, now = Date.now()) {
  const r = await env.LEDGER.prepare(
    "SELECT COUNT(*) AS n FROM deletions WHERE confirmed_at IS NULL AND pending_alert_at < ?").bind(now).first();
  return r.n;
}

export async function cleanupState(env) {
  if (!env.LEDGER) return null;
  return await env.LEDGER.prepare(
    "SELECT last_ok_at, last_try_at, fail_streak, open_pending FROM cleanup_runs WHERE id = 1").first();
}

// ── 스키마가 실제로 거기 있나 ────────────────────────────────────────────
// `readMode()` 가 통과하는 것은 **`maintenance` 한 표**뿐이다. 그래서 ledger 를 만들고
// migration 을 절반만 걸어도(또는 `0001` 을 나중에 쪼개도) 게이트는 멀쩡히 답하고,
// **첫 계정 삭제에서만** 터진다 — 배포자가 아니라 사용자가 먼저 안다. 그 실패를 여기서 낸다.
// 한 문장으로 세 표와 컬럼까지 건드린다. 전부 작은 표라 COUNT 가 값싸고,
// 사용자 데이터도 아니다(표식은 되돌릴 수 없는 HMAC 하나뿐이다).
// ⚠️ 오류 문자열을 밖으로 내보내지 않는다 — D1 오류에는 표·컬럼 이름이 섞여 나온다.
export async function ledgerAnswers(env) {
  if (!env.LEDGER) return false;
  try {
    const r = await env.LEDGER.prepare(
      `SELECT (SELECT COUNT(*) FROM deletions WHERE key_version IS NOT NULL)
            + (SELECT COUNT(*) FROM write_leases WHERE expires_at IS NOT NULL)
            + (SELECT COUNT(*) FROM cleanup_runs WHERE id = 1)
            + (SELECT COUNT(*) FROM maintenance WHERE mode IS NOT NULL)
            + (SELECT COUNT(*) FROM deletion_keys WHERE key_check IS NOT NULL)
            + (SELECT COUNT(*) FROM rate_limits WHERE expires_at IS NOT NULL) AS n`).first();
    return typeof r?.n === "number";
  } catch {
    return false;
  }
}
