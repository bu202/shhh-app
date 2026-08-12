-- shhh! — D1 스키마 (P1-1)
--
-- 왜 옮기나: KV 에는 **트랜잭션이 없다.** 지금 친구 수락은 두 사람의 레코드에 두 번 쓰기라
-- 첫 쓰기만 성공하면 반쪽이 남는다. 권한이 새는 방향은 이미 막아 뒀지만(양쪽 확인, P0-1)
-- 그건 증상을 막은 것이고 원인은 **관계를 두 곳에 적는다는 것**이다.
-- 관계를 행 하나로 두면 반쪽 상태가 아예 생길 수 없다.
--
-- 왜 Durable Object 가 아닌가: 우리가 필요한 건 "여러 행을 원자적으로" 하나뿐이고 그건 SQL 의 일이다.
-- DO 는 코디네이션(실시간·순서 보장)이 필요할 때 값이 있는데 여기엔 그런 게 없다.
--
-- ⚠️ 이 파일은 **재실행 가능해야 한다**(IF NOT EXISTS). 마이그레이션이 중간에 죽어도
--    다시 돌려서 이어갈 수 있어야 하기 때문이다.

-- 사람. 제공자 회원번호는 **여기서만** 안다(KV 의 p:/i: 매핑이 하던 일).
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,           -- 내부 무작위 번호. 밖으로 나가는 유일한 식별자
  provider          TEXT NOT NULL,              -- kakao | naver | google
  provider_subject  TEXT NOT NULL,              -- 제공자 회원번호. 절대 응답에 싣지 않는다
  session_version   INTEGER NOT NULL DEFAULT 0, -- 올리면 이 계정의 **모든** 세션이 즉시 죽는다
  created_at        INTEGER NOT NULL
);
-- 같은 제공자 계정이 두 번 가입되면 단어장이 갈라진다.
CREATE UNIQUE INDEX IF NOT EXISTS users_provider ON users(provider, provider_subject);

-- 세션. **원본 토큰을 저장하지 않는다** — DB 가 새도 남의 세션을 쓸 수 없어야 한다.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash       TEXT PRIMARY KEY,            -- SHA-256(토큰). 원본은 브라우저에만
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_version  INTEGER NOT NULL,            -- 발급 당시 값. users 와 다르면 죽은 세션이다
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- 단어장. version 은 서버가 센다(P2-2 에서 KV 에 이미 넣은 것과 같은 규칙).
CREATE TABLE IF NOT EXISTS books (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  words       TEXT NOT NULL DEFAULT '[]',       -- JSON 배열. 단어를 행으로 쪼개지 않는다 —
                                                -- 통째로 읽고 통째로 쓰는 게 전부라 조인할 일이 없다
  nickname    TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- 친구. **관계 하나에 행 하나.** 이게 이 이전의 전부다.
CREATE TABLE IF NOT EXISTS friendships (
  requester_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 두 uid 를 **정렬해 이어 붙인 값**. 방향이 달라도 같은 쌍이면 같은 문자열이다.
  -- 앱이 계산해 넣는다(생성 컬럼이 아닌 이유: ALTER 로 추가하려면 상수 기본값이어야 한다).
  pair_key      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  PRIMARY KEY (requester_id, addressee_id)
);
-- 받은 요청 목록을 뽑는 쪽. 없으면 목록 조회가 전체 스캔이 된다.
CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships(addressee_id, status);
-- ⚠️ **관계는 두 사람당 하나다.** 전에는 이걸 애플리케이션이 SELECT 로 확인했는데,
--    A→B 와 B→A 가 **동시에** 오면 둘 다 "관계 없음"을 읽고 각자 INSERT 해서 행이 둘 생겼다
--    (PK 가 방향까지 포함해서 안 부딪힌다). 그러면 목록에 같은 사람이 두 번 나오고,
--    남은 「취소」를 누르면 DELETE 가 양방향이라 **이미 맺은 친구가 끊겼다.**
--    이제 그 경합은 UNIQUE 충돌이 되고, 충돌 자체가 "서로 보냈다"는 신호라
--    같은 문장의 ON CONFLICT 가 그 자리에서 accepted 로 만든다(worker/index.js 의 POST /friends).
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair ON friendships(pair_key);

-- 초대 코드.
-- ⚠️ 세션 토큰과 달리 **원문을 저장한다.** 처음엔 해시만 두려다 되돌렸다 — 사용자가 폰을 바꾸면
--    앱이 자기 초대 링크를 **다시 보여줘야 하는데**, 해시만 있으면 되살릴 수가 없다.
--    (되살리려면 코드를 uid 로부터 유도해야 하고, 그러면 STATE_KEY 를 바꾸는 순간 모두의 링크가
--     한꺼번에 죽는다 — 로그인 키와 초대 링크를 묶는 건 값보다 대가가 크다.)
--    감수하는 것: DB 가 새면 남의 초대 링크를 알 수 있다. 그 코드로 할 수 있는 일은
--    **친구 요청을 보내는 것**뿐이고 수락은 여전히 상대가 해야 한다 — 읽기 권한이 아니다.
CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER                           -- 회전하면 여기에 시각을 적는다(행은 남긴다)
);
-- 지금 살아 있는 코드를 사람마다 하나 찾는 쪽.
CREATE INDEX IF NOT EXISTS invite_user ON invite_codes(user_id, revoked_at);

-- ⚠️ entitlements 는 **만들지 않는다.** 지금 파는 물건이 없고(BETA_NO_WALL), 마스터는
--    MASTER_UIDS 시크릿이 정한다. 결제를 붙이는 날 그때의 요구에 맞춰 만든다 —
--    지금 만들면 쓰지도 않는 테이블을 마이그레이션이 계속 끌고 다닌다.
