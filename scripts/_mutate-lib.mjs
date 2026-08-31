// 돌연변이 실행기의 **수명주기**와 **판정**. `mutate.mjs`(실행기)와
// `test-verifier.mjs`(그 실행기를 검증하는 스위트)가 **같은 구현**을 쓴다 —
// 검증기가 자기 사본을 재면 아무것도 증명하지 못한다.
//
// ⚠️ 왜 생겼나 (2026-08-28 · 위협 91): 변이 하나(M164)가 `reconPage` 를 같은 커서로 재귀시켜
//    **종료하지 않는 자식**을 만들었다. 실행기에는 제한 시간이 없어서 211종 검증이 통째로
//    멈췄고, 바깥에서 실행기를 죽여도 **손자(스위트 프로세스)가 계속 CPU 를 먹으며 남았다.**
//    그 상태는 「생존 0」도 「사망 211」도 아닌 **측정 불능**인데, 표에는 아무것도 안 나와서
//    「아직 안 끝났다」로만 보였다.
//
// ⚠️ 그 마감은 **부분 마감이었다** (2026-08-29 · 위협 93 · 설계서 §0-21): `status === null` 의
//    생산자 셋 중 **우리 타이머 하나만** 갈라냈다. 실측으로 확인한 나머지 둘 —
//    **spawn 실패**(ENOENT·EACCES)와 **바깥에서 온 signal** — 은 그대로 `KILLED` 로 접혔다.
//    즉 `node` 를 못 띄우는 환경에서는 **전부 사망 · 종료 코드 0** 이었다.
//
// ⛔ 그리고 「자식이 닫혔다」를 `close` 로 재지 않는다 (2026-08-29 · 위협 94 · 설계서 §0-22).
//    Node 의 `'close'` 는 **그 자식 하나와 그 stdio** 만 보장한다 — 재현에서 `close` 뒤에도
//    `kill(-pgid, 0)` 이 `alive` 였고 손자가 살아 있었다. 그래서 완료 조건은
//    **`closeSeen && groupState === "absent"`** 이고, 부재는 **음수 PGID probe 가 `ESRCH`**
//    일 때만 인정한다.
import { spawn as nodeSpawn } from "node:child_process";

// ── 상수 ────────────────────────────────────────────────────────────────
// ⛔ **mutation timeout 과 같은 값을 쓰지 않는다.** 재는 대상이 다르다 —
//    mutation timeout 은 「테스트가 너무 오래 돈다」이고, 이 값은 「종료 명령 뒤 실제로
//    닫혔나」다. 한 상수를 돌려 쓰면 정리 확인이 실행 시간에 끌려다닌다(설계서 §0-21-2a).
export const CLEANUP_DEADLINE_MS = 10_000;
// 직접 자식이 닫힌 뒤 그룹이 **스스로** 빠지기를 기다리는 창. 이 창을 넘겨도 그룹이 남아
// 있으면 그때가 **잔류**다. ⚠️ 이것은 불변식의 유예가 아니다 — 어느 경우에도 그룹 부재를
// 확인하기 전에는 반환하지 않는다. 창은 「정상 종료 중인 손자」와 「잔류」를 가르기만 한다.
export const GROUP_SETTLE_MS = 400;
const PROBE_MS = 25;

