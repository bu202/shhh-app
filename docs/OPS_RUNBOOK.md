# 운영 절차서 (OPS_RUNBOOK)

이 문서는 **원격에 무엇을 어떤 순서로 만들고 붙이고 배포하는가**만 다룬다.
왜 그렇게 설계했는지는 `docs/STAGE3_SIGNUP_SECURITY_DESIGN.md`, 지금 어디까지 됐는지는
`CLAUDE.md` §1-1 과 `docs/HANDOFF.md` 가 말한다.

<!-- 현재상태:시작 -->

## 0. 지금 상태 (2026-08-22)

- **4단계는 로컬 구현 완료다. 원격은 아무것도 하지 않았다** — 배포 0건 · 원격 D1 쓰기 0건 ·
  ledger D1 미생성 · 새 시크릿 미등록 · 정리 Worker 미배포.
- 아래 절차는 **한 번도 실행된 적이 없다.** 명령은 검증됐지만 결과는 실측되지 않았다.
- **공개 OAuth·계정 기능 출시는 No-Go다.** 이 문서를 끝까지 실행해도 그대로다 —
  남은 것은 §9 에 있다.
- 이 문서의 모든 원격 작업은 **사용자 승인 대상**이다(`CLAUDE.md` §9). Claude 는 실행하지 않는다.

<!-- 현재상태:끝 -->

<!-- 배포전필수: LEDGER 바인딩 -->

## 1. 무엇이 필요한가 — 한 장 요약

| 종류 | 이름 | 어디에 | 없으면 |
|---|---|---|---|
| D1 | `shhh-db` (`DB`) | `wrangler.jsonc` | 전부 안 된다 |
| D1 | **`shhh-ledger` (`LEDGER`)** | `wrangler.jsonc` · 정리 Worker 설정 | **사용자 데이터 API 가 전부 503**(fail-closed) |
| 시크릿 | `STATE_KEY` | Pages | 로그인 503 |
| 시크릿 | `RL_KEY` | Pages | 레이트리밋이 세지 않는다 → `/api/ready` 503 |
| 시크릿 | **`SIGNUP_STATE_KEY`**(32바이트 base64url) | Pages | 가입 503 |
| 시크릿 | **`TOMBSTONE_KEY`** | Pages | 가입 503 |
| 시크릿 | **`DELETION_KEY`** | Pages | 계정 삭제 503 |
| 시크릿 | `KAKAO_ID` `KAKAO_SECRET` `NAVER_ID` `NAVER_SECRET` `GOOGLE_ID` `GOOGLE_SECRET` | Pages | 그 제공자 버튼이 안 뜬다 |
| 시크릿 | `MASTER_UIDS` | Pages | 아무도 마스터가 아니다 |
| 시크릿 | `DEV_ORIGINS` | **개발 Worker 에만** | 로컬·LAN 로그인이 안 된다. ⛔ **운영에 넣지 않는다** — 넣으면 `/api/login/kakao?return=http://192.168.…` 로 세션이 같은 와이파이의 남의 서버로 간다 |
| 변수 | `APP_ORIGIN` `APP_URL` | `wrangler.jsonc` | 복귀 주소 검증이 안 선다 |
| 변수 | **`EDGE_GUARD`** (`waf` 또는 `ratelimit`) | `wrangler.jsonc` | **계정 라우트가 전부 503** — 선언되지 않은 방어를 있다고 보지 않는다(위협 52·55). 모드별 절차는 §13-2 |
| 바인딩 | `RL`(엣지 레이트리밋) | `wrangler.jsonc` | `EDGE_GUARD="ratelimit"` 인데 없거나 `limit()` 이 함수가 아니면 **`none` 으로 떨어져 계정 라우트 503**. ⚠️ **Pages Functions 에는 못 붙인다**(§13) |
| 시크릿 | **`READY_KEY`** | Pages | `/api/ready` 의 **진단을 아무도 못 본다**(키 없는 호출은 DB 를 만지지 않고 503). 없다고 전부 공개로 돌아가지 않는다(위협 56) |
| 시크릿 | **`SESSION_ENVELOPE_KEY`** | Pages | 세션 쿠키 서명을 만들 수도 확인할 수도 없다 → **계정 라우트 전부 503**. ⚠️ **바꾸면 모든 세션이 로그아웃된다**(§5-1) |
| 시크릿 | **`TURNSTILE_SECRET`** | Pages | **공개 회원가입만** 503. 로그인·읽기·쓰기에는 안 쓴다(결정 3) |
| 변수 | **`TURNSTILE_SITE_KEY`** | `wrangler.jsonc` vars | 가입 화면이 위젯을 못 그린다 → `signupReady:false`. **공개 값이다** |
| 변수 | `DEV_RATE_LIMIT` | **로컬 전용**(`.dev.vars`·테스트) | 로컬에서 계정 라우트가 503. ⛔ **배포 설정에 넣지 않는다** — 넣으면 남용 방어 없이 열린 채 배포된다. 이 값으로는 `/api/ready` 가 200 이 되지 않는다 |

