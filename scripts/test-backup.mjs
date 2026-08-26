// migration 직전 백업 — **fail-closed 전수 검사** (2026-08-26 · H1)
//
// 재는 것은 하나다: **백업이 확실히 성공하지 않은 모든 경우에 migration 이 막히는가.**
// 반대 방향(성공 경로)도 함께 잰다 — 막는 쪽만 재면 「영영 안 되는」 회귀를 못 잡는다.
//
// ⛔ **원격에 한 글자도 쓰지 않는다.** 외부 명령 실행기와 inventory 를 전부 가짜로 끼운다.
//    실제 `wrangler` 는 이 스위트에서 한 번도 실행되지 않는다(호출 목록으로 확인한다).
import assert from "node:assert";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runBackup, backupGate, readConfig, sqlValue, REQUIRED_TABLES, NEXT,
  BACKUP_TTL_DAYS, GATE_MAX_AGE,
} from "./backup.mjs";

let n = 0;
const t = (m) => { n++; return m; };
const KEY = Buffer.alloc(32, 7).toString("base64");

const dump = (which) => REQUIRED_TABLES[which]
  .map((x) => `CREATE TABLE ${x} (a);\nINSERT INTO ${x} VALUES (1);`).join("\n");

// 가짜 inventory. 상태 전이를 **표대로** 강제한다 — 코드가 순서를 건너뛰면 여기서 걸린다.
function fakeInv(opts = {}) {
  const rows = new Map();
  const calls = [];
  const guard = (name) => { if (opts.failOn === name) throw new Error("inventory down"); };
  return {
    rows, calls,
    async insertPending(id, at) { guard("insert"); calls.push("insert");
      rows.set(id, { status: "pending", snapshot_at: at }); },
    async setUploaded(id, m, l, k, exp) { guard("uploaded"); calls.push("uploaded");
      const r = rows.get(id);
      assert.ok(NEXT[r.status].includes("uploaded"), `전이 위반: ${r.status} → uploaded`);
      Object.assign(r, { status: "uploaded", main_db_hash: m, ledger_db_hash: l,
                         object_key: k, expires_expected_at: exp }); },
    async setReady(id) { guard("ready"); calls.push("ready");
      const r = rows.get(id);
      assert.ok(NEXT[r.status].includes("ready"), `전이 위반: ${r.status} → ready`);
      r.status = "ready"; },
    async fail(id, code) { calls.push("fail:" + code);
      const r = rows.get(id); if (r) { r.status = "failed"; r.last_error_code = code; } },
  };
}

// 가짜 실행기. **실제로 파일을 만든다** — 「export 는 성공했는데 파일이 없다」를 재려면
// 파일 유무가 진짜여야 한다.
function fakeRun({ fail = {}, emptyMain = false, missingTable = null, noFile = false } = {}) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      const kind = args[1] === "d1" && args[2] === "export" ? "export"
        : args[1] === "d1" ? "d1"
        : args[1] === "r2" && args[3] === "put" ? "put"
        : args[1] === "r2" ? "get" : "?";
      if (kind === "export") {
        const which = args[3].includes("ledger") ? "ledger" : "main";
        if (fail[which + "_export"]) return { code: 1, out: "", err: "" };
        if (noFile) return { code: 0, out: "", err: "" };     // 코드 0인데 파일이 없다
        const out = args[args.indexOf("--output") + 1];
        let text = dump(which);
        if (emptyMain && which === "main") text = "";
        if (missingTable && which === missingTable[0])
          text = text.replace(new RegExp(`CREATE TABLE ${missingTable[1]} \\(a\\);`), "");
        await writeFile(out, text);
        return { code: 0, out: "", err: "" };
      }
      if (kind === "put" && fail.upload) return { code: 1, out: "", err: "" };
      if (kind === "get" && fail.upload_verify) return { code: 1, out: "", err: "" };
      return { code: 0, out: "[]", err: "" };
    },
  };
}

const tmp = await mkdtemp(path.join(tmpdir(), "shhh-bk-test-"));
const keyFile = path.join(tmp, "key");
await writeFile(keyFile, KEY);
const ENV = { BACKUP_MAIN_DB: "shhh-db", BACKUP_LEDGER_DB: "shhh-ledger",
              BACKUP_R2_BUCKET: "shhh-backups", BACKUP_KEY_FILE: keyFile };