export const GROUP_STATES = ["unknown", "present", "absent", "unverifiable"];
export const OUTCOMES = ["exited", "timeout", "start-timeout", "spawn-failed",
                         "post-spawn-error", "signalled", "residual-group", "unobservable"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 그룹 부재 probe (설계서 §0-22-4) ────────────────────────────────────
// ⛔ **양수 PID probe 금지.** `process.kill(pid, 0)` 은 그 프로세스 하나만 말한다 —
//    재현에서 직접 자식은 `ESRCH` 인데 **그룹은 살아 있었다.**
// ⛔ `pgid <= 1` 은 절대 묻지 않는다. POSIX 에서 `kill(-1, …)` 은 **보낼 수 있는 모든
//    프로세스**를 뜻해 사용자의 다른 작업까지 대상이 된다.
export function probeGroup(pgid, kill = process.kill) {
  if (!Number.isInteger(pgid) || pgid <= 1) return "unverifiable";
  try {
    kill(-pgid, 0);
    return "present";
  } catch (e) {
    if (e && e.code === "ESRCH") return "absent";
    if (e && e.code === "EPERM") return "unverifiable";
    return "unverifiable";
  }
}

// ── 실행 (설계서 §0-21-2·§0-21-2a·§0-22-3) ──────────────────────────────
// 결과 계약: started · status · signal · timedOut · startTimedOut · spawnFailed ·
//            postSpawnError · out · pgid · closeSeen · groupState ·
//            residualGroupDetected · cleanupRequested · cleanupTimedOut
export function runWithTimeout(cmd, args, opts = {}) {
  const { cwd, env, timeoutMs,
          cleanupMs = CLEANUP_DEADLINE_MS, settleMs = GROUP_SETTLE_MS,
          spawn: spawnFn = nodeSpawn, kill: killFn = process.kill } = opts;
  return new Promise((resolve) => {
    const ev = {
      started: false, status: null, signal: null,
      timedOut: false, startTimedOut: false,
      spawnFailed: false, postSpawnError: false,
      out: "", pgid: null,
      closeSeen: false, groupState: "unknown",
      residualGroupDetected: false, cleanupRequested: false, cleanupTimedOut: false,
    };
    // ⛔ **「Promise 는 두 번째 resolve 를 무시한다」에 기대지 않는다.** 그 성질이 지켜 주는
    //    것은 반환값 하나뿐이고, 이 함수에는 `clearTimeout` · 그룹 kill · 종료 확인이라는
    //    **부수효과**가 있다. 확정은 `finalize()` 한 자리에서 정확히 한 번 일어난다.
    let settled = false, exitLatched = false, settling = false;
    let timer = null, deadline = null;
    // ⚠️ **공유 객체**로 센다. 결과는 얕은 사본이라, 두 번째 확정이 일어나도 이미 돌려준
    //    객체의 숫자는 안 바뀐다 — 그러면 「한 번만 확정한다」를 아무도 못 잰다.
    const audit = { finalizeCount: 0, clearedTimers: 0 };

    const finalize = () => {
      if (settled) return;
      settled = true;
      audit.finalizeCount++;
      clearTimeout(timer);
      clearTimeout(deadline);
      audit.clearedTimers++;
      // 얕은 사본을 돌려준다 — 확정 뒤에 늦게 오는 `close(-2)` 가 앞선 증거를 덮지 못한다.
      resolve({ ...ev, audit });
    };

    const grab = (d) => { ev.out += d; if (ev.out.length > (1 << 20)) ev.out = ev.out.slice(-(1 << 20)); };

    const armDeadline = () => {
      if (deadline) return;
      deadline = setTimeout(() => {
        if (settled) return;
        ev.cleanupTimedOut = true;
        finalize();
      }, cleanupMs);
    };

    // kill 은 **요청**이다. 종료가 아니다.
    const requestCleanup = () => {
      armDeadline();
      if (ev.pgid === null || ev.cleanupRequested) return;
      ev.cleanupRequested = true;
      try { killFn(-ev.pgid, "SIGKILL"); }
      catch (e) { if (!e || e.code !== "ESRCH") ev.postSpawnError = true; }
    };

    // 정리 확인 — `close` 와 **그룹 부재**를 둘 다 본 뒤에만 확정한다(§0-22-8).
    const confirmCleanup = async () => {
      if (settling) return;
      settling = true;
      armDeadline();
      const t0 = Date.now();
      for (;;) {
        if (settled) return;
        const state = probeGroup(ev.pgid, killFn);
        ev.groupState = state;
        // ⛔ **둘 다** 봐야 한다 — 그룹 부재만으로도, `close` 만으로도 확정하지 않는다.
        //    늦게 온 `'spawn'` 을 죽인 직후에는 그룹이 비었어도 `close` 가 아직 안 왔다.
        if (state === "absent" && ev.closeSeen) return finalize();
        if (state === "unverifiable") return finalize();   // ⛔ EPERM 은 부재가 아니다
        const waited = Date.now() - t0;   // 정리 기한은 `armDeadline()` **한 자리**가 소유한다
        if (waited >= settleMs && !ev.residualGroupDetected) {
          ev.residualGroupDetected = true;                 // 직접 자식이 끝났는데 그룹이 안 빠진다
          requestCleanup();
        }
        await sleep(PROBE_MS);
      }
    };

    // 자식이 아예 만들어지지 않았으면 확인할 그룹이 없다(§0-22-3 ⓐ).
    const settleNow = () => { if (ev.pgid === null) finalize(); else void confirmCleanup(); };

    let ch;
    try {
      // group-escape-ok: 검증기 **자신**이 그룹을 만드는 유일한 자리다 — 자식이 그 그룹의 리더가 되어야
      // 음수 PGID 로 그룹 부재를 물을 수 있다(설계서 §0-22-4·§0-22-9).
      ch = spawnFn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); // group-escape-ok: 위 주석
    } catch (e) {
      ev.spawnFailed = true; ev.out += String(e); finalize(); return;
    }
    if (ch.stdout) ch.stdout.on("data", grab);
    if (ch.stderr) ch.stderr.on("data", grab);

    // ⛔ 시작은 **관측**한다 — `pid` 존재나 `spawnFailed === false` 로 추정하지 않는다.
    ch.on("spawn", () => {
      if (!ev.started) { ev.started = true; ev.pgid = Number.isInteger(ch.pid) ? ch.pid : null; }
      // `start-timeout` 뒤 늦게 온 시작: 아무도 모르는 자식을 남기지 않는다.
      if (ev.startTimedOut) { requestCleanup(); void confirmCleanup(); }
    });

    ch.on("error", (e) => {
      ev.out += String(e);
      // 시작 전 error 와 시작 후 error 를 가른다 — 「아무것도 실행되지 않았다」를
      // 거짓으로 기록하면 운영자를 실행 환경 쪽으로 잘못 보낸다.
      if (ev.started) { ev.postSpawnError = true; }
      else if (!ev.spawnFailed) { ev.spawnFailed = true; }
      // ⛔ `error` 는 종료의 증거가 아니다. 자식이 아예 없는 경우에만 그 자리에서 확정한다.
      if (!ev.started && ev.pgid === null) finalize();
      else armDeadline();
    });

    ch.on("close", (code, signal) => {
      if (!exitLatched) { exitLatched = true; ev.status = code ?? null; ev.signal = signal ?? null; }
      ev.closeSeen = true;
      settleNow();
    });

    timer = setTimeout(() => {
      ev.timedOut = true;
      if (ev.started) requestCleanup();
      else { ev.startTimedOut = true; armDeadline(); }   // 죽일 대상이 아직 없다
    }, timeoutMs);
  });
}

