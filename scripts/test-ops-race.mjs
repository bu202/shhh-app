// **운영 교차 행렬** — 백업 생산자 · 수동 reconcile · 정리 크론이 겹칠 때
// (2026-08-28 · 위협 88·89·90)
//
// ── 왜 별도 스위트인가 ─────────────────────────────────────────────────
// `test-backup.mjs` 는 백업 하나를 **혼자 돌렸을 때**를 재고, `test-cleanup.mjs` 는 크론 하나를
// **혼자 돌렸을 때**를 잰다. 둘 다 통과하는데도 아래가 재현됐다(2026-08-28):
//
//   ① `insertPending` 뒤 첫 export 앞에 수동 reconcile 이 끼어들면 → R2 가 아직 「없다」고
//      답하므로 `pending → aborted` 로 닫힌다. 그 뒤 생산자가 깨어나 **실제로 업로드한다.**
//      결과: `{ finalInventoryStatus: "aborted", objectPresent: true }`.
//      `aborted` 는 「객체가 없음을 확인했다」이고 **삭제 표식 정리를 막지 않는** 유일한 상태다 —
//      즉 데이터를 담은 백업이 살아 있는데 표식이 지워진다.
//   ② 크론 reconciliation 이 `ORDER BY snapshot_at LIMIT 25` 라, 앞 25개가 계속 살아 있으면
//      26번째는 **몇 회차가 지나도 검사되지 않는다**(실측: 3회차까지 상태 그대로).
//      그 행이 표식 정리를 막으므로 보유기간이 사실상 무한이 된다.
//
// ⚠️ **고정 sleep 이 아니라 실제 함수 진입 지점에 배리어를 둔다.** 「빠르니까 안 겹친다」로는
//    아무것도 증명되지 않는다 — `test-actor-fence.mjs` 와 같은 방식이다.
// ⚠️ **inventory 는 진짜 SQL 이다.** `makeInventory` 가 만드는 문장을 그대로 받아 실제 ledger
//    스키마(CHECK 제약 포함) 위에서 돌린다 — 가짜 객체로 흉내내면 CAS 를 아무것도 재지 못한다.
import assert from "node:assert";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  runBackup, reconcile, makeInventory, objectKeyFor, MIN_NODE, nodeOk, assertNode,
  REQUIRED_TABLES, REQUIRED_INDEXES,
} from "./backup.mjs";
import { reconcileBackups, RECON_LIMIT } from "../worker/cleanup/index.js";
import { BACKUP_NEXT, backupCanTransition } from "../worker/ledger.js";
import { makeLedger } from "./_d1.mjs";

let n = 0;
const t = (m) => { n++; return m; };

const tmp = await mkdtemp(path.join(tmpdir(), "shhh-race-"));
const keyFile = path.join(tmp, "key");
await writeFile(keyFile, Buffer.alloc(32, 7).toString("base64"));
const ENV = { BACKUP_MAIN_DB: "shhh-db", BACKUP_LEDGER_DB: "shhh-ledger",
              BACKUP_R2_BUCKET: "shhh-backups", BACKUP_KEY_FILE: keyFile };

const dump = (which) => [
  ...REQUIRED_TABLES[which].map((x) => `CREATE TABLE ${x} (a);`),
  ...REQUIRED_INDEXES[which].map((x, i) => `CREATE INDEX ${x} ON ${REQUIRED_TABLES[which][i]}(a);`),
].join("\n");

