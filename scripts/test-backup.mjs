// migration 직전 백업 — **fail-closed 전수 검사** (2026-08-26 · H1)
//
// 재는 것은 하나다: **백업이 확실히 성공하지 않은 모든 경우에 migration 이 막히는가.**
// 반대 방향(성공 경로)도 함께 잰다 — 막는 쪽만 재면 「영영 안 되는」 회귀를 못 잡는다.
//
// ⛔ **원격에 한 글자도 쓰지 않는다.** 외부 명령 실행기와 inventory 를 전부 가짜로 끼운다.
//    실제 `wrangler` 는 이 스위트에서 한 번도 실행되지 않는다(호출 목록으로 확인한다).
import assert from "node:assert";
import { mkdtemp, writeFile, readFile, rm, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runBackup, backupGate, readConfig, sqlValue, REQUIRED_TABLES, REQUIRED_INDEXES, NEXT,
  BACKUP_TTL_DAYS, GATE_MAX_AGE, objectKeyFor, canTransition, reconcile,
  OVERDUE_GRACE, absentEvidence, verifyBackup, keyFingerprint, VERIFY_VERSION,
  makeInventory, decryptBundle, loadTemp, BUNDLE_SEP, MAX_VERIFY_BYTES,
} from "./backup.mjs";

let n = 0;
const t = (m) => { n++; return m; };
const KEY = Buffer.alloc(32, 7).toString("base64");

// **실제로 SQLite 에 실리는 덤프여야 한다.** 검증이 임시 DB 에 싣기 때문이다 —
// 표 이름만 문자열로 맞춰 두면 「적재해 봤다」가 재지 못한다.
const dump = (which, { drop = null } = {}) => [
  ...REQUIRED_TABLES[which].filter((x) => x !== drop)
    .map((x) => `CREATE TABLE ${x} (a);\nINSERT INTO ${x} VALUES (1);`),
  ...REQUIRED_INDEXES[which].filter((x) => x !== drop)
    .map((x, i) => `CREATE INDEX ${x} ON ${REQUIRED_TABLES[which][i]}(a);`),
].join("\n");

// 가짜 inventory. 상태 전이를 **표대로** 강제한다 — 코드가 순서를 건너뛰면 여기서 걸린다.
function fakeInv(opts = {}) {
  const rows = new Map();
  for (const r of opts.list || []) rows.set(r.backup_id, { ...r });
  const calls = [];
  const guard = (name) => { if (opts.failOn === name) throw new Error("inventory down"); };
  const move = (id, to) => {
    const r = rows.get(id);
    assert.ok(r, `없는 행을 옮긴다: ${id}`);
    assert.ok(canTransition(r.status, to), `전이 위반: ${r.status} → ${to}`);
    r.status = to;
    return r;
  };
  return {
    rows, calls,
    async insertPending(id, at, epoch, fp) { guard("insert"); calls.push("insert");
      rows.set(id, { backup_id: id, status: "pending", snapshot_at: at,
                     maintenance_epoch: epoch, key_fingerprint: fp }); },
    async getRow(id) { guard("row"); calls.push("row");
      const r = rows.get(id); return r ? { ...r } : null; },
    async setVerified(id, at, v) { guard("verified"); calls.push("verified");
      const r = rows.get(id);
      assert.ok(r && r.status === "ready", `ready 가 아닌 행에 영수증을 적는다: ${id}`);
      r.verified_at = at; r.verify_version = v; },
    async setUploaded(id, m, l, k, exp, bytes, hash) { guard("uploaded"); calls.push("uploaded");
      Object.assign(move(id, "uploaded"), { main_db_hash: m, ledger_db_hash: l, object_key: k,
        expires_expected_at: exp, object_bytes: bytes, object_hash: hash }); },
    async setReady(id) { guard("ready"); calls.push("ready"); move(id, "ready"); },
    async fail(id, code) { calls.push("fail:" + code);
      const r = rows.get(id); if (r && canTransition(r.status, "failed")) {
        r.status = "failed"; r.last_error_code = code; } },
    async abort(id, code) { calls.push("abort:" + code);
      const r = rows.get(id); if (r && canTransition(r.status, "aborted")) {
        r.status = "aborted"; r.last_error_code = code; } },
    // ── reconcile 이 쓰는 자리 ──
    async openRows() { guard("list"); calls.push("list");
      return [...rows.values()].filter((r) => !r.deleted_at && r.status !== "aborted"
                                              && r.status !== "deleted"); },
    async markChecked(id, at) { calls.push("checked"); rows.get(id).deletion_checked_at = at; },
    async markGone(id, at, to) { calls.push("gone:" + to);
      Object.assign(move(id, to), { deleted_at: to === "deleted" ? at : undefined,
                                    deletion_checked_at: at }); },
  };
}

