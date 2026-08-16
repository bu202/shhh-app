# 인수인계 — shhh! (2026-08-14 기준)

다른 AI·사람이 이 저장소를 이어받을 때 **먼저 읽는 문서**다. 규칙의 원본은 `CLAUDE.md`이고
이 파일은 "지금 어디까지 왔고 다음에 무엇을 하는가"만 담는다. 둘이 어긋나면 `CLAUDE.md`가 이긴다.

---

## 0. 30초 요약

연인·친구가 **실제 한국수어 단어**를 함께 배우는 PWA. Vanilla JS + Cloudflare Pages Functions + D1.
**앱스토어 미출시, 공개 계정 베타 No-Go.** 서버 P0 4건은 2026-08-12 에, **클라이언트 P0 3건**은
2026-08-14 에 닫혔다. P1(레이트리밋·세션 정리·스키마 readiness·상한 경합·Origin)도 2026-08-14 에 닫혔다.

프로덕션 재배포는 2026-08-14 에 끝났다(배포 `774015e9`, source `cd767ee`, Production/main).

> ⚠️ **그 뒤 2026-08-16 재감사에서 라이브가 다시 코드보다 오래됐다.** 이 문서의 다른 곳에 있는
> "라이브가 코드보다 오래됐다"와 "재배포 완료"는 **시점이 다른 두 사실**이지 모순이 아니다.
> 지금 기준: 라이브 = source `cd767ee`. 저장소 = 그보다 앞선다(친구 목록·서비스워커·리미터 수정).
> 재감사에서 **P0 네 건이 새로 확인돼 닫혔고, P0 한 건과 P1 두 건이 열려 있다** — `CLAUDE.md` 5절이 원본이다.
> 남은 것은 **① P0-4(다중 탭 계정 전환) ② 개인정보 법률 검토 ③ 실기기 확인 ④ 배포** 넷이다.

`npm test` 16개 스위트 전부 통과한다(2026-08-14 실측). 단, **테스트 통과는 보안 완료가 아니다** —
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
| 브랜치 | `cf-pages` (`origin/cf-pages` 와 같음 = push 됨) |
| 테스트 | 16개 스위트 통과(2026-08-16 실측). `test-client` 53개, `test-friends` 115개, `test-auth` 24개, `test-migrations` 3개 이전 |
| 배포본 | `dist/` 51개 파일, 내부 파일 0개, 선캐시 17개 |
| OAuth | **비활성.** 시크릿 8개(`KAKAO_ID`·`KAKAO_SECRET`·`NAVER_*`·`GOOGLE_*`·`STATE_KEY`·`MASTER_UIDS`) 미투입 |
| 원격 D1 | **`0001`·`0002`·`0003` 적용 완료(2026-08-14).** 적용 전 실측 **전 테이블 0행** |
| 라이브 | ⚠️ **배포본이 이 코드보다 오래됐다.** `/api/ready` 응답에 `db` 항목이 없다 — 현재 코드는 반드시 넣는다 |
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
| 레이트리밋 | D1 카운터가 **실제로 막는다**. 키는 해시라 원문 IP·uid 를 안 남긴다 | `test-friends` 84~88 |

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
| 실기기 확인 | 설치된 PWA 에서 OAuth 복귀 · iOS/Android · 느린 회선에서 12초 타임아웃 | 기기가 필요하다. Node·헤드리스로 못 잰다 |
| 개인정보 | 동의·만 14세·계정 삭제 정책 | **법률 판단은 AI 가 하지 않는다.** 사용자 몫 |
| OAuth 활성화 | P0 완료(됨) + 사용자 승인 | 승인 대기 |

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
> `s-maxage` 만료로 **약 52시간 뒤 자동으로 사라진다**(그 뒤에는 폴백으로 대체된다).
> 커스텀 도메인을 붙여도 그 도메인은 새 캐시라, **이 주소의 옛 캐시는 앞당겨 지울 수 없다.**
>
> **왜 2026-08-14 에는 못 봤나**: 그때 판정 근거가 "Content-Type 이 html 이면 폴백"이었는데,
> 그 측정이 **배포 고유 주소**에서 이뤄졌다. 거기는 엣지 캐시 이력이 없어 언제나 깨끗하다.
> → §5-4 의 규칙에 한 줄 붙는다: **canonical 주소를 쿼리 없이, `cf-cache-status` 와 `age` 까지 본다.**

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
npm test                              # 16개 스위트 (빌드·dist 검사 포함)
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