// ── 가짜 wrangler. **inventory SQL 은 진짜 ledger 스키마 위에서 돈다** ────
function mkRun(LEDGER, put, { onExport, r2Down = false, quiet = {} } = {}) {
  const maint = { mode: "maintenance", epoch: 7, drained_at: 1, pending_transition: null, ...quiet };
  return async (cmd, args) => {
    const kind = args[1] === "d1" && args[2] === "export" ? "export"
      : args[1] === "d1" ? "d1"
      : args[1] === "r2" && args[3] === "put" ? "put"
      : args[1] === "r2" ? "get" : "?";
    if (kind === "d1") {
      const sql = args[args.indexOf("--command") + 1];
      if (/write_leases/.test(sql)) return d1json([{ n: 0 }]);
      if (/write_fence/.test(sql)) return d1json([{ epoch: 7 }]);
      if (/FROM maintenance/.test(sql)) return d1json([maint]);
      // 그 밖은 전부 inventory 문장 — **실제 ledger DB 에 그대로 던진다.**
      try {
        const st = LEDGER._db.prepare(sql);
        if (/^\s*select/i.test(sql)) return d1json(st.all());
        const r = st.run();
        return { code: 0, err: "",
                 out: JSON.stringify([{ results: [], meta: { changes: Number(r.changes) } }]) };
      } catch (e) { return { code: 1, out: "", err: String(e && e.message) }; }
    }
    if (kind === "export") {
      if (onExport) await onExport();
      await writeFile(args[args.indexOf("--output") + 1],
                      dump(args[3].includes("ledger") ? "ledger" : "main"));
      return { code: 0, out: "", err: "" };
    }
    const key = String(args[4] || "").split("/").slice(1).join("/");
    if (kind === "put") {
      put.set(key, await readFile(args[args.indexOf("--file") + 1]));
      return { code: 0, out: "", err: "" };
    }
    if (r2Down) return { code: 1, out: "", err: "network unreachable" };
    if (!put.has(key)) return { code: 1, out: "", err: "The specified key does not exist (10007)" };
    await writeFile(args[args.indexOf("--file") + 1], put.get(key));
    return { code: 0, out: "", err: "" };
  };
}
const d1json = (results) =>
  ({ code: 0, err: "", out: JSON.stringify([{ results, meta: { changes: 0 } }]) });

const rowOf = (LEDGER, id) =>
  LEDGER._db.prepare("SELECT * FROM backups WHERE backup_id = ?").get(id);
const statuses = (LEDGER) =>
  LEDGER._db.prepare("SELECT status, COUNT(*) AS n FROM backups GROUP BY status").all();

// ══ R0. 전이표가 **업로드 권리**를 실제로 표현하나 ═════════════════════════
// `pending → uploaded` 가 남아 있으면 생산자는 권리를 따지 않고도 올린 것을 기록할 수 있다.
{
  assert.ok(Object.prototype.hasOwnProperty.call(BACKUP_NEXT, "uploading"),
    t("R0: ★ 전이표에 uploading 이 없다 — 업로드 권리를 표현할 자리가 없다"));
  assert.equal(backupCanTransition("pending", "uploaded"), false,
    t("R0: ★ pending 에서 곧장 uploaded 로 갈 수 있다 — 권리 없이 올린 것이 기록된다"));
  assert.equal(backupCanTransition("pending", "uploading"), true,
    t("R0: pending → uploading 이 막혀 있다 — 아무도 업로드할 수 없다"));
  assert.equal(backupCanTransition("uploading", "uploaded"), true,
    t("R0: uploading → uploaded 가 막혀 있다"));
  // `aborted` 는 **업로드가 시작되지 않았음을 아는** 상태에서만 간다.
  assert.deepEqual(Object.keys(BACKUP_NEXT).filter((f) => BACKUP_NEXT[f].includes("aborted")),
    ["pending"],
    t("R0: ★ pending 말고 다른 상태에서도 aborted 로 갈 수 있다 — 부재를 모르는 채로 닫힌다"));
}

// ══ R1. **생산자 ↔ 수동 reconcile 교차** — aborted 뒤 객체가 생기지 않는다 ══
// 배리어: `insertPending` 뒤, **첫 export 직전**에 수동 reconcile 을 완주시킨다.
{
  const LEDGER = makeLedger(), put = new Map();
  const inv = makeInventory({ ledgerDb: "shhh-ledger" }, mkRun(LEDGER, put));
  let fired = false;
  const run = mkRun(LEDGER, put, { onExport: async () => {
    if (fired) return; fired = true;
    await reconcile({ env: ENV, run: mkRun(LEDGER, put), inventory: inv });
  } });
  const r = await runBackup({ env: ENV, run, inventory: inv });
  const row = rowOf(LEDGER, r.backupId);
  const present = put.has(objectKeyFor(r.backupId));
  assert.ok(fired, t("R1: 배리어가 안 걸렸다 — 교차를 재지 못했다"));
  assert.ok(!(row.status === "aborted" && present),
    t(`R1: ★ aborted 인데 객체가 있다 (status=${row.status} present=${present}) — `
      + "삭제 표식 정리가 데이터를 담은 백업을 무시한다"));
  assert.equal(present, false,
    t(`R1: ★ reconcile 이 닫은 backup_id 로 업로드가 나갔다 (status=${row.status})`));
  assert.equal(r.ok, false, t("R1: 권리를 못 땄는데 성공이라 한다"));
  assert.equal(r.code, "claim", t(`R1: 실패 코드가 claim 이 아니다 (${r.code})`));
}

