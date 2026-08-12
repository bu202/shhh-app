# 출시 전 보안 체크리스트 — shhh!

마지막 갱신: 2026-08-11 (2차) · 대상: `https://shhh-app.pages.dev` (Cloudflare Pages + Pages Functions + **D1**)

> **이 문서를 먼저 읽는 법.** 「미해결」이 곧 출시 판정이다. 해결된 항목은 어떻게 확인했는지가
> 같이 적혀 있어야 한다 — "고쳤다"만 적힌 줄은 다음 사람에게 아무것도 안 알려준다.

---

## 판정

> ⚠️ **2026-08-12 재감사.** 아래 옛 판정("공개 베타 가능")은 **틀렸다.** 이 문서가 P0 로 세던
> 다섯 항목은 전부 사실이었지만, **재지 않은 항목이 넷 더 있었다** — 로그인 콜백의 브라우저
> 결속, 동기화의 시계 의존, 친구 쌍 유일성, 계정 교체 판정 순서. 통과한 검사만 세고
> **무엇을 안 쟀는지는 세지 않은 것**이 이 문서의 실패였다.
>
> 그중 넷은 2026-08-12 에 고쳤고 공격 회귀 테스트가 붙었다(아래 「2026-08-12 에 닫은 것」).
> **판정은 여전히 공개 베타 No-Go 다** — 남은 P1(레이트리밋·운영 안전·법률 검토)
> 때문이고, 그 목록은 `CLAUDE.md` 5절이 원본이다.

| 심각도 | 해결 | 미해결 |
|---|---|---|
| Critical (P0) | 9 / 9 | 0 (2026-08-12 에 4건 추가 해결) |
| High (P1) | 5 / 8 | 3 (레이트리밋 · 세션 정리 · 개인정보 법률 검토) |
| Medium (P2) | 5 / 5 | 0 |

**현재 판정: 비공개 계정 테스트 가능 · 공개 웹/PWA 계정 베타 No-Go · 앱스토어 No-Go.**
레이트리밋은 코드로 못 닫는다 — `*.pages.dev` 에 WAF 규칙을 걸 수 없어서, **커스텀 도메인 하나**가
그 문과 엣지 캐시 퍼지를 함께 연다(Pages Functions 바인딩 목록에 `ratelimits` 가 없다는 것은
2026-08-12 에 공식 문서로 재확인했다). 정식 출시(결제·홍보) 전에는 **개인정보 법률 검토**가 따로 필요하다.

## 2026-08-12 에 닫은 것

| # | 무엇이 열려 있었나 | 무엇을 했나 | 확인 |
|---|---|---|---|
| P0-6 | **로그인 콜백이 시작한 브라우저와 결속되지 않았다.** 공격자가 자기 `code`·`state` 링크를 이미 로그인한 사람에게 보내면, 서버가 그 브라우저에 **공격자 계정 쿠키**를 심고 다음 동기화에서 피해자 단어장·별명이 공격자 계정으로 올라갔다 | `/login` 이 그 브라우저에만 표(`shh_t`, HttpOnly·10분)를 심고 state 에는 **해시만** 서명. `/cb`·`/exchange` 가 **code 교환·세션 생성 이전에** 대조 | `test-friends` 76~84 (표 없음·다른 표·한 글자 차이 전부 400, 세션 0, **제공자 호출 0**) |
| P0-7 | **동기화 승자를 기기 시계가 정했다.** 서버가 버전을 세고 있었지만 앱이 판정 직전에 최신 버전을 받아 되보내 CAS 를 통과시켰다 | `apiGetBook` 이 저장을 그만두고, `syncPlan` 이 `dirty`·`base` 로만 판정 | `test-auth` 3~8·16 (시계 자리가 아예 없어졌다) |
| P0-8 | **친구 관계가 두 사람당 하나가 아니었다.** A→B/B→A 동시 요청이 둘 다 들어가 목록에 두 번 뜨고, 남은 「취소」가 **이미 맺은 친구를 끊었다** | `pair_key` + UNIQUE 인덱스, 같은 문장의 `ON CONFLICT` 가 경합을 곧 "서로 보냈다"로 처리 | `test-friends` 85~89 · `test-migrations` |
| P0-9 | **계정 교체 판정을 서버 대답 전에** 했다. 탭 두 개로 다른 계정이 로그인하면 앞 계정 단어장이 뒷 계정으로 병합됐다 | `remote.me` 를 받은 뒤 판정. 로그아웃이 계정 귀속 로컬 값(초대 코드·별명·버전)을 지운다 | `test-auth` 13~15·17 |
| — | 스키마 변경 절차가 `schema.sql` 재실행뿐이라 **컬럼 추가가 조용히 반영되지 않았다** | `migrations/` 도입 + 이력과 `schema.sql` 이 갈라지면 실패하는 검사 | `test-migrations` |
| P1 | **readiness 가 바인딩만 봤다.** `database_id` 가 틀린 배포는 바인딩이 멀쩡해 `/ready` 가 200 이고, 사용자의 첫 질의에서 터진다. `providers` 도 id 만 봐서 secret 없는 제공자의 버튼이 그려졌다 | `/ready` 가 `SELECT 1` 을 실제로 던지고, `providers` 가 id·secret 쌍이 맞는 것만 센다(카카오만 secret 선택) | `test-friends` 69b~69d (오류 문자열 미노출까지) |

