// 돌연변이 검증 실행기. `node scripts/mutate.mjs [--only M01,M14] [--json <경로>]`
//
// 왜 있나: **테스트가 통과한다는 것과 테스트가 방어를 지킨다는 것은 다른 말이다.** 이 저장소는
// 스위트가 전부 통과하는 상태에서 결함 22건을 차례로 재현했다. 그래서 완료 판정의 근거를
// 「통과 개수」가 아니라 **「보안 불변식을 깨면 어느 테스트가 실제로 실패하는가」**로 옮긴다.
//
// ⚠️ **원본 작업 폴더를 절대 건드리지 않는다.** 추적 파일 목록(`git ls-files`)을 임시 폴더로
//    복사해 거기서만 고친다. 중간에 죽어도 원본은 그대로다.
//    ⛔ 미추적 디렉터리(`네이버검수-캡처/`)는 `git ls-files` 에 안 나오므로 **구조적으로 제외**된다 —
//       제외 목록을 손으로 적지 않는다(손으로 적은 목록은 낡는다).
// ⚠️ `node_modules` 는 복사하지 않고 **심볼릭 링크**를 건다(수백 MB 를 매번 복사할 이유가 없다).
import { MUTATIONS } from "./mutations.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync,
         rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : null;
};
const only = (arg("--only") || "").split(",").filter(Boolean);
const jsonOut = arg("--json");
const list = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;
if (only.length && list.length !== only.length) {
  console.error("모르는 돌연변이 id 가 있다:", only.filter((i) => !MUTATIONS.some((m) => m.id === i)).join(","));
  process.exit(2);
}

// ── 임시 사본 ──
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 << 20 })
  .toString("utf8").split("\0").filter(Boolean);
const dir = mkdtempSync(join(tmpdir(), "shhh-mutate-"));
for (const rel of tracked) {
  const dst = join(dir, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(ROOT, rel), dst);       // **작업 트리의 현재 내용**을 복사한다(HEAD 가 아니다)
}
symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));

const rows = [];
let baselineFail = 0;
try {
  // ── 0. 기준선. 변이 없이 대상 스위트가 **통과**해야 한다.
  //    안 그러면 아래의 「죽었다」는 변이 때문인지 원래 빨간지 구분이 안 된다.
  const suites = [...new Set(list.map((m) => m.suite))];
  for (const s of suites) {
    const r = spawnSync("node", [`scripts/${s}.mjs`], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) {
      baselineFail++;
      console.error(`⛔ 기준선 실패: ${s} 가 변이 없이도 실패한다 (exit ${r.status})`);
      console.error((r.stderr || r.stdout || "").split("\n").filter((l) => /Assertion|✗/.test(l))[0] || "");
    }
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
      rows.push({ ...pick(m), verdict: "ANCHOR-MISS", exit: null,
                  detail: "대상 코드를 못 찾았다 — 목록이 낡았다" });
      continue;
    }
    writeFileSync(p, mutated);
    const r = spawnSync("node", [`scripts/${m.suite}.mjs`], { cwd: dir, encoding: "utf8" });
    writeFileSync(p, src);
    const out = (r.stderr || "") + (r.stdout || "");
    const why = out.split("\n").find((l) => /AssertionError|✗/.test(l)) || "";
    rows.push({ ...pick(m), verdict: r.status === 0 ? "SURVIVED" : "KILLED", exit: r.status,
                detail: why.trim().slice(0, 120) });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function pick(m) {
  return { id: m.id, file: m.file, suite: m.suite, what: m.what, invariant: m.invariant };
}

// ── 보고 ──
const w = (s, n) => String(s).padEnd(n);
console.log("");
console.log(`${w("ID", 5)} ${w("판정", 12)} ${w("스위트", 22)} 무엇을 바꿨나`);
console.log("-".repeat(100));
for (const r of rows) console.log(`${w(r.id, 5)} ${w(r.verdict, 12)} ${w(r.suite, 22)} ${r.what}`);
const killed = rows.filter((r) => r.verdict === "KILLED").length;
const survived = rows.filter((r) => r.verdict === "SURVIVED");
const missed = rows.filter((r) => r.verdict === "ANCHOR-MISS");
console.log("-".repeat(100));
console.log(`총 ${rows.length}종 · 사망 ${killed} · 생존 ${survived.length} · 앵커 실패 ${missed.length}`);
for (const r of survived)
  console.log(`  ⚠️ 생존 ${r.id} — ${r.what}\n     깨진 불변식: ${r.invariant}`);
for (const r of missed) console.log(`  ⛔ 앵커 실패 ${r.id} — ${r.what}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log(`\n결과를 ${jsonOut} 에 적었다.`);
}
// **생존이나 앵커 실패가 하나라도 있으면 0 이 아니다.** 설명은 사람이 하되, 기본값은 실패다.
process.exit(survived.length + missed.length ? 1 : 0);