// ══ R2. **반대 순서** — 생산자가 먼저 권리를 따면 reconcile 이 못 닫는다 ═══
// 배리어: 생산자가 `uploading` 을 딴 **직후**(= put 직전) 수동 reconcile 을 완주시킨다.
{
  const LEDGER = makeLedger(), put = new Map();
  const inv = makeInventory({ ledgerDb: "shhh-ledger" }, mkRun(LEDGER, put));
  let out = null;
  const run = async (cmd, args) => {
    if (args[1] === "r2" && args[3] === "put" && !out)
      out = await reconcile({ env: ENV, run: mkRun(LEDGER, put), inventory: inv });
    return mkRun(LEDGER, put)(cmd, args);
  };
  const r = await runBackup({ env: ENV, run, inventory: inv });
  assert.ok(out, t("R2: 배리어가 안 걸렸다"));
  assert.equal(r.ok, true, t(`R2: ★ 권리를 딴 백업이 실패했다 (${r.code})`));
  assert.equal(rowOf(LEDGER, r.backupId).status, "ready",
    t("R2: ★ 권리를 딴 백업이 ready 로 안 끝났다"));
  assert.equal(put.has(objectKeyFor(r.backupId)), true, t("R2: 객체가 안 올라갔다"));
  // reconcile 은 그 행을 **닫지 못했고, 그 사실을 실패로 말한다.**
  assert.equal(out.ok, false,
    t("R2: ★ reconcile 이 진행 중인 업로드를 정상으로 넘겼다"));
}

// ══ R3. **생산자 ↔ 정리 크론 교차** — 자동도 수동과 같은 규칙이다 ══════════
// 「운영자가 동시에 안 돌리겠지」는 안전 근거가 아니다. 크론은 **매시간 스스로** 돈다.
{
  const LEDGER = makeLedger(), put = new Map();
  const inv = makeInventory({ ledgerDb: "shhh-ledger" }, mkRun(LEDGER, put));
  const cronEnv = { LEDGER, BACKUPS: { head: async (k) => (put.has(k) ? { size: 1 } : null) } };
  let fired = false;
  const run = mkRun(LEDGER, put, { onExport: async () => {
    if (fired) return; fired = true;
    await reconcileBackups(cronEnv, Date.now());
  } });
  const r = await runBackup({ env: ENV, run, inventory: inv });
  const row = rowOf(LEDGER, r.backupId);
  assert.ok(!(row.status === "aborted" && put.has(objectKeyFor(r.backupId))),
    t(`R3: ★ 크론이 닫은 뒤 객체가 생겼다 (status=${row.status})`));
  assert.equal(r.code, "claim", t(`R3: 크론이 닫았는데 생산자가 진행했다 (${r.code})`));
}

// ══ R4. **크론 ↔ 진행 중인 업로드** — 순간 부재로 자동 종결하지 않는다 ═════
{
  const LEDGER = makeLedger();
  const now = Date.now();
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploading')").run("a".repeat(32), now, now);
  const env = { LEDGER, BACKUPS: { head: async () => null } };   // 아직 안 보인다
  const out = await reconcileBackups(env, now + 1000);
  assert.equal(rowOf(LEDGER, "a".repeat(32)).status, "uploading",
    t("R4: ★ 진행 중인 업로드를 순간 부재만으로 닫았다"));
  assert.equal(out.gone, 0, t("R4: 닫지 않았는데 닫았다고 센다"));
  // 오래 방치된 것은 **닫지 않고 알린다** — 사람이 판단한다.
  const old = "b".repeat(32);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploading')").run(old, now, now - 12 * 3600e3);
  const out2 = await reconcileBackups(env, now + 2000);
  assert.equal(rowOf(LEDGER, old).status, "uploading",
    t("R4: ★ 방치된 uploading 을 시간만 보고 닫았다"));
  assert.ok(out2.stuck >= 1, t("R4: ★ 방치된 uploading 이 경보로 올라가지 않는다"));
}

