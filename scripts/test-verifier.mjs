// 검증 장치 자체를 검증한다 (2026-08-28 위협 91·92 → 2026-08-29 위협 93·94).
//
// ⚠️ 왜 스위트가 하나 더 있나: 이 저장소의 완료 판정 근거는 **돌연변이 결과**다. 그런데
//    그 결과를 만드는 실행기가 조용히 고장 나면, 화면에는 아무 실패도 안 뜨고 **「아직 안
//    끝났다」**로만 보인다. 실제로 그랬다 —
//    · 위협 91: 변이 하나가 종료하지 않는 자식을 만들자 211종 검증이 통째로 멈췄고, 바깥에서
//      실행기를 죽여도 **손자가 CPU 를 먹으며 남았다.**
//    · 위협 92: 「모든 경계에서 교차시킨다」는 검사가 마지막 자리에서 **reconciliation 을 한 번도
//      안 돌리고** 통과했다.
//    · 위협 93: **없는 실행 파일**과 **바깥에서 온 signal** 이 조용히 `KILLED` 로 접혔다 —
//      `node` 를 못 띄우는 환경에서는 217종이 전부 사망 · 종료 코드 0 이었다.
//    · 위협 94: 직접 자식의 `close` 를 **그룹 부재**로 읽었다 — 재현에서 `close` 뒤에도
//      `kill(-pgid, 0)` 이 `alive` 였고 손자가 살아 있었다.
//    넷 다 **테스트가 통과하는 상태에서** 성립했다.
//
// ⛔ **4단계 기능이 도는지는 재지 않는다** — 그 둘을 섞지 않는다.
import assert from "node:assert";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, symlinkSync,
         rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWithTimeout, tally, classify, probeGroup, cleanupFailed, nextMutationAllowed,
         VERDICTS, FATAL, INFRA_ERROR, OUTCOMES, GROUP_STATES, KILLED_REQUIREMENTS,
         CLEANUP_DEADLINE_MS, GROUP_SETTLE_MS,
         GROUP_ESCAPE_MARK, GROUP_ESCAPE_PATTERNS, groupEscapeViolations,
         resultRow, JSON_EVIDENCE, baselineHalt, runBaselines,
         RUN_ROOT_ENV, RUN_ROOT_PREFIX, RUN_ROOT_MARKER,
         runRootUsable, childEnv, staleRunRoots } from "./_mutate-lib.mjs";
import { MUTATIONS } from "./mutations.mjs";

let n = 0;
const t = (m) => { n++; return m; };
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const repo = process.env.SHHH_GIT_ROOT || fileURLToPath(new URL("..", import.meta.url));
// 이 스위트가 만든 그룹만 기록해 두고 **끝에서 전수로 부재를 확인한다.**
// ⛔ 광범위한 종료 명령(`pkill`·`killall`)은 쓰지 않는다 — 사용자의 다른 작업을 죽인다.
// ⚠️ 오래 도는 fixture 에는 **자기 종료**를 함께 심는다(60초). 그룹 kill 을 없애는 변이가 걸리면
//    아래 정리 핸들러가 잡을 pgid 자체가 안 남을 수 있고, 그때 fixture 가 몇 시간씩 CPU 를 먹는다
//    (실측 2026-08-31: 4시간짜리 6개). ⛔ 단언의 창(≤1.5초)과는 두 자릿수 차이라 판정을 바꾸지 않는다.
const madeGroups = [];
const track = (r) => { if (Number.isInteger(r?.pgid) && r.pgid > 1) madeGroups.push(r.pgid); return r; };
// ⛔ **단언이 중간에 터져도 정리한다.** 이 스위트를 대상으로 하는 돌연변이는 정리 코드를 없애는
//    것들이라, 그 회차의 자식이 그대로 남으면 **다음 회차의 판정이 부하 때문인지 변이 때문인지
//    갈리지 않는다**(위협 91 이 겪은 그 상태다). 지우는 대상은 **우리가 만든 PGID 뿐**이다.
// ⛔ **임시 디렉터리도 같은 자리에서 치운다.** 이 스위트를 대상으로 하는 변이는 단언을 중간에
//    터뜨리므로, 만든 자리에서 지우는 코드는 **실패 회차마다 건너뛴다** — 실측으로 그렇게 6개가 쌓였다.
//    지우는 대상은 **우리가 만든 경로뿐**이다(접두사 훑기가 아니다).
const madeDirs = [];
const mkTmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); madeDirs.push(d); return d; };
process.on("exit", () => {
  for (const g of new Set(madeGroups)) {
    try { process.kill(-g, "SIGKILL"); } catch { /* 이미 없다 */ }
  }
  for (const d of madeDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 이미 없다 */ }
  }
});

// 합성 결과의 기준값 — 「전부 관측된 정상 실행」. 검사마다 필요한 칸만 덮어쓴다.
const base = () => ({
  started: true, status: 0, signal: null, timedOut: false, startTimedOut: false,
  spawnFailed: false, postSpawnError: false, out: "", pgid: 424242,
  closeSeen: true, groupState: "absent",
  residualGroupDetected: false, cleanupRequested: false, cleanupTimedOut: false,
});
const R = (o) => ({ ...base(), ...o });

// 가짜 자식 — **순서**를 관측하기 위한 것이다. 실제 프로세스로는 「spawn 전 타이머 만료」·
// 「kill 요청 실패」·「close 없이 정리 기한 초과」를 결정적으로 만들 수 없다.
function fakeChild(pid = 987654) {
  const ch = new EventEmitter();
  ch.pid = pid; ch.stdout = null; ch.stderr = null;
  return ch;
}
function killer(answer) {
  const calls = [];
  const k = (target, sig) => { calls.push([target, sig]); return answer(target, sig); };
  k.calls = calls;
  return k;
}
const err = (code) => { const e = new Error(code); e.code = code; return e; };
const gone = () => { throw err("ESRCH"); };
const alive = () => undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══ V1. 종료하지 않는 자식을 제한 시간 안에 죽인다 — **그룹째** ═══════════
// ⛔ `spawnSync({ timeout })` 은 직계 자식만 죽인다. 스위트가 손자를 띄우면(workerd) 그 손자는
//    남아서 다음 회차와 CPU 를 다툰다 — 그러면 뒤 회차의 판정이 부하 때문인지 변이 때문인지 갈리지 않는다.
// ⚠️ **2026-08-29 정정**: 옛 V1 은 **알고 있는 손자 하나**를 양수 PID 로 쟀다. 그것은 「그 손자가
//    죽었다」이지 **「그룹이 비었다」가 아니다**(위협 94). 이제 음수 PGID probe 로 잰다.
{
  const child = "const c=require('node:child_process')"
    + ".spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)'],{stdio:'ignore'});"
    + "console.log('GPID '+c.pid);setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000);";
  const t0 = Date.now();
  const r = track(await runWithTimeout(process.execPath, ["-e", child], { timeoutMs: 1500 }));
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true, t("V1: ★ 종료하지 않는 자식인데 timedOut 이 아니다"));
  assert.ok(took < 12_000, t(`V1: ★ 제한 시간(1.5초)이 지나도 ${took}ms 를 기다렸다`));
  assert.ok(/GPID \d+/.test(r.out), t("V1: 손자를 못 띄웠다 — 검사가 헛돈다"));
  assert.equal(r.closeSeen, true, t("V1: 직접 자식의 close 를 안 봤다"));
  assert.equal(r.groupState, "absent",
    t(`V1: ★ 반환 시점에 그룹이 ${r.groupState} 다 — 손자가 남았다`));
  assert.equal(probeGroup(r.pgid), "absent",
    t(`V1: ★ 반환 뒤에도 그룹 ${r.pgid} 가 살아 있다`));
  assert.equal(classify(r).verdict, "TIMEOUT", t("V1: 제한 시간 초과가 TIMEOUT 이 아니다"));
}

// ══ V2. 정상 종료는 그대로 통과시킨다 ══════════════════════════════════════
{
  const ok = track(await runWithTimeout(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 10_000 }));
  assert.equal(ok.timedOut, false, t("V2: 즉시 끝난 자식을 timeout 으로 적었다"));
  assert.equal(ok.status, 0, t(`V2: 종료 코드가 ${ok.status} 다`));
  const bad = track(await runWithTimeout(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 10_000 }));
  assert.equal(bad.status, 7, t(`V2: 종료 코드를 안 그대로 준다 (${bad.status})`));
  assert.equal(bad.timedOut, false, t("V2: 실패한 자식을 timeout 으로 적었다"));
}

