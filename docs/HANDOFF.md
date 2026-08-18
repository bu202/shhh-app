# 인수인계 — shhh! (2026-08-14 기준)

다른 AI·사람이 이 저장소를 이어받을 때 **먼저 읽는 문서**다. 규칙의 원본은 `CLAUDE.md`이고
이 파일은 "지금 어디까지 왔고 다음에 무엇을 하는가"만 담는다. 둘이 어긋나면 `CLAUDE.md`가 이긴다.

---


## 2026-08-17 운영 반영 기록 (1단계)

**배포 `f72f5225`** — Production / branch `main` / source **`cba3d3a`**.
`--commit-dirty=true` 를 쓰지 않았다. 직전 프로덕션은 `acdecfa2`(source `586cc86`) — **롤백 후보**.

> ⚠️ **배포 시점 HEAD 와 현재 HEAD 는 다르다.** 배포 source 는 `cba3d3a` 로 고정된 사실이고,
> 저장소 HEAD 는 그 뒤로도 문서 커밋이 얹혀 계속 움직인다. 현재 HEAD 는 `git rev-parse HEAD` 로 본다.
> **2026-08-18 09:07 KST 재확인: 라이브는 여전히 `f72f5225`(source `cba3d3a`) 이고, 그 뒤 배포는 없다.**

| # | 한 일 | 결과 |
|---|---|---|
| 1 | 원격 D1 읽기 전용 사전 점검 | `users`·`sessions`·`books`·`friendships`·`invite_codes` **전부 0행** · `rate_limits` **4행** · migration `0001`~`0003` · `invite_codes_active` 인덱스 **없음** |
| 2 | 저장소 밖 백업 | `~/shhh-d1-backups/shhh-db-20260817-184520.sql` · 3,637B · SHA-256 `79514461…` · 66줄 · CREATE TABLE 7 · INSERT 8 |
| 3 | **백업 복원 시험** | 로컬 SQLite 로 실제 복원 성공. tables 8 · indexes 6 · users 0 · rate_limits 4 · migrations 3 — **export 시점(2026-08-17 18:45 KST)의 원격 상태와 일치**. ⚠️ **현재 원격과 일치한다는 뜻이 아니다** — 그 뒤 `0004` 가 적용됐고 `rate_limits` 행도 하나 늘었다 |
| 4 | `RL_KEY` 생성·등록 | production 환경. **값을 출력하지 않았다.** 시크릿 이름 목록: `RL_KEY` · `STATE_KEY` |
| 5 | 원격 D1 `0004` 적용 | ✅ 3 commands. 적용 후 `invite_codes_active` **존재**, 중복 활성 코드 **0건**, `users` **0명 무변화** |
| 6 | 빌드·배포 | `npm test` 17개 스위트 통과 · `npm audit` 0건 · `test-dist` 통과(dist 51개, 내부 파일 0개) |
| 7 | 배포 후 검증 | 아래 |

### 배포 후 실측

| 항목 | 결과 |
|---|---|
| `/api/ready` | `{"ok":true,"configReady":false,"db":true,"providers":[],"ready":false}` · **HTTP 503** |
| `ready:false` 의 원인 | **`providers: []`**(OAuth 미설정). ⚠️ `RL_KEY` 미등록도 DB 오류도 **아니다** — `db:true` 가 스키마 접근을 증명하고, 시크릿 목록에 `RL_KEY` 가 있다 |
| Origin 없는 `POST /friends` | **403** |
| Origin 없는 `DELETE /session` | **403** |
| 외부 Origin `POST /friends` | **403** |
| 세션 없는 `GET /book` | **401** |
| 없는 경로 `POST` | **404** (리미터를 안 탄다) |
| **레이트리밋** | `/api/cb/kakao` 12회 → **1~10 은 400, 11~12 는 429.** `RL_KEY` 가 실제로 센다 |
| **리미터 증폭 방어** | 12회 요청인데 카운터는 **11 에서 멈췄다**. 한도 초과 후 D1 쓰기가 없다 |

### ⛔ 아직 안 끝난 것 — 옛 엣지 캐시

**배포 뒤에도 내부 파일 7개가 canonical 에서 원문 200 이다.** 최신 실측(쿼리 없는 GET,
**2026-08-18 09:10 KST**):

| 경로 | status | content-type | byte | cf-cache-status | age |
|---|---|---|---|---|---|
| `/CLAUDE.md` | 200 | `text/markdown` | 106,598 | HIT | 570,330 |
| `/worker/index.js` | 200 | `application/javascript` | 33,307 | HIT | 570,334 |
| `/scripts/test-friends.mjs` | 200 | `application/javascript` | 23,749 | HIT | 570,334 |
| `/wrangler.jsonc` | 200 | `application/octet-stream` | 1,256 | HIT | 570,334 |
| `/package.json` | 200 | `application/json` | 403 | HIT | 568,320 |
| `/package-lock.json` | 200 | `application/json` | 3,085 | HIT | 570,334 |
| `/docs/API_KEY_GUIDE.md` | 200 | `text/markdown` | 3,002 | HIT | 582,007 |

전부 `cache-control: public, s-maxage=604800`. byte 수가 2026-08-17 측정과 **한 바이트도 다르지 않다.**

- **오리진은 깨끗하다.** 쿼리를 붙이면 전부 `index.html` 폴백(9,994B)이고 `dist/` 에도 내부 파일이 0개다.
  ⚠️ 쿼리를 붙인 결과는 **완료 근거가 아니다.** 닫혔다고 말하려면 쿼리 없는 canonical 이 폴백이어야 한다.
- **배포로는 안 지워진다 — 이번이 세 번째 확인**(08-14 · 08-16 · 08-17). `age` 가 계속 08-11 을 가리킨다.
- `*.pages.dev` 는 우리 존이 아니라 **퍼지 API 를 쓸 수 없다.**
- ⚠️ 그 `CLAUDE.md` 안에 **개인 복구 링크 5건**이 들어 있다.
- **이것이 1단계 운영 마감의 유일한 외부 대기 조건이다.** 자동 만료 예상 시각을 완료 근거로 쓰지 않는다 —
  **7개 경로를 다시 측정해 폴백이 나와야** 닫는다.

