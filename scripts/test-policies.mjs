// 정책 문서 무결성. `node scripts/test-policies.mjs`
//
// 재는 것은 하나다: **파일 내용 · manifest · 서버 상수 세 값이 언제나 같은가.**
// 하나라도 어긋나면 화면이 보여준 문서와 DB 에 기록되는 해시가 달라지고, 그 순간
// 「사용자가 무엇을 보고 동의했는가」의 기록이 거짓이 된다.
//
// ⚠️ **이 검사가 증명하지 못하는 것**: 과거 항목을 파일과 manifest 에서 **함께** 지우는
//    의도적 삭제는 잡지 못한다 — 둘 다 사라지면 남은 것끼리는 여전히 일관적이다.
//    그것을 잡는 것은 테스트가 아니라 Git 이력과 코드 리뷰이고, 저장소 이력을 통제하는
//    사람에게는 그것도 방어가 아니다. **「불변」은 자동으로 강제되는 성질이 아니라 운영 규칙이다.**
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, bundleId, currentAssets, KINDS, DIR } from "./policies.mjs";
import { POLICY_BUNDLE } from "../worker/policies.js";
import { requiredPolicyKinds, REQUIRED_POLICY_EVENTS } from "../worker/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (rel) => readFile(path.join(ROOT, rel));
const sha = (b) => createHash("sha256").update(b).digest("hex");
let n = 0;
const t = (msg) => { n++; return msg; };

const m = await readManifest();

// 1. manifest 의 **모든 판**이 실제 파일이고 해시가 맞는가.
for (const v of m.versions) {
  const body = await R(`policies/${v.file}`);
  assert.equal(sha(body), v.hash, t(`policies/${v.file} 의 내용이 manifest 해시와 다르다 — 불변 파일이 고쳐졌다`));
  // 파일 이름 자체가 내용의 앞 12자다. 이름만 보고도 어긋남을 알 수 있게.
  assert.ok(v.file.startsWith(`${v.kind}-${v.hash.slice(0, 12)}.`),
    t(`${v.file} 의 이름이 내용 해시와 다르다`));
}