// ══ R5. **25행 이후가 굶지 않는다** (2026-08-28 재현) ══════════════════════
{
  const LEDGER = makeLedger();
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const id = String(i).padStart(32, "0");
    ids.push(id);
    LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
      + " VALUES (?,?,?,'uploaded')").run(id, now - (60 - i) * 1000, now);
  }
  assert.equal(RECON_LIMIT, 25, t(`R5: 페이지 크기가 25가 아니다 (${RECON_LIMIT})`));
  // 앞 25개는 계속 present, 26번째만 absent.
  const target = ids[25];
  const env = { LEDGER, BACKUPS: {
    head: async (k) => (k.includes(target) ? null : { size: 1 }) } };
  let closedAt = 0;
  const rounds = Math.ceil(60 / RECON_LIMIT) + 1;
  for (let i = 1; i <= rounds; i++) {
    await reconcileBackups(env, now + i * 1000);
    if (!closedAt && rowOf(LEDGER, target).status === "deleted") closedAt = i;
  }
  assert.ok(closedAt > 0,
    t(`R5: ★ 26번째 행이 ${rounds}회차 안에 검사되지 않았다 — 영구 기아다`));
  assert.ok(closedAt <= rounds,
    t(`R5: 26번째 행이 ${closedAt}회차에야 닫혔다 — 유한 시간 보장이 없다`));
  // 커서는 **영속**이다. 회차마다 처음으로 돌아가면 위 성질이 저절로 깨진다.
  const cur = LEDGER._db.prepare("SELECT recon_cursor FROM cleanup_runs WHERE id = 1").get();
  assert.ok(cur && typeof cur.recon_cursor === "string",
    t("R5: ★ reconciliation 커서를 저장할 자리가 없다"));

  // ── 한 바퀴 뒤에 **다시** 검사되는가 (wrap-around) ──────────────────────
  // 위까지는 「한 바퀴 안에 전부 본다」만 잰다. 그런데 R2 lifecycle 은 **나중에** 지운다 —
  // 첫 바퀴에 present 였던 행이 그 다음에 사라지는 것이 정상 순서다. 커서가 끝에 닿은 뒤
  // 처음으로 돌아오지 않으면 그 행은 **영원히** 다시 안 보이고, 삭제 표식 정리를 계속 막는다.
  const late = ids[3];                              // **첫 페이지**의 행이어야 의미가 있다
  assert.equal(rowOf(LEDGER, late).status, "uploaded", t("R5: 첫 페이지 행이 벌써 닫혔다"));
  const env2 = { LEDGER, BACKUPS: {
    head: async (k) => (k.includes(late) || k.includes(target) ? null : { size: 1 }) } };
  let lapClosed = 0;
  const lap = Math.ceil(60 / RECON_LIMIT) + 2;      // 한 바퀴 + 여유
  for (let i = 1; i <= lap; i++) {
    await reconcileBackups(env2, now + (rounds + i) * 1000);
    if (!lapClosed && rowOf(LEDGER, late).status === "deleted") lapClosed = i;
  }
  assert.ok(lapClosed > 0,
    t(`R5: ★ 첫 페이지 행이 한 바퀴(${lap}회차) 뒤에도 다시 검사되지 않았다`
      + " — 커서가 끝에서 멈춘다(wrap-around 없음)"));
}

// ══ R6. **모르는 행 하나가 나머지를 영구 차단하지 않는다** ═════════════════
{
  const LEDGER = makeLedger();
  const now = Date.now();
  const bad = "f".repeat(32);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploaded')").run(bad, now, now);
  const gone = [];
  for (let i = 0; i < 30; i++) {
    const id = "e" + String(i).padStart(31, "0");
    gone.push(id);
    LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
      + " VALUES (?,?,?,'uploaded')").run(id, now, now);
  }
  const env = { LEDGER, BACKUPS: { head: async (k) => {
    if (k.includes(bad)) throw new Error("R2 down");
    return null;
  } } };
  for (let i = 1; i <= 4; i++) await reconcileBackups(env, now + i * 1000);
  const left = LEDGER._db.prepare(
    "SELECT COUNT(*) AS n FROM backups WHERE status = 'uploaded'").get().n;
  assert.equal(left, 1,
    t(`R6: ★ 모르는 행 하나 때문에 ${left - 1}개가 닫히지 못했다`));
  assert.equal(rowOf(LEDGER, bad).status, "uploaded",
    t("R6: 모르는 행을 근거 없이 닫았다"));
  assert.equal(rowOf(LEDGER, bad).deletion_checked_at, null,
    t("R6: ★ 확인하지 못한 행에 확인 시각을 적었다"));
}

