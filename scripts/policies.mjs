// 정책 문서 번들 — 불변 파일과 manifest 를 만들고 읽는다.
//
// 왜 두 벌인가: 사용자가 **실제로 본 바이트**를 나중에 재현할 수 있어야 하기 때문이다.
// `privacy.html` 과 `policies-src/*` 는 고쳐 나가는 살아 있는 파일이고,
// `policies/<kind>-<hash12>.<ext>` 는 **한 번 쓰면 안 고치는** 사본이다.
// 기록에 남는 `document_version` 은 언제나 불변 사본의 해시다.
//
// ⚠️ **불변은 자동으로 강제되는 성질이 아니라 운영 규칙이다.** 이 스크립트는 기존 파일을
//    덮어쓰지 않지만, 사람이 파일과 manifest 항목을 **함께** 지우면 남은 것끼리는 여전히
//    일관적이라 테스트가 못 잡는다. 그것을 막는 것은 Git 이력과 코드 리뷰다.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
// 배포 경계의 원본은 해시 하나다 — 보관함의 「나갔던 판 / 아직 안 나간 판」이 여기서 갈린다.
import { DEPLOYED_SOURCE } from "./deployed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIR = path.join(ROOT, "policies");
export const MANIFEST = path.join(DIR, "manifest.json");

// 종류마다 「살아 있는 원본」이 어디인가. privacy 만 앱이 직접 서빙하는 파일(privacy.html)이
// 원본이다 — 방침은 사람이 읽으러 오는 주소가 따로 있어야 해서 두 벌이 된다(설계서 §7-3).
export const KINDS = {
  terms:   { src: "policies-src/terms.html", ext: "html" },
  privacy: { src: "privacy.html",            ext: "html" },
  age14:   { src: "policies-src/age14.txt",  ext: "txt"  },
  summary: { src: "policies-src/summary.txt", ext: "txt" },
};

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

// 번들 id. **정렬된 `kind:hash` 줄들의 SHA-256 앞 12자.** 정렬하는 이유는 manifest 의
// 키 순서가 바뀌어도 같은 번들이면 같은 값이 나와야 하기 때문이다.
export const bundleId = (current) =>
  sha256hex(Object.keys(current).sort().map((k) => `${k}:${current[k].hash}`).join("\n")).slice(0, 12);

export async function readManifest() {
  return JSON.parse(await readFile(MANIFEST, "utf8"));
}

// 서버가 들고 다닐 상수. Pages Functions 번들에는 정적 파일이 안 들어가므로
// **JS 모듈로 구워서** worker 가 import 한다.
const WORKER_FILE = path.join(ROOT, "worker/policies.js");
const workerModule = (m) => `// 자동 생성 — \`node scripts/policies.mjs stamp\` 가 쓴다. 손으로 고치지 않는다.
// 원본은 policies/manifest.json 이고, scripts/test-policies.mjs 가 셋(파일·manifest·이 파일)을 대조한다.
export const POLICY_BUNDLE = ${JSON.stringify(m.bundle, null, 2)};
`;

