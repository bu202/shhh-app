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
    find: "  `DELETE FROM deletions WHERE confirmed_at IS NOT NULL AND expires_at < ?1",
    replace: "  `DELETE FROM deletions WHERE expires_at < ?1",
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
    find: "차례로 재현했다(위협 **39~81** · **여섯 판 연속**",
    replace: "차례로 재현했다(위협 39~60 · 다섯 판 연속",
  },
  {
    id: "D08", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "재감사 결함 합계만 22건으로 되돌린다(위협 범위는 그대로 둔다)",
    invariant: "합계는 판별 문형(`4+5+…건` · `N건을 차례로 재현`) 어느 쪽으로 적어도 파생값과 같아야 한다",
    find: "4단계 로컬 구현 완료(재감사 결함 4+5+4+5+4+3+1+1+4+3+6+3건 = **43건** 수정",
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
    find: "`scripts/mutations.mjs`(목록 161종",
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
    find: "  [/^\\/friends\\/code\\/ensure$/, [\"POST\"], true, \"write\", true, \"header\"],\n",
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
    // ⚠️ **앵커는 「현재 번들의 privacy 경로」다.** 새 판이 나올 때마다 여기를 갱신한다 —
    //    안 하면 앵커 실패로 `mutate.mjs` 가 0 이 아닌 코드로 끝난다(조용히 통과하지 않는다).
    // ⚠️ **경로를 손으로 적지 않는다.** 판을 새로 stamp 할 때마다 바뀌어 앵커가 낡는다
    //    (실제로 두 번 낡았다). 지금 번들이 가리키는 판을 **Turnstile 설명이 없는 옛 판**으로
    //    바꿔치기한다 — 그 옛 판은 지우지 않으므로 언제나 실재한다.
    transform: (src) => {
      const OLD = "privacy-1d3d2d870876.html";
      const m = JSON.parse(src);
      const old = m.versions.find((v) => v.file === OLD);
      if (!old) throw new Error("M41: 옛 판이 사라졌다 — 불변 판을 지우면 안 된다");
      m.bundle.docs.privacy = { path: "policies/" + old.file, hash: old.hash };
      return JSON.stringify(m, null, 2) + "\n";
    },
  },
  {
    id: "M59", file: "scripts/test-policies.mjs", suite: "test-policies", kind: "정적",
    what: "현재 방침 판 선택을 다시 `versions` 배열의 마지막 항목으로 되돌린다",
    invariant: "현재 판의 원본은 manifest 의 번들 하나다 — 배열 정렬 순서가 그것을 정하지 않는다",
    // ⚠️ **경로를 고르는 줄**을 바꾼다. 내용 단언만으로는 못 잡는다 — 첫 판이 그래서 살아남았다
    //    (`.at(-1)` 이 직전 판을 집었고 그 판도 모든 내용 단언을 통과했다).
    find: "  const curPath = POLICY_BUNDLE.docs.privacy.path;",
    // ⚠️ **`.at(-1)` 이 아니라 `.at(0)` 이다**(2026-08-26). 그날 만든 판의 해시가 우연히
    //    배열 마지막으로 정렬되면서 `.at(-1)` 이 **현재 판과 같은 파일**을 집었고, 그래서 이
    //    변이가 동치가 되어 살아남았다(실측). 「확실히 현재가 아닌 항목」을 집게 고쳤다.
    // ⚠️ **`.at(0)`·`.at(-1)` 을 쓰지 않는다** — 새 판의 해시가 우연히 그 자리에 오면
    //    변이가 현재 판을 고르게 되어 **동등 변이**가 된다(실제로 두 번 그랬다).
    //    번들이 가리키는 것과 **다른 판**을 고르면 언제나 불변식을 깬다.
    replace: "  const curPath = \"policies/\" + m.versions.filter((v) => v.kind === \"privacy\")\n      .find((v) => \"policies/\" + v.file !== m.bundle.docs.privacy.path).file;",
  },
  {
    id: "M60", file: "scripts/build.mjs", suite: "test-policies", kind: "정적",
    what: "카메라 JS 를 배포 allowlist 에 넣고 방침은 그대로 둔다",
    invariant: "배포되는 JS 가 늘면 방침 검사 범위도 함께 는다 — 하드코딩한 파일 목록은 새 파일을 놓친다",
    find: "  \"js/app.js\",",
    replace: "  \"js/camera.js\",\n  \"js/app.js\",",
  },
  {
    id: "D26", file: "CLAUDE.md", suite: "test-docs", kind: "정적",
    what: "외부 법률 검토를 다시 공개 출시 No-Go 사유로 적는다",
    invariant: "외부 전문가 상담은 사용자 결정으로 필수 범위에서 제외됐다 — No-Go 사유로 되살리지 않는다",
    find: "## 6. 구조와 경계",
    replace: "현재 외부 법률 검토 미완료이므로 공개 출시는 No-Go 다.\n\n## 6. 구조와 경계",
  },
  {
    id: "D27", file: "docs/PRIVACY_LEGAL_REVIEW_PACKET.md", suite: "test-docs", kind: "정적",
    what: "법률·사례 자료의 §10 을 다시 「현재 미해결 8건」으로 되돌린다",
    invariant: "8건은 2026-08-18 개정으로 해소됐다 — 현재 미해결로 적으면 검토 전제가 틀어진다",
    find: "## 10. 2026-08-17 당시 발견된 불일치 8건",
    replace: "## 10. 현재 개인정보처리방침과 코드의 알려진 불일치 8건",
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
    find: "**100건 전부 실행 가능한 단언으로 연결됐다.**",
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
    find: "(동작 115 · 정적 46).",
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
    find: "const fenceSql = (e) => `EXISTS (SELECT 1 FROM write_fence WHERE id = 1 AND epoch = ${e})`;",
    replace: "const fenceSql = (e) => `(${e} IS NOT NULL)`;",
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
  // ── 2026-08-26 2단계 재마감: 결정이 코드·방침에서 되살아나지 않는가 ──────
  {
    id: "M61", file: "worker/index.js", suite: "test-policies",
    what: "세션 절대 유효기간을 옛 180일로 되돌린다",
    invariant: "세션 기간의 원본은 상수 하나이고 방침이 같은 값을 적는다 — 한쪽만 바뀌면 방침이 거짓이 된다",
    find: "export const SESSION_DAYS = 90;",
    replace: "export const SESSION_DAYS = 180;",
  },
  {
    id: "M62", file: "worker/ledger.js", suite: "test-policies",
    what: "확정 표식 보유기간을 옛 37일로 되돌린다",
    invariant: "보유기간은 실제 요금제(Free · Time Travel 7일)에서 계산한다 — 가정값으로 되돌리면 방침의 숫자가 근거를 잃는다",
    find: "export const CONFIRMED_RETENTION = 15 * 86400e3;",
    replace: "export const CONFIRMED_RETENTION = 37 * 86400e3;",
  },
  {
    id: "M63", file: "worker/index.js", suite: "test-friends",
    what: "구글을 초기 개방 제공자 목록에 다시 넣는다",
    invariant: "초기 계정 개방은 네이버·카카오 둘이다 — 목록 밖 제공자는 화면에도 서버 라우트에도 없어야 한다",
    find: 'export const ENABLED_PROVIDERS = ["kakao", "naver"];',
    replace: 'export const ENABLED_PROVIDERS = ["kakao", "naver", "google"];',
  },
  {
    id: "M64", file: "worker/index.js", suite: "test-friends",
    what: "제공자 잠금을 화면(목록)에만 남기고 라우트에서는 뺀다",
    invariant: "막는 자리는 하나여야 한다 — 화면만 숨기면 주소를 아는 사람은 그대로 들어온다",
    find: 'const isProvider = (n) => typeof n === "string" && Object.prototype.hasOwnProperty.call(P, n)\n'
        + "  && ENABLED_PROVIDERS.includes(n);",
    replace: 'const isProvider = (n) => typeof n === "string" && Object.prototype.hasOwnProperty.call(P, n);',
  },
  {
    id: "M65", file: "worker/index.js", suite: "test-signup",
    what: "구글에 이메일·프로필 범위를 추가한다",
    invariant: "제공자에게 실명·이메일·전화번호를 요청하지 않는다 — 범위가 늘면 방침의 「요청조차 하지 않습니다」가 거짓이 된다",
    find: '    scope: "openid",                 // sub 만 받는 최소 범위',
    replace: '    scope: "openid email profile",   // sub 만 받는 최소 범위',
  },
  {
    id: "M66", file: "worker/schema.sql", suite: "test-signup",
    what: "users 표에 email 칸을 만든다",
    invariant: "저장할 자리가 없어야 저장되지 않는다 — 칸 하나가 생기면 그날부터 받을 수 있다",
    find: "  suspended_at      INTEGER\n);",
    replace: "  suspended_at      INTEGER,\n  email             TEXT\n);",
  },
  {
    id: "M67", file: "worker/index.js", suite: "test-signup",
    what: "제공자가 준 이메일을 계정 행에 함께 저장한다",
    invariant: "제공자 응답에서 회원 식별 번호 말고는 아무것도 영속화하지 않는다",
    find: "      .bind(id, provider, subject, now),",
    replace: '      .bind(id, provider, subject + "|leak@example.com", now),',
  },
  {
    id: "D28", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "방침에서 개인정보 보호책임자 성명 행을 지운다",
    invariant: "처리자와 보호책임자를 방침에 표기한다(제30조 제1항 제6호 기재사항)",
    find: "      <tr><th>개인정보 보호책임자</th><td>배성욱</td></tr>\n",
    replace: "",
  },
  {
    id: "D29", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "문의 주소를 실재하지 않는 예시 주소로 바꾼다",
    invariant: "공개 정책에 가짜·플레이스홀더 주소를 넣지 않는다 — 도착하지 않는 주소는 「연락할 수 있다」를 거짓으로 만든다",
    transform: (src) => src.replaceAll("qotjddnr9788@gmail.com", "privacy@example.com"),
  },
  {
    id: "D30", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "APAC 을 실제 저장 국가로 단정한다",
    invariant: "APAC 은 국가도 관할권도 아니다 — 확인하지 못한 것을 확인한 것처럼 적지 않는다",
    find: "<b>APAC(아시아·태평양)</b> 이라고 표시하며, 이는 <b>국가가 아니라 지역 이름</b>입니다.",
    replace: "<b>APAC(아시아·태평양)</b> 이며, 데이터는 APAC 에 저장됩니다.",
  },
  {
    id: "D31", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "백업 사본이 정확히 제때 지워진다고 단정한다",
    invariant: "R2 는 만료 표시 뒤 실제 삭제까지 통상 24시간이 더 걸릴 수 있다 — 우리가 정하지 못하는 시점을 보장하지 않는다",
    find: "통상 하루 정도가 더 걸릴 수 있다",
    replace: "즉시 지워진다",
  },
  {
    id: "D32", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "Turnstile 을 「활성화 완료」로 적는다",
    invariant: "widget·시크릿·운영 호스트 검증·실브라우저가 하나도 안 됐다 — 로컬 준비를 활성화로 승격하지 않는다",
    find: "| 16 | **Turnstile 위젯 생성·등록** | ❌ **미구성(결정 3).**",
    replace: "| 16 | **Turnstile 위젯 생성·등록** | ✅ Turnstile 활성화 완료.",
  },
  {
    id: "D33", file: "docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md", suite: "test-docs", kind: "정적",
    what: "요금제를 사용자 선언에서 원격 확인으로 승격한다",
    invariant: "사용자 확인과 원격 대시보드 검증은 다른 사실이다 — 섞으면 확인하지 않은 것을 확인했다고 말하게 된다",
    find: "| **사용자 확인** | **Workers Free 사용 중** (사용자 선언 · 2026-08-26) |",
    replace: "| **사용자 확인** | 요금제는 대시보드에서 확인했다 |",
  },
  {
    id: "D34", file: "docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md", suite: "test-docs", kind: "정적",
    what: "백업 주기를 「매일 백업한다」로 되돌린다",
    invariant: "백업은 migration 직전에만 만든다 — 방침이 그 사실을 적고 있어 문서가 갈리면 방침이 거짓이 된다",
    find: "| 정기 백업 | **하지 않는다**(매일 백업 없음) |",
    replace: "| 정기 백업 | 매일 백업한다 |",
  },
  {
    id: "D35", file: "docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md", suite: "test-docs", kind: "정적",
    what: "§24-5 백업 절 자체를 없앤다",
    invariant: "결정이 문서에서 사라지면 그것을 지키는 금지 목록이 아무것도 안 재게 된다",
    find: "### 24-5. 백업",
    replace: "### 24-5x. 백업",
  },
  // ── 2026-08-26 권리 행사 · 백업 · 세대 대조 ───────────────────────────
  {
    id: "M68", file: "worker/index.js", suite: "test-rights",
    what: "내려받기에서 세션 확인 **둘 다** 없앤다",
    // ⚠️ **한 줄만 빼면 동치였다**(2026-08-26 실측). 아래 `if (!u)` 가 두 번째 자물쇠라
    //    `uid` 가 `null` 이어도 결국 401 이었다 — 그래서 둘을 함께 뺀다. 자물쇠가 둘인 것은
    //    좋은 일이고, 여기서 재려는 것은 **둘 다 없으면 열리나**다.
    invariant: "개인정보 전문은 살아 있는 세션이 있을 때만 나간다",
    transform: (src) => src
      .replace('    if (path === "/me/export" && req.method === "GET") {\n'
             + '      if (!uid) return json(env, req, { error: "로그인이 필요해요" }, 401);',
               '    if (path === "/me/export" && req.method === "GET") {')
      .replace('      if (!u) return json(env, req, { error: "로그인이 필요해요" }, 401);',
               '      if (!u) return json(env, req, { 스키마: "shhh-export-1" }, 200);'),
  },
  {
    id: "M69", file: "worker/index.js", suite: "test-rights",
    what: "내려받기가 세션 uid 대신 요청이 준 uid 를 쓴다",
    invariant: "열람은 **세션이 말한 계정**만 본다 — 입력이 계정을 고르면 IDOR 다",
    find: '      const u = await env.DB.prepare(\n'
        + '        `SELECT provider, provider_subject, created_at, session_version, suspended_at\n'
        + '           FROM users WHERE id = ? AND {FENCE}`).bind(uid).first();',
    replace: '      const who2 = url.searchParams.get("uid") || uid;\n'
        + '      const u = await env.DB.prepare(\n'
        + '        `SELECT provider, provider_subject, created_at, session_version, suspended_at\n'
        + '           FROM users WHERE id = ? AND {FENCE}`).bind(who2).first();',
  },
  {
    id: "M70", file: "worker/index.js", suite: "test-rights",
    what: "정지 계정 차단을 없앤다",
    invariant: "정지된 계정은 서비스 처리를 받지 않는다 — 세션이 살아남은 경합에서도 막힌다",
    find: "    if (me && me.suspended && !suspendAllows(path, req.method))",
    replace: "    if (false && me && me.suspended && !suspendAllows(path, req.method))",
  },
  {
    id: "M71", file: "worker/index.js", suite: "test-rights",
    what: "처리정지가 **현재 세션만** 끊는다",
    invariant: "정지는 이 계정의 모든 기기를 끊는다 — 한 기기만 끊으면 정지가 이름뿐이다",
    find: "      `UPDATE users SET suspended_at = COALESCE(suspended_at, ?), session_version = session_version + 1\n"
        + "        WHERE id = ? AND {FENCE}`).bind(now, uid),",
    replace: "      `UPDATE users SET suspended_at = COALESCE(suspended_at, ?)\n"
        + "        WHERE id = ? AND {FENCE}`).bind(now, uid),",
  },
  {
    id: "M72", file: "worker/index.js", suite: "test-rights",
    what: "정지된 계정의 콜백이 그냥 로그인시킨다(자동 재개)",
    invariant: "OAuth 인증 성공만으로 처리가 재개되지 않는다 — 재개는 사용자가 명시적으로 고른다",
    find: "          if (su && su.s !== null && su.s !== undefined) {",
    replace: "          if (false && su && su.s !== null && su.s !== undefined) {",
  },
  {
    id: "M73", file: "worker/index.js", suite: "test-rights",
    what: "재개 티켓의 1회 소비를 없앤다",
    invariant: "재개 티켓은 1회용이다 — 재사용되면 사용자가 다시 정지한 계정을 남이 되살린다",
    find: "      try {\n        await consumeSignupState(env, await stateTombstone(env, raw), t.exp);\n"
        + "      } catch {\n        return failResume();\n      }",
    replace: "      try {\n        await consumeSignupState(env, await stateTombstone(env, raw), t.exp);\n"
        + "      } catch { /* 재사용 허용 */ }",
  },
  {
    id: "M74", file: "worker/index.js", suite: "test-rights",
    what: "재개가 제공자·회원번호를 다시 확인하지 않는다",
    invariant: "재개는 티켓이 가리키는 **그 제공자 계정**에만 듣는다",
    find: "      WHERE id = ? AND provider = ? AND provider_subject = ? AND suspended_at IS NOT NULL AND {FENCE}`)\n"
        + "    .bind(uid, provider, subject).run();",
    replace: "      WHERE id = ? AND suspended_at IS NOT NULL AND {FENCE}`)\n"
        + "    .bind(uid).run();",
  },
  {
    id: "M75", file: "js/authApi.js", suite: "test-client",
    what: "세대 대조를 항상 참으로 만든다",
    invariant: "화면 세대와 서버 세대가 다르면 계정 UI 를 닫는다",
    find: "  return typeof serverBuild === \"string\" && !!serverBuild && !!mine && mine === serverBuild;",
    replace: "  return true;",
  },
  {
    id: "M76", file: "js/authApi.js", suite: "test-client",
    what: "서버 세대가 없을 때를 「같다」로 읽는다",
    invariant: "모름은 「같다」가 아니다 — 값이 없거나 모양이 다르면 닫는 쪽이다",
    find: "  return typeof serverBuild === \"string\" && !!serverBuild && !!mine && mine === serverBuild;",
    replace: "  return !serverBuild || !mine || mine === serverBuild;",
  },
  {
    id: "M77", file: "js/friends.js", suite: "test-client",
    what: "초대 버튼이 세대 대조를 안 본다",
    invariant: "계정 판정 밖에 남는 화면 자리가 없어야 한다(정적 버튼이 그 무늬였다)",
    find: "    el(\"share-btn\").hidden = !authToken() || accountDown() || buildStale();",
    replace: "    el(\"share-btn\").hidden = !authToken() || accountDown();",
  },
  {
    id: "M78", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "삭제 표식을 **시간만 보고** 지운다(백업 조건 제거)",
    invariant: "표식은 되살릴 수 있는 원본이 남아 있는 동안 지우지 않는다",
    find: "     AND confirmed_at < ?2\n"
        + "     AND NOT EXISTS (SELECT 1 FROM backups b\n"
        + "                      WHERE ${BACKUP_BLOCKS_SQL} AND b.snapshot_at <= deletions.confirmed_at)`;",
    replace: "     AND ?2 IS NOT NULL`;",
  },
  {
    id: "M79", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "「객체가 있는지 모르는」 백업을 막지 않는 것으로 친다",
    invariant: "모름은 삭제 허가가 아니다 — `aborted` 만이 「객체가 없음을 확인했다」이다",
    find: '  "b.deleted_at IS NULL AND b.status <> \'aborted\'";',
    replace: '  "b.status = \'ready\' AND b.deleted_at IS NULL";',
  },
  {
    id: "M80", file: "worker/ledger.js", suite: "test-deletion-ledger",
    what: "요금제를 모를 때 **가장 짧은** 복원 창을 쓴다",
    invariant: "설정을 빠뜨린 배포가 표식을 더 일찍 지우게 되면 안 된다",
    find: "  return (d === undefined ? 30 : d) * 86400e3;",
    replace: "  return (d === undefined ? 7 : d) * 86400e3;",
  },
  {
    id: "M81", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "정리 크론이 복원 창 인자에 `now` 를 두 번 넣는다",
    invariant: "`?1`·`?2` 는 다른 값이다 — 같으면 복원 창 조건이 통째로 무력해진다",
    find: "   (env, now) => [now, sweepCutoff(env, now)]],",
    replace: "   (env, now) => [now, now]],",
  },
  {
    id: "M82", file: "scripts/backup.mjs", suite: "test-backup",
    what: "설정이 없어도 백업을 진행한다",
    invariant: "원격 구성이 없으면 백업은 **실패**다 — 「건너뛴 것」이 아니다",
    find: "  if (miss.length) {\n"
        + "    // ⛔ **fail-closed.** 설정이 없으면 백업이 「건너뛴 것」이 아니라 「실패한 것」이다.\n"
        + "    log(`백업 설정이 없다: ${miss.join(\", \")}`);\n"
        + "    return { ok: false, step: \"config\", code: \"config\", missing: miss };\n  }",
    replace: "  if (miss.length) log(`백업 설정이 없다: ${miss.join(\", \")}`);",
  },
  {
    id: "M83", file: "scripts/backup.mjs", suite: "test-backup",
    what: "업로드 검증 실패를 무시하고 ready 로 적는다",
    invariant: "되읽어 확인하기 전에는 `ready` 가 아니다",
    find: '    if (got !== "present") return await fail("upload_verify", "upload_verify");',
    replace: '    if (got !== "present") { /* 무시 */ }',
  },
  {
    id: "M84", file: "scripts/backup.mjs", suite: "test-backup",
    what: "필수 표 검증을 없앤다",
    invariant: "빈 덤프·표가 빠진 덤프를 백업이라 부르지 않는다",
    find: "      for (const tbl of REQUIRED_TABLES[which]) {\n"
        + "        if (!new RegExp(`CREATE TABLE[^;]*\\\\b${tbl}\\\\b`, \"i\").test(text))\n"
        + "          return await abort(\"verify\", \"verify\");\n      }",
    replace: "      void text;",
  },
  {
    id: "M85", file: "scripts/backup.mjs", suite: "test-backup",
    what: "inventory 상태를 못 읽어도 migration 게이트를 연다",
    invariant: "「모른다」는 「백업이 있다」가 아니다",
    find: '  } catch { log("백업 상태를 못 읽었다"); return { ok: false, code: "unreadable" }; }',
    replace: '  } catch { return { ok: true, code: "unreadable" }; }',
  },
  {
    id: "M86", file: "scripts/backup.mjs", suite: "test-backup",
    what: "dry-run 에서도 원격에 기록한다",
    invariant: "dry-run 은 원격 쓰기 0건이다",
    find: "    if (!dryRun) {\n      try { await inv.insertPending(id, now); }",
    replace: "    if (true) {\n      try { await inv.insertPending(id, now); }",
  },
  {
    id: "D36", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "「로그아웃하면 처리가 멈춘다」를 되살린다",
    invariant: "로그아웃은 세션만 끊는다 — 계정·단어장·친구 관계·가입 기록은 그대로다",
    find: "⚠️ <b>로그아웃은 처리정지가 아닙니다.</b>",
    replace: "<b>로그아웃하시면 그 시점부터 계정 관련 처리가 멈춥니다.</b>",
  },
  {
    id: "D37", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "이메일만으로 계정을 처리해 준다고 되돌린다",
    invariant: "이메일은 계정 소유의 증명이 아니다 — 우리는 이메일을 받지도 저장하지도 않는다",
    find: "<b>이메일만으로는 계정 정보를 알려 드리거나, 지우거나, 정지를 풀어 드릴 수 없습니다.</b>",
    replace: "<b>이메일로 요청하시면 계정 정보를 알려 드리거나 지워 드립니다.</b>",
  },
  {
    id: "D38", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "아직 없는 백업을 운영 중이라고 적는다",
    invariant: "구현이 없는 것을 방침에 현재형으로 적지 않는다",
    find: "<b>백업 사본은 지금 운영하고 있지 않습니다.</b>",
    replace: "<b>백업 사본을 운영하고 있습니다.</b>",
  },
  {
    id: "D39", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "15일을 삭제일로 단정한다",
    invariant: "15일은 최소 보유기간이고, 되살릴 원본이 남아 있으면 더 오래 보관한다",
    find: "여기서 <b>15일은 「최소」이지\n       「그날 지운다」가 아닙니다.</b>",
    replace: "표식은 <b>15일째에 지워집니다.</b>",
  },
  {
    id: "D40", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "비회원에게는 기기 단어장도 안 생긴다고 적는다",
    invariant: "로그인하지 않아도 이 기기의 로컬 저장소에는 단어장이 만들어진다",
    find: "<b>① 이 기기 안에는 단어장이 만들어집니다.</b>",
    replace: "<b>① 이 기기에도 아무것도 남지 않습니다.</b>",
  },
  {
    id: "M87", file: "worker/index.js", suite: "test-rights",
    what: "정지된 친구의 별명·단어 개수를 그대로 실어 보낸다",
    invariant: "처리정지는 **친구의 화면에서도** 그 사람의 값을 멈춘다 — 그 값을 나르는 것은 친구의 요청이다",
    find: "            CASE WHEN o.suspended_at IS NULL THEN b.nickname ELSE NULL END AS name,\n"
        + "            CASE WHEN o.suspended_at IS NULL THEN b.words    ELSE NULL END AS words",
    replace: "            b.nickname AS name, b.words AS words",
  },
  {
    id: "M88", file: "worker/index.js", suite: "test-rights",
    what: "정지된 친구의 단어장을 그대로 열어 준다",
    invariant: "정지된 사람의 단어장은 친구에게도 열리지 않는다",
    find: "               JOIN users o ON o.id = ?2 AND o.suspended_at IS NULL\n",
    replace: "",
  },
  // ── 2026-08-27 K1 · 사용자 단위 fencing (위협 79) ─────────────────────
  {
    id: "M89", file: "worker/fence.js", suite: "test-actor-fence",
    what: "행위자 술어를 통째로 끈다",
    invariant: "정지·로그아웃·탈퇴가 끝난 뒤에는 그보다 먼저 인증된 요청도 사용자 데이터를 만질 수 없다",
    find: "  const actor = withActor && !only;",
    replace: "  const actor = false;",
  },
  {
    id: "M90", file: "worker/fence.js", suite: "test-actor-fence",
    what: "행위자 술어에서 「정지되지 않았다」를 뺀다",
    invariant: "처리정지는 **문장 안에서** 막힌다 — 요청 초입의 한 번 조회는 TOCTOU 라 방어가 아니다",
    find: "WHERE id = ${u} AND suspended_at IS NULL AND session_version = ${g})",
    replace: "WHERE id = ${u} AND (suspended_at IS NULL OR 1 = 1) AND session_version = ${g})",
  },
  {
    id: "M91", file: "worker/fence.js", suite: "test-actor-fence",
    what: "행위자 술어에서 「인증 당시 세대」를 뺀다",
    invariant: "모든 기기 로그아웃과 탈퇴가 끝난 뒤에는 옛 요청이 쓰지 못한다",
    find: "AND suspended_at IS NULL AND session_version = ${g})",
    replace: "AND suspended_at IS NULL AND (session_version = ${g} OR 1 = 1))",
  },
  {
    id: "M92", file: "worker/index.js", suite: "test-actor-fence",
    what: "요청에 행위자를 결속하지 않는다",
    invariant: "인증을 통과한 요청은 그 뒤의 모든 주 D1 문장에 자기 계정 술어를 들고 나간다",
    find: "    if (me) bindActor(env, me);",
    replace: "    if (me && false) bindActor(env, me);",
  },
  {
    id: "M93", file: "worker/fence.js", suite: "test-actor-fence",
    what: "0행을 「정상」으로만 읽고 행위자 소멸을 안 던진다",
    invariant: "행위자가 사라진 뒤의 0행은 정상 결과가 아니다 — 화면이 빈 응답을 진짜 답으로 받는다",
    find: '  if (u && u.s !== null && u.s !== undefined) throw new ActorGone("suspended");',
    replace: '  if (u && u.s !== null && u.s !== undefined) return;',
  },
  {
    id: "M94", file: "worker/index.js", suite: "test-rights",
    what: "세션 철거에도 행위자 술어를 건다",
    invariant: "정지된 계정에게 **로그아웃 하나는 열려 있어야 한다** — 스스로 끝낼 길이 없으면 갇힌다",
    find: 'env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND {FENCE_ONLY}").bind(uid),\n    env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ? AND {FENCE_ONLY}").bind(uid),',
    replace: 'env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND {FENCE}").bind(uid),\n    env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ? AND {FENCE}").bind(uid),',
  },
  {
    id: "M95", file: "worker/index.js", suite: "test-actor-fence",
    what: "탈퇴 문장에서 행위자 술어를 뺀다",
    invariant: "정지된 계정은 옛 요청으로도 지워지지 않는다 — 탈퇴는 되돌릴 수 없다",
    find: '            await env.DB.prepare("DELETE FROM users WHERE id = ? AND {FENCE}").bind(uid).run();',
    replace: '            await env.DB.prepare("DELETE FROM users WHERE id = ? AND {FENCE_ONLY}").bind(uid).run();',
  },

  // ── 2026-08-27 K2 · 백업 상태 머신 (위협 81) ───────────────────────────
  {
    id: "M96", file: "scripts/backup.mjs", suite: "test-backup",
    what: "정지 확인 결과를 무시하고 export 를 시작한다",
    invariant: "두 DB export 전에 쓰기가 멈춘 것을 확인한다 — 안 하면 백업 안에서 두 DB 가 다른 시점을 가리킨다",
    find: "  if (!q.ok) {",
    replace: "  if (false && !q.ok) {",
  },
  {
    id: "M97", file: "scripts/backup.mjs", suite: "test-backup",
    what: "살아 있는 임차증이 있어도 정지로 본다",
    invariant: "진행 중인 요청이 하나라도 있으면 백업하지 않는다",
    find: '  if (Number(leases.n) !== 0) return { ok: false, why: "live_lease" };',
    replace: "",
  },
  {
    id: "M98", file: "scripts/backup.mjs", suite: "test-backup",
    what: "정지 상태를 못 읽어도 진행한다",
    invariant: "「질의가 실패했다」는 「멈췄다」가 아니다 — 모르면 시작하지 않는다",
    find: '  } catch { return { ok: false, why: "unreadable" }; }',
    replace: "  } catch { return { ok: true, why: \"unreadable\" }; }",
  },
  {
    id: "M99", file: "scripts/backup.mjs", suite: "test-backup",
    what: "업로드 전 확실한 실패도 `failed`(모른다) 로 적는다",
    invariant: "객체가 없다는 것을 아는 실패는 `aborted` 다 — `failed` 로 적으면 그 행이 영영 표식 정리를 막는다",
    find: "      if (r.code !== 0) return await abort(`${which}_export`, `${which}_export`);",
    replace: "      if (r.code !== 0) return await fail(`${which}_export`, `${which}_export`);",
  },
  {
    id: "M100", file: "scripts/backup.mjs", suite: "test-backup",
    what: "R2 조회 실패를 「없다」로 읽는다",
    invariant: "조회 실패는 부재의 증거가 아니다 — 그렇게 읽으면 근거 없이 삭제 표식이 지워진다",
    find: '  return "unknown";',
    replace: '  return "absent";',
  },
  {
    id: "M101", file: "scripts/backup.mjs", suite: "test-backup",
    what: "되읽은 객체의 크기·해시를 대조하지 않는다",
    invariant: "업로드는 **되읽어 같은 것임을 확인한 뒤에만** ready 다",
    find: "    if ((await stat(back)).size !== encBytes || (await sha256File(back)) !== encHash)\n      return await fail(\"upload_verify\", \"upload_verify\");",
    replace: "",
  },
  {
    id: "M102", file: "scripts/backup.mjs", suite: "test-backup",
    what: "reconcile 이 모르는 행도 닫는다",
    invariant: "부재를 확인하지 못한 행은 계속 표식 정리를 막는다",
    find: '      if (state === "unknown") {',
    replace: '      if (false && state === "unknown") {',
  },
  {
    id: "M103", file: "scripts/backup.mjs", suite: "test-backup",
    what: "reconcile 이 내용 불일치를 정상으로 본다",
    invariant: "키가 같은 다른 내용은 복구에 쓸 수 없다 — 정상으로 읽으면 못 쓰는 사본을 믿게 된다",
    find: "        if (!same) {",
    replace: "        if (false && !same) {",
  },
  {
    id: "M104", file: "scripts/backup.mjs", suite: "test-backup",
    what: "전이표를 무시하고 어느 상태에서든 옮긴다",
    invariant: "종결 상태(`deleted`·`aborted`)는 되살아나지 않는다",
    find: "export const canTransition = (from, to) =>\n  Object.prototype.hasOwnProperty.call(NEXT, from) && NEXT[from].includes(to);",
    replace: "export const canTransition = () => true;",
  },
  {
    id: "M105", file: "scripts/backup.mjs", suite: "test-backup",
    what: "만료 예정이 한참 지나도 경보하지 않는다",
    invariant: "만료 표시 뒤에도 남아 있는 객체는 비정상이고 사람이 봐야 한다",
    find: "      if (r.expires_expected_at && now > Number(r.expires_expected_at) + OVERDUE_GRACE) {",
    replace: "      if (false && r.expires_expected_at && now > Number(r.expires_expected_at) + OVERDUE_GRACE) {",
  },

  // ── 2026-08-27 K3 · 서버 강제 클라이언트 호환성 (위협 80) ───────────────
  {
    id: "M106", file: "worker/index.js", suite: "test-compat",
    what: "빌드 계약을 검사하지 않는다",
    invariant: "지원되지 않는 옛 클라이언트는 인증·제공자 호출·DB 접근 전에 서버가 거절한다",
    find: "      if (claimed !== BUILD_ID) {",
    replace: "      if (false && claimed !== BUILD_ID) {",
  },
  {
    id: "M107", file: "worker/index.js", suite: "test-compat",
    what: "계약이 **없는** 요청은 통과시킨다(모르면 연다)",
    invariant: "빠진 값을 「모르니 통과」로 읽지 않는다 — 그것이 정확히 옛 클라이언트의 모양이다",
    find: "      if (claimed !== BUILD_ID) {",
    replace: "      if (claimed != null && claimed !== BUILD_ID) {",
  },
  {
    id: "M108", file: "worker/index.js", suite: "test-compat",
    what: "로그인 시작에는 계약을 안 건다",
    invariant: "최상위 이동도 계약을 나른다 — 안 걸면 옛 화면이 제공자까지 갔다가 콜백에서 죽는다",
    find: '    if (rt.compat === "header" || rt.compat === "query") {',
    replace: '    if (rt.compat === "header") {',
  },
  {
    id: "M109", file: "worker/index.js", suite: "test-compat",
    what: "콜백이 state 안의 빌드를 안 본다",
    invariant: "제공자 호출 **앞에서** 대조한다 — 뒤에 두면 옛 화면 하나가 `code` 를 태운다",
    find: "        if (st.b !== BUILD_ID)",
    replace: "        if (false && st.b !== BUILD_ID)",
  },
  {
    id: "M110", file: "js/authApi.js", suite: "test-client",
    what: "화면이 계정 요청에 세대를 안 싣는다",
    invariant: "계정 API 호출은 전부 한 자리에서 세대를 싣는다 — 한 곳만 빠져도 그 기능이 426 으로 죽는다",
    find: "  return b ? { [BUILD_HEADER]: b } : {};",
    replace: "  return b ? {} : {};",
  },
  {
    id: "M111", file: "js/authApi.js", suite: "test-client",
    what: "로그인 시작 주소에서 세대를 뺀다",
    invariant: "로그인 시작은 쿼리로 계약을 나른다",
    find: '  + `&b=${encodeURIComponent(clientBuild() || "")}`;',
    replace: "  ;",
  },
  {
    id: "M112", file: "js/authApi.js", suite: "test-client",
    what: "426 을 평범한 서버 오류로 읽는다",
    invariant: "426 은 로그아웃이 아니라 갱신 안내다 — 표시를 지우면 이유 없는 로그아웃으로 보인다",
    find: "  if (res.status === 426) {\n    setAccountState(\"ok\");\n    setBuildOk(false);\n    return { ok: false, status: 426, kind: \"outdated\", data: null };\n  }",
    replace: "",
  },

  {
    id: "M113", file: "worker/fence.js", suite: "test-fence",
    what: "`{FENCE_ONLY}` 를 아무것도 안 붙는 자리표시자로 만든다",
    invariant: "예외가 빼는 것은 **행위자 술어뿐**이다 — 유지보수 fence 까지 빠지면 그 문장은 전환 뒤에도 쓴다",
    find: "    let pred = fenceSql(slot(at));",
    replace: '    let pred = only ? "1 = 1" : fenceSql(slot(at));',
  },
  // ── 2026-08-27 독립 검토 반영 ──────────────────────────────────────────
  {
    id: "M114", file: "worker/fence.js", suite: "test-actor-fence",
    what: "한 batch 안에서 자리표시자를 섞는 것을 허용한다",
    invariant: "batch 의 판별(하나라도 바뀌었으면 통과)은 **문장이 같은 술어를 들 때만** 참이다 — 섞으면 실패한 작업이 성공으로 보고된다",
    find: "  if (new Set(marks).size > 1)",
    replace: "  if (false && new Set(marks).size > 1)",
  },
  {
    id: "M115", file: "worker/index.js", suite: "test-actor-fence",
    what: "정지 batch 의 세션 삭제를 다시 `{FENCE_ONLY}` 로 되돌린다",
    invariant: "정지는 **전부 되거나 전부 안 된다** — 세션만 지워지고 정지는 안 된 상태가 있으면 안 된다",
    find: '      "DELETE FROM sessions WHERE user_id = ? AND {FENCE}").bind(uid),\n    env.DB.prepare(\n      `UPDATE users SET suspended_at',
    replace: '      "DELETE FROM sessions WHERE user_id = ? AND {FENCE_ONLY}").bind(uid),\n    env.DB.prepare(\n      `UPDATE users SET suspended_at',
  },
  {
    id: "M116", file: "scripts/backup.mjs", suite: "test-backup",
    what: "부재 판정을 다시 넓게 잡는다(버킷 오류·일반 404 도 「없다」)",
    invariant: "부재의 증거는 **객체 수준**이어야 한다 — 설정 오타 하나로 삭제 표식이 근거 없이 지워진다",
    find: "const ABSENT_RE = /\\b10007\\b|no such key|specified key does not exist/i;",
    replace: "const ABSENT_RE = /does not exist|not\\s*found|no such key|10007|404/i;",
  },
  {
    id: "M117", file: "scripts/backup.mjs", suite: "test-backup",
    what: "export 뒤의 정지 재확인을 없앤다",
    invariant: "검사와 사용이 같은 경계에 있어야 한다 — 두 export 사이에 문이 다시 열리면 두 덤프가 다른 시점을 담는다",
    find: "      const q2 = await quiescence({ cfg, run });\n      if (!q2.ok || q2.epoch !== q.epoch) {",
    replace: "      const q2 = { ok: true, epoch: q.epoch };\n      if (!q2.ok || q2.epoch !== q.epoch) {",
  },
  {
    id: "M118", file: "worker/index.js", suite: "test-compat",
    what: "계약 헤더를 CORS 허용 목록에서 뺀다",
    invariant: "커스텀 헤더는 preflight 를 만든다 — 허용 목록에 없으면 다른 origin 에서 계정 기능이 통째로 죽는다",
    find: '"Access-Control-Allow-Headers": "Authorization,Content-Type,X-Shh-Build"',
    replace: '"Access-Control-Allow-Headers": "Authorization,Content-Type"',
  },

  // ── 2026-08-27 K4 · 방침이 코드와 같은 말을 하나 ────────────────────────
  {
    id: "D41", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "로그아웃을 다시 「이 기기만」이라고 적는다",
    invariant: "로그아웃은 그 계정의 **모든 기기** 세션을 끊는다 — 방침이 기기 하나로 적으면 거짓이다",
    find: "로그아웃은 <b>지금 로그인돼 있는 모든 기기의 접속을\n       한꺼번에 끝내는 것</b>이고(저희는 기기별로 따로 끊지 않습니다),",
    replace: "로그아웃은 <b>이 기기의 접속을 끝내는 것</b>이고,",
  },
  {
    id: "D42", file: "policies-src/summary.txt", suite: "test-policies", kind: "정적",
    what: "요약에서도 로그아웃을 「이 기기만」으로 되돌린다",
    invariant: "요약과 본문이 같은 사실을 말한다 — 한쪽만 고치면 문서가 스스로 모순이 된다",
    find: "  로그아웃은 로그인돼 있는 모든 기기의 접속을 한꺼번에 끝내는 것일 뿐,\n  처리정지도 삭제도 아닙니다. 기기 안에 담긴 단어장은 그대로 남습니다.",
    replace: "  로그아웃은 이 기기의 접속을 끝내는 것일 뿐, 처리정지도 삭제도 아닙니다.",
  },
  {
    id: "D43", file: "privacy.html", suite: "test-policies", kind: "정적",
    what: "한 줄 요약에서 「단어장도 안 만든다」를 서버 한정 없이 되돌린다",
    invariant: "비회원도 **기기 안에는** 단어장을 만든다 — 서버로 한정하지 않은 문장은 거짓이다",
    find: "— <b>저희 서버에는</b> 계정도 단어장도 별명도 만들지 않기 때문입니다.",
    replace: "— 계정도, 단어장도, 별명도 만들지 않기 때문입니다.",
  },
];
