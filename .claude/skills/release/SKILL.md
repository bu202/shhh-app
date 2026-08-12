---
name: release
description: shhh!의 Cloudflare Pages preview/production 배포, OAuth 시크릿, 원격 D1 migration, 배포 검증, 롤백을 다룰 때 반드시 사용하는 안전한 출시 절차. 사용자가 배포·공개·출시·시크릿 활성화·원격 DB 작업을 요청하면 적용한다.
---

# shhh! 안전한 출시 절차

배포는 외부 상태를 바꾸므로 분석과 로컬 검증을 먼저 끝내고 사용자의 명시적 승인을 받는다.

## 1. 범위 확인

1. 루트 `CLAUDE.md`, `docs/SECURITY_RELEASE_CHECKLIST.md`, `package.json`, `wrangler.jsonc`를 읽는다.
2. `git status --short`와 현재 branch/commit을 확인한다.
3. preview인지 production인지, 코드만인지 시크릿·DB 변경도 포함하는지 구분한다.
4. 범위가 불분명하면 외부 변경을 시작하지 않는다.

## 2. 출시 차단 조건

- 루트의 P0가 열려 있으면 OAuth 시크릿을 활성화하거나 계정 베타를 시작하지 않는다.
- production에 modified tracked file을 배포하지 않는다. untracked 파일은 목록을 보고 build allowlist에 포함되지 않는지 확인한다.
- `--commit-dirty=true`를 사용하지 않는다.
- 원격 D1 스키마 변경은 버전형 migration, 백업, 복원안, 사용자 승인이 없으면 실행하지 않는다.
- 비밀값을 인자·로그·문서에 출력하지 않는다. 대화형 secret 입력 또는 승인된 보안 경로만 쓴다.

## 3. 로컬 preflight

```bash
npm test
npm audit
npm run build
git diff --check
git status --short
```

- `dist/`에 내부 문서, 소스, 설정, 테스트가 없는지 `test-dist` 결과와 실제 목록을 확인한다.
- 실패를 무시하거나 문서의 과거 통과 기록으로 대체하지 않는다.
- 보안 변경이면 관련 공격 회귀 테스트가 실제로 실패 전/통과 후를 구분하는지 확인한다.

## 4. 변경 계획과 승인

사용자에게 다음을 간단히 제시한다.

- 배포 대상 commit과 환경
- 변경되는 Cloudflare 자원·시크릿·DB
- 자동/수동 검증 항목
- 실패 시 롤백 대상
- 남아 있는 위험과 허용할 공개 범위

그 다음 외부 변경 실행 승인을 받는다. preview 승인과 production 승인을 하나로 추정하지 않는다.

## 5. 배포 후 검증

- deployment 목록에서 Production/Preview 환경과 commit을 확인한다.
- `/api/health`와 `/api/ready`를 각각 확인한다. health 200만으로 준비 완료라고 판정하지 않는다.
- 정적 내부 경로는 상태코드뿐 아니라 Content-Type과 본문을 확인한다. SPA fallback의 200을 파일 노출로 오인하지 않는다.
- cache-busting URL과 canonical URL을 모두 확인한다. canonical에서 과거 내부 파일이 남으면 공개 범위를 넓히지 않는다.
- OAuth 제공자를 활성화했다면 각 제공자의 시작·취소·성공·잘못된 state/nonce를 확인한다.
- 배포 직후 전파 지연을 고려해 이상 결과는 간격을 두고 다시 측정하되, 반복 측정으로 실패를 덮지 않는다.
- PWA 실기기, 계정 전환, 동기화, 로그아웃을 변경 범위에 맞게 smoke test한다.

## 6. 실패와 롤백

- 새 배포에 오류가 있으면 추가 수정을 연속 배포하기 전에 직전 검증된 deployment로 롤백한다.
- DB migration처럼 코드 롤백만으로 복구되지 않는 변경은 실행 전에 복원 절차를 실제로 검증한다.
- 무엇이 실패했고 어떤 측정이 그것을 증명했는지 기록한다. “다시 하니 됐다”로 원인을 확정하지 않는다.

## 완료 보고

배포 환경, commit, 테스트, smoke test, readiness, 남은 위험, 롤백 가능 상태를 보고한다. 시크릿 값과 개인 식별자는 보고하지 않는다.
