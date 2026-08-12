-- 0002 — 친구 관계를 **두 사람당 하나**로 못 박는다.
--
-- 무엇이 문제였나: 기본키가 (requester_id, addressee_id) 라 **방향까지 포함**한다.
-- A→B 와 B→A 가 동시에 오면 둘 다 "관계 없음"을 읽고 각자 INSERT 해서 행이 둘 생겼다.
-- 그러면 ① 목록에 같은 사람이 「내 친구」와 「보낸 요청」 양쪽에 나오고 ② 남아 있는 「취소」를
-- 누르면 DELETE 가 양방향이라 **이미 맺은 친구가 끊긴다** ③ 친구 상한이 행 수를 세므로 빨리 찬다.
-- 개인정보처리방침의 「친구 관계는 기록 한 줄」도 이 제약이 있어야 참이 된다.
--
-- ⚠️ 순서가 중요하다. 유니크 인덱스를 먼저 만들면 이미 중복이 있는 DB 에서 **이 이전 전체가
--    실패**한다. 그래서 컬럼 → 채우기 → 중복 정리 → 인덱스 순으로 간다.
--    (이전 시점 실측으로 친구 관계는 0건이지만, 0건임을 가정하지 않고 쓴다 —
--     가정이 틀리면 실패하는 자리가 하필 운영 DB 다.)

-- ① 쌍 이름 컬럼. NOT NULL 을 못 붙이는 이유는 SQLite 가 ALTER 로 컬럼을 더할 때
--    상수 기본값만 받기 때문이다. 대신 앱이 항상 채우고 유니크 인덱스가 지킨다.
ALTER TABLE friendships ADD COLUMN pair_key TEXT;

-- ② 기존 행 채우기. 두 uid 를 정렬해 이어 붙인다 — 방향이 달라도 같은 쌍이면 같은 값이 된다.
UPDATE friendships
   SET pair_key = CASE WHEN requester_id < addressee_id
                       THEN requester_id || '|' || addressee_id
                       ELSE addressee_id || '|' || requester_id END
 WHERE pair_key IS NULL;

-- ③ 이미 생긴 중복이 있으면 **하나만 남긴다.**
--    남길 것: accepted 가 있으면 그것, 없으면 먼저 만들어진 것(created_at, 같으면 rowid).
--    지우는 쪽은 어차피 화면에서 유령으로 보이던 행이다.
DELETE FROM friendships
 WHERE rowid NOT IN (
   SELECT rowid FROM friendships f
    WHERE f.rowid = (SELECT g.rowid FROM friendships g
                      WHERE g.pair_key = f.pair_key
                      ORDER BY (g.status = 'accepted') DESC, g.created_at ASC, g.rowid ASC
                      LIMIT 1)
 );

-- ④ 이제 DB 규칙이 된다. 앞으로 반대 방향 요청은 오류가 아니라 **"서로 보냈다"는 신호**로
--    쓰인다 — worker/index.js 의 POST /friends 가 같은 문장의 ON CONFLICT 로 받아
--    그 자리에서 accepted 로 만든다.
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair ON friendships(pair_key);