// ── 판정 (설계서 §0-21-2b·§0-21-2c·§0-22-7) ─────────────────────────────
export const INFRA_ERROR = "INFRA-ERROR";
// 판정은 다섯이다. ⛔ **TIMEOUT 을 KILLED 로 세지 않는다** — 제한 시간에 걸린 것은
// 「방어가 그 변이를 잡았다」가 아니라 **「재지 못했다」**다. ⛔ **INFRA-ERROR 를 TIMEOUT 과
// 합치지도 않는다** — 둘 다 측정 불능이지만 운영자가 할 일이 다르다.
export const VERDICTS = ["KILLED", "SURVIVED", "ANCHOR-MISS", "TIMEOUT", INFRA_ERROR];
// 완료 조건: 아래 넷이 전부 0.
export const FATAL = ["SURVIVED", "ANCHOR-MISS", "TIMEOUT", INFRA_ERROR];

// `KILLED` 의 필요충분조건(설계서 §0-21-2c). ⛔ **개수를 문서에 손으로 적지 않는다** —
// `scripts/test-docs.mjs` 가 이 목록의 길이와 문서의 주장을 대조한다.
export const KILLED_REQUIREMENTS = [
  "started === true ('spawn' 이벤트를 봤다)",
  "spawnFailed === false",
  "postSpawnError === false",
  "timedOut === false",
  "signal === null",
  "Number.isInteger(status)",
  "status !== 0",
  "closeSeen === true",
  'groupState === "absent"',
  "residualGroupDetected === false",
  'cleanupTimedOut === false',
  '정규화 상태가 "exited"',
];

