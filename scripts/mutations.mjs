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
      const anchor = "    try {\n      return await route(req, env, { url, path, gate, lease, rt });";
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
    find: "    env.DB.prepare(\"INSERT INTO consumed_signup_states (state_hash, key_version, expires_at) VALUES (?, ?, ?)\")",
    replace: "    env.DB.prepare(\"INSERT OR IGNORE INTO consumed_signup_states (state_hash, key_version, expires_at) VALUES (?, ?, ?)\")",
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
];