// ══ R7. **수동 명령이 자동 크론보다 약한 규칙을 쓰지 않는다** ══════════════
{
  const LEDGER = makeLedger(), put = new Map();
  const now = Date.now();
  const inv = makeInventory({ ledgerDb: "shhh-ledger" }, mkRun(LEDGER, put));
  const up = "c".repeat(32);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploading')").run(up, now, now);
  const stuck = "d".repeat(32);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploading')").run(stuck, now, now - 12 * 3600e3);
  const out = await reconcile({ env: ENV, now, run: mkRun(LEDGER, put), inventory: inv });
  assert.equal(rowOf(LEDGER, up).status, "uploading",
    t("R7: ★ 수동 reconcile 이 진행 중인 업로드를 닫았다 — 크론보다 약하다"));
  assert.equal(out.ok, false, t("R7: 수동 reconcile 이 닫지 못한 행을 정상으로 넘겼다"));
  // ⚠️ **상태가 남았다는 것만으로는 부족하다**(2026-08-28 · 위협 91 을 고치자마자 드러났다).
  //    `uploading` 갈래를 통째로 건너뛰어도 전이표가 UPDATE 를 0행으로 막아 **행은 그대로 남는다** —
  //    그래서 옛 R7 은 그 변이를 못 잡았다. 그런데 그때 운영자가 받는 것은 「진행 중」·「방치」가
  //    아니라 **「경합」**이다. 방치된 업로드를 사람이 보고 `failed` 로 옮기는 절차
  //    (runbook §18-2-1)가 그 신호에 걸려 있으므로, **세는 칸까지 같아야** 규칙이 같은 것이다.
  assert.equal(out.uploading, 2,
    t(`R7: ★ 진행 중인 업로드를 uploading 으로 안 센다 (${out.uploading}) — 운영자 신호가 바뀐다`));
  assert.equal(out.stuck, 1,
    t(`R7: ★ 12시간 방치된 업로드가 방치로 안 올라간다 (${out.stuck})`));
  assert.equal(out.raced, 0,
    t(`R7: ★ 진행 중인 업로드를 경합으로 셌다 (${out.raced}) — 사람이 볼 신호가 사라진다`));
  assert.equal(out.closed, 0, t(`R7: 닫으면 안 되는 행을 ${out.closed}개 닫았다`));
}

// ══ R13. **크론의 CAS** — 조회와 UPDATE 사이에 생산자가 옮긴 행을 닫지 않는다 ══
// (2026-08-28 · 위협 91 을 고치자마자 드러난 공백)
// `backupFroms(to)` 만으로는 부족하다. `uploaded` 로 읽은 행이 그 사이 `ready` 가 되면
// **`ready` 도 `deleted` 의 출발 상태**라 그대로 통과한다 — 관측한 값을 조건에 걸어야 막힌다.
{
  const LEDGER = makeLedger();
  const now = Date.now();
  const id = "e".repeat(32);
  // `ready` 로 옮길 수 있어야 하므로 CHECK 가 요구하는 값을 전부 채운다.
  const full = "f".repeat(64);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status,"
    + " main_db_hash, ledger_db_hash, object_key, object_bytes, object_hash,"
    + " maintenance_epoch, key_fingerprint) VALUES (?,?,?,'uploaded',?,?,?,?,?,?,?)")
    .run(id, now, now, full, full, objectKeyFor(id), 10, full, 7, "0".repeat(16));
  let moved = 0;
  const env = { LEDGER, BACKUPS: { head: async () => {
    // **조회 뒤 · UPDATE 앞.** 생산자가 그 사이에 한 칸 옮긴다.
    if (!moved++) LEDGER._db.prepare("UPDATE backups SET status='ready' WHERE backup_id=?").run(id);
    return null;                                   // 그리고 객체는 없다
  } } };
  const out = await reconcileBackups(env, now);
  assert.equal(rowOf(LEDGER, id).status, "ready",
    t("R13: ★ 그 사이에 생산자가 옮긴 행을 닫았다 — 관측 상태 CAS 가 없다"));
  assert.equal(out.gone, 0, t(`R13: ★ 닫지 못한 행을 「닫았다」로 셌다 (gone ${out.gone})`));
  assert.equal(out.failed, 1, t(`R13: ★ 경합을 실패로 안 센다 (failed ${out.failed})`));
}

