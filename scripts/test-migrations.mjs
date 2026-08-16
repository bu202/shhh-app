// 마이그레이션 검증. `node scripts/test-migrations.mjs`
//
// 재는 것은 하나다: **`migrations/` 를 순서대로 돌린 DB 와 `worker/schema.sql` 로 만든 DB 가
// 같은 모양인가.** 두 곳에 스키마가 있으면 언젠가 갈라지는데, 갈라진 걸 알아채는 자리가
// 하필 원격 DB 라서 그때는 이미 늦다. 여기서 갈라지면 테스트가 실패한다.
//
// 이력을 흉내내지 않고 **진짜 sqlite** 에 진짜 SQL 을 돌린다(_d1.mjs 와 같은 이유) —
// ALTER 로 더한 컬럼이 실제로 어디에 붙는지, 유니크 인덱스가 실제로 무엇을 막는지는
// 흉내로는 안 나온다.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = path.join(ROOT, "migrations");

export const migrationFiles = () =>
  readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();

// 스키마의 "모양". 테이블별 컬럼과 인덱스만 본다 — CREATE 문 원문을 비교하면
// ALTER 로 더한 컬럼과 처음부터 적힌 컬럼이 글자로는 달라서, 같은 스키마인데 실패한다.
function shape(db) {
  const out = {};
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all()
      .map((c) => `${c.name}:${c.type}${c.notnull ? " NOT NULL" : ""}${c.pk ? " PK" + c.pk : ""}`).sort();
    const idx = db.prepare(`PRAGMA index_list(${name})`).all()
      .filter((i) => i.origin !== "pk")   // 기본키 자동 인덱스는 위 컬럼 정보에 이미 나온다
      .map((i) => {
        const on = db.prepare(`PRAGMA index_info(${i.name})`).all().map((c) => c.name).join(",");
        return `${i.name}(${on})${i.unique ? " UNIQUE" : ""}`;
      }).sort();
    out[name] = { cols, idx };
  }
  return out;
}