// ══ V3. TIMEOUT·INFRA-ERROR 를 KILLED 로 접지 않는다 ═══════════════════════
// 합치는 순간 **종료하지 않는 변이가 곧 만점**이 된다. 그것이 위협 91·93 의 핵심이다.
{
  assert.ok(VERDICTS.includes("TIMEOUT"), t("V3: ★ TIMEOUT 판정 자체가 없다"));
  assert.ok(FATAL.includes("TIMEOUT"), t("V3: ★ TIMEOUT 이 완료를 막지 않는다"));
  const s = tally([{ verdict: "KILLED" }, { verdict: "TIMEOUT" }, { verdict: "SURVIVED" },
                   { verdict: "ANCHOR-MISS" }, { verdict: INFRA_ERROR }]);
  assert.equal(s.KILLED, 1, t(`V3: ★ 측정 불능이 사망에 섞였다 (사망 ${s.KILLED})`));
  assert.equal(s.TIMEOUT, 1, t("V3: TIMEOUT 을 안 센다"));
  assert.equal(s[INFRA_ERROR], 1, t("V3: INFRA-ERROR 를 안 센다"));
  assert.equal(s.total, 5, t("V3: 총수가 안 맞는다"));
  assert.equal(s.fatal, 4, t(`V3: ★ 완료를 막아야 할 것이 ${s.fatal}개다 (생존·앵커·timeout·측정 불능)`));
  assert.equal(tally([{ verdict: "KILLED" }]).fatal, 0, t("V3: 전부 사망인데 완료를 막는다"));
}

// ══ V4. 실행기가 직계만 죽이는 API 로 되돌아가지 않았다 ════════════════════
{
  const src = read("scripts/mutate.mjs");
  assert.ok(!/spawnSync/.test(src),
    t("V4: ★ mutate.mjs 가 spawnSync 를 쓴다 — 손자가 남는다"));
  assert.ok(/runWithTimeout/.test(src) && /_mutate-lib/.test(src),
    t("V4: mutate.mjs 가 제한 시간 실행기를 안 쓴다"));
  assert.ok(/기준선/.test(src), t("V4: ★ 기준선 중단 처리가 없다"));
  assert.ok(/sum\.fatal/.test(src),
    t("V4: ★ 종료 코드가 생존·앵커·timeout·측정 불능을 함께 보지 않는다"));
  // ⛔ **판정을 호출 자리에서 다시 쓰지 않는다**(설계서 §0-21-3 B안). 규칙이 두 군데 있으면
  //    반드시 갈라진다 — 실제로 기준선과 루프의 규칙이 어긋나 있었다.
  assert.ok(!/\br\.status\b|\br\.timedOut\b/.test(src),
    t("V4: ★ mutate.mjs 가 종료 코드를 직접 보고 판정한다 — 삼항식이 돌아왔다"));
  assert.ok(/classify\(/.test(src), t("V4: ★ mutate.mjs 가 classify() 를 안 쓴다"));
}

// ══ V5. M164 가 **유한**하고, assertion 으로 죽는다 ════════════════════════
{
  const r = track(await runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", "M164"],
    { cwd: repo, timeoutMs: 120_000 }));
  assert.equal(r.timedOut, false, t("V5: ★ M164 단독 실행이 120초 안에 안 끝난다 — 무한 변이다"));
  assert.equal(r.status, 0,
    t(`V5: ★ M164 가 안 죽었다 (exit ${r.status})\n${r.out.split("\n").slice(-12).join("\n")}`));
  assert.match(r.out, /M164\s+KILLED/, t("V5: ★ M164 판정이 KILLED 가 아니다"));
  assert.ok(!/TIMEOUT/.test(r.out.match(/M164[^\n]*/)?.[0] || ""), t("V5: M164 가 timeout 으로 끝났다"));
}

// ══ V6. R11 의 「전수」가 실제 실행한 경계만 센다 ═══════════════════════════
{
  const src = read("scripts/test-ops-race.mjs");
  assert.ok(!/assert\.ok\(fired \|\|/.test(src),
    t("V6: ★ 배리어가 안 걸린 회차를 예외로 통과시킨다 — 실행 안 한 경계를 전수에 센다"));
  assert.match(src, /assert\.ok\(fired,/,
    t("V6: ★ 배리어가 실제로 걸렸는지 요구하지 않는다"));
  assert.match(src, /if \(!fired\) await cross\(\);/,
    t("V6: ★ 마지막 경계에서 reconciliation 을 안 돌린다"));
  for (const need of ["'uploading'", "'uploaded'", "'ready'", "object put"])
    assert.ok(src.includes(need), t(`V6: R11 이 ${need} 경계를 확인하지 않는다`));
}

// ══ V7. 제한 시간의 원본이 **측정한 기준선**이다 ═══════════════════════════
{
  const src = read("scripts/mutate.mjs");
  // ⚠️ 기준선 **순서와 중단**이 `runBaselines()` 로 옮겨가면서 측정도 거기서 한다(2026-08-31).
  //    재는 것은 그대로다 — 「제한 시간의 원본이 손으로 고른 상수가 아니라 실측값인가」.
  assert.match(src, /ms \* 20/, t("V7: 제한 시간이 기준선 실측에서 파생되지 않는다"));
  assert.match(read("scripts/_mutate-lib.mjs"), /const t0 = now\(\);[\s\S]{0,400}?elapsed\.set\(s, now\(\) - t0\)/,
    t("V7: ★ 기준선 소요 시간을 실제로 재지 않는다"));
  assert.match(src, /TIMEOUT_FLOOR/, t("V7: 제한 시간에 하한이 없다"));
  // ⛔ **mutation timeout 과 cleanup deadline 은 다른 상수다** — 한 값을 돌려 쓰면 종료 확인이
  //    실행 시간에 끌려다닌다(설계서 §0-21-2a).
  assert.ok(Number.isInteger(CLEANUP_DEADLINE_MS) && CLEANUP_DEADLINE_MS > 0,
    t("V7: ★ CLEANUP_DEADLINE_MS 가 없다"));
  assert.ok(!/TIMEOUT_FLOOR\s*=\s*CLEANUP_DEADLINE_MS|CLEANUP_DEADLINE_MS\s*=\s*TIMEOUT_FLOOR/.test(
    src + read("scripts/_mutate-lib.mjs")), t("V7: ★ 두 제한 시간이 같은 상수다"));
}

// ══ V8. 시작하지 못한 실행을 사망으로 세지 않는다 (위협 93) ════════════════
{
  // V8-a ENOENT
  const enoent = await runWithTimeout("/nonexistent/shhh-no-such-binary", [], { timeoutMs: 5000 });
  assert.equal(enoent.started, false, t("V8-a: ★ 시작도 못 했는데 started 가 참이다"));
  assert.equal(enoent.spawnFailed, true, t("V8-a: spawnFailed 를 안 적는다"));
  const ce = classify(enoent);
  assert.equal(ce.outcome, "spawn-failed", t(`V8-a: ★ ENOENT 의 정규화 상태가 ${ce.outcome} 다`));
  assert.equal(ce.verdict, INFRA_ERROR, t(`V8-a: ★ ENOENT 가 ${ce.verdict} 로 접혔다`));

  // V8-a EACCES — 실행 권한이 없는 파일
  const d = mkTmp("shhh-verifier-");
  const noexec = join(d, "noexec.sh");
  writeFileSync(noexec, "#!/bin/sh\nexit 0\n");
  chmodSync(noexec, 0o644);
  const eacces = await runWithTimeout(noexec, [], { timeoutMs: 5000 });
  assert.equal(eacces.started, false, t("V8-a: ★ EACCES 인데 started 가 참이다"));
  const ca = classify(eacces);
  assert.equal(ca.outcome, "spawn-failed", t(`V8-a: ★ EACCES 의 정규화 상태가 ${ca.outcome} 다`));
  assert.equal(ca.verdict, INFRA_ERROR, t(`V8-a: ★ EACCES 가 ${ca.verdict} 로 접혔다`));

  // V9-b — 시작을 관측하지 못한 실행은 **어느 것도** KILLED 가 아니다.
  //        ⛔ `close` 의 `-2`·`-13` 을 종료 코드로 받지 않는다.
  for (const r of [enoent, eacces])
    assert.notEqual(classify(r).verdict, "KILLED",
      t(`V9-b: ★ 'spawn' 이벤트가 없는 실행이 KILLED 다 (status=${r.status})`));

  // V8-b — 정상 갈래는 그대로다.
  const zero = track(await runWithTimeout(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 10_000 }));
  const seven = track(await runWithTimeout(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 10_000 }));
  assert.equal(zero.started, true, t("V8-b: 정상 실행인데 started 가 거짓이다"));
  assert.deepEqual([classify(zero).outcome, classify(zero).verdict], ["exited", "SURVIVED"],
    t("V8-b: exit 0 이 SURVIVED 가 아니다"));
  assert.deepEqual([classify(seven).outcome, classify(seven).verdict], ["exited", "KILLED"],
    t("V8-b: exit 7 이 KILLED 가 아니다"));
  assert.ok(Number.isInteger(classify(seven).outcome === "exited" ? seven.status : NaN),
    t("V8-b: KILLED 의 종료 코드가 숫자가 아니다"));
}

// ══ V9-a. 바깥에서 온 signal 은 방어와 무관한 종료다 ═══════════════════════
{
  const r = track(await runWithTimeout(process.execPath,
    ["-e", "process.kill(process.pid,'SIGTERM')"], { timeoutMs: 10_000 }));
  assert.equal(r.timedOut, false, t("V9-a: 우리 타이머가 아닌데 timedOut 이 참이다"));
  assert.equal(r.signal, "SIGTERM", t(`V9-a: ★ signal 이 결과에 안 실린다 (${r.signal})`));
  const c = classify(r);
  assert.equal(c.outcome, "signalled", t(`V9-a: ★ 정규화 상태가 ${c.outcome} 다`));
  assert.equal(c.verdict, INFRA_ERROR, t(`V9-a: ★ 바깥에서 죽은 실행이 ${c.verdict} 다`));
}

