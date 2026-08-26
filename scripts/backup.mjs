// migration 직전 백업. **운영자가 손으로 부르는 도구다.**
//
// 왜 생겼나(2026-08-26 · H1): `privacy.html` 이 「구조를 바꾸기 직전에만 백업 사본을 만들고
// 7일 만료로 설정해 둔다」고 **현재형으로** 적고 있었는데, 그 일을 하는 코드가 한 줄도 없었다.
// 방침이 하는 약속에 구현이 없으면 그 문장은 적는 순간 거짓이다.
//
// 「자동」의 뜻(사용자 결정 2026-08-26):
//   ⭕ migration 실행 **직전에 한 명령으로** 백업·검증까지 끝난다
//   ⭕ 백업이 성공하지 않으면 migration 이 **실행되지 않는다**(`gate` 가 0이 아닌 코드로 끝난다)
//   ⛔ 매일 도는 정기 백업이 **아니다**
//   ⛔ 백업 성공이 migration 을 **자동 실행하지 않는다** — 승인은 사람이 따로 한다
//   ⛔ **자동 복원 경로를 만들지 않는다.** 이 파일에 restore 는 없고, 앞으로도 넣지 않는다
//
// ⚠️ **shell 을 쓰지 않는다.** 모든 외부 명령은 `spawn(cmd, args, { shell: false })` 이고
//    인자는 배열이다 — DB 이름·객체 키가 문자열 조합으로 셸에 닿는 자리가 없어야 한다.
// ⚠️ **로그에 개인정보·백업 내용·키를 찍지 않는다.** 남기는 것은 backup_id·상태·바이트 수뿐이다.
// ⚠️ **이번 세션에서는 실제 원격 작업을 하지 않았다.** `--dry-run` 만 돌렸다.
import { spawn } from "node:child_process";
import { createHash, randomBytes, createCipheriv } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── 두 DB 와 「그 안에 반드시 있어야 하는 표」 ────────────────────────────
// export 가 **성공했는데 비어 있는** 경우를 잡는 것이 이 목록의 일이다. wrangler 는 빈 덤프도
// 종료 코드 0 으로 끝낼 수 있고, 그 파일을 백업이라고 부르면 복구가 필요한 날 아무것도 없다.
export const REQUIRED_TABLES = {
  main: ["users", "sessions", "books", "friendships", "invite_codes",
         "policy_events", "consumed_signup_states", "write_fence"],
  ledger: ["deletions", "maintenance", "write_leases", "cleanup_runs",
           "deletion_keys", "rate_limits", "backups"],
};

// 상태 전이. **한 방향이다** — 되돌아가는 전이는 없다(되돌리려면 새 backup_id 로 다시 한다).
export const NEXT = {
  pending: ["uploaded", "aborted", "failed"],
  uploaded: ["ready", "failed"],
  ready: ["deleted"],
  aborted: [], deleted: [], failed: [],
};

// R2 lifecycle 만료까지. 방침이 적는 값과 같다.
export const BACKUP_TTL_DAYS = 7;
// `gate` 가 「방금 만든 백업」으로 인정하는 최대 나이. 어제 백업으로 오늘 migration 을 돌리면
// 그 사이의 쓰기가 복구 대상에서 빠진다.
export const GATE_MAX_AGE = 2 * 3600e3;

// ── 값 검증 — SQL 로 나가기 전에 모양을 고정한다 ─────────────────────────
// ⚠️ **정규식으로 SQL 을 고쳐 쓰지 않는다.** 여기서 하는 것은 그 반대다: 값이 정해진 모양이
//    아니면 **던진다.** 통과한 값만 문장에 들어가므로 주입할 자리가 남지 않는다.
//    (wrangler d1 execute 의 `--command` 는 바인드 파라미터를 받지 않는다.)
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/;
// 객체 키. **`..` 를 막는다** — SQL 주입은 아니지만 버킷 안에서 위로 올라가는 키를 만들 수
// 있고, 그런 키는 나중에 lifecycle 규칙(접두어 기준)을 조용히 빗나간다.
const KEYRE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export function sqlValue(v, kind) {
  if (v === null || v === undefined) return "NULL";
  if (kind === "id" && HEX32.test(v)) return `'${v}'`;
  if (kind === "hash" && HEX64.test(v)) return `'${v}'`;
  if (kind === "key" && KEYRE.test(v) && !String(v).includes("..")) return `'${v}'`;
  if (kind === "status" && Object.prototype.hasOwnProperty.call(NEXT, v)) return `'${v}'`;
  if (kind === "code" && /^[a-z_]{1,40}$/.test(v)) return `'${v}'`;
  if (kind === "int" && Number.isSafeInteger(v)) return String(v);
  throw new Error(`백업 inventory 에 넣을 수 없는 값이다 (${kind})`);
}

