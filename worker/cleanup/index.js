// 정리 전용 Worker. **Pages 프로젝트와 별개로 배포한다.**
//
// 왜 따로인가: Cron Trigger 는 Workers 의 `scheduled()` 핸들러에 붙는데, Pages Functions 에서
// 그것을 쓸 수 있다는 공식 근거를 찾지 못했다. 억지로 끼워 넣는 대신 전용 Worker 로 둔다.
//
// 왜 생겼나: 4판까지 정리는 **다른 일이 일어날 때 곁다리로** 붙어 있었다 — 세션과 리미터 행은
// 「다음 로그인」에, 확정 표식은 「다음 삭제」에, 소비 표식은 「다음 가입」에. 아무도 그 일을
// 하지 않으면 **영원히 남는다.** 방침에 「N일 뒤 지웁니다」라고 쓰면서 지우는 사람이 없으면
// 그 문장은 적는 순간 거짓이다.
//
// ⚠️ 여기에는 **계정 생성·세션 발급 코드가 없다.** 읽기와 조건부 삭제만 한다.
//
// ⚠️ **이 Worker 도 주 D1 을 만지는 「온라인 workload」다.** HTTP 요청과 같은 임차증을 든다 —
//    2026-08-18 재현에서 이것이 빠져 있어 크론이 지우는 도중에 `drainState()` 가
//    `drained:true` 라고 답했다(T47b). 「크론이니까 예외」가 정확히 그 구멍이었다.
import { withFence } from "../fence.js";
import { DELETIONS_SWEEP_SQL, acquireLease, releaseLease, LEASE_MODES_CLEANUP,
         pendingAlertCount, sweepCutoff, BACKUP_OBJECT_KEY, backupFroms } from "../ledger.js";

// 무료 플랜의 scheduled Worker CPU 한도는 10ms 다. 한 번에 다 지우려다 시간 초과로
// **매번 아무것도 못 지우는** 상태가 가장 나쁘다 — 대상별로 잘라 여러 번에 걸쳐 지운다.
// ponytail: 200행은 실측값이 아니라 보수적 시작값이다. 관측 후 조정할 것.
const LIMIT = 200;
// 정리가 낡았다고 볼 기준(= 주기의 2배). `/api/ready` 의 `cleanupStale` 과 같은 값을 쓴다.
const PERIOD = 3600e3;