// ══ V10. 합성 입력 — 판정은 순수 함수 하나가 소유한다 ══════════════════════
{
  const un = (o, why) => {
    const c = classify(R(o));
    assert.equal(c.outcome, "unobservable", t(`V10: ★ ${why} → ${c.outcome}`));
    assert.equal(c.verdict, INFRA_ERROR, t(`V10: ★ ${why} 가 ${c.verdict} 다`));
  };
  un({ status: null }, "V10-a status 가 null 인데 종료를 주장한다");
  un({ status: "0" }, "V10-b status 가 문자열이다");
  un({ timedOut: "yes" }, "V10-b timedOut 이 boolean 이 아니다");
  un({ started: false, status: 7, timedOut: false }, "V10-c 시작을 못 봤는데 숫자 exit 다");
  un({ started: false, spawnFailed: false, status: 7 }, "V10-d 모순: 시작도 실패도 없는데 종료 코드");
  un({ started: true, spawnFailed: true }, "V10-e 모순: 시작했는데 시작 전 실패");
  un({ groupState: "unknown" }, "V10 그룹을 안 쟀는데 확정한다");
  un({ groupState: "unverifiable" }, "V10 그룹 조회가 unverifiable 이다");
  un({ closeSeen: false }, "V10 close 를 못 봤는데 확정한다");
  un({ cleanupTimedOut: true }, "V10 정리 기한을 넘겼다");
  // 필드가 아예 없는 입력
  for (const bad of [null, undefined, 42, "x", {}, { started: true }])
    assert.equal(classify(bad).outcome, "unobservable", t("V10-b: ★ 필드 누락 입력이 통과한다"));
  // V10-f 모르는 추가 필드 — 정상은 그대로, 비정상은 unobservable
  assert.equal(classify(R({ status: 3, 새필드: 1 })).verdict, "KILLED",
    t("V10-f: 모르는 필드가 붙었다고 정상 입력을 거부한다"));
  assert.equal(classify(R({ status: 3, started: false, 새필드: 1 })).verdict, INFRA_ERROR,
    t("V10-f: ★ 모르는 필드가 붙은 비정상 입력이 exited 로 떨어진다"));
  // V10-g postSpawnError 는 **숫자 검사보다 앞**이다
  const g = classify(R({ postSpawnError: true, status: 7 }));
  assert.equal(g.outcome, "post-spawn-error", t(`V10-g: ★ 시작 뒤 오류가 ${g.outcome} 다`));
  assert.equal(g.verdict, INFRA_ERROR, t("V10-g: ★ 시작 뒤 오류가 난 실행이 KILLED 다"));
  // V10-h 입력이 실어 온 outcome 을 믿지 않는다
  assert.equal(classify(R({ postSpawnError: true, status: 7, outcome: "exited" })).outcome,
    "unobservable", t("V10-h: ★ 입력의 outcome 을 그대로 믿는다"));
  // 기본값이 exited 가 아니다 — 조건을 전부 입증했을 때만 exited 다
  assert.equal(classify(R({ signal: "SIGKILL" })).outcome, "signalled", t("V10: signal 갈래가 없다"));
  assert.equal(classify(R({ residualGroupDetected: true })).outcome, "residual-group",
    t("V10: 잔류 그룹 갈래가 없다"));
  assert.ok(OUTCOMES.includes("unobservable") && OUTCOMES.includes("residual-group"),
    t("V10: 정규화 상태 목록이 낡았다"));
}

// ══ V11. 확정은 정확히 한 번 — 이벤트 경합에서도 ═══════════════════════════
{
  // ENOENT 는 `error` 와 `close(-2)` 가 **둘 다** 온다(실측). 늦은 close 가 앞선 증거를 덮으면
  // 「시작도 못 했는데 숫자 exit」가 되어 이번 결함이 그대로 되살아난다.
  const r = await runWithTimeout("/nonexistent/shhh-no-such-binary", [], { timeoutMs: 5000 });
  await sleep(80);   // 늦은 close 가 도착할 시간을 준다
  assert.equal(r.audit.finalizeCount, 1, t(`V11: ★ finalize 가 ${r.audit.finalizeCount}번 일어났다`));
  assert.equal(r.audit.clearedTimers, 1, t(`V11: ★ clearTimeout 이 ${r.audit.clearedTimers}번이다`));
  assert.equal(r.spawnFailed, true, t("V11: ★ 늦은 close 가 앞선 error 를 덮었다"));
  assert.notEqual(r.status, -2, t("V11: ★ 반환된 객체의 status 가 나중에 -2 로 덮였다"));

  // 가짜 자식으로 순열을 만든다 — close 두 번 · error 뒤 close · 타이머와 close 경합
  for (const order of ["close-close", "error-close", "close-error"]) {
    const ch = fakeChild(555001);
    const k = killer(gone);
    const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 5000,
                                        cleanupMs: 1000, settleMs: 50 });
    await sleep(5);
    ch.emit("spawn");
    if (order === "close-close") { ch.emit("close", 3, null); ch.emit("close", 0, null); }
    if (order === "error-close") { ch.emit("error", err("EPIPE")); ch.emit("close", 3, null); }
    if (order === "close-error") { ch.emit("close", 3, null); ch.emit("error", err("EPIPE")); }
    const res = await p;
    await sleep(10);   // 늦게 온 이벤트가 두 번째 확정을 시도할 시간을 준다
    assert.equal(res.audit.finalizeCount, 1,
      t(`V11: ★ ${order} 에서 finalize 가 ${res.audit.finalizeCount}번이다`));
    assert.equal(res.status, 3, t(`V11: ★ ${order} 에서 종료 코드가 덮였다 (${res.status})`));
  }
  // 우리 타이머와 signal 이 겹치면 **우선순위**가 이름을 정한다 — 언제나 timeout 이다.
  assert.equal(classify(R({ timedOut: true, signal: "SIGKILL", status: null })).outcome, "timeout",
    t("V11: ★ 타이머+signal 경합에서 판정이 도착 순서를 따른다"));
}

// ══ V12. 기준선이 측정 불능이면 돌연변이를 **하나도** 실행하지 않는다 ══════
{
  // `git` 만 있고 `node` 는 없는 PATH 를 만든다 — 기준선 spawn 이 ENOENT 로 실패한다.
  const d = mkTmp("shhh-nopath-");
  const gitBin = execFileSync("/usr/bin/which", ["git"]).toString().trim();
  symlinkSync(gitBin, join(d, "git"));
  const r = track(await runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", "M01"],
    { cwd: repo, env: { ...process.env, PATH: d, SHHH_GIT_ROOT: repo }, timeoutMs: 90_000 }));
  assert.equal(r.status, 2, t(`V12: ★ 기준선 측정 불능인데 종료 코드가 ${r.status} 다`));
  assert.match(r.out, /기준선 spawn-failed/,
    t(`V12: ★ 정규화 상태를 이름으로 말하지 않는다\n${r.out.slice(-400)}`));
  assert.ok(!/M01\s+(KILLED|SURVIVED)/.test(r.out),
    t("V12: ★ 기준선이 빨간데 돌연변이를 실행했다"));
  // ⚠️ 위 실행은 **원본 저장소**의 실행기라 변이를 못 본다 — 배선은 소스에서도 못박는다.
  const src = read("scripts/mutate.mjs");
  assert.match(src, /baselineFail\+\+;/, t("V12: ★ 기준선 실패를 세지 않는다"));
  assert.match(src, /if \(baselineFail\) \{[^}]*process\.exit\(2\);/,
    t("V12: ★ 기준선이 빨간데 돌연변이를 계속 실행한다"));
}

