# 로그인 설정 — 개발자 콘솔에 등록할 값

앱 주소: `https://shhh-app.pages.dev/` · API: **같은 주소의 `/api/`** (Cloudflare Pages Functions)

> ⚠️ **2026-08-11 에 주소가 바뀌었다.** 예전엔 앱이 `bu202.github.io`, API 가
> `shhh-api.bu202.workers.dev` 로 **origin 이 둘**이었다. 지금은 하나다.
> 아래 표의 값이 콘솔에 그대로 들어가 있어야 하고, **옛 `workers.dev` 리디렉션 URI 는
> 목록에서 지워야 한다** — 남겨 두면 옛 주소로도 로그인이 되고, 그 경로에는 오늘 넣은
> 세션 고정 방어(nonce)가 없다. 문이 둘이면 잠금은 약한 쪽을 따른다.

**받는 개인정보는 회원 고유 번호뿐이다.** 이름·이메일·프로필 사진은 요청하지 않는다 —
그래서 카카오 비즈앱 전환도, 구글 민감범위 심사도 필요 없다. 동의항목을 늘리려면
`privacy.html` 을 **먼저** 고칠 것.

## 비밀값 — Pages 프로젝트에 넣는다

> ⚠️ **개수를 여기 적지 않는다.** 예전에 「8개」라고 적어 두었고, 그 뒤 `RL_KEY` 가 필수가 됐을
> 때도, 가입·삭제 키 셋이 필수가 됐을 때도 이 줄은 8개인 채로 남아 있었다 — 이 목록만 보고
> 배포하면 그대로 빠진다. 지금은 `scripts/test-config.mjs` 가 **코드에서 `env.*` 를 읽어**
> 이 문서·README·`wrangler.jsonc`·`docs/OPS_RUNBOOK.md` 와 대조한다.

```bash
# 레포 루트에서. `cd worker` 가 아니다 — 배포 단위가 Pages 프로젝트(shhh-app)로 바뀌었다.
# ⚠️ 값을 명령줄에 두지 않는다(히스토리·프로세스 목록에 남는다). 표준입력으로 넣는다.
npx wrangler pages secret put KAKAO_ID --project-name shhh-app
#  KAKAO_ID · KAKAO_SECRET · NAVER_ID · NAVER_SECRET · GOOGLE_ID · GOOGLE_SECRET
#  STATE_KEY        — 로그인 state **서명** 키. `openssl rand -base64 32`.
#                     바꾸면 진행 중이던 로그인만 실패한다(세션은 안 끊긴다).
#  RL_KEY           — 레이트리밋 버킷 HMAC. 없으면 **세지 않고** /api/ready 가 503.
#  SIGNUP_STATE_KEY — 가입 state **암호화**(AES-256-GCM). base64 로 디코딩해 **정확히 32바이트**.
#                     아니면 가입이 fail-closed 다(짧은 키를 조용히 늘려 쓰지 않는다).
#  TOMBSTONE_KEY    — 가입 state 1회 소비 표식 HMAC. 없으면 가입 503.
#  DELETION_KEY     — 삭제 표식 HMAC. 없으면 계정 삭제 503.
#  READY_KEY        — /api/ready 진단용 운영자 키(`X-Ready-Key` 헤더). 없으면 진단을 아무도
#                     못 본다 — 키 없는 호출은 두 DB 를 만지지 않고 503 이다(위협 56).
#  MASTER_UIDS      — 무료 벽이 없는 계정. 쉼표 구분. 비우면 아무도 마스터가 아니다.
#  DEV_ORIGINS      — **개발 Worker 에만.** localhost·LAN 주소를 허용한다. 운영에 넣지 않는다.
#  DEV_RATE_LIMIT   — **로컬 전용.** 없으면 계정 라우트가 DB 를 만지기 전에 503 이다(위협 50).
#                     `.dev.vars` 나 테스트 env 에만 둔다. ⛔ wrangler.jsonc 에 넣지 않는다 —
#                     넣으면 남용 방어 없이 계정 기능이 열린 채 배포된다. 이 값으로는
#                     `/api/ready` 가 절대 200 이 아니다(EDGE_GUARD 선언이라야 ready 다).
#  EDGE_GUARD       — **시크릿이 아니라 wrangler.jsonc 의 vars** 다. `waf` 또는 `ratelimit`.
#                     없거나 모르는 값이면 계정 라우트가 DB 를 만지기 전에 503 이다.
#                     모드별 절차는 docs/OPS_RUNBOOK.md §13-2.
npx wrangler pages secret list --project-name shhh-app     # 목록(값은 안 보인다)
```

**서로 겸용하지 않는다.** 다섯 개의 키(`STATE_KEY`·`SIGNUP_STATE_KEY`·`TOMBSTONE_KEY`·
`DELETION_KEY`·`RL_KEY`)는 용도가 다르다 — 겸용하면 하나를 교체할 때 다른 하나가 같이 무너진다.

## 바인딩 — `wrangler.jsonc` 에 적는다

| 바인딩 | D1 | 없으면 |
|---|---|---|
| `DB` | `shhh-db` | 전부 안 된다 |
| **`LEDGER`** | `shhh-ledger` | **사용자 데이터 API 가 전부 503**(fail-closed) |

