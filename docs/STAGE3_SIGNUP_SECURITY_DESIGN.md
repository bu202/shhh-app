# 3단계 상세 설계 — 회원가입 · 정책 기록 · 삭제 복원 안전성

**작성 2026-08-17 · 기준 커밋 `8d8842d` · 브랜치 `cf-pages` · 상태: 설계만. 코드 0줄**

이 문서는 **설계와 결정 요청**이다. 애플리케이션 코드·migration·정적 정책 파일·원격 리소스는
이번 단계에서 하나도 만들지 않았다. 2단계 결정서(`docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md`)를
뒤집는 항목은 없고, 사실 정정 3건은 §0 에 적었다.

**법률 판단은 이 문서 어디에도 없다.** 검토용 사실 자료는 `docs/PRIVACY_LEGAL_REVIEW_PACKET.md` 다.

---

## 0. 이 단계에서 고친 사실 오류 3건

| # | 어디 | 전 | 후 |
|---|---|---|---|
| 1 | `docs/HANDOFF.md` §2 | "라이브 `/api/ready` 응답에 `db` 항목이 없다" | 실측(2026-08-17): HTTP **503** · `{"ok":true,"configReady":false,"db":true,"providers":[],"ready":false}`. `db` 는 **이미 있다.** 503 은 OAuth·`RL_KEY` 미비로 인한 **의도된 fail-closed** 다. 라이브가 1단계 로컬 커밋보다 오래된 것은 그대로 사실이다 |
| 2 | 2단계 결정서 §3 가입 화면 | "계정 삭제로 전부 지울 수 있음" | 같은 문서 §8·§9(복원 시 부활)와 충돌. "주 서비스 DB 에서는 즉시 삭제 / 복구 이력 보유기간과 재삭제 절차는 방침에 안내"로 정정. **최종 법률 문구가 아님**을 함께 표시 |
| 3 | `HANDOFF.md` §2 · 2단계 §13 | D1 조회 `7403` 을 "간헐적 실패"로 단정 | "한 실행은 7403 권한 오류였고 이후 실행은 성공했다. 인증 컨텍스트·권한·Cloudflare 측 상태 중 무엇이 원인인지는 확인되지 않았다. 0명은 성공한 실행의 값이다" |

`CLAUDE.md` 에는 같은 단정이 없었다(검색으로 확인). 문서 지도에 이 문서와 법률 자료를 더했다.

---

## 1. 지금 코드가 실제로 하는 일

문서가 아니라 `worker/index.js` 를 읽어 확인한 것이다. 줄 번호는 커밋 `8d8842d` 기준이다.

```
POST 없음.  가입이라는 개념이 코드에 존재하지 않는다.

GET  /api/login/:provider          :706-739
     ├ 설정 확인(id·STATE_KEY)  → 없으면 503
     ├ return 주소를 allowed() 로 검사
     ├ txn = mkToken();  Set-Cookie shh_t (HttpOnly·Secure·SameSite=Lax·Path=/api·600초)
     └ state = HMAC 서명([provider, back, now+600s, nonce, sha256(txn)])  → 제공자로 302

GET  /api/cb/:provider             :773-811   (카카오·구글)
GET  /api/exchange/:provider       :744-768   (네이버 — 콜백이 앱 도메인으로 온다)
     ├ limited(login)  → 10회/분
     ├ takeState()  서명·만료·provider 대조
     ├ bound()      shh_t 쿠키와 state 안 해시 대조   ← code 교환 **전에**
     └ exchange()   :465-494
        ├ 토큰 교환 → /me 호출 → provider_subject(who)
        ├ internalUid(env, name, who)   :511-526   ← ★ 여기가 곧 가입이다
        └ newSession(env, uid)          :244-263
```

| 확인한 사실 | 근거 |
|---|---|
| 소셜 로그인 성공이 곧 계정 생성이다. 분기가 없다 | `exchange()` 가 조건 없이 `internalUid()` 를 부른다 (`:492`) |
| `internalUid()` 는 **신규인지 기존인지 호출자에게 말하지 않는다** | `:511-526` — 두 경우 다 `id` 문자열 하나 |
| 동의·약관·연령을 적을 자리가 없다 | `users` 컬럼은 `id · provider · provider_subject · session_version · created_at` 뿐 (`worker/schema.sql:15-21`) |
| 신규 가입 경로는 `WRITE_ROUTES` 에 **자동으로 안 들어간다** | `/^\/(session\|book\|me\|friends)(\/\|$)/` (`:327`) — `/signup` 은 여기 없다 |
| 새 버킷 이름을 `RL_MAX` 에 안 넣으면 **조용히 120/분**이 된다 | `RL_MAX[bucket] ?? RL_MAX.write` (`:369`) |
| 상태 변경 요청의 Origin 검사는 **모든 non-GET** 에 이미 걸린다 | `:830-839` — 새 POST 라우트는 자동으로 보호된다 |
| 계정 삭제는 `DELETE FROM users` **한 문장** + CASCADE | `:948` |
| `users` 를 참조하는 **모든** 테이블은 CASCADE 여야 한다 — 테스트가 강제한다 | `scripts/test-migrations.mjs:96-103` |
| 정적 자산과 Functions 는 **같은 Pages 배포 단위**로 나간다 | `wrangler.jsonc` 의 `pages_build_output_dir: "dist"` + 루트 `functions/` |
| 서비스워커는 `privacy.html` 을 **선캐시**한다 | `service-worker.js` ASSETS 목록 |

마지막 두 줄이 §8(정책 문서 무결성)의 출발점이다. 서버 상수와 정적 파일은 **같은 배포에 실려**
세대가 갈리지 않지만, **서비스워커 캐시는 그 배포와 무관하게 옛 파일을 줄 수 있다.**

---

## 2. 설계 목표와 불변식

| # | 불변식 | 어디서 강제되나 |
|---|---|---|
| I1 | 제공자 확인만으로 `users` 행이 생기지 않는다 | 서버 분기 (§7) |
| I2 | 기존 사용자는 가입 화면 없이 로그인된다 | 로그인 경로 (§5) |
| I3 | 신규 사용자는 가입 제출 전 세션이 없다 | 세션 발급이 계정 생성 뒤에만 |
| I4 | 계정과 필수 정책 이벤트가 갈라져 생기지 않는다 | `env.DB.batch()` 단일 트랜잭션 |
| I5 | 동시 가입에서도 `users` 행은 하나다 | `UNIQUE(provider, provider_subject)` + `ON CONFLICT DO NOTHING` |
| I6 | 진 쪽 요청은 이긴 계정 상태를 다시 조회해 안전하게 확인한다 | batch 뒤 `SELECT` |
| I7 | 로그인 API 와 가입 완료 API 를 혼동할 수 없다 | 경로 분리 + 서명된 `pv` 유무 |
| I8 | 가입 값 재생으로 기존 계정 세션을 발급하지 않는다 | 재생해도 `code` 가 1회용이라 제공자가 거부 |
| I9 | 탈퇴 후 재가입은 **새 내부 UID** 다 | 행이 사라져 `SELECT` 가 비고 새 UUID |
| I10 | `UNIQUE(provider, provider_subject)` 유지 | `worker/schema.sql:23` |
| I11 | 사용자가 본 문서와 서버가 기록한 해시가 같다 | 양쪽 대조 (§8) |
| I12 | 확정(`confirmed`)된 삭제는 복원 뒤에도 유지된다 | 삭제 표식 + 재적용 (§10·§11) |

---

## 3. 회원가입 상태 머신

### 3-1. 정상 경로

```
anonymous
  └ 가입하기 → policy_screen
policy_screen            (약관 체크 · 만14세 체크 · 방침 요약+전문 링크 · 제공자 선택)
  └ 제출 → signup_started            POST /api/signup/start
oauth_started            (shh_t 쿠키 심음 · state 에 pv 서명 · 제공자로 이동)
  └ 제공자 동의 → provider_verified  (/cb 또는 /exchange 에서 code 교환 성공)
provider_verified
  ├ 기존 계정 있음 → existing_user → session_issued → active   (정책 이벤트 안 만듦)
  └ 없음          → account_and_policy_events_created (batch) → session_issued → active
```

로그인 경로:

```
anonymous → login_started (GET /api/login/:provider, pv 없음)
  → provider_verified
      ├ 기존 계정 → session_issued → active
      └ 없음      → signup_required   (계정 생성 안 함. 가입 화면으로 되돌림)
```

### 3-2. 상태별 표

`서버가 아는 값`은 그 시점에 서버가 요청으로부터 얻는 값이다. 서버는 **어떤 임시 상태도 저장하지
않는다**(§6 권고안 기준).

