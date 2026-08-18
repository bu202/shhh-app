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
export async function readMode(env) {
  // 바인딩이 아예 없다 = ledger 를 아직 안 붙였다. 그때는 **열림으로 본다** —
  // 게이트가 뜻을 갖는 것은 복원 작업 중뿐이고, 복원은 지금 운영상 금지다.
  // 대신 `/api/ready` 가 `ledger:false` 로 시끄럽게 말한다(있는 척하지 않는다).
  if (!env.LEDGER) return { mode: "open", epoch: 0, bound: false };
  // ⚠️ 바인딩이 **있는데 질의가 실패**하면 열림으로 떨어지지 않는다. 그건 「모른다」이고,
  //    모를 때 게이트를 여는 것은 게이트가 없는 것과 같다.
  const r = await env.LEDGER.prepare("SELECT mode, epoch FROM maintenance WHERE id = 1").first();
  if (!r) throw new Error("maintenance row missing");
  return { mode: r.mode, epoch: r.epoch, bound: true };
}

// ── 요청 임차증(lease) ───────────────────────────────────────────────────
// **요청 하나에 임차증 하나다**(2026-08-18 결정 A′). SQL 문장마다가 아니다 —
// 문장 단위로 따면 한 요청이 여러 개를 들고, 그중 하나만 해제돼도 drain 이 거짓으로 0 이 된다.
//
// 언제 딴다: **주 D1 의 사용자 데이터에 처음 닿기 전.** 세션 인증(`sessions`·`users` 조회)도
// 그 안에 든다 — 인증이 먼저 지나가면 그 조회는 추적 밖에서 일어난다.
// 언제 푼다: 그 요청의 **모든 DB 작업이 끝난 뒤**, 가장 바깥 `finally` 에서.
//
// **한 문장으로 딴다.** 읽고 나서 쓰면 전환 직후의 요청이 창을 빠져나간다.
// 행이 안 생기면 = 지금은 새 요청을 받지 않는다.
//
// ⚠️ 조건이 `mode = 'open'` 이 아니라 **`mode <> 'restore_closed'`** 인 이유:
//    `maintenance` 는 읽기를 허용하는 상태다(§10-7). 거기서 임차증을 거부하면 허용된 읽기가
//    추적 밖에서 돌게 되어 **재려던 것을 못 잰다.** 쓰기는 라우트 허용 목록이 이미 막는다.
//    `restore_closed` 에서만 신규 획득을 **원자적으로** 거부한다 — 그래야 활성 수가 0 으로 내려간다.
export async function acquireLease(env, now = Date.now()) {
  const id = crypto.randomUUID();
  const r = await env.LEDGER.prepare(
    `INSERT INTO write_leases (lease_id, epoch, started_at, expires_at)
     SELECT ?1, m.epoch, ?2, ?3 FROM maintenance m WHERE m.mode <> 'restore_closed'`)
    .bind(id, now, now + LEASE_TTL).run();
  return r.meta && r.meta.changes ? id : null;
}

// fencing. 이 조각을 **모든 ledger 쓰기의 WHERE 에** 붙인다 — 유지보수로 전환된 뒤에도
// 살아 있던 요청이 계속 쓰는 것을 막는다. 옛 epoch 의 lease 도 여기서 걸린다.
const FENCE = `EXISTS (SELECT 1 FROM write_leases l JOIN maintenance m ON m.id = 1
                        WHERE l.lease_id = ?LEASE AND l.released_at IS NULL
                          AND l.expires_at > ?NOW AND l.epoch = m.epoch)`;
const fenced = (sql) => sql.replace(/\?LEASE/g, "?").replace(/\?NOW/g, "?");

export async function leaseAlive(env, lease, now = Date.now()) {
  const r = await env.LEDGER.prepare(`SELECT 1 AS ok WHERE ${fenced(FENCE)}`).bind(lease, now).first();
  return !!r;
}

// 해제는 **행을 지운다.** UPDATE 로 표시만 남기지 않는 이유가 셋이다.
//   ① 요청마다 행이 하나씩 쌓이는데, 정리 크론은 한 시간에 200행씩만 지운다 —
//      요청이 시간당 200건을 넘으면 **표가 영원히 자란다**(A′ 로 바뀌면서 생긴 실제 위험이다).
//   ② 남겨서 읽는 곳이 없다. `drainState`·`FENCE` 는 **미해제 행만** 본다.
//   ③ 끝난 요청의 기록을 안 남기는 쪽이 개인정보 면에서도 낫다(요청 시각의 나열이 된다).
// ⚠️ **미해제 행은 여전히 안 지운다** — 그게 「끝났는지 모른다」의 유일한 증거다(stale).
export async function releaseLease(env, lease) {
  await env.LEDGER.prepare("DELETE FROM write_leases WHERE lease_id = ? AND released_at IS NULL")
    .bind(lease).run();
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
       FROM write_leases WHERE released_at IS NULL`).bind(now).first();
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

// 확정되지 않은 채 경보 시각을 넘긴 표식. **세기만 한다. 지우지 않는다.**
export async function openPendingCount(env, now = Date.now()) {
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
            + (SELECT COUNT(*) FROM write_leases WHERE released_at IS NULL)
            + (SELECT COUNT(*) FROM cleanup_runs WHERE id = 1)
            + (SELECT COUNT(*) FROM maintenance WHERE mode IS NOT NULL) AS n`).first();
    return typeof r?.n === "number";
  } catch {
    return false;
  }
}