### 부수 발견 — 만료된 `rate_limits` 행이 그대로 남아 있다

**2026-08-18 09:20 KST 원격 읽기 전용 재측정: 5행, 전부 만료.** `n` = 63 · 67 · 11 · 1 · 11,
가장 늦은 `expires_at` 도 2026-08-17 19:09 KST 다. 아래는 그 5행이 어떻게 생겼는지의 기록이다.

> ⚠️ `expires_at` 은 **밀리초**(`Date.now()`)다. `unixepoch()`(초)와 그냥 비교하면
> **만료 0건으로 잘못 나온다** — 08-18 재측정에서 실제로 한 번 그렇게 나왔다. `unixepoch()*1000` 과 비교한다.

**당시 사실 — 2026-08-17 18:45 KST 사전 점검 시점에는 4행이었다.**
08-16 14:10~14:29 에 만들어진 행 4개(`n` = 63 · 67 · 11 · 1)가 **전부 만료됐는데 삭제되지 않았다.**
다섯 번째 행(`n` = 11)은 그날 배포 후 `RL_KEY` 스모크 테스트가 만든 것이다.
정리가 `newSession()`(= 로그인) 에만 붙어 있는데(`worker/index.js:256-261`) **아무도 로그인하지 않기 때문**이다.

- 이 4행은 **당시 라이브 코드(`586cc86`)가 키 없는 `sha256()` 로 만든 값**이다 — 2026-08-16 재감사가
  **실측 43회 대입으로 원본 IP 를 복원**한 바로 그 종류다. **08-18 현재도 그대로 남아 있다.**
- 08-17 에 만든 5번째 행은 새 `RL_KEY` HMAC 이라 그 문제가 없다.
- **설계서 위협 38 의 라이브 증거다** — 「보유기간을 약속했는데 지우는 사람이 없다」.
  4단계의 정리 Worker(설계서 §10-5-2)가 이것을 닫는다.
- ⚠️ **이 4행의 삭제는 승인 범위 밖이라 실행하지 않았다.** 원격 D1 쓰기이므로 별도 승인이 필요하다.

## 0. 30초 요약

연인·친구가 **실제 한국수어 단어**를 함께 배우는 PWA. Vanilla JS + Cloudflare Pages Functions + D1.
**앱스토어 미출시, 공개 계정 베타 No-Go.** 서버 P0 4건은 2026-08-12 에, **클라이언트 P0 3건**은
2026-08-14 에 닫혔다. P1(레이트리밋·세션 정리·스키마 readiness·상한 경합·Origin)도 2026-08-14 에 닫혔다.

프로덕션 재배포는 2026-08-14 에 끝났다(배포 `774015e9`, source `cd767ee`, Production/main).

> **당시 사실 — 2026-08-16.** 그날 재감사 시점에는 라이브(`acdecfa2` · source `586cc86`)가
> 저장소 코드보다 오래됐다. 이 문서 곳곳의 "라이브가 코드보다 오래됐다"와 "재배포 완료"는
> **시점이 다른 두 사실**이지 모순이 아니다.
>
> **2026-08-18 09:07 KST 기준: 라이브는 배포 `f72f5225`(source `cba3d3a`)** 이고, 그 안에
> 1단계 작업분이 전부 들어 있다. 저장소 HEAD 는 그 뒤 문서 커밋만큼 앞서 있으며 **런타임 코드
> 차이는 아니다.** 상태 판정의 원본은 `CLAUDE.md` §1-1 · §5 다.
>
> **2026-08-16 1단계 재감사(2차)에서 여섯 건을 더 닫았다** — 초대 코드 동시성 · 계정 삭제 원자성 ·
> 레이트리밋 키 재식별(실측 43회 대입으로 IP 복원됨) · 초대 링크 회전의 D1 쓰기 증폭 ·
> 로그인 한도 표기 불일치 · OAuth 응답 무제한 적재. **2026-08-17 배포 `f72f5225` 로 전부 운영 반영됐다.**
> 남은 것은 **① 개인정보 법률 검토 ② 실기기 확인 ③ 옛 엣지 캐시 7개 소멸 확인** 셋이다.
>
> **단계 현황 (2026-08-18 09:20 KST 재측정)** — 단계 정의의 원본은 `CLAUDE.md` §1-1 이다.
>
> | 단계 | 상태 |
> |---|---|
> | 1단계 보안 기준선 | **로컬 완료 · 운영 반영 완료 2026-08-17** (배포 `f72f5225` · `RL_KEY` 등록 · 원격 `0004` 적용). **최종 미완료** — 옛 엣지 캐시 내부 파일 7개가 08-18 09:10 KST 실측에서 여전히 원문 200 |
> | 2단계 정책 결정 | **내부 정책 결정 완료 · 외부 법률 검토 미완료** → `docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md` |
> | 3단계 기술 상세 설계 | **완료(5판)** → `docs/STAGE3_SIGNUP_SECURITY_DESIGN.md`. **설계 완료일 뿐 런타임 구현은 0줄** |
> | 4단계 코드·DB 구현 | **미착수. 코드 0줄** |
>
> 결정 1·2·5(조건부)·6 과 **A(AEAD state)·B(정리 Worker)·C(옛 배포 차단, 조건부)·D(drain 은 법률 후)·E(보유기간 임시값)**
> 는 확정, **결정 3·4 는 외부 법률 검토(L1~L15)에 종속**되어 있다.
> 전달 자료는 `docs/PRIVACY_LEGAL_REVIEW_PACKET.md`.
>
> ⚠️ **「법률 자료를 보냈다」만으로 4단계가 열리지 않는다.** 순서는 넷이고 중간을 건너뛰지 않는다:
> **외부 법률 검토 전달 → 회신 수령 → 사용자 결정 3·4 확정 → 4단계 구현 별도 승인.**
> **⛔ 검증 가능한 전역 write drain 이 구현되기 전까지 주 D1 restore 금지**(설계서 §10-8-0).
> 회원가입 **구현**은 개인정보 처리의 법적 근거가 확정된 뒤에 시작한다(설계서 §20 착수 조건).
> **배포와 공개 OAuth·계정 출시는 계속 No-Go** 다.
> 설계 완료는 법률 검토 완료도, 구현 완료도, 출시 준비 완료도 아니다.

