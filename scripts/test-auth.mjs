// 로그인 동기화 규칙(syncPlan)을 화면 없이 잰다.
// 이 규칙이 틀리면 증상이 "단어장이 조용히 사라졌다"라서 사람이 눈으로는 못 잡는다.
//
// ⚠️ 2026-08-12: **기기 시계를 판정에서 뺐다.** 예전 이 파일은 `remote.updated > localAt` 을
//    정상으로 단언하고 있었다 — 즉 방어 장치가 아니라 **취약한 요구사항의 잠금장치**였다.
//    시계가 미래인 기기는 언제나 자기가 새것이라 여겨 다른 기기 단어를 지웠고, 서버가 버전을
//    세고 있었는데도 막히지 않았다(앱이 판정 직전에 최신 버전을 받아 그대로 되보냈다).
//    지금 판정에 쓰는 것은 dirty(이 기기에서 고쳤나)와 base(그때 들고 있던 서버 버전)뿐이다.
import { readFileSync } from "node:fs";
import assert from "node:assert";

// auth.js 의 화면 부분은 `typeof document !== "undefined"` 안에 있어 Node 에선 안 돈다.
const src = readFileSync(new URL("../js/auth.js", import.meta.url), "utf8");
const { syncPlan } = new Function(`${src}\n; return { syncPlan };`)();

// 서버 레코드. **updated 를 일부러 터무니없는 값으로 둔다** — 규칙이 시계를 다시 보기 시작하면
// 아래 단언들이 실제로 깨지도록.
const R = (words, version, name = "") => ({ words, version, name, updated: 9e15 });
const P = (o) => syncPlan(R(o.rw || [], o.rv ?? 0, o.rn), o.lw || [], {
  dirty: o.dirty, base: o.base, firstLogin: o.first, localName: o.ln, accountChanged: o.swap,
});

// 1. 오프라인(서버 응답 없음) — 로컬을 절대 건드리지 않는다.
assert.equal(syncPlan(null, ["사랑"], { dirty: true }).action, "none");
assert.equal(syncPlan(null, [], { firstLogin: true }).action, "none");

// 2. 로그인 첫 순간 — 합집합. 로그인 전에 담아둔 것도, 다른 기기 것도 남는다.
const first = P({ rw: ["사랑", "고맙다"], rv: 3, lw: ["사랑", "잘 자다"], first: true });
assert.equal(first.action, "merge");
assert.deepEqual(first.words, ["사랑", "고맙다", "잘 자다"]);
assert.equal(new Set(first.words).size, first.words.length, "합집합에 중복이 생기면 안 된다");

// 3. 이 기기에서 고친 적이 없다 → 서버가 진실. 시계도 버전도 볼 이유가 없다.
assert.deepEqual(P({ rw: ["가"], rv: 7, lw: ["나", "다"], dirty: false, base: 2 }),
                 { action: "pull", words: ["가"], name: "" });

// 4. 고쳤고 그 사이 서버는 그대로 → 내 것을 올린다. **삭제도 이 길로 전파된다** —
//    여기서 합집합을 쓰면 다른 기기에서 뺀 단어가 되살아난다.
assert.deepEqual(P({ rw: ["가", "나"], rv: 5, lw: ["가"], dirty: true, base: 5 }),
                 { action: "push", words: ["가"], name: "" });

// 5. 고쳤는데 서버도 움직였다 → **둘 다 고친 것**이다. 어느 쪽도 버리지 않는다.
const clash = P({ rw: ["가", "나"], rv: 9, lw: ["가", "라"], dirty: true, base: 5 });
assert.equal(clash.action, "merge", "양쪽이 다 고쳤는데 한쪽을 버렸다");
assert.deepEqual(clash.words, ["가", "나", "라"]);

// 6. 서버에 아무것도 없던 첫 기기(version 0, base 0) → 로컬을 올린다.
assert.equal(P({ rw: [], rv: 0, lw: ["사랑"], dirty: true, base: 0 }).action, "push");

// 7. **기기 시계가 미래여도 아무것도 안 바뀐다.** 이 파일이 생긴 이유의 절반이다.
//    (localAt 자리가 아예 없으므로, 규칙이 시계를 다시 보려면 인자부터 늘어야 한다)
const future = P({ rw: ["서버가 새로 담은 말"], rv: 9, lw: ["옛 단어"], dirty: false, base: 1 });
assert.equal(future.action, "pull", "시계와 무관하게 clean 이면 받아와야 한다");
assert.deepEqual(future.words, ["서버가 새로 담은 말"], "옛 로컬이 서버를 덮었다");

// 8. dirty 를 안 넘기면 **고친 것으로 본다.** 이 표시가 생기기 전에 담아둔 단어장이 있는
//    기기에서 clean 으로 오판하면 그 단어장이 통째로 덮인다 — 기본값이 안전한 쪽이어야 한다.
assert.equal(syncPlan(R(["서버"], 3), ["내 것"], { base: 3 }).action, "push",
  "dirty 기본값이 false 로 떨어졌다");

