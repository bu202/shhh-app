// 검증 장치 자체를 검증한다 (2026-08-28 · 위협 91·92 · T110·T111).
//
// ⚠️ 왜 스위트가 하나 더 생겼나: 이 저장소의 완료 판정 근거는 **돌연변이 결과**다. 그런데
//    그 결과를 만드는 실행기가 조용히 고장 나면, 화면에는 아무 실패도 안 뜨고 **「아직 안
//    끝났다」**로만 보인다. 실제로 그랬다 —
//    · 위협 91: 변이 하나가 종료하지 않는 자식을 만들자 211종 검증이 통째로 멈췄고, 바깥에서
//      실행기를 죽여도 **손자가 CPU 를 먹으며 남았다.** 그 상태는 사망도 생존도 아닌 **측정 불능**이다.
//    · 위협 92: 「모든 경계에서 교차시킨다」는 검사가 마지막 자리에서 **reconciliation 을 한 번도
//      안 돌리고** 통과했다. 실행하지 않은 경계를 「전수」에 세고 있었다.
//    둘 다 **테스트가 통과하는 상태에서** 성립했다. 그래서 실행기에도 자기검사를 붙인다 —
//    `test-docs` 가 자기 판정을 합성 입력으로 self-test 하는 것과 같은 이유다.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWithTimeout, tally, VERDICTS, FATAL } from "./_mutate-lib.mjs";

let n = 0;
const t = (m) => { n++; return m; };
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

// ══ V1. 종료하지 않는 자식을 제한 시간 안에 죽인다 — **손자까지** ═══════════
// ⛔ `spawnSync({ timeout })` 은 직계 자식만 죽인다. 스위트가 손자를 띄우면(workerd) 그 손자는
//    남아서 다음 회차와 CPU 를 다툰다 — 그러면 뒤 회차의 판정이 부하 때문인지 변이 때문인지 갈리지 않는다.
{
  const child = "const c=require('node:child_process')"
    + ".spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});"
    + "console.log('GPID '+c.pid);setInterval(()=>{},1000);";
  const t0 = Date.now();
  const r = await runWithTimeout(process.execPath, ["-e", child], { timeoutMs: 1500 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true, t("V1: ★ 종료하지 않는 자식인데 timedOut 이 아니다"));
  assert.ok(took < 8000, t(`V1: ★ 제한 시간(1.5초)이 지나도 ${took}ms 를 기다렸다`));
  const m = /GPID (\d+)/.exec(r.out);
  assert.ok(m, t("V1: 손자를 못 띄웠다 — 검사가 헛돈다"));
  const gpid = Number(m[1]);
  let alive = true;
  try { process.kill(gpid, 0); } catch { alive = false; }
  if (alive) { try { process.kill(gpid, "SIGKILL"); } catch { /* 정리만 */ } }
  assert.equal(alive, false,
    t(`V1: ★ 손자 ${gpid} 가 살아남았다 — 프로세스 그룹째 죽이지 않는다`));
}

// ══ V2. 정상 종료는 그대로 통과시킨다 ══════════════════════════════════════
{
  const ok = await runWithTimeout(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 10_000 });
  assert.equal(ok.timedOut, false, t("V2: 즉시 끝난 자식을 timeout 으로 적었다"));
  assert.equal(ok.status, 0, t(`V2: 종료 코드가 ${ok.status} 다`));
  const bad = await runWithTimeout(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 10_000 });
  assert.equal(bad.status, 7, t(`V2: 종료 코드를 안 그대로 준다 (${bad.status})`));
  assert.equal(bad.timedOut, false, t("V2: 실패한 자식을 timeout 으로 적었다"));
}

// ══ V3. TIMEOUT 을 KILLED 로 접지 않는다 ═══════════════════════════════════
// 합치는 순간 **종료하지 않는 변이가 곧 만점**이 된다. 그것이 위협 91 의 핵심이다.
{
  assert.ok(VERDICTS.includes("TIMEOUT"), t("V3: ★ TIMEOUT 판정 자체가 없다"));
  assert.ok(FATAL.includes("TIMEOUT"), t("V3: ★ TIMEOUT 이 완료를 막지 않는다"));
  const s = tally([{ verdict: "KILLED" }, { verdict: "TIMEOUT" }, { verdict: "SURVIVED" },
                   { verdict: "ANCHOR-MISS" }]);
  assert.equal(s.KILLED, 1, t(`V3: ★ TIMEOUT 이 사망에 섞였다 (사망 ${s.KILLED})`));
  assert.equal(s.TIMEOUT, 1, t("V3: TIMEOUT 을 안 센다"));
  assert.equal(s.total, 4, t("V3: 총수가 안 맞는다"));
  assert.equal(s.fatal, 3, t(`V3: ★ 완료를 막아야 할 것이 ${s.fatal}개다 (생존·앵커·timeout)`));
  assert.equal(tally([{ verdict: "KILLED" }]).fatal, 0, t("V3: 전부 사망인데 완료를 막는다"));
}