// 가짜 실행기. **실제로 파일을 만든다** — 「export 는 성공했는데 파일이 없다」를 재려면
// 파일 유무가 진짜여야 한다.
function fakeRun({ fail = {}, emptyMain = false, missingTable = null, noFile = false,
                   quiet = {}, objects = null, r2Down = false, tamperOnGet = false,
                   breakEncrypt = false, putMap = null } = {}) {
  const calls = [];
  const store = objects;                       // null 이면 「이번 실행에서 올린 것만 있다」
  const put = putMap || new Map();
  const maint = { mode: "maintenance", epoch: 7, drained_at: 1, pending_transition: null,
                  ...(quiet.maintenance || {}) };
  const leases = quiet.leases === undefined ? 0 : quiet.leases;
  const fence = quiet.fence === undefined ? 7 : quiet.fence;
  return {
    calls, put,
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      const kind = args[1] === "d1" && args[2] === "export" ? "export"
        : args[1] === "d1" ? "d1"
        : args[1] === "r2" && args[3] === "put" ? "put"
        : args[1] === "r2" ? "get" : "?";
      if (kind === "d1") {
        const sql = args[args.indexOf("--command") + 1];
        const table = /write_leases/.test(sql) ? "write_leases"
          : /write_fence/.test(sql) ? "write_fence"
          : /FROM maintenance/.test(sql) ? "maintenance" : "backups";
        if (quiet.d1Fail === table) return { code: 1, out: "", err: "" };
        const results = table === "write_leases" ? [{ n: leases }]
          : table === "write_fence" ? [{ epoch: fence }]
          : table === "maintenance" ? [maint] : [];
        return { code: 0, out: JSON.stringify([{ results }]), err: "" };
      }
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
        // 암호화 단계의 실패를 **진짜로** 만든다: 두 번째 export 뒤에 첫 덤프를 지운다.
        if (breakEncrypt && which === "ledger")
          await unlink(path.join(path.dirname(out), "main.sql")).catch(() => {});
        return { code: 0, out: "", err: "" };
      }
      const key = String(args[4] || "").split("/").slice(1).join("/");
      if (kind === "put") {
        if (fail.upload) return { code: 1, out: "", err: "" };
        const src = args[args.indexOf("--file") + 1];
        put.set(key, await readFile(src));
        return { code: 0, out: "", err: "" };
      }
      // get — **반드시 --file 로 받는다**(stdout 버퍼링 금지).
      if (r2Down) return { code: 1, out: "",
        err: typeof r2Down === "string" ? r2Down : "network unreachable" };
      if (fail.upload_verify) return { code: 1, out: "", err: "network unreachable" };
      const dst = args[args.indexOf("--file") + 1];
      if (store) {
        const meta = store[key];
        if (!meta) return { code: 1, out: "", err: "The specified key does not exist (10007)" };
        // 크기·해시를 흉내낸다: 내용은 안 쓰고 메타만 맞춘다.
        await writeFile(dst, Buffer.alloc(meta.bytes, 1));
        return { code: 0, out: "", err: "" };
      }
      if (!put.has(key)) return { code: 1, out: "", err: "The specified key does not exist (10007)" };
      const body = put.get(key);
      await writeFile(dst, tamperOnGet ? Buffer.concat([body, Buffer.from("X")]) : body);
      return { code: 0, out: "", err: "" };
    },
  };
}

const tmp = await mkdtemp(path.join(tmpdir(), "shhh-bk-test-"));
const keyFile = path.join(tmp, "key");
await writeFile(keyFile, KEY);
// **다른 키.** 「키를 갈아 끼운 뒤 옛 백업을 복원 가능이라 부르는」 경우를 재려면 필요하다.
const otherKeyFile = path.join(tmp, "key2");
await writeFile(otherKeyFile, Buffer.alloc(32, 9).toString("base64"));
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
  // ⚠️ **`aborted` 다**(2026-08-27 · K2). 업로드 명령을 한 번도 안 냈으므로 객체가 없다는
  //    것을 우리가 안다 — `failed`(모른다)로 적으면 이 행이 영영 표식 정리를 막는다.
  assert.equal(inv.rows.get(r.backupId).status, "aborted", t(`B2: ${which} 실패가 기록되지 않았다`));
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
    // ⚠️ 정지 확인 질의(읽기 3건)는 이 앞이다. 재는 것은 **export·업로드**가 없었나다.
    assert.ok(!f.calls.some((c) => /d1 export|r2 /.test(c)),
      t("B5: pending 을 못 적었는데 export 를 진행했다"));
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
  // ⚠️ 정지 확인은 dry-run 에서도 돈다 — **읽기**이기 때문이다. 쓰기가 0건인지를 잰다.
  const sql = f.calls.filter((c) => c.includes("--command"));
  assert.ok(sql.length > 0, t("B7: dry-run 이 정지 확인조차 안 했다"));
  assert.ok(sql.every((c) => !/INSERT|UPDATE|DELETE|DROP|ALTER/i.test(c)),
    t("B7: dry-run 이 원격에 쓰는 SQL 을 던졌다"));
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

