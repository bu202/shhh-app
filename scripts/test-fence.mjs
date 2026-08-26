// 주 D1 **구조적 fencing** 의 아키텍처 검사와 동작 검사.
//
// 왜 별도 스위트인가: 방어가 「모든 문장이 술어를 들고 있다」는 **전수 성질**이라, 한 자리만
// 빠져도 그 자리가 곧 우회로다. 사람이 기억해서 지키는 규칙은 반드시 낡는다 —
// 어기면 검사가 실패해야 한다(아키텍처 피트니스 함수).
//
// ⚠️ **정규식 하나로 끝내지 않는다**(2026-08-25 · 원칙 9). 이 파일은
//   ① 주석·문자열을 인식하는 토크나이저로 `prepare()` 의 SQL 리터럴과 **어느 바인딩에 붙었는지**를
//      뽑고,
//   ② `worker/schema.sql` 에서 **사용자 데이터 표 목록을 파생**해(손으로 적지 않는다)
//   ③ 둘을 대조한다. 사용자 데이터 표를 만지는 문장은 `{FENCE}` 를 들고 있어야 하고,
//      예외는 **이유와 함께** 이 파일에 등재돼야 한다.
//   ④ `worker/` 아래 모든 파일이 분류표에 있는지도 본다 — 새 파일로 우회하는 길을 막는다.
//   ⑤ 동적 디스패치(`env[binding]`)도 값까지 따라가 검사한다.
// AST 파서를 쓰지 않는 이유는 이 저장소에 파서 의존성이 없고 그걸 위해 하나 들이는 것이
// 「의존성 0」 방침과 어긋나기 때문이다. **완전한 증명은 아니다** — 빠뜨림을 줄이는 장치다.
import "./_workers-shim.mjs";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { makeD1, makeLedger, asRequest } from "./_d1.mjs";
import { acquireLease, releaseLease, LEASE_TTL } from "../worker/ledger.js";
import { withFence, FenceMismatch, FENCE_MARK } from "../worker/fence.js";
import { setMode, fenceEpoch, fenceInSync, resumeTransition,
         resolveStaleLeases, RESOLUTION_GRACE } from "../worker/ops.js";
import { drainState, CONFIRMED_RETENTION } from "../worker/ledger.js";

let n = 0;
const t = (m) => { n++; return m; };
const R = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// ── 주석을 뗀다(문자열 안의 `//` 는 주석이 아니다) ─────────────────────────
function stripComments(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") { out += src[i]; i++; }
        out += src[i]; i++;
      }
      out += src[i] || ""; i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else { out += c; i++; }
  }
  return out;
}

// ── `<receiver>.prepare(<문자열 리터럴>` 을 전부 뽑는다 ────────────────────
// 리터럴이 아닌 것(변수·연결식)은 `sql: null` 로 남겨 **따로 보고**한다 — 조용히 넘기면
// 그 자리가 검사 밖이다.
function preparedStatements(src) {
  const s = stripComments(src);
  const out = [];
  let i = 0;
  while ((i = s.indexOf(".prepare(", i)) !== -1) {
    // receiver: `.prepare` 앞의 식별자·점·대괄호를 뒤로 훑는다
    let j = i - 1;
    while (j >= 0 && /[\w$\].[]/.test(s[j])) {
      if (s[j] === "]") { while (j >= 0 && s[j] !== "[") j--; }
      j--;
    }
    const recv = s.slice(j + 1, i).trim();
    let k = i + ".prepare(".length;
    while (k < s.length && /\s/.test(s[k])) k++;
    const q = s[k];
    if (q === '"' || q === "'" || q === "`") {
      let m = k + 1, lit = "";
      while (m < s.length && s[m] !== q) {
        if (s[m] === "\\") { lit += s[m + 1]; m += 2; continue; }
        lit += s[m]; m++;
      }
      out.push({ recv, sql: lit, at: s.slice(0, i).split("\n").length });
    } else {
      out.push({ recv, sql: null, at: s.slice(0, i).split("\n").length });
    }
    i += ".prepare(".length;
  }
  return out;
}