// 원인은 **정규화 상태에서 만든 고정 문구**다. ⛔ 오류 원문·환경 변수·명령 인자·자식 출력을
// 산출물에 싣지 않는다(설계서 §0-21-2c 파생 규칙 4).
export const WHY = {
  "exited": "자식을 끝까지 관측했고 정상적으로 종료했다",
  "timeout": "제한 시간을 넘겨 프로세스 그룹을 종료시켰다 — 잡은 것이 아니라 재지 못한 것이다",
  "start-timeout": "자식이 시작되기 전에 제한 시간이 만료됐다 — 돌연변이가 실행된 증거가 없다",
  "spawn-failed": "자식을 시작하지 못했다 — 실행 환경 문제다",
  "post-spawn-error": "시작한 자식을 끝까지 관측하지 못했다",
  "signalled": "바깥에서 온 신호로 종료됐다 — 방어와 무관한 종료다",
  "residual-group": "직접 자식이 끝난 뒤에도 프로세스 그룹이 남아 있었다",
  "unobservable": "실행 결과를 증거로 확정할 수 없다",
};

const OUTCOME_VERDICT = {
  "timeout": "TIMEOUT",
  "start-timeout": INFRA_ERROR,
  "spawn-failed": INFRA_ERROR,
  "post-spawn-error": INFRA_ERROR,
  "signalled": INFRA_ERROR,
  "residual-group": INFRA_ERROR,
  "unobservable": INFRA_ERROR,
};

// ⛔ **기본값은 `unobservable` 이다.** 마지막 갈래가 `exited` 이면 새 필드 하나가 조용히
//    만점을 만든다 — 이 저장소가 열세 판째 만나는 무늬가 「기본값이 성공」이다.
function outcomeOf(r) {
  if (!r || typeof r !== "object") return "unobservable";
  const B = (k) => typeof r[k] === "boolean";
  if (!B("started") || !B("timedOut") || !B("spawnFailed") || !B("postSpawnError")) return "unobservable";
  if (!(r.status === null || Number.isInteger(r.status))) return "unobservable";
  if (!(r.signal === null || typeof r.signal === "string")) return "unobservable";

  // 1. 아무것도 실행되지 않았다는 증거가 가장 강하다.
  if (r.spawnFailed) return r.started ? "unobservable" : "spawn-failed";
  // 2. 시작을 **관측**하지 못했으면 어떤 숫자 종료 코드도 증거가 아니다 —
  //    실측에서 ENOENT 는 `close(code=-2)` 라는 **숫자 non-zero** 를 낸다.
  if (!r.started) return r.timedOut ? "start-timeout" : "unobservable";
  // 3. 시작 뒤의 오류는 「끝까지 관측하지 못했다」는 증거다 — 숫자 검사보다 **앞**이다.
  if (r.postSpawnError) return "post-spawn-error";
  // 4. 시작된 자식은 **정리를 확인**해야 한다(§0-22-3).
  if (!B("closeSeen") || !B("residualGroupDetected") || !B("cleanupTimedOut")
      || !GROUP_STATES.includes(r.groupState)) return "unobservable";
  if (r.cleanupTimedOut) return "unobservable";
  if (r.groupState === "unverifiable") return "unobservable";
  if (r.residualGroupDetected || r.groupState === "present") return "residual-group";
  if (!r.closeSeen) return "unobservable";
  if (r.groupState !== "absent") return "unobservable";
  // 5. **spawn 전에 만료된 실행은 늦게 시작됐어도 `timeout` 이 아니다** — 그 실행에는
  //    돌연변이가 제대로 돌았다는 증거가 없다(설계서 §0-22-6 14번).
  if (r.startTimedOut === true) return "start-timeout";
  // 6. 우리 타이머 → 7. 바깥 신호 → 8. 숫자 종료 코드
  if (r.timedOut) return "timeout";
  if (r.signal !== null) return "signalled";
  if (Number.isInteger(r.status)) return "exited";
  return "unobservable";
}

