-- 0005 — 백업 inventory (2026-08-26)
--
-- 배경: 확정된 삭제 표식을 **시간만 보고** 지우고 있었다(`expires_at < now`). 그런데 표식의
-- 쓸모는 「복원으로 되살아난 계정을 다시 지우는 것」이고, 되살릴 수 있는 원본은 두 가지다 —
-- D1 Time Travel 과 **백업 사본**. 백업이 아직 살아 있는데 표식을 지우면, 그 백업으로 복원한
-- 순간 그 사람이 되살아나고 **다시 지울 근거가 사라진다.**
--
-- 그래서 표식 삭제의 조건에 「그 계정을 담고 있을 수 있는 백업이 더 이상 없다」가 들어간다.
-- 그 판정을 하려면 백업의 **스냅샷 시각**과 **실제 객체가 아직 있는지**를 알아야 한다.
-- 이 표가 그 둘만 담는다.
--
-- ⛔ **백업 내용·사용자 uid·제공자 회원번호를 여기 담지 않는다.** 담는 것은 시각·해시·상태뿐이다.
-- ⛔ **오류 전문을 담지 않는다** — D1·R2 오류 문자열에는 표·컬럼·객체 이름이 섞여 나온다.
--    담는 것은 우리가 정한 짧은 코드 하나(`last_error_code`)뿐이다.
--
-- 상태 전이는 **한 방향**이다:
--   pending → uploaded → ready → deleted
--   pending → aborted            (업로드가 시작되지 않았음을 확인했다)
--   어느 상태에서든 → failed     (재시도는 새 backup_id 로 한다)
--
-- 표식 삭제를 **막는** 행: `deleted_at IS NULL AND status <> 'aborted'`.
--   · `pending`·`uploaded`·`failed` 는 **객체가 있는지 모른다** → 막는다(모름은 삭제 허가가 아니다)
--   · `ready` 는 객체가 확실히 있다 → 막는다
--   · `aborted` 는 **객체가 없음을 확인했다** → 막지 않는다
--   · `deleted` 는 `deleted_at` 이 채워져 있다 → 막지 않는다
--
-- ⚠️ 재실행 가능해야 한다(IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS backups (
  backup_id        TEXT PRIMARY KEY,     -- 우리가 만드는 불투명 id. 시각·계정을 담지 않는다
  -- **스냅샷 시각.** 이 시각 이전에 확정된 삭제는 이 백업에 담겨 있을 수 있다.
  -- 삭제 표식과 대조하는 값이 이것 하나이므로 반드시 NOT NULL 이다.
  snapshot_at      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  -- 두 DB 의 export 무결성. **내용이 아니라 해시**다. 한쪽이라도 NULL 이면 반쪽 백업이라
  -- `ready` 가 될 수 없다(아래 CHECK).
  main_db_hash     TEXT,
  ledger_db_hash   TEXT,
  object_key       TEXT,                 -- R2 객체 키. 버킷 이름은 설정에 있고 여기 안 적는다
  expires_expected_at INTEGER,           -- lifecycle 만료 **예정** 시각. 실제 삭제 시각이 아니다
  deletion_checked_at INTEGER,           -- 마지막으로 「아직 있나」를 물어본 시각
  deleted_at       INTEGER,              -- 객체가 **실제로 없음을 확인한** 시각
  status           TEXT NOT NULL
                   CHECK (status IN ('pending','uploaded','ready','deleted','aborted','failed')),
  last_error_code  TEXT,                 -- 우리가 정한 짧은 코드. 오류 전문이 아니다
  -- `ready` 는 두 DB 해시와 객체 키가 **전부** 있어야 한다. 한 DB 만 성공한 반쪽 백업이
  -- `ready` 로 기록되는 것이 이 표가 막으려는 첫 번째 사고다.
  CHECK (status <> 'ready' OR (main_db_hash IS NOT NULL AND ledger_db_hash IS NOT NULL
                               AND object_key IS NOT NULL)),
  -- `deleted` 는 확인 시각이 있어야 한다. 「아마 지워졌을 것」을 삭제로 적지 않는다.
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
-- 표식 삭제 판정이 매번 훑는 인덱스. 막는 행만 빠르게 찾는다.
CREATE INDEX IF NOT EXISTS backups_blocking ON backups(deleted_at, snapshot_at);
