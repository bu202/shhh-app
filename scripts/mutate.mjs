// 돌연변이 검증 실행기. `node scripts/mutate.mjs [--only M01,M14] [--json <경로>]`
//
// 왜 있나: **테스트가 통과한다는 것과 테스트가 방어를 지킨다는 것은 다른 말이다.** 이 저장소는
// 스위트가 전부 통과하는 상태에서 결함 25건을 차례로 재현했다. 그래서 완료 판정의 근거를
// 「통과 개수」가 아니라 **「보안 불변식을 깨면 어느 테스트가 실제로 실패하는가」**로 옮긴다.
//
// ⚠️ **원본 작업 폴더를 절대 건드리지 않는다.** 추적 파일 목록(`git ls-files`)을 임시 폴더로
//    복사해 거기서만 고친다. 중간에 죽어도 원본은 그대로다.
//    ⛔ 미추적 디렉터리(`네이버검수-캡처/`)는 `git ls-files` 에 안 나오므로 **구조적으로 제외**된다 —
//       제외 목록을 손으로 적지 않는다(손으로 적은 목록은 낡는다).
// ⚠️ `node_modules` 는 복사하지 않고 **심볼릭 링크**를 건다(수백 MB 를 매번 복사할 이유가 없다).
import { MUTATIONS } from "./mutations.mjs";
import { runWithTimeout, tally, classify, cleanupFailed, nextMutationAllowed, resultRow, VERDICTS, FATAL,
         INFRA_ERROR, CLEANUP_DEADLINE_MS } from "./_mutate-lib.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync,
         rmSync, symlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── 플랫폼 게이트 (설계서 §0-22-4) ──────────────────────────────────────
// 이 실행기의 안전은 **POSIX 프로세스 그룹**(음수 PGID) 위에 서 있다. Windows 에는 그 계약이
// 없다. ⛔ **조용히 그룹 검사를 건너뛰고 도는 것이 가장 나쁘다** — 잔류 손자가 있는 채로
// 표가 초록이 된다. 그래서 시작 시점에 fail-closed 로 멈춘다.
if (process.platform === "win32") {
  console.error("⛔ 이 플랫폼에서는 프로세스 그룹 부재를 증명할 수 없다 — 돌연변이를 실행하지 않는다.");
  process.exit(2);
}
const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : null;
};
const only = (arg("--only") || "").split(",").filter(Boolean);
const jsonOut = arg("--json");
// 제한 시간의 원본은 **측정한 기준선**이다(손으로 고른 상수가 아니다). 기준선의 20배,
// 최소 15초. ⚠️ 이 값이 없으면 종료하지 않는 변이 하나가 전체 검증을 멈춘다(위협 91).
const TIMEOUT_FLOOR = 15_000;
const timeoutArg = Number(arg("--timeout")) || 0;
const list = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;
if (only.length && list.length !== only.length) {
  console.error("모르는 돌연변이 id 가 있다:", only.filter((i) => !MUTATIONS.some((m) => m.id === i)).join(","));
  process.exit(2);
}

// ── 임시 사본 ──
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 << 20 })
  .toString("utf8").split("\0").filter(Boolean);
// ⚠️ **지난 실행이 남긴 사본을 먼저 치운다.** 이 실행기는 자식을 **프로세스 그룹째 SIGKILL**
//    하는데(위협 91), `test-verifier` 안에서 도는 중첩 실행이 그렇게 죽으면 `finally` 가 돌지
//    못해 사본이 남는다 — 실측으로 한 번에 125개(약 1.6GB)가 쌓였다. SIGKILL 은 잡을 수 없으므로
//    핸들러로는 못 막고, 다음 실행이 치우는 것이 유일한 자리다.
//    ⛔ **우리 접두사 · 2시간보다 오래된 것만** 지운다 — 지금 도는 형제 실행을 건드리지 않는다.
const PREFIX = "shhh-mutate-";
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(PREFIX)) continue;
  const old = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(old).mtimeMs < 2 * 3600e3) continue;
    rmSync(old, { recursive: true, force: true });
  } catch { /* 남의 것이거나 이미 없다 — 조용히 넘어간다 */ }
}
const dir = mkdtempSync(join(tmpdir(), PREFIX));
for (const rel of tracked) {
  const dst = join(dir, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(ROOT, rel), dst);       // **작업 트리의 현재 내용**을 복사한다(HEAD 가 아니다)
}
symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));

// ⚠️ **아직 스테이징하지 않은 새 파일은 사본에 없다.** `git ls-files` 는 인덱스를 읽기 때문이다.
//    그 상태로 돌리면 「기준선이 빨갛다」로만 보이고 원인이 안 보인다 — 여기서 이름을 대고 멈춘다.
//    (미추적 파일을 통째로 긁어오지 않는 이유: 보호 대상 미추적 디렉터리가 따라온다.)
{
  const missing = [...new Set(list.map((m) => `scripts/${m.suite}.mjs`).concat(list.map((m) => m.file)))]
    .filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    console.error("사본에 없는 파일이 있다 — `git add` 로 먼저 인덱스에 넣을 것:");
    for (const f of missing) console.error("  " + f);
    rmSync(dir, { recursive: true, force: true });
    process.exit(2);
  }
}

