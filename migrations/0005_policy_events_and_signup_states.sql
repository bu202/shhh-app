-- 0005 — 가입 기록(policy_events)과 가입 state 1회 소비 표식(consumed_signup_states)
--
-- 왜 지금인가: 4단계에서 **명시적 회원가입**이 생긴다. 계정이 만들어지는 자리가 하나가 되고,
-- 그 자리에서 「무엇을 보여주고 무엇을 확인받았는지」가 기록으로 남아야 한다.
--
-- ⚠️ SQLite 는 `CHECK` 를 `ALTER` 로 바꾸지 못한다. 아래 CHECK 를 고치려면 테이블을 새로 만들어
--    옮기는 migration 이 필요하다 — 그래서 (kind, action) 조합을 확정한 뒤에 만든다.
--    확정 근거: 처리 근거를 「개인정보 보호법」 제15조 제1항 제4호(계약의 이행)로 두기로 한
--    프로젝트 결정(2026-08-18). 그래서 `privacy` 는 `accepted` 가 아니라 **`presented`** 다 —
--    동의를 받지 않았는데 받았다고 기록하면 그 기록 자체가 거짓이 된다.
--    같은 이유로 `xborder/accepted` 도 만들지 않는다(제28조의8 제1항 제3호를 근거로 삼는다).

-- 가입할 때 무엇을 보여주고 무엇을 확인받았나. **행 하나 = 확인 하나.**
CREATE TABLE IF NOT EXISTS policy_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ⚠️ **CASCADE 다.** 계정을 지우면 이 기록도 함께 사라진다(프로젝트 결정 2026-08-18).
  --    탈퇴자에 대한 가명 보존 구조를 만들지 않는다 — 최소보유를 앞세운 선택이고,
  --    scripts/test-migrations.mjs 의 「users 참조는 전부 CASCADE」 전수 검사와도 맞는다.
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  action           TEXT NOT NULL,
  -- 그때 보여준 **불변 파일 내용의 SHA-256**. 클라이언트가 보낸 값을 그대로 쓰지 않는다 —
  -- 서버가 자기 상수(worker/policies.js)에서 꺼내 적는다.
  document_version TEXT NOT NULL,
  -- 두 시각을 나눈다. occurred_at 은 사용자가 [가입하기] 를 누른 순간 **서버가** 찍은 값이고,
  -- recorded_at 은 이 행이 실제로 들어간 순간이다. OAuth 왕복만큼(최대 10분) 벌어질 수 있다.
  -- 둘 다 서버 시각이다 — 클라이언트가 보낸 시각은 어느 쪽에도 쓰지 않는다.
  occurred_at      INTEGER NOT NULL,
  recorded_at      INTEGER NOT NULL,
  CHECK (
    (kind = 'terms'   AND action = 'accepted') OR
    (kind = 'privacy' AND action = 'presented') OR
    (kind = 'age14'   AND action = 'attested')
  )
);
-- 계정 하나의 기록을 뽑는 쪽. 다른 인덱스는 두지 않는다.
CREATE INDEX IF NOT EXISTS policy_events_user ON policy_events(user_id);
-- ⚠️ **UNIQUE 를 걸지 않는다.** 특히 (pv, occurred_at) 류의 전역 유니크를 걸면,
--    같은 밀리초에 가입한 **두 번째 사람이 막힌다**(설계서 T48). 사용자당 kind 하나만
--    허용하는 유니크도 안 된다 — 약관이 바뀌어 재확인을 받는 날 같은 kind 가 여러 행이 된다.

-- 가입 state 1회 소비 표식. **replay 를 막는 것이 전부다.**
--
-- 여기 들어가는 것은 `HMAC-SHA256(TOMBSTONE_KEY, state 전체)` 하나뿐이다.
--   · raw state 를 넣지 않는다 — state 안에 약관 수락·연령 진술·행위 시각이 들어 있다.
--   · provider·provider_subject·user_id·IP 를 넣지 않는다 — 이 표는 **누가 가입했는지 몰라도
--     되는 표**다. 알면 그만큼 개인정보다.
--   · 단순 SHA-256 을 쓰지 않는다. 해시 함수는 공개라, state 를 관찰할 수 있는 사람
--     (제공자 접근 로그·브라우저 기록·조직 프록시)이 그 값을 그대로 해시해 **DB 의 어느 행인지
--     정확히 지목**할 수 있다. 키를 모르면 그 계산 자체가 불가능하다.
--     (레이트리밋 키가 2026-08-16 에 겪은 것과 같은 교훈이고, 여기는 전수 대입조차 필요 없어 더 쉽다.)
--
-- ⚠️ **users 를 참조하지 않는다.** 참조하면 「계정을 만들기 전에 표식부터 넣는다」는 순서가
--    깨진다 — 표식 INSERT 는 계정 INSERT 와 같은 batch 의 **맨 앞**이어야 한다.
CREATE TABLE IF NOT EXISTS consumed_signup_states (
  state_hash  TEXT PRIMARY KEY,
  key_version INTEGER NOT NULL,   -- TOMBSTONE_KEY 회전용. 표식 수명이 10분이라 회전이 값싸다
  expires_at  INTEGER NOT NULL    -- state 자신의 만료 시각. **그전에 지우면 replay 창이 다시 열린다**
);
CREATE INDEX IF NOT EXISTS consumed_signup_states_exp ON consumed_signup_states(expires_at);
