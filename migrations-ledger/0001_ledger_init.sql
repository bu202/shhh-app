-- 0001 (ledger) — 삭제 표식 저장소 초기 스키마
--
-- worker/ledger-schema.sql 과 **같은 모양**이어야 한다. scripts/test-migrations.mjs 가 대조한다.
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
  drained_at INTEGER
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