// ── 별명 ── 단어장과 같은 레코드라 같은 판정을 따라야 한다.
// 따로 판정하면 "단어는 새것인데 별명은 옛것"인 반쪽 상태가 생긴다.

// 9. 서버 것을 받을 때는 별명도 서버 것.
assert.deepEqual(P({ rw: ["가"], rv: 4, rn: "달", lw: ["나"], dirty: false, base: 1, ln: "별" }),
                 { action: "pull", words: ["가"], name: "달" });
// 10. 내 것을 올릴 때는 방금 지은 별명 — 안 그러면 별명이 저장 직후 되돌아간다.
assert.deepEqual(P({ rw: ["가"], rv: 4, rn: "달", lw: ["가"], dirty: true, base: 4, ln: "별" }),
                 { action: "push", words: ["가"], name: "별" });
// 11. 첫 로그인: 이 기기에서 지은 별명이 있으면 그걸, 없으면 계정에 있던 것(폰을 바꾼 경우).
assert.equal(P({ rn: "달", first: true, ln: "별" }).name, "별");
assert.equal(P({ rn: "달", first: true, ln: "" }).name, "달");
// 12. 양쪽 다 없으면 빈 문자열. undefined 가 새면 화면에 "undefined님"이 뜬다.
assert.equal(P({ first: true, ln: "" }).name, "");
assert.equal(P({ rv: 9, dirty: false, base: 0, ln: "" }).name, "");

// ── 계정 교체 ──
// 13. 계정이 바뀌면 이 기기의 단어장을 **새 계정에 물려주지 않는다.**
//     한 기기로 계정을 갈아 로그인하면 앞 계정 단어가 뒷 계정 서버로 올라가던 자리다.
const swapped = P({ rw: ["가"], rv: 2, lw: ["앞계정단어"], first: true, swap: true });
assert.equal(swapped.action, "pull", "계정을 바꿔 로그인했는데 로컬 단어장이 새 계정으로 갔다");
assert.deepEqual(swapped.words, ["가"], "새 계정 단어장이 아니라 앞 계정 것이 남았다");
// 14. 이 기기에서 고쳤어도, 버전이 맞아떨어져도 마찬가지다 — 계정 교체가 가장 먼저다.
assert.equal(P({ rw: [], rv: 5, lw: ["앞계정단어"], dirty: true, base: 5, swap: true }).action, "pull",
  "계정이 바뀌었는데 로컬이 새것이라고 push 했다");
// 15. 계정이 그대로면 종전 규칙이 그대로 돈다(이 변경이 평소 동작을 바꾸면 안 된다).
assert.equal(P({ rw: ["가"], rv: 1, lw: ["나"], first: true, swap: false }).action, "merge");
assert.equal(P({ rw: ["가"], rv: 1, lw: ["나"], dirty: true, base: 1, swap: false }).action, "push");

// 16. **판정 근거를 읽기가 갈아치우지 않는다.** apiGetBook 이 응답을 받자마자 버전과 내 계정
//     id 를 저장하면, syncPlan 이 보기도 전에 base 와 "앞서 맞춰 둔 계정"이 최신으로 바뀐다.
//     그게 정확히 옛 단어장이 서버를 덮던 경로였다. 규칙을 코드에 못 박는다.
const api = readFileSync(new URL("../js/authApi.js", import.meta.url), "utf8");
const getBookBody = api.slice(api.indexOf("const apiGetBook"), api.indexOf("const apiPutBook"));
assert.ok(!/setBookVersion|setAuthUid/.test(getBookBody),
  "apiGetBook 이 판정 전에 버전·계정 id 를 저장한다 — 시계 독립 동기화가 무효가 된다");

// 17. 로그아웃이 **계정에 딸린 로컬 값**을 같이 지운다. 안 지우면 한 기기를 두 사람이 쓸 때
//     앞사람의 초대 링크와 별명이 뒷사람에게 남는다.
for (const k of ["shh-invite", "shh-name", "shh-bookver", "shh-dirty", "shh-me", "shh-via"])
  assert.ok(new RegExp(`ACCOUNT_KEYS[\\s\\S]{0,400}${k}`).test(api) || api.includes(`"${k}"`),
    `로그아웃이 ${k} 를 안 지운다`);
// 단어장과 계정 판정 근거는 **남겨야 한다** — 로그아웃은 "그만 보기"지 "지우기"가 아니고,
// shh-uid 가 없으면 다음에 다른 계정이 로그인한 것을 알아챌 수 없다.
const accountKeys = api.slice(api.indexOf("const ACCOUNT_KEYS"), api.indexOf("const setAuth"));
assert.ok(!accountKeys.includes("shh-wordbook"), "로그아웃이 이 기기의 단어장을 지운다");
assert.ok(!accountKeys.includes("shh-uid"), "로그아웃이 계정 교체 판정 근거를 지운다");

console.log("test-auth: 24개 통과 — 시계 무관 동기화 · 계정 교체 · 로그아웃 정리");
