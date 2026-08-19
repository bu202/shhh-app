# shhh! — 텍스트 → 한국수어 (KSL)

연인·친구가 **실제 한국수어를 배워서** 소리 없이 대화하게 만드는 앱. 목적은 수어를 알리는 것이다.

라이브: <https://shhh-app.pages.dev> · 개발 규칙과 함정 기록은 [`CLAUDE.md`](CLAUDE.md)

## 스택 (실제)

**빌드 도구·프레임워크 없음.** 브라우저에 나가는 코드는 의존성 0이다.

| 계층 | 무엇 | 파일 |
|---|---|---|
| 입력 수신 (UI) | 화면 전환·이벤트·렌더 | `js/app.js` · `js/auth.js` · `js/friends.js` |
| 핵심 로직 | 문장 매칭·활용 풀기·동기화 판정 | `js/app.js`(`matchSentence`) · `js/auth.js`(`syncPlan`) |
| 데이터·외부 접근 | **계정 API 호출은 여기에만** | `js/authApi.js` |
| 서버 | OAuth 3사 + 단어장·친구 (Cloudflare Pages Functions) | `worker/index.js` ← `functions/api/[[path]].js` |
| 저장소 | Cloudflare **D1** (`worker/schema.sql` · `migrations/`) | — |

> 계층 규칙(grep 으로 확인 가능): **계정 API(`/api/*`)를 부르는 `fetch()` 는 `js/authApi.js` 에만 나온다.**
> (`js/app.js` 의 `fetch()` 는 `data/ksl-*.json` 정적 사전을 읽는 것뿐이다 — 계정도 세션도 안 탄다.)
> `worker/index.js` 는 Pages Functions 로 번들되며 **정적으로 배포되지 않는다.**

`package.json` 의 의존성(`@anthropic-ai/sdk`)은 `scripts/` 전용 개발 도구다 — 앱은 쓰지 않는다.

## 로컬 실행

```bash
cd ~/Desktop/claude/shhh\!

# ① 앱만 (로그인·친구 없이). no-store 라 옛 JS/CSS 를 안 문다
python3 scripts/serve.py 8000            # http://localhost:8000

# ② API 까지 (Pages Functions 포함). 배포와 같은 모양으로 돈다
npm run build
npx wrangler pages dev dist              # http://127.0.0.1:8788
```

⚠️ 로컬에서는 **로그인이 안 된다.** 복귀 주소가 `APP_ORIGIN` 하나로 잠겨 있기 때문이다
(열어 두면 같은 와이파이에 있는 사람이 세션 토큰을 가져갈 수 있다 — 함정 57).
로그인을 로컬에서 보려면 운영 Worker 를 여는 게 아니라 **개발용 Pages 프로젝트를 따로** 세운다.

## 테스트

```bash
npm test      # 아래 전부. 하나라도 실패하면 배포하지 않는다
npm audit
```

| 검사 | 무엇을 재나 |
|---|---|
| `test-friends` (115) | **로그인 왕복 표(브라우저 결속)**·**친구 쌍 유일성**·친구 권한·세션 무효화·제공자ID 비공개·본문 한도·state 서명·CSRF |
| `test-auth` (24) | 어느 쪽 단어장이 새것인지(`syncPlan`) — **기기 시계를 안 본다** · 계정 교체 · 로그아웃 정리 |
| `test-migrations` | `migrations/` 를 다 돌린 모양 == `worker/schema.sql` · 중복 관계 정리 |
| `test-hash` | 조작된 주소 해시가 앱 초기화를 못 멈춘다 |
| `test-sw` | SW 가 OAuth 왕복 주소·API·실패 응답을 캐시하지 않는다 |
| `test-dist` | 배포 산출물에 내부 파일이 없다 |
| `test-match`·`test-compounds`·`test-fingers`·`test-assemble`·`test-book`·`test-home`·`test-meaning`·`test-knn`·`test-screen` | 사전·매칭·수형·지화 |

## 빌드와 배포

**배포되는 것은 `dist/` 뿐이다.** 레포 루트가 아니다 — 예전엔 루트를 통째로 배포해
`CLAUDE.md`·`worker/index.js`·`scripts/` 가 공개됐다.

```bash
npm run build                                    # allowlist 로 dist/ 생성 (scripts/build.mjs)
npx wrangler pages deploy --project-name shhh-app --branch main
```

- 넣을 파일 목록은 `scripts/build.mjs` 의 `INCLUDE` **한 곳**. 새 정적 파일을 추가하면 여기에 적는다
  (allowlist 라 안 적으면 배포되지 않는다 — 기본값이 안전한 쪽).
- ⚠️ `--branch main` 을 빼면 프리뷰로 간다(git 브랜치가 `cf-pages` 라서).
- ⚠️ **`--commit-dirty=true` 로 운영에 배포하지 않는다.** 무엇이 올라갔는지 커밋으로 되짚을 수 없어
  롤백할 대상이 없어진다(`CLAUDE.md` 9번). 커밋한 뒤 배포한다.