// ══ B1. 설정이 없으면 아무것도 하지 않는다 — **지금 이 저장소의 상태** ══
{
  for (const drop of ["BACKUP_MAIN_DB", "BACKUP_LEDGER_DB", "BACKUP_R2_BUCKET", "BACKUP_KEY_FILE"]) {
    const env = { ...ENV }; delete env[drop];
    const f = fakeRun();
    const r = await runBackup({ env, run: f.run, inventory: fakeInv() });
    assert.equal(r.ok, false, t(`B1: ${drop} 이 없는데 백업이 성공했다고 한다`));
    assert.equal(r.code, "config", t(`B1: ${drop} 부재를 config 실패로 안 본다`));
    assert.equal(f.calls.length, 0, t(`B1: ${drop} 이 없는데 외부 명령을 ${f.calls.length}번 실행했다`));
  }
  // 키 파일이 가리키는 파일이 없을 때 · 길이가 32바이트가 아닐 때도 같다.
  const short = path.join(tmp, "short"); await writeFile(short, Buffer.alloc(8).toString("base64"));
  for (const kf of [path.join(tmp, "없는파일"), short]) {
    const f = fakeRun();
    const r = await runBackup({ env: { ...ENV, BACKUP_KEY_FILE: kf }, run: f.run, inventory: fakeInv() });
    assert.equal(r.code, "config", t("B1: 키가 없거나 32바이트가 아닌데 진행했다"));
    assert.equal(f.calls.length, 0, t("B1: 키가 잘못됐는데 외부 명령을 실행했다"));
  }
}

// ══ B2. 두 DB 중 하나라도 export 실패 → 업로드도 기록도 없다 ══
for (const which of ["main", "ledger"]) {
  const f = fakeRun({ fail: { [which + "_export"]: true } });
  const inv = fakeInv();
  const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
  assert.equal(r.ok, false, t(`B2: ${which} export 가 실패했는데 성공이라 한다`));
  assert.equal(r.step, `${which}_export`, t(`B2: ${which} 실패 단계가 안 맞다`));
  assert.ok(!f.calls.some((c) => c.includes("r2")), t(`B2: ${which} export 실패 뒤 업로드했다`));
  assert.equal(inv.rows.get(r.backupId).status, "failed", t(`B2: ${which} 실패가 기록되지 않았다`));
  assert.ok(!inv.calls.includes("ready"), t(`B2: ${which} 실패인데 ready 로 적었다`));
}

// ══ B3. 빈 파일 · 파일 없음 · 필수 표 누락 → 실패 ══
{
  for (const [label, opt] of [
    ["빈 export", { emptyMain: true }],
    ["코드 0인데 파일 없음", { noFile: true }],
    ["주 D1 에 users 표 없음", { missingTable: ["main", "users"] }],
    ["ledger 에 deletions 표 없음", { missingTable: ["ledger", "deletions"] }],
    ["ledger 에 backups 표 없음", { missingTable: ["ledger", "backups"] }],
  ]) {
    const f = fakeRun(opt);
    const inv = fakeInv();
    const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
    assert.equal(r.ok, false, t(`B3: ${label} 인데 성공이라 한다`));
    assert.ok(!f.calls.some((c) => c.includes("r2 object put")), t(`B3: ${label} 인데 업로드했다`));
    assert.notEqual(inv.rows.get(r.backupId).status, "ready", t(`B3: ${label} 인데 ready 다`));
  }
}

// ══ B4. 업로드 실패 · 업로드 검증 실패 → ready 기록 금지 ══
{
  for (const [label, opt, step] of [
    ["업로드 실패", { fail: { upload: true } }, "upload"],
    ["업로드 검증 실패", { fail: { upload_verify: true } }, "upload_verify"],
  ]) {
    const f = fakeRun(opt);
    const inv = fakeInv();
    const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
    assert.equal(r.ok, false, t(`B4: ${label} 인데 성공이라 한다`));
    assert.equal(r.step, step, t(`B4: ${label} 단계가 안 맞다`));
    assert.equal(inv.rows.get(r.backupId).status, "failed", t(`B4: ${label} 인데 failed 가 아니다`));
    assert.ok(!inv.calls.includes("ready"), t(`B4: ${label} 인데 ready 를 적었다`));
  }
}

