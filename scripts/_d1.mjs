// 테스트용 D1 셰임. `node:sqlite` 위에 Cloudflare D1 의 호출 규약을 얹는다.
//
// 왜 가짜 객체가 아니라 **진짜 SQL** 인가: 예전 가짜 KV 는 Map 이라 "즉시 일관적이고 절대 실패하지
// 않는" 저장소였고, 그래서 12개가 통과하는데도 라이브에서 남의 단어 개수가 새어 나갔다(함정 50).
// D1 로 옮기면서 재려는 것이 바로 **제약·트랜잭션·changes 카운트**라, 그걸 흉내내면 아무것도 안 잰다.
// sqlite 를 그대로 쓰면 외래키 CASCADE 도 UNIQUE 충돌도 진짜로 일어난다.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");

// D1 은 `?` 와 `?1` 을 둘 다 받는다. node:sqlite 도 그렇지만, 이름 있는 자리와 익명 자리를
// 섞으면 바인딩 규칙이 갈린다 — worker 코드가 쓰는 두 형태를 그대로 통과시키는지 여기서 확인된다.
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  #prep() { return this.db.prepare(this.sql); }
  async first(col) {
    const row = this.#prep().get(...this.args);
    if (!row) return null;
    return col === undefined ? row : row[col];
  }
  async all() {
    return { results: this.#prep().all(...this.args), success: true };
  }
  async run() {
    const r = this.#prep().run(...this.args);
    // D1 은 `meta.changes` 로 몇 줄이 바뀌었는지 말한다. worker 가 이 값으로
    // "받은 요청이 아니에요"·"친구가 아니에요"를 판정하므로 모양이 같아야 한다.
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");   // ⚠️ 켜지 않으면 CASCADE 가 조용히 안 돈다
  db.exec(SCHEMA);
  return {
    prepare: (sql) => new Stmt(db, sql),
    // D1 의 batch 는 **하나의 트랜잭션**이다. 중간에 실패하면 앞의 것도 되돌아간다 —
    // 이 성질을 재는 테스트가 있으므로 흉내가 아니라 실제 트랜잭션으로 돌린다.
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    _db: db,
  };
}