> **서로 겸용하지 않는다.** 용도가 다른 비밀값을 돌려 쓰면 하나를 교체할 때 다른 하나가 같이
> 무너진다. `STATE_KEY`(로그인 state 서명) · `SIGNUP_STATE_KEY`(가입 state 암호화) ·
> `TOMBSTONE_KEY`(소비 표식) · `DELETION_KEY`(삭제 표식) · `RL_KEY`(리미터 버킷) ·
> `SESSION_ENVELOPE_KEY`(세션 쿠키 서명) · `READY_KEY`(진단) · `TURNSTILE_SECRET`(사람 확인)은
> **여덟 개의 다른 값**이다. `scripts/test-friends.mjs` T71-e 가 겸용을 실제로 거부하는지 잰다.

### 5-1. ⚠️ `SESSION_ENVELOPE_KEY` 를 바꾸면 **전원 로그아웃**이다

세션 쿠키는 이 키로 서명돼 있고, 검증은 **D1 을 만지기 전에** 일어난다(결정 4). 키를 바꾸면
기존 쿠키의 서명이 전부 안 맞아 **모든 사용자가 즉시 로그아웃**된다 — `sessions` 행은 남아
있지만 아무도 그 행에 닿지 못한다(다음 로그인에 정리된다).

- **교체가 정당한 때**: 키가 샜다고 볼 만한 사건. 그때는 전원 로그아웃이 **목적**이다.
- **교체하면 안 되는 때**: 「정리하는 김에」. 사용자에게는 이유 없는 강제 로그아웃으로 보인다.
- 교체 절차: 새 값 등록 → 배포 → `/api/ready` 200 확인 → 공지. 되돌려도 옛 쿠키는
  이미 브라우저에서 지워졌을 수 있으므로 **롤백이 원상복구가 아니다.**

**목록을 손으로 세지 않는다.** `scripts/test-config.mjs` 가 코드에서 `env.*` 를 읽어
이 표·README·`worker/SETUP.md`·`wrangler.jsonc` 와 대조한다. 코드가 새 값을 요구하는데
문서에 없으면 `npm test` 가 실패한다.

## 2. ledger D1 만들기

```bash
npx wrangler d1 create shhh-ledger              # → database_id 가 출력된다
# migration 을 **번호 순서대로** 건다. 새로 만드는 DB 라도 순서를 지킨다 —
# `worker/ledger-schema.sql` 은 현재 기준 스키마일 뿐 운영 migration 파일이 아니다.
npx wrangler d1 execute shhh-ledger --remote --file migrations-ledger/0001_ledger_init.sql
npx wrangler d1 execute shhh-ledger --remote --file migrations-ledger/0002_deletion_key_check.sql
npx wrangler d1 execute shhh-ledger --remote --file migrations-ledger/0003_rate_limits.sql
# 표 여섯과 초기 행이 들어갔는지 (mode=open · epoch 는 아무 값)
npx wrangler d1 execute shhh-ledger --remote --command \
  "SELECT mode, epoch FROM maintenance WHERE id = 1"
npx wrangler d1 execute shhh-ledger --remote --command \
  "SELECT COUNT(*) FROM deletions; SELECT COUNT(*) FROM write_leases; SELECT COUNT(*) FROM cleanup_runs; SELECT COUNT(*) FROM deletion_keys; SELECT COUNT(*) FROM rate_limits"
```

- `database_id` 는 **비밀값이 아니다**(KV 네임스페이스 id 와 같은 성격). 설정 파일에 적어도 된다.
- ⚠️ **id 를 추측해서 미리 적지 않는다.** 가짜 id 는 배포를 통과하고 **첫 질의에서** 터진다.
- ⚠️ 여섯 표가 다 있어야 한다(`0003` 이 `rate_limits` 를 더했다 — 남용 방지 카운터가
  2026-08-20 에 주 D1 에서 옮겨 왔다 · 위협 49). `readMode()` 가 지나가는 것은 `maintenance`
  하나뿐이라, 절반만 걸린 ledger 는 게이트를 멀쩡히 통과하고 **첫 계정 삭제에서만** 터진다.
  그 실패를 배포자가 먼저 보게 하려고 `/api/ready` 의 `ledger` 가 여섯 표를 다 건드린다.
- ⚠️ **`deletion_keys` 는 비워 둔다. 손으로 채우지 않는다.** 첫 계정 삭제가 지금 `DELETION_KEY` 의
  검사값을 스스로 적는다(TOFU). 손으로 적으면 「그때 그 키」의 증거가 아니라 **적은 사람의 주장**이
  된다. 이 표가 있어야 reconciliation 이 잘못된 키로 살아 있는 계정을 승격하지 않는다(위협 46).
- ⛔ **`DELETION_KEY` 를 바꾸면서 `DELETION_KEY_VERSION` 을 그대로 두지 않는다.** 그러면 다음
  삭제가 `DELETION_KEY mismatch` 로 503 이 된다(그게 맞는 실패 방향이다 — 조용히 도는 것보다 낫다).