`npm test` **17개 스위트** 전부 통과한다(2026-08-18 실측, exit 0). 단, **테스트 통과는 보안 완료가 아니다** —
이 저장소는 "초록불인데 P0 가 살아 있던" 사고를 **두 번** 겪었다(§5 참고). 두 번째가 더 중요하다:
96개 서버 테스트가 통과하는 동안 **클라이언트 실패 처리 경로에는 테스트가 하나도 없었고**,
계정 삭제가 500 이어도 "계정을 지웠어요"라고 말하고 있었다.

---

## 1. 스택과 구조

| 계층 | 파일 |
|---|---|
| 입력·화면 | `js/app.js`, `js/auth.js`, `js/friends.js` |
| 핵심 판단(순수 함수) | `syncPlan()` 등 — 화면·저장소 없이 테스트 가능 |
| 데이터·외부 접근 | `js/authApi.js`, `worker/index.js`, D1 |

- 브라우저의 `fetch()`는 **`js/authApi.js` 에만** 있다. 화면 코드가 직접 부르지 않는다.
- `functions/api/[[path]].js` 는 Pages 연결부일 뿐, 로직을 복사하지 않는다. 로직은 `worker/index.js`.
- `dist/` 는 **allowlist** 다(`scripts/build.mjs`). 새 파일의 기본값은 "배포 안 됨"이고,
  `scripts/test-dist.mjs` 가 내부 파일 유출을 막는다. 예전에 레포 루트를 통째로 배포해
  `CLAUDE.md`·`worker/index.js`가 라이브에서 200으로 열렸던 사고의 재발 방지책이다.
- 앱과 API 가 **같은 origin** 이다. 그래야 CSP 를 `connect-src 'self'` 로 조이고 쿠키를 쓴다.
  이 조건이 뒤에 나오는 레이트리밋 선택지를 좁힌다.

## 2. 지금 서 있는 자리

| 항목 | 상태 |
|---|---|
| 브랜치 | `cf-pages`. ⚠️ **push 되지 않은 로컬 커밋이 있다** — 개수는 자주 바뀌니 `git status --short --branch` 로 본다 |
| 테스트 | **17개 스위트** 통과(2026-08-18 실측, exit 0). 개수의 원본은 `package.json` 의 `test` 스크립트이고 `scripts/test-docs.mjs` 가 거기서 읽어 문서와 대조한다 |
| 배포본 | `dist/` **51개 파일**, 내부 파일 0개, 선캐시 **18개**, 캐시 이름 `shhh-v11-32a4fa795959` (2026-08-18 빌드) |
| OAuth | **비활성.** 제공자 시크릿 6개(`KAKAO_ID`·`KAKAO_SECRET`·`NAVER_*`·`GOOGLE_*`)와 `MASTER_UIDS` 미투입 |
| 시크릿 (production) | **`RL_KEY` · `STATE_KEY` 두 개 등록됨** (2026-08-18 이름 목록 재확인, 값은 보지 않는다). ⚠️ **preview 환경에는 `RL_KEY` 가 없다** |
| 원격 D1 | **`0001`~`0004` 전부 적용 완료** (`0001`~`0003` 2026-08-14 · `0004` 2026-08-17). 2026-08-18 `migrations list` 적용 대기 **0건** · `invite_codes_active` 인덱스 존재 · 중복 활성 코드 **0건** |
| 원격 D1 `rate_limits` | **5행, 전부 만료된 채 남아 있다**(2026-08-18 실측). 자동 정리 수단이 없다 — 위협 38 의 라이브 증거. 삭제는 원격 쓰기라 **별도 승인** 사항 |
| 원격 D1 사용자 수 | **0명** (2026-08-17 읽기 전용 `SELECT COUNT(*)` 재조회 성공). 같은 날 다른 실행 하나는 Cloudflare API `7403` 권한 오류였다. **원인은 확인되지 않았다** — 인증 컨텍스트·권한·Cloudflare 측 상태 중 무엇인지 모른다. "간헐적 장애"라고 단정하지 않는다. 값 0명은 **성공한 실행**에서 나온 것이다 |
| legacy KV | **아직 살아 있다.** 5개(`b:1 c:1 s:2 u:1`, 접두사 개수만 확인). 새 코드는 쓰지 않는다. 폐기 방향은 승인, **실행은 별도 승인** |
| 2단계(회원가입·개인정보) | **정책 설계 완료 2026-08-17.** 법률 검토·구현·출시는 각각 별개다 → `docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md` |
| 라이브 | **배포 `f72f5225`**(Production/main, source `cba3d3a`) — 1단계 작업분이 들어 있다. 2026-08-18 09:07 KST 실측: `/api/ready` HTTP **503** · `{"ok":true,"configReady":false,"db":true,"providers":[],"ready":false}`. 이 503 은 **`providers: []`(OAuth 미설정) 때문의 의도된 fail-closed** 다. `RL_KEY` 부재도 DB 오류도 아니다 — `db:true` 가 원격 D1 스키마 접근을 증명한다 |
| wrangler | `4.123.0` 을 devDependency 로 **고정**(예전엔 아예 설치돼 있지 않았다). OAuth 토큰은 살아 있음 |
| 추적 안 된 파일 | `네이버검수-캡처/` — 사용자 파일. **건드리지 않는다** |

> 커밋 해시는 여기 적지 않는다. 이 표가 가장 자주 틀리던 자리라 — `git log --oneline -1` 이 늘 맞다.

## 3. 닫힌 것 (근거 없이 다시 열지 말 것)

