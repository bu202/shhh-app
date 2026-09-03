// **배포 경계의 원본.** 지금 라이브에 올라가 있는 source 커밋 하나다.
//
// 왜 여기 있나: 「무엇이 배포됐나」는 문서 여러 곳이 주장하는데, 그 주장들이 서로 어긋난 채
// 오래 살아 있었다. 실제로 세 문서가 **`e02e810` 에 위협 57~69 가 들어 있다**고 적고 있었고
// 그것은 거짓이었다 — 66~69 는 로컬 커밋뿐이다. 더 나쁜 것은, 그 거짓을 **검사가 강제하고
// 있었다**는 점이다: 옛 검사는 배포를 말하는 문장의 위협 범위 끝을 **최신 번호**와 같게
// 요구했고, 그래서 배포된 적 없는 번호를 적어야 통과했다.
//
// 그래서 이 파일은 **해시 하나만** 들고, 나머지는 전부 git 에서 파생한다:
//   배포 시점의 위협·T 최대 번호 = `git show <SOURCE>:docs/STAGE3_…md` 를 파싱한 값
// 손으로 유지하는 숫자가 없으므로 낡을 자리가 없다.
//
// ⚠️ **배포할 때 이 파일을 갱신한다.** 그것이 배포 절차의 일부다(docs/OPS_RUNBOOK.md).
//    갱신을 잊으면 검사가 「배포 주장」과 옛 커밋을 대조하므로 **틀린 쪽으로 시끄럽게** 실패한다.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 2026-09-03 production 배포 `715c897c` 의 source (보관함 경계 해시 제거 · 그림 실패 안내).
export const DEPLOYED_SOURCE = "e0c5921";
export const DEPLOYED_DEPLOYMENT_ID = "715c897c";
export const DEPLOYED_AT = "2026-09-03";

// ⚠️ **저장소 위치를 인자로 받을 수 있다.** 돌연변이 실행기는 추적 파일만 임시 폴더로 복사하고
//    `.git` 은 가져가지 않는다 — 그 사본에서 이 파생을 돌리면 「기준선이 빨갛다」로만 보이고
//    원인이 안 보인다(실제로 그랬다). 그래서 실행기가 원본 저장소 경로를 넘겨 준다.
//    ⛔ 배포 스냅샷은 **변이의 대상이 아니다** — 변이는 작업 트리를 고치는 것이고, 배포된
//       커밋의 내용은 git 안에 있어 변이가 닿지 않는다. 그것이 이 대조가 뜻을 갖는 이유다.
const REPO = process.env.SHHH_GIT_ROOT || fileURLToPath(new URL("..", import.meta.url));
const git = (...args) => execFileSync("git", args, { encoding: "utf8", cwd: REPO });

// 배포된 커밋 시점의 설계서. **지금 파일이 아니다** — 그것이 이 파생의 전부다.
const atDeploy = () => git("show", `${DEPLOYED_SOURCE}:docs/STAGE3_SIGNUP_SECURITY_DESIGN.md`);

const maxThreatIn = (text) =>
  Math.max(...[...text.matchAll(/^\|\s*\*\*(\d+)\*\*\s*\|/gm)].map((m) => +m[1]));
const maxTIn = (text) =>
  Math.max(...[...text.matchAll(/\bT(\d+)\b/g)].map((m) => +m[1]));

// 배포된 세대가 담고 있는 최대 위협 번호와 최대 T 번호.
export function deployedRanges() {
  const text = atDeploy();
  return { maxThreat: maxThreatIn(text), maxT: maxTIn(text) };
}

// 배포 지점이 지금 HEAD 의 조상인가. 아니면 배포 경계 주장 전체가 뜻을 잃는다.
export function deployedIsAncestorOfHead() {
  try {
    git("merge-base", "--is-ancestor", DEPLOYED_SOURCE, "HEAD");
    return true;
  } catch { return false; }
}

// 배포 지점 이후의 로컬 커밋. 「배포되지 않았다」는 주장의 근거다.
export function commitsSinceDeploy() {
  return git("log", "--oneline", `${DEPLOYED_SOURCE}..HEAD`).trim().split("\n").filter(Boolean);
}

// 배포 지점 이후로 **위협 표가 실제로 바뀌었나.**
//
// ⚠️ **왜 필요한가**(2026-09-02): 경계 정합성 검사가 「배포 시점 최대 == 지금 최대인데 로컬
//    커밋이 있다」를 모순으로 봤는데, 그 판정에는 **적히지 않은 전제**가 있었다 —
//    「배포 뒤 로컬 커밋은 언제나 위협을 더한다」. 역사적으로는 참이었다(배포 뒤 커밋은 전부
//    새 감사 회차였다). 그런데 **배포 기록 커밋**은 위협을 하나도 안 더한다. 그래서 그 전제가
//    깨지는 순간, 문서화된 배포 절차(배포 → 경계 갱신 커밋)를 **끝낼 수 없게** 됐다.
// ⛔ **검사를 무르게 하지 않는다.** 잡으려던 것(위협을 더했는데 번호가 안 늘었다)은 그대로
//    잡힌다 — 표가 바뀌었는데 최대 번호가 안 늘어난 경우가 정확히 그것이다.
// 위협 표의 행만 뽑는다. **순수 함수** — 합성 입력으로 직접 잴 수 있게 뺐다.
// ⛔ 여기가 비면 어떤 두 문서든 「같다」가 되어 위 판정이 통째로 무력해진다.
export function threatRows(text) {
  return [...String(text).matchAll(/^\|\s*\*\*(\d+)\*\*\s*\|[^\n]*/gm)].map((m) => m[0]).join("\n");
}

export function threatTableChangedSinceDeploy() {
  // ⚠️ **비교 대상은 작업 트리다**(HEAD 가 아니다). test-docs 의 다른 검사가 전부 작업 트리를
  //    읽으므로 기준을 맞춘다 — 커밋하지 않은 위협 추가도 같이 잡힌다.
  const now = readFileSync(new URL("../docs/STAGE3_SIGNUP_SECURITY_DESIGN.md", import.meta.url), "utf8");
  return threatRows(atDeploy()) !== threatRows(now);
}

// **순수 판정.** 위 셋을 받아 「경계 주장이 낡았나」를 답한다.
// ⚠️ 순수 함수로 빼 두는 이유는 합성 입력으로 직접 잴 수 있게 하기 위해서다 — git 에 기대는
//    검사는 변이를 먹여도 「아무것도 실패하지 않음」으로 조용히 통과할 수 있다.
export function boundaryStale(depTh, maxTh, hasCommits, threatsChanged) {
  return hasCommits && threatsChanged && depTh >= maxTh;
}