// ══ V13·V17. 산출물이 증거를 싣고, 비밀·가변 정보를 안 싣는다 ══════════════
{
  // ── ⓐ 행의 모양은 순수 함수가 소유한다 — 합성 입력으로 직접 잰다 ──────
  // ⚠️ 아래 ⓑ 의 실행기는 **원본 저장소**에서 돌아 변이를 보지 못한다(돌연변이 사본은 git 저장소가
  //    아니라 `git ls-files` 를 못 쓴다). 그래서 산출물 계약은 여기서 잰다.
  {
    const meta = { id: "MX", file: "worker/index.js", suite: "test-x", what: "무엇", invariant: "불변식" };
    const poison = R({ status: 3, out: "AssertionError: /Users/someone/secret --only PATH=x" });
    const row = resultRow(meta, poison, classify(poison));
    for (const f of JSON_EVIDENCE)
      assert.ok(f in row || (f === "status" && "exit" in row),
        t(`V13-a: ★ 산출물 행에 ${f} 가 없다`));
    assert.equal(row.postSpawnError, false, t("V13-a: ★ postSpawnError 를 안 싣는다"));
    assert.equal(row.started, true, t("V13-a: ★ started 를 안 싣는다"));
    assert.equal(row.outcome, "exited", t("V13-a: ★ 정규화 상태를 안 싣는다"));
    assert.equal(row.verdict, "KILLED", t("V13-a: 판정이 행에 없다"));
    for (const forbidden of ["pgid", "out", "cwd", "env", "args"])
      assert.ok(!(forbidden in row), t(`V17: ★ 산출물 행에 ${forbidden} 를 실었다`));
    const text = JSON.stringify(row);
    for (const leak of ["AssertionError", "/Users/", "--only", "PATH="])
      assert.ok(!text.includes(leak), t(`V17: ★ 산출물 행에 "${leak}" 가 샜다 — 원인은 고정 문구여야 한다`));
  }

  // ── ⓑ 실행기를 끝까지 돌려 산출물 전체를 본다 ─────────────────────────
  const pick = MUTATIONS.find((m) => m.suite === "test-docs");
  assert.ok(pick, t("V13: test-docs 를 대상으로 하는 변이가 없다 — 검사가 헛돈다"));
  const out = join(mkTmp("shhh-json-"), "r.json");
  const r = track(await runWithTimeout(process.execPath,
    ["scripts/mutate.mjs", "--only", pick.id, "--json", out], { cwd: repo, timeoutMs: 120_000 }));
  assert.equal(r.status, 0, t(`V13: 대조용 변이 ${pick.id} 가 안 죽었다 (exit ${r.status})\n${r.out.slice(-600)}`));
  const j = JSON.parse(readFileSync(out, "utf8"));
  // V13-a — 모든 행에 증거 일곱
  for (const row of j.rows)
    for (const f of ["started", "outcome", "signal", "timedOut", "spawnFailed", "postSpawnError"])
      assert.ok(f in row, t(`V13-a: ★ JSON 행에 ${f} 가 없다`));
  // V13-b — KILLED 행은 §0-21-2c 의 조건을 만족한다
  for (const row of j.rows.filter((x) => x.verdict === "KILLED")) {
    assert.equal(row.started, true, t("V13-b: ★ started 가 아닌 KILLED 행이 있다"));
    assert.equal(row.postSpawnError, false, t("V13-b: ★ postSpawnError 인 KILLED 행이 있다"));
    assert.equal(row.spawnFailed, false, t("V13-b: ★ spawnFailed 인 KILLED 행이 있다"));
    assert.equal(row.timedOut, false, t("V13-b: ★ timedOut 인 KILLED 행이 있다"));
    assert.equal(row.signal, null, t("V13-b: ★ signal 이 있는 KILLED 행이 있다"));
    assert.ok(Number.isInteger(row.exit) && row.exit !== 0,
      t(`V13-b: ★ KILLED 인데 종료 코드가 ${row.exit} 다`));
    assert.equal(row.outcome, "exited", t(`V13-b: ★ KILLED 의 정규화 상태가 ${row.outcome} 다`));
  }
  // V17 — 오류 원문 · 환경 변수 · 명령 인자 · 자식 출력 · 경로가 없다
  const text = JSON.stringify(j);
  for (const forbidden of ["AssertionError", "Error:", "PATH=", process.env.HOME || "@@none@@",
                           "/private/var/folders", "SHHH_GIT_ROOT", "--only", "node_modules"])
    assert.ok(!text.includes(forbidden),
      t(`V17: ★ JSON 에 "${forbidden}" 가 실렸다 — 원인은 고정 문구여야 한다`));
  assert.ok(!("pgid" in (j.rows[0] || {})), t("V17: ★ JSON 에 PGID 를 실었다 (화면에만 적는다)"));
}

// ══ V14. INFRA-ERROR 가 판정에도 완료 조건에도 있다 ════════════════════════
{
  assert.ok(VERDICTS.includes(INFRA_ERROR), t("V14: ★ INFRA-ERROR 판정이 없다"));
  assert.ok(FATAL.includes(INFRA_ERROR), t("V14: ★ 측정 불능이 완료를 막지 않는다"));
  assert.notEqual(INFRA_ERROR, "TIMEOUT", t("V14: ★ TIMEOUT 과 INFRA-ERROR 를 합쳤다"));
  assert.ok(KILLED_REQUIREMENTS.length >= 11,
    t(`V14: KILLED 필요충분조건 목록이 ${KILLED_REQUIREMENTS.length}개다`));
}

// ══ V15·V22. spawn 전 만료와 spawn 후 만료는 다른 사건이다 ═════════════════
{
  // V15 — 합성 입력으로 가른다(실제 프로세스로는 재현되지 않았다 · 설계서 §0-21-1b)
  assert.equal(classify(R({ started: false, timedOut: true, status: null })).outcome, "start-timeout",
    t("V15: ★ spawn 전 만료가 start-timeout 이 아니다"));
  assert.equal(classify(R({ started: false, timedOut: true, status: null })).verdict, INFRA_ERROR,
    t("V15: ★ spawn 전 만료가 TIMEOUT 으로 접혔다 — 돌연변이가 실행된 증거가 없다"));
  assert.equal(classify(R({ timedOut: true, status: null, signal: "SIGKILL" })).verdict, "TIMEOUT",
    t("V15: ★ spawn 후 만료가 TIMEOUT 이 아니다"));

  // V22 — `start-timeout` 뒤 늦게 온 'spawn' 을 **정확한 PGID 로** 죽이고, 정리를 확인한 뒤에만 반환한다.
  const ch = fakeChild(555002);
  let present = true;
  const k = killer((target, sig) => {
    if (sig === "SIGKILL") { present = false; return; }
    if (present) return;                       // 살아 있다
    throw err("ESRCH");
  });
  let returned = false;
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 60,
                                      cleanupMs: 3000, settleMs: 30 }).then((v) => { returned = true; return v; });
  await sleep(150);                            // 타이머가 먼저 만료된다 — 죽일 대상이 아직 없다
  assert.equal(returned, false, t("V22: ★ 자식이 없는데 start-timeout 만 보고 반환했다"));
  ch.emit("spawn");                            // 늦게 도착한 시작
  await sleep(20);
  assert.ok(k.calls.some(([tg, sg]) => tg === -555002 && sg === "SIGKILL"),
    t(`V22: ★ 늦게 온 자식을 정확한 PGID 로 죽이지 않았다 (${JSON.stringify(k.calls)})`));
  ch.emit("close", null, "SIGKILL");
  const res = await p;
  assert.equal(res.startTimedOut, true, t("V22: startTimedOut 을 안 적는다"));
  assert.equal(classify(res).outcome, "start-timeout",
    t(`V22: ★ 늦은 spawn 뒤 정규화 상태가 ${classify(res).outcome} 다`));
}

// ══ V16·V18·V23. spawn 후 error 는 spawn 실패도, 종료의 증거도 아니다 ══════
{
  // V16 — 시작 뒤의 error 를 `spawnFailed` 로 거짓 기록하지 않는다
  const ch = fakeChild(555003);
  const k = killer(gone);
  let returned = false;
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 5000,
                                      cleanupMs: 400, settleMs: 30 }).then((v) => { returned = true; return v; });
  ch.emit("spawn");
  await sleep(5);
  ch.emit("error", err("EPIPE"));
  await sleep(40);
  // V18·V23 — ⛔ `error` 시점에 반환하지 않는다. 자식이 아직 살아 있을 수 있다.
  assert.equal(returned, false, t("V18: ★ error 에서 즉시 반환했다 — 자식 종료를 확인하지 않았다"));
  ch.emit("close", 0, null);
  const res = await p;
  assert.equal(res.spawnFailed, false, t("V16: ★ 시작 뒤 오류를 「시작 실패」로 기록했다"));
  assert.equal(res.postSpawnError, true, t("V16: postSpawnError 를 안 적는다"));
  assert.equal(classify(res).outcome, "post-spawn-error",
    t(`V16: ★ 정규화 상태가 ${classify(res).outcome} 다`));
  assert.equal(classify(res).verdict, INFRA_ERROR, t("V16: ★ 시작 뒤 오류가 사망으로 접혔다"));

  // V23 — kill 요청이 실패하고 close 가 아직 없으면 **정리 기한까지 기다린다**
  const ch2 = fakeChild(555004);
  const k2 = killer(() => undefined);          // 그룹이 계속 살아 있다
  const t0 = Date.now();
  const p2 = runWithTimeout("x", [], { spawn: () => ch2, kill: k2, timeoutMs: 40,
                                       cleanupMs: 500, settleMs: 30 });
  ch2.emit("spawn");
  const res2 = await p2;
  assert.ok(Date.now() - t0 >= 400, t("V23: ★ 정리 기한을 안 기다리고 반환했다"));
  assert.equal(res2.cleanupTimedOut, true, t("V23: ★ cleanupTimedOut 을 안 적는다"));
  assert.equal(nextMutationAllowed(res2), false, t("V23: ★ 정리를 증명 못 했는데 다음 변이를 허용한다"));
}

// ══ V25. error 뒤에 숫자 non-zero close 가 와도 KILLED 가 아니다 ═══════════
{
  const ch = fakeChild(555005);
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: killer(gone), timeoutMs: 5000,
                                      cleanupMs: 500, settleMs: 20 });
  ch.emit("spawn");
  ch.emit("error", err("EPIPE"));
  ch.emit("close", 9, null);
  const res = await p;
  assert.notEqual(classify(res).verdict, "KILLED",
    t("V25: ★ 시작 뒤 오류가 있는데 숫자 non-zero 종료만 보고 KILLED 다"));
}