const rows = [];
const screen = new Map();   // 화면용 문장 — JSON 에 싣지 않는다
let baselineFail = 0;
let aborted = null;
try {
  // ── 0. 기준선. 변이 없이 대상 스위트가 **통과**해야 한다.
  //    안 그러면 아래의 「죽었다」는 변이 때문인지 원래 빨간지 구분이 안 된다.
  const suites = [...new Set(list.map((m) => m.suite))];
  const budget = new Map();
  for (const s of suites) {
    const t0 = Date.now();
    const r = await runWithTimeout("node", [`scripts/${s}.mjs`],
      { cwd: dir, env: { ...process.env, SHHH_GIT_ROOT: ROOT }, timeoutMs: 120_000 });
    // ⛔ **기준선은 1번 갈래(`started:true` · `exited` · `status:0`)만 허용한다.**
    //    측정 불능·timeout·spawn 실패·signal·잔류 그룹은 전부 **즉시 전체 중단**이다 —
    //    기준선을 못 재면 그 뒤 표는 하나도 읽을 수 없다(설계서 §0-21-2b Ⅲ 21번).
    //    ⚠️ 옛 판은 `exit null` 이라고만 말해서 **환경 문제가 코드 문제로 읽혔다.**
    const c = classify(r);
    if (c.outcome !== "exited" || c.verdict !== "SURVIVED") {
      baselineFail++;
      console.error(c.outcome === "exited"
        ? `⛔ 기준선 실패: ${s} 가 변이 없이도 실패한다 (정규화 상태 exited · 판정 ${c.verdict})`
        : `⛔ 기준선 ${c.outcome}: ${s} — ${c.why}`);
      if (c.outcome === "exited")
        console.error("   " + (r.out.split("\n").filter((l) => /Assertion|✗/.test(l))[0] || "").trim());
      if (cleanupFailed(r)) console.error(`   ⛔ 잔류 프로세스 그룹이 없음을 증명하지 못했다 — PGID ${r.pgid}`);
      continue;
    }
    budget.set(s, timeoutArg || Math.max(TIMEOUT_FLOOR, (Date.now() - t0) * 20));
  }
  if (baselineFail) { console.error("기준선이 빨간 상태에서는 돌연변이 결과를 믿을 수 없다."); process.exit(2); }

  // ── 1. 하나씩 적용 → 실행 → 되돌리기
  for (const m of list) {
    const p = join(dir, m.file);
    const src = readFileSync(p, "utf8");
    let mutated = null;
    if (m.transform) mutated = m.transform(src);
    else if (src.split(m.find).length - 1 === 1) mutated = src.split(m.find).join(m.replace);

    if (mutated === null || mutated === undefined || mutated === src) {
      // **앵커를 못 찾은 것은 통과가 아니다.** 코드가 바뀌어 목록이 낡았다는 뜻이라 실패로 센다.
      rows.push({ ...resultRow(m, { status: null, signal: null, started: false, timedOut: false,
                                    spawnFailed: false, postSpawnError: false },
                               { verdict: "ANCHOR-MISS", outcome: "unobservable",
                                 why: "대상 코드를 못 찾았다 — 목록이 낡았다" }) });
      continue;
    }
    // ⚠️ **두 파일을 함께 바꾸는 변이 기능(`also`)을 만들었다가 지웠다**(2026-08-25).
    //    쓰려던 곳은 「검사를 무력화하고 그 검사가 막던 조건을 되살린다」였는데, 그런 변이는
    //    **원리적으로 죽지 않는다** — 없앤 방어가 곧 유일한 관측 수단이라 「아무것도 실패하지
    //    않음」이 나온다. 답은 기능이 아니라 **검사 쪽에 자기검사를 붙이는 것**이었다
    //    (`test-docs` 의 `exemptByDate` 합성 입력). 안 쓰는 기능은 남기지 않는다.
    writeFileSync(p, mutated);
    const timeoutMs = budget.get(m.suite) ?? TIMEOUT_FLOOR;
    const r = await runWithTimeout("node", [`scripts/${m.suite}.mjs`],
      { cwd: dir, env: { ...process.env, SHHH_GIT_ROOT: ROOT }, timeoutMs });
    writeFileSync(p, src);
    // ⛔ **판정을 여기서 다시 쓰지 않는다.** 종료 코드와 제한 시간 플래그를 직접 보는
    //    삼항식이 바로 위협 93 의 자리였고, 그 규칙이 기준선과 이 루프 **두 곳**에 갈라져
    //    있었다. 이제 둘 다 같은 `classify()` 를 지난다(설계서 §0-21-3 B안).
    //    아래 구조분해는 **증거를 산출물에 싣기 위한 것**이지 판정에 쓰지 않는다.
    const c = classify(r);
    rows.push(resultRow(m, r, c));
    // 화면용 한 줄은 **JSON 에 싣지 않는다** — 자식 출력에서 잘라 온 문자열이기 때문이다.
    screen.set(m.id, (r.out.split("\n").find((l) => /AssertionError|✗/.test(l)) || "").trim().slice(0, 120));
    // ⛔ **정리를 증명하지 못하면 남은 변이를 하나도 실행하지 않는다**(설계서 §0-22-8).
    //    잔류 프로세스가 있는 채로 다음 변이를 재면 그 뒤의 모든 판정이 「부하 때문인지
    //    변이 때문인지」 갈리지 않는다 — 표가 한 줄 나빠지는 것이 아니라 **전체가 무의미**해진다.
    if (!nextMutationAllowed(r)) {
      aborted = { id: m.id, pgid: r.pgid,
                  why: r.cleanupTimedOut ? `${Math.round(CLEANUP_DEADLINE_MS / 1000)}초 안에 확인하지 못했다`
                                         : `close=${r.closeSeen} · 그룹=${r.groupState}` };
      break;
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 보고 ──
const w = (s, n) => String(s).padEnd(n);
console.log("");
console.log(`${w("ID", 5)} ${w("판정", 12)} ${w("종류", 6)} ${w("스위트", 22)} 무엇을 바꿨나`);
console.log("-".repeat(108));
for (const r of rows) console.log(`${w(r.id, 5)} ${w(r.verdict, 12)} ${w(r.kind, 6)} ${w(r.suite, 22)} ${r.what}`);
const sum = tally(rows);
const of = (v) => rows.filter((r) => r.verdict === v);
console.log("-".repeat(108));
console.log(`총 ${sum.total}종 · 사망 ${sum.KILLED} · 생존 ${sum.SURVIVED}`
  + ` · 앵커 실패 ${sum["ANCHOR-MISS"]} · 제한 시간 초과 ${sum.TIMEOUT}`
  + ` · 측정 불능 ${sum[INFRA_ERROR]}`);
// ⚠️ **정적 검사와 동작 검사를 한 숫자로 합쳐 읽지 않는다.** 문서 일관성이 아무리 촘촘해도
//    런타임 방어를 증명하지 못한다 — 그 착각이 이 저장소가 여섯 판 연속 겪은 사고의 모양이다.
for (const k of ["동작", "정적"]) {
  const g = rows.filter((r) => r.kind === k);
  if (!g.length) continue;
  console.log(`  · ${k} 검사 ${g.length}종 — 사망 ${g.filter((r) => r.verdict === "KILLED").length}`
    + ` · 생존 ${g.filter((r) => r.verdict === "SURVIVED").length}`
    + ` · 앵커 실패 ${g.filter((r) => r.verdict === "ANCHOR-MISS").length}`
    + ` · 제한 시간 초과 ${g.filter((r) => r.verdict === "TIMEOUT").length}`
    + ` · 측정 불능 ${g.filter((r) => r.verdict === INFRA_ERROR).length}`);
}
for (const r of of("SURVIVED"))
  console.log(`  ⚠️ 생존 ${r.id} — ${r.what}\n     깨진 불변식: ${r.invariant}`);
for (const r of of("ANCHOR-MISS")) console.log(`  ⛔ 앵커 실패 ${r.id} — ${r.what}`);
for (const r of of("TIMEOUT"))
  console.log(`  ⛔ 제한 시간 초과 ${r.id} — ${r.what}\n     재지 못했다(사망이 아니다): ${r.detail}`);
// ⛔ **측정 불능을 사망 통계에 섞지 않는다.** 「방어가 잡았다」가 아니라 **「아무것도 재지
//    못했다」**이고, 운영자가 할 일은 테스트 보강이 아니라 **실행 환경 확인**이다.
for (const r of of(INFRA_ERROR)) {
  console.log(`  ⛔ 측정 불능 ${r.id} (${r.outcome}) — ${r.what}\n     ${r.detail}`);
  const line = screen.get(r.id);                 // 화면에만 — 자식 출력이라 JSON 에 안 싣는다
  if (line) console.log(`     자식이 남긴 마지막 줄: ${line}`);
}

if (aborted) {
  // 화면에만 PGID 를 적는다 — JSON 에는 가변 세부정보를 싣지 않는다(설계서 §0-22-8).
  console.error(`\n⛔ 잔류 프로세스 그룹이 없음을 증명하지 못했다 — PGID ${aborted.pgid} (${aborted.id}: ${aborted.why})`);
  console.error(`   남은 변이를 실행하지 않고 중단한다. 그 그룹을 직접 확인할 것: ps -g ${aborted.pgid}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), verdicts: VERDICTS,
                                          fatal: FATAL, aborted: !!aborted,
                                          summary: sum, rows }, null, 2));
  console.log(`\n결과를 ${jsonOut} 에 적었다.`);
}
// **생존·앵커 실패·제한 시간 초과·측정 불능이 하나라도 있으면 0 이 아니다.** 설명은 사람이 하되,
// 기본값은 실패다. ⛔ **정리를 증명 못 해 중단한 실행은 1 이 아니라 2 다** — 그 표는 완성되지도
// 않았고, 「재 봤더니 몇 개 살았다」와 「아예 재지 못했다」를 같은 코드로 말하지 않는다.
if (aborted) process.exit(2);
process.exit(sum.fatal ? 1 : 0);
