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

  console.log(`test-migrations: 통과 — ${files.length}개 이전, schema.sql 과 같은 모양, 중복 정리 확인`);
}