// ══ V19·V36. 제한 시간 뒤에는 **그룹 부재를 확인한 뒤에만** 반환한다 ═══════
{
  const ch = fakeChild(555006);
  let killedGroup = false, closed = false;
  const k = killer((target, sig) => {
    if (sig === "SIGKILL") { killedGroup = true; return; }
    if (!closed || !killedGroup) return;       // 아직 살아 있다
    throw err("ESRCH");
  });
  let returned = false;
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 40,
                                      cleanupMs: 3000, settleMs: 20 }).then((v) => { returned = true; return v; });
  ch.emit("spawn");
  await sleep(120);
  assert.equal(killedGroup, true, t("V19: ★ 제한 시간이 지났는데 그룹 kill 을 요청하지 않았다"));
  assert.equal(returned, false, t("V36: ★ close 도 그룹 부재도 없이 반환했다"));
  closed = true; ch.emit("close", null, "SIGKILL");
  const res = await p;
  assert.equal(res.groupState, "absent", t(`V19: ★ 반환 시점 그룹이 ${res.groupState} 다`));
  assert.equal(classify(res).verdict, "TIMEOUT", t("V19: 제한 시간 초과가 TIMEOUT 이 아니다"));
}

// ══ V24·V37. 정리 기한 안에 부재를 증명 못 하면 중단이다 ═══════════════════
{
  const ch = fakeChild(555007);
  const k = killer(() => undefined);           // 그룹이 끝내 안 빠진다
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 5000,
                                      cleanupMs: 400, settleMs: 30 });
  ch.emit("spawn");
  ch.emit("close", 0, null);
  const res = await p;
  assert.equal(res.residualGroupDetected, true, t("V24: ★ 잔류 그룹을 관찰하고도 안 적는다"));
  assert.equal(res.cleanupTimedOut, true, t("V24: ★ 정리 기한 초과를 안 적는다"));
  assert.equal(classify(res).verdict, INFRA_ERROR, t("V24: ★ 정리 실패가 INFRA-ERROR 가 아니다"));
  assert.equal(nextMutationAllowed(res), false, t("V37: ★ 정리 실패 뒤 다음 변이를 허용한다"));
  assert.equal(cleanupFailed(res), true, t("V24: cleanupFailed 가 거짓이다"));
  // 실행기가 그 자리에서 **중단**하고 종료 코드 2 로 끝나는지 — 문구와 종료 코드
  const src = read("scripts/mutate.mjs");
  assert.match(src, /잔류 프로세스 그룹이 없음을 증명하지 못했다/,
    t("V24: ★ 중단 문구가 없다"));
  assert.match(src, /if \(aborted\) process\.exit\(2\);/,
    t("V37: ★ 정리 실패 뒤 종료 코드가 2 가 아니다"));
  assert.match(src, /if \(!nextMutationAllowed\(r\)\) \{[\s\S]{0,400}?break;/,
    t("V28: ★ 정리 실패 뒤 남은 변이를 계속 실행한다"));
}

// ══ V27. 다음 변이 시작 조건은 §0-22-3 의 불변식 하나다 ════════════════════
{
  assert.equal(nextMutationAllowed(R({ closeSeen: true, groupState: "absent" })), true,
    t("V27: 정상 실행 뒤 다음 변이를 막는다"));
  assert.equal(nextMutationAllowed(R({ closeSeen: true, groupState: "present" })), false,
    t("V27: ★ 그룹이 남았는데 다음 변이를 시작한다 — 이번 결함 그 자체다"));
  assert.equal(nextMutationAllowed(R({ closeSeen: true, groupState: "unverifiable" })), false,
    t("V27: ★ 그룹을 확인 못 했는데 다음 변이를 시작한다"));
  assert.equal(nextMutationAllowed(R({ closeSeen: false, groupState: "absent" })), false,
    t("V27: ★ close 없이 다음 변이를 시작한다"));
  assert.equal(nextMutationAllowed(R({ started: false, spawnFailed: true, closeSeen: false,
                                       groupState: "unknown" })), true,
    t("V27: spawn 전 실패는 확인할 그룹이 없다 — 허용해야 한다"));
}

// ══ V29~V32. 직접 자식이 끝나도 그룹은 남을 수 있다 (위협 94 재현) ═════════
{
  // 손자를 띄우고 직접 자식만 종료한다 — `close` 와 손자 생존이 **공존**한다.
  const leak = (exitCode, mode) =>
    "const c=require('node:child_process').spawn(process.execPath,"
    + "['-e','setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)'],{stdio:'ignore'});"
    + "console.log('GRAND '+c.pid);"
    + (mode === "signal" ? "setTimeout(()=>process.kill(process.pid,'SIGTERM'),120);"
                         : `setTimeout(()=>process.exit(${exitCode}),120);`);

  for (const [label, code, mode, forbidden] of [
    ["V32 exit 0 + 그룹 잔류", 0, "exit", "SURVIVED"],
    ["V31 non-zero + 그룹 잔류", 5, "exit", "KILLED"],
    ["V30 외부 signal + 그룹 잔류", 0, "signal", "KILLED"],
  ]) {
    const r = track(await runWithTimeout(process.execPath, ["-e", leak(code, mode)],
      { timeoutMs: 20_000, settleMs: 150, cleanupMs: 8000 }));
    assert.ok(/GRAND \d+/.test(r.out), t(`${label}: 손자를 못 띄웠다 — 검사가 헛돈다`));
    assert.equal(r.closeSeen, true, t(`${label}: 직접 자식의 close 를 못 봤다`));
    assert.equal(r.residualGroupDetected, true,
      t(`${label}: ★ close 뒤에도 그룹이 살아 있었는데 안 적는다`));
    const c = classify(r);
    assert.equal(c.outcome, "residual-group", t(`${label}: ★ 정규화 상태가 ${c.outcome} 다`));
    assert.equal(c.verdict, INFRA_ERROR, t(`${label}: ★ 오염된 실행이 ${c.verdict} 다`));
    assert.notEqual(c.verdict, forbidden, t(`${label}: ★ ${forbidden} 로 적혔다`));
    // 정리했더라도 **소급해서 정상 측정으로 바꾸지 않는다.**
    assert.equal(r.groupState, "absent", t(`${label}: ★ 반환 시점에 그룹이 안 비었다`));
    assert.equal(classify(r).verdict, INFRA_ERROR,
      t(`${label}: ★ 정리에 성공했다고 판정을 소급 변경했다`));
    const grand = Number(/GRAND (\d+)/.exec(r.out)[1]);
    let live = true; try { process.kill(grand, 0); } catch { live = false; }
    assert.equal(live, false, t(`${label}: ★ 손자 ${grand} 가 살아남았다`));
  }
}

// ══ V33·V34·V35. 그룹 부재 probe 판정표 ════════════════════════════════════
{
  assert.equal(probeGroup(4242, alive), "present", t("V33: ★ 살아 있는 그룹을 present 로 안 읽는다"));
  assert.equal(probeGroup(4242, gone), "absent", t("V35: ★ ESRCH 를 absent 로 안 읽는다"));
  assert.equal(probeGroup(4242, () => { throw err("EPERM"); }), "unverifiable",
    t("V34: ★ EPERM 을 부재로 인정한다 — 확인 못 한 것은 부재가 아니다"));
  assert.equal(probeGroup(4242, () => { throw err("EINVAL"); }), "unverifiable",
    t("V34: ★ 예상 밖 오류를 부재로 인정한다"));
  assert.equal(probeGroup(4242, () => { throw new Error("코드 없음"); }), "unverifiable",
    t("V34: ★ code 없는 오류를 부재로 인정한다"));
  // ⛔ `kill(-1, …)` 은 **보낼 수 있는 모든 프로세스**다 — 절대 묻지 않는다.
  for (const bad of [0, 1, -5, null, undefined, "4242", 1.5]) {
    const k = killer(alive);
    assert.equal(probeGroup(bad, k), "unverifiable", t(`V33: ★ pgid ${bad} 를 probe 한다`));
    assert.equal(k.calls.length, 0, t(`V33: ★ pgid ${bad} 로 실제 kill 을 불렀다`));
  }
  // 음수 PGID 로 묻는다 — 양수 PID probe 는 그 프로세스 하나만 말한다
  const k = killer(alive);
  probeGroup(4242, k);
  assert.deepEqual(k.calls[0], [-4242, 0], t(`V29: ★ 양수 PID 로 그룹을 물었다 (${JSON.stringify(k.calls[0])})`));
  // 실제 살아 있는 그룹 하나로도 확인한다
  const live = track(await runWithTimeout(process.execPath,
    ["-e", "console.log('UP');setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)"], { timeoutMs: 800 }));
  assert.equal(probeGroup(live.pgid), "absent", t("V33: 제한 시간 뒤 그룹이 안 비었다"));
}