// ── 사용자 데이터 표 목록을 **스키마에서 파생한다** ───────────────────────
// 손으로 적으면 표가 늘 때마다 낡는다. `write_fence` 만 뺀다 — 그것은 fence 자신이다.
const USER_TABLES = [...R("worker/schema.sql").matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
  .map((m) => m[1]).filter((x) => x !== "write_fence");
assert.ok(USER_TABLES.length >= 6,
  t(`fence: 스키마에서 사용자 데이터 표를 못 뽑았다 (${USER_TABLES.length}개)`));

const touchesUserTable = (sql) =>
  USER_TABLES.some((tb) => new RegExp(`\\b${tb}\\b`).test(sql));

// ── worker/ 아래 파일 전수 분류 (§10-9-6 의 A~D) ──────────────────────────
// 새 파일이 생기면 여기 이름을 올려야 한다 — 안 올리면 실패한다.
const CLASSIFIED = {
  "worker/index.js":         "A-1 온라인 workload — 요청 임차증을 들고 fence 를 지난다",
  "worker/cleanup/index.js": "A-2 온라인 workload(cron) — 같은 임차증·같은 fence",
  "worker/ops.js":           "B 운영 명령 — 임차증을 씌우지 않는다. 주 D1 쓰기는 fence 예외 하나뿐",
  "worker/ledger.js":        "ledger 전용 — 주 D1 을 만지지 않는다",
  "worker/fence.js":         "D fence 통로 — 술어를 붙이는 곳 자신",
  "worker/policies.js":      "빌드 산출 상수 — DB 를 만지지 않는다",
};

// ── 예외: 사용자 데이터 표를 만지지만 fence 를 안 지나는 자리 ─────────────
// **이유 없이 늘리지 않는다.** 하나 늘 때마다 그 자리가 방어 밖이다.
const EXCEPTIONS = [
  {
    file: "worker/index.js", must: /SELECT \(SELECT COUNT\(\*\) FROM users\)/,
    why: "C 공개 상태 확인 — `/ready` 의 스키마 실질의. COUNT 집계만이고 **행 내용을 응답하지 않는다**. "
       + "임차증도 fence 도 없이 답해야 하는 이유는, 복원 중에도 운영자가 상태를 볼 창구가 "
       + "하나는 있어야 하기 때문이다. 이 문장이 사용자 데이터를 밖으로 내보내면 예외가 깨진다.",
  },
  {
    file: "worker/ops.js", must: /SELECT id FROM users/,
    why: "B 운영 명령 — reconciliation·재개방 판정의 근거 수집. 임차증을 씌우면 복원 작업이 "
       + "자기 게이트에 막힌다(§10-9-6 B). 읽기 전용이고 사용자에게 응답하지 않는다.",
  },
];

// ══ 1. worker/ 아래 모든 파일이 분류돼 있다 ════════════════════════════════
{
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL("../" + dir, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(dir + "/" + e.name);
      else if (e.name.endsWith(".js")) files.push(dir + "/" + e.name);
    }
  };
  walk("worker");
  for (const f of files)
    assert.ok(CLASSIFIED[f],
      t(`fence: ${f} 가 §10-9-6 분류에 없다 — 새 파일로 fence 를 우회하는 길이 생겼다`));
  for (const f of Object.keys(CLASSIFIED))
    assert.ok(files.includes(f), t(`fence: 분류표에 없는 파일이 적혀 있다: ${f}`));
}