// ── 외부 명령 ────────────────────────────────────────────────────────────
// 기본 실행기. **셸을 거치지 않는다.** 테스트는 이 자리에 가짜를 끼운다.
export const realRunner = (cmd, args, { input } = {}) => new Promise((res) => {
  const p = spawn(cmd, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("error", (e) => res({ code: 127, out: "", err: String(e && e.message) }));
  p.on("close", (code) => res({ code, out, err }));
  if (input !== undefined) p.stdin.end(input); else p.stdin.end();
});

const sha256File = async (f) => createHash("sha256").update(await readFile(f)).digest("hex");

// ── 설정 ─────────────────────────────────────────────────────────────────
// ⛔ **원격 설정이 없으면 아무것도 하지 않는다.** 지금 이 저장소가 그 상태다 —
//    R2 버킷도 키 파일도 없다. 「없으면 건너뛴다」로 두면 백업 없이 migration 이 돈다.
export function readConfig(env = process.env) {
  const miss = [];
  const need = (k) => { const v = env[k]; if (!v) miss.push(k); return v; };
  const cfg = {
    mainDb: need("BACKUP_MAIN_DB"),
    ledgerDb: need("BACKUP_LEDGER_DB"),
    bucket: need("BACKUP_R2_BUCKET"),
    // ⛔ **키는 파일 경로로 받는다. 값으로 받지 않는다** — 값으로 받으면 프로세스 목록과
    //    셸 기록에 남는다. 그리고 그 파일은 **백업 객체와 다른 곳**에 있어야 한다:
    //    같은 버킷에 두면 버킷 하나가 새는 순간 암호화가 아무 일도 안 한 것이 된다.
    keyFile: need("BACKUP_KEY_FILE"),
  };
  return { cfg, miss };
}

// ── inventory 접근 ───────────────────────────────────────────────────────
// 기본 구현은 `wrangler d1 execute <ledger> --remote --command`. 테스트는 가짜를 끼운다.
export const makeInventory = (cfg, run) => ({
  async exec(sql) {
    const r = await run("npx", ["wrangler", "d1", "execute", cfg.ledgerDb, "--remote",
                                "--json", "--command", sql]);
    if (r.code !== 0) throw new Error("ledger 질의 실패");
    return r.out;
  },
  insertPending(id, snapshotAt) {
    return this.exec(`INSERT INTO backups (backup_id, snapshot_at, created_at, status)`
      + ` VALUES (${sqlValue(id, "id")}, ${sqlValue(snapshotAt, "int")},`
      + ` ${sqlValue(snapshotAt, "int")}, 'pending')`);
  },
  setUploaded(id, mainHash, ledgerHash, key, expiresAt) {
    return this.exec(`UPDATE backups SET status = 'uploaded',`
      + ` main_db_hash = ${sqlValue(mainHash, "hash")},`
      + ` ledger_db_hash = ${sqlValue(ledgerHash, "hash")},`
      + ` object_key = ${sqlValue(key, "key")},`
      + ` expires_expected_at = ${sqlValue(expiresAt, "int")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND status = 'pending'`);
  },
  setReady(id) {
    return this.exec(`UPDATE backups SET status = 'ready' WHERE backup_id = ${sqlValue(id, "id")}`
      + ` AND status = 'uploaded'`);
  },
  fail(id, code) {
    return this.exec(`UPDATE backups SET status = 'failed',`
      + ` last_error_code = ${sqlValue(code, "code")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND status IN ('pending','uploaded')`);
  },
});

// ── 본체 ─────────────────────────────────────────────────────────────────
// 돌려주는 것은 **영수증 하나**다. 던지지 않는다 — 부르는 쪽(사람)이 코드로 읽는다.
//   { ok, backupId, step, code, bytes }
//   code:  config | main_export | ledger_export | verify | encrypt | upload |
//          upload_verify | inventory
export async function runBackup({
  env = process.env, now = Date.now(), run = realRunner, dryRun = false,
  inventory, log = () => {},
} = {}) {
  const { cfg, miss } = readConfig(env);
  if (miss.length) {
    // ⛔ **fail-closed.** 설정이 없으면 백업이 「건너뛴 것」이 아니라 「실패한 것」이다.
    log(`백업 설정이 없다: ${miss.join(", ")}`);
    return { ok: false, step: "config", code: "config", missing: miss };
  }
  if (!existsSync(cfg.keyFile)) {
    log("암호화 키 파일이 없다");
    return { ok: false, step: "config", code: "config", missing: ["BACKUP_KEY_FILE"] };
  }
  const key = Buffer.from((await readFile(cfg.keyFile, "utf8")).trim(), "base64");
  if (key.length !== 32) {
    // 짧은 키를 조용히 늘려 쓰지 않는다. 키 강도가 설정 실수에 좌우되면 안 된다.
    log("암호화 키가 32바이트가 아니다");
    return { ok: false, step: "config", code: "config", missing: ["BACKUP_KEY_FILE"] };
  }

  const id = randomBytes(16).toString("hex");
  const inv = inventory || makeInventory(cfg, run);
  const dir = await mkdtemp(path.join(tmpdir(), "shhh-backup-"));
  const fail = async (step, code) => {
    // 기록이 실패해도 **결과는 실패**다. 「기록 못 했으니 성공으로 치자」가 없어야 한다.
    if (!dryRun) { try { await inv.fail(id, code); } catch { /* 아래에서 실패로 끝난다 */ } }
    log(`실패: ${step}`);
    return { ok: false, backupId: id, step, code };
  };
  try {
    // ── 0. **pending 을 먼저 적는다.** ──
    // 여기서 죽으면 `pending` 행이 남고, 그 행은 삭제 표식 정리를 **막는다**(`BACKUP_BLOCKS_SQL`).
    // 그게 맞는 방향이다 — 객체가 생겼는지 우리가 모르는 상태이기 때문이다.
    if (!dryRun) {
      try { await inv.insertPending(id, now); }
      catch { log("inventory 기록 실패"); return { ok: false, backupId: id, step: "inventory", code: "inventory" }; }
    }

    // ── 1~2. 두 DB export. **하나라도 실패하면 전체 실패다.** ──
    const dumps = {};
    for (const [which, db] of [["main", cfg.mainDb], ["ledger", cfg.ledgerDb]]) {
      const out = path.join(dir, `${which}.sql`);
      const r = await run("npx", ["wrangler", "d1", "export", db, "--remote", "--output", out]);
      if (r.code !== 0) return await fail(`${which}_export`, `${which}_export`);
      if (!existsSync(out)) return await fail(`${which}_export`, `${which}_export`);
      const size = (await stat(out)).size;
      // ── 3. 크기·필수 표 검증. 빈 파일과 「표가 빠진」 덤프를 백업이라 부르지 않는다.
      if (size === 0) return await fail("verify", "verify");
      const text = await readFile(out, "utf8");
      for (const tbl of REQUIRED_TABLES[which]) {
        if (!new RegExp(`CREATE TABLE[^;]*\\b${tbl}\\b`, "i").test(text))
          return await fail("verify", "verify");
      }
      dumps[which] = { file: out, size, hash: await sha256File(out) };
      log(`${which}: ${size} bytes`);
    }

    // ── 4. 암호화. **성공한 뒤에만** 업로드 단계로 간다. ──
    // AES-256-GCM. nonce 는 매번 CSPRNG 이고 파일 앞에 붙는다. 태그는 뒤에 붙는다.
    const objectKey = `shhh/${id}.enc`;
    const encFile = path.join(dir, "bundle.enc");
    try {
      const bundle = Buffer.concat([
        Buffer.from(JSON.stringify({ v: 1, id, snapshot_at: now,
                                     main: dumps.main.hash, ledger: dumps.ledger.hash }) + "\n"),
        await readFile(dumps.main.file), Buffer.from("\n-- ledger --\n"),
        await readFile(dumps.ledger.file),
      ]);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(bundle), c.final()]);
      await writeFile(encFile, Buffer.concat([iv, body, c.getAuthTag()]));
    } catch {
      return await fail("encrypt", "encrypt");
    }

    if (dryRun) {
      // ⛔ **원격에는 한 글자도 안 쓴다.** 여기까지가 로컬에서 확인할 수 있는 전부다.
      log("dry-run: 업로드·기록 없음");
      return { ok: true, dryRun: true, backupId: id, step: "encrypt",
               bytes: (await stat(encFile)).size,
               hashes: { main: dumps.main.hash, ledger: dumps.ledger.hash } };
    }

    // ── 5. 업로드 ──
    const up = await run("npx", ["wrangler", "r2", "object", "put",
                                 `${cfg.bucket}/${objectKey}`, "--file", encFile, "--remote"]);
    if (up.code !== 0) return await fail("upload", "upload");

    // ── 6. **업로드된 것을 다시 확인한 뒤에만** uploaded → ready ──
    const expiresAt = now + BACKUP_TTL_DAYS * 86400e3;
    try { await inv.setUploaded(id, dumps.main.hash, dumps.ledger.hash, objectKey, expiresAt); }
    catch { return await fail("inventory", "inventory"); }
    const head = await run("npx", ["wrangler", "r2", "object", "get",
                                   `${cfg.bucket}/${objectKey}`, "--remote"]);
    if (head.code !== 0) return await fail("upload_verify", "upload_verify");
    try { await inv.setReady(id); }
    catch { return await fail("inventory", "inventory"); }

    log(`ready: ${id}`);
    // ⛔ **여기서 migration 을 실행하지 않는다.** 승인은 사람이 따로 한다.
    return { ok: true, backupId: id, step: "ready", objectKey, expiresAt,
             hashes: { main: dumps.main.hash, ledger: dumps.ledger.hash } };
  } finally {
    // 평문 덤프를 남기지 않는다.
    await rm(dir, { recursive: true, force: true });
  }
}