| 상태 | 서버가 아는 값 | 브라우저가 가진 값 | DB 기록 | 다음 상태 조건 | 실패 시 지울 임시값 | 사용자에게 보이는 것 | 재시도 |
|---|---|---|---|---|---|---|---|
| `anonymous` | 없음 | `shh-peek`(선택) | 없음 | 버튼 클릭 | — | 게이트 | ○ |
| `policy_screen` | 없음 | 표시한 문서 해시 3개 · 체크 상태 | 없음 | 두 체크 + 제공자 선택 | 화면 상태(메모리) | 가입 화면 | ○ |
| `signup_started` | `provider`·`pv`·Origin | — | 없음 | `pv` == 현재 번들 | — | 이동 중 | ○ |
| `oauth_started` | 없음(서명해 들려보냄) | `shh_t` 쿠키 · `shh-nonce` | 없음 | 제공자 복귀 | `shh_t`(10분 만료) | 제공자 동의 화면 | ○ |
| `provider_verified` | `provider_subject` (메모리에만) | `shh_t` | 없음 | 계정 조회 결과 | `shh_t` 즉시 폐기 | — | ○ |
| `existing_user` | `uid` | — | 없음 | 세션 발급 | — | "이미 가입되어 있어 로그인했어요" | — |
| `signup_required` | 없음(subject 폐기) | — | **없음** | 사용자가 가입 화면으로 | `shh_t` | "아직 가입하지 않으셨어요" | ○ |
| `account_and_policy_events_created` | `uid`·`pv` | — | `users` 1행 + `policy_events` 3행 (**한 batch**) | batch 성공 | — | — | — |
| `session_issued` | `uid` | `shh_s` 쿠키 | `sessions` 1행 | — | — | "가입했어요" | — |
| `active` | `uid` | `shh_s`·`shh-via`·`shh-me` | — | — | — | 앱 | — |

### 3-3. 실패·중단 상태

| 상태 | 언제 | 서버 동작 | DB | 브라우저에서 지울 것 | 사용자 문구(안) | 재시도 |
|---|---|---|---|---|---|---|
| OAuth 거부 | 제공자 화면에서 취소 | `/cb` 가 `code` 없음 감지 | 없음 | `shh-nonce` | "로그인을 취소했어요" | ○ |
| state 만료 | 10분 초과 | 400 | 없음 | `shh_t` | "로그인 요청이 만료됐어요" | ○ |
| 브라우저 결속 실패 | `shh_t` 없음/불일치 | **code 교환 전** 400 + `clearTxn()` | 없음 | `shh_t` | "이 기기에서 시작한 로그인이 아니에요" | ○ |
| 가입 중단 | 정책 화면에서 뒤로 | 아무 일도 없음 | 없음 | 없음(서버 상태 자체가 없다) | — | ○ |
| 정책 문서 변경 | `pv` != 현재 번들 | `/signup/start` 409 `policyStale` · 콜백에서도 409 | 없음 | 화면 다시 읽기 | "방침이 바뀌었어요. 다시 확인해 주세요" | ○ |
| 가입 요청 만료 | state 10분 초과 | 위 state 만료와 같다 | 없음 | `shh_t` | 같음 | ○ |
| 중복 탭 | 두 탭이 가입 시작 | `shh_t` 는 한 칸 → 먼저 시작한 탭이 실패 | 없음 | `shh_t` | "다시 눌러 주세요" | ○ |
| 계정 생성 충돌 | 두 기기 동시 첫 가입 | `ON CONFLICT DO NOTHING` → 재조회 | `users` 1행 | — | 정상 가입 | — |
| 정책 이벤트 INSERT 실패 | batch 중 오류 | **batch 전체 롤백** → 계정도 안 생김 | 없음 | — | "가입하지 못했어요. 다시 시도해 주세요" | ○ |
| 세션 발급 실패 | batch 성공 후 `newSession` 실패 | 500 | 계정·이벤트 **있음**, 세션 없음 | — | "가입은 됐어요. 다시 로그인해 주세요" | ○ (다음 로그인이 기존 사용자 경로로 성공) |
| 기존 계정 발견 | 가입 경로인데 이미 계정 | 세션 발급, **이벤트 안 만듦** | 없음 | — | "이미 가입되어 있어 로그인했어요" | — |
| 탈퇴 직후 재가입 | 같은 제공자 계정 | 신규로 판정 → 새 UUID + 새 이벤트 | 새 행 | — | 정상 가입 | — |
| 오래된 앱 버전 요청 | 옛 PWA 가 `GET /login` 만 안다 | 신규면 `signup_required` 로 돌려보냄 | **없음** | — | "앱을 새로고침해 주세요" | ○ |

> **「세션 발급 실패」가 유일하게 중간 상태를 남긴다.** 계정과 이벤트는 있고 세션만 없다.
> 이것을 batch 에 넣지 않는 이유: `newSession` 은 만료 세션 청소까지 하는 별도 batch 이고,
> 하나로 묶으면 청소 실패가 가입 실패가 된다. 남는 상태가 **안전한 쪽**이다 — 다시 로그인하면
> 기존 사용자로 붙는다. 반대(세션은 있는데 계정이 없다)는 절대 생길 수 없다.

---

## 4. 가입 시점 대안 비교

세 안 모두 **현재 코드에 대입해서** 적었다.

### A안 — OAuth 전에 가입 화면

정책 수락을 **서명된 `state` 에 실어** OAuth 왕복을 건넌다. `makeState()` 는 이미
`[provider, back, exp, nonce, txn]` 를 HMAC 서명하고 있으므로 여섯 번째 칸 `pv` 를 더하면 된다
(`takeState()` 의 구조분해는 옛 state 에 대해 `undefined → ""` 로 안전하다).

- **임시 저장소가 필요 없다.** pending 테이블도, 암호화 쿠키도, 제공자 회원번호 보관도 없다.
- 문제: **기존 사용자도 가입 화면을 보게 된다.** 진입점이 하나면 피할 수 없다.

### B안 — OAuth 후 가입 화면

OAuth 로 `provider_subject` 를 얻은 뒤 계정을 만들지 않고 가입 화면을 띄운다. 그 사이
`provider_subject` 를 **어딘가 보관해야 한다** — 이것이 B안의 전부다(§6).

- 기존 사용자 경험이 가장 짧다.
- 대가: 임시 개인정보 · 탈취/재사용/만료/중복 제출 · 정리 작업 · 서버 상태 증가.
  pending 을 D1 에 두면 **Time Travel 이 그 pending 까지 복원**한다.

### C안 — 로그인과 회원가입 완전 분리

진입점을 둘로 나눈다. 가입 경로는 A안 그대로(정책 → OAuth → 생성), 로그인 경로는 계정을
만들지 않고 신규면 되돌려 보낸다.

- 신규 사용자가 로그인 버튼을 먼저 누르면 OAuth 왕복이 **한 번 헛돈다.**
- 그 대신 기존 사용자는 정책 화면을 다시 보지 않는다.

### 비교표

| 기준 | A | B | C (= A + 진입점 분리) |
|---|---|---|---|
| 보안(새 공격면) | 없음 | **가입 대기 토큰 하나가 통째로 새 공격면** | 없음 |
| 구현 복잡도 | 낮음 | 높음 | 낮음(+버튼 하나·분기 하나) |
| 사용자 이해도 | 낮음 — 기존 사용자가 매번 약관을 본다 | 높음 | 중간 — "가입/로그인"을 구분해야 한다 |
| OAuth 왕복(신규) | 1 | 1 | 1 (로그인 버튼을 먼저 누르면 2) |
| OAuth 왕복(기존) | 1 | 1 | 1 |
| 새 DB 테이블 | 0 | **1 (`pending_signups`)** 또는 0(쿠키안) | 0 |
| 개인정보 임시 저장 | **없음** | `provider_subject` 를 최소 수 분 보관 | **없음** |
| 재생 공격 | `code` 1회용이 막는다 | pending 토큰 재사용을 따로 막아야 한다 | `code` 1회용이 막는다 |
| 동시 가입 | UNIQUE 충돌로 수렴 | 같음 + pending 중복 제출 | UNIQUE 충돌로 수렴 |
| 기존 사용자 호환 | 나쁨(전원 정책 화면) | 좋음 | 좋음 |
| 장애 복구 | 서버 상태 0이라 정리할 것이 없다 | pending 청소 필요 | 서버 상태 0 |
| 테스트 비용 | 낮음 | 높음(만료·재사용·중복·정리) | 낮음~중간 |
| 이 규모에 적합한가 | 부분적 | **과함** | **적합** |

### 권고 — **C안**

이유 셋.

1. **임시 개인정보가 0이다.** B안이 지불하는 값(제공자 회원번호 임시 보관, 토큰 탈취·재사용·만료,
   Time Travel 이 pending 까지 복원하는 문제)을 전부 안 낸다. 최소수집 원칙과도 같은 방향이다.
2. **이미 있는 자물쇠를 그대로 쓴다.** 정책 수락은 우리가 HMAC 서명한 `state` 를 타고 건너오고,
   그 서명은 지금 로그인 CSRF 를 막고 있는 바로 그 자물쇠다. 새 비밀값도, 새 테이블도 없다.
3. **기존 사용자를 괴롭히지 않는다.** A안의 유일한 약점이 진입점 하나뿐인 것인데, 버튼 하나와
   분기 하나로 해결된다.

**C안의 대가**는 명시한다: 신규 사용자가 「로그인」을 먼저 누르면 제공자 동의를 한 번 헛하게 된다.
현재 사용자 0명이고, 게이트에서 **「가입하기」를 주 버튼으로** 두면 실제 발생률은 낮다.

> 사용자 최종 선택 대기 — §17 결정 1.

---

## 5. C안 상세 흐름