| 항목 | 무엇을 고쳤나 | 근거 |
|---|---|---|
| OAuth 로그인 브라우저 결속 | `/login` 이 심은 표(`shh_t`)를 `/cb`·`/exchange` 가 code 교환 **전에** 대조 | `test-friends` 76~84 |
| 계정별 로컬 상태 격리 | 로그아웃이 `ACCOUNT_KEYS` 를 지우고, 계정 판정을 `remote.me` **수신 후로** 옮김 | `test-auth` 13~17 |
| 시계 독립 동기화 | `syncPlan` 이 `dirty`·`base` 만 본다. **시계 인자가 아예 없다** | `test-auth` 3~8·16 |
| 친구 관계 쌍 유일성 | `pair_key` UNIQUE + 같은 문장의 `ON CONFLICT` | `test-friends` 85~89 |
| readiness | `providers` 는 id·secret **쌍이 맞는 것만** 센다. `/ready` 는 이제 `SELECT 1` 이 아니라 **코드가 쓰는 테이블·컬럼을 실제로 만진다** | `test-friends` 69b~69d·76·77 |
| 실패를 성공이라 말하던 화면 | 로그아웃·계정 삭제·친구 철회가 **서버 2xx 를 확인한 뒤에만** 성공 처리. 404 는 "이미 그 상태"라 성공 수렴 | `test-client` 전체 |
| 저장 완료 판정 | `localRevision`(이 탭의 편집)과 `serverVersion`(서버가 센 번호)을 갈랐다. 두 번째 409 도 저장 실패다 | `test-client` |
| 로그인 버튼 fail-closed | 서버에 못 물어봤으면 버튼을 안 그린다. 문구가 "연결 실패"와 "준비 중"으로 갈린다 | `test-client` |
| 친구 상한 경합 | 세는 것이 INSERT·UPDATE **문장 안**에 있다 | `test-friends` 78·79 |
| 세션 행 정리 | 만료·폐기된 행을 다음 로그인 때 지운다 | `test-friends` 80·81 |
| Origin 없는 상태 변경 | 이제 **막는다**(읽기는 그대로) | `test-friends` 82·83 |
| 레이트리밋 | D1 카운터가 **실제로 막는다**. 키는 **`RL_KEY` HMAC** 이라 원문 IP·uid 를 안 남기고, 대입으로도 못 되돌린다 | `test-friends` 84~88 · 116~120 |
| 초대 코드 동시성 | `0004` 부분 유니크 인덱스가 **활성 코드 1개를 DB 가 강제**. 읽기는 회전을 안 부른다 | `test-friends` 107~115 · `test-migrations` 8~9 |
| 계정 삭제 원자성 | `DELETE FROM users` **한 문장** + CASCADE 전수 검사. 실패해도 중간 상태가 없고 세션이 살아 재시도된다 | `test-friends` 124~129 · `test-migrations` 6~7 |
| 제공자 응답 크기 | `text()` 에 64KB 상한. 전에는 1MB 응답으로도 **로그인이 성공했다** | `test-friends` 101~106 |

## 4. 남은 일 — 다음 사람이 할 것

### 4-1. 결정 대기 중 (사용자 승인 필요, 코드 아님)

**(A) ~~원격 D1 에 `migrations/0002` 적용~~ — 완료(2026-08-14).** 아래 표는 그때의 판단 기록이다.
실제로 골라 실행한 것은 **A**이고, 결과는 이렇다: `d1_migrations` 가 비어 있었고 `pair_key` 컬럼도
없었다(= 예전에 `schema.sql` 을 직접 돌린 상태). 백업 → `migrations apply` → 스키마 재확인 순으로
셋 다 적용했다. 전 테이블 0행이라 잃을 데이터가 없었다.

| | 방법 | 판정 |
|---|---|---|
| **A** | `d1 export` 백업 → `wrangler d1 migrations apply shhh-db --remote` → `/ready`·친구 왕복 확인 | **권고.** 이력이 `d1_migrations` 에 남아 다음 이전이 안전 |
| B | 대시보드 D1 콘솔에 SQL 붙여넣기 | 이력이 안 남아 다음 `migrations apply` 가 0002 를 또 돌려 `duplicate column` 실패 |
| C | 원격 DB 재생성 | A 보다 위험만 크고 이득 없음 |
| D | 코드가 `pair_key` 없이도 돌게 폴백 | 코드가 늘고 중복 행 버그는 그대로. **반대** |
| E | 손대지 않고 친구 UI 를 끔 | 위험 0, 친구 기능이 계속 죽어 있음 |

> A 의 실패 시나리오: 0002 가 중간에 실패하면 이력은 안 남고 `pair_key` 컬럼만 남는다.
> 재시도하면 ① `ALTER` 에서 멈춘다. 백업 먼저, 실패 시 "컬럼 존재 확인 → 남은 단계만 수동" 순서.
> `0001_init.sql` 은 전부 `IF NOT EXISTS` 라 다시 돌아도 무해하다(확인함).

**(B) ~~레이트리밋~~ — 코드 쪽은 완료(2026-08-14).** ②(D1 카운터)를 골랐다. 아래 표의 "②는 느린
남용만 막는다"는 그대로 맞고, **①(커스텀 도메인 + WAF)이 여전히 더 좋은 답이다.** 도메인이 붙는 날
①로 옮기고 호스트 잠금 3줄을 반드시 같이 넣는다.

| | ① 커스텀 도메인 + WAF | ② D1 카운터 | ③ 현행(이음새만) |
|---|---|---|---|
| 코드 | 0줄 + **호스트 잠금 3줄** | `limited()` 안 ~12줄 | 0줄 |
| 비용 | 도메인 1~2만원/년 | D1 쓰기 1건/요청(무료 10만/일) | 0 |
| 막는 것 | 볼류메트릭 포함 전부, 엣지에서 | 초대코드 무차별·친구 스팸 같은 **느린 남용만** | 없음 |
| 덤 | 캐시 퍼지도 같이 열림 | — | — |

- **①의 함정**: 도메인을 붙여도 `shhh-app.pages.dev` 는 열려 있어 공격자가 우회한다.
  워커에서 `Host` 가 커스텀 도메인이 아니면 거절하는 3줄이 **반드시** 따라붙어야 성립한다.
