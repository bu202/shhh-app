// 설정·바인딩·시크릿 **계약** 검사. `node scripts/test-config.mjs`
//
// 왜 필요한가(2026-08-19 실측): 코드가 요구하는 것과 설정·문서가 말하는 것이 **다섯 군데에서**
// 어긋나 있었다 —
//   ① `worker/cleanup/wrangler.jsonc` 가 없는 파일 `docs/OPS_RUNBOOK.md` 를 가리켰다
//   ② 그 설정에 `<TODO: … 채운다>` 가 **배포 가능한 자리**에 남아 있었다
//   ③ 루트 `wrangler.jsonc` 가 없는 파일 `worker/wrangler.jsonc` 를 가리켰다
//   ④ 필수가 된 시크릿 셋(`SIGNUP_STATE_KEY`·`TOMBSTONE_KEY`·`DELETION_KEY`)이 설정 파일
//      주석에도 `worker/SETUP.md` 에도 README 에도 없었다 — 그 목록만 보고 배포하면 그대로 빠진다
//   ⑤ `LEDGER` 바인딩이 필수가 됐는데 어느 설정에도 없고, 어디에 적어야 하는지도 안 적혀 있었다
//
// 사람이 세는 목록은 반드시 낡는다. 그래서 **개수를 세지 않고 코드에서 읽는다.**
//
// ⚠️ 이것은 런타임 테스트가 아니다. 「배포하면 도는가」가 아니라 「코드가 요구하는 것이
//    설정과 문서에 다 적혀 있는가」만 본다.

import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";

const R = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const has = (f) => existsSync(new URL("../" + f, import.meta.url));
let n = 0;
const t = (m) => { n++; return m; };

// jsonc → json. **줄 전체가 주석인 줄만** 지운다 — 값 뒤에 붙은 `//` 는 건드리지 않는다.
// (건드리면 `"https://…"` 같은 값이 잘린다. 값 뒤 주석이 있으면 아래 JSON.parse 가 던지고,
//  그건 「설정 파일이 이 검사기가 읽을 수 있는 모양이 아니다」라는 정확한 실패다.)
const parse = (f) => JSON.parse(R(f).replace(/^\s*\/\/.*$/gm, ""));

const ROOT = "wrangler.jsonc";
const CLEANUP_TEMPLATE = "worker/cleanup/wrangler.example.jsonc";
const CLEANUP_REAL = "worker/cleanup/wrangler.jsonc";
const RUNBOOK = "docs/OPS_RUNBOOK.md";