```
① 게이트         [ 가입하기 ]  [ 로그인 ]  [ 로그인 없이 둘러보기 ]

② 가입 화면      GET /api/policies  →  { pv, docs:{terms:{path,hash}, privacy:{…}, age14:{…}} }
                 클라이언트가 각 path 를 fetch 해 **내용을 직접 해시**하고 서버 값과 대조
                 ├ 다르면 → 가입 버튼을 그리지 않는다("앱을 새로고침해 주세요")   ← fail-closed
                 └ 같으면 → 문서를 화면에 렌더하고 체크박스 2개 + 제공자 3개

③ 제출           POST /api/signup/start   { provider, terms:true, age14:true, pv }
                 서버: Origin 검사(기존 :830-839) · signup 버킷 · pv == 현재 번들 · 두 값 모두 true
                 → Set-Cookie shh_t · state = sign([provider, back, exp, nonce, sha256(txn), pv])
                 → { url: "<제공자 authorize URL>" }   앱이 그 주소로 이동

④ 복귀           /api/cb/:provider  또는  /api/exchange/:provider   (지금 코드 그대로)
                 limited(login) → takeState → bound(shh_t)  ← 전부 code 교환 **전에**

⑤ 판정           verifyProvider() → { name, subject }        ← 계정을 만들지 않는다
                 findUser(name, subject)
                 ├ 있다  → newSession()                      (pv 는 무시. 이벤트 없음)
                 └ 없다
                    ├ state 에 pv 있음 → pv 재검사 → createAccountWithPolicy() → newSession()
                    └ pv 없음(로그인 경로) → signup_required (아무것도 안 만든다)
```

`POST /signup/start` 를 GET 링크(`/login/kakao?pv=…`)로 대신하지 않는 이유: 그러면
**남이 보낸 링크 하나가 약관 수락과 연령 진술을 만들어낸다.** 사용자는 가입 화면을 본 적이 없는데
기록에는 "수락함"이 남는다. POST 는 이미 있는 Origin 검사(`:830-839`)에 자동으로 걸린다.

### 5-1. 계정 생성 batch (동시 가입까지 포함)

```sql
-- ① 내 후보 id 로 넣어 본다. 진 쪽은 아무 행도 안 만든다.
INSERT INTO users (id, provider, provider_subject, session_version, created_at)
VALUES (?myId, ?provider, ?subject, 0, ?now)
ON CONFLICT (provider, provider_subject) DO NOTHING;

-- ② 이벤트는 **내가 실제로 이겼을 때만** 들어간다.
INSERT INTO policy_events (user_id, kind, action, document_version, recorded_at)
SELECT ?myId, 'terms', 'accepted', ?termsHash, ?now
 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?myId);
-- (privacy / age14 도 같은 모양으로 2행 더)
```

