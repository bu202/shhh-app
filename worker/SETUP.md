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

## ⬜ 카카오

<https://developers.kakao.com/console/app> → **애플리케이션 추가하기**

| 자리 | 넣을 값 |
|---|---|
| 앱 이름 | `shhh!` |
| 회사명 | 개인이면 본인 이름 |
| 카테고리 | 교육 |

만든 뒤 순서대로:

1. **앱 설정 > 플랫폼 > Web > 사이트 도메인 등록**
   ```
   https://shhh-api.bu202.workers.dev
   ```
   ⚠️ 이걸 먼저 등록해야 Redirect URI 칸이 열린다.
2. **제품 설정 > 카카오 로그인 > 활성화 상태 `ON`**
3. **제품 설정 > 카카오 로그인 > Redirect URI**
   ```
   https://shhh-api.bu202.workers.dev/cb/kakao
   ```
4. **동의항목 — 아무것도 켜지 않는다.** 회원번호만 받으므로 필요 없고,
   이메일을 켜면 비즈앱 전환 심사가 붙는다.
5. **보안 > Client Secret — 사용 안 함**(기본값)으로 둔다. 켰다면 코드를 복사해 아래 2번 명령에 쓴다.
6. **앱 키 > REST API 키**를 복사한다. ← 이게 `KAKAO_ID` 다 (JavaScript 키가 아니다)

```bash
cd worker
printf '<REST API 키>' | npx wrangler secret put KAKAO_ID
# Client Secret 을 켰을 때만:
printf '<Client Secret>' | npx wrangler secret put KAKAO_SECRET
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