// ── migration 게이트 ─────────────────────────────────────────────────────
// **백업이 있다는 것을 확인만 한다.** 백업을 만들지도, migration 을 돌리지도 않는다.
// ⛔ 「방금 만든 ready 백업」이 없으면 0이 아닌 코드로 끝난다 — 그것이 migration 을 막는 방식이다.
export async function backupGate({ env = process.env, now = Date.now(), run = realRunner,
                                   query, log = () => {} } = {}) {
  const { cfg, miss } = readConfig(env);
  if (miss.length) { log(`백업 설정이 없다: ${miss.join(", ")}`); return { ok: false, code: "config" }; }
  const q = query || (async () => {
    const r = await run("npx", ["wrangler", "d1", "execute", cfg.ledgerDb, "--remote", "--json",
      "--command", `SELECT snapshot_at FROM backups WHERE status = 'ready'`
                 + ` ORDER BY snapshot_at DESC LIMIT 1`]);
    if (r.code !== 0) throw new Error("ledger 질의 실패");
    return r.out;
  });
  let rows;
  try {
    const out = await q();
    // ⚠️ 못 읽으면 **모른다**이고, 모를 때는 막는다.
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    rows = (Array.isArray(parsed) ? parsed[0] : parsed);
    rows = (rows && rows.results) || [];
  } catch { log("백업 상태를 못 읽었다"); return { ok: false, code: "unreadable" }; }
  if (!rows.length) { log("ready 상태의 백업이 없다"); return { ok: false, code: "none" }; }
  const age = now - Number(rows[0].snapshot_at);
  if (!(age >= 0 && age <= GATE_MAX_AGE)) {
    log("마지막 백업이 너무 오래됐다");
    return { ok: false, code: "stale", ageMs: age };
  }
  return { ok: true, ageMs: age };
}

// ── CLI ──────────────────────────────────────────────────────────────────
// 함정 20·53: import 한 스크립트의 하단이 실행되면 안 된다.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const cmd = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const log = (m) => console.log("[backup]", m);
  if (cmd === "backup") {
    const r = await runBackup({ dryRun, log });
    console.log(JSON.stringify({ ok: r.ok, backupId: r.backupId, step: r.step, code: r.code }));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "gate") {
    const r = await backupGate({ log });
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } else {
    console.log("사용법: node scripts/backup.mjs backup [--dry-run] | gate");
    console.log("  backup  두 DB 를 내보내고 검증·암호화·업로드한다. migration 은 실행하지 않는다.");
    console.log("  gate    방금 만든 ready 백업이 있는지만 본다. 없으면 0이 아닌 코드로 끝난다.");
    process.exit(2);
  }
}