// 2. 현재 번들이 manifest 의 판 목록 안에 있는가. (밖에 있으면 어디서 온 값인지 알 수 없다)
for (const k of Object.keys(m.bundle.docs)) {
  const d = m.bundle.docs[k];
  assert.ok(m.versions.some((v) => v.file === d.path.replace(/^policies\//, "") && v.hash === d.hash),
    t(`현재 번들의 ${k} 가 manifest 판 목록에 없다`));
}

// 3. **pv 가 실제 해시들에서 계산되는가.** 손으로 적어 둔 값이면 여기서 걸린다.
assert.equal(m.bundle.pv, bundleId(m.bundle.docs), t("manifest 의 pv 가 문서 해시들과 맞지 않는다"));

// 4. ★ **T22 — 서버 상수 == manifest == 파일 해시.** 셋이 갈리면 화면이 보여준 문서와
//    기록되는 해시가 달라진다. 세 값을 각각 독립적으로 계산해 비교한다.
assert.equal(POLICY_BUNDLE.pv, m.bundle.pv, t("T22: 서버 상수의 pv 가 manifest 와 다르다"));
assert.deepEqual(POLICY_BUNDLE.docs, m.bundle.docs, t("T22: 서버 상수의 문서 목록이 manifest 와 다르다"));
for (const k of Object.keys(POLICY_BUNDLE.docs)) {
  const d = POLICY_BUNDLE.docs[k];
  assert.equal(sha(await R(d.path)), d.hash,
    t(`T22: 서버 상수의 ${k} 해시가 실제 파일 내용과 다르다 — 파일만 고치고 stamp 를 안 돌렸다`));
}

// 5. 서버가 기록하는 **모든 kind 가 번들에 있는가.** 없으면 그 자리에 undefined 가 들어간다.
for (const [kind] of requiredPolicyKinds)
  assert.ok(POLICY_BUNDLE.docs[kind], t(`서버가 기록하는 kind '${kind}' 가 번들에 없다`));
assert.equal(REQUIRED_POLICY_EVENTS, requiredPolicyKinds.length,
  t("REQUIRED_POLICY_EVENTS 가 집합 크기와 다르다 — 숫자를 따로 적어 뒀다"));
// **동의를 받지 않기로 한 것을 받은 척하지 않는다.** 처리 근거가 계약의 이행이므로
// `privacy` 는 `presented` 여야 하고, `xborder/accepted` 는 존재하면 안 된다.
const kinds = Object.fromEntries(requiredPolicyKinds);
assert.equal(kinds.privacy, "presented",
  t("privacy 의 action 이 presented 가 아니다 — 받지 않은 동의를 받았다고 기록하게 된다"));
assert.ok(!("xborder" in kinds), t("xborder 항목이 살아났다 — 국외 이전 별도 동의를 받지 않기로 했다"));

// 6. `privacy.html` 은 **가장 최근 불변 사본과 내용이 같아야 한다.**
//    두 벌을 두는 대가가 이것이다 — 어긋나면 사람이 읽는 문서와 기록되는 문서가 갈린다.
assert.equal(sha(await R("privacy.html")), POLICY_BUNDLE.docs.privacy.hash,
  t("privacy.html 이 현재 불변 사본과 다르다 — `node scripts/policies.mjs` 를 돌려라"));

// 7. 원본(`policies-src/`)도 각각 현재 사본과 같은가. 원본만 고치고 stamp 를 안 돌린 상태를 잡는다.
for (const kind of Object.keys(KINDS)) {
  assert.equal(sha(await R(KINDS[kind].src)), POLICY_BUNDLE.docs[kind].hash,
    t(`${KINDS[kind].src} 가 현재 번들과 다르다 — stamp 를 안 돌렸다`));
}

// 8. `policies/` 안에 **허용된 확장자만** 있는가. 이 폴더는 빌드가 통째로 내보내는 유일한
//    폴더라, 여기 `.md` 나 `.sql` 이 놓이면 그 순간 공개된다.
for (const f of readdirSync(DIR))
  assert.ok(/\.(html|txt|json)$/.test(f), t(`policies/ 에 허용되지 않은 파일이 있다: ${f}`));

// 9. 서비스워커 선캐시 목록이 **정확히 지금 번들**인가. 지난 판까지 넣으면 캐시가 계속 자라고,
//    더 나쁘게는 옛 문서를 렌더하면서 서버는 새 해시를 기록하는 상태가 된다.
{
  const sw = await readFile(path.join(ROOT, "service-worker.js"), "utf8");
  const listed = [...sw.matchAll(/^\s*"(policies\/[^"]+)",\s*$/gm)].map((x) => x[1]).sort();
  assert.deepEqual(listed, currentAssets(m).sort(),
    t("서비스워커의 정책 선캐시 목록이 지금 번들과 다르다"));
}

// 10. 판이 늘어날 때 **기존 항목이 안 바뀌는가**(추가만 허용). 지금 저장소 안에서 잴 수 있는
//     것은 「같은 kind 의 파일이 여럿이어도 각자 자기 해시를 지킨다」까지다 — 위 1번이 그것이다.
//     여기서는 **같은 파일 이름이 두 번 등록되지 않았는지**만 더 본다.
{
  const files = m.versions.map((v) => v.file);
  assert.equal(new Set(files).size, files.length, t("manifest 에 같은 파일이 두 번 등록됐다"));
}

console.log(`test-policies: 통과 — 단언 ${n}개 · 판 ${m.versions.length}개 · pv ${m.bundle.pv} · `
  + `필수 이벤트 ${REQUIRED_POLICY_EVENTS}종(${requiredPolicyKinds.map(([k, a]) => k + "/" + a).join(" ")})`);
