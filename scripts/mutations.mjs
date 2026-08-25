// **돌연변이 목록 — 이 파일이 원본이다.** `scripts/mutate.mjs` 가 이것을 읽어 실행한다.
//
// 왜 파일로 두나: 2026-08-22 오전 보고서는 「34종 중 33종 사망」이라고 적었는데 **저장소에는
// 목록도 실행 명령도 로그도 없었다.** 그러면 다음 사람은 그 숫자를 확인할 수도, 다시 돌릴 수도
// 없다 — 검증이 아니라 주장이다. 숫자를 맞추는 대신 **다시 돌릴 수 있는 목록**을 둔다.
//
// 각 항목이 답해야 하는 것:
//   id         고유 번호
//   file       대상 파일
//   what       무엇을 바꾸나 (사람이 읽는 한 줄)
//   invariant  이 변이가 깨뜨리는 **보안 불변식**
//   suite      죽여야 하는 스위트 (여기서 안 죽으면 그 스위트에 공백이 있다는 뜻)
//   kind       "동작" = 실제 실행 경로를 재는 검사 · "정적" = 문서·설정 일관성 검사
//              ⚠️ **둘을 한 숫자로 합치지 않는다.** 정적 검사가 아무리 촘촘해도 런타임 방어를
//                 증명하지 못하고, 반대도 마찬가지다 — 보고할 때 갈라서 적는다.
//   find/replace 또는 transform  실제 변경
//
// ⚠️ **목표 숫자를 정해 두고 맞추지 않는다.** 살아남은 변이는 숨기지 않고 분류한다 —
//    ① 실제 테스트 공백 ② 동치 변이 ③ 도달 불가능 코드.

