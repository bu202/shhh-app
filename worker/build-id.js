// **생성 파일이다. 손으로 고치지 않는다.**
//
// 값의 원본은 `scripts/build.mjs` 의 `swCacheName()` — 서비스워커가 선캐시하는 자산 전체의
// 내용 해시다. 그 값 하나가 세 곳으로 간다:
//   ① `dist/service-worker.js` 의 캐시 이름
//   ② `dist/js/build.js` 의 `window.SHH_BUILD` (화면이 자기 세대를 아는 유일한 근거)
//   ③ 이 파일 (`/api/health` 가 서버 세대로 답한다)
// 셋이 **같은 계산에서 나오므로** 사람이 같은 값을 두 곳에 옮겨 적을 일이 없다.
// `scripts/test-dist.mjs` 가 빌드 결과와 이 파일을 대조한다 — 낡으면 테스트가 실패한다.
//
// ⚠️ 저장소에 커밋한다(`worker/policies.js` 와 같은 규칙). Pages 는 `functions/` 를 번들할 때
//    이 파일을 그대로 읽으므로, 없으면 배포가 아니라 **import 에서** 죽는다.
export const BUILD_ID = "v11-05dd4eb05be8";   // 빌드가 박는다: scripts/build.mjs stampBuildId()