- **②는 KV 시절 판단의 정정**이다. KV 무료는 하루 1,000 writes 라 리미터 자체가 서비스 거부 수단이었지만
  D1 은 하루 10만 writes 다. 다만 걸 값어치가 있는 자리는 `/exchange`·초대코드 조회·친구 요청 **세 곳뿐**.
- 무료 플랜 WAF 규칙 개수·차단 시간 조건은 **미확인**. 대시보드에서 확인해야 한다.
- 권고: **지금은 ③ 유지 → 도메인 붙는 날 ①(+호스트 잠금).** 비공개 계정 테스트가 도메인보다
  먼저 시작되면 그때 ②를 세 경로에만. Turnstile 은 봇 가입 방어일 뿐 레이트리밋 대체가 아니다.

### 4-2. 남은 것

| 항목 | 완료 조건 | 막고 있는 것 |
|---|---|---|
| ~~프로덕션 재배포~~ ✅ | **완료 2026-08-14.** `774015e9` (Production/main, source `cd767ee`). 스모크 결과는 §4-4 | — |
| ~~1단계 작업분 배포~~ ✅ | **완료 2026-08-17.** `f72f5225`(source `cba3d3a`) · `RL_KEY` 등록 · 원격 `0004` 적용을 같은 창에서 마쳤다 | — |
| **옛 엣지 캐시 내부 파일 7개** | 쿼리 없는 canonical GET 7개가 전부 폴백/404 | **외부 대기.** 2026-08-18 09:10 KST 실측에서 여전히 원문 200. 퍼지 API 를 쓸 수 없다(§4-5) |
| 실기기 확인 | 설치된 PWA 에서 OAuth 복귀 · iOS/Android · 느린 회선에서 12초 타임아웃 | 기기가 필요하다. Node·헤드리스로 못 잰다 |
| ~~개인정보 정책 설계~~ ✅ | **완료 2026-08-17** → `docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md` | — |
| **개인정보 법률 검토** | 처리 근거(제15조 제1항 제1호 vs 제4호) · 국외 이전(제28조의8 제1호 vs 제3호) · 만 14세 · 정책 이벤트 보존 · 삭제 표식의 성격과 보유기간(L9-1~L9-6) · **정책 행위 시각(L11)** · **가입 state 소비 표식(L12)** · **제공자 식별자 성질(L13)** · **백업과 표식 보유기간 동기화(L14)** · **가입 정보의 제공자 URL 통과(L15)** | **법률 판단은 AI 가 하지 않는다.** 전달 자료는 `docs/PRIVACY_LEGAL_REVIEW_PACKET.md`(**L1~L15**). 사용자 몫 |
| ~~3단계 기술 상세 설계~~ ✅ | **완료 2026-08-17(5판)** → `docs/STAGE3_SIGNUP_SECURITY_DESIGN.md`. 설계가 끝났다는 뜻이고 **구현·법률·출시는 각각 별개다.** 5판이 닫은 것: **복원 중 읽기 노출**(위협 36 · Critical) · **ledger 자기복원**(위협 37 · Critical) · **가입 정보 평문 통과**(§5-4) · **정리 수단 부재**(위협 38) · **옛 배포 차단 합격 조건**(§10-8-1) | — |
| ~~3단계 결정 1·2·5·6~~ ✅ | C안 · 임시 상태 제거(**4판 정정**: `pending_signups` 는 여전히 없고, OAuth 검증 **후의** replay tombstone `consumed_signup_states` 만 추가) · 별도 D1(조건부, 조건 C1~C8 반영 완료) · saga 실패 응답 + **reconciliation 은 promote-only 이고 활성 deletion lease 0건에서만** | — |
| **3단계 결정 3·4** | 정책 이벤트 법적 분기 · CASCADE 여부 | **법률 검토에 종속.** 그전까지 CASCADE 임시 유지, `policy_events` migration **생성 금지** |
| **4단계 회원가입 구현** | 가입 UI·API·`policy_events`·**`consumed_signup_states`**·**전역 write drain**·`test-signup`·`test-policies`·`test-deletion-ledger`(명세는 설계서 §13-5 의 **T1~T48**) · **정리 Worker**(`test-cleanup`) | 위 결정 + 법률 근거 확정. **먼저 만들면 재생성 migration 을 쓰게 된다**(SQLite 는 `CHECK` 를 `ALTER` 로 못 바꾼다) |
| **4단계 전역 write drain** | 설계서 §10-9-8 의 후보 A/B/C 를 **실측 비교**해 하나를 고르고, T1~T8 을 통과시킨다 | 4단계 착수. **이것이 끝나야 §10-8-0 의 주 D1 복원 금지가 풀린다.** ⚠️ **법률 검토와 병행할지는 사용자 결정 대기**(설계서 §20-1) — 「병행」으로도 「대기」로도 확정하지 않았다 |
| **`privacy.html` 불일치 8건** | 목록은 위 문서 §14 | 법률 근거가 정해져야 어떤 문장으로 고칠지가 정해진다. 가입 화면 구현과 **같은 변경 단위**로 고친다 |
| OAuth 활성화 | P0 완료(됨) + 사용자 승인 + **preview 환경 `RL_KEY` 등록**(production 은 완료) | 승인 대기. **공개 OAuth 는 계속 No-Go** |

### 4-2b. 1단계(2026-08-16) 작업분을 배포할 때 — **셋을 같은 창에서**

> ✅ **당시 사실 — 2026-08-16 ~ 2026-08-17. 이 절차는 2026-08-17 에 실제로 실행돼 끝났다**
> (배포 `f72f5225` · `RL_KEY` 등록 · 원격 `0004` 적용 — §「2026-08-17 운영 반영 기록」).
> 아래는 다음 배포 때 다시 쓰는 **순서 기록**이지, 지금 남아 있는 할 일이 아니다.

당시 상태는 로컬 테스트만 통과한 것이었다. 순서가 중요하다 — 하나만 빠지면 지금보다 나빠진다.

