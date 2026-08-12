# 인수인계 — shhh! (2026-08-12 기준)

다른 AI·사람이 이 저장소를 이어받을 때 **먼저 읽는 문서**다. 규칙의 원본은 `CLAUDE.md`이고
이 파일은 "지금 어디까지 왔고 다음에 무엇을 하는가"만 담는다. 둘이 어긋나면 `CLAUDE.md`가 이긴다.

---

## 0. 30초 요약

연인·친구가 **실제 한국수어 단어**를 함께 배우는 PWA. Vanilla JS + Cloudflare Pages Functions + D1.
**앱스토어 미출시, 공개 계정 베타 No-Go.** P0 보안 4건은 2026-08-12 에 닫혔고,
남은 것은 P1(레이트리밋·운영 안전·개인정보 법률 검토)과 **원격 D1 이전 미적용** 하나다.

`npm test` 15개 스위트 전부 통과한다(2026-08-12 실측). 단, **테스트 통과는 보안 완료가 아니다** —
이 저장소는 "초록불인데 P0 4개가 살아 있던" 사고를 한 번 겪었다(§5 참고).

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
| 브랜치 | `cf-pages` (upstream 없음 = **아직 push 안 됨**) |
| 최신 커밋 | `215df77 fix: make readiness answer the question it was pretending to answer` |
| 테스트 | 15개 스위트 통과. `test-friends` 96개, `test-migrations` 2개 이전 |
| 배포본 | `dist/` 51개 파일, 내부 파일 0개, 선캐시 17개 |
| OAuth | **비활성.** 시크릿 8개(`KAKAO_ID`·`KAKAO_SECRET`·`NAVER_*`·`GOOGLE_*`·`STATE_KEY`·`MASTER_UIDS`) 미투입 |
| 원격 D1 | `migrations/0002` **미적용** → 원격에서 친구 API 는 500 (코드가 `pair_key` 를 쓴다) |
| wrangler | 로그인돼 있음. `d1 (write)`·`pages (write)` 권한 있음 = **기술적 제약 아님, 승인 제약임** |
| 추적 안 된 파일 | `네이버검수-캡처/` — 사용자 파일. **건드리지 않는다** |

## 3. 닫힌 것 (근거 없이 다시 열지 말 것)

| 항목 | 무엇을 고쳤나 | 근거 |
|---|---|---|
| OAuth 로그인 브라우저 결속 | `/login` 이 심은 표(`shh_t`)를 `/cb`·`/exchange` 가 code 교환 **전에** 대조 | `test-friends` 76~84 |
| 계정별 로컬 상태 격리 | 로그아웃이 `ACCOUNT_KEYS` 를 지우고, 계정 판정을 `remote.me` **수신 후로** 옮김 | `test-auth` 13~17 |
| 시계 독립 동기화 | `syncPlan` 이 `dirty`·`base` 만 본다. **시계 인자가 아예 없다** | `test-auth` 3~8·16 |
| 친구 관계 쌍 유일성 | `pair_key` UNIQUE + 같은 문장의 `ON CONFLICT` | `test-friends` 85~89 |
| readiness | `/ready` 가 `SELECT 1` 을 실제로 던지고, `providers` 는 id·secret **쌍이 맞는 것만** 센다 | `test-friends` 69b~69d |

## 4. 남은 일 — 다음 사람이 할 것

### 4-1. 결정 대기 중 (사용자 승인 필요, 코드 아님)

**(A) 원격 D1 에 `migrations/0002` 적용** — 가장 급하다. 이게 없으면 원격 친구 기능이 500이다.

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

**(B) 레이트리밋** — 공개 베타 전 유일한 미해결 High.

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

### 4-2. 아직 손 안 댄 P1

| 항목 | 완료 조건 | 막고 있는 것 |
|---|---|---|
| 운영 안전 | 백업·복원 시험, 배포 후 smoke test, 롤백 절차 | 4-1(A) 이후에 의미가 생김 |
| 개인정보 | 동의·만 14세·계정 삭제 정책 | **법률 판단은 AI 가 하지 않는다.** 사용자 몫 |
| OAuth 활성화 | P0 완료(됨) + 사용자 승인 | 승인 대기 |

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
npm test                              # 15개 스위트 (빌드·dist 검사 포함)
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
