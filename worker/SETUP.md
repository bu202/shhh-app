# 로그인 설정 — 개발자 콘솔에 등록할 값

앱 주소: `https://bu202.github.io/shhh-app/` · API: `https://shhh-api.bu202.workers.dev`

**받는 개인정보는 회원 고유 번호뿐이다.** 이름·이메일·프로필 사진은 요청하지 않는다 —
그래서 카카오 비즈앱 전환도, 구글 민감범위 심사도 필요 없다. 동의항목을 늘리려면
`privacy.html` 을 **먼저** 고칠 것.

---

## ✅ 구글 (완료, 2026-08-07)

Google Cloud Console → 인증 플랫폼. 앱 이름 `shhh!`, 대상 **외부**, 게시 상태 **프로덕션**.
OAuth 클라이언트 `shhh! Worker` (웹 애플리케이션), 승인된 리디렉션 URI:

```
https://shhh-api.bu202.workers.dev/cb/google
```

`openid` 범위만 쓰므로 앱 인증(verification) 없이 누구나 로그인된다.
JavaScript 원본은 비워 뒀다 — 브라우저가 구글 API 를 직접 부르지 않는다.

---

## ✅ 카카오 (완료, 2026-08-07 · 앱 ID 1536945)

<https://developers.kakao.com/console/app> → **앱 생성**. 이름·회사명 `shhh!`, 카테고리 교육,
대표 도메인 `https://bu202.github.io`.

⚠️ **저장이 계속 실패하면 모달을 끝까지 스크롤할 것.** 맨 아래 「운영정책을 위반하지 않는 앱입니다」
체크박스가 필수인데, 오류 메시지는 "필수 항목을 입력하지 않았거나 값이 올바르지 않습니다"뿐이라
위쪽 입력칸을 의심하게 만든다(앱 이름의 `!` 를 범인으로 의심했지만 **`!` 는 허용된다**).

1. **제품 설정 > 카카오 로그인 > 사용 설정 `ON`**
   활성화 대화상자가 *"회원식별 값 이외의 추가 정보가 필요한 경우 동의항목을 설정"* 이라고 말한다 —
   우리는 회원식별 값만 쓰므로 **동의항목은 하나도 켜지 않는다.**
2. **Redirect URI 는 「카카오 로그인」 메뉴에 없다.**
   앱 설정 > **플랫폼 키 > REST API 키 카드의 ⋮ > 수정** > 「카카오 로그인 리다이렉트 URI」:
   ```
   https://shhh-api.bu202.workers.dev/cb/kakao
   ```
   입력 후 **＋** 로 목록에 넣고, 페이지 오른쪽 끝의 **저장**을 누른다(창이 좁으면 버튼이 화면 밖이다).
3. **같은 페이지에 「클라이언트 시크릿」이 있고 기본이 `ON` 이다.**
   콘솔 안내: *"보안 강화를 위해 REST API 키 발급 시 기본 활성화"*. 그래서 `KAKAO_SECRET` 이 **필요하다**.
4. `KAKAO_ID` 는 **REST API 키**다 (JavaScript 키·네이티브 앱 키가 아니다).

```bash
cd worker
printf '<REST API 키>'      | npx wrangler secret put KAKAO_ID
printf '<클라이언트 시크릿>' | npx wrangler secret put KAKAO_SECRET
```

---

## ⬜ 네이버

<https://developers.naver.com/apps/#/register> (Chrome 확장의 안전 설정에서 이 도메인 허용 필요)

| 자리 | 넣을 값 |
|---|---|
| 애플리케이션 이름 | `shhh!` |
| 사용 API | **네이버 로그인** |
| 제공 정보 선택 | **전부 체크 해제** (필수 항목이 강제되면 그것만) |
| 환경 추가 | **PC웹** |
| 서비스 URL | `https://bu202.github.io` |
| Callback URL | `https://shhh-api.bu202.workers.dev/cb/naver` |

```bash
cd worker
printf '<Client ID>'     | npx wrangler secret put NAVER_ID
printf '<Client Secret>' | npx wrangler secret put NAVER_SECRET
```

⚠️ **네이버는 검수를 통과하기 전까지 등록한 테스트 계정(본인)만 로그인된다.**
전체 공개하려면 애플리케이션 > **검수 요청**. 서비스 URL 과 개인정보처리방침
(`https://bu202.github.io/shhh-app/privacy.html`)이 살아 있어야 통과한다.

---

## 확인

```bash
cd worker && npx wrangler secret list        # 넣은 키 목록(값은 안 보인다)
curl -sI "https://shhh-api.bu202.workers.dev/login/kakao?return=https://bu202.github.io/shhh-app/" | head -1
#   302 → 설정됨 · 503 → 키가 아직 없음
```

키를 넣으면 재배포는 필요 없다 — secret 은 즉시 반영된다.
