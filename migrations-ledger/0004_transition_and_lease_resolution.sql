-- 0004 — 두 DB 전환 프로토콜과 stale lease 해제 기록 (2026-08-25)
--
-- 배경 ①: 주 D1 과 ledger D1 은 서로 다른 D1 바인딩이라 **한 SQL 문장으로 원자적으로 바꿀 수
-- 없다.** 유지보수 전환은 두 DB 를 모두 건드리므로, 중간에 죽어도 같은 명령을 다시 실행하면
-- 이어서 끝낼 수 있는 프로토콜이 필요하다. `transitions` 가 그 진행 상태를 영속화한다.
--
-- 배경 ②: stale lease 를 운영자가 해제할 때 「누가 무엇을 왜」를 확인할 수 있어야 한다.
-- 저장하는 것은 최소 항목뿐이고 보유기간은 37일이다(사용자 결정 1 · 2026-08-25).
--
-- ⚠️ 재실행 가능해야 한다. `ALTER TABLE ADD COLUMN` 은 IF NOT EXISTS 를 못 쓰므로 이 파일은
--    한 번만 적용한다 — 이미 적용됐는지는 `PRAGMA table_info(maintenance)` 로 확인한다
--    (docs/OPS_RUNBOOK.md).
ALTER TABLE maintenance ADD COLUMN pending_transition TEXT;

CREATE TABLE IF NOT EXISTS transitions (
  transition_id TEXT PRIMARY KEY,
  source_epoch  INTEGER NOT NULL,
  target_epoch  INTEGER NOT NULL,
  target_mode   TEXT NOT NULL CHECK (target_mode IN ('open', 'maintenance', 'restore_closed')),
  state         TEXT NOT NULL CHECK (state IN ('started', 'fence_set', 'committed')),
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_open ON transitions(state);

CREATE TABLE IF NOT EXISTS lease_resolutions (
  lease_id     TEXT PRIMARY KEY,
  epoch        INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  resolved_at  INTEGER NOT NULL,
  reason_code  TEXT NOT NULL,
  operator_ref TEXT NOT NULL,
  expires_keep INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lease_resolutions_keep ON lease_resolutions(expires_keep);