// ══ B9. 게이트 — **지정한 백업 하나**를 실제로 검증한다 ══
//
// 옛 게이트는 `status='ready'` 중 가장 최근 것을 골라 **나이만** 봤다. 그래서 R2 객체가
// 없어도, 키가 사라져도, 암호문이 망가져도, 이전 유지보수 세대의 사본이어도 통과했다.
{
  const now = Date.now();
  const put = new Map();
  const inv = fakeInv();
  const F = fakeRun({ putMap: put });
  const made = await runBackup({ env: ENV, now, run: F.run, inventory: inv, log: () => {} });
  assert.equal(made.ok, true, t("B9: 준비용 백업이 실패했다"));

  // ── a. **backup_id 없이는 시작조차 안 한다.**
  const noId = await backupGate({ env: ENV, now, run: F.run, inventory: inv });
  assert.equal(noId.ok, false, t("B9-a: ★ backup_id 없이 게이트가 열렸다 — 「가장 최근」을 골랐다"));
  assert.equal(noId.code, "no_backup_id", t(`B9-a: 사유가 ${noId.code} 다`));

  // ── b. 양성 대조 — 방금 만든 그 백업은 통과하고, 영수증이 남는다.
  const ok = await backupGate({ env: ENV, now, run: F.run, inventory: inv, backupId: made.backupId });
  assert.equal(ok.ok, true, t(`B9-b: 정상 백업을 막았다 (${ok.code})`));
  assert.equal(ok.receipt.backupId, made.backupId, t("B9-b: 영수증의 backup_id 가 다르다"));
  assert.equal(ok.receipt.verifyVersion, VERIFY_VERSION, t("B9-b: 영수증에 검증 판이 없다"));
  assert.equal(ok.receipt.keyFingerprint, keyFingerprint(Buffer.from(KEY, "base64")),
    t("B9-b: 영수증의 키 지문이 다르다"));
  assert.equal(inv.rows.get(made.backupId).verified_at, now, t("B9-b: 영수증이 기록되지 않았다"));
  // ⛔ 영수증에 비밀값이 없다.
  assert.doesNotMatch(JSON.stringify(ok.receipt), new RegExp(KEY.slice(0, 20)),
    t("B9-b: ★ 영수증에 키가 실렸다"));

  // ── c. 각 실패 조건에서 **막힌다.**
  const cases = [
    ["없는 backup_id", { backupId: "f".repeat(32) }, "no_row"],
    ["R2 객체가 없다", { run: fakeRun({ objects: {} }).run }, "object_absent"],
    ["R2 가 답을 못 한다", { run: fakeRun({ putMap: put, r2Down: "network unreachable" }).run },
      "object_unknown"],
    ["크기가 다르다", { patch: (r) => { r.object_bytes = Number(r.object_bytes) + 1; } }, "size_mismatch"],
    ["암호문 해시가 다르다", { patch: (r) => { r.object_hash = "a".repeat(64); } }, "hash_mismatch"],
    ["암호문이 손상됐다", { run: fakeRun({ putMap: put, tamperOnGet: true }).run }, "size_mismatch"],
    ["키 파일이 없다", { env: { ...ENV, BACKUP_KEY_FILE: path.join(tmp, "no-such-key") } }, "key"],
    ["키가 갈렸다", { env: { ...ENV, BACKUP_KEY_FILE: otherKeyFile } }, "key_rotated"],
    ["내부 main 해시가 다르다", { patch: (r) => { r.main_db_hash = "b".repeat(64); } }, "inventory_hash"],
    ["세대가 다르다", { run: fakeRun({ putMap: put, quiet: { maintenance: { epoch: 9 }, fence: 9 } }).run },
      "epoch"],
    ["멈춘 상태가 아니다", { run: fakeRun({ putMap: put, quiet: { maintenance: { mode: "open" } } }).run },
      "quiescence"],
    ["너무 오래됐다", { at: now + GATE_MAX_AGE + 1 }, "stale"],
  ];
  for (const [label, opt, code] of cases) {
    const row = inv.rows.get(made.backupId);
    const before = { ...row };
    if (opt.patch) opt.patch(row);
    const r = await backupGate({ env: opt.env || ENV, now: opt.at || now,
                                 run: opt.run || F.run, inventory: inv,
                                 backupId: opt.backupId || made.backupId });
    Object.assign(row, before);
    assert.equal(r.ok, false, t(`B9-c: ★ ${label} 인데 게이트가 열렸다 — migration 이 진행된다`));
    assert.equal(r.code, code, t(`B9-c: ${label} 의 사유가 ${r.code} 다 (${code} 여야 한다)`));
  }

  // ── d. 상태가 `ready` 가 아니면 막는다.
  for (const st of ["pending", "uploaded", "failed"]) {
    const row = inv.rows.get(made.backupId);
    const was = row.status; row.status = st;
    const r = await backupGate({ env: ENV, now, run: F.run, inventory: inv, backupId: made.backupId });
    row.status = was;
    assert.equal(r.ok, false, t(`B9-d: ★ ${st} 상태인데 게이트가 열렸다`));
    assert.equal(r.code, "not_ready", t(`B9-d: ${st} 의 사유가 ${r.code} 다`));
  }

  // ── e. 설정 부재.
  const { miss } = readConfig({});
  assert.ok(miss.length >= 4, t("B9-e: 설정 부재를 못 센다"));
  assert.equal((await backupGate({ env: {}, now, backupId: made.backupId })).code, "config",
    t("B9-e: 설정이 없는데 게이트가 통과했다"));

  // ── f. inventory 를 못 읽으면 **막는다**(모름은 허가가 아니다).
  const downInv = fakeInv({ failOn: "row" });
  const down = await backupGate({ env: ENV, now, run: F.run, inventory: downInv,
                                  backupId: made.backupId });
  assert.equal(down.ok, false, t("B9-f: ★ inventory 를 못 읽었는데 게이트가 열렸다"));
  assert.equal(down.code, "unreadable", t(`B9-f: 사유가 ${down.code} 다`));
}

