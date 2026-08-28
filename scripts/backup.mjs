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
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
// ⚠️ **`node:sqlite` 를 여기서 정적으로 부르지 않는다**(2026-08-28 · 위협 90). 지원하지 않는
//    Node 에서는 이 줄이 **모듈을 읽는 순간** `ERR_UNKNOWN_BUILTIN_MODULE` 로 터져, 운영자가
//    보는 것이 「백업 도구가 원래 안 되는 것」처럼 보이는 스택 하나다. 아래 `assertNode()` 가
//    먼저 말할 수 있도록 실제로 쓰는 자리에서 지연해 부른다.
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
// ⚠️ **전이표와 객체 키의 원본은 `worker/ledger.js` 다.** 정리 크론(Workers)과 이 도구(Node)가
//    같은 규칙을 써야 하는데, 두 곳에 적으면 갈라진다 — 갈라진 날 한쪽은 표에 없는 전이를
//    받아들이고 다른 쪽은 있지도 않은 키를 묻는다.
import { BACKUP_NEXT, backupCanTransition, backupFroms, BACKUP_OBJECT_KEY } from "../worker/ledger.js";

// ── 두 DB 와 「그 안에 반드시 있어야 하는 표」 ────────────────────────────
// export 가 **성공했는데 비어 있는** 경우를 잡는 것이 이 목록의 일이다. wrangler 는 빈 덤프도
// 종료 코드 0 으로 끝낼 수 있고, 그 파일을 백업이라고 부르면 복구가 필요한 날 아무것도 없다.
export const REQUIRED_TABLES = {
  main: ["users", "sessions", "books", "friendships", "invite_codes",
         "policy_events", "consumed_signup_states", "write_fence"],
  // ⚠️ `transitions`·`lease_resolutions` 가 **빠져 있었다**(2026-08-27 · K2 중간 항목).
  //    둘 다 ledger `0004` 가 만드는 실제 표이고, 없으면 유지보수 전환이 재개되지 않고
  //    stale 해제 기록이 사라진다 — 그런 덤프를 백업이라 부르면 복구가 반쪽이 된다.
  ledger: ["deletions", "maintenance", "write_leases", "cleanup_runs",
           "deletion_keys", "rate_limits", "transitions", "lease_resolutions", "backups"],
};

// 복원 검증이 **임시 DB 에 실은 뒤** 확인하는 인덱스. 표만 보면 유일성·부분 유니크가 빠진
// 덤프를 정상으로 읽는다 — 그 사본으로 복원하면 활성 초대 코드가 사용자당 여러 개가 된다.
export const REQUIRED_INDEXES = {
  main: ["users_provider", "friendships_pair", "invite_codes_active"],
  ledger: ["backups_blocking"],
};

// 검증 도구의 판. 영수증에 함께 적는다 — 나중에 「무엇이 검증했나」를 물을 수 있어야 한다.
export const VERIFY_VERSION = "v1";
// 복호화는 Node 메모리에서 한 번에 한다. **한도를 명시한다** — 넘으면 검증을 시작하지 않고
// 실패로 끝난다(조용히 죽는 것보다 낫다). 넘기 시작하면 스트리밍 복호화로 바꾼다.
export const MAX_VERIFY_BYTES = 256 * 1024 * 1024;
// 암호화 키의 **지문.** 비밀값이 아니다 — 키를 갈아 끼웠는지만 말한다.
export const keyFingerprint = (key) =>
  createHash("sha256").update("shhh-backup-key-v1").update(key).digest("hex").slice(0, 16);

// 상태 전이. **한 방향이다** — 되돌아가는 전이는 없다(되돌리려면 새 backup_id 로 다시 한다).
//
// 각 상태가 답하는 질문은 **「지금 R2 에 그 객체가 있나」** 하나다:
//   pending   모른다 — 업로드 명령을 아직 안 냈거나 결과를 모른다        → 표식 정리를 막는다
//   uploaded  있다(올렸다). 아직 전체 검증 전                            → 막는다
//   ready     있고, 크기·해시까지 검증됐다                               → 막는다
//   failed    **모른다.** 업로드 결과가 불확실하거나 내용이 어긋났다      → 막는다
//   aborted   **없다.** 업로드가 시작되지 않았음을 확인했다              → 막지 않는다
//   deleted   **없다.** R2 에서 부재를 확인하고 `deleted_at` 을 적었다   → 막지 않는다
//
// ⚠️ `failed` → `deleted`·`aborted` 는 **reconcile 이 실제 부재를 확인했을 때만** 쓴다.
//    이 길이 없으면 한 번 불확실해진 행이 영원히 표식 정리를 막아 보유기간이 사실상 무한이 된다.
export const NEXT = BACKUP_NEXT;
export const canTransition = backupCanTransition;

// 객체 키는 **backup_id 하나에서 결정적으로 재구성된다.** inventory 의 `object_key` 가
// 비어 있어도(= pending 에서 죽었어도) reconcile 이 무엇을 물어봐야 하는지 알 수 있다.
export const objectKeyFor = BACKUP_OBJECT_KEY;

// 만료 예정 시각이 지나고도 객체가 남아 있을 수 있는 여유. R2 lifecycle 은 만료 표시 뒤
// 실제 삭제까지 **통상 하루** 정도가 더 걸릴 수 있다(그래서 「7일에 삭제」라고 안 적는다).
// 이 여유마저 지났는데 아직 있으면 **비정상**이고 사람이 봐야 한다.
export const OVERDUE_GRACE = 2 * 86400e3;

// `uploading` 이 이만큼 지나도록 안 끝났으면 **비정상**이다. ⛔ **닫는 근거가 아니다** —
// 시간이 지났다고 생산자가 죽었다고 단정하지 않는다. 사람이 보라고 알리기만 한다.
// `worker/cleanup/index.js` 의 `RECON_UPLOADING_STUCK` 과 같은 값이다.
export const UPLOADING_STUCK = 6 * 3600e3;