// 가입 화면이 아니라 **사람이 주소로 찾아올 때** 보여줄 목록. 번들이 바뀌면 다시 쓴다.
export const indexHtml = (m, shipped) => {
  // ⚠️ **현재 판을 「지난 판」에 다시 적지 않는다**(2026-08-27 · K4). 옛 보관함은 `versions`
  //    전체를 그대로 뿌려서, 지금 나가는 사본 넷이 「지난 판」에도 함께 있었다 — 보관함의
  //    쓸모가 「그때 그 사람이 본 문서가 이것이다」인데 그 구분이 없으면 지목이 안 된다.
  // ⚠️ **「지난 판」과 「아직 나간 적 없는 판」도 다르다.** 로컬에서 stamp 만 하고 배포되지
  //    않은 사본은 **아무도 본 적이 없다** — 그걸 「지난 판」이라 부르면 거짓이다.
  //    경계의 원본은 `scripts/deployed.mjs` 의 source 해시 하나다.
  // ⛔ **경계 해시를 이 페이지에 찍지 않는다**(2026-09-02). 찍었더니 배포할 때마다 경계가
  //    바뀌고 → 이 페이지가 바뀌고 → 선캐시 해시에서 파생되는 BUILD_ID 가 바뀌어서,
  //    「경계를 갱신하면 또 배포해야 하는」 고리가 됐다. **끝나지 않는다** — 경계는 배포한
  //    뒤에야 정해지므로 자기 경계를 적은 페이지는 언제나 한 세대 뒤처진 값을 말한다.
  //    분류(어느 사본이 나갔나)는 그대로 경계에서 파생한다 — 지운 것은 **표시**뿐이다.
  const current = new Set(Object.values(m.bundle.docs).map((d) => d.path.replace(/^policies\//, "")));
  const rest = m.versions.filter((v) => !current.has(v.file));
  const past = shipped ? rest.filter((v) => shipped.has(v.file)) : rest;
  const draft = shipped ? rest.filter((v) => !shipped.has(v.file)) : null;
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>약관·방침 보관함 — shhh!</title>
  <link rel="icon" href="../icons/icon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="../css/style.css" />
  <style>
    .doc { max-width: 44rem; margin: 0 auto; padding: 24px 18px 60px; line-height: 1.7; }
    .doc h1 { font-size: 24px; } .doc h2 { font-size: 16px; margin: 24px 0 6px; }
    .doc p, .doc li { color: var(--sub); } .doc a { color: var(--coral-d); }
    .doc code { font-size: 12px; word-break: break-all; }
  </style>
</head>
<body>
  <main class="doc">
    <h1>약관·방침 보관함</h1>
    <p>가입 화면에서 보여드린 문서를 <b>그때 그 내용 그대로</b> 보관합니다.
       파일 이름 뒤의 값과 아래 판별 값이 문서 내용에서 계산되므로, 한 글자만 달라도 값이 달라집니다.</p>
    <p>지금 쓰이는 묶음의 판별 값(pv): <code>${m.bundle.pv}</code></p>
    <h2>지금 쓰이는 문서</h2>
    <ul>
${Object.keys(m.bundle.docs).sort().map((k) =>
  `      <li><b>${k}</b> — <a href="${m.bundle.docs[k].path.replace(/^policies\//, "")}">${m.bundle.docs[k].path.replace(/^policies\//, "")}</a><br><code>${m.bundle.docs[k].hash}</code></li>`).join("\n")}
    </ul>
    <h2>지난 판 — 실제로 나갔던 문서</h2>
    <p>이 페이지를 내보낸 배포 시점까지 저장소에 있던 사본만 여기에 둡니다.</p>
    <ul>
${past.length ? past.map((v) => `      <li>${v.kind} — <a href="${v.file}">${v.file}</a></li>`).join("\n")
              : "      <li>아직 없습니다.</li>"}
    </ul>
    <h2>아직 나간 적 없는 판</h2>
    <p>만들어 두었지만 <b>배포된 적이 없는</b> 사본입니다. 이 문서를 보신 분은 아무도 없습니다.
       지우지 않고 남기는 이유는 판별 값(pv)의 계산 근거가 되기 때문입니다.</p>
    <ul>
${draft === null
  ? "      <li>배포 경계를 확인할 수 없어 분류하지 못했습니다.</li>"
  : (draft.length ? draft.map((v) => `      <li>${v.kind} — <a href="${v.file}">${v.file}</a></li>`).join("\n")
                  : "      <li>없습니다.</li>")}
    </ul>
    <p style="margin-top:32px"><a href="../">← shhh!로 돌아가기</a> · <a href="../privacy.html">개인정보처리방침</a></p>
  </main>
</body>
</html>
`;
};

// 배포 경계 시점에 `policies/` 에 있던 파일 이름들. **git 이 원본이다** — manifest 에 적어 두면
// 파생값이 낡는다. 확인할 수 없으면 `null` 을 돌려주고, 보관함이 그 사실을 그대로 적는다.
export function shippedPolicyFiles() {
  try {
    // ⚠️ **저장소 위치를 환경에서 받을 수 있다** — 돌연변이 실행기는 추적 파일만 임시 폴더로
    //    복사하고 `.git` 은 가져가지 않는다(`scripts/deployed.mjs` 와 같은 이유).
    return new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", DEPLOYED_SOURCE, "policies/"],
      { encoding: "utf8", cwd: process.env.SHHH_GIT_ROOT || ROOT }).split("\n").filter(Boolean)
      .map((f) => f.replace(/^policies\//, "")));
  } catch { return null; }
}

// 살아 있는 원본을 읽어 새 불변 사본이 필요하면 만든다. **이미 있는 파일은 절대 덮어쓰지 않는다.**
export async function stamp() {
  await mkdir(DIR, { recursive: true });
  const m = existsSync(MANIFEST) ? await readManifest() : { versions: [], bundle: { pv: "", docs: {} } };
  const docs = {};
  const added = [];
  for (const kind of Object.keys(KINDS).sort()) {
    const { src, ext } = KINDS[kind];
    const body = await readFile(path.join(ROOT, src));
    const hash = sha256hex(body);
    const file = `${kind}-${hash.slice(0, 12)}.${ext}`;
    if (!m.versions.some((v) => v.file === file)) {
      m.versions.push({ kind, file, hash, added: new Date().toISOString().slice(0, 10) });
      added.push(file);
    }
    if (!existsSync(path.join(DIR, file))) await writeFile(path.join(DIR, file), body);
    docs[kind] = { path: `policies/${file}`, hash };
  }
  m.versions.sort((a, b) => (a.kind + a.file).localeCompare(b.kind + b.file));
  m.bundle = { pv: bundleId(docs), docs };
  await writeFile(MANIFEST, JSON.stringify(m, null, 2) + "\n");
  await writeFile(WORKER_FILE, workerModule(m));
  await writeFile(path.join(DIR, "index.html"), indexHtml(m, shippedPolicyFiles()));
  await stampServiceWorker(m);
  return { manifest: m, added };
}

// 서비스워커 선캐시 목록. **지금 번들만** 넣는다 — 지난 판까지 선캐시하면 캐시가 계속 자란다.
const SW = path.join(ROOT, "service-worker.js");
const BEGIN = "  // policies:begin", END = "  // policies:end";
export const currentAssets = (m) =>
  ["policies/manifest.json", "policies/index.html",
   ...Object.keys(m.bundle.docs).sort().map((k) => m.bundle.docs[k].path)];

export async function stampServiceWorker(m) {
  const src = await readFile(SW, "utf8");
  const i = src.indexOf(BEGIN), j = src.indexOf(END);
  if (i < 0 || j < 0) throw new Error("service-worker.js 에 policies:begin/end 표시가 없다");
  const body = currentAssets(m).map((a) => `  "${a}",`).join("\n");
  await writeFile(SW, src.slice(0, i) + BEGIN + " — scripts/policies.mjs 가 다시 쓴다\n" + body + "\n" + src.slice(j));
}

export const listPolicyFiles = () => readdir(DIR);

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { manifest, added } = await stamp();
  console.log(`policies: pv=${manifest.bundle.pv} · 판 ${manifest.versions.length}개`
    + (added.length ? ` · 새 파일 ${added.join(", ")}` : " · 새 파일 없음"));
}