// ══ B22. 안에 든 것이 실제로 실리는가 — 임시 SQLite 적재 ══
// 「크기와 해시가 맞다」는 **그 바이트가 그대로 있다**는 말일 뿐, 그 안에 DB 가 들어 있다는
// 말이 아니다. 표가 빠진 덤프도 크기·해시는 완벽하게 맞는다.
{
  const now = Date.now();
  // 필수 표 하나가 빠진 덤프로 진짜 백업을 만든다 — `runBackup` 의 검증을 우회해야 하므로
  // 번들을 **여기서 직접 만들어** R2 에 올려 두고 inventory 행을 맞춘다.
  const craft = async (mainSql, ledgerSql) => {
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const id = randomBytes(16).toString("hex");
    const mainB = Buffer.from(mainSql), ledgerB = Buffer.from(ledgerSql);
    const mh = createHash("sha256").update(mainB).digest("hex");
    const lh = createHash("sha256").update(ledgerB).digest("hex");
    const bundle = Buffer.concat([
      Buffer.from(JSON.stringify({ v: 1, id, snapshot_at: now, main: mh, ledger: lh }) + "\n"),
      mainB, Buffer.from(BUNDLE_SEP), ledgerB]);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), iv);
    const enc = Buffer.concat([iv, c.update(bundle), c.final(), c.getAuthTag()]);
    const key = objectKeyFor(id);
    const put = new Map([[key, enc]]);
    const inv = fakeInv({ list: [{ backup_id: id, status: "ready", snapshot_at: now,
      object_key: key, object_bytes: enc.length,
      object_hash: createHash("sha256").update(enc).digest("hex"),
      main_db_hash: mh, ledger_db_hash: lh, maintenance_epoch: 7,
      key_fingerprint: keyFingerprint(Buffer.from(KEY, "base64")) }] });
    return { id, inv, run: fakeRun({ putMap: put }).run };
  };

  // ── a. 양성 대조 — 온전한 덤프는 실린다.
  {
    const c = await craft(dump("main"), dump("ledger"));
    const r = await verifyBackup({ backupId: c.id, env: ENV, now, run: c.run, inventory: c.inv });
    assert.equal(r.ok, true, t(`B22-a: 온전한 백업을 거부했다 (${r.code} ${r.missing || ""})`));
  }
  // ── b. 표가 빠진 덤프는 크기·해시가 맞아도 거부된다.
  for (const [which, drop] of [["main", "policy_events"], ["ledger", "transitions"],
                               ["ledger", "lease_resolutions"]]) {
    const c = await craft(which === "main" ? dump("main", { drop }) : dump("main"),
                          which === "ledger" ? dump("ledger", { drop }) : dump("ledger"));
    const r = await verifyBackup({ backupId: c.id, env: ENV, now, run: c.run, inventory: c.inv });
    assert.equal(r.ok, false, t(`B22-b: ★ ${which} 에 ${drop} 이 없는데 통과했다`));
    assert.equal(r.code, "load_" + which, t(`B22-b: ${drop} 의 사유가 ${r.code} 다`));
    assert.equal(r.missing, drop, t(`B22-b: 빠진 것이 ${r.missing} 라고 한다`));
  }
  // ── c. 인덱스가 빠져도 거부된다(유일성이 사라진 사본이다).
  {
    const c = await craft(dump("main", { drop: "invite_codes_active" }), dump("ledger"));
    const r = await verifyBackup({ backupId: c.id, env: ENV, now, run: c.run, inventory: c.inv });
    assert.equal(r.ok, false, t("B22-c: ★ 부분 유니크 인덱스가 없는 사본을 통과시켰다"));
  }
  // ── d. SQL 이 아예 안 실리는 경우.
  {
    const c = await craft("this is not sql;", dump("ledger"));
    const r = await verifyBackup({ backupId: c.id, env: ENV, now, run: c.run, inventory: c.inv });
    assert.equal(r.ok, false, t("B22-d: ★ 실리지도 않는 덤프를 통과시켰다"));
    assert.equal(r.missing, "load", t(`B22-d: 사유가 ${r.missing} 다`));
  }
  // ── e. manifest 의 id 를 바꾼 사본은 거부된다(다른 백업의 객체를 끼워 넣는 길).
  {
    const c = await craft(dump("main"), dump("ledger"));
    const other = await craft(dump("main"), dump("ledger"));
    // other 의 행에 c 의 객체 크기·해시를 그대로 적어도, 안쪽 id 가 달라 걸린다.
    const r = await verifyBackup({ backupId: other.id, env: ENV, now, run: c.run,
                                   inventory: other.inv });
    assert.equal(r.ok, false, t("B22-e: ★ 다른 백업의 객체를 끼워 넣었는데 통과했다"));
  }
  // ── g. **크기·해시는 맞는데 복호화가 실패하는** 사본. 이 갈래가 없으면 「태그를 봤다」를
  //    아무도 재지 않는다(돌연변이 M132 가 처음에 살아남았다 — B9-c 의 손상 사본은 길이가
  //    달라져 **크기 검사에서 먼저** 걸렸다).
  {
    const c = await craft(dump("main"), dump("ledger"));
    const row = c.inv.rows.get(c.id);
    const key = row.object_key;
    // 길이를 유지한 채 암호문 한 바이트를 뒤집고, **바뀐 바이트의 해시를 기록에 적는다.**
    const store = new Map();
    const orig = await (async () => {
      const tmpd = await mkdtemp(path.join(tmpdir(), "shhh-flip-"));
      const f = path.join(tmpd, "o");
      await c.run("npx", ["wrangler", "r2", "object", "get", `x/${key}`, "--file", f, "--remote"]);
      const b = await readFile(f); await rm(tmpd, { recursive: true, force: true }); return b;
    })();
    const flipped = Buffer.from(orig);
    flipped[20] ^= 0xff;                       // 태그도 nonce 도 아닌 본문 한 바이트
    store.set(key, flipped);
    row.object_bytes = flipped.length;
    row.object_hash = createHash("sha256").update(flipped).digest("hex");
    const r = await verifyBackup({ backupId: c.id, env: ENV, now,
                                   run: fakeRun({ putMap: store }).run, inventory: c.inv });
    assert.equal(r.ok, false, t("B22-g: ★ 크기·해시만 맞으면 열리지도 않는 사본을 통과시켰다"));
    assert.equal(r.code, "decrypt", t(`B22-g: 사유가 ${r.code} 다`));
  }

  // ── f. 한도. 기록된 크기가 한도를 넘으면 받아 보지도 않는다.
  {
    const c = await craft(dump("main"), dump("ledger"));
    c.inv.rows.get(c.id).object_bytes = MAX_VERIFY_BYTES + 1;
    const r = await verifyBackup({ backupId: c.id, env: ENV, now, run: c.run, inventory: c.inv });
    assert.equal(r.code, "too_large", t(`B22-f: 큰 객체의 사유가 ${r.code} 다`));
  }
}

