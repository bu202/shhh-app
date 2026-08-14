-- 0003 — ① pair_key 를 DB 가 강제하게 만든다 ② 실제로 막는 레이트리밋 자리를 만든다.
--
-- ① 왜 또 pair_key 인가
--   0002 는 유니크 인덱스까지 걸었지만 컬럼이 NULL 을 받는다(ALTER 로 컬럼을 더할 때
--   SQLite 는 상수 기본값만 받아서 NOT NULL 을 못 붙였다). 그런데 **SQLite 의 UNIQUE 인덱스는
--   NULL 을 서로 다른 값으로 본다** — pair_key 가 비어 들어가는 경로가 하나라도 생기면
--   중복 관계가 다시 만들어지고, 0002 가 없애려던 증상(「취소」가 이미 맺은 친구를 끊는 것)이
--   그대로 돌아온다. 지금은 앱이 항상 채우므로 문제가 없지만, 그건 **제약이 아니라 성실함**이다.
--   불변식은 문장이 아니라 DB 가 깨뜨려야 한다(0002 주석과 같은 이유, 한 단계 더).
--
-- ② 왜 rate_limits 인가
--   `limited()` 는 이음새만 있고 아무것도 막지 않았다(env.RL 이 없으면 늘 통과). Pages Functions
--   에서는 Rate Limiting 바인딩을 못 쓰고, KV 카운터는 무료 1,000 writes/일이라 리미터 자체가
--   서비스 거부 수단이 됐다. **D1 은 하루 10만 writes** 라 그 반대가 성립한다.
--   원문 IP·uid 를 행에 남기지 않는다 — 키는 SHA-256 해시다(개인정보를 세는 대가로 쌓지 않는다).

-- ── ① pair_key NOT NULL ──────────────────────────────────────────────────
-- SQLite 는 컬럼 제약을 나중에 붙일 수 없다. 테이블을 새로 만들어 옮기는 것이 유일한 길이다.
-- 순서: 채우기 → 새 테이블 → 복사 → 교체 → 인덱스. 0002 가 이미 돌았어도 안전하다.

-- 0002 와 **같은 식**으로 채운다. 여기서 안 채우고 복사하면 NULL 행이 통째로 사라진다.
UPDATE friendships
   SET pair_key = CASE WHEN requester_id < addressee_id
                       THEN requester_id || '|' || addressee_id
                       ELSE addressee_id || '|' || requester_id END
 WHERE pair_key IS NULL;

-- 0002 ③ 과 같은 중복 정리. 0002 뒤에 생긴 중복은 없어야 하지만, **없음을 가정하지 않는다** —
-- 가정이 틀리면 아래 UNIQUE 에서 이 이전 전체가 운영 DB 에서 실패한다.
DELETE FROM friendships
 WHERE rowid NOT IN (
   SELECT rowid FROM friendships f
    WHERE f.rowid = (SELECT g.rowid FROM friendships g
                      WHERE g.pair_key = f.pair_key
                      ORDER BY (g.status = 'accepted') DESC, g.created_at ASC, g.rowid ASC
                      LIMIT 1)
 );

-- 새 모양. **worker/schema.sql 의 friendships 와 글자까지 같아야 한다**
-- (scripts/test-migrations.mjs 가 두 경로의 결과를 대조해 갈라지면 실패시킨다).
CREATE TABLE friendships_new (
  requester_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_key      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  PRIMARY KEY (requester_id, addressee_id)
);

INSERT INTO friendships_new (requester_id, addressee_id, pair_key, status, created_at, accepted_at)
  SELECT requester_id, addressee_id, pair_key, status, created_at, accepted_at FROM friendships;

DROP TABLE friendships;
ALTER TABLE friendships_new RENAME TO friendships;

-- 인덱스는 테이블과 함께 사라졌으므로 다시 만든다. **빠뜨리면 목록 조회가 전체 스캔이 된다.**
CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships(addressee_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair ON friendships(pair_key);

-- ── ② 레이트리밋 카운터 ──────────────────────────────────────────────────
-- 고정 창(fixed window). 창 하나에 행 하나이고, 세는 것도 판정도 UPSERT 한 문장에서 끝난다 —
-- 읽고 나서 쓰면 동시 요청이 창 하나를 여러 번 통과한다(친구 상한이 겪은 것과 같은 종류).
CREATE TABLE IF NOT EXISTS rate_limits (
  -- SHA-256(용도|주체|창번호). **원문을 넣지 않는다** — IP 와 uid 는 개인정보이고,
  -- 남용을 세기 위해 그걸 쌓아 두는 건 목적에 비해 과한 수집이다.
  bucket      TEXT PRIMARY KEY,
  n           INTEGER NOT NULL,
  -- 이 행이 쓸모없어지는 시각. 로그인할 때 지난 행을 함께 지운다(청소를 위한 크론이 없다).
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);