// R2 lifecycle 만료까지. 방침이 적는 값과 같다.
export const BACKUP_TTL_DAYS = 7;
// `gate` 가 「방금 만든 백업」으로 인정하는 최대 나이. 어제 백업으로 오늘 migration 을 돌리면
// 그 사이의 쓰기가 복구 대상에서 빠진다.
export const GATE_MAX_AGE = 2 * 3600e3;

// ── Node 런타임 계약 (2026-08-28 · 위협 90) ──────────────────────────────
// 이 도구는 복원 가능성을 증명할 때 **덤프를 실제 SQLite 에 싣는다**(`loadTemp`). 그 기능은
// `node:sqlite` 이고, **플래그 없이 쓸 수 있는 최소 판이 22.13.0** 이다(그 아래는 22.5~22.12 가
// `--experimental-sqlite` 를 요구하고, 그보다 아래는 모듈 자체가 없다).
//
// ⛔ **「지금 Node 24 에서 되니까 됐다」로 끝내지 않는다.** 운영자의 기기·CI·나중의 나는
//    다른 판일 수 있고, 그때 나오는 것은 이해할 수 없는 import 오류다 — 그 상태에서 백업
//    없이 migration 을 돌리는 것이 이 계약이 막으려는 결과다.
// ⚠️ **값의 원본은 여기 하나다.** `package.json` 의 `engines.node` 와 `.nvmrc` 를
//    `test-ops-race` R9 가 이 상수와 대조한다 — 손으로 세 곳에 적으면 반드시 갈라진다.
export const MIN_NODE = "22.13.0";
const partsOf = (v) => String(v).split(".").map((x) => parseInt(x, 10) || 0);
export function nodeOk(v = process.versions.node) {
  const a = partsOf(v), b = partsOf(MIN_NODE);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return true;
}
// ⛔ **fail-closed 다.** 던지고, 필요한 판을 말한다.
export function assertNode(v = process.versions.node) {
  if (!nodeOk(v))
    throw new Error(`백업 도구는 Node ${MIN_NODE} 이상이 필요하다 (지금 ${v}). `
      + "복원 가능성 증명이 node:sqlite 를 쓰고, 그 아래 판에서는 플래그 없이 열리지 않는다.");
}

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
  if (kind === "code" && /^[a-z_0-9]{1,40}$/.test(v)) return `'${v}'`;
  if (kind === "fp" && /^[0-9a-f]{16}$/.test(v)) return `'${v}'`;
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

// ── 정지(quiescence) 확인 ────────────────────────────────────────────────
// **두 DB 를 각각 내보내는 사이에 쓰기가 들어오면 백업 안에서 두 DB 가 서로 다른 시점을
// 가리킨다.** 그 사본으로 복원하면 「표식은 있는데 계정은 살아 있는」 상태가 만들어진다.
// 그래서 export 전에 다섯을 확인한다. ⛔ **하나라도 못 읽으면 시작하지 않는다** —
// 「질의가 실패했다」는 「멈췄다」가 아니다.
const rowsOf = (out) => {
  const parsed = typeof out === "string" ? JSON.parse(out) : out;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && first.results) || [];
};
const askD1 = async (run, db, sql) => {
  const r = await run("npx", ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql]);
  if (r.code !== 0) throw new Error("d1 질의 실패");
  return rowsOf(r.out);
};
export async function quiescence({ cfg, run }) {
  let maint, leases, fence;
  try {
    maint = (await askD1(run, cfg.ledgerDb,
      "SELECT mode, epoch, drained_at, pending_transition FROM maintenance WHERE id = 1"))[0];
    leases = (await askD1(run, cfg.ledgerDb, "SELECT COUNT(*) AS n FROM write_leases"))[0];
    fence = (await askD1(run, cfg.mainDb, "SELECT epoch FROM write_fence WHERE id = 1"))[0];
  } catch { return { ok: false, why: "unreadable" }; }
  if (!maint || !leases || !fence) return { ok: false, why: "unreadable" };
  if (maint.mode === "open") return { ok: false, why: "open" };
  if (maint.pending_transition) return { ok: false, why: "transition" };
  if (maint.drained_at === null || maint.drained_at === undefined) return { ok: false, why: "no_drain" };
  if (Number(leases.n) !== 0) return { ok: false, why: "live_lease" };
  if (Number(fence.epoch) !== Number(maint.epoch)) return { ok: false, why: "epoch" };
  return { ok: true, epoch: Number(maint.epoch) };
}

// ── R2 객체가 지금 있나 ──────────────────────────────────────────────────
// **「있다 · 없다 · 모른다」 셋으로 답한다.** 종료 코드만 보면 네트워크 장애가 「없다」로
// 읽히고, 그 순간 삭제 표식이 근거 없이 지워진다.
// ⚠️ 반드시 `--file` 로 받는다 — stdout 으로 받으면 객체 전체가 문자열에 담긴다.
// ⚠️ **객체 수준의 증거만 「없다」로 읽는다**(2026-08-27 · 독립 검토 #2). 넓게 잡으면
//    「버킷이 없다」(10006) · 자격증명이 다른 계정을 가리키는 경우 · 일반 404 까지 **부재의
//    증거**가 되어, 설정 오타 하나로 살아 있는 백업 행이 전부 닫히고 **삭제 표식이 근거 없이
//    지워진다.** 그 셋은 전부 「모른다」여야 한다.
const ABSENT_RE = /\b10007\b|no such key|specified key does not exist/i;
// 부재 판정 규칙. **테스트가 직접 잰다** — 넓어지는 순간 부재가 아닌 것이 부재가 된다.
export const absentEvidence = (text) => ABSENT_RE.test(String(text || ""));
export async function probeObject(run, cfg, key, dest) {
  const r = await run("npx", ["wrangler", "r2", "object", "get",
                              `${cfg.bucket}/${key}`, "--file", dest, "--remote"]);
  if (r.code === 0) return "present";
  if (ABSENT_RE.test(String(r.err || "") + String(r.out || ""))) return "absent";
  return "unknown";
}