// ══ V38. 계약 없는 플랫폼에서는 시작 자체를 안 한다 ════════════════════════
{
  const url = new URL("./mutate.mjs", import.meta.url).href;
  // ⚠️ `--only` 를 준다 — 게이트를 없애는 변이가 걸렸을 때 **전체 실행이 재귀로 도는 것**을 막는다.
  const cheap = MUTATIONS.find((m) => m.suite === "test-docs").id;
  const r = track(await runWithTimeout(process.execPath, ["-e",
    `Object.defineProperty(process,'platform',{value:'win32'});`
    + `process.argv.push('--only',${JSON.stringify(cheap)});import(${JSON.stringify(url)})`],
    { cwd: repo, timeoutMs: 120_000 }));
  assert.equal(r.status, 2, t(`V38: ★ win32 에서 종료 코드가 ${r.status} 다 — 조용히 돈다`));
  assert.match(r.out, /프로세스 그룹 부재를 증명할 수 없다/,
    t(`V38: ★ 플랫폼 게이트 문구가 없다\n${r.out.slice(0, 300)}`));
  assert.ok(!/KILLED|SURVIVED/.test(r.out), t("V38: ★ win32 에서 돌연변이를 실행했다"));
  const src = read("scripts/mutate.mjs");
  assert.match(src, /if \(process\.platform === "win32"\) \{[\s\S]{0,300}?process\.exit\(2\);/,
    t("V38: ★ 플랫폼 게이트가 없다 — 계약 없는 곳에서 조용히 돈다"));
}

// ══ V39·V40. spawn 뒤 error 는 **정리로 들어간다** (2026-08-31) ════════════
// ⛔ 옛 판은 `armDeadline()` 만 하고 기한이 흐르기를 기다렸다 — 종료를 **요청조차 하지 않아서**
//    `close` 가 영영 안 오면 우리가 만든 그룹이 실행기보다 오래 살아남았다.
{
  // V39 — close 가 안 오고 그룹이 안 빠지는 경우: 정확한 음수 PGID 로 요청하고 기한까지 기다린다
  const ch = fakeChild(555201);
  const k = killer(() => undefined);            // 그룹이 계속 살아 있다
  let returned = false;
  const t0 = Date.now();
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 60_000,
                                      cleanupMs: 400, settleMs: 30 }).then((v) => { returned = true; return v; });
  ch.emit("spawn");
  await sleep(5);
  ch.emit("error", err("EPIPE"));
  await sleep(60);
  assert.equal(returned, false, t("V39: ★ spawn 뒤 error 에서 즉시 반환했다"));
  const res = await p;
  assert.equal(res.cleanupRequested, true,
    t("V39: ★ spawn 뒤 error 인데 정리를 요청하지 않았다 — 그룹이 실행기보다 오래 산다"));
  assert.ok(k.calls.some(([tg, sg]) => tg === -555201 && sg === "SIGKILL"),
    t(`V39: ★ 정확한 음수 PGID 로 종료를 요청하지 않았다 (${JSON.stringify(k.calls)})`));
  assert.equal(res.cleanupTimedOut, true, t("V39: ★ 정리 기한 초과를 안 적는다"));
  assert.ok(Date.now() - t0 >= 380, t("V39: ★ 정리 기한을 안 기다리고 반환했다"));
  assert.equal(classify(res).verdict, INFRA_ERROR, t("V39: ★ 정리 못 한 실행이 INFRA-ERROR 가 아니다"));
  assert.equal(nextMutationAllowed(res), false, t("V39: ★ 그 뒤 다음 변이를 허용한다"));

  // V40 — 정리가 확인되면 기한을 다 안 쓰고 반환하되 판정은 그대로 INFRA-ERROR 다
  const ch2 = fakeChild(555202);
  let live = true;
  const k2 = killer((tg, sg) => { if (sg === "SIGKILL") { live = false; return; } if (live) return; throw err("ESRCH"); });
  const t1 = Date.now();
  const p2 = runWithTimeout("x", [], { spawn: () => ch2, kill: k2, timeoutMs: 60_000,
                                       cleanupMs: 5000, settleMs: 20 });
  ch2.emit("spawn");
  ch2.emit("error", err("EPIPE"));
  await sleep(60);
  ch2.emit("close", 0, null);
  const res2 = await p2;
  assert.ok(Date.now() - t1 < 4000, t("V40: ★ 정리가 끝났는데 기한을 다 썼다"));
  assert.equal(res2.closeSeen, true, t("V40: close 를 안 봤다"));
  assert.equal(res2.groupState, "absent", t(`V40: ★ 반환 시점 그룹이 ${res2.groupState} 다`));
  assert.equal(res2.cleanupTimedOut, false, t("V40: ★ 확인했는데 기한 초과로 적었다"));
  assert.equal(classify(res2).outcome, "post-spawn-error",
    t(`V40: ★ 정규화 상태가 ${classify(res2).outcome} 다`));
  assert.equal(classify(res2).verdict, INFRA_ERROR, t("V40: ★ 시작 뒤 오류가 사망으로 접혔다"));
  assert.equal(nextMutationAllowed(res2), true, t("V40: 정리를 증명했는데 다음 변이를 막는다"));
}

// ══ V41·V42. 확인할 수 없다 ≠ 확인을 포기한다 (2026-08-31) ═════════════════
// ⛔ 옛 판은 `unverifiable` 을 보는 즉시 `finalize()` 했다. 「부재로 인정하지 않는다」는 지켰지만
//    **우리가 만든 그룹은 그대로 남았다** — 다음 변이가 그 부하 위에서 측정된다.
{
  for (const [id, code] of [["V41", "EPERM"], ["V42", "EINVAL"]]) {
    const ch = fakeChild(555210);
    const k = killer(() => { throw err(code); });
    const t0 = Date.now();
    const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 60_000,
                                        cleanupMs: 400, settleMs: 30 });
    ch.emit("spawn");
    ch.emit("close", 0, null);
    const res = await p;
    assert.ok(Date.now() - t0 >= 380,
      t(`${id}: ★ ${code} 를 보고 정리 기한 전에 반환했다 — 그룹을 남긴 채 다음 변이로 넘어간다`));
    assert.equal(res.cleanupRequested, true, t(`${id}: ★ ${code} 인데 정리를 시도조차 안 했다`));
    assert.ok(k.calls.some(([tg, sg]) => tg === -555210 && sg === "SIGKILL"),
      t(`${id}: ★ 정확한 음수 PGID 로 종료를 요청하지 않았다`));
    assert.equal(res.groupState, "unverifiable", t(`${id}: ★ ${code} 를 부재로 읽었다`));
    assert.equal(res.cleanupTimedOut, true, t(`${id}: ★ 끝내 확인 못 했는데 기한 초과를 안 적는다`));
    assert.equal(cleanupFailed(res), true, t(`${id}: cleanupFailed 가 거짓이다`));
    assert.equal(classify(res).outcome, "unobservable",
      t(`${id}: ★ 정규화 상태가 ${classify(res).outcome} 다`));
    assert.equal(nextMutationAllowed(res), false, t(`${id}: ★ 확인 못 했는데 다음 변이를 허용한다`));
  }
}