// ══ 2. ★ 사용자 데이터 표를 만지는 모든 문장이 {FENCE} 를 든다 ═════════════
{
  const offenders = [];
  for (const f of Object.keys(CLASSIFIED)) {
    for (const st of preparedStatements(R(f))) {
      // ledger 바인딩은 자기 FENCE(lease_id + epoch)를 쓴다 — 주 D1 fence 와 다른 이야기다.
      if (/LEDGER/.test(st.recv)) continue;
      if (st.sql === null) {
        // 리터럴이 아니다. 동적 디스패치는 아래 4번이 값까지 따라가 검사한다.
        continue;
      }
      if (!touchesUserTable(st.sql)) continue;
      if (st.sql.includes(FENCE_MARK)) continue;
      if (EXCEPTIONS.some((x) => x.file === f && x.must.test(st.sql))) continue;
      offenders.push(`${f}:${st.at} [${st.recv}] ${st.sql.replace(/\s+/g, " ").trim().slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [],
    t("fence: 사용자 데이터 표를 만지는데 {FENCE} 가 없는 문장이 있다:\n      " + offenders.join("\n      ")));
}

// ══ 3. 예외는 **실재해야** 한다 (죽은 예외를 남겨 두지 않는다) ═════════════
{
  for (const x of EXCEPTIONS) {
    const hit = preparedStatements(R(x.file)).some((st) => st.sql && x.must.test(st.sql));
    assert.ok(hit, t(`fence: 예외가 가리키는 문장이 ${x.file} 에 없다 — 낡은 예외는 지운다`));
    assert.ok(x.why.length > 60, t("fence: 예외에 이유가 없다"));
  }
}

// ══ 4. 동적 디스패치(`env[binding]`)도 값까지 따라간다 ═════════════════════
// `worker/cleanup/index.js` 의 JOBS 는 `["표이름", "DB"|"LEDGER", sql]` 이다. 정규식으로
// `env.DB` 를 찾는 검사는 이 모양을 **통째로 놓친다**(그래서 원칙 9 가 따로 짚었다).
{
  const src = stripComments(R("worker/cleanup/index.js"));
  const jobs = [...src.matchAll(/\[\s*"(\w+)"\s*,\s*"(DB|LEDGER)"\s*,\s*`([\s\S]*?)`/g)];
  assert.ok(jobs.length >= 4, t(`fence: cleanup 의 JOBS 를 못 읽었다 (${jobs.length}개)`));
  for (const [, name, binding, sql] of jobs) {
    if (binding !== "DB") continue;
    assert.ok(sql.includes(FENCE_MARK),
      t(`fence: cleanup 의 주 D1 정리 대상 '${name}' 이 {FENCE} 없이 지운다`));
  }
  // 주 D1 을 만지는 JOB 이 실제로 있어야 이 검사가 뜻이 있다.
  assert.ok(jobs.some(([, , b]) => b === "DB"),
    t("fence: cleanup 에 주 D1 대상이 하나도 없다 — 검사가 헛돈다"));
}

// ══ 5. fence 를 **쓰는** 자리는 운영 예외 하나뿐이다 (원칙 6) ══════════════
{
  let writes = [];
  for (const f of Object.keys(CLASSIFIED)) {
    const src = stripComments(R(f));
    for (const m of src.matchAll(/(UPDATE|INSERT INTO|DELETE FROM)\s+write_fence/g))
      writes.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
  }
  assert.equal(writes.length, 1,
    t(`fence: write_fence 를 바꾸는 자리가 ${writes.length}곳이다 (${writes.join(", ")}) — 하나여야 한다`));
  assert.ok(writes[0].startsWith("worker/ops.js"),
    t(`fence: write_fence 를 바꾸는 자리가 ops.js 가 아니다: ${writes[0]}`));
  // 그 함수는 **export 되지 않는다** — 일반 코드가 부를 수 있으면 그게 곧 우회로다.
  const ops = stripComments(R("worker/ops.js"));
  assert.ok(/\n\s*async function setFenceEpoch\(/.test(ops),
    t("fence: setFenceEpoch 가 없다"));
  assert.ok(!/export\s+async\s+function\s+setFenceEpoch\(/.test(ops),
    t("fence: setFenceEpoch 가 export 됐다 — 일반 코드가 fence 를 임의로 옮길 수 있다"));
}

// ══ 5-1. ★ `_raw` 탈출구는 **fence 자신만** 쓴다 ═══════════════════════════
// `withFence()` 가 감싼 바인딩에 `_raw` 를 남겨 뒀다(fence 행 자체를 읽어야 하므로).
// 그 이름을 아무 데서나 쓰면 **모든 술어를 건너뛰는 우회로**가 된다 — 한 줄이면 충분하다.
{
  const uses = [];
  for (const f of Object.keys(CLASSIFIED)) {
    const src = stripComments(R(f));
    for (const m of src.matchAll(/\._raw\b/g))
      uses.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
  }
  assert.ok(uses.every((u) => u.startsWith("worker/fence.js")),
    t(`fence: fence.js 밖에서 _raw 를 쓴다 (${uses.join(", ")}) — 술어를 통째로 건너뛰는 길이다`));
}

// ══ 6. 요청 경로가 **감싼 env** 를 넘긴다 ══════════════════════════════════
{
  const src = stripComments(R("worker/index.js"));
  assert.ok(/const denv = lease \? withFence\(env, lease\) : env;/.test(src),
    t("fence: 요청 경로가 withFence 로 감싸지 않는다"));
  assert.ok(/route\(req, denv,/.test(src),
    t("fence: route 에 감싸지 않은 env 를 넘긴다 — 그 요청의 주 D1 문장은 fence 밖이다"));
  assert.ok(/instanceof FenceMismatch/.test(src),
    t("fence: FenceMismatch 를 503 으로 바꾸는 자리가 없다"));
}

// ══ 7. 동작 — 옛 epoch 은 **읽기도 쓰기도** 실패한다 (원칙 1·5) ════════════
const makeEnv = () => ({ DB: makeD1(), LEDGER: makeLedger() });
{
  const env = makeEnv();
  // 계정 하나를 정상 경로로 만든다.
  await asRequest(env, async (fe) => {
    await fe.DB.prepare("INSERT INTO users (id, provider, provider_subject, session_version, created_at) SELECT ?, ?, ?, 0, ? WHERE {FENCE}")
      .bind("u1", "kakao", "s1", 1).run();
  });
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 1,
    t("fence: 정상 경로인데 계정이 안 생겼다"));

  // 옛 epoch 을 든 요청을 만든다: lease 를 딴 **뒤** 전환한다.
  const stale = await acquireLease(env);
  await setMode(env, "maintenance");
  const fenced = withFence(env, stale);

  // ★ 쓰기 — 0행이고 FenceMismatch 다.
  await assert.rejects(
    () => fenced.DB.prepare("DELETE FROM users WHERE id = ? AND {FENCE}").bind("u1").run(),
    (e) => e instanceof FenceMismatch,
    t("fence: 옛 epoch 의 쓰기가 FenceMismatch 를 안 냈다"));
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 1,
    t("fence: 옛 epoch 의 요청이 실제로 계정을 지웠다 — 구조적 fencing 이 안 걸렸다"));

  // ★ 읽기 — 같은 규칙이다(원칙 1: 복원된 탈퇴자 데이터를 옛 요청이 읽으면 안 된다).
  await assert.rejects(
    () => fenced.DB.prepare("SELECT id FROM users WHERE id = ? AND {FENCE}").bind("u1").first(),
    (e) => e instanceof FenceMismatch,
    t("fence: 옛 epoch 의 읽기가 통과했다 — 복원된 데이터를 그대로 읽어 돌려줄 수 있다"));
  await assert.rejects(
    () => fenced.DB.prepare("SELECT id FROM users WHERE {FENCE}").all(),
    (e) => e instanceof FenceMismatch,
    t("fence: 옛 epoch 의 목록 읽기가 통과했다"));

  // ★ batch — 전부 막힌다.
  await assert.rejects(
    () => fenced.DB.batch([
      fenced.DB.prepare("DELETE FROM users WHERE id = ? AND {FENCE}").bind("u1"),
      fenced.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND {FENCE}").bind("u1"),
    ]),
    (e) => e instanceof FenceMismatch,
    t("fence: 옛 epoch 의 batch 가 통과했다"));
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) n FROM users").get().n, 1,
    t("fence: 옛 epoch 의 batch 가 실제로 지웠다"));
  await releaseLease(env, stale);
}

// ══ 8. ★ 정상 비즈니스 0행은 **오류가 아니다** (원칙 2) ════════════════════
// 여기가 「fence 불일치」와 「정상 0행」을 가르는 자리다. 뭉뚱그렸다면 멱등 DELETE 와
// ON CONFLICT DO NOTHING 이 전부 503 이 되어 기존 HTTP 상태와 멱등성이 바뀐다.
{
  const env = makeEnv();
  await asRequest(env, async (fe) => {
    // 없는 행을 지운다 — 0행이지만 fence 는 지금 것이다.
    const r = await fe.DB.prepare("DELETE FROM users WHERE id = ? AND {FENCE}").bind("없음").run();
    assert.equal(r.meta.changes, 0, t("fence: 없는 행을 지웠는데 changes 가 0이 아니다"));

    // 없는 행을 읽는다 — null 이지만 오류가 아니다.
    const row = await fe.DB.prepare("SELECT id FROM users WHERE id = ? AND {FENCE}").bind("없음").first();
    assert.equal(row, null, t("fence: 없는 행 조회가 null 이 아니다"));

    // 빈 목록도 오류가 아니다.
    const all = await fe.DB.prepare("SELECT id FROM users WHERE {FENCE}").all();
    assert.deepEqual(all.results, [], t("fence: 빈 목록 조회가 빈 배열이 아니다"));

    // 멱등 INSERT — 두 번째는 0행이고 그래도 정상이다.
    const ins = "INSERT INTO users (id, provider, provider_subject, session_version, created_at) "
              + "SELECT ?, ?, ?, 0, ? WHERE {FENCE} ON CONFLICT (provider, provider_subject) DO NOTHING";
    await fe.DB.prepare(ins).bind("a1", "kakao", "dup", 1).run();
    const again = await fe.DB.prepare(ins).bind("a2", "kakao", "dup", 1).run();
    assert.equal(again.meta.changes, 0, t("fence: ON CONFLICT DO NOTHING 이 0행이 아니다"));
  });
}

// ══ 9. {FENCE} 를 빠뜨린 문장은 **던진다** ═════════════════════════════════
{
  const env = makeEnv();
  await asRequest(env, async (fe) => {
    assert.throws(() => fe.DB.prepare("SELECT id FROM users WHERE id = ?"),
      /must contain/, t("fence: {FENCE} 없는 문장이 조용히 통과했다"));
    // batch 에 감싸지 않은 문장을 섞으면 던진다.
    await assert.rejects(() => fe.DB.batch([env.DB.prepare("SELECT 1")]),
      /unfenced statement/, t("fence: batch 에 감싸지 않은 문장이 섞였는데 통과했다"));
  });
}

// ══ 10. 전환 프로토콜 — 각 단계 직후에 죽어도 이어서 끝난다 (원칙 4) ═══════
{
  // ① `started` 에서 죽음: fence 는 아직 안 옮겨졌고 문은 닫혀 있다.
  const env = makeEnv();
  const before = await fenceEpoch(env);
  const cur = env.LEDGER._db.prepare("SELECT * FROM maintenance WHERE id = 1").get();
  env.LEDGER._db.prepare(
    "UPDATE maintenance SET pending_transition = 'tr-1' WHERE id = 1").run();
  env.LEDGER._db.prepare(
    `INSERT INTO transitions (transition_id, source_epoch, target_epoch, target_mode, state, started_at, updated_at)
     VALUES ('tr-1', ?, ?, 'maintenance', 'started', 1, 1)`).run(cur.epoch, cur.epoch + 1);
  // 문이 닫혔으므로 새 lease 가 안 나온다 — 그것이 1단계의 목적이다.
  assert.equal(await acquireLease(env), null,
    t("fence: 전환 중인데 새 임차증이 나왔다 — 전환 도중에 옛 epoch 요청이 계속 들어온다"));
  assert.equal(await fenceEpoch(env), before,
    t("fence: started 단계인데 fence 가 이미 움직였다"));
  assert.equal(await fenceInSync(env), false,
    t("fence: 전환 중인데 in-sync 라고 답한다 — 그 상태는 fail-closed 여야 한다"));

  // 같은 명령을 다시 실행하면 **이어서 끝난다.**
  const g = await setMode(env, "maintenance");
  assert.equal(g.mode, "maintenance", t("fence: 중단된 전환을 이어서 못 끝냈다"));
  assert.equal(await fenceInSync(env), true, t("fence: 이어서 끝냈는데 두 DB 가 안 맞는다"));
  assert.equal(await fenceEpoch(env), g.epoch, t("fence: fence 와 ledger epoch 이 다르다"));
}
{
  // ② `fence_set` 에서 죽음: fence 는 옮겨졌고 ledger 는 아직이다. **어긋난 상태**다.
  const env = makeEnv();
  const cur = env.LEDGER._db.prepare("SELECT * FROM maintenance WHERE id = 1").get();
  const target = cur.epoch + 1;
  env.LEDGER._db.prepare("UPDATE maintenance SET pending_transition = 'tr-2' WHERE id = 1").run();
  env.LEDGER._db.prepare(
    `INSERT INTO transitions (transition_id, source_epoch, target_epoch, target_mode, state, started_at, updated_at)
     VALUES ('tr-2', ?, ?, 'maintenance', 'fence_set', 1, 1)`).run(cur.epoch, target);
  env.DB._db.prepare("UPDATE write_fence SET epoch = ? WHERE id = 1").run(target);
  // 이 상태에서는 **아무도 주 D1 을 못 만진다** — 새 lease 도 안 나오고, in-sync 도 아니다.
  assert.equal(await fenceInSync(env), false,
    t("fence: fence_set 에서 죽은 상태를 in-sync 라고 답한다"));
  assert.equal(await acquireLease(env), null, t("fence: fence_set 에서 죽었는데 임차증이 나왔다"));
  // 이어서 끝낸다.
  const g = await resumeTransition(env,
    { transition_id: "tr-2", source_epoch: cur.epoch, target_epoch: target, target_mode: "maintenance", state: "fence_set" });
  assert.equal(g.epoch, target, t("fence: 이어 끝냈는데 ledger epoch 이 target 이 아니다"));
  assert.equal(await fenceInSync(env), true, t("fence: 이어 끝냈는데 두 DB 가 안 맞는다"));
  // **멱등이다** — 한 번 더 돌려도 같다.
  await resumeTransition(env,
    { transition_id: "tr-2", source_epoch: cur.epoch, target_epoch: target, target_mode: "maintenance", state: "fence_set" });
  assert.equal(await fenceEpoch(env), target, t("fence: 재실행이 fence 를 또 움직였다"));
}
{
  // ③ 정상 전환 뒤에는 두 DB 가 맞고 새 lease 가 새 epoch 을 단다.
  const env = makeEnv();
  const g = await setMode(env, "maintenance");
  const l = await acquireLease(env);
  assert.ok(l, t("fence: 전환이 끝났는데 임차증이 안 나온다"));
  assert.equal(l.epoch, g.epoch, t("fence: 새 임차증의 epoch 이 전환 결과와 다르다"));
  assert.equal(await fenceEpoch(env), l.epoch, t("fence: fence 가 새 epoch 을 안 따라갔다"));
  await releaseLease(env, l);
}

// ══ 11. stale lease 의 안전한 해제 (원칙 7) ════════════════════════════════
//
// 재현(고치기 전): 해제가 실패해 남은 행 하나가 `stale` 로 영원히 세어져 `drained` 가 계속
// 거짓이고 `markDrained()`·reconciliation 이 **영구히 막혔다.** fail-closed 방향은 옳지만
// 복구할 길이 없는 것은 운영 결함이다. 그런데 해제의 근거가 「시간이 지났다」면 안 된다 —
// 그건 증명이 아니라 가정이다. 근거는 **구조적 fencing**(옛 epoch 은 두 DB 어디에도 못 쓴다)이고,
// `expires_at + 15분` 은 그 위의 운영 완충일 뿐이다.
{
  const GRACE = RESOLUTION_GRACE;
  // stale 임차증 하나를 **실제로** 만든다: 임차증을 딴 뒤 해제가 실패한 상황.
  const withStale = async () => {
    const env = makeEnv();
    const lease = await acquireLease(env);
    await setMode(env, "maintenance");              // epoch 이 오른다 → 이 임차증은 옛 epoch 이다
    // 해제 실패를 흉내내지 않고 **그냥 안 푼다** — 그것이 stale 의 정의다.
    return { env, lease };
  };
  const leaseCount = (env) => env.LEDGER._db.prepare("SELECT COUNT(*) n FROM write_leases").get().n;
  const resCount = (env) => env.LEDGER._db.prepare("SELECT COUNT(*) n FROM lease_resolutions").get().n;
  const ok = { operatorRef: "ops-2026-09-01", reasonCode: "worker_terminated" };
  // 만료(획득 + LEASE_TTL)에 운영 완충까지 지난 시점.
  // ⚠️ 이 값은 **테스트가 시계를 앞당기는 것**이지 안전 근거가 아니다 — 안전 근거는 epoch 이다.
  const past = () => Date.now() + LEASE_TTL + GRACE + 1000;

  // ── a. ★ `open` 에서는 절대 해제하지 않는다.
  {
    const env = makeEnv();
    const l = await acquireLease(env);
    const r = await resolveStaleLeases(env, { ...ok, now: past() });
    assert.equal(r.ok, false, t("fence: open 인데 stale 해제가 실행됐다"));
    assert.match(r.why, /모드가 open/, t("fence: open 거부 사유가 모드가 아니다"));
    assert.equal(leaseCount(env), 1, t("fence: 거부했는데 임차증이 사라졌다"));
    await releaseLease(env, l);
  }

  // ── b. ★ live lease 가 있으면 거부한다.
  {
    const { env } = await withStale();
    const live = await acquireLease(env);            // 현재 epoch 의 임차증
    assert.ok(live, t("fence: maintenance 에서 임차증을 못 땄다"));
    const r = await resolveStaleLeases(env, { ...ok, now: past() });
    assert.equal(r.ok, false, t("fence: live lease 가 있는데 해제했다"));
    assert.match(r.why, /살아 있다/, t("fence: 거부 사유가 live lease 가 아니다"));
    assert.equal(resCount(env), 0, t("fence: 거부했는데 기록이 남았다"));
    await releaseLease(env, live);
  }

  // ── c. ★ 완충이 안 지났으면 대상이 아니다.
  {
    const { env } = await withStale();
    const r = await resolveStaleLeases(env, { ...ok, now: Date.now() });
    assert.equal(r.ok, true, t("fence: 대상이 없는 것은 실패가 아니다"));
    assert.equal(r.resolved, 0, t("fence: 완충 전인데 해제됐다"));
    assert.equal(leaseCount(env), 1, t("fence: 완충 전인데 임차증이 사라졌다"));
  }

  // ── d. ★ 두 DB 의 epoch 이 어긋나면 거부한다 (전환이 안 끝난 상태).
  {
    const { env } = await withStale();
    env.DB._db.prepare("UPDATE write_fence SET epoch = epoch + 5 WHERE id = 1").run();
    const r = await resolveStaleLeases(env, { ...ok, now: past() });
    assert.equal(r.ok, false, t("fence: 두 DB 가 어긋났는데 해제했다"));
    assert.match(r.why, /fence|전환/, t("fence: 거부 사유가 fence 불일치가 아니다"));
  }

  // ── e. ★ 전환이 진행 중이면 거부한다.
  {
    const { env } = await withStale();
    env.LEDGER._db.prepare("UPDATE maintenance SET pending_transition = 'tr-x' WHERE id = 1").run();
    const r = await resolveStaleLeases(env, { ...ok, now: past() });
    assert.equal(r.ok, false, t("fence: 전환 중인데 해제했다"));
  }

  // ── f. ★ 허용되지 않은 reason_code · 식별 가능한 operator_ref 는 거부한다.
  {
    const { env } = await withStale();
    for (const bad of ["", "그냥", "worker terminated", "custom-reason", null, undefined]) {
      const r = await resolveStaleLeases(env, { operatorRef: "ops-x1", reasonCode: bad, now: past() });
      assert.equal(r.ok, false, t(`fence: 허용되지 않은 reason_code 가 통과했다: ${bad}`));
    }
    for (const bad of ["someone@example.com", "홍길동", "a", "", null, "OPS-2026", "x".repeat(60)]) {
      const r = await resolveStaleLeases(env, { operatorRef: bad, reasonCode: "release_failed", now: past() });
      assert.equal(r.ok, false, t(`fence: 비식별 라벨이 아닌 operator_ref 가 통과했다: ${bad}`));
    }
    assert.equal(resCount(env), 0, t("fence: 거부했는데 기록이 남았다"));
  }

  // ── g. ★ 조건이 모두 맞으면 해제되고, **최소 항목만** 기록된다.
  {
    const { env, lease } = await withStale();
    const before = env.LEDGER._db.prepare("SELECT * FROM write_leases").get();
    const r = await resolveStaleLeases(env, { ...ok, now: past() });
    assert.equal(r.ok, true, t(`fence: 조건이 맞는데 해제가 거부됐다: ${r.why}`));
    assert.equal(r.resolved, 1, t("fence: 해제 건수가 1이 아니다"));
    assert.equal(leaseCount(env), 0, t("fence: 해제했는데 임차증이 남았다"));

    const row = env.LEDGER._db.prepare("SELECT * FROM lease_resolutions").get();
    assert.equal(row.lease_id, lease.id, t("fence: 기록의 lease_id 가 다르다"));
    assert.equal(row.epoch, before.epoch, t("fence: 기록의 epoch 이 그 lease 의 epoch 이 아니다"));
    assert.equal(row.reason_code, ok.reasonCode, t("fence: reason_code 가 안 적혔다"));
    assert.equal(row.operator_ref, ok.operatorRef, t("fence: operator_ref 가 안 적혔다"));
    // ⚠️ **보유 만료가 확정 표식과 같은 규칙(37일)이다.**
    assert.equal(row.expires_keep - row.resolved_at, CONFIRMED_RETENTION,
      t("fence: 해제 기록의 보유기간이 CONFIRMED_RETENTION 과 다르다"));
    // ⛔ **개인정보가 될 수 있는 칸이 없다.** 표 정의 자체를 검사한다 — 나중에 컬럼을 더하면
    //    여기서 걸린다.
    const cols = env.LEDGER._db.prepare("PRAGMA table_info(lease_resolutions)").all().map((c) => c.name);
    assert.deepEqual(cols.sort(),
      ["epoch", "expires_at", "expires_keep", "lease_id", "operator_ref", "reason_code", "resolved_at", "started_at"],
      t("fence: 해제 기록의 컬럼 구성이 승인된 최소 항목과 다르다"));
    for (const banned of ["ip", "uid", "user", "path", "note", "reason_text", "request"])
      assert.ok(!cols.some((c) => c.includes(banned)),
        t(`fence: 해제 기록에 '${banned}' 를 담는 칸이 생겼다 — 승인 범위 밖이다`));

    // ★ 해제한 **뒤에야** drain 이 된다.
    assert.equal((await drainState(env)).drained, true,
      t("fence: stale 을 해제했는데 여전히 drain 이 아니다 — 복구가 안 된 것이다"));
    // 자물쇠는 풀려 있어야 한다.
    assert.equal(
      env.LEDGER._db.prepare("SELECT pending_transition p FROM maintenance WHERE id = 1").get().p, null,
      t("fence: 해제 뒤에 신규 lease 자물쇠가 안 풀렸다"));
  }

  // ── h. ★ 처리 도중 경합하면 **아무것도 확정하지 않는다.**
  {
    const { env } = await withStale();
    const realBatch = env.LEDGER.batch.bind(env.LEDGER);
    env.LEDGER.batch = async (stmts) => {
      // 판정과 삭제 사이에 다른 운영자가 전환했다.
      env.LEDGER._db.prepare("UPDATE maintenance SET epoch = epoch + 1 WHERE id = 1").run();
      return realBatch(stmts);
    };
    const r = await resolveStaleLeases(env, { ...ok, now: past() });
    env.LEDGER.batch = realBatch;
    assert.equal(r.ok, false, t("fence: 처리 도중 경합했는데 성공으로 끝났다"));
    assert.equal(leaseCount(env), 1, t("fence: 경합했는데 임차증이 지워졌다"));
  }

  // ── i. ★ ledger 가 답하지 않으면 fail-closed 다.
  {
    const { env } = await withStale();
    const broken = { ...env, LEDGER: { prepare: () => { throw new Error("ledger down"); } } };
    const r = await resolveStaleLeases(broken, { ...ok, now: past() });
    assert.equal(r.ok, false, t("fence: ledger 가 죽었는데 해제가 통과했다"));
  }

  // ── j. cleanup 이 stale lease 를 **자동으로 지우지 않는다**(운영자 명령만).
  {
    const src = R("worker/cleanup/index.js");
    assert.ok(!/DELETE FROM write_leases/.test(src),
      t("fence: 정리 크론이 stale 임차증을 자동으로 지운다 — 증거가 시간으로 사라진다"));
  }
}

// ══ 12. 검사 파일 자체에 **보이지 않는 제어문자**가 없다 ═══════════════════
//
// 왜 이것을 재나: 2026-08-25 에 5-1 검사의 정규식이 `/\._raw\b/` 로 보였는데 실제 바이트에는
// `\b` 자리에 **백스페이스(0x08)** 가 들어 있었다(문자열을 만든 도구가 `\b` 를 이스케이프로
// 해석했다). 그래서 그 검사는 **아무것도 매치하지 않으면서 통과**했다 — diff 로도, 터미널
// 출력으로도 보이지 않는다. 우회로를 막으라고 만든 검사가 조용히 죽어 있는 것이
// 우회로 자체보다 나쁘다.
// ⛔ 허용하는 것은 데이터 수집 스크립트의 **의도된 NUL 구분자** 하나뿐이다.
{
  // ⚠️ 돌연변이 실행기의 사본에는 `.git` 이 없다 — 원본 저장소 경로를 넘겨받는다
  //    (`scripts/deployed.mjs` 와 같은 규약). 목록은 원본에서 얻고 **내용은 여기서** 읽으므로,
  //    변이가 넣은 제어문자도 그대로 걸린다.
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const repo = process.env.SHHH_GIT_ROOT || fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: repo })
    .trim().split("\n");
  const ALLOW = new Set(["scripts/fetch-ksl.mjs"]);   // 합성 키의 NUL 구분자 — 의도된 것이다
  const offenders = [];
  for (const f of files) {
    if (ALLOW.has(f) || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|pdf|zip)$/i.test(f)) continue;
    let src; try { src = R(f); } catch { continue; }
    const hits = [...src.matchAll(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g)];
    if (hits.length) offenders.push(`${f} (${hits.length}개)`);
  }
  assert.deepEqual(offenders, [],
    t(`fence: 추적 파일에 보이지 않는 제어문자가 있다 — 정규식이 조용히 죽는다: ${offenders.join(", ")}`));
}

console.log(`test-fence: ${n}개 통과 — worker/ 전수 분류 · 사용자 데이터 문장의 {FENCE} 전수 ·`
  + ` 예외 실재와 이유 · cleanup 동적 디스패치 · write_fence 쓰기 1곳(미export) ·`
  + ` _raw 는 fence.js 안에서만 · 요청 경로의 withFence · 옛 epoch 은 읽기·쓰기·batch 전부 차단 ·`
  + ` 정상 0행은 오류가 아님(멱등 유지) · {FENCE} 누락은 예외 · 전환 프로토콜 재개(3단계) ·`
  + ` 검사 파일의 제어문자 0건 ·`
  + ` stale 해제 10조건(open 거부 · live lease · 완충 · epoch 불일치 · 전환 중 · 사유·라벨 ·`
  + ` 최소 기록과 보유기간 · 경합 시 원자적 실패 · ledger 장애 fail-closed · 크론 자동삭제 없음)`);