function fresh(sqlTexts) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of sqlTexts) db.exec(sql);
  return db;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const files = migrationFiles();
  assert.ok(files.length >= 2, "migrations/ 에 파일이 없다");

  // 1. 번호가 겹치지 않고 이어진다. 겹치면 어느 것이 먼저인지 사람마다 다르게 읽는다.
  const nums = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(nums).size, nums.length, "마이그레이션 번호가 겹친다: " + files.join(", "));

  // 2. 순서대로 돌린 결과 == schema.sql 의 결과.
  const migrated = fresh(files.map((f) => readFileSync(path.join(MIG_DIR, f), "utf8")));
  const declared = fresh([readFileSync(path.join(ROOT, "worker/schema.sql"), "utf8")]);
  assert.deepEqual(shape(migrated), shape(declared),
    "migrations/ 를 다 돌린 모양과 worker/schema.sql 이 다르다 — 둘 중 하나가 뒤처졌다");

  // 3. 다시 돌려도 안전한가. 이전이 중간에 죽었을 때 이어서 돌릴 수 있어야 한다.
  //    (0002 의 ALTER 는 두 번 돌면 실패하는 것이 정상이다 — D1 이 적용 이력을 들고 있어
  //     같은 파일을 두 번 돌리지 않기 때문이다. 여기서는 **0001 만** 재실행을 보장한다.)
  const again = fresh([readFileSync(path.join(MIG_DIR, files[0]), "utf8"),
                       readFileSync(path.join(MIG_DIR, files[0]), "utf8")]);
  assert.ok(shape(again).users, "0001 을 두 번 돌리면 깨진다");

  // 4. **이전의 목적이 실제로 이뤄졌는지.** 유니크 인덱스가 없으면 위 비교가 통과해도 소용없다.
  assert.throws(() => {
    migrated.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('a','k','1',0,0)");
    migrated.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('b','k','2',0,0)");
    migrated.exec("INSERT INTO friendships (requester_id,addressee_id,pair_key,status,created_at) VALUES ('a','b','a|b','pending',0)");
    migrated.exec("INSERT INTO friendships (requester_id,addressee_id,pair_key,status,created_at) VALUES ('b','a','a|b','pending',0)");
  }, /UNIQUE/, "반대 방향 관계가 두 줄 들어갔다 — 유니크 인덱스가 안 걸렸다");

  // 5. 옛 스키마(0001)에 **중복이 이미 있는 DB** 에서도 0002 가 통과하는가.
  //    운영 데이터가 깨끗하다고 가정하지 않는다 — 가정이 틀리면 실패하는 자리가 원격 DB 다.
  const dirty = fresh([readFileSync(path.join(MIG_DIR, files[0]), "utf8")]);
  dirty.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('a','k','1',0,0)");
  dirty.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('b','k','2',0,0)");
  dirty.exec("INSERT INTO friendships (requester_id,addressee_id,status,created_at) VALUES ('a','b','pending',1)");
  dirty.exec("INSERT INTO friendships (requester_id,addressee_id,status,created_at,accepted_at) VALUES ('b','a','accepted',2,2)");
  dirty.exec(readFileSync(path.join(MIG_DIR, files[1]), "utf8"));
  const left = dirty.prepare("SELECT requester_id, status, pair_key FROM friendships").all();
  assert.equal(left.length, 1, "중복이 정리되지 않았다");
  assert.equal(left[0].status, "accepted", "맺어진 관계 대신 대기 중인 쪽이 남았다");
  assert.equal(left[0].pair_key, "a|b", "쌍 이름이 안 채워졌다");

  // 6. **users 를 참조하는 모든 테이블이 ON DELETE CASCADE 여야 한다.**
  //    계정 삭제는 `DELETE FROM users` 한 문장이다(worker/index.js) — 한 문장이라 원자적이라는
  //    것이 그 선택의 이유인데, 그게 성립하려면 **지울 것을 CASCADE 가 빠짐없이 안다**는 전제가 있다.
  //    새 테이블을 CASCADE 없이 붙이면 탈퇴한 사람의 데이터가 조용히 남고, 아무도 안 알아챈다.
  //    사람이 기억해야 도는 규칙 대신 여기서 깨뜨린다.
  for (const { name } of migrated.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const fk of migrated.prepare(`PRAGMA foreign_key_list(${name})`).all()) {
      if (fk.table !== "users") continue;
      assert.equal(fk.on_delete, "CASCADE",
        `${name}.${fk.from} 이 users 를 참조하는데 ON DELETE ${fk.on_delete} 다 — 탈퇴해도 이 행이 남는다`);
    }
  }
  // 7. 그리고 **정말로 지워지는지** 한 번 돌려 본다. 선언과 동작은 다른 말이다
  //    (PRAGMA foreign_keys 가 꺼져 있으면 CASCADE 는 조용히 안 돈다 — 로컬 D1 은 1 로 확인했다).
  migrated.exec("INSERT INTO books (user_id,words,nickname,version,updated_at) VALUES ('a','[]','',0,0)");
  migrated.exec("INSERT INTO invite_codes (code,user_id,created_at) VALUES ('c1','a',0)");
  migrated.exec("INSERT INTO sessions (token_hash,user_id,session_version,expires_at) VALUES ('h','a',0,9e15)");
  migrated.exec("DELETE FROM users WHERE id = 'a'");
  for (const t of ["books", "invite_codes", "sessions", "friendships"]) {
    assert.equal(migrated.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0,
      `users 를 지웠는데 ${t} 에 행이 남았다 — 한 문장 삭제가 성립하지 않는다`);
  }

  // 8. **살아 있는 초대 코드는 사람당 하나**(0004). 두 탭이 동시에 친구 화면을 열면
  //    둘 다 "코드 없음"을 읽고 각자 만들었고, 먼저 응답을 받은 탭은 죽은 코드를 손에 쥐었다.
  migrated.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('z','k','9',0,0)");
  migrated.exec("INSERT INTO invite_codes (code,user_id,created_at) VALUES ('live1','z',1)");
  assert.throws(() => migrated.exec("INSERT INTO invite_codes (code,user_id,created_at) VALUES ('live2','z',2)"),
    /UNIQUE/, "활성 초대 코드가 사람당 둘이 될 수 있다");
  // 폐기된 것은 여럿이어도 된다 — 아니면 회전 자체가 막힌다.
  migrated.exec("INSERT INTO invite_codes (code,user_id,created_at,revoked_at) VALUES ('dead1','z',3,3)");
  migrated.exec("INSERT INTO invite_codes (code,user_id,created_at,revoked_at) VALUES ('dead2','z',4,4)");

  // 9. **중복 활성 코드가 이미 있는 DB** 에서도 0004 가 통과하는가. 원격이 깨끗하다고
  //    가정하지 않는다 — 가정이 틀리면 실패하는 자리가 운영 DB 다(5번과 같은 이유).
  const dirtyCodes = fresh(files.slice(0, 3).map((f) => readFileSync(path.join(MIG_DIR, f), "utf8")));
  dirtyCodes.exec("INSERT INTO users (id,provider,provider_subject,session_version,created_at) VALUES ('a','k','1',0,0)");
  dirtyCodes.exec("INSERT INTO invite_codes (code,user_id,created_at) VALUES ('old','a',1)");
  dirtyCodes.exec("INSERT INTO invite_codes (code,user_id,created_at) VALUES ('new','a',2)");
  dirtyCodes.exec(readFileSync(path.join(MIG_DIR, files[3]), "utf8"));
  const alive = dirtyCodes.prepare("SELECT code FROM invite_codes WHERE revoked_at IS NULL").all();
  assert.equal(alive.length, 1, "0004 가 중복 활성 코드를 정리하지 못했다");
  assert.equal(alive[0].code, "new", "가장 최근 코드가 아니라 옛 코드를 남겼다 — 방금 공유한 링크가 죽는다");
  assert.equal(dirtyCodes.prepare("SELECT COUNT(*) n FROM invite_codes").get().n, 2, "정리하면서 행을 지웠다");

  console.log(`test-migrations: 통과 — ${files.length}개 이전, schema.sql 과 같은 모양, 중복 정리, users CASCADE 전수, 활성 초대 코드 1개`);
}