---

## 해결된 것과 확인 방법

| # | 무엇 | 확인 |
|---|---|---|
| P0-1 | 비대칭 친구 상태에서 남의 단어장을 못 읽는다 (양쪽 레코드 확인) | `test-friends` 5·62 (D1 이후엔 반쪽 상태가 구조적으로 불가능) |
| P0-2 | 관계없는 타인 `DELETE` 는 404 + **남의 관계 보존** | `test-friends` 64~66 |
| P0-3 | `STATE_KEY` 없으면 로그인 실패-닫힘 · `/health`·`/ready` · 미설정 제공자 버튼 미노출 | `test-friends` 67~72 + 브라우저 실측(버튼 3개가 사라지고 안내문이 뜸) |
| P0-4 | 레포 전체 공개 중단 (`dist/` allowlist 빌드) | `test-dist` + 라이브 `?cb=` 검증 |
| P0-5 | 조작된 해시가 앱 초기화를 못 멈춘다 | `test-hash` + 브라우저에서 `#q=%E0%A4%A` 진입 후 `appReadyDone: true` |
| P1-3 | 제공자 회원번호가 응답·주소·토큰 어디에도 안 나온다 | `test-friends` 43~48 (모든 응답을 문자열로 훑음) |
| P1-1 | 친구·세션·삭제가 **원자적**(D1: 관계 = 행 하나, 삭제 = CASCADE 한 문장) | `test-friends` 5·61~66 + 실기(`pages dev` + 원격 D1 스키마) |
| P1-2 | 세션이 **HttpOnly 쿠키** · 완전 무작위 · DB 에는 해시만 · 세대(session_version)로 즉시 무효화 | `test-friends` 25~30 + 실기(Bearer 401 · 로그아웃 후 401) |
| P1-5 | 개인정보처리방침이 코드 동작과 일치 | 아래 「방침 대조표」 |
| P2-2 | 단어장 충돌을 **서버 버전**이 판정(기기 시계 무관) | `test-friends` 54~60 + 실기(409) |
| P2-4 | 미검증 수어가 연습에 안 나온다(판정 함수 하나) | `test-compounds` (실데이터 400건) |
| — | 운영 로그에 uid 가 안 남는다(경로 템플릿) | `test-friends` 73~75 |
| P2-1 | SW 가 OAuth 왕복 주소·API·실패 응답을 캐시하지 않는다 | `test-sw` (캐시 v10 으로 옛 항목 폐기) |
| P2-3 | 결제 없는데 가격·유료 상태를 노출하지 않는다 | `BETA_NO_WALL` · `PRO_PRICE=""` |
| P2-5 | `/api/health`·`/api/ready`, 비밀값 미노출 | `test-friends` 67~70 |

---

## 미해결 — 왜 아직인가

