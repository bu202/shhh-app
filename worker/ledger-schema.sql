-- shhh! — 삭제 표식 ledger 스키마 (주 D1 과 **다른 데이터베이스**)
--
-- 왜 따로 두나: 이 표들이 존재하는 이유가 **주 D1 을 과거로 되돌렸을 때 무엇을 다시 지워야 하는지
-- 아는 것**이다. 같은 DB 에 두면 되돌리는 순간 그 표까지 함께 과거로 가서, 무엇을 지워야 하는지
-- 아는 유일한 근거가 사라진다.
--
-- ⚠️ **이 DB 자체는 과거로 복원하지 않는다.** 복원이 필요하면 지금 것을 내보내고 과거 것을 별도
--    인스턴스로 읽어 **병합**한다(설계서 §10-6·§10-6-0). 제자리 restore 는 게이트·epoch·lease 를
--    함께 과거로 보낸다.
--
-- ⚠️ 재실행 가능해야 한다(IF NOT EXISTS). 이전이 중간에 죽어도 이어 돌릴 수 있어야 한다.

-- 지워진 계정의 표식. 저장하는 것은 **되돌릴 수 없게 변환한 값 하나**뿐이다.
-- 제공자 회원번호·별명·단어장·세션 어느 것도 여기 없다.
CREATE TABLE IF NOT EXISTS deletions (
  mark             TEXT PRIMARY KEY,   -- HMAC-SHA256(DELETION_KEY, 내부 uid)
  key_version      INTEGER NOT NULL,   -- 키 회전용. 보유기간 동안 옛 키를 지우지 않는다
  pending_at       INTEGER NOT NULL,   -- 삭제를 **시도한** 시각
  confirmed_at     INTEGER,            -- NULL 이면 삭제가 성공했는지 **모른다**
  -- 이 시각을 넘도록 확정되지 않으면 **경보 대상**이다.
  -- ⚠️ 지났다고 행을 지우지 않는다 — 지우면 「삭제는 됐는데 확정 기록만 실패한」 표식이 사라져
  --    복원 때 그 계정이 되살아나고 아무도 알아채지 못한다.
  pending_alert_at INTEGER NOT NULL,
  -- 표식이 쓸모를 잃는 시각. confirmed 가 되는 순간 **확정 시점 기준으로 다시 계산**한다.
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deletions_expires ON deletions(expires_at);
CREATE INDEX IF NOT EXISTS deletions_open    ON deletions(confirmed_at, pending_alert_at);

-- 유지보수 게이트. **행 하나.**
--
-- 왜 환경변수가 아닌가: 환경변수는 배포 세대마다 다르게 전파된다(프로덕션 별칭이 배포 직후
-- 약 1분간 옛 응답을 주는 것을 실측했다 — docs/HANDOFF.md §4-6). 게이트의 진실 원본은 이 행이고,
-- 모든 세대가 매 요청마다 이 행을 읽는다.
--
-- 상태가 **셋**인 이유: 불리언이면 「읽기는 열린 점검」과 「전면 차단」을 구분할 수 없다.
--   open           평상시
--   maintenance    DB 를 쓰는 라우트 전부 차단. 읽기는 허용
--   restore_closed 주 D1 복원 전후. **읽기도 세션 인증도 막는다** — 되살아난 탈퇴자의
--                  단어장이 그대로 읽히고 세션까지 부활하기 때문이다
CREATE TABLE IF NOT EXISTS maintenance (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT NOT NULL CHECK (mode IN ('open', 'maintenance', 'restore_closed')),
  -- 전환할 때마다 +1. 옛 epoch 의 lease 를 든 요청은 fencing 을 통과하지 못한다.
  epoch      INTEGER NOT NULL,
  closed_at  INTEGER,
  -- **drain 이 0 이 된 시각.** 이것이 곧 증거다. `/api/ready` 의 503 은 「막기 시작했다」일 뿐이다.
  drained_at INTEGER,
  -- 진행 중인 전환의 id. **NULL 이 아니면 새 lease 를 내주지 않는다**(전환 1단계).
  -- 두 DB 에 걸친 전환은 한 문장으로 못 하므로, 먼저 문을 닫고 나서 옮긴다.
  pending_transition TEXT
);
INSERT OR IGNORE INTO maintenance (id, mode, epoch) VALUES (1, 'open', 1);

-- 진행 중인 작업의 임차증.
--
-- **주 D1 의 사용자 데이터를 만지는 온라인 workload 는 전부 여기 잡힌다**(2026-08-18 결정 A′):
-- `worker/index.js` 의 HTTP 요청 하나에 하나, `worker/cleanup/` 의 정리 크론 실행 하나에 하나.
-- ⚠️ **「삭제 saga 만 딴다」는 옛 사실이다.** 그때는 활성 0건이 「삭제 saga 가 안 돈다」만
--    뜻했고, 그것을 「모든 쓰기가 멈췄다」로 읽은 것이 위협 32 였다. 지금 추적 범위는
--    설계서 §10-9-6 의 분류표가 말한다.
--
-- ⚠️ **`released_at` 컬럼이 없다.** 해제는 행을 **지운다**(ledger.js `releaseLease`) —
--    요청마다 표시만 남기면 정리 크론(시간당 200행)보다 빨리 쌓여 표가 무한히 자란다.
--    그래서 **여기 남아 있다 = 아직 안 끝났다**이고, 만료된 미해제는 `stale` 로 세어
--    복원을 계속 막는다. 자동으로 지우는 경로는 **없다**.
CREATE TABLE IF NOT EXISTS write_leases (
  lease_id    TEXT PRIMARY KEY,
  epoch       INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL   -- started_at + LEASE_TTL. Worker 최대 실행시간보다 길어야 한다
);
-- ⛔ 인덱스를 두지 않는다. 조회는 `COUNT(*)`·PK 조회 둘뿐이라 인덱스가 고를 것이 없고,
--    D1 은 **인덱스 갱신도 rows_written 으로 센다**(공식 요금 문서) — 요청마다 쓰기만 늘린다.

-- 정리 Worker 의 기록. **행 하나.**
-- 없으면 「안 돌았다」와 「돌았는데 지울 게 없었다」를 구분할 수 없다.
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_ok_at   INTEGER,
  last_try_at  INTEGER,
  fail_streak  INTEGER NOT NULL DEFAULT 0,
  -- 대상별 삭제 행 수(JSON). 갑자기 0이 되거나 폭증하는 것이 신호다.
  last_counts  TEXT NOT NULL DEFAULT '{}',
  -- 확정되지 않은 pending 표식 수. **지우지 않는다. 세어서 알린다.**
  open_pending INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);