// ── 암호화 키 ────────────────────────────────────────────────────────────
// ⛔ **키를 로그·오류·영수증에 담지 않는다.** 밖으로 나가는 것은 지문뿐이다.
export async function readKey(cfg) {
  if (!existsSync(cfg.keyFile)) return { miss: "absent" };
  let key;
  try { key = Buffer.from((await readFile(cfg.keyFile, "utf8")).trim(), "base64"); }
  catch { return { miss: "unreadable" }; }
  // 짧은 키를 조용히 늘려 쓰지 않는다. 키 강도가 설정 실수에 좌우되면 안 된다.
  if (key.length !== 32) return { miss: "length" };
  return { key, fingerprint: keyFingerprint(key) };
}

// ── 복호화와 임시 적재 ───────────────────────────────────────────────────
// 파일 모양: `[12바이트 nonce][암호문][16바이트 태그]`. 평문은
// `{"v":1,...}\n` + main.sql + `\n-- ledger --\n` + ledger.sql.
export const BUNDLE_SEP = "\n-- ledger --\n";
export function decryptBundle(buf, key) {
  if (buf.length < 12 + 16) return { code: "too_short" };
  let plain;
  try {
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    // ⚠️ `final()` 이 태그를 검증한다. 여기서 던지면 **내용이 바뀌었거나 키가 다르다** —
    //    둘 다 「복원할 수 없다」이므로 갈라 말하지 않는다(어느 쪽인지 말하면 힌트가 된다).
    plain = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
  } catch { return { code: "decrypt" }; }
  const nl = plain.indexOf(0x0a);
  if (nl < 0) return { code: "shape" };
  let header;
  try { header = JSON.parse(plain.subarray(0, nl).toString("utf8")); }
  catch { return { code: "shape" }; }
  const rest = plain.subarray(nl + 1);
  const at = rest.indexOf(BUNDLE_SEP);
  if (at < 0) return { code: "shape" };
  return {
    header,
    main: rest.subarray(0, at),
    ledger: rest.subarray(at + Buffer.byteLength(BUNDLE_SEP)),
  };
}

// **비파괴적 임시 복원.** 메모리 안의 SQLite 하나에 덤프를 그대로 실어 본다 —
// 운영 DB 는 물론이고 디스크에도 남기지 않는다.
// ⛔ 이것이 이 저장소에서 「복원」에 가장 가까운 코드이고, **어디에도 쓰지 않는다.**
//    돌려주는 것은 boolean 하나이고 내용은 함수 밖으로 나가지 않는다.
export async function loadTemp(sqlText, which) {
  // ⚠️ 여기서 판을 확인한다 — 아래 `import` 가 지원하지 않는 Node 에서 터지기 전에.
  assertNode();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(String(sqlText));
    const names = new Set(db.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name));
    for (const tbl of REQUIRED_TABLES[which]) if (!names.has(tbl)) return { ok: false, missing: tbl };
    for (const ix of REQUIRED_INDEXES[which]) if (!names.has(ix)) return { ok: false, missing: ix };
    return { ok: true, objects: names.size };
  } catch { return { ok: false, missing: "load" }; }
  finally { db.close(); }
}

// ── inventory 접근 ───────────────────────────────────────────────────────
// 기본 구현은 `wrangler d1 execute <ledger> --remote --command`. 테스트는 가짜를 끼운다.
// D1 이 실제로 몇 행을 바꿨나. **`--json` 응답의 `meta.changes` 가 원본이다** —
// 종료 코드 0 은 「문장이 돌았다」이지 「그 행이 바뀌었다」가 아니다.
const changesOf = (out) => {
  const parsed = typeof out === "string" ? JSON.parse(out) : out;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const m = first && first.meta;
  return m && Number.isFinite(Number(m.changes)) ? Number(m.changes) : null;
};