### ✅ H1·H2 는 2026-08-11 에 해결됐다 (아래는 기록)
D1 이전과 쿠키 세션 전환을 **한 커밋에서** 했다. 나눠서 하면 쿠키만 먼저 나가 CSRF 공격면을
새로 열고 얻는 게 없기 때문이다. 자세한 절차·롤백은 [`D1_MIGRATION.md`](D1_MIGRATION.md).

<details><summary>당시의 문제 기록</summary>

#### H1. 친구·세션·삭제의 원자성 (D1 이전)
KV 에는 트랜잭션이 없다. 수락은 두 사람의 레코드에 **두 번 쓰기**라 첫 쓰기만 성공하면 반쪽이 남는다.
- **지금 막아 둔 것**: 반쪽 상태에서 **양쪽 다 접근이 막힌다**(P0-1). 즉 *권한이 새는 방향*은 닫혔다.
- **남은 것**: 목록에 이름만 남는 표시 불일치. 방침에도 그대로 적어 두었다.
- **최종 해결**: 관계 행 하나(`friendships`)를 D1 트랜잭션으로 다루기. 로컬 스키마·마이그레이션 작성은
  승인됐으나 **D1 리소스 생성과 Production 바인딩은 사용자 승인 대상**이라 아직 안 만들었다.
- ⚠️ 이전 시점의 KV 실측: **계정 1개, 친구 레코드 0개.** 지금 옮기면 사실상 공짜다. 사용자가 늘면 비싸진다.

### H2. 세션을 HttpOnly 쿠키 + 서버 세대(session_version)로
- **지금**: `localStorage` 의 Bearer 토큰. 토큰 앞부분이 내부 uid(무작위)라 **제공자 번호는 안 샌다**(P1-3).
- **남은 것**: ① 토큰이 완전 무작위가 아니다 ② 로그아웃이 `KV.list` 에 기대는데 최종 일관성 때문에
  **다른 기기가 60초 안에 만든 세션**은 못 지운다.
- **왜 안 했나**: `session_version` 을 KV 에 두면 그 읽기도 같은 최종 일관성을 져서 **창이 안 닫힌 채
  요청마다 KV 읽기만 하나 는다.** 쿠키 전환은 지금 원천적으로 불가능한 CSRF 공격면을 새로 여는 일이라
  (지금은 Bearer 라 CSRF 가 성립하지 않는다) D1 이전과 **같은 커밋에서** 해야 값이 있다.

</details>

### H3. 실제 레이트리밋 — **유일한 미해결 High**
- **확인된 사실**: Cloudflare **Rate Limiting 바인딩은 Pages Functions 에서 못 쓴다**(지원 바인딩 목록에 없음).
- **KV 카운터는 답이 아니다**: 무료 플랜 하루 1,000 writes — 리미터 자체가 서비스 거부 수단이 된다.
- **지금 있는 것**: `limited()` 이음새(바인딩이 생기면 그 자리에서 붙는다, `test-friends` 49~53) +
  실효가 있는 개별 상한들(친구 50명, 본문 8KB, OAuth 외부 호출 10초 타임아웃).
- **실제로 켜는 길 — 둘 다 코드가 아니다**:
  1. **커스텀 도메인을 붙이고 WAF 레이트리밋 규칙** ← 권장. `*.pages.dev` 는 Cloudflare 소유 존이라
     대시보드에서 규칙을 못 건다. **엣지 캐시 퍼지도 같은 조건이라 도메인 하나로 둘이 같이 풀린다.**
  2. API 를 Worker 로 되돌리고 `ratelimits` 바인딩 → 앱과 origin 이 갈려 CSP·쿠키·네이버 조건을
     전부 되돌려야 한다. 값보다 대가가 크다.

### 미검증 수어 — 알고 안 한 것 하나
데이터에 `verificationStatus` 필드를 **일부러 안 만들었다.** 그 값의 출처가 결국 `ksl-pins.json`
(사람이 고른 수형)이라, 필드로 복사해 두면 **진실이 둘**이 되어 갈라진다. 상태는 저장하는 것이 아니라
`unpinnedCandidates()` 한 함수가 계산하는 것으로 남기고, 대신 **실데이터 400건**에 대고
"출제된 것에는 미확정 부품이 없다"를 잠갔다(`test-compounds`).
⚠️ **카피에 "정확한 수어"·"검증된"을 쓰지 않는다** — 합성 2,485 중 사람이 확인한 건 12건이다.