**중단 기준:** 위 두 확인 질의 중 하나라도 실패하면 여기서 멈춘다. 다음 단계로 가지 않는다.

## 3. 정리 Worker 설정 만들기

```bash
cp worker/cleanup/wrangler.example.jsonc worker/cleanup/wrangler.jsonc
# 만들어진 파일에서 LEDGER 의 database_id 를 §2 의 결과로 바꾼다 (0000PLACEHOLDER… 자리)
```

- `worker/cleanup/wrangler.jsonc` 는 **`.gitignore` 에 있다.** 템플릿과 실제 설정을 파일로
  갈라 둔 이유는 하나다 — placeholder 가 배포 경로에 들어갈 수 없게 하려고.
- 배포는 §6 에서 한다. 여기서는 파일만 만든다.

## 4. Pages 에 바인딩 추가

`wrangler.jsonc` 의 `d1_databases` 에 한 줄 더한다.

```jsonc
{ "binding": "LEDGER", "database_name": "shhh-ledger", "database_id": "<§2 의 결과>" }
```

- ⚠️ **대시보드에서 붙이는 길은 없다.** Pages 프로젝트에 Wrangler 설정 파일이 있으면
  공식 문서상 그 파일이 원본이 되고 대시보드에서 같은 항목을 편집할 수 없다
  ("This file becomes the source of truth when used, meaning that you can not edit the same
  fields in the dashboard" — Pages / Wrangler configuration).
- 커밋한다. `--commit-dirty=true` 로 배포하지 않으므로 커밋이 먼저다.

## 5. 시크릿 등록

```bash
# 값은 명령 출력·로그·커밋 어디에도 남기지 않는다. 히스토리에도 남기지 않는다:
#   ⚠️ zsh 에서는 명령 앞에 **공백 한 칸**을 두면 히스토리에 안 남는다(setopt HIST_IGNORE_SPACE).
#   ⚠️ `echo "값" | wrangler …` 를 쓰지 않는다 — 히스토리와 프로세스 목록에 값이 남는다.
#   아래처럼 파일도 거치지 않고 표준입력으로 넣는다(입력이 화면에 안 보인다).
 npx wrangler pages secret put SIGNUP_STATE_KEY --project-name shhh-app
 npx wrangler pages secret put TOMBSTONE_KEY    --project-name shhh-app
 npx wrangler pages secret put DELETION_KEY     --project-name shhh-app

# 등록된 이름 목록(값은 안 보인다)
npx wrangler pages secret list --project-name shhh-app
```

- `SIGNUP_STATE_KEY` 는 **base64 로 디코딩했을 때 정확히 32바이트**여야 한다. 아니면 가입이
  fail-closed 다(짧은 키를 조용히 늘려 쓰지 않는다). 만드는 법:
  `openssl rand -base64 32` — **출력은 이 문서에도, 커밋에도, 채팅에도 붙여넣지 않는다.**
- `TOMBSTONE_KEY` · `DELETION_KEY` 는 길이 제약이 없다. `openssl rand -base64 32` 로 충분하다.
- ⚠️ **preview 환경에는 아직 `RL_KEY` 가 없다.** preview 로도 계정 기능을 여는 날 같이 넣는다.

**중단 기준:** `secret list` 에 §1 표의 이름이 전부 보이지 않으면 배포하지 않는다.

## 6. 주 D1 에 `0005` 적용

```bash
# 1) 백업 먼저. 복원 시험까지 끝내고 진행한다(docs/HANDOFF.md §4-3).
npx wrangler d1 export shhh-db --remote --output backup-$(date +%Y%m%d).sql
# 2) 적용 전 실측 — 새 표가 아직 없어야 한다
npx wrangler d1 execute shhh-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('policy_events','consumed_signup_states')"
# 3) 적용
npx wrangler d1 execute shhh-db --remote --file migrations/0005_policy_events_and_signup_states.sql
# 4) 적용 후 실측 — 두 표가 생겼고 users 는 그대로다
npx wrangler d1 execute shhh-db --remote --command \
  "SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS pe FROM policy_events; \
   SELECT COUNT(*) AS css FROM consumed_signup_states"
```

**중단 기준:** ③이 실패하면 ④를 하지 않고 멈춘다. `users` 수가 변했으면 즉시 멈추고 조사한다.

## 7. 배포 — 순서가 곧 방어다

**순서를 바꾸지 않는다.** 앞의 것이 없으면 뒤의 것이 사용자에게 오류로 보인다.

1. §2 ledger D1 생성 + migration
2. §5 시크릿 등록
3. §6 주 D1 `0005` 적용
4. §4 바인딩 커밋
5. **앱 배포** — `npm test` 통과 후, 커밋한 상태에서:
   ```bash
   npm run build
   npx wrangler pages deploy --project-name shhh-app --branch main
   ```
   - `--branch main` 을 빼면 프리뷰로 간다(git 브랜치가 `cf-pages` 다).
   - **`--commit-dirty=true` 를 쓰지 않는다.** 무엇이 올라갔는지 커밋으로 되짚을 수 없으면
     롤백할 대상이 없어진다.
6. **정리 Worker 배포** — `npx wrangler deploy --config worker/cleanup/wrangler.jsonc`
7. §8 검증

> **개인정보 문서와 코드는 같은 배포에 실린다.** `privacy.html`·`policies/` 는 `dist/` 안에
> 있으므로 앱 배포 하나로 원자적으로 바뀐다. **문서만 먼저 바꾸거나 코드만 먼저 바꾸지 않는다** —
> 화면이 말하는 것과 서버가 하는 것이 어긋나는 창이 생긴다.

**중간 실패 시:** 5에서 실패하면 6을 하지 않는다(크론이 없는 것보다 앱이 반쯤 바뀐 것이 나쁘다).
6에서 실패하면 앱은 그대로 두고 크론만 다시 배포한다 — 정리가 밀리는 것은 `/api/ready` 의
`cleanupStale` 로 보이고 사용자를 막지 않는다. 롤백 절차는 `docs/HANDOFF.md` §4-3.

## 8. 배포 후 확인 — `/api/ready` 의 기대값

```bash
# ⚠️ 진단은 운영자 키를 요구한다(위협 56). 키 없는 호출은 DB 를 만지지 않고 503 이다.
#    값을 명령줄에 그대로 적지 않는다 — 셸 기록에 남는다.
read -rs READY_KEY            # 붙여넣고 Enter (화면에 안 보인다)
curl -s -H "X-Ready-Key: $READY_KEY" https://shhh-app.pages.dev/api/ready | python3 -m json.tool
unset READY_KEY
```

| 키 없이 부르면 | `{"ok":true,"ready":false,"diagnostics":false}` · **503** · 두 DB 질의 0건 |
|---|---|

| 필드 | 기대값 | 아니면 |
|---|---|---|
| `ready` | `true` (HTTP 200) | 아래를 하나씩 본다 |
| `mode` | `"open"` | 유지보수가 켜져 있다 |
| `configReady` | `true` | 시크릿·바인딩·제공자 중 빠진 것이 있다(§1·§5) |
| `db` | `true` | 주 D1 이 답하지 않거나 migration 이 덜 걸렸다(§6) |
| `ledgerBound` | `true` | **바인딩이 없다**(§4) |
| `ledger` | `true` | 바인딩은 있는데 **표가 없다**(§2 의 migration) |
| `signupReady` | `true` | 가입 전용 키가 없다(§5) |
| `cleanupStale` | `false` | 정리 크론이 두 시간 넘게 성공하지 못했다(§6 배포 확인) |
| `cleanupAlert` | `false` | 확정 안 된 삭제 표식이 있거나 크론이 3회 연속 실패했다 — **사람이 본다** |
| `providers` | 등록한 제공자 이름들 | 비어 있으면 id/secret 쌍이 안 맞거나 ledger 가 없거나 **남용 방어가 없다** |
| `abuseReady` | `true` | **엣지 남용 방어가 선언되지 않았거나 검증에 실패했다.** 이 값이 거짓이면 계정 라우트가 전부 503 이다 — 지금 이 프로젝트가 그 상태다(§13 · 위협 52·55). ⚠️ `waf` 모드에서 이 값이 참인 것은 **앱 쪽 조건이 갖춰졌다**는 뜻이지 WAF 규칙이 실제로 있다는 뜻이 아니다 — 그건 §13-2 의 외부 점검이 답한다 |
| `deletionEvidence` | `true` | **지금 `DELETION_KEY` 가 표식을 만든 키와 다르거나**, 모르는 키 버전이 섞여 있다. ⛔ 그 상태로 reconciliation 을 돌리면 **살아 있는 계정이 「지워진 사람」으로 승격**된다(위협 46·51). 키를 되돌리기 전에는 아무것도 하지 않는다 |

- ⚠️ **배포 직후 약 1분은 옛 응답이 올 수 있다**(별칭 전파 실측). 이상하면 한 번 더 재고 나서
  원인을 말한다.
- 값·비밀값 이름·표 이름·SQL 은 이 응답에 **절대 실리지 않는다.** 무엇이 없는지는 이 표가 답한다.

추가 smoke test(Origin 없는 상태 변경이 403 인지 등)는 `docs/HANDOFF.md` §4-4.

## 9. 크론이 실제로 도는지

```bash
npx wrangler d1 execute shhh-ledger --remote --command \
  "SELECT last_ok_at, last_try_at, fail_streak, open_pending FROM cleanup_runs WHERE id = 1"
```

- 배포 후 **한 시간 안에** `last_ok_at` 이 채워져야 한다(크론은 `0 * * * *`).
- `fail_streak >= 3` 이면 `/api/ready` 의 `cleanupAlert` 가 `true` 가 된다. 실패 사유는
  `cleanup_runs.last_error` 와 Workers observability 로그에 있다 — **HTTP 로 열지 않는다**
  (정리 Worker 에는 `fetch` 핸들러가 없고 `workers_dev:false` 다).
- `open_pending > 0` 은 **확정되지 않은 삭제 표식**이다. 시간이 지나도 저절로 해결되지 않는다:
  계정이 살아 있으면 삭제가 실패한 것이고, 계정이 없으면 확정 기록만 실패한 것이다.
  판정은 사람이 하고, 승격은 `reconcile()`(유지보수 모드에서만) 이 한다. **지우지 않는다.**

## 10. 복원 — 지금은 금지다

- **주 D1 의 Time Travel `restore` 와 백업 복원은 운영상 금지다.** 해제 조건 9개는
  설계서 §10-8-0 이고, 2026-08-19 기준 셋이 미충족이다(⑤ 지금 이 순간 임차증 0건 ·
  ⑦ 옛 배포 차단 증명 · ⑨ T8).
- ⚠️ **앱 코드는 복원을 막지 못한다.** `worker/ops.js` 의 `restorePreflight()`·`restoreGate()` 는
  **사전점검**이다 — `wrangler d1 time-travel restore` 는 계정 권한으로 실행되고 이 코드를
  지나지 않는다. 그래서 그 함수들은 언제나 `restoreAllowed: false` 를 돌려준다.
  실제 통제는 코드 밖에 있다: 계정 권한, 승인 절차, 그리고 옛 배포를 없애는 일(§10-8-1).
- 복원이 꼭 필요하면 임의로 실행하지 않고 **사고 대응으로 승격**해 별도 승인을 받는다.
- `restore_closed` 를 다시 열 때는 `reopenReport(env)` 가 통과해야 한다. 그 판정은 **아무 인자도
  받지 않는다**(2026-08-19) — 대상 목록도, 표식을 만드는 함수도. 주 D1 과 ledger 를 직접 읽어
  스스로 만들고, 키 재료는 `DELETION_MARKERS` 레지스트리가 소유한다. `setMode(env, "open")` 도
  보고서를 받지 않고 그 자리에서 다시 판정한다.
- ⚠️ **`restore_closed` 에서 `maintenance` 로 곧장 갈 수 없다.** `maintenance` 도 `GET /book`·
  `GET /me`·`GET /friends/:id/book` 을 허용하는 상태라, 그리로 가면 자물쇠를 지나지 않는다
  (2026-08-19 재현 · 위협 43). 순서는 **`restore_closed` → (검증) → `open` → `maintenance`** 다.
- ⚠️ 전환은 **CAS** 다. 판정에 쓴 `mode`·`epoch` 이 그 사이에 바뀌면 「유지보수 전환이 경합했다」로
  실패한다. 그때는 **다시 판정한다** — 억지로 다시 부르지 않는다.

## 11. 옛 Pages 배포 정리

- Cloudflare Pages 는 배포마다 **영구 주소**를 주고, 바인딩은 프로젝트 단위라 **옛 배포에도
  같은 D1 이 붙어 있다.** 게이트·임차증은 그 코드가 실행될 때만 작동하므로, 게이트를 모르는
  옛 세대는 유지보수 중에도 읽고 쓴다(T8-b 가 이 사실을 고정해 둔다).
- 그래서 복원 금지 해제 조건 ⑦ 은 **코드로 못 채운다.** 옛 배포를 지우거나(`wrangler pages
  deployment delete`) Cloudflare Access 로 닿지 못하게 해야 한다 — 절차와 증명 항목은
  설계서 §10-8-1 의 D1~D12.
- ⚠️ 이것은 **파괴적 원격 작업**이다. 별도 승인 대상이고 이 문서만으로 실행하지 않는다.

## 12. 남은 것 — 이 문서를 다 해도 안 되는 것

| 무엇 | 왜 |
|---|---|
| **공개 OAuth·계정 출시** | No-Go. 아래가 전부 끝나야 재판정한다 |
| 옛 배포 차단(§11) | 복원 금지 해제 조건 ⑦ |
| ~~옛 엣지 캐시의 내부 파일 7개~~ | ✅ **2026-08-19 실측으로 닫혔다** — canonical 7개가 전부 SPA 폴백(`docs/HANDOFF.md` §4-5) |
| **분산 요청(여러 IP)의 쓰기 증폭** | 앱 리미터는 **IP·분당**까지만 좁힌다. 여러 IP 로 나눠 오면 앱 코드로 못 막는다 — **WAF · Rate Limiting · Turnstile** 은 존이 우리 것이어야 걸 수 있어 **도메인이 붙는 날** 함께 열린다(위협 47·50). ⚠️ **2026-08-20 부터 이것이 계정 기능의 전제 조건이다** — 붙기 전에는 계정 라우트가 503 이다(§13) |
| 세션 쿠키를 DB 없이 검증하기 | 지금 리미터는 인증 **앞**이라 신원이 IP 뿐이고, 그래서 공유 IP(CGNAT)가 버킷을 나눠 쓴다. uid 별로 되돌리려면 **서명된 세션 envelope**(전용 시크릿 하나 추가 · 기존 세션 전부 무효)가 필요하다. 지금은 사용자 0명이라 값싸지만, **바꾸는 순간 시크릿이 하나 더 는다** — 별도 결정 |
| ~~`rate_limits` 를 ledger D1 로 옮기기~~ | ✅ **2026-08-20 에 옮겼다**(위협 49 · migration `migrations-ledger/0003`). 「주 D1 은 임차증 안에서만 만진다」에 예외가 없어졌다. ⚠️ 주 D1 의 옛 표는 **그대로 둔다** — 파괴적 migration 은 별도 승인이고 안 쓰는 표는 해가 없다 |
| **엣지 남용 방어 자체** | 지금은 붙일 수단이 없다 — Pages Functions 지원 바인딩에 ratelimits 가 없고 `*.pages.dev` 에는 WAF 규칙을 못 건다. 그래서 **계정 라우트가 fail-closed 다**(위협 50). 선택지·비용은 §13 |
| 외부 법률 검토 L1~L15 | `docs/PRIVACY_LEGAL_REVIEW_PACKET.md`. Claude 가 법적 적합성을 판정하지 않는다 |
| 네이버·카카오 재승인 | 절차는 `docs/OAUTH_REAPPROVAL_RUNBOOK.md`. **배포와 `/api/ready` 확인이 끝난 뒤에** 낸다 — 검수자가 여는 화면이 최신이어야 한다 |
| 설치형 PWA 실검증 | iOS Safari · Android Chrome 에서 **설치한 뒤** 오프라인·업데이트를 직접 본다. Node 목이 통과했다고 오프라인이 되는 것이 아니다 |
| 바깥 origin 수형 그림의 오프라인 | `<img>` 로 받는 응답은 opaque(성공·실패 구분 불가)라 캐시하지 않는다. 하려면 그림을 우리 origin 으로 옮기거나 CORS 를 요청해야 한다(`service-worker.js` 의 `cacheable`) |
| legacy KV 폐기 | 방향만 승인됐다. 6단계 순서는 `docs/STAGE2_ACCOUNT_PRIVACY_DECISIONS.md` §11 |

## 13. 남용 방어 — 지금 없고, 그래서 계정 라우트가 닫혀 있다 (2026-08-22 개정)

**코드가 강제하는 것:** `EDGE_GUARD` 가 선언되지 않았거나 선언된 모드의 실재가 검증되지 않으면
`/api/health`·`/api/ready`·`/api/policies` 만 답하고, 나머지 요청은 **주 D1·ledger 어느 쪽도
만지기 전에** 503 이다. `/api/health` 는 `providers: []`·`abuseReady:false` 로 답해 버튼도
그리지 않는다.

> ⛔ **2026-08-22 정정.** 8판까지는 **`RL` 이라는 이름의 값이 있기만 하면** 방어로 인정됐다 —
> 문자열도, 빈 객체도, `limit()` 이 예외를 던지는 객체도 `abuseReady:true` 였고 그 상태에서
> `/api/ready` 는 200 이었다(위협 52). 그리고 **WAF·Turnstile 을 실제로 붙여도 `env.RL` 은
> 생기지 않아** 아래 A·C 는 코드에서 문을 열지 못했다(위협 55). 지금 계약은 설계서 §12-3 이다.

**왜 열지 않나:** 리미터가 셀 수 있는 신원은 **IP** 하나뿐이고(인증보다 앞에서 돌아야 하므로),
IP·분당 한도는 **IP 를 나누면 그대로 곱해진다.** 실측: 서로 다른 IP 100개가 한 번씩 보낸 익명
요청에 429 는 **0건**이고 ledger 쓰기는 **200건**이었다. D1 무료 한도는 하루 쓰기 10만 행이고,
바닥나면 **정상 사용자의 저장이 먼저 죽는다.**

**확인된 사실(공식 문서 · 2026-08):**

- Pages Functions 의 지원 바인딩 목록에 **ratelimits 가 없다**(Workers 전용). Turnstile 도
  바인딩이 아니라 **HTTP 검증**(`challenges.cloudflare.com/turnstile/v0/siteverify`)이다.
- Workers 의 Rate Limiting 바인딩은 한도를 **설정의 `simple.limit`·`period`** 에 고정한다 —
  `limit()` 인자는 `key` 뿐이라 **바인딩 하나로 여러 한도를 낼 수 없다**. `period` 는 10 또는 60.
  카운터는 **Cloudflare 위치(colo)별이고 eventually consistent** 라 전역 합계가 아니다.
- WAF 레이트리밋 규칙은 **우리 존**에 건다. `*.pages.dev` 는 Cloudflare 소유라 못 건다.
  **무료 등급은 규칙 1개 · 카운팅 IP · 주기 10초 · 규칙 식에 쓸 수 있는 필드는 Path·Verified Bot ·
  차단 유지 10초**다(Pro: 규칙 2개 · 주기 1분까지 · Host/URI/Query · 차단 1시간까지).
- D1 Free plan: 하루 **읽기 500만 행 · 쓰기 10만 행**. 인덱스 갱신도 쓰기로 센다.

### 13-1. ⛔ 사용자 결정 ① — 무엇을 붙일 것인가

**Claude 가 고르지 않는다.** 넷 다 돈·도메인·구조가 걸려 있다. 표의 「막는다/못 막는다」는
설계서 §12-3-3 의 수치와 같은 것이다.

| 안 | 무엇을 한다 | 막는 것 | **못 막는 것** | 비용 | 사용자 불편 | 코드 변경 | OAuth 재승인 |
|---|---|---|---|---|---|---|---|
| **A. 커스텀 도메인 + WAF** | 도메인을 사서 Cloudflare 존에 붙이고 Pages 에 연결한 뒤 WAF 규칙 1개(무료: IP·10초·경로)를 건다. `EDGE_GUARD="waf"` 를 선언하고 `APP_ORIGIN` 을 새 도메인으로 바꾼다 | **같은 IP 의 빠른 반복**을 엣지에서 끊는다(우리 D1 에 닿기 전). 캐시 퍼지도 그날 함께 열린다 | **여러 IP 의 저속 분산.** 무료 등급은 규칙 하나·10초 창이라 「IP 1,000개가 한 번씩」은 그대로 통과한다 | 도메인 연 단위 비용(약 1~2만 원) + Cloudflare 무료 | 없음 | **작다**(선언 + `APP_ORIGIN`) | **필요**(네이버·카카오 콜백 주소 전부 재등록 · 재검수) |
| **B. API 를 Workers 로 되돌리고 `ratelimits` 바인딩** | Pages Functions 대신 Worker 로 API 를 뺀다. 바인딩을 만들고 `EDGE_GUARD="ratelimit"` 을 선언한다 | **같은 IP 의 반복**을 엣지에서 끊는다(colo 별) | 여러 IP 의 분산 · **colo 를 옮겨 다니는 요청**(카운터가 위치별) | 무료 | 없음 | **크다** — 앱과 API 의 origin 이 갈라져 쿠키·CSP·CORS·네이버 조건을 되감아야 한다(2026-08 에 합친 작업을 되돌리는 것) | 갈라진 origin 에 따라 **필요할 수 있다** |
| **C. Turnstile 을 가입·로그인 앞에 둔다** | 위젯을 붙이고 서버가 토큰을 검증한다. **단독 모드가 아니다** — A 나 B 위에 얹는다 | **자동화된 대량 가입·로그인**을 크게 줄인다 | **인증된 읽기·쓰기 전체**(토큰은 가입·로그인에만 있다) · 사람이 직접 하는 남용 | 무료 | **는다**(가입·로그인마다 위젯) | 중간(위젯 + 검증 호출 + 실패 UI) | 불필요 |
| **D. 아무것도 안 한다(현 상태)** | 계정 라우트를 닫아 둔다 | **전부** — 계정 API 가 두 DB 를 만지기 전에 503 | 없음(공개 `/ready` 도 9판에서 닫혔다) | 0 | **계정 기능을 못 쓴다** | 없음 | 불필요 |

**비개발자용 예시**: A 를 고르면 「한 사람이 1초에 100번 두드리는 것」은 우리 서버에 닿기도 전에
막힙니다. 하지만 「서로 다른 1,000곳에서 한 번씩」은 그대로 들어옵니다 — 그건 무료 등급의
WAF 로도, 우리 코드로도 못 막습니다. D 를 고르면 그 1,000번도 전부 503 이지만, **로그인 자체가
없습니다.**

### 13-2. 고른 모드를 실제로 켜는 절차

**⚠️ 모드마다 켜는 방법이 다르다. 8판에서는 이 절이 없어서 A·C 를 골라도 문이 안 열렸다.**

**A(waf)**
1. 도메인을 Cloudflare 존에 붙이고 Pages 프로젝트에 커스텀 도메인을 연결한다.
2. `wrangler.jsonc` 의 `APP_ORIGIN`·`APP_URL` 을 새 도메인으로 바꾼다.
   ⚠️ **`*.pages.dev` 인 채로 `EDGE_GUARD="waf"` 를 선언하면 코드가 `none` 으로 떨어뜨린다** —
   그 조합에서는 WAF 규칙을 걸 수 없기 때문이다.
3. `"vars": { "EDGE_GUARD": "waf" }` 를 추가한다.
4. WAF 레이트리밋 규칙을 만든다(무료 등급: 경로 `/api/*` · IP · 10초).
5. 배포 후 **외부 점검**(코드가 대신 못 한다):
   - 새 도메인으로 `/api/health` → `abuseReady:true`
   - `https://shhh-app.pages.dev/api/book` → **403**(호스트 잠금)
   - 규칙 한도를 넘겨 보고 Cloudflare 대시보드의 **Security Events** 에 차단이 남는지 본다
   - 이 세 줄의 결과를 `docs/SECURITY_RELEASE_CHECKLIST.md` 에 **날짜와 함께 적는다**
6. OAuth 콜백 재등록 → `docs/OAUTH_REAPPROVAL_RUNBOOK.md`.

**B(ratelimit)**
1. Worker 전환(범위가 크다 — 별도 계획).
2. 설정에 `ratelimits` 를 넣는다. `simple.limit` 은 **`RL_MAX` 의 최댓값 이상**이어야 한다 —
   그보다 좁으면 엣지가 먼저 잘라 문서의 버킷별 숫자가 거짓이 된다(`scripts/test-config.mjs` 가 잰다).
3. `EDGE_GUARD="ratelimit"` 선언 → `/api/ready` 의 `abuseReady` 가 참이 되는지 확인.
   ⚠️ 바인딩이 있어도 `limit()` 이 함수가 아니거나 던지면 **계정 라우트는 503** 이다.

**C(turnstile · 보조)**
- A 나 B 를 먼저 켠 뒤에 얹는다. **단독으로는 `none`** 이다.
- 덮는 범위는 `POST /api/signup/start` 와 로그인 콜백뿐이다. 그 밖의 읽기·쓰기는 못 덮는다.

**D**: 아무것도 하지 않는다. 지금 상태다.

### 13-3. ⛔ 사용자 결정 ② — 서명 세션 envelope 을 지금 도입할 것인가

| | 도입한다 | 안 한다(현행) |
|---|---|---|
| 쿠키 없음·위조 쿠키 요청의 비용 | **ledger 쓰기 0건** (서명을 DB 없이 확인하고 401) | 요청당 **3건**(카운터 1 + 임차증 2) |
| 하루 10만 쓰기를 태우는 데 필요한 익명 요청 | 사실상 불가(인증된 요청만 센다) | **약 3.3만 건** |
| 대가 | **기존 세션이 전부 끊긴다**(재로그인) · 전용 시크릿 1개 추가 · 세션 구조 변경 | 없음 |
| 지금의 실제 대가 | **계정이 0개라 끊길 세션이 없다** | — |
| 승인 근거 | 인증·세션 구조 변경이라 `CLAUDE.md` §4 의 사용자 결정 대상 | — |

⚠️ **이것은 분산 공격을 「막는」 것이 아니다.** 인증 없는 요청의 **단가를 0 으로** 만드는 것이고,
유효한 세션을 가진 분산 요청은 그대로 남는다(계정을 실제로 만들어야 한다).

### 13-4. 지금 상태

**지금 상태는 D 이고, 그것이 「공개 출시 No-Go」의 기술적 내용이다.**
`wrangler.jsonc` 에 `EDGE_GUARD` 가 없다 — 그 사실이 계정 라우트를 닫아 두는 유일한 장치다. A~C 중 하나가 실제로 붙고
`/api/ready` 의 `abuseReady` 가 `true` 가 되기 전에는 계정 기능을 열 수 없다.

## 14. 알고 감수하는 비용

- **통과한 요청 하나 = ledger 쓰기 둘**(임차증 INSERT + DELETE). 결정 A′ 의 대가다.
  없는 주소·로그인 시작은 0 이고(라우트 분류가 앞이다), **429 로 막힌 요청도 0 이다**
  — 2026-08-19 에 리미터를 임차증 **앞**으로 옮겼다(위협 47).
  ⛔ **그전에는 「차단된 요청도 임차증을 든다 · 요청당 둘이 상한이다」라고 적혀 있었다.
  요청 수가 무제한이면 요청당 상수는 상한이 아니다.**
- 지금 상한은 **IP·분당**이다: 주 D1 은 버킷 한도+1 회, ledger 는 통과한 요청당 둘.
  가장 넉넉한 버킷이 120 이므로 한 IP 가 한 라우트에서 낼 수 있는 쓰기는 분당 수백 수준이다.
  D1 무료 한도(하루 10만 쓰기)를 이 값으로 나눠 보고, 트래픽이 그 근처에 가거나
  **여러 IP 로 나눠 오는 요청**이 보이면 **WAF 를 먼저 붙인다**(엣지에서 끊는 것이 언제나 더 좋은 답이다).
- **인증이 필요한 읽기도 이제 D1 쓰기 하나를 낸다**(`read` 버킷). 무한한 쪽을 유한하게 바꾼
  대가이고, 정상 사용에서는 앱을 한 번 열 때 서너 건이다.
- `LEASE_TTL` 120초는 실측이 아니라 여유값이다. 실제 p95 를 재서 좁힌다(설계서 §10-9-5 Q6).
- 정리 크론의 `LIMIT 200` 도 실측값이 아니다. `cleanup_runs.last_counts` 가 매번 200 에
  붙어 있으면 밀리고 있다는 뜻이므로 올린다.