// ══ V4. 실행기가 직계만 죽이는 API 로 되돌아가지 않았다 ════════════════════
{
  const src = read("scripts/mutate.mjs");
  assert.ok(!/spawnSync/.test(src),
    t("V4: ★ mutate.mjs 가 spawnSync 를 쓴다 — 손자가 남는다"));
  assert.ok(/runWithTimeout/.test(src) && /_mutate-lib/.test(src),
    t("V4: mutate.mjs 가 제한 시간 실행기를 안 쓴다"));
  // 기준선 timeout 은 **즉시 전체 실패**다. 안 그러면 그 스위트의 변이가 전부 TIMEOUT 이 되어
  // 아무것도 재지 못한 채 표만 길어진다.
  assert.ok(/기준선 timeout/.test(src), t("V4: ★ 기준선 timeout 처리가 없다"));
  assert.ok(/sum\.fatal/.test(src),
    t("V4: ★ 종료 코드가 생존·앵커·timeout 을 함께 보지 않는다"));
}

// ══ V5. M164 가 **유한**하고, assertion 으로 죽는다 ════════════════════════
// ⚠️ 처음 M164 는 `reconPage` 를 같은 커서로 무한 재귀시켰다. 결함(wrap-around 없음)은 그대로
//    두고 재귀만 끊어야 「굶는다」가 드러난다 — 안 끝나는 변이는 아무것도 증명하지 못한다.
{
  // ⚠️ **실행기는 원본 저장소에서 돌린다.** 돌연변이 사본은 git 저장소가 아니라 `git ls-files`
  //    가 거기서 아무것도 못 읽는다 — 다른 스위트가 쓰는 `SHHH_GIT_ROOT` 규약을 그대로 쓴다.
  const repo = process.env.SHHH_GIT_ROOT || fileURLToPath(new URL("..", import.meta.url));
  const r = await runWithTimeout(process.execPath, ["scripts/mutate.mjs", "--only", "M164"],
    { cwd: repo, timeoutMs: 90_000 });
  assert.equal(r.timedOut, false, t("V5: ★ M164 단독 실행이 90초 안에 안 끝난다 — 무한 변이다"));
  assert.equal(r.status, 0,
    t(`V5: ★ M164 가 안 죽었다 (exit ${r.status})\n${r.out.split("\n").slice(-12).join("\n")}`));
  assert.match(r.out, /M164\s+KILLED/, t("V5: ★ M164 판정이 KILLED 가 아니다"));
  assert.ok(!/TIMEOUT/.test(r.out.match(/M164[^\n]*/)?.[0] || ""), t("V5: M164 가 timeout 으로 끝났다"));
}

// ══ V6. R11 의 「전수」가 실제 실행한 경계만 센다 ═══════════════════════════
{
  const src = read("scripts/test-ops-race.mjs");
  // ⚠️ **주석이 아니라 assertion 자리만** 본다 — 과거의 오류를 설명하는 문장은 통과해야 한다
  //    (`test-docs` 가 정정 맥락을 허용하는 것과 같은 이유다).
  assert.ok(!/assert\.ok\(fired \|\|/.test(src),
    t("V6: ★ 배리어가 안 걸린 회차를 예외로 통과시킨다 — 실행 안 한 경계를 전수에 센다"));
  assert.match(src, /assert\.ok\(fired,/,
    t("V6: ★ 배리어가 실제로 걸렸는지 요구하지 않는다"));
  // 마지막 자리(명령이 없는 자리)에서도 실제로 완주시켜야 한다.
  assert.match(src, /if \(!fired\) await cross\(\);/,
    t("V6: ★ 마지막 경계에서 reconciliation 을 안 돌린다"));
  // 핵심 상태 전이가 배리어 자리에 실제로 들어 있는지 스위트 스스로 확인해야 한다.
  for (const need of ["'uploading'", "'uploaded'", "'ready'", "object put"])
    assert.ok(src.includes(need), t(`V6: R11 이 ${need} 경계를 확인하지 않는다`));
}

// ══ V7. 제한 시간의 원본이 **측정한 기준선**이다 ═══════════════════════════
// 손으로 고른 상수는 스위트가 무거워지는 날 조용히 낡는다.
{
  const src = read("scripts/mutate.mjs");
  assert.match(src, /Date\.now\(\) - t0\) \* 20/, t("V7: 제한 시간이 기준선에서 파생되지 않는다"));
  assert.match(src, /TIMEOUT_FLOOR/, t("V7: 제한 시간에 하한이 없다"));
}

console.log(`test-verifier: ${n}개 통과 — 실행기 수명주기(프로세스 그룹·제한 시간·TIMEOUT 판정) · `
  + `M164 유한성 · R11 실행 경계 전수`);