// 대상 다섯 가지. **`deletions` 를 지우는 문장은 C2 하나뿐이고, 그 WHERE 에는 반드시
// `confirmed_at IS NOT NULL` 과 **백업 inventory 조건**이 들어간다.** 없으면 「삭제는 됐는데
// 확정 기록만 실패한」 표식이 사라지거나, 아직 살아 있는 백업으로 되살아난 사람을 다시 지울
// 근거가 사라진다 — 둘 다 아무도 알아채지 못한다.
const JOBS = [
  // ⚠️ C1 — **만료 전에 지우면 그 순간 replay 창이 다시 열린다.**
  ["consumed_signup_states", "DB",
   `DELETE FROM consumed_signup_states WHERE state_hash IN
      (SELECT state_hash FROM consumed_signup_states WHERE expires_at < ? LIMIT ${LIMIT})
      AND {FENCE}`],
  // C3 — 로그인 자리의 청소를 **옮기는 게 아니라 더한다**(둘 다 있어도 무해하다).
  ["sessions", "DB",
   `DELETE FROM sessions WHERE token_hash IN
      (SELECT token_hash FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL LIMIT ${LIMIT})
      AND {FENCE}`],
  // C4 — **2026-08-20 부터 ledger 다**(위협 49 · migration `0003`). 주 D1 의 같은 이름 표는
  //      남아 있지만 아무도 쓰지 않는다.
  ["rate_limits", "LEDGER",
   `DELETE FROM rate_limits WHERE bucket IN
      (SELECT bucket FROM rate_limits WHERE expires_at < ? LIMIT ${LIMIT})`],
  // C2 — 확정된 표식만. 조건이 SQL 문자열 한 곳(ledger.js)에서 온다.
  //
  // ⚠️ **인자가 둘이고 값이 다르다**(2026-08-26 · H4). `?1` 은 지금, `?2` 는 「지금 − 복원 창」이다.
  //    같은 값을 두 번 넣으면 복원 창 조건이 통째로 무력해진다 — 그래서 `now` 를 개수만큼
  //    복제하던 옛 방식(`Array(nArgs).fill(now)`)을 쓰지 않고 **값을 만들어 넘긴다.**
  // ⚠️ 이 문장은 `backups` 표를 읽는다. 표가 없거나 질의가 실패하면 **던진다** —
  //    「inventory 를 못 읽었다」는 「백업이 없다」가 아니다. 던지면 아래 `tick()` 이
  //    연속 실패로 세고 `/api/ready` 의 `cleanupAlert` 가 켜진다.
  ["deletions", "LEDGER",
   `${DELETIONS_SWEEP_SQL} AND mark IN (SELECT mark FROM deletions
      WHERE confirmed_at IS NOT NULL AND expires_at < ?1 LIMIT ${LIMIT})`,
   (env, now) => [now, sweepCutoff(env, now)]],
  // C5 — stale 해제 기록의 보유기간(2026-08-25 · 사용자 결정 1). 확정 삭제 표식과 **같은 규칙**
  //      (`CONFIRMED_RETENTION`)이고, `expires_keep` 은 기록할 때 이미 계산돼 있다.
  //      ⚠️ 지우지 못한 채 기한이 지난 것은 **경보 대상**이다(`/api/ready` 의 `cleanupAlert`).
  ["lease_resolutions", "LEDGER",
   `DELETE FROM lease_resolutions WHERE lease_id IN
      (SELECT lease_id FROM lease_resolutions WHERE expires_keep < ? LIMIT ${LIMIT})`],
  // ⛔ **`write_leases` 를 지우는 대상은 없다.** 해제는 행을 지우므로(결정 A′) 표에 남아 있는
  //    행은 전부 **진행 중이거나 stale** 이고, 둘 다 「아직 안 끝났다」는 증거다. 시간이 지났다는
  //    이유로 지우면 그 증거가 사라져 복원 금지가 저절로 풀린다.
];

// ── 백업 inventory 자동 reconciliation (2026-08-27 · 위협 85) ────────────
//
// 왜 크론인가: R2 lifecycle 은 우리에게 알려 주지 않고 객체를 지운다. 그런데 그 객체가
// 「아직 있다」는 이유로 삭제 표식이 막혀 있으므로, **아무도 물어보지 않으면 그 표식은
// 영원히 남는다** — 방침이 약속한 보유기간이 사실상 무한이 된다.
// ⛔ runbook 의 「주기적으로 reconcile 을 실행하세요」 한 줄은 그 상태를 막지 못한다.
//    사람이 잊으면 그대로이고, 잊었다는 사실조차 아무 데도 안 남는다.
//
// ⚠️ **R2 는 바인딩으로 만진다**(공식 Workers best practices: "Bindings are direct,
//    in-process references … Using the REST API from within a Worker wastes time").
// ⚠️ **`head()` 만 부른다.** 본문을 받으면 백업 하나가 Worker 메모리 한도(128MB)를 그대로
//    넘긴다. 우리가 묻는 것은 「있나 없나」 하나다.
// ⚠️ **부재를 확인했을 때만 닫는다.** 조회가 실패하면 아무것도 적지 않는다 —
//    확인 시각조차 적지 않는다(적으면 다음 사람이 「확인했다」로 읽는다).
export const RECON_LIMIT = 25;
// 만료 예정 시각이 지나고도 객체가 남아 있을 수 있는 여유(R2 lifecycle 은 표시 뒤 실제
// 삭제까지 통상 하루가 더 걸린다). 이 여유마저 지났는데 아직 있으면 **비정상**이다.
const RECON_OVERDUE_GRACE = 2 * 86400e3;
// `uploading` 이 이만큼 지나도록 안 끝났으면 **비정상**이다. ⛔ **닫는 근거가 아니다** —
// 시간이 지났다고 생산자가 죽었다고 단정하지 않는다. 사람이 보라고 경보로만 올린다.
// migration 직전 백업 하나는 길어야 수십 분이고, 이 값은 그 열 배가 넘는다.
const RECON_UPLOADING_STUCK = 6 * 3600e3;

