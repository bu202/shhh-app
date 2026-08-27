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
--
-- ⚠️ **2026-08-27 에 이 파일 하나로 합쳤다.** 잠깐 `0006`(`ALTER TABLE ... ADD COLUMN`)이
--    따로 있었지만, ledger D1 은 **아직 만들어지지도 않았다**(`d1 list` 에 `shhh-ledger` 가
--    없다). 적용된 적 없는 migration 을 `ALTER` 로 쌓으면 ⓐ 순서가 곧 조건이 되고
--    ⓑ `ALTER` 는 재실행이 안 되며 ⓒ 운영자가 지켜야 할 단계가 늘기만 한다.
--    **원격에 없다는 것이 확실할 때만** 이렇게 합친다 — 확실하지 않으면 후속 migration 을 쓴다.
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
  -- 올린 **암호문**의 크기와 SHA-256. 복호화 없이 「그때 올린 그 객체가 맞나」를 물을 수 있어야
  -- 한다 — 키가 같은 다른 내용이 있어도 R2 는 「있다」라고만 답한다.
  object_bytes     INTEGER,
  object_hash      TEXT,
  -- **이 백업이 어느 유지보수 세대의 것인가.** 복원 검증이 「지금 세대와 같은가」를 물으려면
  -- 그 값이 백업 쪽에도 있어야 한다. 세대가 다르면 그 사본은 지금 상태의 복원본이 아니다.
  maintenance_epoch INTEGER,
  -- 암호화 키의 **지문**(비밀값이 아니다 · `sha256("shhh-backup-key-v1"|key)` 앞 16자).
  -- 키를 갈아 끼운 뒤 옛 백업을 「복원 가능」이라 부르는 일을 막는다. ⛔ 키 자체는 담지 않는다.
  key_fingerprint  TEXT,
  -- 복원 **가능성 증명**의 영수증. `ready` 와 다른 사실이다 — `ready` 는 「올렸다」이고
  -- 이것은 「받아서 풀고 임시 DB 에 실어 봤다」이다. 게이트는 이 값을 **믿지 않고 다시 잰다**.
  verified_at      INTEGER,
  verify_version   TEXT,
  status           TEXT NOT NULL
                   CHECK (status IN ('pending','uploaded','ready','deleted','aborted','failed')),
  last_error_code  TEXT,                 -- 우리가 정한 짧은 코드. 오류 전문이 아니다
  -- `ready` 는 **대조에 필요한 값이 전부** 있어야 한다. 한 DB 만 성공한 반쪽 백업이나
  -- 「크기·해시를 모르는 채 올라간」 객체가 `ready` 로 기록되는 것이 이 표가 막으려는 사고다.
  CHECK (status <> 'ready' OR (main_db_hash IS NOT NULL AND ledger_db_hash IS NOT NULL
                               AND object_key IS NOT NULL AND object_bytes IS NOT NULL
                               AND object_hash IS NOT NULL AND maintenance_epoch IS NOT NULL
                               AND key_fingerprint IS NOT NULL)),
  -- 검증 영수증은 **반쪽으로 남지 않는다.** 시각만 있고 판이 없으면 무엇이 검증했는지 모른다.
  CHECK ((verified_at IS NULL) = (verify_version IS NULL)),
  -- `deleted` 는 확인 시각이 있어야 한다. 「아마 지워졌을 것」을 삭제로 적지 않는다.
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
-- 표식 삭제 판정이 매번 훑는 인덱스. 막는 행만 빠르게 찾는다.
CREATE INDEX IF NOT EXISTS backups_blocking ON backups(deleted_at, snapshot_at);