// ══ V43. 정리 못 한 기준선 뒤에는 다음 스위트도 안 띄운다 (2026-08-31) ══════
{
  const dirty = R({ closeSeen: false, groupState: "present", cleanupTimedOut: true, status: null });
  const clean = R({ status: 0 });
  const red = R({ status: 1 });

  const calls = [];
  const a = await runBaselines(["a", "b"], async (s) => { calls.push(s); return s === "a" ? dirty : clean; });
  assert.deepEqual(calls, ["a"],
    t(`V43: ★ 정리를 증명 못 한 기준선 뒤에 다음 스위트를 띄웠다 (${calls.join(",")})`));
  assert.equal(a.halted?.suite, "a", t("V43: ★ 중단을 기록하지 않는다"));
  assert.equal(a.elapsed.size, 0, t("V43: ★ 못 잰 기준선의 제한 시간을 만들었다"));

  // ⚠️ 평범하게 빨간 기준선은 멈추지 않는다 — 정리는 확인됐고, 모아서 함께 보고하는 편이 낫다.
  const calls2 = [];
  const b = await runBaselines(["a", "b"], async (s) => { calls2.push(s); return s === "a" ? red : clean; });
  assert.deepEqual(calls2, ["a", "b"], t("V43: 평범한 빨간 기준선에서 나머지를 안 잰다"));
  assert.equal(b.halted, null, t("V43: 평범한 실패를 중단으로 읽었다"));
  assert.equal(b.failed.length, 1, t("V43: 실패한 기준선을 안 센다"));

  assert.equal(baselineHalt(clean), false, t("V43: ★ 정상 기준선을 중단으로 읽는다"));
  assert.equal(baselineHalt(red), false, t("V43: ★ 평범한 실패를 중단으로 읽는다"));
  for (const [why, r] of [["정리 기한 초과", R({ cleanupTimedOut: true })],
                          ["확인 불가", R({ groupState: "unverifiable" })],
                          ["close 없음", R({ closeSeen: false })],
                          ["잔류 그룹", R({ groupState: "present" })]])
    assert.equal(baselineHalt(r), true, t(`V43: ★ ${why} 인데 다음 기준선을 띄운다`));

  // 중첩 실행은 변이를 못 본다 — 실행기의 배선은 **소스**로 못박는다.
  const src = read("scripts/mutate.mjs");
  assert.match(src, /if \(halted\) \{[\s\S]{0,500}?process\.exit\(2\);/,
    t("V43: ★ 기준선 중단 뒤 종료 코드 2 로 멈추지 않는다"));
  assert.match(src, /남은 기준선도 돌연변이도 하나 실행하지 않고 중단한다/,
    t("V43: ★ 중단 사유 문구가 없다"));
}

// ══ V44·V45. 최초 원인을 나중에 발견한 잔류가 덮지 않는다 (2026-08-31) ══════
{
  // V44 — spawn 전 만료 → 늦은 spawn → 정리가 settle 창보다 오래 걸린다
  const ch = fakeChild(555220);
  let live = true;
  const k = killer((tg, sg) => { if (sg === "SIGKILL") return; if (live) return; throw err("ESRCH"); });
  const p = runWithTimeout("x", [], { spawn: () => ch, kill: k, timeoutMs: 50,
                                      cleanupMs: 5000, settleMs: 20 });
  await sleep(110);                              // spawn 전에 만료됐다
  ch.emit("spawn");                              // 늦게 도착한 시작
  await sleep(150);                              // 정리가 settle 창보다 오래 걸린다
  live = false; ch.emit("close", null, "SIGKILL");
  const res = await p;
  assert.equal(res.startTimedOut, true, t("V44: startTimedOut 을 안 적는다"));
  assert.equal(res.groupState, "absent", t(`V44: ★ 반환 시점 그룹이 ${res.groupState} 다`));
  assert.equal(classify(res).outcome, "start-timeout",
    t(`V44: ★ 최초 원인이 ${classify(res).outcome} 로 덮였다 — 운영자가 엉뚱한 곳을 고치러 간다`));
  assert.equal(classify(res).verdict, INFRA_ERROR, t("V44: ★ start-timeout 이 INFRA-ERROR 가 아니다"));

  // V45 — `close` 전에는 잔류로 적지 않는다. 아직 정상 종료 중일 수 있다.
  // ⚠️ **정리 반복문이 실제로 도는 경로**여야 한다 — spawn 뒤 오류가 그 자리다(제한 시간 갈래는
  //    `close` 가 와야 반복문에 들어가서, 거기서 재면 이 갈래가 한 번도 실행되지 않는다).
  const ch2 = fakeChild(555221);
  const k2 = killer(() => undefined);            // 그룹이 계속 present
  const p2 = runWithTimeout("x", [], { spawn: () => ch2, kill: k2, timeoutMs: 60_000,
                                       cleanupMs: 400, settleMs: 20 });
  ch2.emit("spawn");
  ch2.emit("error", err("EPIPE"));               // 정리 반복문에 들어간다
  await sleep(200);                              // settle 창을 한참 넘겼는데 close 가 아직이다
  const res2 = await p2;
  assert.equal(res2.closeSeen, false, t("V45: 검사가 헛돈다 — close 가 왔다"));
  assert.equal(res2.groupState, "present", t(`V45: 검사가 헛돈다 — 그룹이 ${res2.groupState} 다`));
  assert.equal(res2.residualGroupDetected, false,
    t("V45: ★ 직접 자식이 닫히기도 전에 잔류로 적었다 — 최초 원인을 덮는 오기록이다"));

  // 잔류는 **close 뒤**에 관찰됐을 때만 적는다(V24 가 그 갈래를 잰다).
  assert.equal(classify(R({ startTimedOut: true, residualGroupDetected: true })).outcome, "start-timeout",
    t("V44: ★ 합성 입력에서도 잔류가 start-timeout 을 덮는다"));
  assert.equal(classify(R({ residualGroupDetected: true })).outcome, "residual-group",
    t("V45: ★ 최초 원인이 없을 때는 잔류가 그대로 상태여야 한다"));
}

// ══ V46~V50. 임시 사본의 소유권은 **최상위 실행 하나** (2026-08-31) ═════════
// ⛔ 이 실행기는 자식을 프로세스 그룹째 SIGKILL 한다 — 죽는 쪽은 `finally` 를 못 돌린다.
//    그래서 「죽는 쪽이 치운다」가 아니라 **「만든 쪽이 치운다」**로 소유권을 올렸다.
{
  const tmp = tmpdir();
  const others = () => readdirSync(tmp).filter((x) => x.startsWith("shhh-mutate-"));
  const cheap = MUTATIONS.find((m) => m.suite === "test-docs").id;

  // V46 — 정상 종료: 이 실행이 만든 것이 하나도 안 남는다
  {
    const before = new Set(others());
    const r = track(await runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", cheap],
      { cwd: repo, env: { ...process.env, SHHH_GIT_ROOT: repo }, timeoutMs: 180_000 }));
    assert.equal(r.status, 0, t(`V46: 검사가 헛돈다 — 실행기가 종료 코드 ${r.status} 로 끝났다`));
    assert.deepEqual(others().filter((x) => !before.has(x)), [],
      t("V46: ★ 정상 종료했는데 이 실행이 만든 임시 자원이 남았다"));
    // 위 실행은 **원본 저장소**의 실행기라 변이를 못 본다 — 배선은 소스에서도 못박는다.
    assert.match(read("scripts/mutate.mjs"),
      /if \(ownsRunRoot\) \{[^\n]*rmSync\(runRoot/,
      t("V46: ★ 만든 실행이 자기 run-root 를 안 지운다"));
  }

  // V47 — 실패 종료(`process.exit()` 는 `finally` 를 안 돌린다): 그래도 안 남는다
  {
    const before = new Set(others());
    const d = mkTmp("shhh-nopath-");
    symlinkSync(execFileSync("/usr/bin/which", ["git"]).toString().trim(), join(d, "git"));
    const r = track(await runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", cheap],
      { cwd: repo, env: { ...process.env, PATH: d, SHHH_GIT_ROOT: repo }, timeoutMs: 180_000 }));
    assert.equal(r.status, 2, t(`V47: 검사가 헛돈다 — 기준선이 실패하지 않았다 (${r.status})`));
    assert.deepEqual(others().filter((x) => !before.has(x)), [],
      t("V47: ★ 기준선 실패로 나가는 길이 임시 자원을 남긴다 — process.exit() 는 finally 를 안 돌린다"));
    rmSync(d, { recursive: true, force: true });
    assert.match(read("scripts/mutate.mjs"), /process\.on\("exit", cleanupOwned\);/,
      t("V47: ★ 종료 경로에 정리가 안 걸려 있다 — process.exit() 는 finally 를 안 돌린다"));
  }

  // V48 — 중첩 실행이 SIGKILL 돼도 사본은 최상위의 run-root **안**에 갇힌다
  {
    const before = new Set(others());
    const root = mkTmp(RUN_ROOT_PREFIX);
    writeFileSync(join(root, RUN_ROOT_MARKER),
                  JSON.stringify({ pid: process.pid, repo, at: Date.now() }));
    // group-escape-ok: 중첩 실행을 **그룹째** 죽여야 SIGKILL 잔류를 재현할 수 있다
    const ch = spawn(process.execPath, ["scripts/mutate.mjs", "--only", cheap],
      { cwd: repo, stdio: "ignore", detached: true,                     // group-escape-ok: 위 주석
        env: childEnv({ ...process.env, SHHH_GIT_ROOT: repo }, root) });
    madeGroups.push(ch.pid);
    let copies = [];
    for (let i = 0; i < 400 && !copies.length; i++) {
      copies = readdirSync(root).filter((x) => x.startsWith("copy-"));
      if (!copies.length) await sleep(25);
    }
    assert.ok(copies.length, t("V48: 검사가 헛돈다 — 중첩 실행이 run-root 안에 사본을 안 만들었다"));
    try { process.kill(-ch.pid, "SIGKILL"); } catch { /* 이미 끝났다 */ }
    await sleep(300);
    assert.deepEqual(others().filter((x) => !before.has(x) && x !== basename(root)), [],
      t("V48: ★ 중첩 실행이 TMPDIR 바로 아래에 사본을 만들었다 — 최상위가 못 치운다"));
    rmSync(root, { recursive: true, force: true });   // 최상위(=이 스위트)가 소유자다
    assert.deepEqual(others().filter((x) => !before.has(x)), [],
      t("V48: ★ 최상위가 지웠는데 중첩 실행의 사본이 남았다"));
  }

  // V49 — 동시 최상위 실행은 서로의 run-root 를 건드리지 않는다
  {
    const before = new Set(others());
    const run = () => runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", cheap],
      { cwd: repo, env: { ...process.env, SHHH_GIT_ROOT: repo }, timeoutMs: 180_000 });
    const [x, y] = (await Promise.all([run(), run()])).map(track);
    assert.equal(x.status, 0, t(`V49: ★ 동시 실행 A 가 종료 코드 ${x.status} 로 끝났다 — 서로를 지웠다`));
    assert.equal(y.status, 0, t(`V49: ★ 동시 실행 B 가 종료 코드 ${y.status} 로 끝났다 — 서로를 지웠다`));
    assert.deepEqual(others().filter((z) => !before.has(z)), [],
      t("V49: ★ 동시 실행 뒤 임시 자원이 남았다"));
  }

  // V50 — 바깥에서 온 경로를 삭제 대상으로 쓰지 않는다 (fail-closed)
  {
    const victim = mkTmp("shhh-victim-");
    writeFileSync(join(victim, "keep.txt"), "x");
    for (const [why, value] of [["TMPDIR 밖", "/"], ["접두사 불일치", victim],
                                ["없는 경로", join(tmp, RUN_ROOT_PREFIX + "nope")]]) {
      const r = track(await runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", cheap],
        { cwd: repo, env: childEnv({ ...process.env, SHHH_GIT_ROOT: repo }, value), timeoutMs: 120_000 }));
      assert.equal(r.status, 2, t(`V50: ★ ${why} 인 경로를 받고도 종료 코드가 ${r.status} 다`));
      assert.match(r.out, /쓸 수 없는 경로다/, t(`V50: ★ ${why} — 거부 문구가 없다`));
    }
    assert.ok(readdirSync(victim).includes("keep.txt"), t("V50: ★ 주입된 경로의 내용을 지웠다"));
    rmSync(victim, { recursive: true, force: true });

    // 합성 입력 — 판정은 순수 함수가 소유한다(중첩 실행은 변이를 못 본다)
    const ok = mkTmp(RUN_ROOT_PREFIX);
    writeFileSync(join(ok, RUN_ROOT_MARKER), "{}");
    assert.equal(runRootUsable(ok, tmp), true, t("V50: ★ 정상 run-root 를 거부한다"));
    assert.equal(runRootUsable(join(tmp, "shhh-other-x"), tmp), false, t("V50: ★ 접두사가 달라도 받는다"));
    assert.equal(runRootUsable(join(ok, "sub"), tmp), false, t("V50: ★ TMPDIR 한 단계 아래가 아닌데 받는다"));
    assert.equal(runRootUsable("", tmp), false, t("V50: ★ 빈 문자열을 받는다"));
    assert.equal(runRootUsable(undefined, tmp), false, t("V50: ★ undefined 를 받는다"));
    rmSync(join(ok, RUN_ROOT_MARKER));
    assert.equal(runRootUsable(ok, tmp), false, t("V50: ★ marker 가 없는 디렉터리를 run-root 로 받는다"));
    // ⛔ **심볼릭 링크를 따라가지 않는다** — 링크 하나로 삭제 대상이 바깥 디렉터리가 된다.
    writeFileSync(join(ok, RUN_ROOT_MARKER), "{}");
    const link = join(tmp, RUN_ROOT_PREFIX + "link" + process.pid);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(ok, link); madeDirs.push(link);
    assert.equal(runRootUsable(link, tmp), false,
      t("V50: ★ run-root 자리의 심볼릭 링크를 따라간다 — 링크 하나로 바깥을 지운다"));
    rmSync(link, { force: true });
    rmSync(ok, { recursive: true, force: true });
    assert.equal(childEnv({ a: 1 }, "/r")[RUN_ROOT_ENV], "/r", t("V50: ★ 중첩 실행에 소유자를 안 물려준다"));
    assert.equal(childEnv({ a: 1 }, "/r").a, 1, t("V50: 나머지 환경을 잃어버린다"));
  }
}