export const MUTATIONS = [
  // ── 비밀값 비교 ────────────────────────────────────────────────────────
  {
    id: "M01", file: "worker/index.js", suite: "test-friends",
    what: "timingSafeEqual() 을 JS XOR 반복문으로 되돌린다",
    invariant: "비밀값 비교는 런타임의 timing-safe API 를 쓴다(직접 구현한 비교는 시간 성질을 우리가 보장 못 한다)",
    find: "  return crypto.subtle.timingSafeEqual(x, y);",
    replace: "  const u = new Uint8Array(x), v = new Uint8Array(y);\n"
           + "  let d = 0;\n  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];\n  return d === 0;",
  },
  {
    id: "M02", file: "worker/index.js", suite: "test-workerd",
    what: "요약을 만들지 않고 원문을 그대로 비교한다",
    invariant: "고정 길이 요약을 비교한다 — 원문을 넣으면 길이가 다를 때 예외가 되어 길이가 새어 나간다",
    find: "  const [x, y] = await Promise.all([\n"
        + "    crypto.subtle.digest(\"SHA-256\", ENC.encode(a)),\n"
        + "    crypto.subtle.digest(\"SHA-256\", ENC.encode(b)),\n"
        + "  ]);\n  return crypto.subtle.timingSafeEqual(x, y);",
    replace: "  return crypto.subtle.timingSafeEqual(ENC.encode(a), ENC.encode(b));",
  },
  {
    id: "M03", file: "worker/index.js", suite: "test-friends",
    what: "비교 결과를 항상 true 로 만든다",
    invariant: "틀린 비밀값은 통과하지 않는다",
    find: "  return crypto.subtle.timingSafeEqual(x, y);",
    replace: "  return true;",
  },
  {
    id: "M04", file: "worker/index.js", suite: "test-friends",
    what: "/ready 의 운영자 키 비교에서 await 를 뺀다",
    invariant: "비동기 비교의 호출부는 전부 await 한다 (Promise 는 늘 truthy 라 검사가 무력해진다)",
    find: "      if (!(await sameSecret(env.READY_KEY || \"\", req.headers.get(\"X-Ready-Key\") || \"\")))",
    replace: "      if (!sameSecret(env.READY_KEY || \"\", req.headers.get(\"X-Ready-Key\") || \"\"))",
  },

  // ── 제공자별 설정 ──────────────────────────────────────────────────────
  {
    id: "M05", file: "worker/index.js", suite: "test-signup",
    what: "제공자 secret 검사를 없애고 ID 만 본다",
    invariant: "네이버·구글은 ID 와 secret 쌍이 있어야 왕복을 시작한다 (카카오만 secret 선택)",
    find: "  return !!id && (!!secret || !!P[name].optionalSecret);",
    replace: "  return !!id;",
  },
  {
    id: "M06", file: "worker/index.js", suite: "test-signup",
    what: "콜백의 제공자 설정 검사를 외부 호출 뒤로 옮긴다",
    invariant: "되돌릴 수 없는 외부 호출(code 교환) 앞에서 설정 미비를 끝낸다",
    transform: (src) => {
      const block = "        if (!providerPossible(env, name))\n"
        + "          return viaApp ? fail(\"로그인이 아직 준비되지 않았어요\", 503)\n"
        + "                        : fail(null, 302, st.back + \"#login=fail\");\n";
      if (!src.includes(block)) return null;
      const after = "        const who = await verifyProvider(env, url.origin, name, code, raw);\n";
      if (!src.includes(after)) return null;
      return src.replace(block, "").replace(after, after + block);
    },
  },
  {
    id: "M07", file: "worker/index.js", suite: "test-signup",
    what: "signupPossible 에서 공통 키 하나(SESSION_ENVELOPE_KEY)를 뺀다",
    invariant: "시크릿이 하나라도 없으면 가입을 시작하지 않는다 (부분 구성에서 쓸 수 없는 계정이 생긴다)",
    find: "  && env.STATE_KEY && env.RL_KEY && env.SESSION_ENVELOPE_KEY);",
    replace: "  && env.STATE_KEY && env.RL_KEY);",
  },

  // ── 사람 확인(Turnstile) ───────────────────────────────────────────────
  {
    id: "M08", file: "worker/index.js", suite: "test-signup",
    what: "Turnstile 응답의 action 검사를 뺀다",
    invariant: "다른 자리에 붙인 위젯의 토큰을 가입에 재사용할 수 없다",
    find: "  return r.action === TURNSTILE_ACTION && r.hostname === want;",
    replace: "  return r.hostname === want;",
  },
  {
    id: "M09", file: "worker/index.js", suite: "test-signup",
    what: "Turnstile 응답의 hostname 검사를 뺀다",
    invariant: "다른 도메인·다른 별칭에서 푼 토큰을 받지 않는다",
    find: "  return r.action === TURNSTILE_ACTION && r.hostname === want;",
    replace: "  return r.action === TURNSTILE_ACTION;",
  },
  {
    id: "M10", file: "worker/index.js", suite: "test-signup",
    what: "Turnstile 성공 여부 검사를 뺀다",
    invariant: "검증 서버가 거절하거나 답하지 않으면 가입이 진행되지 않는다",
    find: "  if (r === null || r.success !== true) return false;",
    replace: "  if (r === null) return false;",
  },

  // ── 세션 envelope ──────────────────────────────────────────────────────
  {
    id: "M11", file: "worker/index.js", suite: "test-friends",
    what: "envelope 의 판(version) 검사를 뺀다",
    invariant: "모르는 판의 쿠키는 통과하지 않는다",
    find: "  if (v !== SESSION_ENVELOPE_VERSION) return false;      // 지원하지 않는 판",
    replace: "  if (!v) return false;",
  },
  {
    id: "M12", file: "worker/index.js", suite: "test-friends",
    what: "envelope 의 만료 검사를 뺀다",
    invariant: "만료된 쿠키는 서명이 맞아도 통과하지 않는다",
    find: "  if (!Number.isInteger(e) || e * 1000 <= now) return false;",
    replace: "  if (!Number.isInteger(e)) return false;",
  },
  {
    id: "M13", file: "worker/index.js", suite: "test-friends",
    what: "envelope 의 서명 검사를 통과로 만든다",
    invariant: "우리가 발급하지 않은 쿠키는 DB 앞에서 버려진다",
    find: "  return await sameSecret(await envelopeSign(env, `${v}.${rand}.${exp}`), sig);",
    replace: "  return true;",
  },

  // ── 남용 방어 ──────────────────────────────────────────────────────────
  {
    id: "M14", file: "worker/index.js", suite: "test-abuse-guard",
    what: "countVerdict 의 예외를 통과(OK)로 읽는다",
    invariant: "리미터 저장소가 답을 안 하면 계정 경로를 닫는다(503) — 429 도 통과도 아니다",
    find: "    return BROKEN;\n  }\n}\n\nconst tooMany",
    replace: "    return OK;\n  }\n}\n\nconst tooMany",
  },
  {
    id: "M15", file: "worker/index.js", suite: "test-docs",
    what: "리미터를 임차증 뒤로 옮긴다(순서 역전)",
    invariant: "엣지 → 게이트 → 리미터 → 임차증 순서. 뒤집히면 막힌 요청도 지속 저장소에 쓴다",
    transform: (src) => {
      const a = src.indexOf("    if (rt.bucket) {\n      const v = await countVerdict");
      const b = src.indexOf("    // ── 0-1-1. 요청 임차증 ──");
      const anchor = "    try {\n      return await route(req, denv, { url, path, gate, lease, rt });";
      if (a < 0 || b < 0 || b < a || !src.includes(anchor)) return null;
      const lim = src.slice(a, b);
      return (src.slice(0, a) + src.slice(b)).replace(anchor, lim + anchor);
    },
  },
  {
    id: "M16", file: "worker/index.js", suite: "test-abuse-guard",
    what: "공개 /ready 의 운영자 키 검사를 지운다",
    invariant: "진단은 운영자만 본다. 키 없는 호출은 어느 DB 도 만지지 않는다",
    find: "      if (!(await sameSecret(env.READY_KEY || \"\", req.headers.get(\"X-Ready-Key\") || \"\")))\n"
        + "        return json(env, req, { ok: true, ready: false, diagnostics: false }, 503,\n"
        + "          { \"Retry-After\": \"60\" });\n",
    replace: "",
  },
  {
    id: "M17", file: "worker/index.js", suite: "test-abuse-guard",
    what: "pages.dev 호스트 잠금을 지운다",
    invariant: "waf 모드에서 계정 API 는 WAF 가 걸리는 호스트로 온 요청만 받는다",
    find: "      if (mode === \"waf\" && url.host !== wafHost(env))\n"
        + "        return json(env, req, { error: \"이 주소에서는 계정 기능을 쓸 수 없어요\" }, 403);\n",
    replace: "",
  },

  // ── 가입 기록 · 소비 표식 ──────────────────────────────────────────────
  {
    id: "M18", file: "worker/index.js", suite: "test-signup",
    what: "계정+정책 기록 batch 를 순차 실행으로 바꾼다",
    invariant: "계정과 필수 정책 기록은 한 트랜잭션이다 — 중간 실패에 반쪽이 남지 않는다",
    find: "  await env.DB.batch(stmts);",
    replace: "  for (const st of stmts) await st.run();",
  },
  {
    id: "M19", file: "worker/index.js", suite: "test-signup",
    what: "소비 표식 충돌을 무시한다(INSERT OR IGNORE)",
    invariant: "같은 가입 state 는 두 번 쓰이지 않는다",
    find: "  const stmts = [\n    env.DB.prepare(\n      `INSERT INTO consumed_signup_states",
    replace: "  const stmts = [\n    env.DB.prepare(\n      `INSERT OR IGNORE INTO consumed_signup_states",
  },

  // ── 삭제 표식 ledger ───────────────────────────────────────────────────
  {
    id: "M20", file: "worker/ledger.js", suite: "test-cleanup",
    what: "표식 정리에서 confirmed 조건을 뺀다",
    invariant: "확정되지 않은 삭제 표식은 지우지 않는다 — 지우면 복원 때 그 사람이 되살아난다",
    find: "  \"DELETE FROM deletions WHERE confirmed_at IS NOT NULL AND expires_at < ?\";",
    replace: "  \"DELETE FROM deletions WHERE expires_at < ?\";",
  },
  {
    id: "M21", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "markPending 의 fencing 을 항상 참으로 만든다",
    invariant: "유지보수로 전환된 뒤 살아남은 요청은 표식을 더 남기지 못한다",
    find: "     SELECT ?, ?, ?, ?, ? WHERE ${fenced(FENCE)}",
    replace: "     SELECT ?, ?, ?, ?, ? WHERE 1=1 AND (? IS NOT NULL) AND (? IS NOT NULL)",
  },
  {
    id: "M22", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "markConfirmed 에서 confirmed_at IS NULL 조건을 뺀다(중복 확정 허용)",
    invariant: "확정은 한 번뿐이다 — 두 번째 확정이 보유기간을 매번 뒤로 민다",
    find: "      WHERE mark = ? AND confirmed_at IS NULL AND ${fenced(FENCE)}`)",
    replace: "      WHERE mark = ? AND ${fenced(FENCE)}`)",
  },

  // ── 화면의 계정 readiness (2026-08-23) ─────────────────────────────────
  //
  // 왜 여기 있나: `apiHealth()` 가 서버 응답에서 `ready` 를 **버리고 있었다.** 판정하는 쪽
  // (js/auth.js)은 `h.ready` 를 읽는데 없는 필드라 언제나 `undefined` 였고, 그래서 라이브의
  // `{"ok":true,"ready":false,"providers":[]}` 를 받고도 **계정 기능을 연 것으로 판정**했다.
  // 서버의 503 fail-closed 는 그대로였으므로 데이터가 새지는 않았지만, 화면은 열려 있는 척했다.
  // ⛔ **그때 `test-client` 74개가 전부 통과하고 있었다** — 기본 store 가 로그인 상태라
  //    뒤이은 `/book` 503 이 우연히 상태를 down 으로 바꿔 줬기 때문이다. 재던 것은 `ready`
  //    계약이 아니라 **뒤이은 503** 이었다. 그래서 두 방향을 각각 잰다.
  {
    id: "M23", file: "js/authApi.js", suite: "test-client",
    what: "apiHealth() 의 성공 응답에서 `ready` 를 다시 버린다",
    invariant: "서버가 말한 `ready` 는 브라우저의 계정 상태까지 전달된다 — 버리면 판정하는 쪽이 언제나 `undefined` 를 읽는다",
    find: "      ? { ok: true, ready: d.ready, providers: d.providers,",
    replace: "      ? { ok: true, providers: d.providers,",
  },
  {
    id: "M24", file: "js/authApi.js", suite: "test-client",
    what: "성공 응답의 최소 계약에서 `ready` 의 타입 검사를 뺀다(누락·문자열·숫자·null 이 통과)",
    invariant: "계약을 어긴 응답은 `providers` 도 못 믿는다 — 조용히 `ready:false` 로 정규화하면 계정 UI 는 닫히는데 되지 않는 로그인 버튼이 그려진다",
    find: "    return d && d.ok === true && typeof d.ready === \"boolean\" && Array.isArray(d.providers)",
    replace: "    return d && d.ok === true && Array.isArray(d.providers)",
  },
  {
    id: "M25", file: "js/auth.js", suite: "test-client",
    what: "첫 화면의 계정 판정이 `/health` 를 안 보고 언제나 열린 것으로 친다",
    invariant: "계정 기능을 여는 근거는 서버의 `/health` 다 — 판정 자리가 응답을 안 보면 앞의 두 변이를 막아도 소용없다",
    find: '    setAccountState(h.ok === true && h.ready === true ? "ok" : "down");',
    replace: '    setAccountState("ok");',
  },
  {
    id: "M26", file: "js/auth.js", suite: "test-client",
    what: "첫 화면의 계정 판정이 `ok` 만 보고 `ready` 를 안 본다(서버가 닫혔다고 말해도 연다)",
    invariant: "「서버가 대답했다」와 「서버가 계정 기능을 열었다고 말했다」는 다른 말이다 — 앞의 것만 보면 라이브가 주는 `ready:false` 가 아무 일도 안 한다",
    find: '    setAccountState(h.ok === true && h.ready === true ? "ok" : "down");',
    replace: '    setAccountState(h.ok === true ? "ok" : "down");',
  },

  // ── 문서 회귀 (정적 검사) ───────────────────────────────────────────────
  //
  // 왜 여기 있나: 2026-08-22 후속 재검증에서 `npm test` 가 통과하는 상태로 **낡은 운영 상태
  // 여섯 가지**가 문서에 남아 있었다(`docs/HANDOFF.md` §5 의 함정 항목). 운영 상태를 잘못
  // 읽으면 다음 사람이 **없는 것을 있다고 믿고 원격 작업을 시작한다** — 그건 코드 결함과
  // 같은 급의 사고다. 그래서 문서 불변식도 돌연변이로 잰다.
  {
    id: "D01", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "운영현황의 현재 라이브를 지운 배포 `f72f5225` 로 되돌린다",
    invariant: "현재 production 배포를 정확히 말한다 — 지운 세대를 라이브라고 적으면 롤백 대상과 검증 대상이 통째로 틀어진다",
    find: "| **라이브 (production)** | **배포 `7362d2f0`**",
    replace: "| **라이브 (production)** | **배포 `f72f5225`**",
  },
  {
    id: "D02", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "원격 migration 을 「적용 대기 0건」으로 되돌린다",
    invariant: "원격 `0005` 가 적용 대기라는 사실을 말한다 — 0건이라고 적으면 migration 없이 배포해 첫 가입에서 500 이 난다",
    find: "⛔ **`0005_policy_events_and_signup_states.sql` 적용 대기 1건**",
    replace: "적용 대기 0건",
  },
  {
    id: "D03", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "production 시크릿을 「두 개」로 되돌리고 `READY_KEY` 를 뺀다",
    invariant: "등록된 시크릿 목록이 실측과 같다 — 빠뜨리면 이미 있는 값을 또 넣거나 없는 값을 있다고 믿는다",
    find: "| **시크릿 (production)** | **`READY_KEY` · `RL_KEY` · `STATE_KEY` 세 개**",
    replace: "| **시크릿 (production)** | **`RL_KEY` · `STATE_KEY` 두 개 등록됨**",
  },
  {
    id: "D04", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "제어면 삭제와 공개 URL 폐쇄를 한 행으로 합친다",
    invariant: "제어면 삭제와 공개 URL 폐쇄는 다른 사건이라 다른 행이다 — 합치면 다음 사람이 「끝났다」로 읽고 재측정을 건너뛴다",
    find: "| **옛 배포 — 제어면** | ✅ **15개 삭제 완료 2026-08-22.**",
    replace: "| **옛 배포 폐쇄** | ✅ **15개 삭제 완료 2026-08-22 — 공개 URL 폐쇄 완료.**",
  },
  {
    id: "D05", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "체크리스트 18번을 「옛 공개 배포 폐쇄 — 완료」로 되돌린다",
    invariant: "18번은 제어면 삭제 하나의 기록이다 — 공개 접근 차단(19번)과 합쳐 「폐쇄 완료」라고 말하지 않는다(복원 금지 해제 조건 ⑦ 이 여기 걸려 있다)",
    find: "| 18(부분) | **옛 공개 배포 — 제어면 삭제** | ✅ **제어면 삭제만 완료 2026-08-22.** ⛔ **이 행은 제어면 삭제 하나의 기록이다**",
    replace: "| ~~18~~ ✅ | **옛 공개 배포 폐쇄** | **완료 2026-08-22.** 이 행 하나로 끝났다",
  },
  {
    id: "D06", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "현재 판정의 설계 판을 10판으로 되돌린다",
    invariant: "현재 판정이 말하는 설계 판은 설계서의 판(`EDITION`)에서 파생된다",
    find: "3단계 설계 11판 완료(9판 사용자 결정 0~7 + 10판 전체 재검증 4건 + 11판 독립 검토 3건)",
    replace: "3단계 설계 10판 완료(9판 사용자 결정 0~7 + 10판 재검증 4건)",
  },
  {
    id: "D07", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "재감사 결함 합계와 위협 범위를 22건 · 39~60 으로 되돌린다",
    invariant: "결함 합계와 위협 범위는 설계서의 위협 표에서 파생된다 — 낡은 숫자는 「이미 다 봤다」는 착각을 만든다",
    find: "차례로 재현했다(위협 **39~72** · **여섯 판 연속**",
    replace: "차례로 재현했다(위협 39~60 · 다섯 판 연속",
  },
  {
    id: "D08", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "재감사 결함 합계만 22건으로 되돌린다(위협 범위는 그대로 둔다)",
    invariant: "합계는 판별 문형(`4+5+…건` · `N건을 차례로 재현`) 어느 쪽으로 적어도 파생값과 같아야 한다",
    find: "4단계 로컬 구현 완료(재감사 결함 4+5+4+5+4+3+1+1+4+3건 = **34건** 수정",
    replace: "4단계 로컬 구현 완료(재감사 결함 4+5+4+5+4건 = **22건** 수정",
  },
  {
    id: "D09", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "Access 차단을 「404 가 됐다」로 승격한다",
    invariant: "제어면 삭제 · 공개 접근 차단 · 404 는 서로 다른 세 사건이다 — Access 차단은 배포를 없애지 않는다",
    find: "⚠️ **404 가 아니다** — 배포는 여전히 존재하고 Access 뒤에서 실행될 수 있다.",
    replace: "옛 배포는 이제 404 가 됐다.",
  },
  {
    id: "D10", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "Access 차단이 가역적이라는 사실을 지운다",
    invariant: "프리뷰 액세스를 끄면 옛 15개가 다시 401 이다 — 되돌릴 수 있는 통제를 영구 조치로 적지 않는다",
    find: "⚠️ **가역적이다** — 끄면 다시 401 이다.",
    replace: "이로써 옛 배포 문제는 영구히 해결됐다.",
  },
  {
    id: "D11", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "복원 금지 해제 조건 ⑦ 이 Access 로 충족됐다고 적는다",
    invariant: "조건 ⑦ 은 옛 배포 차단 증명(D1~D12)이고, 공개 접근 차단 하나로 대체되지 않는다",
    find: "조건 ⑦(옛 배포 차단 D1~D12)은 **별도 검토**로 남는다.",
    replace: "이로써 복원 금지 해제 조건 ⑦ 충족.",
  },
  {
    id: "D12", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "2026-08-22 역사 절을 다시 「지금도 401 · 지원 문의 필요」라는 현재형 판정으로 되돌린다",
    invariant: "더 최신 운영 기록이 있으면 옛 날짜 절은 현재형 운영 판정을 주장할 수 없다 — 두 절이 서로 다른 「지금」을 말하면 다음 사람이 옛 쪽을 읽는다",
    find: "> ### 당시 판정 — **2026-08-22 에는 공개 URL 이 401 로 남아 있었다**",
    replace: "그러므로 지금 사실은 **「공개 URL 폐쇄는 ❌ 미완료」**이고, 다음 단계는 Cloudflare 지원 문의가 필요하다.\n\n> ### 참고",
  },
  {
    id: "D14", file: "docs/OPS_RUNBOOK.md", suite: "test-docs", kind: "정적",
    what: "현재 상태를 「옛 15개가 아직 401 · 공개 URL 폐쇄 미완료」로 되돌린다",
    invariant: "Access 기록이 있으면 현재 상태가 「아직 401」이라고 단정할 수 없다 — 옛 401 은 「당시 사실」이지 지금이 아니다",
    find: "  - **공개 접근 차단**: ✅ 2026-08-23. **Pages 프리뷰 액세스**로 막았다 — 옛 15개가 **전부 302 →\n"
        + "    `cloudflareaccess.com`**(401 0건) · canonical `shhh-app.pages.dev` 는 **대상이 아니라 그대로**다(§16-1).",
    replace: "  - **공개 접근 차단**: 미완료. 지운 15개의 해시 주소는 **아직 `/api/book` 에 401 로 답한다** —\n"
           + "    공개 URL 폐쇄는 미완료이고 §16 이 재측정 방법을 적는다.",
  },
  {
    id: "D15", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "돌연변이 목록 개수를 낡은 22 로 되돌린다",
    invariant: "문서가 주장하는 돌연변이 개수는 `MUTATIONS` 목록에서 파생한다 — 손으로 적은 총수는 반드시 낡는다",
    // ⚠️ **이 앵커는 개수가 바뀔 때마다 함께 바꾼다**(D21 을 더하며 세 번째로 고쳤다).
    //    자기가 건드리는 숫자를 앵커에 담는 변이라 피할 수 없다 — 대신 낡으면 실행기가
    //    ANCHOR-MISS 로 종료 코드 1 을 내므로 **조용히 썩지는 않는다.**
    find: "`scripts/mutations.mjs`(목록 83종",
    replace: "`scripts/mutations.mjs`(목록 22종",
  },
  {
    id: "D13", file: "docs/HANDOFF.md", suite: "test-docs", kind: "정적",
    what: "운영현황의 배포 지점 행에 「최신 커밋」 해시를 고정한다",
    invariant: "움직이는 HEAD 해시를 문서에 손으로 적지 않는다 — 커밋할 때마다 낡고, 실제로 한 번 낡았다",
    find: "**production source 는 `e02e810` 이다**(2026-08-24)",
    replace: "**최신 세 커밋(`156fd8a`·`41455b6`·`8628e14`)은 production 에 안 올라갔다**(2026-08-24)",
  },
  {
    id: "D16", file: "docs/OPS_RUNBOOK.md", suite: "test-docs", kind: "정적",
    what: "배포 경계 범위의 위협 끝번호를 낡은 63 으로 되돌린다",
    invariant: "「배포 지점 이후」를 가리키는 범위는 끝이 열려 있다 — 끝번호는 위협 표의 최신 번호에서 파생한다(미배포·배포 양쪽 모두)",
    find: "수정이 여기 들어 있다.",
    replace: "수정 중 위협 57~63 까지가 여기 들어 있다.",
  },
  // ── 2026-08-25 재마감: drain 결속 · 복귀 주소 · GET 무쓰기 · 세션 폐기 재시도 ──
  {
    // ⚠️ **두 층을 함께 없앤다.** 처음에는 이른 return 하나만 지웠는데 SQL 의 `mode <> 'open'`
    //    이 남아 결과가 같았다 — **동등 변이**라 생존이 공백의 증거가 아니었다(2026-08-25 실측).
    //    open 거부는 실제로 두 겹이고, 한 겹만 빼는 변이는 그 사실을 재지 못한다.
    id: "M27", file: "worker/ops.js", suite: "test-deletion-ledger",
    what: "open 모드 거부를 두 층 모두 없앤다 (이른 return + SQL 조건)",
    invariant: "요청이 자유롭게 들어오는 상태에서 「멈췄다」를 적지 않는다",
    transform: (src) => src
      .replace("  if (cur.mode === \"open\")\n"
        + "    return { drained: false, why: \"open 에서는 drain 을 인증하지 않는다 — 요청이 자유롭게 들어온다\" };\n", "")
      .replace("AND mode <> 'open'\n        AND NOT EXISTS", "\n        AND NOT EXISTS"),
  },
  {
    id: "M28", file: "worker/ops.js", suite: "test-deletion-ledger",
    what: "markDrained 의 mode·epoch CAS 를 없앤다",
    invariant: "판정에 쓴 게이트가 그대로일 때만 drain 증거를 적는다 (읽고 나서 쓰면 그 사이가 창이다)",
    find: "      WHERE id = 1 AND mode = ? AND epoch = ? AND mode <> 'open'\n"
        + "        AND NOT EXISTS (SELECT 1 FROM write_leases)`)\n"
        + "    .bind(now, cur.mode, cur.epoch).run();",
    replace: "      WHERE id = 1`)\n    .bind(now).run();",
  },
  {
    id: "M29", file: "worker/ops.js", suite: "test-deletion-ledger",
    what: "markDrained 의 NOT EXISTS write_leases 조건을 없앤다",
    invariant: "도는 작업이 하나라도 있으면 drain 증거를 적지 않는다 — 같은 문장 안에서 확인한다",
    find: "AND mode <> 'open'\n        AND NOT EXISTS (SELECT 1 FROM write_leases)`)",
    replace: "AND mode <> 'open'`)",
  },
  {
    id: "M30", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "drain 인증 뒤에도 신규 임차증을 내준다",
    invariant: "drain 이 인증된 epoch 에서는 새 작업이 못 들어온다 (증거가 그 자리에서 거짓이 되면 안 된다)",
    find: "      WHERE m.mode IN (${marks}) AND m.drained_at IS NULL",
    replace: "      WHERE m.mode IN (${marks})",
  },
  {
    id: "M31", file: "worker/ops.js", suite: "test-deletion-ledger",
    what: "reconcile 의 drain 증거 검사를 없앤다",
    invariant: "두 DB 를 훑는 승격 판정은 이 epoch 의 drain 증거를 요구한다 (한 문장으로 못 만드는 판정이다)",
    find: "  if (gate.drained_at == null)\n"
        + "    return { ok: false, why: \"이 epoch 의 drain 증거가 없다 — markDrained() 로 먼저 인증한다\" };",
    replace: "",
  },
  {
    id: "M32", file: "worker/ops.js", suite: "test-deletion-ledger",
    what: "setMode 가 전환할 때 drained_at 을 그대로 둔다",
    invariant: "모드 전환은 이전 drain 증거를 무효화한다 — 새 epoch 에서는 다시 인증해야 한다",
    find: "            closed_at = CASE WHEN ? = 'open' THEN NULL ELSE ? END,\n            drained_at = NULL",
    replace: "            closed_at = CASE WHEN ? = 'open' THEN NULL ELSE ? END",
  },
  {
    id: "M33", file: "worker/index.js", suite: "test-friends",
    what: "네이버 복귀 주소를 다시 env.APP_URL 에 의존시킨다",
    invariant: "복귀 주소의 원본은 준비도 계약 안의 APP_ORIGIN 하나다 (계약 밖 변수는 빠져도 readiness 가 초록이다)",
    find: "  P[name].viaApp ? appOrigin(env) + \"/\" : origin + \"/api/cb/\" + name;",
    replace: "  P[name].viaApp ? env.APP_URL : origin + \"/api/cb/\" + name;",
  },
  {
    id: "M34", file: "worker/index.js", suite: "test-friends",
    what: "appOrigin 이 origin 모양을 확인하지 않고 그대로 돌려준다",
    invariant: "APP_ORIGIN 은 https 이고 path·query·fragment·끝 슬래시가 없어야 한다",
    find: "  return u.origin === raw ? u.origin : null;",
    replace: "  return raw;",
  },
  {
    id: "M35", file: "worker/index.js", suite: "test-friends",
    what: "GET /friends 가 다시 초대 코드를 만든다",
    invariant: "OAuth 콜백을 뺀 모든 GET 은 주 D1·ledger D1 에 논리적 변경 0건이다 (콜백은 제공자가 GET 으로 되돌려보내므로 없앨 수 없는 예외이고, 서명 state + shh_t 로 묶인다)",
    find: "        const mine = await liveCode(env, uid);\n"
        + "        return json(env, req, {\n          code: mine ? mine.code : null,",
    replace: "        return json(env, req, {\n          code: await myCode(env, uid),",
  },
  {
    id: "M36", file: "worker/index.js", suite: "test-friends",
    what: "초대 코드 생성 POST 를 라우트 표에서 뺀다 (= 404 로 만든다)",
    invariant: "코드 생성은 라우트 표에 등재된 same-origin·인증 POST 하나다",
    find: "  [/^\\/friends\\/code\\/ensure$/, [\"POST\"], true, \"write\", true],\n",
    replace: "",
  },
  {
    id: "M37", file: "js/authApi.js", suite: "test-client",
    what: "세션 폐기가 실패해도 표식을 지운다",
    invariant: "끊었다는 확인(2xx·401) 없이는 표식을 지우지 않는다 — 지우면 그 세션은 영영 남는다",
    find: "    .then((done) => { if (done) clearRevokePending(); return done; })",
    replace: "    .then((done) => { clearRevokePending(); return done; })",
  },
  {
    id: "M38", file: "js/authApi.js", suite: "test-client",
    what: "모든 4xx 를 「끊었다」로 친다",
    invariant: "403·429 는 서버가 세션을 만지지도 않은 응답이다 — 성공으로 치면 그 세션이 남는다",
    find: "const REVOKED = (status) => status === 401 || (status >= 200 && status < 300);",
    replace: "const REVOKED = (status) => status < 500;",
  },
  {
    id: "M39", file: "js/auth.js", suite: "test-client",
    what: "다음 실행의 재시도를 없앤다",
    invariant: "표식이 남아 있으면 다음 앱 실행이 세션 폐기를 다시 보낸다",
    find: "    if (!plantsSession(ret)) retryRevokeSession();\n",
    replace: "",
  },
  {
    id: "M40", file: "js/auth.js", suite: "test-client",
    what: "왕복 중 자물쇠를 실제 복귀 종류에서 파생하지 않고 언제나 열어 둔다",
    invariant: "로그인 왕복이 도는 동안에는 재시도가 잠긴다 — 그 자리의 쿠키는 방금 심어진 새 세션이다",
    // ⚠️ **옛 M40 은 2026-08-25 에 동등 변이가 됐다**(위협 70 을 닫으면서). 그때의 변이는
    //    부팅 재시도의 조건절 하나를 지웠는데, 이제 그 뒤를 `oauthBusy` 가 받치므로 지워도
    //    행동이 안 바뀐다 — 살아남은 이유가 「테스트 공백」이 아니라 「같은 프로그램」이었다.
    //    그래서 자물쇠를 세우는 그 자리를 직접 겨눈다(옛 M24 때와 같은 처리다).
    find: "    setOauthBusy(plantsSession(ret));",
    replace: "    setOauthBusy(false);",
  },
  {
    id: "M41", file: "policies/manifest.json", suite: "test-policies", kind: "정적",
    what: "번들의 privacy 판을 Turnstile 설명이 없는 옛 판으로 되돌린다",
    invariant: "현재 방침 판은 실제로 나가는 외부 요청을 전부 설명한다 (가입 화면의 challenges.cloudflare.com)",
    find: "        \"path\": \"policies/privacy-ea634a5aeafd.html\",",
    replace: "        \"path\": \"policies/privacy-1d3d2d870876.html\",",
  },
  {
    id: "D22", file: "docs/PRIVACY_LEGAL_REVIEW_PACKET.md", suite: "test-docs", kind: "정적",
    what: "법률 자료를 다시 「설계만 있고 코드가 없다」로 되돌린다",
    invariant: "법률 검토 전달 자료는 현재 코드 사실을 말한다 — 없는 것을 전제로 검토하게 하면 검토가 헛돈다",
    find: "| **① 로컬 코드에 구현돼 있다** |",
    replace: "| **설계만 있고 코드가 없다** | 회원가입 화면 · policy_events · 삭제 표식 ledger |\n| **코드에 실제로 존재한다** |",
  },
  {
    id: "D23", file: "docs/OAUTH_REAPPROVAL_RUNBOOK.md", suite: "test-config", kind: "정적",
    what: "runbook 에서 SESSION_ENVELOPE_KEY 행을 지운다",
    invariant: "코드가 요구하는 이름은 배포 순서를 적은 문서 전부에 등재된다 (빠지면 그 순서로는 /api/ready 가 200 이 안 된다)",
    find: "| `SESSION_ENVELOPE_KEY` | 시크릿 | 세션 서명. 없으면 **쓸 수 없는 계정**이 만들어진다 |\n",
    replace: "",
  },
  {
    // ⚠️ **문서 전체에서 지운다.** 처음에는 표의 한 줄만 지웠는데 같은 이름이 §1 의 3c 행에도
    //    있어 검사가 그대로 통과했다 — **동등 변이**였다(2026-08-25 실측). 검사가 재는 것은
    //    「그 이름이 이 문서에 있나」이므로, 변이도 그 단위로 만들어야 재는 것과 맞는다.
    id: "D24", file: "docs/OAUTH_REAPPROVAL_RUNBOOK.md", suite: "test-config", kind: "정적",
    what: "runbook 에서 TURNSTILE_SECRET 이라는 이름을 전부 지운다",
    invariant: "코드가 요구하는 이름은 배포 순서 문서 전부에 등재된다 — 공개 site key 와 비밀키는 다른 값이고 둘 다 가입의 전제다",
    transform: (src) => src.replaceAll("TURNSTILE_SECRET", "(가입 비밀키)"),
  },
  {
    // ⚠️ **처음에는 「면제를 넓히고 조건을 되살리는」 두 조각짜리로 짰는데 살아남았다**
    //    (2026-08-25 실측). 당연했다 — 검사를 무력화하는 변이는 **그 검사 자신이 잡을 수 없다.**
    //    없앤 방어가 곧 유일한 관측 수단이면 「아무것도 실패하지 않음」이 나온다.
    //    그래서 면제 규칙을 술어(`exemptByDate`)로 꺼내고 **합성 입력으로 직접 재는 자기검사**를
    //    붙였다. 이제 규칙을 넓히는 변이는 그 자기검사가 잡는다.
    id: "D25", file: "scripts/test-docs.mjs", suite: "test-docs", kind: "정적",
    what: "검사 30 의 면제를 「날짜만 있으면 통과」로 넓힌다",
    invariant: "「로컬 완료 · 배포 안 함」 면제는 **배포일보다 뒤에 고친 것**에만 준다 — 날짜가 있다는 사실만으로 면제하지 않는다",
    find: "    && [...ln.matchAll(/(\\d{4}-\\d{2}-\\d{2})/g)].some((d) => d[1] > LIVE.date);",
    replace: "    && /(\\d{4}-\\d{2}-\\d{2})/.test(ln);",
  },
  {
    id: "D17", file: "docs/STAGE3_SIGNUP_SECURITY_DESIGN.md", suite: "test-docs", kind: "정적",
    what: "§13-6 매핑 합계를 낡은 79 로 되돌린다",
    invariant: "매핑 절의 「N건 전부 연결됐다」는 표의 최대 T 번호에서 파생한다 — 표만 늘리고 합계를 안 고치면 검사가 그것을 잡아야 한다",
    find: "**89건 전부 실행 가능한 단언으로 연결됐다.**",
    replace: "**79건 전부 실행 가능한 단언으로 연결됐다.**",
  },
  {
    id: "D18", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "현재 상태 블록의 안전 동기화 배포를 직전 `19e69dee` 로 되돌린다",
    invariant: "현재 상태 블록이 말하는 배포 ID·source 는 「현재 라이브」 원본과 같아야 한다 — 옛 배포는 당시·직전·롤백 맥락에서만 적는다",
    find: "✅ 안전 동기화 배포는 실행됐다 — production **`7362d2f0`**(source **`e02e810`**)",
    replace: "✅ 안전 동기화 배포 `19e69dee` 는 실행됐고, production",
  },
  {
    id: "D19", file: "CLAUDE.md", suite: "test-docs", kind: "정적",
    what: "위협 57 의 행을 「로컬 완료 · 배포 안 함」으로 되돌린다",
    invariant: "배포된 source 앞의 「로컬 완료」 수정은 전부 배포됐다 — 「배포 안 함」은 당시 기록일 때만 참이다",
    find: "| ~~P0~~ ✅ | **부분 시크릿에서 가입이 끝까지 진행됐다** | **로컬 수정 2026-08-22 · 배포 2026-08-24**(production `7362d2f0` · source `e02e810`). ⚠️ **당시 사실 — 2026-08-22**: 그날은 배포하지 않았고 라이브는 `19e69dee` 였다. ",
    replace: "| ~~P0~~ ✅ | **부분 시크릿에서 가입이 끝까지 진행됐다** | **로컬 완료 2026-08-22 · 배포 안 함.** ",
  },
  {
    id: "D20", file: "CLAUDE.md", suite: "test-docs", kind: "정적",
    what: "timing-safe 비교 설명을 「Node 에 없으니 쓰지 않는다」는 중간 결론으로 되돌린다",
    invariant: "문서의 timing-safe 서술은 worker/index.js 가 실제로 부르는 것과 같아야 한다 — 기준은 코드다",
    find: "**현재 구현은 요약 32바이트를 런타임의 `crypto.subtle.timingSafeEqual()` 로 비교하고 JS fallback 이 없다**",
    replace: "`crypto.subtle.timingSafeEqual` 은 **Workers 확장이라 Node 에 없다** — 스위트가 Node 에서 도는 한 쓰지 않는다",
  },
  {
    id: "D21", file: "docs/STAGE3_SIGNUP_SECURITY_DESIGN.md", suite: "test-docs", kind: "정적",
    what: "「종」이 없는 괄호형 내역을 낡은 「정적 21」로 되돌린다",
    invariant: "총계뿐 아니라 **하위 내역**도 MUTATIONS 에서 파생한다 — 「N종」이라고 안 적은 괄호형 내역도 센다(총계만 보면 66 ≠ 40+21 이 남는다)",
    find: "(동작 57 · 정적 26).",
    replace: "(동작 40 · 정적 21).",
  },
  // ── 위협 70 · 불완전한 OAuth 주소가 세션 폐기 재시도를 막던 결함의 방어들 ──
  {
    id: "M42", file: "js/auth.js", suite: "test-client",
    what: "모양만 갖춘 OAuth 주소(junk)를 진짜 복귀로 쳐서 재시도를 건너뛴다",
    invariant: "`#login=` · `?code=&state=` 같은 불완전한 값은 복귀가 아니다 — 재시도를 삼키면 새로고침마다 삼켜서 서버 세션이 영영 남는다",
    find: "    if (!plantsSession(ret)) retryRevokeSession();",
    replace: "    if (!ret) retryRevokeSession();",
  },
  {
    id: "M43", file: "js/auth.js", suite: "test-client",
    what: "불완전한 OAuth 파라미터를 주소에서 지우지 않는다",
    invariant: "판정이 「복귀 모양」이라 읽은 것은 전부 주소에서 지운다 — 남기면 다음 실행이 같은 오판을 무한히 반복한다",
    find: "    if (!hm && !hasQ) return null;",
    replace: "    if (!hm && !hasQ) return null;\n    if (!(hm && hm[1]) && !(q.get(\"code\") && q.get(\"state\"))) return { kind: \"junk\" };",
  },
  {
    id: "M44", file: "js/authApi.js", suite: "test-client",
    what: "세션 폐기의 single-flight 를 없앤다",
    invariant: "재시도를 부르는 자리가 셋이라 겹칠 수 있다 — 겹치면 online 이 연달아 뜨는 회선에서 DELETE 가 폭주한다",
    find: "  if (revokeInFlight) return revokeInFlight;",
    replace: "  if (false) return revokeInFlight;",
  },
  {
    id: "M45", file: "js/authApi.js", suite: "test-client",
    what: "로그인 왕복 중 재시도를 재우는 자물쇠를 없앤다",
    invariant: "왕복이 도는 동안의 재시도는 서버가 막 심는 **새 세션**을 끊는다 — 자물쇠는 위치가 아니라 상태여야 한다",
    find: "  if (oauthBusy || !revokePending()) return null;",
    replace: "  if (!revokePending()) return null;",
  },
  {
    id: "M46", file: "js/authApi.js", suite: "test-client",
    what: "연결 복구(online) 재시도를 없앤다",
    invariant: "오프라인에서 실패한 폐기는 연결이 돌아오면 그 자리에서 다시 시도한다 — 없으면 앱을 다시 열 때까지 방치된다",
    find: "addEventListener(\"online\", () => { retryRevokeSession(); });",
    replace: "",
  },
  // ── 원칙 5 · lease context(ledger 가 발급한 epoch) ──
  {
    id: "M47", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "lease context 검사를 무력화해 문자열 lease_id 를 통과시킨다",
    invariant: "lease 를 받는 함수는 { id, epoch } 만 받는다 — 문자열을 받으면 그 경로는 epoch 을 모른 채 돌고 주 D1 fencing 을 걸 수 없다",
    find: "  if (!lease || typeof lease !== \"object\"",
    replace: "  if (false && (!lease || typeof lease !== \"object\")",
  },
  {
    id: "M48", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "발급 epoch 을 ledger 가 돌려준 값이 아니라 상수로 만든다",
    invariant: "epoch 은 ledger 가 INSERT ... RETURNING 으로 발급한다 — 코드가 정한 값은 그 행의 값이 아니다",
    find: "  return Object.freeze({ id, epoch: Number(row.epoch) });",
    replace: "  return Object.freeze({ id, epoch: 1 });",
  },
  // ── 원칙 1~9 · 주 D1 구조적 fencing / 전환 프로토콜 / stale 해제 ──
  {
    id: "M49", file: "worker/fence.js", suite: "test-fence",
    what: "fence 술어를 항상 참으로 만든다",
    invariant: "옛 epoch 을 든 요청은 주 D1 에 한 줄도 못 쓴다 — 술어가 참이면 유지보수 전환이 아무것도 막지 못한다",
    find: "const FENCE_SQL = \"EXISTS (SELECT 1 FROM write_fence WHERE id = 1 AND epoch = ?)\";",
    replace: "const FENCE_SQL = \"(? IS NOT NULL)\";",
  },
  {
    id: "M50", file: "worker/fence.js", suite: "test-fence",
    what: "fence 불일치를 정상 0행으로 삼킨다",
    invariant: "0행의 두 뜻을 가른다 — 불일치를 정상으로 읽으면 막힌 요청이 성공으로 보고된다",
    find: "  if (!(await fenceCurrent(raw, epoch))) throw new FenceMismatch();",
    replace: "  if (false) throw new FenceMismatch();",
  },
  {
    id: "M51", file: "worker/ledger.js", suite: "test-fence",
    what: "전환 중에도 신규 임차증을 내준다",
    invariant: "전환은 두 DB 를 건드리므로 먼저 문을 닫는다 — 열려 있으면 그 창의 요청이 옛 epoch 을 들고 나간다",
    find: "        AND m.pending_transition IS NULL",
    replace: "",
  },
  {
    id: "M52", file: "worker/ops.js", suite: "test-fence",
    what: "전환에서 주 D1 fence 옮기기를 건너뛴다",
    invariant: "fence 를 안 옮기면 옛 epoch 요청이 계속 쓴다 — 전환이 이름만 남는다",
    find: "  if (tr.state === \"started\") {",
    replace: "  if (false) {",
  },
  {
    id: "M53", file: "worker/ops.js", suite: "test-fence",
    what: "stale 해제가 만료·완충을 안 보고 대상으로 삼는다",
    invariant: "만료되지 않은 임차증은 stale 이 아니다 — 아직 도는 작업의 증거를 지우는 것이다",
    // ⚠️ **옛 M53 은 2026-08-25 에 동등 변이였다.** 그때의 변이는 `epoch < ?` 를 `epoch <= ?` 로
    //    바꾸는 것이었는데, 바로 앞 단계가 「현재 epoch 이상인 임차증 0건」을 이미 요구하고
    //    신규 획득은 자물쇠로 막혀 있어서 두 조건이 **같은 집합**을 고른다 — 살아남은 이유가
    //    테스트 공백이 아니라 「같은 프로그램」이었다(옛 M24·M40 과 같은 처리).
    //    그래서 겹치지 않는 조건인 만료·완충을 겨눈다.
    find: "        WHERE epoch < ? AND expires_at <= ?`).bind(g2.epoch, cutoff).all();",
    replace: "        WHERE epoch < ? AND expires_at > -1`).bind(g2.epoch, cutoff).all();",
  },
  {
    id: "M54", file: "worker/ops.js", suite: "test-fence",
    what: "open 모드에서도 stale 해제를 허용한다",
    invariant: "open 에서는 새 요청이 계속 들어온다 — 그 상태에서 해제하면 증거가 그 자리에서 거짓이 된다",
    find: "  if (gate.mode !== \"maintenance\" && gate.mode !== \"restore_closed\")",
    replace: "  if (false)",
  },
  {
    id: "M55", file: "worker/ops.js", suite: "test-fence",
    what: "live lease 가 있어도 stale 해제를 진행한다",
    invariant: "현재 epoch 의 임차증이 하나라도 있으면 아무것도 해제하지 않는다",
    find: "    if (Number(live && live.n) > 0)",
    replace: "    if (false)",
  },
  {
    id: "M56", file: "worker/ops.js", suite: "test-fence",
    what: "두 DB 의 epoch 이 어긋나도 stale 해제를 허용한다",
    invariant: "fence 와 ledger epoch 이 같아야 「옛 epoch 은 못 쓴다」의 전제가 성립한다",
    find: "  if (!(await fenceInSync(env)))",
    replace: "  if (false)",
  },
  {
    id: "M57", file: "worker/fence.js", suite: "test-fence",
    what: "fenceInSync 가 진행 중인 전환을 무시한다",
    invariant: "전환이 중간에 멈춘 상태는 fail-closed 여야 한다 — 정상으로 읽으면 그 상태로 해제·배포가 통과한다",
    find: "    return Number(g.epoch) === (await fenceEpoch(env)) && !g.pending_transition;",
    replace: "    return Number(g.epoch) === (await fenceEpoch(env));",
  },
  {
    id: "M58", file: "worker/ops.js", suite: "test-fence",
    what: "식별 가능한 운영자 라벨을 허용한다",
    invariant: "operator_ref 는 비식별 라벨이다 — 자유 입력 칸은 개인정보 유입구다",
    find: "  if (typeof operatorRef !== \"string\" || !OPERATOR_REF.test(operatorRef))",
    replace: "  if (false)",
  },
];