// ── 회차마다 어디서부터 볼지 (2026-08-28 · 위협 89) ──────────────────────
// ⛔ **옛 방식은 `ORDER BY snapshot_at LIMIT 25` 뿐이었다.** 크론은 회차마다 새 실행이라
//    커서가 없으면 언제나 처음으로 돌아간다 — 실측: 60행 중 앞 25개가 계속 살아 있으면
//    26번째는 **3회차까지 한 번도 검사되지 않았다.** 그 행이 삭제 표식 정리를 막으므로
//    방침이 약속한 보유기간이 사실상 무한이 된다.
// ⚠️ 정렬 기준을 `backup_id`(PK · hex32 · 전순서)로 바꾼다 — `snapshot_at` 은 같은 값이
//    여럿일 수 있어 커서로 쓰면 건너뛴다. 나이 순서를 잃는 대신 **모든 행이 유한 회차 안에
//    검사되는 것**을 얻는다(한 바퀴 = ⌈N/25⌉ 회차).
// ⚠️ **커서는 SELECT 직후에 옮긴다.** 뒤에 두면 어떤 행에서 매번 던지는 배포가 그 페이지를
//    영영 다시 읽어, 고치려던 기아가 그대로 돌아온다. 못 본 행은 다음 바퀴에 다시 온다.
// ⛔ 무작위 정렬·메모리 커서를 쓰지 않는다 — 둘 다 「언젠가는 본다」만 말하고 유한 시간을
//    보장하지 못한다.
async function reconPage(env, limit) {
  const cur = await env.LEDGER.prepare(
    "SELECT recon_cursor FROM cleanup_runs WHERE id = 1").first();
  const from = (cur && cur.recon_cursor) || "";
  const rows = (await env.LEDGER.prepare(
    `SELECT backup_id, status, created_at, object_key, expires_expected_at, deletion_checked_at
       FROM backups WHERE deleted_at IS NULL AND status NOT IN ('aborted','deleted')
        AND backup_id > ?
      ORDER BY backup_id LIMIT ?`).bind(from, limit).all()).results || [];
  // 한 페이지를 다 못 채웠다 = 이 바퀴의 끝이다. 다음 회차는 처음부터 본다.
  const next = rows.length < limit ? "" : rows[rows.length - 1].backup_id;
  await env.LEDGER.prepare("UPDATE cleanup_runs SET recon_cursor = ? WHERE id = 1")
    .bind(next).run();
  // 커서가 끝에 있었고 그 뒤가 비었으면, 이 회차는 처음부터 다시 한 페이지를 본다 —
  // 안 그러면 「빈 회차」가 한 번 끼어 확인이 한 주기씩 늦어진다.
  if (!rows.length && from) return reconPage(env, limit);
  return rows;
}

