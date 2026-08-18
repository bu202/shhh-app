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
import { DELETIONS_SWEEP_SQL } from "../ledger.js";

// 무료 플랜의 scheduled Worker CPU 한도는 10ms 다. 한 번에 다 지우려다 시간 초과로
// **매번 아무것도 못 지우는** 상태가 가장 나쁘다 — 대상별로 잘라 여러 번에 걸쳐 지운다.
// ponytail: 200행은 실측값이 아니라 보수적 시작값이다. 관측 후 조정할 것.
const LIMIT = 200;
// 정리가 낡았다고 볼 기준(= 주기의 2배). `/api/ready` 의 `cleanupStale` 과 같은 값을 쓴다.
const PERIOD = 3600e3;

// 대상 여섯 가지. **`deletions` 를 지우는 문장은 C2 하나뿐이고, 그 WHERE 에는 반드시
// `confirmed_at IS NOT NULL` 이 들어간다.** 없으면 「삭제는 됐는데 확정 기록만 실패한」 표식이
// 사라져 복원 때 그 사람이 되살아나고 아무도 모른다.
const JOBS = [
  // ⚠️ C1 — **만료 전에 지우면 그 순간 replay 창이 다시 열린다.**
  ["consumed_signup_states", "DB",
   `DELETE FROM consumed_signup_states WHERE state_hash IN
      (SELECT state_hash FROM consumed_signup_states WHERE expires_at < ? LIMIT ${LIMIT})`],
  // C3 — 로그인 자리의 청소를 **옮기는 게 아니라 더한다**(둘 다 있어도 무해하다).
  ["sessions", "DB",
   `DELETE FROM sessions WHERE token_hash IN
      (SELECT token_hash FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL LIMIT ${LIMIT})`],
  ["rate_limits", "DB",
   `DELETE FROM rate_limits WHERE bucket IN
      (SELECT bucket FROM rate_limits WHERE expires_at < ? LIMIT ${LIMIT})`],
  // C2 — 확정된 표식만. 조건이 SQL 문자열 한 곳(ledger.js)에서 온다.
  ["deletions", "LEDGER",
   `${DELETIONS_SWEEP_SQL} AND mark IN (SELECT mark FROM deletions
      WHERE confirmed_at IS NOT NULL AND expires_at < ? LIMIT ${LIMIT})`, 2],
  // ⚠️ C5 — **released 되지 않은 lease 는 지우지 않는다.** 그건 「진행 중이던 작업이 죽었다」는
  //    신호이고, 지우면 그 사실이 사라진다.
  //    2026-08-18(결정 A′)부터 해제는 행을 **지우므로** 이 대상은 보통 0건이다. 남겨 두는 이유는
  //    옛 세대가 `released_at` 을 채워 놓고 간 행을 치우기 위해서다 — 있으면 지우고, 없으면 0이다.
  ["write_leases", "LEDGER",
   `DELETE FROM write_leases WHERE lease_id IN
      (SELECT lease_id FROM write_leases WHERE released_at IS NOT NULL AND expires_at < ? LIMIT ${LIMIT})`],
];

export async function runCleanup(env, now = Date.now()) {
  // ⚠️ C14 — 유지보수·복원 중에는 **아무것도 지우지 않고 그 자리에서 끝낸다.**
  //    복원 중 정리가 겹치면 reconciliation 과 경합한다.
  const gate = await env.LEDGER.prepare("SELECT mode FROM maintenance WHERE id = 1").first();
  if (!gate || gate.mode !== "open") return { skipped: gate ? gate.mode : "unknown" };

  const counts = {};
  for (const [name, binding, sql, nArgs = 1] of JOBS) {
    const r = await env[binding].prepare(sql).bind(...Array(nArgs).fill(now)).run();
    counts[name] = (r.meta && r.meta.changes) || 0;
  }
  // ⛔ C6 — 확정되지 않은 pending 은 **지우지 않는다. 세어서 알린다.**
  //    시간이 지나도 아무것도 저절로 해결되지 않는다: 계정이 살아 있으면 지우는 근거가 되고,
  //    계정이 없으면 지우는 순간 복원 때 그 사람이 되살아난다. 판정은 사람이 한다.
  const open = await env.LEDGER.prepare(
    "SELECT COUNT(*) AS n FROM deletions WHERE confirmed_at IS NULL AND pending_alert_at < ?")
    .bind(now).first();
  return { counts, openPending: open.n };
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
  }
}

export { PERIOD };
