---
paths:
  - "index.html"
  - "privacy.html"
  - "css/**/*"
  - "js/**/*"
  - "service-worker.js"
  - "manifest.webmanifest"
  - "_headers"
  - "scripts/build.mjs"
  - "scripts/test-sw.mjs"
  - "scripts/test-dist.mjs"
---

# 프론트엔드·PWA 규칙

- 화면 렌더링과 API 호출을 분리한다. `fetch()`는 API 클라이언트 경계 밖에 새로 만들지 않는다.
- 인증·API·OAuth 왕복 주소·실패 응답·개인별 데이터는 Service Worker와 CDN 캐시에 저장하지 않는다.
- 새 정적 파일은 `scripts/build.mjs`의 allowlist를 거쳐야만 배포한다. 저장소 전체를 배포하지 않는다.
- CSP, Referrer-Policy, 외부 수형 이미지, Service Worker가 함께 작동하는지 실제 브라우저에서 확인한다.
- 새 `input`과 `textarea`는 iOS 자동 확대와 접근성을 함께 확인한다. 확대 금지를 해결책으로 사용하지 않는다.
- `hidden`, SVG, CSS custom property, 오프라인 첫 방문은 브라우저 실측 대상이다. DOM 값만 보고 완료하지 않는다.
- 화면 문구를 고치면 같은 값을 설명하는 다른 화면과 `privacy.html`도 검색한다.
- 앱의 핵심 사전은 오프라인에서도 열려야 하지만, 첫 로드 비용을 무조건 선캐시로 해결하지 않는다. 자산 크기와 실제 사용 흐름을 측정한다.
- 설치된 PWA의 OAuth 복귀는 시뮬레이터만으로 완료 판정하지 않는다. 계정 기능을 열기 전에 Android와 iPhone 실기기에서 확인한다.
