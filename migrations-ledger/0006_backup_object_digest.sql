-- 백업 객체의 **크기와 암호문 해시** (2026-08-27 · K2)
--
-- 왜 필요한가: `reconcile` 이 R2 에 「그 객체가 아직 있나」를 물을 때, 있다는 답만으로는
-- **그때 올린 그 객체가 맞는지** 알 수 없다. 키가 같은 다른 내용이 있어도 「있다」이고,
-- 그 상태를 정상으로 읽으면 복구가 필요한 날 복구되지 않는 사본을 믿고 있게 된다.
--
-- 담는 것은 **암호문의 크기와 SHA-256** 뿐이다. 평문도, 키도, 계정 값도 여기 없다.
-- 복호화 없이 대조할 수 있어야 하므로 암호문 기준이다.
--
-- ⚠️ 재실행 가능하지 않다(`ALTER TABLE ... ADD COLUMN` 은 두 번 돌면 실패한다).
--    적용 전에 `PRAGMA table_info(backups);` 로 칸이 이미 있는지 확인한다.
-- ⚠️ 이 migration 은 **ledger D1** 의 것이다. 주 D1 에 돌리지 않는다.
ALTER TABLE backups ADD COLUMN object_bytes INTEGER;
ALTER TABLE backups ADD COLUMN object_hash  TEXT;