export function classify(r) {
  let outcome = outcomeOf(r);
  // 입력이 실어 온 `outcome` 을 **믿지 않고 다시 계산한다** — 다르면 그 입력은 모순이다.
  if (r && typeof r === "object" && r.outcome != null && r.outcome !== outcome) outcome = "unobservable";
  const verdict = outcome === "exited"
    ? (r.status === 0 ? "SURVIVED" : "KILLED")
    : OUTCOME_VERDICT[outcome];
  return { outcome, verdict, why: WHY[outcome] };
}

// 정리를 증명하지 못한 실행은 **판정 한 줄로 끝나지 않는다** — 그 뒤 표 전체가 무의미해진다.
export function cleanupFailed(r) {
  return !!r && (r.cleanupTimedOut === true || r.groupState === "unverifiable");
}

// **핵심 불변식 (설계서 §0-22-3).** 다음 돌연변이는 ⓐ 자식이 아예 생성되지 않았거나
// ⓑ 직접 자식의 `close` **와** 검증기가 만든 프로세스 그룹의 **부재**가 둘 다 확인된 뒤에만
// 시작한다. ⛔ `promiseResolved` · `killRequested` · `directPidAbsent` · `closeSeen` 하나는
// 전부 이 조건의 대용이 될 수 없다 — 재현에서 `close` 와 손자 생존이 **공존**했다.
export function nextMutationAllowed(r) {
  if (!r || typeof r !== "object") return false;
  if (r.spawnFailed === true && r.started === false) return true;   // ⓐ 확인할 그룹이 없다
  return r.closeSeen === true && r.groupState === "absent";
}

export function tally(rows) {
  const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of rows) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
  t.total = rows.length;
  t.fatal = FATAL.reduce((n, v) => n + t[v], 0);
  return t;
}


// ── 프로세스 그룹 이탈 검사 (설계서 §0-22-9·G12) ────────────────────────
// 이 실행기가 통제하는 것은 「우리가 만든 그룹 안에 남아 있는 후손」이다. 후손이 스스로
// 스스로 새 세션을 열거나 새 그룹을 만들면 PGID 검사로는 못 잡는다. 2026-08-29 실측에서 그런 코드가
// 실행기 자신 말고는 0곳이었고, **그 전제를 사람의 기억이 아니라 검사가 지킨다.**
// ⛔ 광범위한 문자열 제외 규칙을 쓰지 않는다 — 예외는 **그 줄에 표식**이 있어야 한다.
export const GROUP_ESCAPE_MARK = "group-escape-ok:";
export const GROUP_ESCAPE_PATTERNS = [/detached/, /setsid/, /\.unref\(\)/, /\bfork\(/]; // group-escape-ok: 패턴 정의

// 표식 없는 이탈 API 사용을 전부 돌려준다. ⚠️ **순수 함수다** — 검사 자신을 합성 입력으로
// self-test 할 수 있어야 「검사를 무력화하는 변이」가 죽는다.
export function groupEscapeViolations(name, text) {
  const bad = [];
  String(text).split("\n").forEach((line, i) => {
    if (!GROUP_ESCAPE_PATTERNS.some((p) => p.test(line))) return;
    if (line.includes(GROUP_ESCAPE_MARK)) return;
    bad.push({ file: name, line: i + 1, text: line.trim().slice(0, 120) });
  });
  return bad;
}

// ── 산출물 행 (설계서 §0-21-2c 파생 규칙 4) ─────────────────────────────
// JSON 은 판정만 적지 않는다 — 행마다 **증거 일곱**과 정규화 상태에서 만든 **고정 문구**를 싣는다.
// ⛔ 오류 원문 · 환경 변수 · 명령 인자 · 자식 출력 원문 · 경로 · PGID 를 싣지 않는다.
export const JSON_EVIDENCE = ["started", "status", "signal", "timedOut",
                              "spawnFailed", "postSpawnError", "outcome"];

export function resultRow(m, r, c) {
  return {
    id: m.id, file: m.file, suite: m.suite, kind: m.kind || "동작",
    what: m.what, invariant: m.invariant,
    verdict: c.verdict, outcome: c.outcome,
    exit: r.status, signal: r.signal, started: r.started, timedOut: r.timedOut,
    spawnFailed: r.spawnFailed, postSpawnError: r.postSpawnError,
    detail: c.why,
  };
}