export async function reconcileBackups(env, now) {
  const out = { scanned: 0, present: 0, gone: 0, unknown: 0, overdue: 0, failed: 0,
                uploading: 0, stuck: 0 };
  // 막는 행만 본다. 이미 닫힌 행(`aborted`·`deleted`)은 다시 묻지 않는다 — 멱등하다.
  const rows = await reconPage(env, RECON_LIMIT);
  if (!rows.length) return out;
  // ⛔ 막는 행이 있는데 바인딩이 없으면 **조용히 넘어가지 않는다.** 그 배포는 이 표를
  //    영원히 닫지 못한다 — 그 사실이 경보로 올라가야 한다.
  if (!env.BACKUPS) throw new Error("backup reconcile: R2 binding missing");

  for (const r of rows) {
    out.scanned++;
    // 키가 기록되지 않았어도(= pending 에서 죽었어도) **결정적으로 재구성**한다.
    const key = r.object_key || BACKUP_OBJECT_KEY(r.backup_id);
    let head;
    try { head = await env.BACKUPS.head(key); }
    catch { out.unknown++; continue; }          // 「모른다」 — 아무것도 안 적는다
    if (head === null || head === undefined) {
      // ⛔ **`uploading` 은 순간 부재만으로 닫지 않는다**(2026-08-28 · 위협 88). 그 순간
      //    `r2 object put` 이 도는 중일 수 있다 — 닫으면 그 뒤에 객체가 생겨 「없음을
      //    확인했다」가 거짓이 된다. 계속 막고, 오래 방치된 것만 **경보로** 올린다.
      //    ⛔ 시간은 **닫는 근거가 아니라 알리는 근거**다.
      if (r.status === "uploading") {
        out.uploading++;
        if (now - Number(r.created_at || 0) > RECON_UPLOADING_STUCK) out.stuck++;
        continue;
      }
      // `pending` 은 업로드 권리를 아무도 못 땄다는 뜻이므로 `aborted`,
      // 그 밖(uploaded·ready·failed)은 있었던 것이 사라졌으므로 `deleted` 다.
      const to = r.status === "pending" ? "aborted" : "deleted";
      // ⚠️ **자리표시자를 익명 `?` 로만 쓴다.** 번호형(`?3`)과 섞으면 `deleted` 갈래에만 있는
      //    칸 때문에 `aborted` 갈래에서 **바인드 개수가 안 맞는다** — 로컬 SQLite 는 넘어가도
      //    D1 은 거절할 수 있고, 그러면 배포한 뒤 첫 회차에서 처음 드러난다.
      const sets = ["status = ?", "deletion_checked_at = ?"];
      const args = [to, now];
      if (to === "deleted") { sets.push("deleted_at = ?"); args.push(now); }
      // ⚠️ **읽은 그 상태에서만 옮긴다**(CAS). `backupFroms(to)` 만으로는 부족하다 — 조회와
      //    이 문장 사이에 생산자가 `pending → uploading → failed` 로 옮기면 `failed` 도
      //    `aborted` 의 출발 상태였던 시절엔 그대로 통과했다. 관측한 값을 그대로 조건에 건다.
      const upd = await env.LEDGER.prepare(
        `UPDATE backups SET ${sets.join(", ")} WHERE backup_id = ? AND status = ?`
        + ` AND ${backupFroms(to)}`)
        .bind(...args, r.backup_id, r.status).run();
      // 전이표가 막았거나 그 사이에 누가 옮겼다 — 「했다」로 넘기지 않는다.
      if (!(upd.meta && upd.meta.changes === 1)) { out.failed++; continue; }
      out.gone++;
      continue;
    }
    out.present++;
    const upd = await env.LEDGER.prepare(
      "UPDATE backups SET deletion_checked_at = ? WHERE backup_id = ?").bind(now, r.backup_id).run();
    if (!(upd.meta && upd.meta.changes === 1)) { out.failed++; continue; }
    // 만료 예정 + 여유가 지났는데 아직 있다 → lifecycle 이 안 걸렸을 수 있다.
    // ⛔ **여기서 지우지 않는다.** 만료 예정 시각은 삭제의 근거가 아니다 — 알리기만 한다.
    if (r.expires_expected_at && now > Number(r.expires_expected_at) + RECON_OVERDUE_GRACE)
      out.overdue++;
  }
  return out;
}