// ══ R14. **수동 명령의 CAS** — 0행을 「닫았다」로 세지 않는다 ═══════════════
// (2026-08-28 · 위협 91 을 고치자마자 드러난 공백)
{
  const LEDGER = makeLedger(), put = new Map();
  const now = Date.now();
  const id = "f".repeat(32);
  // `ready` 로 옮길 수 있어야 하므로 CHECK 가 요구하는 값을 전부 채운다.
  const full = "f".repeat(64);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status,"
    + " main_db_hash, ledger_db_hash, object_key, object_bytes, object_hash,"
    + " maintenance_epoch, key_fingerprint) VALUES (?,?,?,'uploaded',?,?,?,?,?,?,?)")
    .run(id, now, now, full, full, objectKeyFor(id), 10, full, 7, "0".repeat(16));
  const base = mkRun(LEDGER, put);
  let moved = 0;
  const run = async (c, a) => {
    // 부재 확인(`r2 object get`) 자리 = **조회 뒤 · markGone 앞**.
    if (a[1] === "r2" && a[3] === "get" && !moved++)
      LEDGER._db.prepare("UPDATE backups SET status='ready' WHERE backup_id=?").run(id);
    return base(c, a);
  };
  const out = await reconcile({ env: ENV, now, run, inventory: makeInventory({ ledgerDb: "shhh-ledger" }, run) });
  assert.equal(rowOf(LEDGER, id).status, "ready",
    t("R14: ★ 그 사이에 생산자가 옮긴 행을 닫았다"));
  assert.equal(out.closed, 0, t(`R14: ★ 0행을 「닫았다」로 셌다 (closed ${out.closed})`));
  assert.equal(out.raced, 1, t(`R14: ★ 경합을 안 센다 (raced ${out.raced}) — 통계에서 사라진다`));
  assert.equal(out.ok, false, t("R14: 경합이 있는데 명령이 성공으로 끝난다"));
}

// ══ R8. **R2 가 답하지 않으면 아무것도 안 적는다** (양쪽 진입점) ═══════════
{
  const LEDGER = makeLedger(), put = new Map();
  const now = Date.now();
  const id = "d".repeat(32);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploaded')").run(id, now, now);
  const inv = makeInventory({ ledgerDb: "shhh-ledger" }, mkRun(LEDGER, put));
  const out = await reconcile({ env: ENV, now,
    run: mkRun(LEDGER, put, { r2Down: true }), inventory: inv });
  assert.equal(out.ok, false, t("R8: R2 가 죽었는데 성공이라 한다"));
  const row = rowOf(LEDGER, id);
  assert.equal(row.status, "uploaded", t("R8: ★ 모르는데 상태를 옮겼다"));
  assert.equal(row.deletion_checked_at, null, t("R8: ★ 모르는데 확인 시각을 적었다"));
}

// ══ R9. **Node 런타임 계약** ═══════════════════════════════════════════════
// `node:sqlite` 는 22.13 부터 플래그 없이 쓸 수 있다. 그 아래에서는 **이해할 수 있는 메시지로
// 즉시 멈춰야** 한다 — 애매한 import 오류로 끝나면 운영자가 「백업이 원래 안 되는 것」으로 읽는다.
{
  assert.equal(MIN_NODE, "22.13.0", t(`R9: 최소 Node 판이 22.13.0 이 아니다 (${MIN_NODE})`));
  for (const v of ["18.20.4", "20.11.0", "22.4.0", "22.12.9"])
    assert.equal(nodeOk(v), false, t(`R9: ★ Node ${v} 를 지원한다고 답한다`));
  for (const v of ["22.13.0", "22.14.1", "23.4.0", "24.14.0", "30.0.0"])
    assert.equal(nodeOk(v), true, t(`R9: Node ${v} 를 못 쓴다고 답한다`));
  assert.throws(() => assertNode("20.11.0"), /22\.13\.0/,
    t("R9: ★ 지원하지 않는 Node 에서 던지지 않거나 필요한 판을 안 말한다"));
  assert.doesNotThrow(() => assertNode(process.versions.node),
    t("R9: 지금 Node 에서 백업 도구가 막힌다"));
  // 선언이 **한 자리**에서 나오나. 문서·설정이 코드와 갈라지면 아무 소용이 없다.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines && pkg.engines.node, `>=${MIN_NODE}`,
    t(`R9: ★ package.json 의 engines.node 가 코드와 다르다 (${pkg.engines?.node})`));
  const nvmrc = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  assert.equal(nvmrc, MIN_NODE, t(`R9: ★ .nvmrc 가 코드와 다르다 (${nvmrc})`));
}