export const makeInventory = (cfg, run) => ({
  async exec(sql) {
    const r = await run("npx", ["wrangler", "d1", "execute", cfg.ledgerDb, "--remote",
                                "--json", "--command", sql]);
    if (r.code !== 0) throw new Error("ledger 질의 실패");
    return r.out;
  },
  // 상태를 바꾸는 문장은 **정확히 한 행**을 바꿔야 한다(2026-08-27 · K2 중간 항목 4).
  // 0행은 전이표가 막았거나 그 행이 없다는 뜻이고, 둘 다 「했다」로 넘기면 안 된다.
  // ⛔ 「몇 행이든 돌았으면 성공」으로 두면 전이표가 SQL 안에 있는 의미가 사라진다.
  async execOne(sql, what) {
    const changed = changesOf(await this.exec(sql));
    if (changed !== 1) throw new Error(`backup inventory: ${what} 가 ${changed}행을 바꿨다`);
  },
  insertPending(id, snapshotAt, epoch, fingerprint) {
    return this.execOne(`INSERT INTO backups (backup_id, snapshot_at, created_at, status,`
      + ` maintenance_epoch, key_fingerprint)`
      + ` VALUES (${sqlValue(id, "id")}, ${sqlValue(snapshotAt, "int")},`
      + ` ${sqlValue(snapshotAt, "int")}, 'pending', ${sqlValue(epoch, "int")},`
      + ` ${sqlValue(fingerprint, "fp")})`, "insertPending");
  },
  // **업로드 권리를 딴다**(2026-08-28 · 위협 88). `r2 object put` 직전에 이것이 1행을 바꿔야
  // 올릴 수 있다. reconciler 의 `pending → aborted` 와 **같은 행의 같은 상태**를 두고 다투므로
  // 둘 중 하나만 이긴다 — 그래서 「`aborted` 인데 객체가 있다」가 만들어질 수 없다.
  // ⛔ **`execOne` 이다.** 0행을 성공으로 넘기면 권리가 없는데 올리게 되고, 그 순간 이 자물쇠는
  //    있으나 마나가 된다.
  setUploading(id) {
    return this.execOne(`UPDATE backups SET status = 'uploading' WHERE backup_id = ${sqlValue(id, "id")}`
      + ` AND ${froms("uploading")}`, "setUploading");
  },
  setUploaded(id, mainHash, ledgerHash, key, expiresAt, bytes, objHash) {
    return this.execOne(`UPDATE backups SET status = 'uploaded',`
      + ` main_db_hash = ${sqlValue(mainHash, "hash")},`
      + ` ledger_db_hash = ${sqlValue(ledgerHash, "hash")},`
      + ` object_key = ${sqlValue(key, "key")},`
      + ` object_bytes = ${sqlValue(bytes, "int")},`
      + ` object_hash = ${sqlValue(objHash, "hash")},`
      + ` expires_expected_at = ${sqlValue(expiresAt, "int")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND ${froms("uploaded")}`, "setUploaded");
  },
  setReady(id) {
    return this.execOne(`UPDATE backups SET status = 'ready' WHERE backup_id = ${sqlValue(id, "id")}`
      + ` AND ${froms("ready")}`, "setReady");
  },
  // 복원 **가능성 증명**의 영수증. 상태는 안 바꾼다 — `ready` 와 다른 사실이기 때문이다.
  setVerified(id, at, version) {
    return this.execOne(`UPDATE backups SET verified_at = ${sqlValue(at, "int")},`
      + ` verify_version = ${sqlValue(version, "code")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND status = 'ready'`, "setVerified");
  },
  // 게이트·검증이 **명시된 backup_id 하나**를 읽는다. 「가장 최근 ready」를 고르지 않는다.
  async getRow(id) {
    const out = await this.exec(`SELECT backup_id, status, snapshot_at, object_key, object_bytes,`
      + ` object_hash, main_db_hash, ledger_db_hash, maintenance_epoch, key_fingerprint,`
      + ` verified_at, verify_version, expires_expected_at, deleted_at FROM backups`
      + ` WHERE backup_id = ${sqlValue(id, "id")}`);
    return rowsOf(out)[0] || null;
  },
  // ⚠️ `fail`·`abort`·`markChecked` 는 **`changes` 를 따지지 않는다.** 셋 다 이미 실패한
  //    경로이거나(앞의 단계가 실패해서 부르는 자리) 기록일 뿐이고, 여기서 던지면 원래의
  //    실패 사유가 그 예외에 덮인다. 상태를 **앞으로** 옮기는 문장만 `execOne` 이다.
  fail(id, code) {
    return this.exec(`UPDATE backups SET status = 'failed',`
      + ` last_error_code = ${sqlValue(code, "code")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND ${froms("failed")}`);
  },
  // **업로드가 시작되지 않았음을 확인한** 실패. 이 행은 표식 정리를 막지 않는다.
  abort(id, code) {
    return this.exec(`UPDATE backups SET status = 'aborted',`
      + ` last_error_code = ${sqlValue(code, "code")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND ${froms("aborted")}`);
  },
  // ── reconcile ──
  async openRows() {
    const out = await this.exec("SELECT backup_id, status, snapshot_at, created_at, object_key,"
      + " object_bytes, object_hash, expires_expected_at FROM backups"
      + " WHERE deleted_at IS NULL AND status NOT IN ('aborted','deleted')");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return (first && first.results) || [];
  },
  markChecked(id, at) {
    return this.exec(`UPDATE backups SET deletion_checked_at = ${sqlValue(at, "int")}`
      + ` WHERE backup_id = ${sqlValue(id, "id")}`);
  },
  // ⛔ **부재를 확인했을 때만 부른다.** `deleted` 는 `deleted_at` 을 함께 적는다.
  // ⚠️ **관측한 상태를 조건에 건다**(2026-08-28 · CAS). 조회와 이 문장 사이에 생산자가 상태를
  //    옮겼으면 0행이고, 부르는 쪽은 그것을 「닫았다」로 읽지 않는다.
  // ⛔ 바뀐 행 수를 돌려준다 — 안 돌려주면 진 싸움이 이긴 것처럼 보인다.
  async markGone(id, at, to, from) {
    return changesOf(await this.exec(
      `UPDATE backups SET status = ${sqlValue(to, "status")},`
      + ` deletion_checked_at = ${sqlValue(at, "int")}`
      + (to === "deleted" ? `, deleted_at = ${sqlValue(at, "int")}` : "")
      + ` WHERE backup_id = ${sqlValue(id, "id")} AND status = ${sqlValue(from, "status")}`
      + ` AND ${froms(to)}`));
  },
});

