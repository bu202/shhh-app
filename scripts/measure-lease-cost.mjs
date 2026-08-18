// 요청 임차증(결정 A′)의 비용 측정. `node scripts/measure-lease-cost.mjs`
//
// **무엇을 재는가 / 무엇을 못 재는가**를 먼저 적는다. 이 구분이 흐려지면 측정이 근거가 아니라
// 장식이 된다.
//
//   잴 수 있는 것 : 요청 하나가 던지는 **SQL 문장 수**, 각 문장이 바꾼 **행 수**,
//                   그 문장이 건드리는 **인덱스 항목 수**(스키마에서 센다)
//   못 재는 것    : D1 이 돌려주는 **`meta.rows_written` 실측값**과 **실제 지연시간**.
//                   셰임은 in-memory sqlite 라 네트워크 왕복도, D1 의 회계도 없다.
//                   공식 문서도 `rows_written` 에 인덱스 쓰기가 포함되는지 말하지 않는다
//                   (developers.cloudflare.com/d1/worker-api/return-object/ 확인 2026-08-18).
//                   **그 두 값은 원격 실측이 필요하고, 원격 작업은 별도 승인 대상이다.**
//
// 그래서 아래 「인덱스 포함 쓰기 항목」은 **스키마에서 계산한 상한**이고 실측값이 아니다.
import worker, { createAccountWithPolicy, newSession } from "../worker/index.js";
import { makeD1, makeLedger } from "./_d1.mjs";

const ORIGIN = "https://app.test";
const KEY32 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64url");

// 문장 하나가 쓰는 **행 + 인덱스 항목** 수. 스키마에서 센다.
//   write_leases : PK(lease_id) + write_leases_active(released_at, expires_at)
//   rate_limits  : PK(bucket)
//   books        : PK(user_id)
const IDX = { write_leases: 2, rate_limits: 1, books: 1, sessions: 1, users: 1 };
const tableOf = (sql) => (/(?:INTO|UPDATE|FROM)\s+(\w+)/i.exec(sql) || [])[1] || "?";

function counting(db) {
  const log = [];
  const wrap = (st, sql) => ({
    bind: (...a) => wrap(st.bind(...a), sql),
    first: (...a) => st.first(...a),
    all: () => st.all(),
    run: async () => {
      const r = await st.run();
      const ch = (r.meta && r.meta.changes) || 0;
      if (ch > 0 || /INSERT|UPDATE|DELETE/i.test(sql)) {
        const tbl = tableOf(sql);
        log.push({ tbl, changes: ch, entries: ch * (1 + (IDX[tbl] || 0)) });
      }
      return r;
    },
  });
  return {
    _db: db._db, log,
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: (sts) => db.batch(sts.map((s) => s._raw || s)),
  };
}

const env0 = () => ({
  APP_ORIGIN: ORIGIN, APP_URL: ORIGIN + "/", STATE_KEY: "k", RL_KEY: "r",
  SIGNUP_STATE_KEY: KEY32, TOMBSTONE_KEY: "t", DELETION_KEY: "d",
  DB: makeD1(), LEDGER: makeLedger(), KAKAO_ID: "id",
});

async function measure(label, withLedger) {
  const env = env0();
  const uid = await createAccountWithPolicy(env, "kakao", "cost-" + label, {
    stateHash: "s-" + label, stateExp: Date.now() + 600e3, occurredAt: Date.now(),
  });
  const token = await newSession(env, uid);
  const ledger = counting(env.LEDGER);
  const run = { ...env, LEDGER: withLedger ? ledger : undefined };
  // 측정 대상: 자동저장 한 번(가장 뜨거운 경로)
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) {
    await worker.fetch(new Request("https://api.test/api/book", {
      method: "PUT", headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: "shh_s=" + token },
      body: JSON.stringify({ words: ["가"], version: i }),
    }), run);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const w = ledger.log;
  return {
    label, N, msTotal: ms.toFixed(1), msPer: (ms / N).toFixed(3),
    ledgerStatements: (w.length / N).toFixed(2),
    ledgerRows: (w.reduce((a, x) => a + x.changes, 0) / N).toFixed(2),
    ledgerEntries: (w.reduce((a, x) => a + x.entries, 0) / N).toFixed(2),
  };
}

// ⚠️ **예열한다.** 첫 실행은 JIT·sqlite 준비 때문에 두 번째보다 느리다 —
//    예열 없이 재면 "임차증을 붙였더니 빨라졌다" 같은 무의미한 숫자가 나온다(실제로 나왔다).
await measure("warmup", true);
await measure("warmup", false);
const off = await measure("ledger 바인딩 없음", false);
const on = await measure("임차증 있음", true);

console.log("PUT /book 자동저장 1회당 (셰임 실측 · N=" + on.N + ")");
console.log("");
console.log("  경우              총 ms     1회 ms   ledger 문장  ledger 행  행+인덱스(상한)");
for (const r of [off, on]) {
  console.log(`  ${r.label.padEnd(14)}  ${String(r.msTotal).padStart(7)}  ${String(r.msPer).padStart(8)}`
    + `  ${String(r.ledgerStatements).padStart(10)}  ${String(r.ledgerRows).padStart(9)}  ${String(r.ledgerEntries).padStart(14)}`);
}
console.log("");
console.log("");
console.log("  · 주 D1 쪽 쓰기는 두 경우가 **같다** — 임차증은 ledger D1 에만 쓴다.");
console.log("  · 「없음」은 ledger 바인딩 자체가 없어 **게이트 조회도 안 하는** 경우다.");
console.log("    그래서 두 줄의 차이는 임차증 2문장 + 게이트 1문장을 합친 값이다.");
console.log("  ⚠️ ms 는 in-memory sqlite 값이라 **D1 왕복 지연이 아니고, 회차 간 편차가 이 차이보다 크다.**");
console.log("     판단에 쓸 수 있는 숫자는 **문장 수와 행+인덱스 항목 수**뿐이다.");
console.log("     실제 지연과 meta.rows_written 은 원격 실측이 필요하고 **별도 승인 대상**이다.");
