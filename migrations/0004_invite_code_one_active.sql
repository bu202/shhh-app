-- 0004 — 사용자당 **살아 있는 초대 코드는 하나**임을 DB 가 강제한다.
--
-- 왜 필요한가
--   `GET /friends` 는 코드가 없으면 만든다. 그래서 두 탭이 동시에 친구 화면을 열면
--   둘 다 "없다"를 읽고 각자 만든다 — 나중 것이 앞 것을 폐기하므로 **먼저 응답을 받은 탭은
--   이미 죽은 코드를 손에 쥔다.** 그 링크를 보낸 상대는 「초대 링크가 만료됐거나 잘못됐어요」만 본다.
--   회전(`POST /friends/code`)을 두 기기에서 동시에 눌러도 같은 일이 난다.
--
--   지금 이 불변식을 지키는 것은 애플리케이션의 성실함뿐이다. 실측으로 확인했다 —
--   같은 user_id 로 활성 행 두 개를 직접 넣어도 **DB 는 아무 말도 하지 않는다.**
--   0002·0003 이 pair_key 에 대해 내린 판단과 같다: 불변식은 문장이 아니라 DB 가 깨뜨려야 한다.
--
-- 무엇이 바뀌나
--   인덱스가 걸린 뒤에는 두 번째 INSERT 가 UNIQUE 충돌로 막히고, worker 는 그 충돌을
--   "누가 이미 만들었다"로 읽어 **이긴 쪽의 코드를 그대로 돌려준다**(internalUid 와 같은 무늬).
--   그래서 두 탭이 반드시 같은 살아 있는 코드를 받는다.
--
-- ⚠️ 부분 인덱스(WHERE 절)인 이유: 폐기된 행은 사람마다 여러 개 남을 수 있고 남아야 한다.
--    제약은 **살아 있는 것 하나**에만 걸린다.

-- ── ① 이미 들어 있는 중복부터 정리한다 ───────────────────────────────────
-- 운영 데이터가 깨끗하다고 **가정하지 않는다** — 가정이 틀리면 실패하는 자리가 원격 DB 다
-- (0003 이 같은 이유로 같은 순서를 밟았다).
-- 가장 최근에 만든 것 하나만 남기고 나머지는 폐기로 적는다. 지우지 않는 이유는
-- "그런 코드가 있었다"는 사실까지 없앨 이유가 없어서다.
UPDATE invite_codes
   SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE revoked_at IS NULL
   AND rowid NOT IN (
     SELECT rowid FROM invite_codes f
      WHERE f.revoked_at IS NULL
        AND f.rowid = (SELECT g.rowid FROM invite_codes g
                        WHERE g.user_id = f.user_id AND g.revoked_at IS NULL
                        ORDER BY g.created_at DESC, g.rowid DESC
                        LIMIT 1)
   );

-- ── ② 제약 ───────────────────────────────────────────────────────────────
-- **worker/schema.sql 의 같은 줄과 글자까지 같아야 한다**
-- (scripts/test-migrations.mjs 가 두 경로의 결과를 대조해 갈라지면 실패시킨다).
CREATE UNIQUE INDEX IF NOT EXISTS invite_codes_active ON invite_codes(user_id) WHERE revoked_at IS NULL;