```bash
# ① 새 시크릿. 없으면 리미터가 **아무것도 안 세고** /api/ready 가 503 이다.
#    값은 여기 적지 않는다. 무작위 32바이트 이상. STATE_KEY·OAuth secret 을 돌려 쓰지 않는다.
npx wrangler pages secret put RL_KEY --project-name shhh-app

# ② 원격 D1 에 0004 (활성 초대 코드 1개 제약). **백업 먼저** — §4-3 과 같은 순서다.
#    ⚠️ 원격에 중복 활성 코드가 이미 있으면 인덱스 생성이 실패한다. 0004 는 그 정리를
#       인덱스 **앞에** 두었지만, 적용 전 실제 개수를 한 번 세어 보고 기록할 것.
npx wrangler d1 execute shhh-db --remote --command \
  "SELECT user_id, COUNT(*) n FROM invite_codes WHERE revoked_at IS NULL GROUP BY user_id HAVING n > 1"
npx wrangler d1 migrations apply shhh-db --remote

# ③ 배포. 절차는 release skill.
```

**배포 후 확인할 것**(§4-4 의 스모크에 더해):
- `/api/ready` 가 `configReady` 를 어떻게 답하는지. OAuth 가 아직 비활성이면 `false` 가 정상이고,
  **`RL_KEY` 를 넣었는데도 계속 `false` 라면** 시크릿이 안 들어간 것이다(둘을 가르려면 OAuth 를
  켜기 전 이 값 하나만 바꿔 놓고 재배포해 본다).
- 원격 스키마에 `invite_codes_active` 인덱스가 실제로 생겼는지 **다시 물어서** 확인한다(적용 ≠ 확인):
  `npx wrangler d1 execute shhh-db --remote --command "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='invite_codes_active'"`
- 계정 삭제는 **되돌릴 수 없다.** 라이브에서 시험하지 않는다 — 로컬 `pages dev` 로 확인할 것.

### 4-3. 백업 · 복원 · 롤백 (2026-08-14 실측)

```bash
# 백업 — **저장소 밖에** 받는다. 단어장·별명·초대 코드가 들어 있다(Git 에 넣지 않는다)
npx wrangler d1 export shhh-db --remote --output ~/어딘가/shhh-db-YYYYMMDD.sql

# 이전 — 반드시 백업 뒤에. 적용 후 스키마를 **다시 물어서** 확인한다(적용 ≠ 확인)
npx wrangler d1 migrations apply shhh-db --remote
npx wrangler d1 execute shhh-db --remote --command "SELECT sql FROM sqlite_master WHERE name='friendships'"

# 복원 시험 — 백업 파일이 진짜 살아나는지 본다. 원격을 안 건드리고 확인할 수 있다
node --experimental-sqlite -e "…" # 또는 로컬 D1 에 --file 로 적용

# 배포 롤백 — Pages 는 이전 배포를 그대로 되살린다(빌드 다시 안 한다)
npx wrangler pages deployment list --project-name shhh-app
```

> ⛔ **복원은 탈퇴한 사람을 되살린다. 지금은 복원 금지다.**
>
> Time Travel 은 D1 에 **항상 켜져 있고 끌 수 없으며**, 운영자가 `wrangler d1 time-travel restore` 로
> 실행할 수 있다. 수동 백업 복원도 결과가 같다. 계정을 지운 사람의 단어장·별명·친구 관계·초대 코드가
> 전부 돌아오고, **친구 목록에 다시 나타난다.** `privacy.html:73` 의 "그 자리에서 사라집니다"가
> 그 순간 거짓이 된다.
>
> "복원 뒤 전원 재로그인" 은 **답이 아니다** — `internalUid()` 가 살아남은 행을 찾아 돌려주므로
> (`worker/index.js:511-513`) 탈퇴자를 원래 계정으로 되돌린다. "재가입하면 새 UUID" 도 재가입한
> 사람만 보호한다.
>
> 필요한 것이 **둘**이고, **둘 다 설계만 있고 구현이 없다**:
>
> | # | 필요한 것 | 어디 | 없으면 |
> |---|---|---|---|
> | ① | 주 D1 **밖의 삭제 표식**을 복원 전후에 재적용하는 절차 | 요구사항 `docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md` §9 · saga·실패 매트릭스·**「주 D1 조건부 복원 11단계」**·**「ledger 재작성 13단계」**(5판 — 제자리 restore 폐지, §10-6-0)는 `docs/STAGE3_SIGNUP_SECURITY_DESIGN.md` §10 | 탈퇴자가 되살아난다 |
> | ② | **검증 가능한 `user-data drain`** — 주 D1 에 쓰는 **11개 경로 전부** + **읽기까지** 빠져나간 것을 질의로 확인 | 전수 표 §10-9-6 · 금지 gate **§10-8-0**(5판: 8조건) · 후보 3안 §10-9-8 | 진행 중이던 쓰기가 복원본에 섞인다 — **로그아웃이 무효가 되고 단어장이 옛 버전으로 되돌아간다** |
> | ③ | **`restore_closed` 상태** — 복원 직후 되살아난 탈퇴자의 단어장·별명을 **읽기까지** 막는다 | §10-7 라우트 전수 표 | **재삭제 전까지 탈퇴자 데이터가 그대로 읽힌다**(위협 36) |
> | ④ | **옛 배포 차단 증명 D1~D12** | §10-8-1 | 게이트 없는 옛 배포가 같은 D1 에 쓰고 읽는다(위협 33) |
>
> ⚠️ **「유지보수 모드를 켜고 `/api/ready` 가 503 이니 쓰기가 멈췄다」는 판단은 틀렸다.**
> 플래그는 **새 요청의 진입**만 막는다. 이미 들어온 요청은 계속 쓴다.
> 설계에 있는 deletion lease 도 **삭제 saga 하나만** 추적하므로 전역 정지의 증거가 아니다.
>
> 그 전까지 `time-travel restore` 와 백업 복원은 실행하지 않는다.
> 꼭 필요하면 임의 실행하지 말고 **사고 대응으로 승격**해 별도 승인·설계 검토를 받는다.
>
> 백업 규칙(migration 직전에만·저장소 밖·암호화 볼륨·24시간 뒤 삭제·7일 상한)은 같은 문서 §10.
> D1 플랜(7일 vs 30일)은 **미확인**이라 안전 기준으로 **최대 30일**을 쓴다. DB 나이로 추론하지 않는다.