export async function runCleanup(env, now = Date.now()) {
  // ⚠️ C14 — 게이트 확인과 임차증 획득이 **한 문장**이다(`LEASE_MODES_CLEANUP` = `open` 만).
  //    읽고 나서 지우면 그 사이의 전환이 창을 빠져나간다 — 그것이 2026-08-18 의 재현이다.
  //    행이 안 생기면 지금은 정리할 때가 아니다: 유지보수·복원 중에는 **주 D1 을 한 줄도
  //    읽지 않고** 끝낸다(복원 중 정리는 reconciliation 과 경합한다).
  //
  // ⚠️ 게이트 질의가 **실패하면 던진다.** 「모른다」를 「열림」으로 읽지 않는다 —
  //    못 지운 것은 다음 회차에 지우면 되지만, 잘못 지운 것은 되돌릴 수 없다.
  const lease = await acquireLease(env, LEASE_MODES_CLEANUP, now);
  if (!lease) {
    const gate = await env.LEDGER.prepare("SELECT mode FROM maintenance WHERE id = 1").first();
    return { skipped: gate ? gate.mode : "unknown" };
  }

  // 임차증은 **주 D1 작업이 전부 끝날 때까지** 유지된다. 문장마다 따고 푸는 것이 아니다 —
  // 그러면 문장 사이의 틈에서 drain 이 0 이 되어 복원이 시작될 수 있다.
  try {
    // ⚠️ **주 D1 은 fence 를 지난다**(2026-08-25 · 원칙 1·9). 크론도 온라인 workload 이고
    //    (§10-9-6 A-2), 전환 뒤에도 살아 있으면 요청과 똑같이 위험하다. 「크론은 우리 코드니까
    //    괜찮다」는 근거가 아니다 — 2026-08-18 에 크론이 임차증 밖에 있어서 지우는 도중에
    //    `drainState()` 가 `drained:true` 를 답한 적이 있다(T47b).
    //    ⛔ `env[binding]` 은 **정규식 검사가 통째로 놓치는 모양**이라, `test-fence` 가 JOBS 의
    //       값까지 따라가 주 D1 대상에 `{FENCE}` 가 있는지 전수로 본다.
    const fenced = withFence(env, lease);
    const bind = (b) => (b === "DB" ? fenced.DB : env[b]);
    const counts = {};
    // 인자는 **대상마다 다르다.** 옛 방식은 「`now` 를 nArgs 개 복제」였는데, 값이 서로 달라야
    // 하는 대상(C2 의 복원 창)이 생기면서 그 방식 자체가 조용한 우회로가 됐다.
    for (const [name, binding, sql, args = () => [now]] of JOBS) {
      // 지울 것이 없으면 0행이다 — 그것은 **정상**이고 fence 불일치가 아니다.
      // 둘을 가르는 것은 fence 통로가 한다(0행일 때만 fence 를 다시 읽는다).
      const r = await bind(binding).prepare(sql).bind(...args(env, now)).run();
      counts[name] = (r.meta && r.meta.changes) || 0;
    }
    // ⛔ C6 — 확정되지 않은 pending 은 **지우지 않는다. 세어서 알린다.**
    //    시간이 지나도 아무것도 저절로 해결되지 않는다: 계정이 살아 있으면 지우는 근거가 되고,
    //    계정이 없으면 지우는 순간 복원 때 그 사람이 되살아난다. 판정은 사람이 한다.
    //    ⚠️ **경보 대상 개수다**(`pending_alert_at` 이 지난 것). 복원·재개방의 안전 조건이 쓰는
    //       「전체 미확정 개수」와 다른 질문이라 함수를 갈라 뒀다(ledger.js · 재현 R3).
    //       여기서 전체를 세면 방금 실패한 삭제마다 경보가 울려 아무도 경보를 안 보게 된다.
    // ⚠️ **정리(삭제)가 다 끝난 뒤에 본다.** 앞에 두면 reconcile 하나가 실패할 때
    //    지울 수 있었던 것까지 못 지운다.
    const backups = await reconcileBackups(env, now);
    const result = { counts, backups, openPending: await pendingAlertCount(env, now) };
    // ⛔ **일부 실패를 성공으로 적지 않는다.** 모르는 행·만료 초과·못 바꾼 행이 하나라도
    //    있으면 이 회차는 실패다 — `tick()` 이 연속 실패로 세고 `/api/ready` 의
    //    `cleanupAlert` 가 켜진다. 그것이 「아무도 안 보는 상태」를 막는 유일한 통로다.
    // ⚠️ `uploading` 자체는 실패가 아니다(정상적인 백업이 도는 중일 수 있다). **오래 방치된**
    //    것만 실패로 센다 — 아니면 백업을 돌릴 때마다 크론이 경보를 내고, 그러면 아무도
    //    경보를 안 보게 된다.
    if (backups.unknown || backups.overdue || backups.failed || backups.stuck)
      throw new Error("backup reconcile incomplete");
    return result;
  } finally {
    // ⚠️ **여기가 유일한 해제 자리다**(worker/index.js 와 같은 무늬). 해제에 실패해도 삼킨다 —
    //    남은 행은 만료 뒤 `stale` 로 세어져 **복원을 계속 막는다.** 그게 맞는 실패 방향이다.
    try { await releaseLease(env, lease); } catch { /* stale 로 남아 복원을 막는다 */ }
  }
}