// ══ R10. 교차 뒤에도 **막는 행이 남아 있으면 정리를 막는다** ═══════════════
// 이번 수정이 「닫히지 않는 행」을 늘리는 방향이므로, 그 행이 실제로 막는지 확인한다.
{
  const LEDGER = makeLedger();
  const now = Date.now();
  // `ready` 는 CHECK 가 값들을 요구한다 — 전부 채워 넣는다.
  const full = "f".repeat(64);
  for (const [i, st] of ["pending", "uploading", "uploaded", "ready", "failed"].entries())
    LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status,"
      + " main_db_hash, ledger_db_hash, object_key, object_bytes, object_hash,"
      + " maintenance_epoch, key_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(String(i).repeat(32).slice(0, 32), now - 1000, now, st,
           full, full, "shhh/x.enc", 10, full, 7, "0".repeat(16));
  const blocking = LEDGER._db.prepare(
    "SELECT COUNT(*) AS n FROM backups b WHERE b.deleted_at IS NULL AND b.status <> 'aborted'"
    + " AND b.snapshot_at <= ?").get(now).n;
  assert.equal(blocking, 5,
    t(`R10: ★ 막아야 할 상태가 ${blocking}개다 — uploading 이 정리를 안 막는다`));
}

// ══ R11. **모든 중단 지점에서** 교차시킨다 — 남은 순서가 하나도 없나 ══════
// R1·R3 은 배리어를 한 자리에 뒀다. 「거기만 안전한 것」과 「어디서든 안전한 것」은 다르다.
//
// **배리어를 어디에 거나 (2026-08-28 · 위협 92).** 생산자가 내는 **외부 명령 전부** 앞이다 —
// `runBackup` 이 직접 내는 것뿐 아니라 **inventory 가 내는 SQL 도 같은 runner** 를 지난다.
// 그래서 상태 전이(`insertPending` · `setUploading` · `setUploaded` · `setReady`)가 각각
// 실제로 실행된 경계가 된다. 마지막 자리(`at === steps`)는 명령이 없으므로 **반환 직후**에
// 완주시킨다. ⛔ 옛 판은 그 자리를 `fired || at === steps` 로 통과시켜서 **reconciliation 을
// 한 번도 안 돌린 회차를 「경계를 쟀다」로 셌다.** 이제 `fired` 를 그냥 요구한다.
// ⚠️ 「전수」는 **여기서 실제로 실행한 경계**에만 쓴다 — 실행 목록은 아래 pre-pass 가 만든다.
{
  // 한 번의 정상 백업이 내는 명령 수를 먼저 잰다(배리어 자리 수).
  let steps = 0;
  const cmds = [];
  {
    const LEDGER = makeLedger(), put = new Map();
    const base = mkRun(LEDGER, put);
    const run = async (c, a) => { steps++; cmds.push((a || []).join(" ")); return base(c, a); };
    await runBackup({ env: ENV, run, inventory: makeInventory({ ledgerDb: "shhh-ledger" }, run) });
    assert.ok(steps >= 12, t(`R11: 배리어 자리가 ${steps}개뿐이다 — 교차를 다 못 잰다`));
    // 핵심 상태 전이가 **실행 목록 안에** 실제로 있어야 한다. 없으면 그 전이 앞에서는
    // 아무도 끼어들지 않은 것이고, 그러면 아래 「전수」는 거짓말이다.
    for (const need of ["'pending'", "'uploading'", "'uploaded'", "'ready'", "object put"])
      assert.ok(cmds.some((c) => c.includes(need)),
        t(`R11: ★ 실행한 경계에 ${need} 가 없다 — 그 전이는 교차를 안 쟀다`));
  }
  for (let at = 0; at <= steps; at++) {
    for (const who of ["manual", "cron"]) {
      const LEDGER = makeLedger(), put = new Map();
      const cronEnv = { LEDGER, BACKUPS: { head: async (k) => (put.has(k) ? { size: 1 } : null) } };
      let i = 0, fired = false;
      const base = mkRun(LEDGER, put);
      let inv;
      const cross = async () => {
        fired = true;
        if (who === "manual") await reconcile({ env: ENV, run: mkRun(LEDGER, put), inventory: inv });
        else await reconcileBackups(cronEnv, Date.now());
      };
      const run = async (c, a) => {
        if (i++ === at) await cross();      // 한 번만 — `i` 가 `at` 과 같아지는 순간은 하나다
        return base(c, a);
      };
      inv = makeInventory({ ledgerDb: "shhh-ledger" }, run);
      const r = await runBackup({ env: ENV, run, inventory: inv });
      if (!fired) await cross();          // 마지막 자리: 명령이 없으므로 **반환 직후**에 완주시킨다
      const row = rowOf(LEDGER, r.backupId);
      const present = put.has(objectKeyFor(r.backupId));
      // ⛔ **이 조합이 하나라도 나오면 삭제 표식이 근거 없이 지워진다.**
      assert.ok(!(row && row.status === "aborted" && present),
        t(`R11: ★ ${who} 이 ${at}번째 명령 앞에서 끼어들었더니 aborted + 객체 존재다`));
      // 성공했다면 반드시 ready 이고, 실패했다면 객체가 없거나 「모른다」로 남아 막는다.
      if (r.ok) assert.equal(row.status, "ready", t(`R11: ${who}/${at} 성공인데 ${row.status} 다`));
      else assert.ok(!present || (row && row.status !== "aborted"),
        t(`R11: ${who}/${at} 실패인데 객체가 남고 행이 안 막는다 (${row && row.status})`));
      // ⛔ 예외 통과 없음. 실행하지 않은 경계를 「전수」에 세지 않는다.
      assert.ok(fired, t(`R11: ${who}/${at} reconciliation 을 아예 안 돌렸다`));
    }
  }
}