⚠️ **DB 롤백은 배포 롤백과 다르다.** 0003 은 테이블을 새로 만들어 옮기므로 되돌리려면 백업 복원이
필요하다. 옛 코드로 배포를 되돌려도 새 스키마는 그대로 남는다 — `pair_key` 가 NOT NULL 이라
**pair_key 를 안 채우는 옛 코드는 친구 추가에서 실패한다.** 되돌릴 거면 배포와 DB 를 같이 본다.

### 4-4. 배포 후 스모크 (2026-08-14 실측, 배포 `774015e9`)

```bash
npm test && npm run build
npx wrangler pages deploy dist --project-name shhh-app --branch main   # --commit-dirty 금지
```

| 확인한 것 | 결과 |
|---|---|
| `/api/ready` | `{"ok":true,"ready":false,"providers":[],"db":false}` — **`db` 필드가 생겼다**(새 코드) |
| `ready:false`·`db:false` 인 이유 | OAuth 시크릿이 없어 `providers` 가 비었고, `db` 는 `ready` 뒤에만 물어본다. **의도한 값** |
| 내부 파일 6개(`CLAUDE.md`·`worker/index.js`·`package.json`·`.git/config` …) | ~~전부 index.html 폴백~~ **이 판정은 틀렸다 — 2026-08-16 §4-5 참조** |
| 정적 자산 | `service-worker.js` `application/javascript` (캐시 `shh-v10`) · `manifest.webmanifest` · `js/*.js` 정상 |
| 보안 헤더 | CSP(`frame-ancestors 'none'`, `object-src 'none'`) · `nosniff` · Referrer-Policy · Permissions-Policy |
| **Origin 없는 상태 변경** | `POST /api/friends` — Origin 없음/외부 Origin **둘 다 403**. 쿠키 없이도 인증보다 먼저 막는다 |
| 원격 D1 | `migrations list` → 적용 대기 없음. 코드와 스키마가 같은 세대다 |

### 4-5. 배포 후 스모크 (2026-08-16 실측, 배포 `fa7d8ef0`, source `468d858`)

| 확인한 것 | 결과 |
|---|---|
| `/api/ready` | `{"ok":true,"configReady":false,"db":true,"providers":[],"ready":false}` — **`db` 가 `false`→`true`.** 새 코드가 산 증거이자, 원격 D1 스키마가 실제로 답한다는 증거 |
| `service-worker.js` | 캐시 이름 `shhh-v10` → **`shhh-v11-4d77de307b92`**. 자산 해시가 박혔다 |
| `js/friends.js` | `loadFriends` 5회 등장 — 새 세대가 라이브에 있다 |
| **Origin 없는 상태 변경** | `POST /api/friends` 403 (회귀 없음) |
| **레이트리밋이 원격 D1 에서 실제로 막는가** | `/api/exchange/naver` 14회 → 10회 400, **11회째부터 429**. `ON CONFLICT DO UPDATE … WHERE … RETURNING` 이 D1 에서 돈다 |
| canonical vs 배포 고유 주소 | 아래 ⚠️ |

> ⚠️ **내부 파일 7개가 옛 엣지 캐시로 아직 열려 있다(오리진은 깨끗하다).**
>
> `https://shhh-app.pages.dev/CLAUDE.md` 는 `cf-cache-status: HIT`, `age` 4일, `s-maxage=604800` 으로
> **1,098줄짜리 옛 CLAUDE.md** 를 준다. 같은 경로가 **배포 고유 주소**(`fa7d8ef0.…`)와
> **쿼리를 붙인 canonical**(`?x=1`) 에서는 `text/html` 폴백이다 — 즉 지금 배포에는 그 파일이 없고,
> `pages_build_output_dir` 이 `.` 이던 시절의 응답이 엣지에 남아 있는 것이다.
>
> 남은 7개: `CLAUDE.md`(옛 1,098줄) · `worker/index.js`(옛 33KB) · `scripts/test-friends.mjs` ·
> `wrangler.jsonc` · `package.json` · `package-lock.json` · `docs/API_KEY_GUIDE.md`.
> **`.env` 와 `CLAUDE.local.md` 는 노출되지 않았다**(배포된 적이 없다).
> 실제 비밀값·토큰은 하나도 없다(코드에 하드코딩된 적이 없고, 시크릿은 wrangler secret 이다).
> 다만 옛 `CLAUDE.md` 에 **개인 단어장 복구 링크(`#w=`)가 5곳** 들어 있다.
>
> **왜 못 지우나**: `*.pages.dev` 는 Cloudflare 소유 존이라 대시보드·API 캐시 퍼지를 걸 수 없다.
> 커스텀 도메인을 붙여도 그 도메인은 새 캐시라, **이 주소의 옛 캐시는 앞당겨 지울 수 없다.**
>
> ⛔ **당시(2026-08-16) 여기에 「`s-maxage` 만료로 약 52시간 뒤 자동으로 사라진다」고 적었다.
> 그 시각은 지났고 파일은 그대로다** — 2026-08-18 09:10 KST 실측에서 7개 전부 원문 200 이었다.
> **만료 예상 시각을 완료 근거로 쓰지 않는다.** 닫혔다고 말할 수 있는 유일한 근거는
> 쿼리 없는 canonical GET 7개가 전부 폴백(또는 404)을 주는 것이다.
>
> **왜 2026-08-14 에는 못 봤나**: 그때 판정 근거가 "Content-Type 이 html 이면 폴백"이었는데,
> 그 측정이 **배포 고유 주소**에서 이뤄졌다. 거기는 엣지 캐시 이력이 없어 언제나 깨끗하다.
> → §5-4 의 규칙에 한 줄 붙는다: **canonical 주소를 쿼리 없이, `cf-cache-status` 와 `age` 까지 본다.**