---

## 방침 대조표 — `privacy.html` 이 코드와 맞는가

| 방침이 말하는 것 | 코드 | 상태 |
|---|---|---|
| 제공자 회원번호는 짝짓는 곳에만 저장, 친구·화면에 안 나온다 | `users.provider_subject` (그 행 밖으로 안 나감) | ✅ `test-friends` 43~46 |
| 세션은 **완전 무작위** · 계정 번호도 안 들어 있다 | `mkToken()` = 무작위 32바이트 | ✅ 45 |
| 기기에는 **HttpOnly 쿠키**, 서버에는 **해시만** | `setCookie()` · `sessions.token_hash` | ✅ 26 + 실기(Bearer 401) |
| 계정 삭제 시 제공자 연결까지 지워진다 | `DELETE FROM users` + CASCADE | ✅ 12 |
| 끊으면 **양쪽 모두에서** 사라진다 · 한쪽만 남는 상태가 없다 | 관계 = `friendships` 행 하나 | ✅ 5·10·61~66 |
| **모든 기기에서 즉시** 로그인이 풀린다 | `session_version + 1` (목록을 안 훑는다) | ✅ 28~30 |
| 보유 기간 · 국외이전 7항목 · 처리 근거 | — | ✅ 표로 명시 |
| 만 14세 이상 · 기술적 확인 수단 없음 | 생년월일 미수집 | ✅ 약속임을 명시 |

> ⚠️ 방침에서 **「드물게 목록에 이름만 남을 수 있다」와 「1분 이내 새 세션은 늦을 수 있다」를 지웠다.**
> 둘 다 KV 의 한계를 정직하게 적어 둔 문장이었는데, D1 으로 옮기면서 **사실이 아니게 됐다.**
> 한계가 사라지면 그 한계를 적은 문장도 같이 지워야 한다 — 안 지우면 이번엔 반대 방향으로 거짓말한다.

⚠️ **법률 검토는 아직 안 받았다.** 위 표는 *사실 대조*이지 법적 충분성 판정이 아니다.
국외이전 고지·동의 방식(로그인 진행 = 동의)과 만 14세 항목은 **정식 출시(홍보·결제) 전에 검토받을 것.**
네이버 검수에 낸 문서이므로 **문구를 고치면 검수 자료도 같이 고친다**(`brand/NAVER-REVIEW.md`).

---

## 배포 전 (매번)

```bash
npm test          # 전부 통과해야 한다 (test-friends 75 · hash · sw · dist 포함)
npm audit         # 0 vulnerabilities
npm run build     # dist/ 재생성
```

## 배포

```bash
npx wrangler pages deploy --project-name shhh-app --branch main --commit-dirty=true
```

⚠️ **`--branch main` 을 빼면 프리뷰로 간다.** git 브랜치가 `cf-pages` 라 그렇다 — 한 번 겪었다.
프로덕션인지는 `npx wrangler pages deployment list --project-name shhh-app` 의 `Environment` 열로 확인한다.

## 배포 후 검증

```bash
# ⚠️ 검증 명령에 함정이 셋 있다. 하나라도 빠지면 **멀쩡한 배포를 실패로 오진한다**(전부 겪었다):
#    ① `?cb=` — 안 붙이면 엣지 캐시가 옛 파일을 준다.
#    ② `-L`   — Pages 는 `/privacy.html` 을 `/privacy` 로 **308** 보낸다. 안 따라가면 본문이 빈다.
#    ③ 상태코드가 아니라 **Content-Type** 을 본다 — 없는 경로에 index.html 을 200 으로 준다.
for u in /CLAUDE.md /worker/index.js /wrangler.jsonc /package.json /scripts/test-friends.mjs; do
  curl -sL -o /dev/null -w "$u %{content_type}\n" "https://shhh-app.pages.dev$u?cb=$RANDOM$RANDOM"
done
#   → 전부 text/html 이어야 한다 (= 파일이 없어서 index.html 로 떨어진 것)

# 방침이 실제로 갱신됐는지 (-L 없으면 308 만 받는다)
curl -sL "https://shhh-app.pages.dev/privacy.html?cb=$RANDOM$RANDOM" | grep -oE "마지막 수정: [0-9-]+"

curl -s  https://shhh-app.pages.dev/api/health     # {"ok":true,"ready":?,"providers":[...]}
curl -sI https://shhh-app.pages.dev/api/ready | head -1   # 200 이어야 정상
curl -sI https://shhh-app.pages.dev/ | grep -i content-security-policy
for p in kakao naver google; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "https://shhh-app.pages.dev/api/login/$p"   # 302 = 정상, 503 = 키 없음
done
```