// ══ B5. inventory 기록 실패 → 백업이 실패다 ══
// 「기록만 실패했으니 성공으로 치자」가 있으면 migration 게이트가 근거를 잃는다.
for (const failOn of ["insert", "uploaded", "ready"]) {
  const f = fakeRun();
  const inv = fakeInv({ failOn });
  const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
  assert.equal(r.ok, false, t(`B5: inventory ${failOn} 실패인데 성공이라 한다`));
  assert.equal(r.code, "inventory", t(`B5: inventory ${failOn} 실패 코드가 안 맞다`));
  if (failOn === "insert")
    assert.equal(f.calls.length, 0, t("B5: pending 을 못 적었는데 export 를 진행했다"));
}

// ══ B6. 성공 경로 — **한 DB 만 성공한 상태가 존재할 수 없다** ══
{
  const f = fakeRun();
  const inv = fakeInv();
  const now = Date.now();
  const r = await runBackup({ env: ENV, run: f.run, inventory: inv, now });
  assert.equal(r.ok, true, t("B6: 정상 경로가 실패했다: " + r.step));
  const row = inv.rows.get(r.backupId);
  assert.equal(row.status, "ready", t("B6: ready 가 아니다"));
  assert.ok(row.main_db_hash && row.ledger_db_hash, t("B6: 두 DB 해시가 모두 있지 않다"));
  assert.notEqual(row.main_db_hash, row.ledger_db_hash, t("B6: 두 해시가 같다 — 같은 파일을 두 번 쟀다"));
  assert.equal(row.expires_expected_at, now + BACKUP_TTL_DAYS * 86400e3,
    t("B6: 만료 예정 시각이 lifecycle 과 다르다"));
  assert.deepEqual(inv.calls, ["insert", "uploaded", "ready"], t("B6: 상태 전이 순서가 다르다"));
  // 업로드 **뒤에** 검증한다. 순서가 뒤집히면 없는 객체를 검증하게 된다.
  const put = f.calls.findIndex((c) => c.includes("r2 object put"));
  const get = f.calls.findIndex((c) => c.includes("r2 object get"));
  assert.ok(put >= 0 && get > put, t("B6: 업로드 검증이 업로드보다 먼저다"));
}

// ══ B7. dry-run 은 원격 쓰기 0건 ══
{
  const f = fakeRun();
  const inv = fakeInv();
  const r = await runBackup({ env: ENV, run: f.run, inventory: inv, dryRun: true });
  assert.equal(r.ok, true, t("B7: dry-run 이 실패했다"));
  assert.equal(inv.calls.length, 0, t(`B7: dry-run 이 inventory 를 ${inv.calls.length}번 건드렸다`));
  assert.ok(!f.calls.some((c) => c.includes("r2")), t("B7: dry-run 이 R2 를 건드렸다"));
  assert.ok(!f.calls.some((c) => c.includes("--command")), t("B7: dry-run 이 원격 SQL 을 던졌다"));
  assert.ok(r.bytes > 0, t("B7: dry-run 이 암호화 결과 크기를 안 말한다"));
}

// ══ B8. 백업 성공이 migration 을 **실행하지 않는다** ══
{
  const f = fakeRun();
  await runBackup({ env: ENV, run: f.run, inventory: fakeInv() });
  assert.ok(!f.calls.some((c) => /migrations\s+apply/.test(c)),
    t("B8: 백업이 migration 을 자동 실행했다"));
  // 되돌리는 경로 자체가 없어야 한다.
  const src = await (await import("node:fs/promises")).readFile(
    new URL("./backup.mjs", import.meta.url), "utf8");
  assert.ok(!/time-travel\s+restore|d1\s+restore/.test(src),
    t("B8: 백업 스크립트에 복원 경로가 생겼다 — 자동 복원은 금지다"));
}