⚠️ Pages 프로젝트에 Wrangler 설정 파일이 있으면 **그 파일이 원본**이고 대시보드에서 같은 항목을
편집할 수 없다(공식 문서). 그러므로 `LEDGER` 도 `wrangler.jsonc` 에 적는다.
ledger D1 은 **아직 만들지 않았다** — 절차는 [`../docs/OPS_RUNBOOK.md`](../docs/OPS_RUNBOOK.md).

---

## ✅ 구글

Google Cloud Console → 인증 플랫폼. 앱 이름 `shhh!`, 대상 **외부**, 게시 상태 **프로덕션**.
OAuth 클라이언트(웹 애플리케이션), 승인된 리디렉션 URI:

```
https://shhh-app.pages.dev/api/cb/google
```

`openid` 범위만 쓰므로 앱 인증(verification) 없이 누구나 로그인된다.
JavaScript 원본은 비워 둔다 — 브라우저가 구글 API 를 직접 부르지 않는다.

---

## ✅ 카카오 (앱 ID 1536945)

<https://developers.kakao.com/console/app>. 이름·회사명 `shhh!`, 카테고리 교육,
대표 도메인 `https://shhh-app.pages.dev`.

⚠️ **저장이 계속 실패하면 모달을 끝까지 스크롤할 것.** 맨 아래 「운영정책을 위반하지 않는 앱입니다」
체크박스가 필수인데, 오류 메시지는 "필수 항목을 입력하지 않았거나 값이 올바르지 않습니다"뿐이라
위쪽 입력칸을 의심하게 만든다(앱 이름의 `!` 를 범인으로 의심했지만 **`!` 는 허용된다**).

1. **제품 설정 > 카카오 로그인 > 사용 설정 `ON`**
   활성화 대화상자가 *"회원식별 값 이외의 추가 정보가 필요한 경우 동의항목을 설정"* 이라고 말한다 —
   우리는 회원식별 값만 쓰므로 **동의항목은 하나도 켜지 않는다.**
2. **Redirect URI 는 「카카오 로그인」 메뉴에 없다.**
   앱 설정 > **플랫폼 키 > REST API 키 카드의 ⋮ > 수정** > 「카카오 로그인 리다이렉트 URI」:
   ```
   https://shhh-app.pages.dev/api/cb/kakao
   ```
   입력 후 **＋** 로 목록에 넣고, 페이지 오른쪽 끝의 **저장**을 누른다(창이 좁으면 버튼이 화면 밖이다).
   **옛 `shhh-api.bu202.workers.dev/cb/kakao` 는 같은 화면에서 지운다.**
3. **같은 페이지에 「클라이언트 시크릿」이 있고 기본이 `ON` 이다.** 그래서 `KAKAO_SECRET` 이 **필요하다**.
4. `KAKAO_ID` 는 **REST API 키**다 (JavaScript 키·네이티브 앱 키가 아니다).

---

## ⬜ 네이버 — 콜백이 **앱 주소**로 간다 (다른 둘과 다르다)

<https://developers.naver.com/apps/#/register>

| 자리 | 넣을 값 |
|---|---|
| 애플리케이션 이름 | `shhh!` |
| 사용 API | **네이버 로그인** |
| 제공 정보 선택 | **전부 체크 해제** (필수가 강제되면 그것만) |
| 환경 추가 | **PC웹** |
| 서비스 URL | `https://shhh-app.pages.dev` |
| **Callback URL** | `https://shhh-app.pages.dev/` |

⚠️ **왜 네이버만 다른가.** 네이버는 서비스 URL 을 **하나만** 받으면서 콜백이 그 도메인 안에 있기를
요구한다. 아니면 이 화면이 뜬다:

> shhh에 로그인할 수 없습니다.
> 개발자센터에 등록되지 않은 사이트에서 로그인을 시도했습니다.

전에는 앱과 API 의 도메인이 달라서 이게 함정이었다(함정 41). **Pages 로 옮기며 저절로 풀렸다** —
이제 셋 다 같은 도메인이다. 다만 네이버 갈래는 앱이 `code` 를 받아 `/api/exchange/naver` 로
넘기는 구조를 그대로 둔다(비밀키가 필요한 교환은 여전히 서버에서 한다).

⚠️ **네이버는 검수를 통과하기 전까지 등록한 테스트 계정(본인)만 로그인된다.**
전체 공개하려면 애플리케이션 > **검수 요청**. 서비스 URL 과 개인정보처리방침
(`https://shhh-app.pages.dev/privacy.html`)이 살아 있어야 통과한다.
**주소가 바뀌었으므로 검수에 낸 값도 같이 고쳐야 한다.**

## 확인

```bash
curl -sI "https://shhh-app.pages.dev/api/login/kakao?return=https://shhh-app.pages.dev/" | head -1
#   302 → 설정됨 · 503 → 키가 아직 없음
```

키를 넣으면 재배포는 필요 없다 — secret 은 즉시 반영된다.
단, **배포 직후 몇 초는 옛 코드가 응답한다**(함정 48). 이상하면 한 번 더 재고 나서 원인을 말할 것.
