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
    find: "기준 설계는 3단계 설계 11판",
    replace: "기준 설계는 3단계 설계 10판",
  },
  {
    id: "D07", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "재감사 결함 합계와 위협 범위를 22건 · 39~60 으로 되돌린다",
    invariant: "결함 합계와 위협 범위는 설계서의 위협 표에서 파생된다 — 낡은 숫자는 「이미 다 봤다」는 착각을 만든다",
    find: "차례로 재현했다(위협 **39~94**)",
    replace: "차례로 재현했다(위협 39~60)",
  },
  {
    id: "D08", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "재현 범위 문장의 위협 최대를 낡은 60 으로 되돌린다(같은 줄의 다른 문형)",
    invariant: "범위를 말하는 문형이 둘이면 **둘 다** 위협 표에서 파생돼야 한다 — 하나만 고치면 같은 줄이 서로 다른 말을 한다",
    find: "**위협 39~94 전부**를",
    replace: "**위협 39~60 전부**를",
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
    find: "`scripts/mutations.mjs`(목록 269종",
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
    find: "**114건 전부 실행 가능한 단언으로 연결됐다.**",
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
    id: "D21", file: "docs/SECURITY_RELEASE_CHECKLIST.md", suite: "test-docs", kind: "정적",
    what: "「종」이 없는 괄호형 내역을 낡은 「정적 21」로 되돌린다",
    invariant: "총계뿐 아니라 **하위 내역**도 MUTATIONS 에서 파생한다 — 「N종」이라고 안 적은 괄호형 내역도 센다(총계만 보면 66 ≠ 40+21 이 남는다)",
    find: "목록 269종 — **동작 209종 · 정적 60종**",
    replace: "목록 188종 — **동작 40종 · 정적 21종**",
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
    find: '  catch { log("백업 상태를 못 읽었다"); return { ok: false, code: "unreadable" }; }',
    replace: '  catch { return { ok: true, code: "unreadable" }; }',
  },
  {
    id: "M86", file: "scripts/backup.mjs", suite: "test-backup",
    what: "dry-run 에서도 원격에 기록한다",
    invariant: "dry-run 은 원격 쓰기 0건이다",
    find: "    if (!dryRun) {\n      try { await inv.insertPending(id, now, q.epoch, k.fingerprint); }",
    replace: "    if (true) {\n      try { await inv.insertPending(id, now, q.epoch, k.fingerprint); }",
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
    find: "  const q = await quiescence({ cfg, run });\n  if (!q.ok) {\n    log(`두 DB 가 멈춘 상태가 아니다: ${q.why}`);",
    replace: "  const q = await quiescence({ cfg, run });\n  if (false && !q.ok) {\n    log(`두 DB 가 멈춘 상태가 아니다: ${q.why}`);",
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
    find: "export const canTransition = backupCanTransition;",
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
  // ── 2026-08-27 K1 · 세션 발급 경합 (위협 82) ───────────────────────────
  {
    id: "M119", file: "worker/index.js", suite: "test-actor-fence",
    what: "세션 발급 문장에서 「정지되지 않았다」를 뺀다",
    invariant: "정지가 끝난 뒤에 도착한 콜백은 세션을 만들 수 없다 — 만들면 재개하는 순간 그 기기가 살아난다",
    find: "      WHERE id = ? AND suspended_at IS NULL AND session_version = COALESCE(?, session_version)",
    replace: "      WHERE id = ? AND session_version = COALESCE(?, session_version)",
  },
  {
    id: "M120", file: "worker/index.js", suite: "test-actor-fence",
    what: "세션 발급 문장에서 자격 확인 시점의 세대 비교를 뺀다",
    invariant: "로그아웃이 끝난 뒤에 도착한 콜백은 세션을 만들 수 없다",
    find: "session_version = COALESCE(?, session_version)",
    replace: "session_version = session_version AND ? IS NOT ?",
  },
  {
    id: "M121", file: "worker/index.js", suite: "test-friends",
    what: "세션 발급 문장에서 fence 를 뺀다",
    invariant: "세션 발급도 유지보수 세대를 지난다 — 전환 뒤의 발급은 0행이어야 한다",
    find: "COALESCE(?, session_version)\n        AND {FENCE}`)",
    replace: "COALESCE(?, session_version)`)",
  },
  {
    id: "M122", file: "worker/index.js", suite: "test-actor-fence",
    what: "0행 발급을 성공으로 읽는다 (changes === 1 검사 제거)",
    invariant: "0행은 성공이 아니다 — 통과시키면 없는 세션을 쿠키로 심고 화면은 로그인됐다고 말한다",
    find: "  if (!(ins.meta && ins.meta.changes === 1)) throw new SessionRace();",
    replace: "  void ins;",
  },
  {
    id: "M123", file: "worker/index.js", suite: "test-actor-fence",
    what: "콜백이 자격 확인 시점의 세대를 안 넘긴다",
    invariant: "발급 문장이 요구하는 「그 시점」을 부르는 쪽이 실제로 넘겨야 한다",
    find: "          token = await newSession(env, uid, elig ? Number(elig.gen) : null);",
    replace: "          token = await newSession(env, uid, null);",
  },

  // ── 2026-08-27 K3 · 옛 PWA 가 읽을 수 있는 화면 (위협 83) ───────────────
  {
    id: "M124", file: "worker/index.js", suite: "test-compat",
    what: "로그인 시작의 426 을 다시 text/plain 한 줄로 돌린다",
    invariant: "top-level navigation 에서 옛 클라이언트가 보는 것은 사람이 읽고 행동할 수 있는 화면이어야 한다",
    find: "          ? updatePage(env, \"로그인을\")\n          : json(env, req, { error: msg, updateRequired: true, build: BUILD_ID }, 426);",
    replace: "          ? new Response(msg, { status: 426, headers: { ...SEC, \"Content-Type\": \"text/plain; charset=utf-8\" } })\n          : json(env, req, { error: msg, updateRequired: true, build: BUILD_ID }, 426);",
  },
  {
    id: "M125", file: "worker/index.js", suite: "test-compat",
    what: "콜백 세대 불일치를 다시 조각 redirect 로 돌린다",
    invariant: "옛 세대에는 `#login=outdated` 를 읽을 코드가 없다 — 사용자에게는 빈 화면이다",
    find: "          return isNavPath(path)\n            ? updatePage(env, \"로그인을\")",
    replace: "          return false\n            ? updatePage(env, \"로그인을\")",
  },
  {
    id: "M126", file: "worker/index.js", suite: "test-compat",
    what: "안내 화면에 자동 새로고침을 넣는다",
    invariant: "옛 PWA 는 옛 캐시를 다시 읽는다 — 자동 새로고침은 고리가 된다",
    find: "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    replace: "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta http-equiv=\"refresh\" content=\"3\">",
  },
  {
    id: "M127", file: "worker/index.js", suite: "test-compat",
    what: "안내 화면이 최신 앱 주소를 안 싣는다",
    invariant: "사용자가 그 화면에서 할 수 있는 일이 하나는 있어야 한다",
    find: "<a class=\"go\" href=\"${home}/\">최신 화면 열기</a>",
    replace: "<span class=\"go\">앱을 다시 열어 주세요</span>",
  },

  {
    id: "M144", file: "worker/index.js", suite: "test-compat",
    what: "안내 화면이 APP_ORIGIN 을 모를 때 null 을 그대로 쓴다",
    invariant: "이 화면의 유일한 쓸모가 링크 하나다 — `null/` 은 누를 수는 있는데 아무 데도 안 간다",
    find: '  const home = appOrigin(env) || "";',
    replace: "  const home = appOrigin(env);",
  },

  // ── 2026-08-27 K2 · 백업의 복원 가능성 증명 (위협 84) ───────────────────
  {
    id: "M128", file: "scripts/backup.mjs", suite: "test-backup",
    what: "게이트가 지정된 backup_id 없이도 진행한다",
    invariant: "migration 을 막는 근거는 운영자가 지목한 그 백업이다 — 자동 선택은 승인이 아니다",
    find: "  if (!HEX32.test(String(backupId || \"\"))) {\n    log(\"검증할 backup_id 를 지정해야 한다\");\n    return { ok: false, code: \"no_backup_id\" };\n  }",
    replace: "  if (!HEX32.test(String(backupId || \"\"))) backupId = String(backupId || \"\");",
  },
  {
    id: "M129", file: "scripts/backup.mjs", suite: "test-backup",
    what: "게이트가 백업의 유지보수 세대를 안 본다",
    invariant: "이전 세대의 사본은 지금 상태의 복원본이 아니다 — 복원하면 그 뒤의 쓰기가 통째로 사라진다",
    find: "  if (Number(q.epoch) !== Number(row.maintenance_epoch)) {",
    replace: "  if (Number(q.epoch) === Number(q.epoch) && false) {",
  },
  {
    id: "M130", file: "scripts/backup.mjs", suite: "test-backup",
    what: "R2 에 객체가 실제로 있는지 확인하지 않는다",
    invariant: "「ready 라고 적혀 있다」는 「지금 그 객체가 있다」가 아니다",
    find: "    if (state !== \"present\") return bad(state === \"absent\" ? \"object_absent\" : \"object_unknown\");",
    replace: "    void state;",
  },
  {
    id: "M131", file: "scripts/backup.mjs", suite: "test-backup",
    what: "받아 온 객체의 크기·해시를 기록과 대조하지 않는다",
    invariant: "키가 같은 다른 내용도 R2 는 「있다」고 답한다",
    find: "    if ((await stat(dest)).size !== Number(row.object_bytes)) return bad(\"size_mismatch\");\n    if ((await sha256File(dest)) !== String(row.object_hash)) return bad(\"hash_mismatch\");",
    replace: "    void dest;",
  },
  {
    id: "M132", file: "scripts/backup.mjs", suite: "test-backup",
    what: "복호화 실패를 통과시킨다",
    invariant: "AES-GCM 태그가 맞아야 그 사본을 우리가 열 수 있다는 증명이 된다",
    find: "    if (parts.code) return bad(parts.code === \"decrypt\" ? \"decrypt\" : \"shape\");",
    replace: "    if (parts.code) return { ok: true, code: \"verified\", receipt: { backupId } };",
  },
  {
    id: "M133", file: "scripts/backup.mjs", suite: "test-backup",
    what: "임시 SQLite 적재 검증을 없앤다",
    invariant: "크기·해시가 맞아도 그 안에 DB 가 들어 있다는 뜻은 아니다 — 실어 봐야 안다",
    find: "      const r = await loadTemp(parts[which].toString(\"utf8\"), which);\n      if (!r.ok) return bad(\"load_\" + which, { missing: r.missing });",
    replace: "      void which;",
  },
  {
    id: "M134", file: "scripts/backup.mjs", suite: "test-backup",
    what: "필수 ledger 표 목록에서 transitions 를 뺀다",
    invariant: "`transitions` 가 없으면 유지보수 전환이 재개되지 않는다 — 반쪽 복구다",
    find: "\"rate_limits\", \"transitions\", \"lease_resolutions\", \"backups\"],",
    replace: "\"rate_limits\", \"lease_resolutions\", \"backups\"],",
  },
  {
    id: "M135", file: "scripts/backup.mjs", suite: "test-backup",
    what: "키 지문 대조를 없앤다",
    invariant: "키를 갈아 끼운 뒤의 옛 백업은 우리가 열 수 없다 — 「복원 가능」이라 부르면 안 된다",
    find: "  if (String(row.key_fingerprint) !== k.fingerprint) return bad(\"key_rotated\");",
    replace: "  void k.fingerprint;",
  },
  {
    id: "M136", file: "scripts/backup.mjs", suite: "test-backup",
    what: "상태 변경의 changes === 1 검사를 없앤다",
    invariant: "종료 코드 0 은 「문장이 돌았다」이지 「그 행이 바뀌었다」가 아니다",
    find: "    if (changed !== 1) throw new Error(`backup inventory: ${what} 가 ${changed}행을 바꿨다`);",
    replace: "    void changed; void what;",
  },

  {
    id: "M146", file: "scripts/backup.mjs", suite: "test-backup",
    what: "게이트가 지금도 멈춰 있는지 확인하지 않는다",
    invariant: "백업이 만들어진 뒤에 문이 다시 열렸으면 그 사본은 지금 상태의 복원본이 아니다",
    find: "  if (!q.ok) { log(`두 DB 가 멈춘 상태가 아니다: ${q.why}`); return { ok: false, code: \"quiescence\", why: q.why }; }",
    replace: "  void q.ok;",
  },

  // ── 2026-08-27 K2-D · 자동 inventory reconciliation (위협 85) ───────────
  {
    id: "M137", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "정리 크론이 백업 inventory 를 맞추지 않는다",
    invariant: "아무도 물어보지 않으면 사라진 객체의 행이 영원히 삭제 표식을 막는다",
    find: "    const backups = await reconcileBackups(env, now);",
    replace: "    const backups = { scanned: 0, present: 0, gone: 0, unknown: 0, overdue: 0, failed: 0 };",
  },
  {
    id: "M138", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "사라진 객체를 발견해도 상태를 안 옮긴다",
    invariant: "부재를 확인했으면 그 행은 닫혀야 한다 — 안 닫으면 보유기간이 사실상 무한이 된다",
    find: "    if (head === null || head === undefined) {",
    replace: "    if (head === null && head !== null) {",
  },
  {
    id: "M139", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "조회 실패(모른다)를 부재로 읽는다",
    invariant: "「모른다」는 삭제 허가가 아니다 — 조회가 실패했다고 객체가 없는 것이 아니다",
    find: "    catch { out.unknown++; continue; }",
    replace: "    catch { head = null; }",
  },
  {
    id: "M140", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "reconciliation 의 실패·초과를 경보로 올리지 않는다",
    invariant: "일부 실패가 회차 전체를 성공으로 만들면 아무도 그 상태를 못 본다",
    find: "    if (backups.unknown || backups.overdue || backups.failed || backups.stuck)\n      throw new Error(\"backup reconcile incomplete\");",
    replace: "    void backups.unknown;",
  },
  {
    id: "M141", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "R2 바인딩이 없어도 조용히 넘어간다",
    invariant: "막는 행이 있는데 물어볼 수단이 없으면 그 사실이 경보로 올라가야 한다",
    find: "  if (!env.BACKUPS) throw new Error(\"backup reconcile: R2 binding missing\");",
    replace: "  if (!env.BACKUPS) return out;",
  },
  {
    id: "M142", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "부재 전이의 changes === 1 검사를 없앤다",
    invariant: "전이표가 막았거나 누가 그 사이에 옮겼는데 「했다」로 넘기지 않는다",
    find: "      if (!(upd.meta && upd.meta.changes === 1)) { out.failed++; continue; }\n      out.gone++;",
    replace: "      out.gone++;",
  },
  {
    id: "M143", file: "worker/cleanup/index.js", suite: "test-cleanup",
    what: "한 회차에 보는 행의 상한을 없앤다",
    invariant: "무료 크론의 CPU 는 10ms 다 — 상한이 없으면 매번 시간 초과로 아무것도 못 한다",
    find: "      ORDER BY backup_id LIMIT ?`).bind(from, limit).all()).results || [];",
    replace: "      ORDER BY backup_id`).bind(from).all()).results || [];",
  },

  {
    id: "M145", file: "worker/ledger.js", suite: "test-friends",
    what: "readiness 의 ledger 질의에서 신규 표 셋을 뺀다",
    invariant: "readiness 는 migration **전부**를 만져야 한다 — 반쯤 적용된 배포가 smoke test 를 통과하면 사용자의 첫 탈퇴에서 처음 드러난다",
    find: "            + (SELECT COUNT(*) FROM transitions WHERE state IS NOT NULL)\n"
        + "            + (SELECT COUNT(*) FROM lease_resolutions WHERE expires_keep IS NOT NULL)\n"
        + "            + (SELECT COUNT(*) FROM backups WHERE status IS NOT NULL) AS n`).first();",
    replace: " AS n`).first();",
  },

  {
    id: "M147", file: "migrations-ledger/0005_backup_inventory.sql", suite: "test-migrations",
    what: "ledger 이전에서 칸 하나를 빼 스키마 원본과 갈라 놓는다",
    invariant: "`migrations-ledger/` 와 `worker/ledger-schema.sql` 은 같은 모양이어야 한다 — 갈라진 걸 알아채는 자리가 원격 D1 이면 그때는 늦다",
    find: "  key_fingerprint  TEXT,",
    replace: "",
  },

  // ── 2026-08-28 · 위협 87 폐쇄 배포의 옛 클라이언트 안내 ────────────────
  {
    id: "M148", file: "worker/index.js", suite: "test-deploy-matrix",
    what: "클라이언트 호환성 검사를 남용 방어 **뒤로** 되돌린다",
    invariant: "옛 클라이언트 안내는 남용 방어보다 앞이다 — 뒤에 두면 폐쇄 배포(지금 라이브)에서 그 안내에 아예 닿지 못한다",
    transform: (src) => {
      const a = src.indexOf("    // ── 0-0-1-1. **클라이언트 호환성 계약**");
      const b = src.indexOf("    // ── 0-0-1. 남용 방어가 준비됐나 ──");
      const c = src.indexOf("    // ── 0-0-2. 우리가 발급한 쿠키인가");
      if (a < 0 || b < a || c < b) return null;
      return src.slice(0, a) + src.slice(b, c) + src.slice(a, b) + src.slice(c);
    },
  },
  {
    id: "M149", file: "worker/index.js", suite: "test-deploy-matrix",
    what: "폐쇄 503 을 최상위 이동에서도 JSON 으로 돌려준다",
    invariant: "브라우저가 주소창으로 들어온 응답은 본문을 그대로 그린다 — 옛 세대에는 그 JSON 을 읽을 코드가 없다",
    find: "const guardClosed = (env, req, path) =>\n  isNavPath(path)\n    ? closedPage(env)\n    : json(",
    replace: "const guardClosed = (env, req, path) =>\n  false\n    ? closedPage(env)\n    : json(",
  },
  {
    id: "M150", file: "worker/index.js", suite: "test-deploy-matrix",
    what: "`/exchange` 까지 최상위 이동으로 본다(앱이 fetch 로 부르는 자리다)",
    invariant: "fetch 로 부르는 자리는 JSON 계약을 지킨다 — HTML 을 주면 화면 코드가 통째로 깨진다",
    find: "export const isNavPath = (p) => /^\\/(?:login|cb)\\//.test(p);",
    replace: "export const isNavPath = (p) => /^\\/(?:login|cb|exchange)\\//.test(p);",
  },
  {
    id: "M151", file: "worker/index.js", suite: "test-deploy-matrix",
    what: "설정이 덜 된 로그인 시작을 다시 평문 한 줄로 돌려준다",
    invariant: "최상위 이동의 거절에도 앱으로 돌아갈 길이 있어야 한다",
    find: "      if (!providerPossible(env, m[1]) || !loginPossible(env)) return closedPage(env);",
    replace: "      if (!providerPossible(env, m[1]) || !loginPossible(env))\n"
           + "        return new Response(\"설정되지 않았어요\", { status: 503 });",
  },
  {
    id: "M152", file: "worker/index.js", suite: "test-deploy-matrix",
    what: "콜백 실패 안내를 다시 charset 없는 평문으로 돌려준다",
    invariant: "콜백은 최상위 이동이다 — 사람이 읽을 화면이 아니면 사용자가 할 수 있는 일이 없다",
    find: "                           : (hash ? redir(hash) : loginFailPage(env, msg, status));",
    replace: "                           : (hash ? redir(hash) : new Response(msg, { status }));",
  },
  {
    id: "M153", file: "scripts/test-deploy-matrix.mjs", suite: "test-deploy-matrix", kind: "정적",
    what: "폐쇄 구성 fixture 에 `DEV_RATE_LIMIT` 을 몰래 끼워 넣는다",
    invariant: "배포에 없는 값으로 문을 열어 둔 fixture 는 라이브를 재지 못한다 — 그 fixture 가 곧 거짓 통과다",
    find: "  none: () => ({ APP_ORIGIN: ORIGIN }),",
    replace: "  none: () => ({ APP_ORIGIN: ORIGIN, DEV_RATE_LIMIT: \"1\" }),",
  },

  // ── 2026-08-28 · 위협 88 백업 생산자와 reconciliation 의 교차 ──────────
  {
    id: "M154", file: "scripts/backup.mjs", suite: "test-ops-race",
    what: "업로드 권리(CAS)를 따지 않고 바로 올린다",
    invariant: "`aborted` 인 backup_id 로는 그 뒤 어떤 생산자도 객체를 올릴 수 없다",
    find: "    try { await inv.setUploading(id); }",
    replace: "    try { if (false) await inv.setUploading(id); }",
  },
  {
    id: "M155", file: "scripts/backup.mjs", suite: "test-ops-race",
    what: "업로드 권리 CAS 가 0행을 바꿔도 성공으로 넘긴다",
    invariant: "권리를 못 땄다는 것은 그 사이에 이 백업이 닫혔다는 뜻이다 — 넘기면 자물쇠가 없는 것과 같다",
    find: "  setUploading(id) {\n    return this.execOne(",
    replace: "  setUploading(id) {\n    return this.exec(",
  },
  {
    id: "M156", file: "worker/ledger.js", suite: "test-ops-race",
    what: "`pending → uploaded` 를 전이표에 되살린다",
    invariant: "업로드는 권리를 딴 뒤에만 기록된다 — 이 전이가 있으면 권리 자체를 건너뛸 수 있다",
    find: "  pending: [\"uploading\", \"aborted\", \"failed\"],",
    replace: "  pending: [\"uploading\", \"uploaded\", \"aborted\", \"failed\"],",
  },
  {
    id: "M157", file: "worker/ledger.js", suite: "test-ops-race",
    what: "`failed → aborted` 를 되살린다",
    invariant: "`failed` 는 업로드가 있었는지 상태만으로 알 수 없다 — 「없음을 확인했다」로 닫을 근거가 없다",
    find: "  failed: [\"deleted\"],",
    replace: "  failed: [\"deleted\", \"aborted\"],",
  },
  {
    id: "M158", file: "worker/cleanup/index.js", suite: "test-ops-race",
    what: "크론이 `uploading` 도 순간 부재만 보고 닫는다",
    invariant: "`put` 이 도는 중일 수 있다 — 닫으면 그 뒤에 객체가 생겨 「없음을 확인했다」가 거짓이 된다",
    find: "      if (r.status === \"uploading\") {\n        out.uploading++;",
    replace: "      if (false) {\n        out.uploading++;",
  },
  {
    id: "M159", file: "worker/cleanup/index.js", suite: "test-ops-race",
    what: "부재 확인 UPDATE 에서 관측 상태 CAS 를 뺀다",
    invariant: "조회와 UPDATE 사이에 생산자가 옮긴 행을 「닫았다」로 적지 않는다",
    find: "        `UPDATE backups SET ${sets.join(\", \")} WHERE backup_id = ? AND status = ?`\n"
        + "        + ` AND ${backupFroms(to)}`)\n"
        + "        .bind(...args, r.backup_id, r.status).run();",
    replace: "        `UPDATE backups SET ${sets.join(\", \")} WHERE backup_id = ?`\n"
           + "        + ` AND ${backupFroms(to)}`)\n"
           + "        .bind(...args, r.backup_id).run();",
  },
  {
    id: "M160", file: "scripts/backup.mjs", suite: "test-ops-race",
    what: "수동 reconcile 만 `uploading` 을 닫게 한다(크론보다 약한 규칙)",
    invariant: "수동 명령이 자동 크론보다 약하면, 운영자가 손으로 부르는 순간 자물쇠가 사라진다",
    find: "        if (r.status === \"uploading\") {\n          out.uploading++; out.ok = false;",
    replace: "        if (false) {\n          out.uploading++; out.ok = false;",
  },
  {
    id: "M161", file: "scripts/backup.mjs", suite: "test-ops-race",
    what: "수동 reconcile 이 markGone 의 결과(바뀐 행 수)를 안 본다",
    invariant: "0행은 그 사이에 생산자가 이겼다는 뜻이다 — 「닫았다」로 세면 경합이 통계에서 사라진다",
    find: "        if (await inv.markGone(id, now, to, r.status) !== 1) {",
    replace: "        if (await inv.markGone(id, now, to, r.status) === -1) {",
  },

  // ── 2026-08-28 · 위협 89 reconciliation 의 기아 ────────────────────────
  {
    id: "M162", file: "worker/cleanup/index.js", suite: "test-ops-race",
    what: "커서를 저장하지 않는다(회차마다 처음부터 본다)",
    invariant: "모든 행이 유한 회차 안에 검사된다 — 앞 25개가 계속 살아 있어도 26번째가 굶지 않는다",
    find: "  await env.LEDGER.prepare(\"UPDATE cleanup_runs SET recon_cursor = ? WHERE id = 1\")\n"
        + "    .bind(next).run();",
    replace: "",
  },
  {
    id: "M163", file: "worker/cleanup/index.js", suite: "test-ops-race",
    what: "커서를 안 쓰고 다시 `snapshot_at` 순으로 앞 25개만 본다",
    invariant: "커서 없는 `LIMIT` 은 「언젠가는 본다」조차 보장하지 않는다",
    find: "        AND backup_id > ?\n      ORDER BY backup_id LIMIT ?`).bind(from, limit).all()).results || [];",
    replace: "        AND ? <> ?\n      ORDER BY snapshot_at LIMIT ?`).bind(from, \"x\", limit).all()).results || [];",
  },
  {
    id: "M164", file: "worker/cleanup/index.js", suite: "test-ops-race",
    what: "한 바퀴를 돌아도 커서를 처음으로 되돌리지 않는다",
    invariant: "wrap-around 가 없으면 커서가 끝에 닿는 순간 그 뒤로는 아무 행도 다시 검사되지 않는다",
    // ⚠️ **유한한 변이여야 한다**(2026-08-28 · 위협 91). 처음에는 `next` 만 바꿨는데, 그러면
    //    빈 페이지에서 `reconPage` 가 **같은 커서로 무한 재귀**해 스위트가 영영 안 끝났다 —
    //    실행기에 제한 시간이 없던 시절 그것이 검증 전체를 멈췄다. 결함(wrap-around 없음)은
    //    그대로 두고 **재귀만** 끊는다. 그래야 「굶는다」가 assertion 으로 드러난다.
    transform: (s) => s
      .replace("  const next = rows.length < limit ? \"\" : rows[rows.length - 1].backup_id;",
               "  const next = rows.length ? rows[rows.length - 1].backup_id : from;")
      .replace("  if (!rows.length && from) return reconPage(env, limit);",
               "  if (!rows.length && from) return [];"),
  },

  // ── 2026-08-28 · 위협 90 Node 런타임 계약 ──────────────────────────────
  {
    id: "M165", file: "scripts/backup.mjs", suite: "test-ops-race",
    what: "Node 판 확인을 없앤다(무엇이든 지원한다고 답한다)",
    invariant: "지원하지 않는 Node 에서는 애매한 import 오류가 아니라 이해할 수 있는 메시지로 즉시 멈춘다",
    find: "export function nodeOk(v = process.versions.node) {",
    replace: "export function nodeOk(v = process.versions.node) {\n  return true;",
  },
  {
    id: "M166", file: "package.json", suite: "test-ops-race", kind: "정적",
    what: "`engines.node` 를 코드의 최소 판과 다르게 적는다",
    invariant: "지원 판의 원본은 한 자리다 — 설정·문서가 코드와 갈라지면 아무 소용이 없다",
    find: "    \"node\": \">=22.13.0\"",
    replace: "    \"node\": \">=18.0.0\"",
  },

  // ── 2026-08-27 K4 · 보관함의 current / past / draft ────────────────────
  {
    id: "D44", file: "scripts/policies.mjs", suite: "test-policies", kind: "정적",
    what: "지금 나가는 사본을 다시 「지난 판」에도 적는다",
    invariant: "보관함의 쓸모는 「그때 그 사람이 본 문서가 이것이다」이다 — 현재 판이 섞이면 지목이 안 된다",
    find: "  const rest = m.versions.filter((v) => !current.has(v.file));",
    replace: "  const rest = m.versions.slice();",
  },
  {
    id: "D45", file: "scripts/policies.mjs", suite: "test-policies", kind: "정적",
    what: "배포된 적 없는 사본까지 「지난 판」이라 부른다",
    invariant: "나간 적 없는 문서를 「지난 판」이라 부르면 아무도 본 적 없는 것을 봤다고 말하는 것이다",
    find: "  const past = shipped ? rest.filter((v) => shipped.has(v.file)) : rest;",
    replace: "  const past = rest;",
  },

  // ── 2026-08-28 · 검증 장치 자체 (위협 91·92) ──────────────────────────
  // ⚠️ 여기 변이가 살아남으면 **다른 210종의 결과를 믿을 수 없다** — 실행기가 고장 나도
  //    표에는 아무 실패도 안 뜨고 「아직 안 끝났다」로만 보이기 때문이다.
  {
    id: "M167", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "제한 시간에 걸린 자식을 **직계만** 죽인다 (프로세스 그룹이 아니라)",
    invariant: "스위트가 띄운 손자가 남으면 다음 회차의 판정이 부하 때문인지 변이 때문인지 갈리지 않는다",
    find: "      try { killFn(-ev.pgid, \"SIGKILL\"); }",
    replace: "      try { killFn(ev.pgid, \"SIGKILL\"); }",
  },
  {
    id: "M168", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "제한 시간에 걸린 변이를 **사망**으로 접는다",
    invariant: "재지 못한 것은 잡은 것이 아니다 — 합치면 종료하지 않는 변이가 곧 만점이 된다",
    find: "export const VERDICTS = [\"KILLED\", \"SURVIVED\", \"ANCHOR-MISS\", \"TIMEOUT\", INFRA_ERROR];",
    replace: "export const VERDICTS = [\"KILLED\", \"SURVIVED\", \"ANCHOR-MISS\", INFRA_ERROR];",
  },
  {
    id: "M169", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "TIMEOUT 이 완료를 막지 않게 한다",
    invariant: "완료 조건은 생존 0 · 앵커 실패 0 · **제한 시간 초과 0** 셋 전부다",
    find: "export const FATAL = [\"SURVIVED\", \"ANCHOR-MISS\", \"TIMEOUT\", INFRA_ERROR];",
    replace: "export const FATAL = [\"SURVIVED\", \"ANCHOR-MISS\", INFRA_ERROR];",
  },
  {
    id: "M170", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "죽이기는 하되 **제한 시간에 걸렸다는 사실을 안 알린다**",
    invariant: "그러면 SIGKILL 당한 실행이 종료 코드만 보고 조용히 KILLED 로 접힌다 — 재지 못한 것이 만점이 된다",
    // ⚠️ 「아예 안 죽인다」로 만들면 그 변이 자체가 안 끝나서 TIMEOUT 이 된다.
    //    TIMEOUT 은 사망이 아니므로 그런 변이는 **아무것도 증명하지 못한다** — 유한하게 만든다.
    find: "      ev.timedOut = true;",
    replace: "      ev.timedOut = false;",
  },
  {
    id: "M171", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "종료 코드에서 제한 시간 초과를 뺀다",
    invariant: "실행기의 기본값은 실패다 — 재지 못한 변이가 있는 실행을 0 으로 끝내지 않는다",
    find: "process.exit(sum.fatal ? 1 : 0);",
    replace: "process.exit(sum.SURVIVED + sum[\"ANCHOR-MISS\"] ? 1 : 0);",
  },
  {
    id: "M172", file: "scripts/test-ops-race.mjs", suite: "test-verifier", kind: "정적",
    what: "R11 의 마지막 경계에서 reconciliation 을 안 돌리고 통과시킨다",
    invariant: "실행하지 않은 경계를 「전수」에 세지 않는다",
    find: "      if (!fired) await cross();          // 마지막 자리: 명령이 없으므로 **반환 직후**에 완주시킨다",
    replace: "      // (마지막 자리는 건너뛴다)",
  },


  // ── 2026-08-31 · 검증기 판정의 fail-closed (위협 93) ────────────────────
  // ⚠️ 여기 변이가 살아남으면 **다른 전부의 결과를 믿을 수 없다** — 실행기가 측정 불능에
  //    빠져도 표에는 「전부 사망 · 종료 코드 0」이 찍힌다. 그것이 위협 93 의 모양이다.
  {
    id: "M173", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 spawn 실패 갈래를 없앤다",
    invariant: "자식을 시작조차 못 한 실행을 「방어가 잡았다」로 세지 않는다",
    find: "  if (r.spawnFailed) return r.started ? \"unobservable\" : \"spawn-failed\";",
    replace: "  // (spawn 실패 갈래 제거)",
  },
  {
    id: "M174", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 signal 갈래를 없앤다",
    invariant: "바깥에서 온 신호로 죽은 실행은 방어와 무관하다 — 사망으로 세지 않는다",
    find: "  if (r.signal !== null) return \"signalled\";",
    replace: "  // (signal 갈래 제거)",
  },
  {
    id: "M175", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 의 기본값을 exited 로 바꾼다",
    invariant: "모르는 결과의 기본값은 실패다 — 마지막 갈래가 exited 이면 새 필드 하나가 만점을 만든다",
    find: "  if (Number.isInteger(r.status)) return \"exited\";\n  return \"unobservable\";",
    replace: "  return \"exited\";",
  },
  {
    id: "M176", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "close 의 둘째 인자(signal)를 버린다",
    invariant: "판정의 증거는 결과 객체 안에 있어야 한다 — 버리면 우리 kill 과 바깥 kill 이 구분되지 않는다",
    find: "      if (!exitLatched) { exitLatched = true; ev.status = code ?? null; ev.signal = signal ?? null; }",
    replace: "      if (!exitLatched) { exitLatched = true; ev.status = code ?? null; }",
  },
  {
    id: "M177", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "FATAL 에서 INFRA-ERROR 를 뺀다",
    invariant: "측정 불능은 완료를 막는다 — 재지 못한 실행이 있는 회차를 0 으로 끝내지 않는다",
    find: "export const FATAL = [\"SURVIVED\", \"ANCHOR-MISS\", \"TIMEOUT\", INFRA_ERROR];",
    replace: "export const FATAL = [\"SURVIVED\", \"ANCHOR-MISS\", \"TIMEOUT\"];",
  },
  {
    id: "M178", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "판정 목록에서 INFRA-ERROR 를 없앤다",
    invariant: "측정 불능에는 자기 이름이 있어야 한다 — 이름이 없으면 다른 판정에 섞인다",
    find: "export const VERDICTS = [\"KILLED\", \"SURVIVED\", \"ANCHOR-MISS\", \"TIMEOUT\", INFRA_ERROR];",
    replace: "export const VERDICTS = [\"KILLED\", \"SURVIVED\", \"ANCHOR-MISS\", \"TIMEOUT\"];",
  },
  {
    id: "M179", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "기준선의 측정 불능을 「경고 후 계속」으로 바꾼다",
    invariant: "기준선을 못 재면 그 뒤 표는 전부 무의미하다 — 돌연변이를 하나도 실행하지 않는다",
    find: "    baselineFail++;\n    console.error(c.outcome === \"exited\"",
    replace: "      console.error(c.outcome === \"exited\"",
  },
  {
    id: "M180", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "finalize() 를 여러 번 허용한다 (늦게 온 close 가 앞선 error 를 덮는다)",
    invariant: "확정과 clearTimeout 은 정확히 한 번이다 — 먼저 온 증거가 남아야 spawn 실패가 숫자 exit 로 둔갑하지 않는다",
    find: "    const finalize = () => {\n      if (settled) return;\n      settled = true;",
    replace: "    const finalize = () => {\n      settled = true;",
  },
  {
    id: "M181", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 started 검사를 뺀다 (나머지 조건은 그대로)",
    invariant: "KILLED 는 시작의 **양의 증거**를 요구한다 — 실측에서 ENOENT 도 close(code=-2) 라는 숫자 non-zero 를 낸다",
    find: "  if (!r.started) return r.timedOut ? \"start-timeout\" : \"unobservable\";",
    replace: "  // (started 검사 제거)",
  },
  {
    id: "M182", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "started 를 'spawn' 이벤트가 아니라 종료 코드에서 **추정**한다",
    invariant: "시작은 추정하지 않고 관측한다 — 부산물로 추정하면 시작도 못 한 실행이 시작된 것이 된다",
    transform: (s) => s
      .replace("      if (!ev.started) { ev.started = true; ev.pgid = Number.isInteger(ch.pid) ? ch.pid : null; }",
               "      if (!ev.started) { ev.pgid = Number.isInteger(ch.pid) ? ch.pid : null; }")
      .replace("      ev.closeSeen = true;",
               "      ev.closeSeen = true; if (Number.isInteger(code)) ev.started = true;"),
  },
  {
    id: "M183", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "spawn 전 만료를 그냥 timeout 으로 접는다",
    invariant: "「변이가 안 끝난다」와 「자식을 띄우지도 못했다」는 운영자가 할 일이 정반대다",
    find: "  if (!r.started) return r.timedOut ? \"start-timeout\" : \"unobservable\";",
    replace: "  if (r.timedOut) return \"timeout\";\n  if (!r.started) return \"unobservable\";",
  },
  {
    id: "M184", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "시작 뒤의 error 를 「시작 실패」로 기록한다",
    invariant: "「아무것도 실행되지 않았다」를 거짓으로 기록하지 않는다 — 운영자를 실행 환경 쪽으로 잘못 보낸다",
    find: "      if (ev.started) { ev.postSpawnError = true; }\n      else if (!ev.spawnFailed) { ev.spawnFailed = true; }",
    replace: "      if (!ev.spawnFailed) { ev.spawnFailed = true; }",
  },
  {
    id: "M185", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 postSpawnError 갈래를 뺀다 (나머지 조건은 그대로)",
    invariant: "시작 뒤에 오류가 난 실행은 끝까지 관측했다고 말할 수 없다 — 숫자 exit 가 있어도 사망이 아니다",
    find: "  if (r.postSpawnError) return \"post-spawn-error\";",
    replace: "  // (postSpawnError 갈래 제거)",
  },
  {
    id: "M186", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "산출물 행에서 postSpawnError 를 뺀다",
    invariant: "판정의 증거는 산출물 안에 있어야 한다 — 없으면 그 표를 나중에 검증할 수 없다",
    find: "    spawnFailed: r.spawnFailed, postSpawnError: r.postSpawnError,",
    replace: "    spawnFailed: r.spawnFailed,",
  },
  {
    id: "M187", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "error 에서 즉시 반환한다 (close 를 안 기다린다)",
    invariant: "error 는 종료의 증거가 아니다 — 죽지 않은 자식을 남긴 채 다음 변이를 시작하게 된다",
    find: "      if (!ev.started && ev.pgid === null) finalize();",
    replace: "      finalize();",
  },
  {
    id: "M188", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "타이머가 kill 을 **요청한 직후** 반환한다",
    invariant: "kill 요청과 종료 확인은 다른 사건이다 — 요청이 성공해도 대상이 즉시 사라지지는 않는다",
    find: "      if (ev.started) requestCleanup();",
    replace: "      if (ev.started) { requestCleanup(); finalize(); }",
  },
  {
    id: "M189", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "start-timeout 뒤 늦게 온 'spawn' 을 죽이지 않는다",
    invariant: "아무도 모르는 자식을 남기지 않는다 — 그 자식은 다음 변이의 측정을 오염시킨다",
    find: "      if (ev.startTimedOut) { requestCleanup(); void confirmCleanup(); }",
    replace: "      // (늦게 온 시작을 그냥 둔다)",
  },
  {
    id: "M190", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "우선순위에서 timedOut 과 signal 을 뒤바꾼다",
    invariant: "우리 타이머가 죽인 것은 언제나 timeout 이다 — 순서가 이름을 정하면 같은 실행이 부하에 따라 다른 이름을 받는다",
    find: "  if (r.timedOut) return \"timeout\";\n  if (r.signal !== null) return \"signalled\";",
    replace: "  if (r.signal !== null) return \"signalled\";\n  if (r.timedOut) return \"timeout\";",
  },
  {
    id: "M191", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "정리를 증명하지 못해도 남은 변이를 계속 실행한다",
    invariant: "증명 못 한 잔류 위에서 재지 않는다 — 그 뒤 판정이 부하 때문인지 변이 때문인지 갈리지 않는다",
    find: "                                         : `close=${r.closeSeen} · 그룹=${r.groupState}` };\n      break;",
    replace: "                                         : `close=${r.closeSeen} · 그룹=${r.groupState}` };",
  },

  // ── 2026-08-31 · 프로세스 그룹 종료 불변식 (위협 94) ────────────────────
  // ⛔ 직접 자식의 `close` 는 **그 자식 하나와 그 stdio** 만 보장한다. 실측에서 `close` 뒤에도
  //    같은 그룹의 손자가 살아 있었다 — 그 상태에서 다음 변이를 재면 표 전체가 무의미하다.
  {
    id: "M192", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "그룹 부재를 **양수 PID** 로 묻는다",
    invariant: "그룹 부재는 그룹에게 묻는다 — 양수 PID probe 는 그 프로세스 하나만 말한다",
    find: "    kill(-pgid, 0);",
    replace: "    kill(pgid, 0);",
  },
  {
    id: "M193", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "probe 를 항상 「없다」로 답하게 한다",
    invariant: "그룹 상태의 기본값은 실패다 — 확인하지 않은 것을 부재로 인정하지 않는다",
    find: "export function probeGroup(pgid, kill = process.kill) {",
    replace: "export function probeGroup(pgid, kill = process.kill) {\n  return \"absent\";",
  },
  {
    id: "M194", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "EPERM 을 「그룹이 없다」로 읽는다",
    invariant: "EPERM 은 「있을 수도 있는데 확인할 권한이 없다」다 — 부재가 아니다",
    find: "    if (e && e.code === \"EPERM\") return \"unverifiable\";",
    replace: "    if (e && e.code === \"EPERM\") return \"absent\";",
  },
  {
    id: "M195", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "pgid <= 1 가드를 없앤다",
    invariant: "kill(-1, …) 은 보낼 수 있는 **모든 프로세스**를 뜻한다 — 우리가 만든 PGID 하나만 만진다",
    find: "  if (!Number.isInteger(pgid) || pgid <= 1) return \"unverifiable\";",
    replace: "  // (가드 없음)",
  },
  {
    id: "M196", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "close 만 보고 정리 완료로 확정한다",
    invariant: "직접 자식의 close 는 그룹 부재의 증거가 아니다 — 이번 결함 그 자체다",
    find: "        if (state === \"absent\" && ev.closeSeen) return finalize();",
    replace: "        if (ev.closeSeen) return finalize();",
  },
  {
    id: "M197", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "잔류 그룹을 관찰하고도 기록하지 않는다",
    invariant: "관찰한 잔류를 무시하지 않는다 — 정리에 성공했어도 그 실행은 오염된 실행이다",
    find: "          if (ev.closeSeen && state === \"present\") ev.residualGroupDetected = true;",
    replace: "          // (잔류를 기록하지 않는다)",
  },
  {
    id: "M198", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 잔류 그룹 갈래를 뺀다",
    invariant: "잔류 그룹이면 KILLED 도 SURVIVED 도 금지다 — 둘 중 어느 쪽으로 적어도 원인을 아무도 안 본다",
    find: "  if (r.residualGroupDetected || r.groupState === \"present\") return \"residual-group\";",
    replace: "  // (잔류 그룹 갈래 제거)",
  },
  {
    id: "M199", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 close 확인을 뺀다",
    invariant: "시작된 자식은 close 와 그룹 부재를 **둘 다** 본 뒤에만 확정한다",
    find: "  if (!r.closeSeen) return \"unobservable\";",
    replace: "  // (close 확인 제거)",
  },
  {
    id: "M200", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "classify 에서 그룹 부재 요구를 뺀다",
    invariant: "기본값 unknown 을 통과시키면 그룹을 한 번도 안 잰 실행이 정상 측정이 된다",
    find: "  if (r.groupState !== \"absent\") return \"unobservable\";",
    replace: "  // (그룹 부재 요구 제거)",
  },
  {
    id: "M201", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "cleanup deadline 을 없앤다 (기한을 넘겨도 그 사실을 안 적는다)",
    invariant: "정리 기한 안에 부재를 증명 못 하면 그 회차는 측정 불능이고 실행기는 중단한다",
    find: "        if (settled) return;\n        ev.cleanupTimedOut = true;\n        finalize();",
    replace: "        if (settled) return;\n        finalize();",
  },
  {
    id: "M202", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "다음 변이 허용 조건을 close 하나로 줄인다",
    invariant: "nextMutationAllowed = directClosed 는 이번 결함이다 — 실측에서 close 와 손자 생존이 공존했다",
    find: "  return r.closeSeen === true && r.groupState === \"absent\";",
    replace: "  return r.closeSeen === true;",
  },
  {
    id: "M203", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "플랫폼 게이트를 없앤다",
    invariant: "계약 없는 플랫폼에서 초록을 만들지 않는다 — 조용히 그룹 검사를 건너뛰고 도는 것이 가장 나쁘다",
    find: "if (process.platform === \"win32\") {",
    replace: "if (false) {",
  },
  {
    id: "M204", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "그룹 이탈 검사에서 첫 패턴을 뺀다",
    invariant: "「그룹을 벗어나는 후손이 없다」는 전제를 사람의 기억이 아니라 검사가 지킨다",
    // ⚠️ 앵커를 문자열로 적으면 이 파일 자신이 그 검사에 걸린다 — 접두사만 잡고 잘라 붙인다.
    transform: (s) => {                                    // group-escape-ok: 변이 정의
      const head = "export const GROUP_ESCAPE_PATTERNS = [";
      const i = s.indexOf(head), j = s.indexOf("]", i);
      if (i < 0 || j < 0) return null;
      const items = s.slice(i + head.length, j).split(",").map((x) => x.trim()).filter(Boolean);
      if (items.length < 2) return null;
      return s.slice(0, i + head.length) + items.slice(1).join(", ") + s.slice(j);
    },
  },
  {
    id: "M205", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "산출물 행에 실행 경로를 싣는다",
    invariant: "산출물에 오류 원문·환경 변수·명령 인자·경로를 싣지 않는다 — 원인은 고정 문구여야 한다",
    find: "    detail: c.why,\n  };",
    replace: "    detail: c.why, cwd: process.cwd(),\n  };",
  },
  {
    id: "M206", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "산출물 행에 PGID 를 싣는다",
    invariant: "PGID 는 화면에만 적는다 — 산출물에 가변 세부정보를 넣지 않는다",
    find: "    verdict: c.verdict, outcome: c.outcome,",
    replace: "    verdict: c.verdict, outcome: c.outcome, pgid: r.pgid,",
  },

  // ── 2026-08-31 · 문서 검사 자체 (G13 · G14) ────────────────────────────
  // ⚠️ 검사를 무력화하는 변이는 **그 검사의 자기검사**만 잡을 수 있다 — 없앤 방어가 곧 유일한
  //    관측 수단이면 「아무것도 실패하지 않음」이 나온다. 그래서 둘 다 합성 입력 self-test 를 둔다.
  {
    id: "D46", file: "scripts/test-docs.mjs", suite: "test-docs", kind: "정적",
    what: "KILLED 조건 개수 검사를 항상 통과시킨다",
    invariant: "문서가 적은 조건 개수는 코드의 KILLED_REQUIREMENTS 길이에서 파생한다",
    find: "  const killedCountProblems = (text, want) => {\n    const out = [];",
    replace: "  const killedCountProblems = (text, want) => {\n    return [];\n    const out = [];",
  },
  {
    id: "D47", file: "scripts/test-docs.mjs", suite: "test-docs", kind: "정적",
    what: "「close 를 봤으므로 그룹이 종료됐다」 금지 패턴을 뺀다",
    invariant: "위협 94 를 만든 문장이 문서에 다시 생기면 검사가 실패해야 한다",
    find: "      [/`close`\\s*를?\\s*봤으므로[^\\n]{0,20}그룹/, \"close 를 그룹 종료의 증거로 읽는다\"],",
    replace: "",
  },

  // ── 2026-08-31 · 검증기 정리 경로 4건 (실행기 수명주기 보완) ─────────────
  // ⚠️ 넷 다 「테스트가 전부 통과하는 상태」에서 성립했다 — 방어를 지우면 어느 검사가 실제로
  //    빨개지는지가 유일한 증거다.
  {
    id: "M207", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "spawn 뒤 error 에서 정리를 요청하지 않고 기한만 흘려 보낸다",
    invariant: "error 는 종료의 증거가 아니다 — 시작한 자식은 정리로 들어가야 한다",
    find: "      else if (ev.started) { requestCleanup(); void confirmCleanup(); }",
    replace: "      else if (ev.started) { armDeadline(); }",
  },
  {
    id: "M208", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "그룹 상태를 확인할 수 없으면 그 자리에서 확정한다",
    invariant: "확인할 수 없다와 확인을 포기한다는 다른 말이다 — 기한까지 계속 묻는다",
    find: "        if (state === \"absent\" && ev.closeSeen) return finalize();",
    replace: "        if (state === \"absent\" && ev.closeSeen) return finalize();\n"
           + "        if (state === \"unverifiable\") return finalize();",
  },
  {
    id: "M209", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "확인할 수 없는 그룹에는 종료를 요청하지 않는다",
    invariant: "부재를 증명 못 한 그룹은 정확한 음수 PGID 로 종료를 요청한다",
    find: "        if (state !== \"absent\" && waited >= settleMs) {",
    replace: "        if (state === \"present\" && waited >= settleMs) {",
  },
  {
    id: "M210", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "기준선의 정리 실패를 중단 사유로 보지 않는다",
    invariant: "정리를 증명 못 한 기준선 뒤에는 다음 프로세스를 띄우지 않는다",
    find: "  return !nextMutationAllowed(r) || cleanupFailed(r);",
    replace: "  return false;",
  },
  {
    id: "M211", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "잔류 그룹 관찰이 start-timeout 보다 먼저 판정된다",
    invariant: "나중에 발견한 정리 증거가 최초 실패 원인을 덮지 않는다",
    find: "  if (r.startTimedOut === true) return \"start-timeout\";\n"
        + "  if (r.residualGroupDetected || r.groupState === \"present\") return \"residual-group\";",
    replace: "  if (r.residualGroupDetected || r.groupState === \"present\") return \"residual-group\";\n"
           + "  if (r.startTimedOut === true) return \"start-timeout\";",
  },
  {
    id: "M212", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "직접 자식이 닫히기 전에도 잔류 그룹으로 적는다",
    invariant: "close 전의 그룹 생존은 잔류가 아니다 — 정상 종료 중일 수 있다",
    find: "          if (ev.closeSeen && state === \"present\") ev.residualGroupDetected = true;",
    replace: "          if (state === \"present\") ev.residualGroupDetected = true;",
  },
  {
    id: "M213", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "중첩 실행에 run-root 소유자를 물려주지 않는다",
    invariant: "중첩 실행의 사본은 최상위 run-root 안에만 생긴다",
    find: "  return { ...base, [RUN_ROOT_ENV]: runRoot };",
    replace: "  return { ...base };",
  },
  {
    id: "M214", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "상속받은 run-root 경로를 검증 없이 받는다",
    invariant: "바깥에서 온 경로를 삭제·사용 대상으로 그대로 믿지 않는다",
    find: "  if (typeof p !== \"string\" || p === \"\") return false;",
    replace: "  return true;\n  if (typeof p !== \"string\" || p === \"\") return false;",
  },
  {
    id: "M215", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "run-root 소유자 PID 가 살아 있어도 지운다",
    invariant: "소유자가 확실히 사라진 run-root 만 치운다 — 확인 불가는 삭제 허가가 아니다",
    find: "    if (!ownerGone) continue;   // 살아 있거나 **확인 불가능**하다 — 둘 다 안 지운다",
    replace: "",
  },
  {
    id: "M216", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "stale 시간을 안 보고 지운다",
    invariant: "지금 도는 형제 실행의 run-root 를 지우지 않는다",
    find: "    if (!Number.isFinite(mark.at) || nowMs - mark.at < staleMs) continue;",
    replace: "",
  },
  {
    id: "M217", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "다른 저장소의 run-root 도 치운다",
    invariant: "우리 저장소가 만든 run-root 만 치운다",
    find: "    if (!mark || mark.repo !== repo) continue;                       // 다른 저장소의 것",
    replace: "",
  },
  {
    id: "M218", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "run-root 자리에 놓인 심볼릭 링크를 그대로 따라간다",
    invariant: "run-root 는 TMPDIR 바로 아래의 **진짜 디렉터리**여야 한다 — 링크를 따라가지 않는다",
    find: "  if (st.isSymbolicLink() || !st.isDirectory()) return false; // 심볼릭 링크를 따라가지 않는다",
    replace: "",
  },
  {
    id: "M219", file: "scripts/_mutate-lib.mjs", suite: "test-verifier",
    what: "정리 실패한 기준선 뒤에도 다음 기준선을 계속 실행한다",
    invariant: "중단은 다음 프로세스를 띄우기 **전에** 일어난다",
    find: "    if (baselineHalt(r)) { halted = { suite: s, r, c }; break; }",
    replace: "    if (baselineHalt(r)) { halted = { suite: s, r, c }; continue; }",
  },
  {
    id: "M220", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "기준선 중단을 보고만 하고 계속 진행한다",
    invariant: "정리를 증명 못 한 기준선은 종료 코드 2 로 그 자리에서 멈춘다",
    find: "    console.error(\"   남은 기준선도 돌연변이도 하나 실행하지 않고 중단한다.\");\n    process.exit(2);",
    replace: "    console.error(\"   남은 기준선도 돌연변이도 하나 실행하지 않고 중단한다.\");",
  },
  {
    id: "M221", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "최상위 실행이 자기 run-root 를 끝에 안 치운다",
    invariant: "run-root 를 지우는 것은 그것을 만든 실행 하나뿐이고, 반드시 지운다",
    find: "  if (ownsRunRoot) { try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* 이미 없다 */ } }",
    replace: "",
  },
  {
    id: "M222", file: "scripts/mutate.mjs", suite: "test-verifier", kind: "정적",
    what: "종료 경로에 정리를 걸지 않고 finally 에만 맡긴다",
    invariant: "process.exit() 는 finally 를 돌리지 않는다 — 종료 경로 전부에 정리가 걸려 있다",
    find: "process.on(\"exit\", cleanupOwned);",
    replace: "",
  },
];
