-- 0002 (ledger) — 삭제 키 검사값
--
-- worker/ledger-schema.sql 과 **같은 모양**이어야 한다.
--
-- ⚠️ 재실행 가능해야 한다(IF NOT EXISTS). 이전이 중간에 죽어도 이어 돌릴 수 있어야 한다.

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
