-- 0001 — 지금 운영에 서 있는 스키마 그대로.
--
-- 왜 이 파일이 생겼나: 여태 스키마 변경 절차가 `worker/schema.sql` 을 원격에 **다시 실행**하는
-- 것이었다. 전부 `IF NOT EXISTS` 라 처음엔 안전해 보이지만, 컬럼을 하나 더하는 순간 그 방식으로는
-- 아무 일도 일어나지 않는다(테이블이 이미 있으니 건너뛴다). 그리고 무엇이 적용됐는지 아무도 모른다.
--
-- 이 파일은 **이미 적용된 상태를 기록**하는 자리다. 원격 DB 에는 이 내용이 이미 들어 있고,
-- 전부 `IF NOT EXISTS` 라 다시 돌려도 아무것도 바꾸지 않는다(그래서 안전하게 이력에 얹을 수 있다).
-- 새 DB(로컬·프리뷰)는 이 파일부터 순서대로 돌리면 운영과 같은 모양이 된다.
--
-- ⚠️ 앞으로 스키마를 바꿀 때는 **여기를 고치지 않는다.** 새 번호 파일을 만든다 —
--    이미 적용된 이력을 고치면 원격과 로컬이 조용히 갈라진다.

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_subject  TEXT NOT NULL,
  session_version   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_provider ON users(provider, provider_subject);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash       TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version  INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS books (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  words       TEXT NOT NULL DEFAULT '[]',
  nickname    TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
  requester_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships(addressee_id, status);

CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS invite_user ON invite_codes(user_id, revoked_at);