셋(또는 넷)을 **한 `batch()`** 로 보낸다. D1 의 `batch` 는 하나의 트랜잭션이고 중간 실패는 전체
롤백이다(공식 문서: <https://developers.cloudflare.com/d1/worker-api/d1-database/>).

- 이긴 쪽: `users` 1행 + `policy_events` 3행.
- 진 쪽: `users` 0행 + `WHERE EXISTS` 가 거짓이라 `policy_events` 0행. **중복 이벤트가 안 생긴다.**
- batch 뒤 `SELECT id FROM users WHERE provider=? AND provider_subject=?` 로 실제 id 를 얻어
  그 id 로 세션을 만든다(`internalUid()` 가 이미 쓰는 무늬 그대로).

`policy_events` 에 `UNIQUE` 를 걸지 않는다: 정책이 바뀌어 기존 사용자에게 재확인을 받는 날
같은 `kind` 가 여러 행 있어야 한다.

### 5-2. `internalUid()` 분해

지금 한 함수가 **조회와 생성**을 같이 한다(`:511-526`). 다음 여섯 역할로 나눈다.
계층을 새로 만들지 않는다 — 전부 `worker/index.js` 안의 함수다.

| 역할 | 새 이름(안) | 하는 일 | 부작용 |
|---|---|---|---|
| 제공자 확인 | `verifyProvider(env, name, code, state)` | 토큰 교환 → `/me` → `{name, subject}` | **없음** |
| 기존 사용자 조회 | `findUser(env, name, subject)` | `SELECT id` | 없음 |
| 계정+정책 생성 | `createAccountWithPolicy(env, name, subject, bundle)` | 위 batch → 재조회 → `id` | `users`·`policy_events` |
| 세션 발급 | `newSession(env, uid)` | 지금 그대로 | `sessions` |
| 정책 번들 조회 | `policyBundle(env)` | 서버 상수 반환 | 없음 |
| 삭제 표식 | §10·§11 | | 별도 저장소 |

`internalUid()` 는 **삭제한다.** 남겨 두면 "조회와 생성을 같이 하는 함수"가 계속 존재해서
누군가 다시 부른다. `scripts/test-friends.mjs` 가 이 함수를 직접 쓰므로(`signUp` 헬퍼)
테스트도 `createAccountWithPolicy` 로 옮겨야 한다 — §13 에 적었다.

---

## 6. 가입 대기 상태 — B안을 고를 경우에만

C안을 고르면 이 절 전체가 필요 없다. B안 검토용으로 남긴다.

### 방식 1 — 인증·암호화된 HttpOnly 쿠키

| 항목 | 요구 |
|---|---|
| 암호화 | **서명만으로는 안 된다.** 서명 쿠키는 내용이 평문이라 `provider_subject` 가 브라우저·프록시·로그에 그대로 보인다. AES-GCM 등 **인증된 암호화** 필요 |
| 키 | 전용 `SIGNUP_KEY`. `STATE_KEY`·`RL_KEY`·OAuth secret **재사용 금지** |
| 만료 | 10분 이하. 평문에 만료 시각을 넣고 **복호화 후 다시 검사** |
| nonce | 요청마다 무작위 12바이트. 재사용 금지 |
| 속성 | `HttpOnly; Secure; SameSite=Lax; Path=/api/signup` (지금보다 좁게) |
| 결속 | `shh_t` 와 묶는다 — 쿠키 안에 `sha256(shh_t)` 를 넣어 다른 브라우저로 옮기면 못 쓰게 |
| 1회용 | **쿠키 삭제만으로는 보장되지 않는다.** 삭제 지시는 브라우저에게 하는 부탁이고, 복사해 둔 값은 만료 전까지 다시 쓸 수 있다. 진짜 1회용을 원하면 서버 상태가 필요하다 → 방식 2 |

### 방식 2 — 서버측 `pending_signups`

| 항목 | 요구 |
|---|---|
| 토큰 | 원본 저장 금지. `SHA-256(token)` 만 (세션과 같은 규칙) |
| `provider_subject` | 평문 저장 금지 — 암호화하거나 HMAC. 그러면 조회 방식이 달라진다 |
| 만료·1회용 | `expires_at` + 소비 시 `DELETE … WHERE` 한 문장(읽고 나서 지우면 두 번 소비된다) |
| 청소 | 크론이 없다 → `newSession()` 이 하는 것처럼 다음 로그인에 붙인다 |
| 결속 | 계정 생성과 소비를 **같은 batch** 안에 |
| **Time Travel** | 복원하면 **소비된 pending 이 되살아난다.** 만료가 지났으면 무해하지만, 만료 전 복원이면 재사용 창이 열린다 |
| 개인정보 | 테이블 하나가 통째로 늘고, 그 안이 제공자 회원번호다 |

### 방식 3 — 임시 상태 자체 제거 (A/C안)

가능하다. §4·§5 가 그 설계다. **권고는 방식 3** 이다 — 가장 적은 임시 개인정보, 가장 적은 상태.
대가는 §4 에 적은 "신규 사용자가 로그인 버튼을 먼저 누르면 왕복 한 번 헛돔"뿐이다.

> 사용자 최종 선택 대기 — §17 결정 2 (결정 1에 종속).

---

## 7. 정책 문서와 `document_version`

### 7-1. 구조

```
policies/
  manifest.json                 ← 종류 · 파일 경로 · SHA-256 · 번들 정의
  terms-<hash12>.html           ← 이용약관 전문 (불변)
  privacy-<hash12>.html         ← 개인정보처리방침 전문 사본 (불변)
  age14-<hash12>.txt            ← 연령 진술 문구 (불변)
  summary-<hash12>.txt          ← 가입 화면 요약 (불변)
```

- **기존 버전 파일을 절대 덮어쓰지 않는다.** 고칠 때는 새 파일 + manifest 엔트리 추가.
- manifest 엔트리는 **불변**이다. 추가만 허용하고 수정·삭제는 테스트가 실패시킨다.
- `pv`(번들 id) = `SHA-256(정렬된 "kind:hash" 줄들)` 의 앞 12자.
- 서버는 현재 번들을 상수로 들고 있고, **manifest 에 등록된 해시만** 기록한다.
- `document_version` = 그 kind 의 **불변 파일 내용 해시**. `recorded_at` = 서버의 `Date.now()`.

### 7-2. 8개 질문에 대한 답

| # | 질문 | 답 |
|---|---|---|
| 1 | 전문과 요약이 다르면 무엇의 해시를 기록하나 | **전문의 해시.** 요약은 같은 번들에 묶인 별도 불변 파일이고, manifest 엔트리가 불변이라 `pv` 로 "그때 무슨 요약을 봤는지"가 재현된다. 요약만 고쳐도 새 파일·새 엔트리·새 `pv` 가 된다 |
| 2 | 전문을 안 열고 체크만 해도 수락으로 기록할 수 있나 | **법률 검토 필요**(L8 — `docs/PRIVACY_LEGAL_REVIEW_PACKET.md`). 설계는 두 경우를 다 지원한다 — 강제 열람이 필요하면 [전문] 클릭을 체크박스 활성 조건으로 두면 된다. Claude 가 판정하지 않는다 |
| 3 | 연령 진술 문구도 불변 파일인가 | **그렇다.** 화면에 뜨는 그 한 문장이 곧 진술 대상이라, 문장이 바뀌면 진술의 뜻이 바뀐다 |
| 4 | manifest 를 클라이언트가 위조할 수 없나 | **위조는 가능하지만 소용이 없다.** 기록되는 값은 언제나 서버 상수이고, 클라이언트가 보내는 `pv` 는 **일치할 때만 통과하는 문지기**로만 쓰인다. 클라이언트가 `document_version` 이나 `recorded_at` 을 지정하는 자리는 없다(2단계 §5 요구 5·6 유지) |
| 5 | 서버 코드와 정적 파일이 다른 배포 세대가 되면 | **될 수 없다.** 한 Pages 프로젝트라 `dist/` 와 `functions/` 가 같은 배포 단위로 나간다. 그래도 `scripts/test-policies.mjs` 가 배포 전에 서버 상수 == manifest == 실제 파일 해시를 대조한다 |
| 6 | 서비스워커가 옛 정책을 캐시한 상태로 가입할 수 있나 | **두 겹으로 막는다.** ① 클라이언트가 자기가 렌더할 파일을 fetch 해 **직접 해시**하고 `GET /api/policies` 값과 다르면 가입 버튼을 안 그린다(fail-closed) ② 그래도 뚫리면 서버가 `pv` 불일치로 409. 화면이 옛 문서를 보여주고 서버가 새 해시를 기록하는 상태는 **어느 한쪽만 뚫려도 생기지 않는다** |
| 7 | 옛 버전 파일을 빌드 allowlist 에 어떻게 넣나 | `scripts/build.mjs` 의 `INCLUDE` 에 `"policies"` 폴더를 통째로 넣는다. 폴더 통째로는 원래 위험하지만 이 폴더는 **공개 목적의 불변 문서 전용**이다. 대신 `test-dist` 가 `policies/` 안에 `.html/.txt/.json` 외 확장자가 있으면 실패시킨다. 그리고 SW `ASSETS` 에는 **현재 번들 파일만** 넣는다(옛 버전까지 선캐시하면 캐시가 계속 자란다) |
| 8 | 문서가 바뀌었는데 서버 상수가 그대로면 어떤 테스트가 실패하나 | `scripts/test-policies.mjs` 의 "서버 상수 == manifest == 파일 해시" 대조. 하나라도 어긋나면 실패. 추가로 `test-dist` 가 SW 선캐시 목록과 현재 번들 파일이 같은지 본다 |

### 7-3. `privacy.html` 과 `policies/privacy-<hash>.html` 의 관계

지금 `privacy.html` 은 내용이 바뀌는 **살아 있는 파일**이라 그대로는 `document_version` 의 대상이
될 수 없다. 규칙:

- 방침을 고칠 때마다 **고친 결과를 `policies/privacy-<hash12>.html` 로 복사**하고 manifest 에 추가한다.
- `privacy.html` 은 항상 **가장 최근 사본과 내용이 같아야 한다** — `test-policies` 가 대조한다.
- 두 파일 관리가 번거롭다는 것은 사실이다. 대안(하나로 두고 Git 이력에 기대기)은 **사용자가
  실제로 본 바이트를 재현할 수 없다** — Git 이 없는 사람에게 보여줄 수 없고, 우리 기록의
  검증 가능성이 저장소 이력에 묶인다. 두 벌을 유지하되 **테스트가 어긋남을 막는 쪽**을 택한다.

---

## 8. `policy_events` 법률 분기

**아직 migration 을 만들지 않았다.** 두 분기를 나란히 둔다.

### 분기 ①: 계약 이행(제15조 제1항 제4호)이 인정되는 경우

```sql
CHECK (
  (kind = 'terms'   AND action = 'accepted') OR
  (kind = 'privacy' AND action = 'presented') OR
  (kind = 'age14'   AND action = 'attested')
)
```

| 항목 | 내용 |
|---|---|
| UI 체크박스 | 2개 — 「(필수) 이용약관에 동의합니다」·「(필수) 만 14세 이상입니다」 |
| 방침 | 체크박스 없이 **요약 + 전문 링크**를 화면에 표시 |
| 거부 시 | 가입 불가(필수 두 개). 방침은 거부 대상이 아니다 |
| 철회 | 개인정보 동의가 아니므로 "동의 철회"라는 행위가 없다. 처리 중단은 **계정 삭제**다 |
| 계정 삭제 시 | 확인 필요(L5) |
| 보존기간 | 확인 필요(L5) |
| 기존 사용자 재확인 | 약관 개정 시에만 |
| 방침 문구 변경점 | `privacy.html:126-127` 의 "동의" 표현을 **처리 근거 = 계약의 이행**으로 고쳐야 한다 |

### 분기 ②: 개인정보 동의(제15조 제1항 제1호)가 필요한 경우

```sql
CHECK (
  (kind = 'terms'   AND action = 'accepted') OR
  (kind = 'privacy' AND action = 'accepted') OR
  (kind = 'age14'   AND action = 'attested') OR
  (kind = 'xborder' AND action = 'accepted')     -- 제28조의8 제1항 제1호일 때만
)
```

| 항목 | 내용 |
|---|---|
| UI 체크박스 | 3개 또는 4개. 「전체 동의」 단일 체크박스는 **두지 않는다**(제22조 제1항 구분 동의) |
| 거부 시 | 필수 항목 거부 → 가입 불가. **선택 항목 거부 → 서비스 거부 금지**(제22조 제5항) |
| 철회 | 철회 경로가 필요하다 → `withdrawn` action 을 `CHECK` 에 넣을지 확인 필요 |
| 계정 삭제 시 | 확인 필요(L5) |
| 보존기간 | 확인 필요(L5) |
| 기존 사용자 재확인 | 근거가 바뀌면 전원 재확인이 필요할 수 있다 — 확인 필요 |
| 방침 문구 변경점 | 동의 항목 구분·거부 시 불이익·철회 방법을 방침에 적어야 한다 |

### 두 분기 공통 — 반드시 알아야 할 기술적 사실

> **정책 이벤트를 계정 삭제 후에도 보존해야 한다는 결과가 나오면, `policy_events` 는
> `users` 를 외래키로 참조할 수 없다.**
>
> `scripts/test-migrations.mjs:96-103` 은 `users` 를 참조하는 **모든** 외래키가
> `ON DELETE CASCADE` 인지 전수 검사한다. 계정 삭제가 `DELETE FROM users` 한 문장인 것이
> 그 검사의 존재 이유다(2026-08-16 에 닫은 P0). 보존이 필요하면 선택지는 둘뿐이다:
>
> - (a) `policy_events` 에서 `users` 참조를 떼고 **가명 키**(§10 의 표식과 같은 성격)를 쓴다
> - (b) 정책 이벤트를 주 D1 밖(삭제 표식 저장소)으로 옮긴다
>
> 어느 쪽이든 **스키마가 통째로 달라진다.** 그래서 L5 의 답이 나오기 전에 migration 을 만들면
> 버리는 일이 된다. 2단계 §4 의 판단이 여기서 다시 확인된다.

---

## 9. 삭제 표식 저장소 비교

legacy KV 는 후보가 아니다(2단계 §11 에서 폐기하기로 한 자원이다).

| 기준 | 별도 D1 | 새 전용 KV | R2 최소 로그 | Durable Object | 저장소 없음(복원 금지) |
|---|---|---|---|---|---|
| 일관성 | 강함 | **최종 일관성**(list 60초) | 강함(read-after-write) | 강함 | — |
| 쓰기 성공 확인 | SQL 결과로 확실 | put 성공 ≠ 즉시 조회 가능 | 확실 | 확실 | — |
| 목록·조회·정리 | SQL 한 줄 | `list()` 훑기 | `list()` + 객체 읽기 | 코드로 직접 | — |
| 비용 | [?] 플랜별 DB 개수·쓰기 한도 **미확인** | [?] 미확인 | [?] 미확인 | [?] 미확인 | 0 |
| 운영 복잡도 | 낮음(`wrangler d1 execute`) | 중간 | 중간 | 높음 | **가장 낮음** |
| 주 D1 복원과 독립 | ○ | ○ | ○ | ○ | — |
| 표식 자체의 복원 위험 | Time Travel 이 **표식도** 되살린다(그러나 표식이 되살아나는 것은 안전한 방향) | 없음 | 없음 | — | — |
| 보유기간 삭제 | `DELETE … WHERE expires_at < ?` | TTL 로 자동 | 수동 | 코드 | — |
| 개인정보 최소화 | HMAC 값 하나 | 같음 | 같음 | 같음 | 최소 |
| 재식별 위험 | **있다**(복원된 DB 와 대조하면 특정 가능 — §11) | 같음 | 같음 | 같음 | — |
| 복원 시 전체 대조 비용 | `users` 를 페이지로 읽어 HMAC — 사용자 수에 비례 | 같음 | 같음 | 같음 | — |
| 현재 규모(0명)에 적합 | ○ | △ | △ | ✗ | ○ |

### 권고 — **별도 D1** (단, "복원 금지" 절차와 **함께**)

- SQL 이라 조회·정리·대조가 전부 한 줄이고, `wrangler d1 execute` 로 운영자가 직접 볼 수 있다.
- KV 는 **쓰기 성공 확인이 약하다.** saga 의 1단계가 "확실히 적혔나"에 달려 있는데 그 확신을 못 준다.
- **[?] 비용과 플랜 조건은 확인하지 않았다.** 저장소를 실제로 만들기 **전에** Cloudflare 대시보드에서
  현재 플랜의 D1 개수 한도·쓰기 한도, Durable Objects 사용 조건을 확인한다. D1 플랜(Time Travel
  7일/30일)이 아직 미확인인 것과 같은 항목이라 **한 번에 같이 확인한다**(2단계 §12).
- "저장소 없음(복원 자체를 금지)"은 사용자 수가 적은 지금 **실효가 있다.** 다만 복원이 필요한 사고
  (데이터 손상)가 실제로 나면 **복원 없이는 못 고치고**, 그때 탈퇴자가 부활한다. 그래서 권고는
  둘을 겹치는 것이다 — 표식을 두되, 표식이 있어도 **복원은 여전히 승인 사항**으로 남긴다.

### 별도 D1 을 골랐을 때 반드시 다룰 함정

**주 D1 과 별도 D1 사이에는 공통 트랜잭션이 없다.** 그래서 계정 삭제는 원자적 트랜잭션이 아니라
**saga** 다. 아래 §10 이 그 전부다.

---

## 10. 삭제 saga 와 복원 절차

### 10-1. 표식 스키마(안)

```sql
CREATE TABLE deletions (
  mark         TEXT PRIMARY KEY,      -- HMAC(DELETION_KEY_v<n>, internal_uid)
  key_version  INTEGER NOT NULL,
  pending_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL       -- pending_at + 30일 (2단계 §9-14)
);
CREATE INDEX deletions_expires ON deletions(expires_at);
CREATE INDEX deletions_open    ON deletions(confirmed_at, pending_at);
```

원본 제공자 ID·이메일·별명·단어장·세션을 **저장하지 않는다.** 저장하는 것은 HMAC 값 하나다.

| 규칙 | 내용 |
|---|---|
| 키 | 전용 `DELETION_KEY`. `RL_KEY`·`STATE_KEY`·OAuth secret **재사용 금지** |
| 키 버전 | `key_version` 컬럼. 회전하면 새 표식만 새 키로 만든다 |
| 회전 중 조회 | **보유기간(30일) 동안 옛 키를 지우지 않는다.** 대조할 때 `key_version` 에 맞는 키를 쓴다 |
| 만료 | `expires_at` 지난 행은 정리. 최대 복원 가능 기간(30일)을 넘긴 표식은 쓸모가 없다 |
| 백업 | 표식 저장소보다 **오래된 주 D1 백업을 만들지 않는다**(2단계 §10) |

### 10-2. saga 순서

```
1. pending 기록      INSERT INTO deletions (mark, key_version, pending_at, expires_at) …
2. 주 D1 삭제        DELETE FROM users WHERE id = ?          (한 문장 + CASCADE)
3. 부재 확인         SELECT 1 FROM users WHERE id = ?        → 없어야 한다
4. confirmed 기록    UPDATE deletions SET confirmed_at = ? WHERE mark = ?
```

### 10-3. 실패 매트릭스

`—` 는 앞 단계가 실패해 그 단계에 도달하지 않았다는 뜻이다.

| pending 기록 | 주 D1 삭제 | 부재 확인 | confirmed 기록 | 사용자 응답 | 다음 조치 |
|---|---|---|---|---|---|
| 실패 | — | — | — | **"지우지 못했어요"** (세션 유지) | 그 화면에서 재시도. 주 D1 은 손대지 않았다 |
| 성공 | 실패 | — | — | **"지우지 못했어요"** (세션 유지) | 재시도. pending 은 남되 **복원 시 삭제에 쓰지 않는다**(confirmed 만 쓴다) |
| 성공 | 성공(0행) | 부재 | 성공 | **"계정을 지웠어요"** | 다른 탭이 먼저 지웠다. 사용자가 원한 결과는 이뤄졌다 |
| 성공 | 성공 | **여전히 존재** | — | **"지우지 못했어요"** | 있을 수 없는 상태. 재시도 + 조사 대상 |
| 성공 | 성공 | 부재 | 실패 | **"계정을 지웠어요"** (계정은 실제로 없다) | reconciliation 이 pending → confirmed 로 승격 |
| 성공 | 성공 | 부재 | 성공 | **"계정을 지웠어요"** | 끝 |
| 성공 | 응답 전 Worker 중단 | — | — | 응답 없음 | 사용자는 다시 누른다. pending 은 `PRIMARY KEY` 라 중복이 안 생긴다. reconciliation 이 최종 상태를 정한다 |
| 성공(이미 있음) | — | — | — | 중복 삭제 요청 | `INSERT … ON CONFLICT DO NOTHING` → 같은 saga 를 이어서 진행 |
| — | — | — | — | 재가입자 | **새 UID → 새 HMAC.** 옛 표식과 절대 안 부딪힌다(§2 I9) |

### 10-4. reconciliation

**무엇을 하나**: `confirmed_at IS NULL` 인 표식마다, 주 D1 에 대응 계정이 아직 있는지 본다.

`mark` 는 HMAC 이라 역산할 수 없다. 그래서 반대로 간다 — **주 D1 의 `users.id` 를 페이지 단위로
읽어 각각 HMAC 하고**, 그 집합과 pending 표식을 대조한다.

| pending 표식이 | 뜻 | 조치 |
|---|---|---|
| 살아 있는 계정과 **일치** | 2단계(주 D1 삭제)가 실패했다 | 표식을 **삭제**한다. 계정은 살아 있고 사용자는 그것을 안다 |
| 어느 계정과도 **불일치** | 삭제는 됐고 4단계만 실패했다 | `confirmed_at` 을 기록(승격) |

- **실행 조건**: ① **모든 복원 직전에 필수** ② 삭제 응답에서 4단계 실패를 감지한 뒤 다음 기회
  ③ 운영자가 수동으로. 크론이 없으므로 자동 주기 실행은 없다.
- 재가입자의 새 UID 는 HMAC 이 다르므로 위 대조에 **원리적으로 걸리지 않는다.**
- **`pending` 은 어떤 경우에도 복원 후 삭제에 쓰지 않는다.** 2단계 §9-7 이 그 규칙이고,
  이유는 위 표 두 번째 줄이다 — 삭제가 실패해 계정을 계속 쓰고 있는 사람을 지워 버린다.

### 10-5. 복원 절차 (Time Travel · 수동 백업 공통)

| # | 단계 | 확인 |
|---|---|---|
| 1 | **유지보수 모드** 진입 — `MAINTENANCE=1` 이면 모든 상태 변경이 503 | `/api/ready` 로 확인 |
| 2 | 복원 **전** bookmark 기록(`wrangler d1 time-travel info`) 또는 현재 상태 백업 | 되돌릴 수단 확보 |
| 3 | **reconciliation 실행** — pending 정리·승격 (§10-4) | pending 0건이 목표 |
| 4 | 복원 실행 | — |
| 5 | 복원된 `users.id` 를 **페이지 단위**(예: 500행)로 읽어 HMAC → **confirmed 표식과 대조** | 일치 목록 확보 |
| 6 | 일치 계정 `DELETE FROM users WHERE id IN (…)` → CASCADE | **지운 행 수 == 일치 수** |
| 7 | 잔여 검사 — `books`·`friendships`·`invite_codes`·`sessions` 에 그 uid 가 0건 | 0이 아니면 재개 금지 |
| 8 | 서비스 재개 | — |

**감사 로그에 남기는 것**: 시각 · 복원 대상 시점 · 대조한 계정 수 · 일치 수 · 삭제 행 수 ·
키 버전 · 실행자. **남기지 않는 것**: 실제 `uid` · `provider_subject` · `mark` 원문 · 별명 · 단어.

> **표식을 「익명정보」라고 부르지 않는다.** 복원된 DB 와 대조하면 특정 개인을 가릴 수 있으므로
> **가명·최소 식별값**으로 취급한다. 법률 검토 자료에 이 성질을 그대로 적었다.

---

## 11. 보안 위협 모델

심각도: **C**ritical(계정 탈취·타인 데이터 노출) / **H**igh(기록 위조·삭제 무력화) / **M**edium.

| # | 위협 | 심 | 공격·실패 순서 | 막는 설계 | 필요한 회귀 테스트 | 남는 위험 |
|---|---|---|---|---|---|---|
| 1 | 공격자가 만든 OAuth callback 링크 | C | 공격자가 자기 `code&state` 링크를 피해자에게 보냄 | `bound()` — `shh_t` 쿠키 대조를 **code 교환 전에**(`:751`·`:781`). **이미 있다** | `test-friends` 76~84 유지 | 없음 |
| 2 | OAuth state 재사용 | M | 같은 state 를 두 번 제출 | `code` 가 1회용이라 제공자가 거부 | `test-signup`: 같은 state 2회 → 두 번째 실패 | state 자체는 1회용이 아니다(의도된 선택) |
| 3 | 브라우저 결속 쿠키 탈취 | C | `shh_t` 를 훔쳐 다른 브라우저에서 사용 | `HttpOnly`·`Secure`·10분 만료·`Path=/api` | 기존 | 기기 전체가 털린 경우는 못 막는다 |
| 4 | 가입 대기 토큰 탈취/재사용/만료 | C | — | **C안에는 그런 토큰이 없다** | — | B안을 고르면 §6 의 항목이 전부 살아난다 |
| 5 | 두 탭 동시 가입 | H | 두 탭이 같은 제공자 계정으로 동시 제출 | `UNIQUE(provider,provider_subject)` + `ON CONFLICT DO NOTHING` + `WHERE EXISTS` (§5-1) | `test-signup`: 동시 2건 → `users` 1행, `policy_events` 3행 | 없음 |
| 6 | 신규·기존 분기 경합 | H | 조회 직후 남이 먼저 만든다 | 판정을 **INSERT 문장 안**에 두고 batch 뒤 재조회 | 위와 같음 | 없음 |
| 7 | 계정만 생기고 정책 이벤트가 없음 | H | batch 중간 실패 | `batch()` = 단일 트랜잭션 → 전체 롤백 | `test-signup`: 이벤트 INSERT 강제 실패 → `users` 0행 | 없음 |
| 8 | 정책 이벤트만 있고 계정이 없음 | H | 위와 반대 | 같은 batch + `WHERE EXISTS` | 같음 | 없음 |
| 9 | 클라이언트가 `document_version` 위조 | H | 위조한 해시를 제출 | 서버는 **자기 상수만** 기록. 클라이언트 값은 문지기로만 | `test-signup`: 위조 `pv` → 409, DB 무변화 | 없음 |
| 10 | 클라이언트가 `recorded_at` 위조 | M | 시각을 실어 보냄 | 서버 `Date.now()` 만 사용. 본문의 시각 필드를 읽지 않는다 | `test-signup`: 시각 필드 무시 확인 | 없음 |
| 11 | 서비스워커가 옛 정책 문서 제공 | H | 옛 캐시의 방침을 보고 가입 | ① 클라이언트가 렌더할 파일을 해시해 서버 값과 대조(fail-closed) ② 서버 `pv` 불일치 409 | `test-policies` + `test-client`: 해시 불일치면 버튼 안 그림 | 사용자가 캐시를 못 지우면 가입을 못 한다(**안전한 실패**) |
| 12 | 가입 API CSRF | C | 남의 사이트가 `POST /signup/start` | 기존 Origin 검사(`:830-839`)가 모든 non-GET 에 적용 | `test-friends` 82·83 무늬로 `/signup/start` 추가 | 없음 |
| 13 | Origin 없는 가입 요청 | C | `curl` 로 Origin 없이 | 같은 검사가 **없는 것도 막는다** | 위와 같음 | 없음 |
| 14 | 외부 Origin 가입 요청 | C | 다른 도메인에서 | `allowed()` | 위와 같음 | 없음 |
| 15 | 가입 endpoint 레이트리밋 누락 | H | 가입 시작을 무한 반복 | **전용 `signup` 버킷.** `WRITE_ROUTES` 에 넣지 않는다(이중 계수 재발 방지) | `test-friends` 무늬로 한도 초과 429 | 공유 IP 는 한도를 나눠 쓴다 |
| 16 | 가입 취소 후 임시값 잔존 | M | 정책 화면에서 이탈 | **서버 상태가 없다.** `shh_t` 는 10분 만료 | `test-client`: 이탈 후 localStorage 잔존 0 | 없음 |
| 17 | 닉네임·정책 문구 XSS | C | `<script>` 를 별명에 | 별명은 `textContent` 로만 렌더(현재 규칙). 정책 문서는 **우리가 쓴 정적 파일** | `test-client`: `innerHTML` 사용 자리 검사 | 정책 파일에 스크립트를 우리가 넣으면 막을 것이 없다 → CSP 가 2차 방어 |
| 18 | 제공자 회원번호 로그 노출 | H | 오류 로그에 subject | 지금도 안 찍는다(`:481` `why()` 80자·`pathTemplate`) | `test-friends` 로그 검사 무늬 유지 | 없음 |
| 19 | 삭제 표식으로 계정 삭제 DoS | H | 남의 `mark` 를 위조해 삽입 | `mark` = HMAC(전용키, uid). 키도 uid 도 모른다. ledger 쓰기는 worker 만 | `test-deletion-ledger`: 임의 mark 는 대조에 안 걸림 | ledger 키가 새면 성립 → 키 회전 절차 |
| 20 | pending 을 confirmed 로 위조 | H | ledger 직접 조작 | ledger 접근 권한 = 운영자. 복원 절차가 **6단계에서 삭제 행 수를 검증** | `test-deletion-ledger`: pending 은 재삭제에 안 쓰임 | 운영자 권한 탈취는 못 막는다 |
| 21 | 복원 후 삭제 계정 부활 | C | 복원 실행 | §10-5 절차 전체 | `test-deletion-ledger`: 복원 시뮬레이션 → CASCADE 확인 | **절차를 안 지키면 그대로 성립한다**(도구가 아니라 절차다) |
| 22 | 키 교체 후 과거 표식 무효화 | H | 옛 키를 지움 | `key_version` + **보유기간 중 옛 키 삭제 금지** | `test-deletion-ledger`: 두 버전 혼재 대조 | 키를 실수로 잃으면 그 표식은 영구 무효 |
| 23 | 오래된 수동 백업 복원 | H | 30일보다 오래된 백업 | 2단계 §10 — 표식 보유기간보다 오래된 백업을 **만들지 않는다** | 자동 검사 불가(절차) | 절차 위반 시 성립 |
| 24 | 기존 앱 버전이 새 가입 API 를 잘못 호출 | M | 옛 PWA 가 `GET /login` 만 안다 | 신규면 `signup_required` 로 되돌림. **계정을 만들지 않는다** | `test-signup`: `pv` 없는 신규 → 계정 0행 | 옛 앱 사용자는 새로고침 전까지 가입 불가(안전한 실패) |
| 25 | OAuth 비활성 상태에서 신규 경로가 열림 | H | 시크릿 없이 배포 | `/login` 이 `id`·`STATE_KEY` 없으면 503(`:712`). `/signup/start` 도 같은 검사 | `test-signup`: 제공자 미설정 → 503 | 없음 |

---

## 12. 레이트리밋 · CSRF · 입력 검증

| 경로 | 메서드 | 인증 | Origin 검사 | CSRF | 버킷 | 기준 | 권고 한도 | 본문 | 허용 필드 |
|---|---|---|---|---|---|---|---|---|---|
| `/api/policies` | GET | 불필요 | — | 해당 없음 | 없음(안 센다) | — | — | — | — |
| `/api/signup/start` | POST | 불필요 | **필수** | Origin + 쿠키 없음 | `signup` | IP | **10/분** | ≤ 8KB(`MAX_BODY`) | `provider`·`terms`·`age14`·`pv` |
| `/api/login/:provider` | GET | 불필요 | — | state 서명 | 없음(현행 유지) | — | — | — | — |
| `/api/cb/:provider` | GET | 불필요 | — | state + `shh_t` | `login` | IP | 10/분(현행) | — | — |
| `/api/exchange/:provider` | GET | 불필요 | — | state + `shh_t` | `login` | IP | 10/분(현행) | — | — |
| 가입 취소 | — | — | — | — | — | — | — | — | **API 없음**(서버 상태가 없다) |

- **`/signup` 을 `WRITE_ROUTES` 에 넣지 않는다.** 넣으면 `write`(120) 와 `signup` 이 같은 요청을
  두 번 센다 — 2026-08-16 에 `auth`/`login` 이중 계수로 이미 겪은 실수다(`:700-703`).
- **`RL_MAX` 에 `signup: 10` 을 반드시 추가한다.** 안 넣으면 `?? RL_MAX.write` 로 조용히 120 이 된다.
- 응답: 형식 오류 400 · 정책 구식 409 `policyStale` · 한도 초과 429 · 제공자 미설정 503.
- **로그에 남길 수 있는 값**: 제공자 이름 · 실패 종류 · 경로 템플릿(`pathTemplate`).
- **로그 금지**: 가입 대기 토큰(있다면) · `provider_subject` · `pv` 나 문서 해시 **전체** ·
  `state` · `code` · `mark` · 별명 · IP 원문.

---

## 13. 테스트 명세 (이번 단계에서는 파일을 만들지 않는다)

### `scripts/test-signup.mjs` (신규)

`test-friends.mjs` 와 같은 방식 — `worker/index.js` 를 그대로 불러 진짜 sqlite(`_d1.mjs`) 위에서 돈다.

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 신규 OAuth 성공(로그인 경로, `pv` 없음) | `users` **0행**, 응답이 `signup_required` |
| 2 | 기존 사용자 로그인 | 세션 발급, `policy_events` 증가 0 |
| 3 | 신규 + 유효 `pv` | `users` 1행 + `policy_events` 3행 + 세션 |
| 4 | 약관 미체크 | `/signup/start` 400, DB 무변화 |
| 5 | 연령 미체크 | 400, DB 무변화 |
| 6 | 방침 `presented` 기록 | 분기 ① 기준 `action='presented'` 로 기록 |
| 7 | 잘못된 조합(`age14/accepted`) | `CHECK` 위반으로 INSERT 실패 → batch 롤백 |
| 8 | `state` 만료 | 400, DB 무변화 |
| 9 | `state` 재사용 | 두 번째 실패(교환 거부) |
| 10 | 두 탭 동시 가입 | `withLatency` 로 경합 재현 → `users` 1행·`policy_events` 3행 |
| 11 | 세션 고정 | `shh_t` 없는 콜백 → code 교환 **전** 400 |
| 12 | 가입 완료 후 새 세션 | 가입 전 쿠키로는 아무것도 안 된다 |
| 13 | 계정·이벤트 원자성 | 이벤트 INSERT 실패 주입 → `users` 0행 |
| 14 | Origin 없음/외부/허용 | 403·403·통과 |
| 15 | 가입 rate limit | 11번째 429 |
| 16 | 제공자 ID 비노출 | 응답 본문·로그에 `provider_subject` 0회 |
| 17 | 위조 `pv` | 409, DB 무변화 |
| 18 | 탈퇴 후 재가입 | 새 `users.id` != 옛 id |

### `scripts/test-policies.mjs` (신규)

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | 파일 해시 == manifest | 일치 |
| 2 | 파일을 고치고 manifest 를 그대로 | **실패** |
| 3 | 기존 manifest 엔트리 수정·삭제 | **실패**(엔트리 불변) |
| 4 | 서버 상수 == manifest 현재 번들 | 일치 |
| 5 | `privacy.html` == 최신 `policies/privacy-*.html` | 일치 |
| 6 | SW 선캐시 목록 == 현재 번들 파일 | 일치 |
| 7 | 미등록 `document_version` 제출 | 서버가 거부 |
| 8 | `pv` 계산이 파일 내용에만 의존 | 파일 한 글자 변경 → `pv` 변경 |

### `scripts/test-deletion-ledger.mjs` (신규)

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | pending 기록 실패 | 사용자 "지우지 못했어요", 주 D1 무변화 |
| 2 | 주 D1 삭제 실패 | 실패 응답, 세션 유지, pending 남음 |
| 3 | confirmed 기록 실패 | **성공 응답**(계정은 없다), pending 남음 |
| 4 | 중복 삭제 요청 | 표식 1개, saga 이어서 진행 |
| 5 | 재가입 | 새 UID 의 HMAC 이 옛 표식과 불일치 |
| 6 | pending 오삭제 방지 | 복원 후 재삭제에 pending 이 **안 쓰임** |
| 7 | confirmed 재삭제 | 복원 후 일치 계정 삭제 + CASCADE 0건 잔여 |
| 8 | 키 버전 | v1·v2 혼재 상태에서 둘 다 대조됨 |
| 9 | 만료 정리 | `expires_at` 지난 행 제거, confirmed 유효기간 내 보존 |
| 10 | 실제 UID 로그 비노출 | 로그 문자열에 uid 0회 |

**중간 상태를 실제로 만들 수 있는가**: 1·2·3은 ledger 핸들을 **주입 가능한 인자**로 두면
실패를 실제로 일으킬 수 있다. 7은 "복원"을 sqlite 두 인스턴스(삭제 전 스냅샷 / 현재)로
재현한다 — 진짜 Time Travel 은 못 부르지만 **재적용 로직 자체는 실제로 돈다**.
1·2·3을 정규식 소스 검사로 대신하지 않는다.

### 기존 테스트 중 손댈 것

| 파일 | 무엇 |
|---|---|
| `test-friends.mjs` | `signUp()` 헬퍼가 `internalUid()` 를 직접 쓴다 → `createAccountWithPolicy()` 로 교체. 156개 단언의 **의도는 그대로** 둔다 |
| `test-client.mjs` | 게이트에 가입/로그인 두 버튼 · 정책 해시 불일치 시 버튼 미표시 · `signup_required` 응답 처리 |
| `test-migrations.mjs` | `policy_events` 의 CASCADE(§8 의 분기에 따라 달라진다) · 새 `CHECK` 조합 검사 |
| `test-sw.mjs` | 정책 파일이 선캐시 목록에 있는지 |
| `test-dist.mjs` | `policies/` 가 `dist` 에 나가는지 · 그 안에 허용 확장자만 있는지 |
| `_d1.mjs` | ledger 용 두 번째 DB 핸들 지원(현재는 `makeD1()` 하나) |

---

## 14. 기존 사용자와 구버전 호환

**현재 0명이다. 구현 직전에 반드시 다시 조회한다**(2026-08-17 값은 그날의 사실일 뿐이다).

### 경우 A — 구현 직전에도 0명

- 전환 migration 없음. 첫 사용자부터 새 정책이 적용된다.
- 스키마와 코드를 **같은 배포에** 반영하고, 그 배포 **전까지** OAuth 를 켜지 않는다.

### 경우 B — 구현 직전에 1명 이상

| 항목 | 설계 |
|---|---|
| 흐름 | 기존 사용자 로그인 성공 → 세션은 발급 → **정책 화면**을 앱이 띄운다 |
| 정책 확인 전 허용 | 사전·연습·단어장 **읽기**, 로그아웃, 계정 삭제 |
| 정책 확인 전 차단 | `PUT /book` · `POST /friends` · `PUT /friends/:id` · `POST /friends/code` (모든 상태 변경) |
| 거부 시 | 로그아웃 또는 계정 삭제를 고르게 한다. 조용히 계속 쓰게 두지 않는다 |
| 기존 세션 | 유지한다. `session_version` 을 올리면 전원이 이유 없이 튕긴다 |
| 구버전 PWA | 새 API 를 모른다 → 서버가 차단하고 "앱을 새로고침해 주세요"로 답한다 |
| 서비스워커 세대 | 자산 해시가 캐시 이름에 박혀 있어(`shhh-v11-<해시>`) 배포와 함께 갈린다 |
| **"이벤트 없음"을 정상으로 오인하지 않는 법** | `users.created_at` 과 정책 도입 시각을 비교한다. 도입 **후**에 만들어진 계정에 이벤트가 없으면 **버그**이고, 도입 **전** 계정은 전환 대상이다. `policy_events` 유무만으로는 이 둘을 구분할 수 없다 |

---

## 15. 배포·migration 순서 (실행하지 않는다)

**아래는 전부 별도 사용자 승인 사항이다**: 새 D1 생성 · 삭제 표식 저장소 생성 · migration 적용 ·
KV 바인딩 제거 · KV 삭제 · 시크릿 등록 · OAuth 활성화 · 배포 · push · Time Travel restore ·
백업 생성·복원.

| # | 단계 | 승인 |
|---|---|---|
| 1 | 법률 검토 결과 반영(§8 분기 확정) | — |
| 2 | 최종 스키마 확정(`policy_events` `CHECK`·CASCADE·ledger) | — |
| 3 | **회귀 테스트 먼저 작성** (`test-signup`·`test-policies`·`test-deletion-ledger`) | — |
| 4 | 로컬 migration (`--local`) | — |
| 5 | 로컬 가입·삭제·복원 시뮬레이션 | — |
| 6 | `privacy.html`·이용약관·`brand/NAVER-REVIEW.md` 를 **같은 변경 단위**로 수정 | — |
| 7 | 전체 `npm test` + `npm audit` | — |
| 8 | **사용자 승인** | ✅ |
| 9 | 원격 사용자 수 재확인 | ✅ |
| 10 | 백업(저장소 밖·암호화 볼륨·24시간 뒤 삭제) | ✅ |
| 11 | 원격 migration (`0004` 포함 — 아직 원격에 없다) | ✅ |
| 12 | 시크릿 등록 — `RL_KEY` · `DELETION_KEY` · OAuth 8개 | ✅ |
| 13 | 배포 | ✅ |
| 14 | **배포 고유 주소**로 검증 | — |
| 15 | **canonical 주소**로 검증(`cf-cache-status`·`age` 까지 본다) | — |
| 16 | OAuth 실제 계정 테스트 | ✅ |
| 17 | 정책 이벤트가 실제로 3행 들어갔는지 확인 | — |
| 18 | 삭제·복원 절차 검증 — **테스트 전용 계정으로만** | ✅ |
| 19 | 구버전 서비스워커 확인(설치형 PWA 실기기) | — |
| 20 | 롤백 경로 확인 후 백업 폐기 | ✅ |

> **라이브 계정 삭제 시험은 사용자 데이터가 생긴 뒤에는 하지 않는다.** 18번은 테스트 전용
> 계정과 승인된 환경에서만 한다. 지금(0명)이 그 시험을 하기 가장 싼 시점이다.

---

## 16. 아키텍처 경계 — 바뀔 파일과 책임

새 계층을 만들지 않는다. 회원가입 하나 때문에 Worker 를 다시 쓰지 않는다.

| 파일 | 계층 | 이번에 지는 책임 | 새 파일인가 |
|---|---|---|---|
| `js/auth.js` | 입력·화면 | 게이트에 「가입하기/로그인」 분리 · 정책 화면 렌더 · 체크박스 · `signup_required` 처리 · 정책 해시 대조 결과에 따른 fail-closed | 기존 |
| `js/authApi.js` | 데이터·외부 접근 | `apiPolicies()` · `apiSignupStart()` 추가. **`fetch` 는 계속 이 파일에만** | 기존 |
| `worker/index.js` | 서버 경계 | `POST /signup/start` · `GET /policies` · `verifyProvider`/`findUser`/`createAccountWithPolicy` 분해 · `RL_MAX.signup` · 정책 상수 · 삭제 saga | 기존 |
| `worker/schema.sql` | DB | `policy_events` (분기 확정 후) | 기존 |
| `migrations/0005_*.sql` | DB | 같은 내용의 버전형 migration | **신규** |
| `policies/` | 정적 | 불변 정책 문서 + manifest | **신규** |
| `scripts/build.mjs` | 빌드 | `INCLUDE` 에 `policies` 추가 | 기존 |
| `service-worker.js` | 캐시 | `ASSETS` 에 현재 번들 파일 추가 | 기존 |
| `functions/api/[[path]].js` | 연결부 | **변경 없음**(로직을 복사하지 않는다) | 기존 |
| ledger DB(별도) | DB | `deletions` 테이블 | **신규**(승인 후) |
| `privacy.html` | 정적 | §14 불일치 7건 — 법률 근거 확정 후 같은 변경 단위 | 기존 |

정책 화면의 판단(무엇을 보여줄지·언제 fail-closed 할지)이 순수 함수로 떨어지면
`test-client` 가 화면 없이 잰다 — `syncPlan()` 과 같은 무늬다.

---

## 17. 사용자 결정 요청 (6건)

### 결정 1 — 가입 흐름

| | A: OAuth 전 가입 화면 | B: OAuth 후 가입 화면 | **C: 로그인·가입 완전 분리** |
|---|---|---|---|
| 쉬운 예시 | 문 앞에서 약관을 읽고 들어간다. **단골도 매번 읽는다** | 일단 들어온 뒤 신규면 서류를 쓴다. 그동안 **신분증을 맡아 둔다** | 문이 둘이다. 단골 문 / 신규 문 |
| 보안 | 좋음 | **가입 대기 토큰이 새 공격면** | 좋음 |
| 사용자 경험 | 기존 사용자가 매번 약관 화면 | 가장 매끄러움 | 신규가 로그인 문을 먼저 열면 왕복 1회 헛돔 |
| 개발·운영 | 낮음 | **높음**(테이블·만료·청소·복원 영향) | 낮음 |
| **Claude 권고** | | | ✅ **C** |

**권고 이유**: 임시 개인정보를 하나도 안 만들고, 정책 수락을 이미 있는 `state` 서명(지금 CSRF 를
막고 있는 그 자물쇠)에 실어 보내면 새 테이블도 새 비밀값도 필요 없다. 대가는 신규 사용자의
왕복 1회이고, 사용자 0명인 지금 그 비용은 사실상 0이다.

**결정하지 않으면 막히는 것**: `worker/index.js` 라우트 설계, `js/auth.js` 게이트, `test-signup` 전부.

### 결정 2 — 임시 가입 상태 (결정 1이 B일 때만 의미가 있다)

| | 1: 암호화 쿠키 | 2: 서버 `pending_signups` | **3: 임시 상태 제거** |
|---|---|---|---|
| 쉬운 예시 | 봉인한 봉투를 손님이 들고 다닌다 | 프런트에 번호표를 맡긴다 | 맡길 것을 아예 안 만든다 |
| 보안 | 복사본 재사용을 완전히 막지 못함 | 1회용 보장 가능, 대신 상태가 는다 | 공격면 없음 |
| 개인정보 | 회원번호를 암호화해 보관 | 회원번호를 DB 에 보관 | **보관 없음** |
| 복원 영향 | 없음 | **Time Travel 이 pending 도 되살린다** | 없음 |
| **Claude 권고** | | | ✅ **3** (결정 1 = C 이면 자동) |

### 결정 3 — 정책 이벤트의 법적 분기 — **사용자가 추측해서 고르지 않는다**

`privacy/presented`(계약 이행) 인가 `privacy/accepted`(동의) 인가, 국외 이전 별도 동의가
필요한가. **외부 법률 검토 전에는 구현을 보류한다**는 것이 Claude 의 권고다.

전달할 질문과 사실은 `docs/PRIVACY_LEGAL_REVIEW_PACKET.md` 에 있다.
**결정하지 않으면 막히는 것**: `policy_events` 의 `CHECK`, migration, 가입 화면 체크박스 수,
`privacy.html` §14 의 5·6번 문장.

### 결정 4 — `policy_events` 의 계정 삭제 시 처리 — **법률 검토 필요**

| | CASCADE(계정과 함께 삭제) | 보존(기간 확인 필요) |
|---|---|---|
| 개인정보 | 최소수집에 부합 | 탈퇴자 기록이 남는다 |
| 기술적 사실 | 지금 스키마 그대로 가능 | **`users` 외래키를 쓸 수 없다**(`test-migrations.mjs:96-103` 이 CASCADE 를 전수 강제). 가명 키로 바꾸거나 ledger 로 옮겨야 한다 |
| **Claude 권고** | 법률 검토 전까지 **CASCADE 유지**(2단계 §4 의 승인 상태) | — |

법률 검토 결과가 "보존"이면 **스키마가 통째로 달라진다.** 이것이 지금 migration 을 만들지 않는
가장 큰 이유다.

### 결정 5 — 삭제 표식 저장소

| | **별도 D1** | 새 전용 KV | R2 | 저장소 없이 복원 금지만 |
|---|---|---|---|---|
| 쉬운 예시 | 옆에 둔 작은 장부 | 포스트잇 벽(붙인 게 바로 안 보임) | 창고에 파일 하나씩 | 장부 없이 "복원 안 하기"로 약속 |
| 쓰기 확인 | **확실** | 최종 일관성 | 확실 | — |
| 운영 | `wrangler d1 execute` 한 줄 | 훑기 | 목록+읽기 | 없음 |
| 위험 | saga 관리 필요 | 위 + 확인 약함 | 위 | **복원이 꼭 필요한 사고에서 무력** |
| **Claude 권고** | ✅ **별도 D1 + 복원 금지 절차 병행** | | | |

**권고 이유**: saga 의 1단계가 "확실히 적혔나"에 달려 있는데 KV 는 그 확신을 못 준다.
"복원 금지"만으로도 지금은 실효가 있지만, 데이터 손상 사고가 나면 복원 없이 고칠 수 없다.

### 결정 6 — 삭제 saga 실패 시 사용자 응답과 reconciliation

| 실패 지점 | 선택지 X (보수적) | 선택지 Y (낙관적) | Claude 권고 |
|---|---|---|---|
| pending 기록 실패 | "지우지 못했어요" | 그냥 진행 | ✅ X — 표식 없이 지우면 복원 때 되살아난다 |
| 주 D1 삭제 실패 | "지우지 못했어요" · 세션 유지 | "지웠어요" | ✅ X — 2026-08-16 에 닫은 P0 와 같은 판단 |
| confirmed 기록 실패 | "지우지 못했어요" | **"계정을 지웠어요"** + reconciliation | ✅ **Y** — 계정은 **실제로 없다.** 여기서 실패라고 말하면 사용자가 재시도하는데 지울 것이 이미 없다 |
| reconciliation 실행 | 자동 주기 | **복원 직전 필수 + 수동** | ✅ 후자 — 크론이 없다. 자동인 척하지 않는다 |

**결정하지 않으면 막히는 것**: `worker/index.js` 의 `DELETE /me` 재작성, `test-deletion-ledger`.

---

## 18. 이번 단계에서 하지 않은 것

`worker/index.js`·`worker/schema.sql`·`js/*.js`·`privacy.html` 수정 · 이용약관 작성 ·
policy manifest·정책 버전 파일 생성 · migration 생성 · 테스트 파일 생성 ·
별도 D1/KV/R2 생성 · 원격 D1 쓰기 · KV 값 조회·삭제 · 시크릿 변경 · OAuth 활성화 ·
배포 · `push` · 캐시 퍼지 · Time Travel restore · 백업 생성·복원 ·
`네이버검수-캡처/` 접근 · **법률 결론 단정**.

---

## 19. 출처

| 출처 | 확인한 것 | 날짜 |
|---|---|---|
| Cloudflare D1 Worker API — `batch()` (문서 갱신일 2026-06-22) | 원문: "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and **it aborts or rolls back the entire sequence**." · <https://developers.cloudflare.com/d1/worker-api/d1-database/> — HTTP 200 확인 | 2026-08-17 |
| Cloudflare D1 — Time Travel | 항상 켜짐·비활성화 불가 · 제자리 덮어쓰기 · bookmark 로 되돌리기 · 30일(유료)/7일(무료) | 2026-08-16(2단계 §19) |
| 이 저장소 코드 | `worker/index.js:244·327·369·465·492·511-526·700-703·712·751·781·830-839·948` · `worker/schema.sql` · `scripts/test-migrations.mjs:96-103` · `scripts/build.mjs` · `service-worker.js` | 2026-08-17 |
| 라이브 `/api/ready` | HTTP 503 · `{"ok":true,"configReady":false,"db":true,"providers":[],"ready":false}` | 2026-08-17 |
| 옛 엣지 캐시 | `/CLAUDE.md`·`/worker/index.js` 가 `cf-cache-status: HIT`, `age 499879`, `s-maxage 604800` → 남은 수명 약 **29시간** | 2026-08-17 |
| 개인정보 보호법 제15조·제22조·제22조의2·제28조의8 | 2단계 §19 의 확인 내용을 그대로 인용. **이 문서에서 법률 판단을 새로 하지 않았다** | 2026-08-16 |

---

## 20. 최종 판정

> **3단계 상세 설계안은 제출했다.** 아직 사용자 결정과 외부 법률 검토가 남아 있으므로 회원가입
> 코드·DB·개인정보처리방침·원격 환경은 변경하지 않았다. 결정이 확정되기 전까지 공개 OAuth 와
> 계정 출시는 **No-Go** 다.