// 「이 상태로 갈 수 있는 출발 상태들」을 **전이표에서 만든다.** SQL 에 손으로 적으면
// 표와 문장이 갈라지고, 갈라진 날 DB 는 표에 없는 전이를 조용히 받아들인다.
const froms = backupFroms;

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
  const k = await readKey(cfg);
  if (k.miss) {
    log("암호화 키를 쓸 수 없다");
    return { ok: false, step: "config", code: "config", missing: ["BACKUP_KEY_FILE"] };
  }
  const key = k.key;

  // ── 정지 확인. **inventory 행을 만들기도 전이다** ──
  // 여기서 막히면 남는 것이 하나도 없어야 한다 — 행을 먼저 만들면 「멈추지 않아서 안 한」
  // 백업이 표식 정리를 막는 행으로 쌓인다.
  const q = await quiescence({ cfg, run });
  if (!q.ok) {
    log(`두 DB 가 멈춘 상태가 아니다: ${q.why}`);
    return { ok: false, step: "quiescence", code: "quiescence", why: q.why };
  }

  const id = randomBytes(16).toString("hex");
  const inv = inventory || makeInventory(cfg, run);
  const dir = await mkdtemp(path.join(tmpdir(), "shhh-backup-"));
  // **결과가 불확실한** 실패. 객체가 생겼는지 모르므로 표식 정리를 계속 막는다.
  const fail = async (step, code) => {
    // 기록이 실패해도 **결과는 실패**다. 「기록 못 했으니 성공으로 치자」가 없어야 한다.
    if (!dryRun) { try { await inv.fail(id, code); } catch { /* 아래에서 실패로 끝난다 */ } }
    log(`실패: ${step}`);
    return { ok: false, backupId: id, step, code };
  };
  // **업로드 명령을 한 번도 내지 않은** 실패. 객체가 없다는 것을 우리가 안다.
  // ⚠️ 이 함수를 부르는 자리는 전부 `r2 object put` **앞**이어야 한다 — 뒤에서 부르면
  //    「부재를 증명했다」가 거짓이 되고, 고아 객체가 아무도 모르게 남는다.
  const abort = async (step, code) => {
    if (!dryRun) { try { await inv.abort(id, code); } catch { /* 아래에서 실패로 끝난다 */ } }
    log(`중단: ${step}`);
    return { ok: false, backupId: id, step, code };
  };
  try {
    // ── 0. **pending 을 먼저 적는다.** ──
    // 여기서 죽으면 `pending` 행이 남고, 그 행은 삭제 표식 정리를 **막는다**(`BACKUP_BLOCKS_SQL`).
    // 그게 맞는 방향이다 — 객체가 생겼는지 우리가 모르는 상태이기 때문이다.
    if (!dryRun) {
      try { await inv.insertPending(id, now, q.epoch, k.fingerprint); }
      catch { log("inventory 기록 실패"); return { ok: false, backupId: id, step: "inventory", code: "inventory" }; }
    }

    // ── 1~2. 두 DB export. **하나라도 실패하면 전체 실패다.** ──
    const dumps = {};
    for (const [which, db] of [["main", cfg.mainDb], ["ledger", cfg.ledgerDb]]) {
      const out = path.join(dir, `${which}.sql`);
      const r = await run("npx", ["wrangler", "d1", "export", db, "--remote", "--output", out]);
      // ⚠️ **`abort` 다.** 여기까지는 `r2 object put` 을 한 번도 실행하지 않았으므로 객체가
      //    없다는 것을 우리가 안다 — 「모른다」로 적으면 이 행이 영영 표식 정리를 막는다.
      if (r.code !== 0) return await abort(`${which}_export`, `${which}_export`);
      if (!existsSync(out)) return await abort(`${which}_export`, `${which}_export`);
      const size = (await stat(out)).size;
      // ── 3. 크기·필수 표 검증. 빈 파일과 「표가 빠진」 덤프를 백업이라 부르지 않는다.
      if (size === 0) return await abort("verify", "verify");
      const text = await readFile(out, "utf8");
      for (const tbl of REQUIRED_TABLES[which]) {
        if (!new RegExp(`CREATE TABLE[^;]*\\b${tbl}\\b`, "i").test(text))
          return await abort("verify", "verify");
      }
      dumps[which] = { file: out, size, hash: await sha256File(out) };
      log(`${which}: ${size} bytes`);
    }

    // ── 4. 암호화. **성공한 뒤에만** 업로드 단계로 간다. ──
    // AES-256-GCM. nonce 는 매번 CSPRNG 이고 파일 앞에 붙는다. 태그는 뒤에 붙는다.
    const objectKey = objectKeyFor(id);
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
      return await abort("encrypt", "encrypt");
    }

    // ── 3-1. **정지를 다시 확인한다**(2026-08-27 · 독립 검토 #3) ──
    // 위 확인과 여기 사이에 `wrangler d1 export` 가 **두 번** 돈다. 그 사이에 누가 문을 다시
    // 열면 두 덤프가 서로 다른 시점을 담는데, 옛 코드는 그대로 올려서 **검증된 백업으로
    // 기록**했다. 검사와 사용이 같은 경계에 있어야 한다는 규칙은 여기에도 적용된다.
    // ⚠️ **`abort` 다** — 아직 `r2 object put` 을 한 번도 내지 않았으므로 객체가 없다는 것을 안다.
    {
      const q2 = await quiescence({ cfg, run });
      if (!q2.ok || q2.epoch !== q.epoch) {
        log(`export 도중에 정지가 풀렸다: ${q2.ok ? "epoch" : q2.why}`);
        return await abort("quiescence", "quiescence");
      }
    }

    if (dryRun) {
      // ⛔ **원격에는 한 글자도 안 쓴다.** 여기까지가 로컬에서 확인할 수 있는 전부다.
      log("dry-run: 업로드·기록 없음");
      return { ok: true, dryRun: true, backupId: id, step: "encrypt",
               bytes: (await stat(encFile)).size,
               hashes: { main: dumps.main.hash, ledger: dumps.ledger.hash } };
    }

    // 암호문의 크기와 해시. **이 두 값이 없으면 나중에 「그때 올린 그 객체가 맞나」를
    // 물어볼 수 없다** — reconcile 이 존재만 확인하고 변조를 못 본다.
    const encBytes = (await stat(encFile)).size;
    const encHash = await sha256File(encFile);

    // ── 4-2. **업로드 권리를 딴다**(2026-08-28 · 위협 88) ──
    // ⚠️ **`r2 object put` 직전이어야 한다.** 앞에 두면 그 사이에 죽었을 때 「올리는 중」인
    //    행이 남고, 뒤에 두면 이미 올린 뒤라 아무것도 못 막는다.
    // ⛔ **실패하면 `abort` 도 `fail` 도 부르지 않는다.** 그 행은 이미 남의 것이다 —
    //    덮어쓰면 상대가 적은 사실(부재 확인)을 우리가 지우는 셈이 된다.
    try { await inv.setUploading(id); }
    catch {
      log("업로드 권리를 못 땄다 — 그 사이에 이 백업이 닫혔다");
      return { ok: false, backupId: id, step: "claim", code: "claim" };
    }

    // ── 5. 업로드 ──
    const up = await run("npx", ["wrangler", "r2", "object", "put",
                                 `${cfg.bucket}/${objectKey}`, "--file", encFile, "--remote"]);
    // ⚠️ **여기부터는 `fail` 이다.** 명령이 실패해도 객체가 생겼을 수 있다(타임아웃·중간 끊김).
    //    「모른다」는 삭제 허가가 아니므로 이 행은 계속 막는다. reconcile 이 실제로 물어본다.
    if (up.code !== 0) return await fail("upload", "upload");

    // ── 6. **되읽어 크기·해시까지 맞은 뒤에만** uploaded → ready ──
    const expiresAt = now + BACKUP_TTL_DAYS * 86400e3;
    try { await inv.setUploaded(id, dumps.main.hash, dumps.ledger.hash, objectKey, expiresAt,
                                encBytes, encHash); }
    catch { return await fail("inventory", "inventory"); }
    // ⛔ **stdout 으로 받지 않는다.** `--file` 로 임시 파일에 내려 크기와 해시를 잰다 —
    //    통째로 문자열에 담으면 큰 백업에서 그대로 죽고, 담긴 값은 평문이 아니어도 메모리에 남는다.
    const back = path.join(dir, "verify.enc");
    const got = await probeObject(run, cfg, objectKey, back);
    if (got !== "present") return await fail("upload_verify", "upload_verify");
    if ((await stat(back)).size !== encBytes || (await sha256File(back)) !== encHash)
      return await fail("upload_verify", "upload_verify");
    try { await inv.setReady(id); }
    catch { return await fail("inventory", "inventory"); }

    log(`ready: ${id}`);
    // ⛔ **여기서 migration 을 실행하지 않는다.** 승인은 사람이 따로 한다.
    return { ok: true, backupId: id, step: "ready", objectKey, expiresAt,
             bytes: encBytes,
             hashes: { main: dumps.main.hash, ledger: dumps.ledger.hash } };
  } finally {
    // 평문 덤프를 남기지 않는다.
    await rm(dir, { recursive: true, force: true });
  }
}