- ⚠️ 스키마를 바꿨으면 **`migrations/` 에 새 번호 파일**을 만든다. `worker/schema.sql` 을 원격에
  다시 실행하는 방식으로는 컬럼 추가가 반영되지 않는다(전부 `IF NOT EXISTS` 라 조용히 건너뛴다).
- 배포 전후 절차와 검증 명령은 **[`docs/SECURITY_RELEASE_CHECKLIST.md`](docs/SECURITY_RELEASE_CHECKLIST.md)**.

## 환경 변수

값은 넣지 않는다. **비밀값은 `wrangler pages secret put` 으로만** 넣고 `wrangler.jsonc` 에 적지 않는다
(그 파일은 공개 레포에 올라간다).

| 이름 | 어디에 | 없으면 |
|---|---|---|
| `STATE_KEY` | 시크릿 | 로그인 전체가 503 (실패-닫힘) |
| `RL_KEY` | 시크릿 | 레이트리밋이 **세지 않는다** → `/api/ready` 503 |
| `SIGNUP_STATE_KEY` (32바이트 base64url) | 시크릿 | 회원가입 503 |
| `TOMBSTONE_KEY` | 시크릿 | 회원가입 503 |
| `DELETION_KEY` | 시크릿 | 계정 삭제 503 |
| `KAKAO_ID` `KAKAO_SECRET` `NAVER_ID` `NAVER_SECRET` `GOOGLE_ID` `GOOGLE_SECRET` | 시크릿 | 그 제공자 버튼이 안 뜬다 |
| `MASTER_UIDS` | 시크릿 | 아무도 마스터가 아니다 |
| `DEV_ORIGINS` | 시크릿(**개발 Worker 에만**) | 로컬·LAN 주소로 로그인 못 한다(운영에는 넣지 않는다) |
| `APP_ORIGIN` `APP_URL` | `wrangler.jsonc` | 복귀 주소 검증이 안 선다 |
| **`DB`** (D1 `shhh-db`) | `wrangler.jsonc` | 전부 안 된다 |
| **`LEDGER`** (D1 `shhh-ledger`) | `wrangler.jsonc` | **사용자 데이터 API 가 전부 503** — 표식 없는 삭제·추적 없는 쓰기를 만들지 않는다 |

- **서로 겸용하지 않는다.** 용도가 다른 비밀값을 돌려 쓰면 하나를 교체할 때 다른 하나가 같이 무너진다.
- ⚠️ **`LEDGER` 는 아직 안 붙였다**(ledger D1 미생성). 그래서 지금 배포하면 계정 기능이 열리지
  않는다 — 그게 의도된 상태다. 만드는 절차는 [`docs/OPS_RUNBOOK.md`](docs/OPS_RUNBOOK.md).
- 이 표는 손으로 세지 않는다. `scripts/test-config.mjs` 가 **코드에서 `env.*` 를 읽어**
  이 표·`worker/SETUP.md`·`wrangler.jsonc`·runbook 과 대조한다.

설정이 됐는지는 `curl -s https://shhh-app.pages.dev/api/health` 로 본다 — **값은 안 보이고 있나 없나만** 나온다.
등록 절차는 [`worker/SETUP.md`](worker/SETUP.md), 원격 작업 순서는 [`docs/OPS_RUNBOOK.md`](docs/OPS_RUNBOOK.md).

## 데이터

한국수어 데이터는 **문화공공데이터광장(kcisa)** 일상생활 수어 API. 동영상이 아니라
**수형 이미지(`signImages`) + 텍스트 설명(`signDescription`)** 이다.

```bash
node scripts/fetch-ksl.mjs '<서비스키>'   # → data/ksl-dict.json (키는 로컬에서만)
node scripts/fetch-ksl.mjs --mock         # 매핑 로직 자가검증(키·네트워크 불필요)
```

매핑 수정은 `normalizeEntry()` **한 곳**. 키 발급은 [`docs/API_KEY_GUIDE.md`](docs/API_KEY_GUIDE.md).

### 지화(한글 지문자)

사전에 없는 단어는 한글을 자모로 분해해 지화 이미지로 표현한다.
[Wikimedia Commons — Korean manual alphabet](https://commons.wikimedia.org/wiki/Category:Korean_manual_alphabet)
(Kwamikagami), **CC BY-SA 3.0** — 크레딧 표기 의무가 있고 푸터에 있다. `assets/fingerspelling/*.jpg` 32장.
된소리(ㄲ=ㄱㄱ 등)는 근사 표기라 현행 표준과 미세차이가 있을 수 있다.

## ⛔ 이 저장소의 절대 규칙

**실제 수어만 보여준다.** 뜻을 지어내지 않고, 그림은 반드시 그 표제어의 것이며,
사람이 확인하지 않은 것은 화면이 「확인 안 됨」이라고 말한다.
카피에도 그대로 적용된다 — **"정확한 수어"·"검증된"은 쓰지 않는다**(합성 2,485 중 사람이 확인한 건 12건).
자세한 것은 [`CLAUDE.md`](CLAUDE.md) 의 「⛔ 절대 규칙」.