// ══ B23. 상태를 바꾸는 문장은 **정확히 한 행**을 바꾼다 ══
// 종료 코드 0 은 「문장이 돌았다」이지 「그 행이 바뀌었다」가 아니다. 0행을 성공으로 읽으면
// 전이표를 SQL 에 넣어 둔 의미가 사라진다.
{
  const mk = (changes) => makeInventory({ ledgerDb: "shhh-ledger" },
    async () => ({ code: 0, out: JSON.stringify([{ results: [], meta: { changes } }]), err: "" }));
  const id = "a".repeat(32), h = "b".repeat(64);
  for (const changes of [0, 2]) {
    const inv = mk(changes);
    await assert.rejects(() => inv.setReady(id),
      t(`B23: ★ ${changes}행을 바꾼 setReady 가 성공으로 끝났다`));
    await assert.rejects(() => inv.setUploaded(id, h, h, "shhh/x.enc", 1, 2, h),
      t(`B23: ★ ${changes}행을 바꾼 setUploaded 가 성공으로 끝났다`));
    await assert.rejects(() => inv.insertPending(id, 1, 7, "0".repeat(16)),
      t(`B23: ★ ${changes}행을 바꾼 insertPending 이 성공으로 끝났다`));
    await assert.rejects(() => inv.setVerified(id, 1, VERIFY_VERSION),
      t(`B23: ★ ${changes}행을 바꾼 setVerified 가 성공으로 끝났다`));
  }
  // 양성 대조.
  await mk(1).setReady(id);
  // `meta` 가 아예 없으면 **모른다** — 성공으로 읽지 않는다.
  const blind = makeInventory({ ledgerDb: "l" },
    async () => ({ code: 0, out: JSON.stringify([{ results: [] }]), err: "" }));
  await assert.rejects(() => blind.setReady(id), t("B23: ★ changes 를 모르는데 성공으로 끝났다"));
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

// ══ B13. **정지(quiescence)를 확인하지 않으면 export 를 시작하지 않는다** ══
//
// 왜: 두 DB 를 각각 내보내는 사이에 쓰기가 계속 들어오면, 백업 안에서 주 D1 과 ledger 가
// **서로 다른 시점**을 가리킨다. 그 사본으로 복원하면 「지웠다는 표식은 있는데 계정은 살아
// 있는」 또는 그 반대의 상태가 만들어진다. 그래서 export **전에** 넷을 확인한다:
//   ① 모드가 `open` 이 아니다  ② 진행 중인 전환이 없다  ③ 지금 epoch 의 drain 증거가 있다
//   ④ 살아 있는 임차증이 0건   ⑤ 주 D1 fence 와 ledger epoch 이 같다
// ⛔ **하나라도 모르면 시작하지 않는다.** 「질의가 실패했다」는 「멈췄다」가 아니다.
{
  const cases = [
    ["열려 있다", { maintenance: { mode: "open" } }],
    ["전환이 진행 중이다", { maintenance: { pending_transition: "tr-1" } }],
    ["drain 증거가 없다", { maintenance: { drained_at: null } }],
    ["임차증이 살아 있다", { leases: 1 }],
    ["주 D1 fence 가 어긋났다", { fence: 99 }],
    ["ledger 질의가 실패한다", { d1Fail: "maintenance" }],
    ["주 D1 질의가 실패한다", { d1Fail: "write_fence" }],
    ["임차증 질의가 실패한다", { d1Fail: "write_leases" }],
  ];
  for (const [label, q] of cases) {
    const f = fakeRun({ quiet: q });
    const inv = fakeInv();
    const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
    assert.equal(r.ok, false, t(`B13: ${label} 인데 백업이 성공이라 한다`));
    assert.equal(r.code, "quiescence", t(`B13: ${label} 의 사유가 quiescence 가 아니다 (${r.code})`));
    assert.ok(!f.calls.some((c) => c.includes("d1 export")),
      t(`B13: ${label} 인데 export 를 시작했다 — 정지 확인이 export 뒤에 있다`));
    assert.ok(!f.calls.some((c) => c.includes("r2")), t(`B13: ${label} 인데 R2 를 건드렸다`));
    assert.equal(inv.calls.length, 0, t(`B13: ${label} 인데 inventory 에 행을 만들었다`));
  }
  // 양성 대조 — 다섯이 전부 맞으면 진행한다.
  const f = fakeRun();
  const r = await runBackup({ env: ENV, run: f.run, inventory: fakeInv() });
  assert.equal(r.ok, true, t("B13: 정지 조건이 전부 맞는데도 막았다 — 영영 백업이 안 된다"));
}

// ══ B14. **업로드 전 실패는 `aborted`, 결과가 불확실하면 `failed`** ══
//
// `failed` 는 「객체가 있는지 모른다」라 삭제 표식 정리를 **영영 막는다**. 업로드 명령을
// 한 번도 실행하지 않은 실패까지 `failed` 로 적으면, 그 행이 쌓여 보유기간이 사실상 무한이 된다.
{
  for (const [label, opt, step] of [
    ["main export 실패", { fail: { main_export: true } }, "main_export"],
    ["ledger export 실패", { fail: { ledger_export: true } }, "ledger_export"],
    ["빈 덤프", { emptyMain: true }, "verify"],
    ["필수 표 누락", { missingTable: ["main", "users"] }, "verify"],
    ["암호화 실패", { breakEncrypt: true }, "encrypt"],
  ]) {
    const f = fakeRun(opt);
    const inv = fakeInv();
    const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
    assert.equal(r.ok, false, t(`B14: ${label} 인데 성공이라 한다`));
    // ⚠️ **어느 단계에서 멈췄는지도 잰다.** 안 재면 다른 이유로 실패해도 이 검사가 통과한다
    //    (「암호화 실패」가 실제로는 export 검증에서 걸리는 식으로).
    assert.equal(r.step, step, t(`B14: ${label} 이 ${r.step} 단계에서 멈췄다`));
    assert.ok(!f.calls.some((c) => c.includes("r2 object put")),
      t(`B14: ${label} 인데 업로드를 실행했다 — 「부재를 증명했다」가 거짓이 된다`));
    assert.equal(inv.rows.get(r.backupId).status, "aborted",
      t(`B14: ${label} 은 업로드 전 확실한 실패인데 ${inv.rows.get(r.backupId).status} 로 적었다`));
  }
  // 반대: 업로드 명령이 실패하면 **객체가 생겼는지 모른다** → 계속 막는다.
  for (const [label, opt] of [
    ["업로드 명령 실패", { fail: { upload: true } }],
    ["업로드 검증 실패", { fail: { upload_verify: true } }],
    ["업로드 뒤 inventory 실패", { }],
  ]) {
    const f = fakeRun(opt);
    const inv = fakeInv(label.includes("inventory") ? { failOn: "uploaded" } : {});
    const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
    assert.equal(r.ok, false, t(`B14: ${label} 인데 성공이라 한다`));
    assert.equal(inv.rows.get(r.backupId).status, "failed",
      t(`B14: ${label} 은 결과가 불확실한데 ${inv.rows.get(r.backupId).status} 로 적었다`));
  }
}

// ══ B15. 객체 키는 **결정적으로 재구성**되고, 암호문 크기·해시를 검증한다 ══
{
  assert.equal(objectKeyFor("0".repeat(32)), `shhh/${"0".repeat(32)}.enc`,
    t("B15: 객체 키를 재구성할 수 없다"));
  const f = fakeRun();
  const inv = fakeInv();
  const r = await runBackup({ env: ENV, run: f.run, inventory: inv });
  const row = inv.rows.get(r.backupId);
  assert.equal(row.object_key, objectKeyFor(r.backupId), t("B15: 기록된 키가 재구성 값과 다르다"));
  assert.ok(row.object_bytes > 0, t("B15: 암호문 크기를 기록하지 않았다"));
  assert.ok(/^[0-9a-f]{64}$/.test(row.object_hash || ""), t("B15: 암호문 해시를 기록하지 않았다"));
  // ⛔ 객체를 stdout 으로 받지 않는다 — 통째로 문자열에 담으면 큰 백업에서 그대로 죽는다.
  const get = f.calls.find((c) => c.includes("r2 object get"));
  assert.ok(get && get.includes("--file"), t("B15: 객체를 --file 없이 받는다(stdout 버퍼링)"));
  assert.ok(!get.includes("--pipe"), t("B15: 객체를 파이프로 받는다"));
  // 내려받은 것이 올린 것과 다르면 실패다.
  const f2 = fakeRun({ tamperOnGet: true });
  const inv2 = fakeInv();
  const r2 = await runBackup({ env: ENV, run: f2.run, inventory: inv2 });
  assert.equal(r2.ok, false, t("B15: 내려받은 객체가 다른데 성공이라 한다"));
  assert.equal(inv2.rows.get(r2.backupId).status, "failed", t("B15: 변조 확인이 failed 가 아니다"));
}

// ══ B16. 전이표는 **한 방향**이고 코드가 그것을 강제한다 ══
{
  assert.ok(canTransition("pending", "aborted"), t("B16: pending → aborted 가 막혔다"));
  assert.ok(canTransition("ready", "deleted"), t("B16: ready → deleted 가 막혔다"));
  assert.ok(canTransition("failed", "deleted"), t("B16: failed → deleted 가 막혔다 — 부재를 확인해도 못 닫는다"));
  for (const [a, b] of [["deleted", "ready"], ["aborted", "ready"], ["ready", "pending"],
                        ["deleted", "failed"], ["aborted", "deleted"]])
    assert.ok(!canTransition(a, b), t(`B16: ${a} → ${b} 가 허용된다 — 종결 상태가 되살아난다`));
  for (const k of Object.keys(NEXT))
    for (const v of NEXT[k])
      assert.ok(Object.prototype.hasOwnProperty.call(NEXT, v), t(`B16: ${k} → ${v} 가 표에 없는 상태다`));
}

// ══ B17. reconcile — **실제 부재를 확인한 뒤에만** 닫는다 ══
{
  const now = Date.now();
  // 가짜 R2 는 `Buffer.alloc(bytes, 1)` 을 돌려준다 — inventory 에 적는 해시도 그 값이어야
  // 「같다/다르다」가 실제로 재어진다(아무 문자열이나 적으면 늘 「다르다」가 된다).
  const H = (b) => createHash("sha256").update(Buffer.alloc(b, 1)).digest("hex");
  const A = "a".repeat(32);
  const mk = (over) => ([
    { backup_id: A, status: "ready", snapshot_at: now - 8 * 86400e3,
      object_key: objectKeyFor(A), object_bytes: 10, object_hash: H(10),
      expires_expected_at: now - (over ? OVERDUE_GRACE + 1 : -86400e3) },
  ]);
  // ① 객체가 아직 있다 → 아무것도 닫지 않는다.
  {
    const f = fakeRun({ objects: { [objectKeyFor(A)]: { bytes: 10 } } });
    const inv = fakeInv({ list: mk(false) });
    const r = await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    assert.equal(inv.rows.get(A).status, "ready", t("B17-①: 객체가 있는데 닫았다"));
    assert.ok(inv.rows.get(A).deletion_checked_at, t("B17-①: 확인 시각을 안 적었다"));
    assert.equal(r.ok, true, t("B17-①: 정상인데 실패라 한다"));
  }
  // ② 객체가 없다 → `deleted` + `deleted_at`.
  {
    const f = fakeRun({ objects: {} });
    const inv = fakeInv({ list: mk(false) });
    const r = await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    const row = inv.rows.get(A);
    assert.equal(row.status, "deleted", t("B17-②: 부재를 확인했는데 안 닫았다"));
    assert.equal(row.deleted_at, now, t("B17-②: deleted_at 을 안 적었다"));
    assert.equal(r.ok, true, t("B17-②: 정상 종결인데 실패라 한다"));
  }
  // ③ **조회가 실패한다 → 모른다. 닫지 않고 0이 아닌 코드로 끝난다.**
  {
    const f = fakeRun({ r2Down: true });
    const inv = fakeInv({ list: mk(false) });
    const r = await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    assert.equal(inv.rows.get(A).status, "ready", t("B17-③: ★ 조회 실패인데 닫았다"));
    assert.ok(!inv.rows.get(A).deleted_at, t("B17-③: ★ 조회 실패인데 deleted_at 을 적었다"));
    assert.equal(r.ok, false, t("B17-③: 모르는 채로 끝났는데 성공이라 한다"));
    assert.equal(r.unknown, 1, t("B17-③: 모르는 건수를 안 센다"));
  }
  // ④ 만료 예정 시각이 한참 지났는데 **아직 있다** → 비정상. 경보한다.
  {
    const f = fakeRun({ objects: { [objectKeyFor(A)]: { bytes: 10 } } });
    const inv = fakeInv({ list: mk(true) });
    const r = await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    assert.equal(r.ok, false, t("B17-④: 만료가 한참 지났는데 아직 있는 것을 정상이라 한다"));
    assert.equal(r.overdue, 1, t("B17-④: overdue 를 안 센다"));
    assert.equal(inv.rows.get(A).status, "ready", t("B17-④: 경보 대상을 임의로 닫았다"));
  }
  // ⑤ 내용이 바뀌었다 → `failed`(계속 막는다). 조용히 정상 처리하지 않는다.
  {
    const f = fakeRun({ objects: { [objectKeyFor(A)]: { bytes: 11 } } });
    const inv = fakeInv({ list: mk(false) });
    const r = await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    assert.equal(inv.rows.get(A).status, "failed", t("B17-⑤: 변조된 객체를 정상으로 봤다"));
    assert.equal(r.ok, false, t("B17-⑤: 변조를 정상 종료로 답한다"));
  }
  // ⑥ **반복해서 돌려도 결과가 같다**(멱등).
  {
    const f = fakeRun({ objects: {} });
    const inv = fakeInv({ list: mk(false) });
    await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    const first = { ...inv.rows.get(A) };
    await reconcile({ env: ENV, run: f.run, inventory: inv, now: now + 1000 });
    assert.deepEqual(inv.rows.get(A), first, t("B17-⑥: 다시 돌리니 결과가 바뀐다"));
  }
  // ⑦ `pending` 인데 객체가 없다 → `aborted`(막지 않는다). 있으면 계속 막는다.
  {
    const rows = [{ backup_id: "d".repeat(32), status: "pending", snapshot_at: now - 86400e3 }];
    const f = fakeRun({ objects: {} });
    const inv = fakeInv({ list: rows });
    await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    assert.equal(inv.rows.get("d".repeat(32)).status, "aborted", t("B17-⑦: pending + 부재가 안 닫힌다"));
    const f2 = fakeRun({ objects: { [objectKeyFor("d".repeat(32))]: { bytes: 5 } } });
    const inv2 = fakeInv({ list: rows });
    const r2 = await reconcile({ env: ENV, run: f2.run, inventory: inv2, now });
    assert.equal(inv2.rows.get("d".repeat(32)).status, "failed",
      t("B17-⑦: pending 인데 객체가 있다 — 계속 막아야 한다"));
    assert.equal(r2.ok, false, t("B17-⑦: 고아 객체를 정상이라 한다"));
  }
}

// ══ B18. reconcile 은 **복원하지 않는다** ══
{
  const f = fakeRun({ objects: {} });
  await reconcile({ env: ENV, run: f.run, inventory: fakeInv({ list: [] }), now: Date.now() });
  assert.ok(!f.calls.some((c) => /restore|d1 import|r2 object put/.test(c)),
    t("B18: reconcile 이 쓰기·복원 명령을 실행했다"));
}

// ══ B19. **부재의 증거는 객체 수준이어야 한다** (2026-08-27 · 독립 검토 #2) ══
//
// ⛔ 넓게 잡으면 「버킷이 없다」·「자격증명이 다른 계정이다」·일반 404 까지 부재의 증거가 된다.
//    그러면 설정 오타 하나로 살아 있는 백업 행이 전부 닫히고 **삭제 표식이 근거 없이 지워진다.**
{
  const ABSENT = [
    "The specified key does not exist. [code: 10007]",
    "no such key",
  ];
  const UNKNOWN = [
    "The specified bucket does not exist. [code: 10006]",
    "A request to the Cloudflare API failed. bucket not found [code: 10006]",
    "Received a malformed response from the API [code: 1000] status 404",
    "fetch failed: connect ETIMEDOUT",
    "Authentication error [code: 10000]",
    "",
  ];
  for (const m of ABSENT)
    assert.equal(absentEvidence(m), true, t(`B19: 진짜 부재를 못 읽는다: ${m.slice(0, 40)}`));
  for (const m of UNKNOWN)
    assert.equal(absentEvidence(m), false,
      t(`B19: ★ 부재가 아닌 것을 부재로 읽는다: ${m.slice(0, 48)}`));
}

// ══ B20. 버킷 수준 오류로는 **아무 행도 닫히지 않는다** ═══════════════════
{
  const now = Date.now();
  const A = "a".repeat(32);
  const rows = [{ backup_id: A, status: "ready", snapshot_at: now - 86400e3,
                  object_key: objectKeyFor(A), object_bytes: 10,
                  object_hash: createHash("sha256").update(Buffer.alloc(10, 1)).digest("hex"),
                  expires_expected_at: now + 86400e3 }];
  for (const err of ["The specified bucket does not exist. [code: 10006]",
                     "Authentication error [code: 10000]"]) {
    const f = fakeRun({ r2Down: err });
    const inv = fakeInv({ list: rows });
    const r = await reconcile({ env: ENV, run: f.run, inventory: inv, now });
    assert.equal(inv.rows.get(A).status, "ready",
      t(`B20: ★ 「${err.slice(0, 24)}」 로 백업 행을 닫았다`));
    assert.ok(!inv.rows.get(A).deleted_at, t("B20: ★ 부재를 확인하지 않고 deleted_at 을 적었다"));
    assert.equal(r.ok, false, t("B20: 모르는 채로 끝났는데 성공이라 한다"));
    assert.equal(r.unknown, 1, t("B20: 모르는 건수를 안 센다"));
  }
}

// ══ B21. **export 도중에 정지가 풀리면 올리지 않는다** (독립 검토 #3) ══════
//
// 정지 확인과 업로드 사이에 `d1 export` 가 **두 번** 돈다. 그 사이에 문이 다시 열리면
// 두 덤프가 서로 다른 시점을 담는데, 그것을 「검증된 백업」으로 기록하면 복구가 필요한 날
// 앞뒤가 안 맞는 사본을 믿게 된다.
{
  for (const [label, after] of [
    ["모드가 다시 열렸다", { maintenance: { mode: "open" } }],
    ["epoch 이 움직였다", { maintenance: { epoch: 9 }, fence: 9 }],
    ["임차증이 생겼다", { leases: 1 }],
  ]) {
    // 첫 확인은 통과하고, export 뒤의 두 번째 확인에서 달라지게 만든다.
    let asked = 0;
    const base = fakeRun();
    const late = fakeRun({ quiet: after });
    const run = async (cmd, args) => {
      if (args[1] === "d1" && args[2] !== "export" && args.includes("--command")) {
        asked++;
        return asked <= 3 ? base.run(cmd, args) : late.run(cmd, args);
      }
      return base.run(cmd, args);
    };
    const inv = fakeInv();
    const r = await runBackup({ env: ENV, run, inventory: inv });
    assert.equal(r.ok, false, t(`B21: ${label} 인데 백업이 성공이라 한다`));
    assert.equal(r.code, "quiescence", t(`B21: ${label} 의 사유가 ${r.code} 다`));
    assert.ok(!base.calls.concat(late.calls).some((c) => c.includes("r2 object put")),
      t(`B21: ${label} 인데 업로드했다`));
    assert.equal(inv.rows.get(r.backupId).status, "aborted",
      t(`B21: ${label} 은 업로드 전 실패인데 ${inv.rows.get(r.backupId).status} 로 적었다`));
  }
  // 양성 대조 — 계속 멈춰 있으면 성공한다.
  const f = fakeRun();
  assert.equal((await runBackup({ env: ENV, run: f.run, inventory: fakeInv() })).ok, true,
    t("B21: 계속 멈춰 있는데도 막았다"));
}

await rm(tmp, { recursive: true, force: true });
console.log(`test-backup: ${n}개 통과 — 설정 부재 fail-closed · 반쪽 백업 금지 · 필수 표 검증 · `
  + `업로드 검증 뒤에만 ready · inventory 실패는 백업 실패 · dry-run 원격 쓰기 0 · `
  + `자동 복원·자동 migration 경로 0 · 게이트(없음/낡음/못 읽음) · SQL 값 고정 · 로그·임시파일`);
