// 돌연변이 실행기의 **수명주기**와 **판정 집계**. `mutate.mjs`(실행기)와
// `test-verifier.mjs`(그 실행기를 검증하는 스위트)가 **같은 구현**을 쓴다 —
// 검증기가 자기 사본을 재면 아무것도 증명하지 못한다.
//
// ⚠️ 왜 생겼나 (2026-08-28 · 위협 91): 변이 하나(M164)가 `reconPage` 를 같은 커서로 재귀시켜
//    **종료하지 않는 자식**을 만들었다. 실행기에는 제한 시간이 없어서 211종 검증이 통째로
//    멈췄고, 바깥에서 실행기를 죽여도 **손자(스위트 프로세스)가 계속 CPU 를 먹으며 남았다.**
//    그 상태는 「생존 0」도 「사망 211」도 아닌 **측정 불능**인데, 표에는 아무것도 안 나와서
//    「아직 안 끝났다」로만 보였다.
import { spawn } from "node:child_process";

// 종료하지 않는 자식을 제한 시간 안에 **프로세스 그룹째** 죽인다.
// ⛔ `spawnSync({ timeout })` 을 쓰지 않는다 — 그것은 **직계 자식만** 죽인다. 스위트가 손자를
//    띄우면(`test-workerd` 의 workerd) 그 손자는 그대로 남아 다음 회차와 CPU 를 다툰다.
export function runWithTimeout(cmd, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const grab = (d) => { out += d; if (out.length > (1 << 20)) out = out.slice(-(1 << 20)); };
    ch.stdout.on("data", grab);
    ch.stderr.on("data", grab);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 음수 pid = **프로세스 그룹 전체**. `detached: true` 라 자식이 그 그룹의 리더다.
      try { process.kill(-ch.pid, "SIGKILL"); } catch { try { ch.kill("SIGKILL"); } catch {} }
    }, timeoutMs);
    ch.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, out: out + String(e), timedOut: false, spawnFailed: true });
    });
    ch.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out, timedOut, spawnFailed: false });
    });
  });
}

// 판정은 넷이다. ⛔ **TIMEOUT 을 KILLED 로 세지 않는다** — 제한 시간에 걸린 것은
// 「방어가 그 변이를 잡았다」가 아니라 **「재지 못했다」**다. 둘을 합치면 종료하지 않는 변이가
// 곧 만점이 된다.
export const VERDICTS = ["KILLED", "SURVIVED", "ANCHOR-MISS", "TIMEOUT"];
// 완료 조건: 아래 셋이 전부 0.
export const FATAL = ["SURVIVED", "ANCHOR-MISS", "TIMEOUT"];

export function tally(rows) {
  const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of rows) t[r.verdict] = (t[r.verdict] ?? 0) + 1;
  t.total = rows.length;
  t.fatal = FATAL.reduce((n, v) => n + t[v], 0);
  return t;
}
