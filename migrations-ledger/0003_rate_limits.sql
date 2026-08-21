-- 0003 (ledger) — 남용 방지 카운터를 주 D1 에서 옮겨 온다
--
-- worker/ledger-schema.sql 과 **같은 모양**이어야 한다.
--
-- ⚠️ 재실행 가능해야 한다(IF NOT EXISTS). 이전이 중간에 죽어도 이어 돌릴 수 있어야 한다.
--
-- 왜 옮기나(2026-08-20 재현 T62 · 위협 49): 리미터는 **임차증보다 먼저** 돌아야 한다.
-- 뒤에 두면 429 를 받는 요청도 임차증을 하나 따고 놓아 ledger 쓰기 둘을 낸다(위협 47).
-- 그런데 임차증보다 먼저면 그 쓰기는 **어느 임차증에도 안 잡힌다** — 게이트를 통과한 뒤
-- UPSERT 직전에 멈춘 요청 하나를 두고 `restore_closed` 로 전환하면 `drainState()` 가
-- **`drained:true`** 라고 답하고, 그 답을 근거로 복원을 시작한 뒤에 그 요청이 깨어나 주 D1 에 쓴다.
--
-- 카운터가 ledger 에 있으면 두 가지가 동시에 참이 된다:
--   ① 주 D1 은 **예외 없이 임차증 안에서만** 만져진다
--   ② UPSERT 를 게이트와 **한 문장**으로 묶을 수 있다 — 전환 뒤에 깨어난 요청은 0행을 쓴다
--
-- ⚠️ **주 D1 의 `rate_limits` 표는 그대로 둔다.** 파괴적 원격 migration 은 별도 승인 대상이고,
--    안 쓰는 표는 해가 없다. 되돌릴 때도 코드만 되돌리면 된다.
CREATE TABLE IF NOT EXISTS rate_limits (
  -- HMAC(RL_KEY, 용도|주체|창번호). **IP 원문도 계정 번호도 여기 없다.**
  bucket     TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);