// ══ 1. 설정이 가리키는 파일이 실제로 있나 ════════════════════════════════
// 없는 파일을 가리키는 설정은 다음 사람에게 「어딘가 다른 설정이 있다」는 착각을 만든다.
{
  const CONFIGS = [ROOT, CLEANUP_TEMPLATE, ...(has(CLEANUP_REAL) ? [CLEANUP_REAL] : [])];
  const generated = new Set(R(".gitignore").split("\n")
    .map((ln) => ln.trim()).filter((ln) => ln && !ln.startsWith("#")).map((ln) => ln.replace(/\/$/, "")));
  // 주석까지 포함해 **파일처럼 생긴 문자열**을 전부 훑는다.
  const PATHLIKE = /(?:^|[\s`'"(])((?:docs|worker|scripts|migrations|migrations-ledger|policies|js|css)\/[A-Za-z0-9_.\-/]+\.[a-z]+)/g;
  for (const f of CONFIGS) {
    const seen = new Set();
    for (const m of R(f).matchAll(PATHLIKE)) seen.add(m[1]);
    assert.ok(seen.size > 0, t(`${f} 에서 참조 경로를 하나도 못 찾았다 — 검사기가 낡았다`));
    for (const ref of seen) {
      // `.gitignore` 에 있는 것은 **만들어지는 파일**이라 없는 것이 정상이다(정리 Worker 의
      // 실제 설정 · dist). 없는 파일과 만들 파일을 같은 실패로 세면 절차서를 못 쓴다.
      if (generated.has(ref)) continue;
      assert.ok(has(ref), t(`${f} 가 없는 파일 ${ref} 를 가리킨다`));
    }
  }
  // `main` 은 설정 파일 기준 상대경로다.
  assert.ok(has("worker/cleanup/" + parse(CLEANUP_TEMPLATE).main),
    t("정리 Worker 설정의 main 이 없는 파일을 가리킨다"));
  // 루트 설정의 산출물 디렉터리는 빌드가 만드는 그 이름이어야 한다.
  const build = R("scripts/build.mjs");
  assert.equal(parse(ROOT).pages_build_output_dir, "dist",
    t("pages_build_output_dir 이 dist 가 아니다"));
  assert.ok(/["']dist["']|\/dist/.test(build), t("scripts/build.mjs 가 dist 를 만들지 않는다"));
}

// ══ 2. 배포 가능한 설정에 placeholder 가 없나 ════════════════════════════
// 템플릿에는 있어야 하고, 배포되는 파일에는 없어야 한다. 파일로 갈라 둔 이유가 그것이다.
{
  const PLACEHOLDER = /<TODO|TODO:|PLACEHOLDER|<채운다|<여기에|XXXX/i;
  assert.ok(PLACEHOLDER.test(R(CLEANUP_TEMPLATE)),
    t("템플릿에 placeholder 가 없다 — 실제 id 가 커밋된 것 아닌가"));
  assert.ok(!PLACEHOLDER.test(R(ROOT)), t("루트 wrangler.jsonc 에 placeholder 가 있다"));
  if (has(CLEANUP_REAL)) {
    assert.ok(!PLACEHOLDER.test(R(CLEANUP_REAL)),
      t("정리 Worker 의 실제 설정에 placeholder 가 남아 있다 — 배포하면 첫 질의에서 터진다"));
    for (const d of parse(CLEANUP_REAL).d1_databases) {
      assert.match(d.database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        t(`정리 Worker 의 ${d.binding} database_id 가 UUID 모양이 아니다`));
    }
  }
  // 실제 설정은 저장소에 두지 않는다(있어도 되지만 커밋되면 안 된다).
  assert.match(R(".gitignore"), /worker\/cleanup\/wrangler\.jsonc/,
    t(".gitignore 에 정리 Worker 의 실제 설정이 없다 — 실제 id 가 커밋될 수 있다"));
}

// ══ 3. 정리 Worker 설정이 코드가 요구하는 것을 다 갖췄나 ═════════════════
{
  const cfg = parse(CLEANUP_TEMPLATE);
  const src = R("worker/cleanup/index.js");
  // 코드가 실제로 쓰는 바인딩을 **코드에서** 읽는다(`env[binding]` 로 부르므로 JOBS 표에서).
  const used = new Set([...src.matchAll(/"(DB|LEDGER)"/g)].map((m) => m[1]));
  assert.ok(used.has("DB") && used.has("LEDGER"),
    t("정리 Worker 코드에서 바인딩 이름을 못 찾았다 — 검사기가 낡았다"));
  const bound = new Set(cfg.d1_databases.map((d) => d.binding));
  for (const b of used) assert.ok(bound.has(b), t(`정리 Worker 설정에 ${b} 바인딩이 없다`));
  // cron 이 없으면 이 Worker 는 아무 일도 하지 않는다(fetch 핸들러가 없다).
  assert.ok(cfg.triggers && cfg.triggers.crons && cfg.triggers.crons.length,
    t("정리 Worker 설정에 cron 이 없다 — 배포해도 아무것도 안 돈다"));
  // ⛔ 열린 HTTP 주소를 만들지 않는다. 기본값이 true 라 **적어야** 닫힌다.
  assert.equal(cfg.workers_dev, false, t("workers_dev 가 false 가 아니다 — 배포하면 인터넷에 열린다"));
  assert.ok(!cfg.routes && !cfg.route, t("정리 Worker 에 route 가 있다 — HTTP 로 열린다"));
  assert.ok(!/export default[\s\S]{0,400}async fetch/.test(src),
    t("정리 Worker 에 fetch 핸들러가 생겼다 — 상태가 인터넷에 열린다"));
}

// ══ 4. 코드가 요구하는 env 이름이 설정·문서에 다 적혀 있나 ═══════════════
//
// **개수를 세지 않는다.** 코드에서 `env.X` 를 전부 긁어 분류하고, 각각이 어디에 적혀 있어야
// 하는지를 본다. 코드가 새 값을 요구하는데 문서를 안 고치면 여기서 실패한다.
{
  const CODE = ["worker/index.js", "worker/ledger.js", "worker/ops.js", "worker/cleanup/index.js"];
  const names = new Set();
  for (const f of CODE) {
    for (const m of R(f).matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    // `env[binding]` 처럼 간접 참조하는 자리(정리 Worker 의 JOBS)도 이름은 문자열로 있다.
  }
  assert.ok(names.size >= 10, t(`코드에서 env 이름을 ${names.size}개만 찾았다 — 검사기가 낡았다`));

  // 바인딩(설정 파일에 적는다) vs 시크릿·변수(대시보드/CLI 로 넣는다).
  const BINDINGS = new Set(["DB", "LEDGER", "KV", "RL"]);
  // ⚠️ `EDGE_GUARD` 는 **운영자가 선언하는 값**이라 vars 다(2026-08-22 · 위협 55). 값이 없으면
  //    계정 라우트가 닫힌다 — 그것이 지금 상태이고, 그래서 「없어도 된다」가 아니라
  //    「없다는 사실이 문서에 적혀 있어야 한다」다. 아래 6-b 가 값까지 검사한다.
  // ⚠️ `TURNSTILE_SITE_KEY` 는 **공개 값**이다(브라우저에 박히도록 설계된 값). 비밀은
  //    `TURNSTILE_SECRET` 쪽이라 그쪽만 시크릿으로 검사한다.
  const VARS = new Set(["APP_ORIGIN", "APP_URL", "EDGE_GUARD", "TURNSTILE_SITE_KEY"]);
  // **로컬 전용 스위치.** 문서 셋에는 적혀 있어야 하고(있는 줄 모르면 아무도 못 쓴다),
  // **배포 가능한 설정 파일에는 절대 없어야 한다** — 있으면 남용 방어 없이 계정 라우트가
  // 열린 채로 배포된다(위협 50). 그래서 시크릿과 **다르게** 검사한다.
  const LOCAL_ONLY = new Set(["DEV_RATE_LIMIT"]);
  // 제공자 자격증명은 `env[provider.toUpperCase() + "_ID"]` 로 만들어져 정규식에 안 잡힌다.
  // 그건 `worker/index.js` 의 `creds()` 가 원본이므로 여기서 이름을 만들어 함께 검사한다.
  const providers = [...R("worker/index.js").matchAll(/^  (kakao|naver|google): \{$/gm)].map((m) => m[1]);
  assert.equal(providers.length, 3, t("제공자 목록을 못 읽었다 — 검사기가 낡았다"));
  for (const p of providers) { names.add(p.toUpperCase() + "_ID"); names.add(p.toUpperCase() + "_SECRET"); }

  const secrets = [...names].filter((x) => !BINDINGS.has(x) && !VARS.has(x) && !LOCAL_ONLY.has(x)).sort();
  // 문서 넷이 같은 말을 해야 한다. 하나라도 빠지면 그 문서만 보고 배포한 사람이 빠뜨린다.
  const DOCS = ["README.md", "worker/SETUP.md", RUNBOOK, ROOT];
  for (const s of secrets) {
    for (const d of DOCS) {
      assert.ok(R(d).includes(s), t(`${d} 에 ${s} 가 없다 — 코드는 이 값을 요구한다`));
    }
  }
  // 선언 변수도 같다. 이름만 코드에 있고 문서에 없으면 아무도 켤 줄 모른다.
  for (const v of ["EDGE_GUARD", "TURNSTILE_SITE_KEY"]) {
    for (const d of DOCS) assert.ok(R(d).includes(v), t(`${d} 에 ${v} 설명이 없다 — 코드가 이 이름으로 계정 라우트를 연다`));
  }
  // 로컬 전용 스위치: 문서 셋에는 있고, **배포 가능한 설정 둘에는 없다.**
  for (const v of LOCAL_ONLY) {
    for (const d of ["README.md", "worker/SETUP.md", RUNBOOK]) {
      assert.ok(R(d).includes(v), t(`${d} 에 ${v} 설명이 없다 — 코드가 이 이름으로 라우트를 연다`));
    }
    for (const c of [ROOT, CLEANUP_TEMPLATE, ...(has(CLEANUP_REAL) ? [CLEANUP_REAL] : [])]) {
      assert.ok(!new RegExp(`"${v}"\\s*:`).test(R(c)),
        t(`${c} 에 ${v} 가 설정값으로 들어 있다 — 남용 방어 없이 계정 라우트가 열린 채 배포된다`));
    }
  }
  // 바인딩도 같다. `RL` 은 지금 코드에서 「있으면 쓴다」라 필수가 아니다(주석이 그렇게 말한다).
  for (const b of ["DB", "LEDGER"]) {
    assert.ok(R(RUNBOOK).includes(b), t(`${RUNBOOK} 에 ${b} 바인딩이 없다`));
  }
  // 문서에만 있고 코드가 안 쓰는 이름은 반대 방향의 거짓이다(낡은 시크릿을 계속 넣게 된다).
  for (const stale of ["MASTER_CODE", "SESSION_KEY"]) {
    for (const d of DOCS) {
      assert.ok(!new RegExp(`\\b${stale}\\b`).test(R(d)) || /지웠|없앴|옛/.test(R(d)),
        t(`${d} 가 코드에 없는 ${stale} 를 아직 요구한다`));
    }
  }
}

// ══ 5. 필수 바인딩 없이 「배포 준비됨」으로 판정되지 않나 ═════════════════
//
// 루트 설정에 `LEDGER` 가 아직 없다 — 그건 **지금 사실**이고, 그래서 이 저장소는 계정 기능을
// 열 수 있는 상태가 아니다. 둘 중 하나여야 한다:
//   ① 설정에 `LEDGER` 바인딩이 있고 UUID 모양이다(= 붙였다)
//   ② 없고, runbook 이 「배포 전 필수」로 표시해 두었다(= 안 붙였고 그걸 안다)
// 아무 표시 없이 없는 상태가 가장 나쁘다 — 다음 사람이 그대로 배포한다.
{
  const root = parse(ROOT);
  const ledger = (root.d1_databases || []).find((d) => d.binding === "LEDGER");
  if (ledger) {
    assert.match(ledger.database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      t("루트 설정의 LEDGER database_id 가 UUID 모양이 아니다 — 가짜 id 는 첫 질의에서 터진다"));
  } else {
    assert.match(R(RUNBOOK), /<!-- 배포전필수: LEDGER 바인딩 -->/,
      t("LEDGER 바인딩이 없는데 runbook 이 그 사실을 표시하지 않는다"));
    assert.match(R(ROOT), /LEDGER[\s\S]{0,400}OPS_RUNBOOK/,
      t("루트 설정이 LEDGER 가 없다는 사실과 붙이는 곳을 말하지 않는다"));
  }
  // 주 D1 은 이미 있다. id 가 UUID 모양이 아니면 배포는 되고 첫 질의에서 터진다.
  const db = (root.d1_databases || []).find((d) => d.binding === "DB");
  assert.ok(db, t("루트 설정에 DB 바인딩이 없다"));
  assert.match(db.database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    t("루트 설정의 DB database_id 가 UUID 모양이 아니다"));
  // 비밀값은 설정 파일에 적지 않는다(이 파일은 공개 레포에 올라간다).
  assert.ok(!root.vars || !Object.keys(root.vars).some((k) => /KEY|SECRET|TOKEN|PASS/i.test(k)),
    t("wrangler.jsonc 의 vars 에 비밀값처럼 생긴 이름이 있다"));
}

// ══ 5-b. 남용 방어 설정이 코드의 계약과 맞나 ═════════════════════════════
//
// 위협 53: 엣지 바인딩의 한도는 **설정의 `simple.limit`·`period`** 에 고정되고 `limit()` 인자는
// `key` 뿐이다(공식 문서 · wrangler 4.123 스키마). 그래서 바인딩 하나로 버킷 여섯의 서로 다른
// 한도를 낼 수 없다 — 우리 카운터가 그 숫자의 집행자이고, 엣지는 **볼류메트릭 사전 거름**이다.
// 사전 거름이 우리 버킷보다 좁으면 문서에 적힌 숫자가 거짓이 된다.
{
  const root = parse(ROOT);
  const src = R("worker/index.js");
  // `RL_MAX` 를 코드에서 읽는다 — 숫자를 여기 손으로 적으면 그 순간 낡는다.
  const m = /const RL_MAX = \{([^}]*)\}/.exec(src);
  assert.ok(m, t("worker/index.js 에서 RL_MAX 를 못 읽었다 — 검사기가 낡았다"));
  const maxes = [...m[1].matchAll(/:\s*(\d+)/g)].map((x) => +x[1]);
  assert.ok(maxes.length >= 6, t(`RL_MAX 에서 한도를 ${maxes.length}개만 읽었다 — 검사기가 낡았다`));
  const ourMax = Math.max(...maxes);

  const rls = root.ratelimits || [];
  for (const r of rls) {
    assert.equal(r.name, "RL", t(`엣지 리미터 바인딩 이름이 ${r.name} 이다 — 코드는 env.RL 을 본다`));
    assert.ok(r.simple && [10, 60].includes(r.simple.period),
      t("ratelimits 의 period 는 10 또는 60 만 된다(공식 스키마)"));
    // 창이 10초면 분당으로 환산해서 비교한다 — 우리 창은 60초다.
    const perMinute = r.simple.limit * (60 / r.simple.period);
    assert.ok(perMinute >= ourMax,
      t(`엣지 사전 거름(${perMinute}/분)이 우리 버킷 최대(${ourMax}/분)보다 좁다 — 문서의 버킷별 한도가 거짓이 된다`));
  }
  // 선언과 바인딩이 짝이 맞나. `ratelimit` 모드인데 바인딩이 없으면 배포해도 계정 라우트가 닫힌다.
  const guard = (root.vars || {}).EDGE_GUARD;
  if (guard !== undefined) {
    assert.ok(["waf", "ratelimit"].includes(guard),
      t(`EDGE_GUARD 가 "${guard}" 다 — 코드가 아는 모드는 waf·ratelimit 뿐이고 나머지는 none 이다`));
    if (guard === "ratelimit")
      assert.ok(rls.length, t("EDGE_GUARD 가 ratelimit 인데 ratelimits 바인딩이 없다 — 배포해도 계정 라우트가 닫힌다"));
    if (guard === "waf")
      assert.ok(!/\.pages\.dev/.test((root.vars || {}).APP_ORIGIN || ""),
        t("EDGE_GUARD 가 waf 인데 APP_ORIGIN 이 *.pages.dev 다 — 그 존에는 WAF 규칙을 못 건다"));
  } else {
    // 없는 것이 지금 사실이다. 그 사실이 runbook 에 적혀 있어야 다음 사람이 그대로 배포하지 않는다.
    assert.match(R(RUNBOOK), /지금 상태는 D|현 상태 유지|지금 상태.{0,20}D/,
      t("EDGE_GUARD 가 없는데 runbook 이 「지금 닫혀 있다」고 말하지 않는다"));
  }
}

// ══ 6. runbook 이 절차서로서 최소한을 갖췄나 ═════════════════════════════
// 「문서가 있다」와 「따라 할 수 있다」는 다른 말이다. 없으면 배포 날 멈춘다.
{
  const rb = R(RUNBOOK);
  for (const [re, what] of [
    [/wrangler d1 create shhh-ledger/, "ledger D1 생성 명령"],
    [/worker\/ledger-schema\.sql/, "ledger migration 적용"],
    [/migrations\/0005_policy_events_and_signup_states\.sql/, "주 D1 0005 적용"],
    [/pages secret put/, "시크릿 등록 명령"],
    [/pages deploy/, "앱 배포 명령"],
    [/wrangler deploy --config/, "정리 Worker 배포 명령"],
    [/\/api\/ready/, "배포 후 확인"],
    [/cleanup_runs/, "크론이 실제로 도는지 확인"],
    [/중단 기준|롤백/, "중간 실패 시 중단·롤백 기준"],
    [/Time Travel|복원/, "복원 금지 정책"],
    [/Access|deployment delete/, "옛 배포 정리"],
    [/observability/, "모니터링·로그"],
    [/원자|같은 배포/, "개인정보 문서와 코드의 공개 순서"],
    [/재승인/, "네이버·카카오 재승인 시점"],
    [/No-Go/, "출시 판정"],
  ]) assert.match(rb, re, t(`${RUNBOOK} 에 ${what} 가 없다`));
  // 값을 문서에 적지 않는다. 예시 키가 들어오면 그대로 쓰인다.
  assert.ok(!/[A-Za-z0-9+/]{40,}={0,2}/.test(rb.replace(/`[^`]*shhh-[^`]*`/g, "")),
    t(`${RUNBOOK} 에 비밀값처럼 생긴 긴 문자열이 있다`));
}

console.log(`test-config: ${n}개 통과 — 설정이 가리키는 파일 실재 · 배포 설정에 placeholder 0건 · `
  + `정리 Worker 바인딩·cron·비공개 · 코드의 env 이름이 설정과 문서 4곳에 전부 등재 · `
  + `필수 바인딩 없이 배포 준비됨으로 안 읽힘 · runbook 필수 절차 15종`);