// ══ B9. 게이트 ══
{
  const now = Date.now();
  const q = (rows) => async () => JSON.stringify([{ results: rows }]);
  assert.equal((await backupGate({ env: ENV, now, query: q([{ snapshot_at: now - 60e3 }]) })).ok,
    true, t("B9: 방금 만든 ready 백업이 있는데 막았다"));
  // ⚠️ **`code` 만 재지 않는다**(2026-08-26 · 돌연변이 M85 생존). `catch` 가
  //    `{ ok: true, code: "unreadable" }` 을 돌려주는 변이가 **`code` 단언을 통과했다** —
  //    막느냐 마느냐를 정하는 값은 `ok` 인데 그것을 아무도 안 보고 있었다.
  for (const [label, query, code] of [
    ["ready 백업 없음", q([]), "none"],
    ["백업이 너무 오래됨", q([{ snapshot_at: now - GATE_MAX_AGE - 1 }]), "stale"],
    ["상태를 못 읽음", async () => { throw new Error("down"); }, "unreadable"],
    ["미래 시각", q([{ snapshot_at: now + 60e3 }]), "stale"],
  ]) {
    const r = await backupGate({ env: ENV, now, query });
    assert.equal(r.ok, false, t(`B9: ${label} 인데 게이트가 열렸다 — migration 이 진행된다`));
    assert.equal(r.code, code, t(`B9: ${label} 의 사유 코드가 ${r.code} 다`));
  }
  const { miss } = readConfig({});
  assert.ok(miss.length >= 4, t("B9: 설정 부재를 못 센다"));
  assert.equal((await backupGate({ env: {}, now })).code, "config",
    t("B9: 설정이 없는데 게이트가 통과했다"));
}

// ══ B10. SQL 로 나가는 값의 모양이 고정돼 있다 ══
{
  assert.equal(sqlValue("a".repeat(32).replace(/a/g, "0"), "id"), "'" + "0".repeat(32) + "'",
    t("B10: 정상 id 를 거부한다"));
  assert.equal(sqlValue(123, "int"), "123", t("B10: 정상 정수를 거부한다"));
  assert.equal(sqlValue(null, "int"), "NULL", t("B10: null 을 NULL 로 안 쓴다"));
  for (const [v, kind] of [
    ["'; DROP TABLE backups; --", "id"], ["x' OR '1'='1", "key"], ["ready'; --", "status"],
    ["nothex", "hash"], [1.5, "int"], ["../../etc/passwd", "key"], ["a b", "code"],
  ]) {
    assert.throws(() => sqlValue(v, kind),
      t(`B10: 주입 가능한 값이 통과했다: ${String(v).slice(0, 24)} (${kind})`));
  }
}

// ══ B11. 로그에 개인정보·키·백업 내용이 없다 ══
{
  const lines = [];
  const f = fakeRun();
  await runBackup({ env: ENV, run: f.run, inventory: fakeInv(), log: (m) => lines.push(String(m)) });
  const all = lines.join("\n");
  assert.ok(all.length > 0, t("B11: 로그가 하나도 없다 — 검사가 아무것도 안 재고 있다"));
  for (const bad of [KEY, "CREATE TABLE", "INSERT INTO", "users"])
    assert.ok(!all.includes(bad), t(`B11: 로그에 "${bad}" 가 실렸다`));
}

// ══ B12. 평문 덤프를 남기지 않는다 ══
{
  const before = new Set(await readdir(tmpdir()));
  const f = fakeRun();
  await runBackup({ env: ENV, run: f.run, inventory: fakeInv() });
  const after = (await readdir(tmpdir())).filter((x) => x.startsWith("shhh-backup-") && !before.has(x));
  assert.deepEqual(after, [], t(`B12: 임시 덤프 폴더가 ${after.length}개 남았다`));
}

await rm(tmp, { recursive: true, force: true });
console.log(`test-backup: ${n}개 통과 — 설정 부재 fail-closed · 반쪽 백업 금지 · 필수 표 검증 · `
  + `업로드 검증 뒤에만 ready · inventory 실패는 백업 실패 · dry-run 원격 쓰기 0 · `
  + `자동 복원·자동 migration 경로 0 · 게이트(없음/낡음/못 읽음) · SQL 값 고정 · 로그·임시파일`);