⚠️ **세 번은 재라**(함정 48·57). 배포 직후 몇 초는 옛 코드가 응답하고, 한 번만 재면 "고쳤는데 안 먹힌다"고 오진한다.

### 롤백
```bash
npx wrangler pages deployment list --project-name shhh-app   # 되돌릴 Id 확인
```
그 뒤 Cloudflare 대시보드 → Pages → shhh-app → 해당 배포 → **Rollback**.
(직전 성공 배포가 계속 살아 있으므로 라이브가 죽지는 않는다.)

---

## OAuth — 사람이 해야 하는 것

**비밀값은 사람이 넣고 사람이 보관한다.** 값을 문서·로그·명령 출력에 남기지 않는다.

```bash
cd ~/Desktop/claude/shhh\!
for k in KAKAO_ID KAKAO_SECRET NAVER_ID NAVER_SECRET GOOGLE_ID GOOGLE_SECRET; do
  npx wrangler pages secret put $k --project-name shhh-app
done
npx wrangler pages secret list --project-name shhh-app     # 이름만 보인다
```

| 이름 | 없으면 | 어디에 |
|---|---|---|
| `STATE_KEY` | **로그인 전체가 503** (실패-닫힘) | 시크릿 |
| `KAKAO_ID`/`SECRET`, `NAVER_ID`/`SECRET`, `GOOGLE_ID`/`SECRET` | 그 제공자만 버튼이 안 뜬다 | 시크릿 |
| `MASTER_UIDS` | 아무도 마스터가 아니다(안전한 기본값) | 시크릿 · **값이 내부 uid 로 바뀌었다** |
| `APP_ORIGIN`, `APP_URL` | 복귀 주소 검증이 안 선다 | `wrangler.jsonc` |
| `DEV_ORIGINS` | (운영에는 넣지 않는다) | 개발 Worker 전용 |

⚠️ **Preview 환경은 시크릿이 따로다.** 프로덕션에 넣어도 프리뷰 배포에서는 로그인이 503 이다.
⚠️ 콜백 URL 은 `worker/SETUP.md` 그대로. **옛 `workers.dev` 리디렉션 URI 는 콘솔에서 지울 것** —
문이 둘이면 잠금은 약한 쪽을 따른다.

---

## 아직 남은 실기기 확인

- [ ] 안드로이드·아이폰에서 PWA 설치
- [ ] **설치된 PWA(standalone)에서 로그인 리다이렉트가 앱으로 돌아오는지** — 시뮬레이터로는 확인 불가(함정 39)
- [ ] 다른 기기 로그인 → 단어장 동기화
- [ ] 전체 로그아웃 후 다른 기기가 401
- [ ] 악성 해시(`#q=%E0%A4%A`)에서 콘솔 오류 0 ← 데스크톱 크롬에서는 확인함
- [ ] DevTools → Application → Cache Storage 에 `?code=`·`?state=` 주소가 없는지

## 엣지 캐시 (미해결, 알고 있는 것)

`shhh-app.pages.dev/CLAUDE.md` 를 **쿼리 없이** 부르면 아직 옛 파일이 온다
(`cf-cache-status: HIT`, `s-maxage=604800` = 7일). 배포 자체는 깨끗하다(`?cb=` 로 확인).
- 심각도 낮음: 그 내용은 **공개 레포에 그대로 있고** 비밀값이 없다.
- `*.pages.dev` 는 Cloudflare 소유 존이라 사용자가 퍼지할 수 없다. **커스텀 도메인을 붙이면 풀린다**
  (WAF 레이트리밋과 같은 조건).