INSERT OR IGNORE INTO cleanup_runs (id) VALUES (1);

-- 삭제 표식을 만든 **키의 검사값**. 행은 키 버전마다 하나.
--
-- 왜 필요한가(2026-08-19 재현 R4): 표식은 HMAC 이라 역산할 수 없어서 **표식만으로는 키를 검증할
-- 수 없다.** 그래서 `env.DELETION_KEY` 가 다른 배포에서는 살아 있는 계정의 표식이 하나도 안 맞고,
-- reconciliation 이 그것을 「계정이 없다 → 삭제는 됐고 기록만 실패했다」로 읽어 **confirmed 로
-- 승격**했다. 승격은 되돌릴 수 없다 — 그 뒤로 그 사람은 「지워진 사람」이다.
--
-- 저장하는 것은 **고정 문자열 하나의 HMAC** 이다. uid 도 표식도 담지 않는다.
CREATE TABLE IF NOT EXISTS deletion_keys (
  key_version INTEGER PRIMARY KEY,
  key_check   TEXT NOT NULL,   -- HMAC-SHA256(DELETION_KEY, "shhh!/deletion-key-check/v<버전>")
  created_at  INTEGER NOT NULL
);

-- 남용 방지 카운터. **2026-08-20 에 주 D1 에서 옮겨 왔다**(위협 49 · migration `0003`).
--
-- 왜 여기인가: 리미터는 임차증보다 **먼저** 돌아야 하는데(위협 47), 그러면 그 쓰기가 임차증
-- 밖이라 「주 D1 은 임차증 안에서만 만진다」에 예외가 생긴다. 카운터를 ledger 로 옮기면
-- 예외가 사라지고, UPSERT 를 게이트와 **한 문장**으로 묶을 수 있다 — `restore_closed` 로
-- 전환된 뒤에 깨어난 요청은 0행을 쓰고 429 로 끝난다.
--
-- ⚠️ 저장하는 것은 **되돌릴 수 없게 변환한 값**이다. 평문 SHA-256 이 아니라 `RL_KEY` HMAC 이라
--    키를 모르면 넣어 볼 값 자체를 만들 수 없다(2026-08-16 · 실측 43회 대입으로 IP 가 복원됐다).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,   -- HMAC(RL_KEY, 용도|주체|창번호)
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);