export default {
  // ⚠️ 모든 Promise 를 await 하거나 `ctx.waitUntil` 로 추적한다. 떠 있는 Promise 는
  //    Worker 가 잠들면서 중간에 끊긴다 — 그러면 「돌았다」고 기록해 놓고 안 지운 상태가 된다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // ⛔ **`fetch` 핸들러가 없다. 일부러 없다.**
  //    있었을 때 무슨 일이 났나(2026-08-18 재현): `/status` 가 인증 없이 `cleanup_runs` 를 통째로
  //    돌려줬다 — 최근 실패 사유·대상별 삭제 건수·미확정 pending 수·마지막 실행 시각이 전부
  //    운영 정보다. 게다가 `wrangler.jsonc` 에 route 도 `workers_dev:false` 도 없었고,
  //    `workers_dev` 는 **기본값이 `true`** 라(공식 문서 「The `workers_dev` Setting … Defaults to
  //    `true`」) 배포하는 순간 `shhh-cleanup.<계정>.workers.dev` 로 인터넷에 열렸을 것이다.
  //
  //    비교한 대안: ① Access 를 붙인다 ② `workers_dev:false` 만 건다 ③ 핸들러를 없앤다.
  //    ①은 이 앱 규모에 비해 붙일 것이 많고(정책·서비스 토큰) 그 설정은 코드 밖에 산다 —
  //    저장소를 봐서는 열렸는지 알 수 없다. ②만 하면 나중에 route 를 하나 붙이는 순간 다시 열린다.
  //    **③이 가장 짧고, 없는 것은 열릴 수 없다.** ②는 그 위에 한 겹 더 얹었다(설정에도 적어 둔다).
  //
  //    그럼 운영자는 뭘 보나: ⓐ `/api/ready` 의 `cleanupStale` ⓑ observability 로그
  //    ⓒ `wrangler d1 execute shhh-ledger --command "SELECT * FROM cleanup_runs"`.
  //    셋 다 이미 있고, 셋 다 인터넷에 열려 있지 않다.
};

async function tick(env) {
  const now = Date.now();
  try {
    const out = await runCleanup(env, now);
    if (out.skipped) {
      // 건너뛴 것은 실패가 아니다. 시도 시각만 적고 연속 실패 카운터를 건드리지 않는다.
      await env.LEDGER.prepare("UPDATE cleanup_runs SET last_try_at = ? WHERE id = 1").bind(now).run();
      return;
    }
    await env.LEDGER.prepare(
      `UPDATE cleanup_runs SET last_ok_at = ?, last_try_at = ?, fail_streak = 0,
              last_counts = ?, open_pending = ?, last_error = NULL WHERE id = 1`)
      .bind(now, now, JSON.stringify(out.counts), out.openPending).run();
  } catch (e) {
    // ⛔ C13 — 정리 실패에 **보상성 대량 삭제를 하지 않는다.** 「오래 못 치웠으니 한꺼번에」류의
    //    동작을 넣으면 정리 로직의 버그가 곧 데이터 손실이 된다.
    //    못 지우는 것은 되돌릴 수 있고, 잘못 지우는 것은 되돌릴 수 없다.
    // 오류 문자열은 자르고 개인정보를 담지 않는다(D1 오류에는 테이블·컬럼 이름이 섞여 나온다).
    const why = String(e && e.message).slice(0, 120);
    console.log("[cleanup] fail", why);
    try {
      await env.LEDGER.prepare(
        `UPDATE cleanup_runs SET last_try_at = ?, fail_streak = fail_streak + 1, last_error = ?
          WHERE id = 1`).bind(now, why).run();
    } catch { /* 기록조차 못 하면 다음 회차의 last_ok_at 간격이 대신 말한다 */ }
    // ⚠️ **기록했다는 이유로 성공으로 끝내지 않는다.** `ctx.waitUntil()` 에 넘긴 Promise 가
    //    거부돼야 Cloudflare 가 이 실행을 Cron Trigger 의 실패로 적는다(공식 문서 scheduled 핸들러).
    //    삼키면 세 번 연속 실패해도 대시보드에는 「성공」 세 줄이 남는다 — 조용히 멈춘 크론이
    //    없는 크론보다 나쁜 바로 그 상태다. 기록 자체가 실패해도 마찬가지로 던진다.
    // ⚠️ 원인은 **밖으로 내보내지 않는다** — D1 오류에는 표·컬럼 이름이 섞여 나온다.
    //    이유는 `cleanup_runs.last_error` 와 observability 로그에만 남는다.
    throw new Error("cleanup failed");
  }
}

export { PERIOD };
