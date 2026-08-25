-- 0006 — 주 D1 쓰기·읽기 fence (2026-08-25)
--
-- 배경: lease 는 진행 중인 작업을 **세는** 장치였을 뿐, 주 D1 의 쓰기를 막지 못했다.
-- 유지보수로 전환한 뒤에도 아직 살아 있는 요청이 주 D1 에 계속 쓸 수 있었고, stale lease 를
-- 해제해도 되는 근거가 「시간이 지났으니 그 요청은 죽었다」밖에 없었다. Workers 의 HTTP 요청은
-- 클라이언트 연결이 유지되는 동안 하드 wall-clock 제한이 없어 그 가정은 성립하지 않는다.
--
-- 이 표는 ledger 의 `maintenance.epoch` 을 주 D1 안으로 복제한다. 사용자 데이터를 만지는 모든
-- 문장이 이 값을 같은 문장 안의 술어로 들고 가므로, 옛 epoch 의 요청은 구조적으로 0행이 된다.
--
-- ⚠️ 재실행 가능해야 한다(IF NOT EXISTS · INSERT OR IGNORE).
-- ⚠️ 초기값 0 은 의도된 불일치다. 전환 프로토콜이 한 번 돌아 ledger epoch 과 맞추기 전까지
--    사용자 데이터 접근과 `/api/ready` 는 fail-closed 다.
CREATE TABLE IF NOT EXISTS write_fence (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL
);
INSERT OR IGNORE INTO write_fence (id, epoch) VALUES (1, 0);