### 4-6. 배포 후 스모크 (2026-08-16 실측, 배포 `acdecfa2`, source `586cc86`)

다중 탭 계정 보호(P0-4)와 친구 UI 경합(P1-2)이 들어간 배포다. 롤백 대상은 `fa7d8ef0`.

| 확인한 것 | 결과 |
|---|---|
| 배포 목록 | `acdecfa2` · Production · main · source `586cc86` |
| `/api/ready` | `{"ok":true,"configReady":false,"db":true,"providers":[],"ready":false}` — 안 바뀌는 것이 정상 |
| 서비스워커 | `shhh-v11-4d77de307b92` → **`shhh-v11-1e4ce4092d0d`**. 자산이 바뀌었으니 세대도 갈렸다 |
| `js/auth.js` | `accountMoved` 3회 — 탭 감지가 라이브 |
| `js/authApi.js` | `me: authUid()` 1회 — 저장이 자기 계정을 싣는다 |
| **세션 없이 `me` 만 실은 `PUT /book`** | **401.** 계정 대조보다 인증이 먼저다 — `me` 만으로는 아무것도 안 된다 |
| Origin 없는 `POST /friends` | 403 (회귀 없음) |
| canonical vs 배포 고유 주소 | 둘 다 같은 값 (이번엔 별칭 지연 없음) |

> ⚠️ **`me` 불일치 거절(409 `accountChanged`)은 라이브에서 블랙박스로 재지 못했다.** 그 자리에
> 닿으려면 세션이 있어야 하는데 OAuth 가 꺼져 있어 계정을 만들 수 없다. 서버 쪽 근거는
> `test-friends` 96~100 이고, 라이브에서 확인한 것은 **그 앞의 인증 순서(401)** 까지다.
> OAuth 를 켜는 날 실제 두 계정으로 다시 재고 이 줄을 지운다.
>
> ⚠️ §4-5 의 옛 엣지 캐시는 이 배포로 달라지지 않는다 — **오리진 문제가 아니다.** 만료를 기다린다.

⚠️ **프로덕션 별칭은 배포 직후 1분 정도 옛 응답을 준다.** 한 번 보고 "배포가 안 됐다"고 판단하지
말 것 — 배포 고유 주소(`https://<id>.shhh-app.pages.dev`)로 먼저 확인하면 구분된다.

`privacy.html` 과 코드의 *사실 대조표*는 `docs/SECURITY_RELEASE_CHECKLIST.md` 에 있다.
그 표는 사실 대조이지 **법적 충분성 판정이 아니다**.

## 5. 이 저장소가 이미 겪은 함정 (반복 금지)

1. **초록불이 보안을 뜻하지 않는다.** 테스트 전부 통과 상태에서 P0 4건이 살아 있었다.
   "테스트가 통과했다"가 아니라 **"실제 공격 순서가 테스트에 들어 있나"** 로 판정한다.
2. **레포 루트를 배포하지 마라.** 한 번 그래서 내부 파일이 라이브에서 열렸다. `dist/` allowlist 유지.
3. **`*.pages.dev` 에는 WAF 규칙도 캐시 퍼지도 못 건다.** Cloudflare 소유 존이다.
4. **배포 검증에 함정 셋** — `?cb=`(엣지 캐시), `-L`(Pages 가 `/privacy.html`→`/privacy` 308),
   그리고 상태코드가 아니라 **Content-Type** 을 본다(없는 경로에 index.html 을 200 으로 준다).
5. **저장 ≠ 배포**, **적용 ≠ 확인.** 마지막엔 항상 실제 호출로 새 동작을 확인한다.
6. 스키마는 `worker/schema.sql` 재실행이 아니라 **번호 붙은 migration** 으로만 바꾼다.
   `test-migrations.mjs` 가 migrations 결과와 `schema.sql` 의 모양을 대조해 갈라지면 실패시킨다.

## 6. Codex/다른 에이전트가 지켜야 할 선

**승인 없이 하지 않는다**: deploy, 원격 D1 실행, 시크릿 변경, 캐시 퍼지, DNS 변경, `git push`,
인증·세션 구조 변경, 동기화 병합 정책, DB 스키마·마이그레이션, 개인정보 정책, 기능 삭제.

**절대 하지 않는다**: 비밀값·세션·개인 UID·복구 링크를 명령 출력·로그·커밋·**Git 추적 문서**에 남기기.
`--commit-dirty=true` 로 프로덕션 배포. `CLAUDE.local.md` 를 커밋하기.

**제품 규칙**: 실제 한국수어만 보여준다. 미검증 데이터는 미검증이라 표시한다.
AI 는 후보를 좁힐 뿐 **최종 수어 판정을 하지 않는다**. 문장 번역기라고 주장하지 않는다.

**작업 순서**: `git status --short` → 실제 코드 읽기 → 현재 동작 재현/측정 → (설계면 대안 2개+권고)
→ **회귀 테스트 먼저** → 코드 수정 → `npm test` → `git diff --check` → 문서의 수치·URL 갱신.

## 7. 명령어

```bash
python3 scripts/serve.py 8000        # 정적 화면만
npm run build && npx wrangler pages dev dist   # Functions + 로컬 D1
npm test                              # 17개 스위트 (빌드·dist 검사 포함)
npm audit
```

배포·원격 명령은 여기 두지 않는다. 배포는 프로젝트 `release` skill 을 쓴다.

## 8. 더 읽을 곳

| 파일 | 무엇 |
|---|---|
| `CLAUDE.md` | **현재 운영 규칙의 원본** |
| `.claude/rules/{security,privacy,data-quality,frontend-pwa}.md` | 경로별 세부 규칙 |
| `docs/SECURITY_RELEASE_CHECKLIST.md` | 항목별 근거와 배포 검증 절차 |
| `docs/D1_MIGRATION.md` | KV→D1 이전 배경 (현재 상태 판단은 코드·실측 우선) |
| `docs/history/` | 과거 결정 기록. **현재 지침으로 쓰지 않는다** |