// ══ V51. 남은 run-root 는 **조건을 전부 만족할 때만** 치운다 ════════════════
// ⛔ 하나라도 확인할 수 없으면 안 지운다 — 지금 도는 형제 실행을 지우면 그 실행이 통째로 깨진다.
{
  const tmp = tmpdir();
  const old = Date.now() - 3 * 3600e3;
  const st = { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => true };
  const fsx = (mark) => ({ lstatSync: () => st, readFileSync: () => JSON.stringify(mark) });
  const dead = () => { throw err("ESRCH"); };
  const name = RUN_ROOT_PREFIX + "aaa";
  const full = { pid: 4242, repo: "/r/", at: old };
  const call = (mark, kill = dead, names = [name], repo2 = "/r/") =>
    staleRunRoots(names, tmp, repo2, Date.now(), fsx(mark), kill);

  assert.deepEqual(call(full), [join(tmp, name)], t("V51: ★ 조건을 다 만족하는데 안 치운다"));
  assert.deepEqual(call({ ...full, at: Date.now() }), [],
    t("V51: ★ 방금 만든 run-root 를 치운다 — 지금 도는 형제를 지운다"));
  assert.deepEqual(call(full, alive), [],
    t("V51: ★ 소유자가 살아 있는데 치운다"));
  assert.deepEqual(call(full, () => { throw err("EPERM"); }), [],
    t("V51: ★ 소유자를 **확인할 수 없는데** 치운다 — 확인 불가는 삭제 허가가 아니다"));
  assert.deepEqual(call({ ...full, repo: "/other/" }), [],
    t("V51: ★ 다른 저장소의 run-root 를 치운다"));
  assert.deepEqual(call(full, dead, ["shhh-mutate-legacy"]), [],
    t("V51: ★ 접두사가 다른 디렉터리를 치운다"));
  assert.deepEqual(call(full, dead, [42, null]), [], t("V51: 문자열이 아닌 항목에서 던진다"));
  assert.deepEqual(call({ ...full, pid: 0 }), [], t("V51: ★ 쓸 수 없는 owner PID 인데 치운다"));
  assert.deepEqual(call({ ...full, at: "언제" }), [], t("V51: ★ 시각을 못 읽는데 치운다"));
}

// ══ G12. 스위트가 프로세스 그룹을 **벗어나지** 않는다 (설계서 §0-22-9) ═════
// ⚠️ 판정은 `_mutate-lib.mjs` 의 **순수 함수**가 소유한다 — 그래야 「검사를 무력화하는 변이」를
//    합성 입력으로 잡을 수 있다. 검사가 자기 안에만 있으면 그 변이는 원리적으로 죽지 않는다.
{
  const dir = fileURLToPath(new URL(".", import.meta.url));
  let marked = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const text = readFileSync(join(dir, f), "utf8");
    const bad = groupEscapeViolations(`scripts/${f}`, text);
    assert.deepEqual(bad, [],
      t(`G12: ★ 프로세스 그룹을 벗어나는 API 를 표식 없이 쓴다 — `
        + bad.map((b) => `${b.file}:${b.line} ${b.text}`).join(" / ")));
    marked += text.split("\n").filter((l) => l.includes(GROUP_ESCAPE_MARK)).length;
  }
  assert.ok(marked >= 1, t("G12: 표식이 하나도 없다 — 검사가 헛돈다(실행기 자신이 그룹을 만든다)"));

  // ── 자기검사: 합성 입력으로 판정이 살아 있는지 잰다 ──────────────────
  const N1 = "const c = spawn(cmd, args, { deta" + "ched: true });";   // group-escape-ok: 합성 입력
  const N2 = "  process.set" + "sid();";                              // group-escape-ok: 합성 입력
  const N3 = "  child.un" + "ref();";                                 // group-escape-ok: 합성 입력
  const N4 = "  const p = fo" + "rk('./w.mjs');";                      // group-escape-ok: 합성 입력
  for (const [i, line] of [N1, N2, N3, N4].entries())
    assert.equal(groupEscapeViolations("합성", line).length, 1,
      t(`G12 자기검사: ★ 이탈 패턴 ${i + 1} 을 못 잡는다 — ${line.trim()}`));
  assert.deepEqual(groupEscapeViolations("합성", `${N1} // ${GROUP_ESCAPE_MARK} 이유`), [],
    t("G12 자기검사: ★ 표식이 있는 줄까지 위반으로 센다"));
  assert.deepEqual(groupEscapeViolations("합성", "const c = spawn(cmd, args);\nconst d = 1;"), [],
    t("G12 자기검사: ★ 평범한 spawn 을 위반으로 센다"));
  assert.equal(groupEscapeViolations("합성", `${N1}\n${N2}`).length, 2,
    t("G12 자기검사: 여러 줄을 전수로 세지 않는다"));
  assert.ok(GROUP_ESCAPE_PATTERNS.length >= 4,
    t(`G12 자기검사: ★ 패턴이 ${GROUP_ESCAPE_PATTERNS.length}개로 줄었다`));
}

// ══ 잔류 확인 — 이 스위트가 만든 그룹이 하나도 안 남았다 ═══════════════════
{
  await sleep(120);
  const left = [...new Set(madeGroups)].filter((g) => probeGroup(g) !== "absent");
  assert.deepEqual(left, [],
    t(`잔류: ★ 이 스위트가 만든 프로세스 그룹이 남았다 — PGID ${left.join(",")}`));
}

console.log(`test-verifier: ${n}개 통과 — 실행기 수명주기(프로세스 그룹 부재 · 두 제한 시간 · `
  + `판정 다섯) · 시작·종료 증거 · 정리 fail-closed · 플랫폼 게이트 · M164 유한성 · R11 실행 경계 전수 · `
  + `spawn 뒤 오류의 정리 · 확인 불가의 정리 기한 · 기준선 즉시 중단 · 최초 원인 보존 · 임시 자원 소유권`);