// ══ R12. **`uploading` 이 영원히 막지는 않는다** — 닫히는 길이 실제로 있다 ══
// 새 상태가 「절대 안 닫히는 행」을 만들면 위협 85 가 고친 상태로 되돌아간다.
{
  const LEDGER = makeLedger(), put = new Map();
  const now = Date.now();
  const id = "9".repeat(32);
  LEDGER._db.prepare("INSERT INTO backups (backup_id, snapshot_at, created_at, status)"
    + " VALUES (?,?,?,'uploading')").run(id, now, now - 12 * 3600e3);
  const env = { LEDGER, BACKUPS: { head: async () => null } };
  // 1) 크론은 닫지 않고 **경보**로 올린다.
  const a = await reconcileBackups(env, now);
  assert.equal(rowOf(LEDGER, id).status, "uploading", t("R12: 크론이 방치된 행을 스스로 닫았다"));
  assert.ok(a.stuck >= 1, t("R12: 방치가 경보로 안 올라간다"));
  // 2) 운영자가 runbook 절차대로 `failed` 로 옮긴다(⛔ `aborted` 가 아니다).
  const upd = LEDGER._db.prepare(
    "UPDATE backups SET status = 'failed', last_error_code = 'stuck_upload'"
    + " WHERE backup_id = ? AND status = 'uploading'").run(id);
  assert.equal(Number(upd.changes), 1, t("R12: ★ 운영자 절차가 전이표에 막힌다 — 닫는 길이 없다"));
  // 3) 그 다음 회차가 **부재를 확인해** 닫는다.
  await reconcileBackups(env, now + 1000);
  const row = rowOf(LEDGER, id);
  assert.equal(row.status, "deleted", t(`R12: ★ 부재를 확인해도 안 닫힌다 (${row.status})`));
  assert.ok(row.deleted_at, t("R12: deleted 인데 확인 시각이 없다"));
  // 4) 닫힌 행은 더 이상 삭제 표식 정리를 막지 않는다.
  const blocking = LEDGER._db.prepare(
    "SELECT COUNT(*) AS n FROM backups b WHERE b.deleted_at IS NULL AND b.status <> 'aborted'").get().n;
  assert.equal(blocking, 0, t("R12: ★ 닫힌 행이 아직도 막는다 — 보유기간이 무한이 된다"));
}

await rm(tmp, { recursive: true, force: true });
console.log(`test-ops-race: ${n}개 통과 — 생산자↔수동 reconcile↔크론 교차 · 업로드 권리 CAS · `
  + `진행 중 업로드는 시간만으로 안 닫는다 · 25행 이후 기아 없음 · Node 런타임 계약`);