// ── reconcile ────────────────────────────────────────────────────────────
// **inventory 가 말하는 상태와 R2 의 실제를 맞춘다.** 이것이 없으면 백업 행은 어느 것도
// 스스로 닫히지 않고, 「모른다」로 남은 행이 삭제 표식 정리를 영원히 막는다.
//
// 규칙 셋만 지킨다:
//   ① **실제 부재를 확인했을 때만** 닫는다(`deleted`·`aborted`). 만료 예정 시각은 근거가 아니다
//   ② **모르면 아무것도 안 한다.** 조회 실패는 「없다」가 아니다 — 0이 아닌 코드로 끝난다
//   ③ **복원하지 않는다.** 이 함수가 내는 R2 명령은 `get` 하나다
//
// ⛔ 되돌리는 명령을 여기 넣지 않는다. `scripts/test-backup.mjs` B18 이 그것을 잰다.
export async function reconcile({ env = process.env, now = Date.now(), run = realRunner,
                                  inventory, log = () => {} } = {}) {
  const { cfg, miss } = readConfig(env);
  if (miss.length) { log(`백업 설정이 없다: ${miss.join(", ")}`); return { ok: false, code: "config" }; }
  const inv = inventory || makeInventory(cfg, run);
  let rows;
  try { rows = await inv.openRows(); }
  catch { log("inventory 를 못 읽었다"); return { ok: false, code: "unreadable" }; }

  const dir = await mkdtemp(path.join(tmpdir(), "shhh-reconcile-"));
  const out = { ok: true, checked: 0, closed: 0, unknown: 0, overdue: 0, mismatch: 0,
                uploading: 0, stuck: 0, raced: 0 };
  try {
    for (const r of rows) {
      const id = r.backup_id;
      // 키가 기록되지 않았어도(= pending 에서 죽었어도) **결정적으로 재구성**한다.
      const key = r.object_key || objectKeyFor(id);
      const dest = path.join(dir, "obj.bin");
      const state = await probeObject(run, cfg, key, dest);
      out.checked++;
      if (state === "unknown") {
        // ⛔ **아무것도 적지 않는다.** 확인 시각조차 적지 않는다 — 적으면 다음 사람이
        //    「확인했다」로 읽는다. 이 행은 계속 막고, 명령은 0이 아닌 코드로 끝난다.
        out.unknown++; out.ok = false; log(`모름: ${id}`);
        continue;
      }
      if (state === "absent") {
        // ⛔ **`uploading` 은 순간 부재만으로 닫지 않는다**(2026-08-28 · 위협 88) —
        //    그 순간 다른 프로세스의 `r2 object put` 이 도는 중일 수 있다.
        //    ⚠️ **자동 크론과 같은 규칙이다.** 수동 명령이 더 약하면 운영자가 손으로 부르는
        //       순간 자물쇠가 없어진다.
        if (r.status === "uploading") {
          out.uploading++; out.ok = false;
          if (now - Number(r.created_at || 0) > UPLOADING_STUCK) { out.stuck++; log(`방치: ${id}`); }
          else log(`업로드 진행 중: ${id}`);
          continue;
        }
        // `pending` 은 업로드 권리를 아무도 못 땄다는 뜻이 되므로 `aborted`,
        // 그 밖(uploaded·ready·failed)은 있었던 것이 사라졌으므로 `deleted` 다.
        const to = r.status === "pending" ? "aborted" : "deleted";
        // 관측한 상태에서만 옮긴다. 0행이면 그 사이에 생산자가 이겼다는 뜻이다.
        if (await inv.markGone(id, now, to, r.status) !== 1) {
          out.raced++; out.ok = false; log(`경합: ${id}`);
          continue;
        }
        out.closed++; log(`부재 확인: ${id} → ${to}`);
        continue;
      }
      // 있다. 검증할 값이 기록돼 있으면 대조한다.
      if (r.object_hash && r.object_bytes !== null && r.object_bytes !== undefined) {
        const same = (await stat(dest)).size === Number(r.object_bytes)
                  && (await sha256File(dest)) === String(r.object_hash);
        if (!same) {
          // 내용이 다르다. **정상으로 처리하지 않는다** — 계속 막고 사람이 본다.
          if (canTransition(r.status, "failed")) await inv.fail(id, "mismatch");
          out.mismatch++; out.ok = false; log(`해시 불일치: ${id}`);
          continue;
        }
      } else {
        // 객체는 있는데 우리가 아는 값이 없다 = **고아**다. 계속 막는다.
        if (canTransition(r.status, "failed")) await inv.fail(id, "orphan");
        out.mismatch++; out.ok = false; log(`고아 객체: ${id}`);
        continue;
      }
      await inv.markChecked(id, now);
      // 만료 예정 시각 + 여유가 지났는데 아직 있다 → 비정상. lifecycle 이 안 걸렸을 수 있다.
      // ⛔ **여기서 지우지 않는다.** 지우는 것은 사람의 판단이고, 이 도구는 알리기만 한다.
      if (r.expires_expected_at && now > Number(r.expires_expected_at) + OVERDUE_GRACE) {
        out.overdue++; out.ok = false; log(`만료 예정이 지났는데 아직 있다: ${id}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return out;
}

// ── 복원 가능성 증명 ─────────────────────────────────────────────────────
// **`ready` 는 「올렸다」이고, 이것은 「받아서 풀고 실어 봤다」이다.** 둘을 같은 사실로
// 쓰면 복구가 필요한 날 복구되지 않는 사본을 믿고 있게 된다.
//
// 재현(2026-08-27 · K2): 옛 게이트는 `status='ready'` 중 **가장 최근 것**을 골라 나이만 봤다.
// 그래서 R2 객체가 없어도, 키 파일이 사라져도, 암호문이 망가져도, 안에 표가 빠져 있어도,
// **이전 유지보수 세대의 사본이어도** migration 이 그대로 진행됐다.
//
// 여기서 확인하는 것 전부(하나라도 못 하면 fail-closed):
//   ① 운영자가 **지정한 backup_id** 의 행이다(「가장 최근」을 고르지 않는다)
//   ② 상태가 `ready` 이고 영수증에 필요한 값이 다 있다
//   ③ 키 파일이 있고 **지문이 그때 쓴 키와 같다**
//   ④ R2 에 그 객체가 **지금** 있다(`--file` 로 받는다 · 크기 한도)
//   ⑤ 크기와 암호문 SHA-256 이 기록과 같다
//   ⑥ AES-GCM **인증** 복호화가 성공한다(태그가 맞다)
//   ⑦ 안쪽 manifest 의 backup_id 와 두 DB 해시가 기록과 같다
//   ⑧ 두 덤프를 **메모리 SQLite 에 실제로 싣는다** — 필수 표·인덱스까지 확인한다
//
// ⛔ **운영 DB 를 건드리지 않는다.** 이 함수가 내는 R2 명령은 `get` 하나이고, 적재는
//    `:memory:` 다. `restore` 하위 명령은 이 파일에 없고 앞으로도 넣지 않는다.
export async function verifyBackup({ backupId, env = process.env, now = Date.now(),
                                     run = realRunner, inventory, log = () => {} } = {}) {
  const bad = (code, extra = {}) => { log(`복원 검증 실패: ${code}`); return { ok: false, code, ...extra }; };
  if (!HEX32.test(String(backupId || ""))) return bad("no_backup_id");
  const { cfg, miss } = readConfig(env);
  if (miss.length) return bad("config", { missing: miss });
  const k = await readKey(cfg);
  if (k.miss) return bad("key");

  const inv = inventory || makeInventory(cfg, run);
  let row;
  try { row = await inv.getRow(backupId); } catch { return bad("unreadable"); }
  if (!row) return bad("no_row");
  if (row.status !== "ready") return bad("not_ready", { status: row.status });
  for (const f of ["object_key", "object_bytes", "object_hash",
                   "main_db_hash", "ledger_db_hash", "maintenance_epoch", "key_fingerprint"]) {
    if (row[f] === null || row[f] === undefined) return bad("incomplete", { field: f });
  }
  // ③ 키가 바뀌었으면 이 사본은 **우리가 못 연다.** 열어 보기 전에 말한다.
  if (String(row.key_fingerprint) !== k.fingerprint) return bad("key_rotated");
  if (Number(row.object_bytes) > MAX_VERIFY_BYTES) return bad("too_large");

  const dir = await mkdtemp(path.join(tmpdir(), "shhh-verify-"));
  try {
    const dest = path.join(dir, "obj.bin");
    const state = await probeObject(run, cfg, String(row.object_key), dest);
    if (state !== "present") return bad(state === "absent" ? "object_absent" : "object_unknown");
    if ((await stat(dest)).size !== Number(row.object_bytes)) return bad("size_mismatch");
    if ((await sha256File(dest)) !== String(row.object_hash)) return bad("hash_mismatch");

    const parts = decryptBundle(await readFile(dest), k.key);
    if (parts.code) return bad(parts.code === "decrypt" ? "decrypt" : "shape");
    if (String(parts.header && parts.header.id) !== backupId) return bad("manifest_id");
    const mainHash = createHash("sha256").update(parts.main).digest("hex");
    const ledgerHash = createHash("sha256").update(parts.ledger).digest("hex");
    if (String(parts.header.main) !== mainHash || String(parts.header.ledger) !== ledgerHash)
      return bad("manifest_hash");
    if (mainHash !== String(row.main_db_hash) || ledgerHash !== String(row.ledger_db_hash))
      return bad("inventory_hash");

    for (const which of ["main", "ledger"]) {
      const r = await loadTemp(parts[which].toString("utf8"), which);
      if (!r.ok) return bad("load_" + which, { missing: r.missing });
    }
  } finally {
    // 평문도 암호문도 남기지 않는다.
    await rm(dir, { recursive: true, force: true });
  }

  // 영수증. **상태는 안 바꾼다** — 게이트는 이 값을 믿지 않고 사용 시점에 다시 잰다.
  try { await inv.setVerified(backupId, now, VERIFY_VERSION); }
  catch { return bad("receipt"); }
  log(`복원 검증 통과: ${backupId}`);
  return { ok: true, code: "verified", receipt: {
    backupId, verifiedAt: now, verifyVersion: VERIFY_VERSION,
    maintenanceEpoch: Number(row.maintenance_epoch), snapshotAt: Number(row.snapshot_at),
    objectKey: String(row.object_key), objectBytes: Number(row.object_bytes),
    objectHash: String(row.object_hash), keyFingerprint: k.fingerprint,
    mainDbHash: String(row.main_db_hash), ledgerDbHash: String(row.ledger_db_hash),
  } };
}

// ── migration 게이트 ─────────────────────────────────────────────────────
// **백업이 있다는 것을 확인만 한다.** 백업을 만들지도, migration 을 돌리지도 않는다.
// ⛔ 「방금 만든, 복원되는 것이 증명된 백업」이 없으면 0이 아닌 코드로 끝난다 —
//    그것이 migration 을 막는 방식이다.
//
// ⚠️ **운영자가 backup_id 를 직접 준다.** 「가장 최근 ready」를 자동으로 고르지 않는다:
//    고르면 사람이 승인하지 않은 사본으로 migration 이 진행되고, 그 사본이 이전 유지보수
//    세대의 것이어도 아무도 모른다.
export async function backupGate({ backupId, env = process.env, now = Date.now(),
                                   run = realRunner, inventory, log = () => {} } = {}) {
  const { cfg, miss } = readConfig(env);
  if (miss.length) { log(`백업 설정이 없다: ${miss.join(", ")}`); return { ok: false, code: "config" }; }
  if (!HEX32.test(String(backupId || ""))) {
    log("검증할 backup_id 를 지정해야 한다");
    return { ok: false, code: "no_backup_id" };
  }
  const inv = inventory || makeInventory(cfg, run);
  let row;
  try { row = await inv.getRow(backupId); }
  catch { log("백업 상태를 못 읽었다"); return { ok: false, code: "unreadable" }; }
  if (!row) { log("그 backup_id 가 없다"); return { ok: false, code: "no_row" }; }
  if (row.status !== "ready") { log("그 백업은 ready 가 아니다"); return { ok: false, code: "not_ready" }; }

  const age = now - Number(row.snapshot_at);
  if (!(age >= 0 && age <= GATE_MAX_AGE)) {
    log("그 백업이 너무 오래됐다");
    return { ok: false, code: "stale", ageMs: age };
  }

  // **지금도 멈춰 있나, 그리고 그 백업이 지금 세대의 것인가.**
  // ⚠️ 세대가 다르면 그 사본은 지금 상태의 복원본이 아니다 — 그 사이에 전환이 있었고,
  //    복원하면 그 전환 이후의 쓰기가 통째로 사라진다.
  const q = await quiescence({ cfg, run });
  if (!q.ok) { log(`두 DB 가 멈춘 상태가 아니다: ${q.why}`); return { ok: false, code: "quiescence", why: q.why }; }
  if (Number(q.epoch) !== Number(row.maintenance_epoch)) {
    log("그 백업은 이전 유지보수 세대의 것이다");
    return { ok: false, code: "epoch", epoch: Number(q.epoch), backupEpoch: Number(row.maintenance_epoch) };
  }

  // ⚠️ **영수증이 있다는 이유로 건너뛰지 않는다.** 검사와 사용은 같은 경계에 있어야 한다 —
  //    객체는 영수증을 쓴 뒤에도 사라지거나 바뀔 수 있다.
  const v = await verifyBackup({ backupId, env, now, run, inventory: inv, log });
  if (!v.ok) return { ok: false, code: v.code, field: v.field, missing: v.missing };
  return { ok: true, ageMs: age, receipt: v.receipt };
}

// ── CLI ──────────────────────────────────────────────────────────────────
// 함정 20·53: import 한 스크립트의 하단이 실행되면 안 된다.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // ⛔ **어느 하위 명령보다 먼저다.** 지원하지 않는 Node 에서 부분적으로 도는 것이 가장 나쁘다 —
  //    export 는 되고 검증만 안 되면, 검증 안 된 사본을 백업이라 부르게 된다.
  if (!nodeOk()) {
    console.error(`[backup] Node ${MIN_NODE} 이상이 필요합니다 (지금 ${process.versions.node}).`);
    console.error("[backup] nvm 을 쓰신다면 저장소 안에서 `nvm use` 하시면 됩니다 (.nvmrc).");
    process.exit(3);
  }
  const cmd = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const log = (m) => console.log("[backup]", m);
  if (cmd === "backup") {
    const r = await runBackup({ dryRun, log });
    console.log(JSON.stringify({ ok: r.ok, backupId: r.backupId, step: r.step, code: r.code }));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "reconcile") {
    const r = await reconcile({ log });
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "verify" || cmd === "gate") {
    // ⚠️ **backup_id 는 운영자가 준다.** `--id <32자리 hex>` 없이는 시작하지 않는다.
    const at = process.argv.indexOf("--id");
    const backupId = at > 0 ? process.argv[at + 1] : null;
    const r = cmd === "gate" ? await backupGate({ backupId, log })
                             : await verifyBackup({ backupId, log });
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } else {
    console.log("사용법: node scripts/backup.mjs backup [--dry-run] | reconcile"
              + " | verify --id <backup_id> | gate --id <backup_id>");
    console.log("  backup  두 DB 를 내보내고 검증·암호화·업로드한다. migration 은 실행하지 않는다.");
    console.log("  reconcile inventory 와 R2 의 실제를 맞춘다. 부재를 확인한 행만 닫는다.");
    console.log("          모르는 행·만료 초과·해시 불일치가 있으면 0이 아닌 코드로 끝난다.");
    console.log("  verify  그 백업을 실제로 받아 풀고 임시 SQLite 에 실어 본다. 운영 DB 는 안 만진다.");
    console.log("  gate    지정한 백업이 지금 세대의 것이고 실제로 복원되는지 본다.");
    console.log("          ⛔ restore 는 없다. 이 도구는 되돌리지 않는다.");
    process.exit(2);
  }
}