-- ── 두 DB 에 걸친 전환의 진행 기록 (2026-08-25 · 원칙 4) ──────────────────
-- ⛔ **주 D1 과 ledger D1 을 한 SQL 문장으로 원자적으로 바꿀 수는 없다.** 서로 다른 D1
--    바인딩이고 공통 트랜잭션이 없다. 그래서 「원자적 전환」이 아니라 **중간에 죽어도 이어서
--    끝낼 수 있는 프로토콜**이 필요하다. 이 표가 그 진행 상태를 영속화한다.
--
-- 순서(각 단계는 멱등이다):
--   started    새 lease 를 막았다(maintenance.pending_transition). 아직 아무것도 안 옮겼다
--   fence_set  주 D1 의 write_fence.epoch 을 target_epoch 으로 올렸다
--              ⚠️ 이 순간부터 **옛 epoch 의 요청은 주 D1 에 한 줄도 못 쓴다**(구조적 fencing)
--   committed  ledger 의 mode·epoch 을 확정하고 문을 다시 열었다
--
-- 중간에 Worker 가 죽으면 같은 명령을 다시 실행한다 — 어느 단계에서 멈췄든 그 다음부터 잇는다.
-- ⚠️ `fence_set` 과 `committed` 사이에서 죽으면 **주 D1 fence 와 ledger epoch 이 어긋난 채**
--    남는다. 그 상태에서는 모든 사용자 데이터 접근과 `/api/ready` 가 fail-closed 다.
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

-- ── stale lease 해제 기록 (2026-08-25 · 사용자 결정 1) ────────────────────
-- 최소 기록만 남긴다. **IP·사용자 UID·요청 경로·요청 내용·자유 입력 사유는 저장하지 않는다.**
-- 보유기간은 확정 삭제 표식과 같은 규칙(`CONFIRMED_RETENTION`)이고 정리 크론이 지운다.
-- 숫자를 여기 적지 않는다 — 원본은 `worker/ledger.js` 의 상수 하나다(요금제가 바뀌면 재계산한다).
-- 보유기간(`CONFIRMED_RETENTION`)이 지난 뒤에도 삭제가 실패하면 운영 경보 대상이다.
--
-- ⚠️ `reason_code` 는 **열거값**이다. 자유 입력이면 그 칸이 곧 개인정보 유입구가 된다.
-- ⚠️ `operator_ref` 는 **비식별 라벨**이다(예: `ops-2026-09-01`). 이메일·이름을 적지 않는다.
CREATE TABLE IF NOT EXISTS lease_resolutions (
  lease_id     TEXT PRIMARY KEY,
  epoch        INTEGER NOT NULL,   -- 그 lease 가 발급받았던 epoch
  started_at   INTEGER NOT NULL,   -- lease 행이 갖고 있던 값 그대로
  expires_at   INTEGER NOT NULL,
  resolved_at  INTEGER NOT NULL,
  reason_code  TEXT NOT NULL,
  operator_ref TEXT NOT NULL,
  expires_keep INTEGER NOT NULL    -- 이 기록 자체의 보유 만료(resolved_at + CONFIRMED_RETENTION)
);
CREATE INDEX IF NOT EXISTS lease_resolutions_keep ON lease_resolutions(expires_keep);

-- ── 백업 inventory (2026-08-26 · migration 0005) ────────────────────────
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
