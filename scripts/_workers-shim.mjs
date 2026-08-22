// Workers 런타임 API 를 **Node 테스트에서만** 채우는 어댑터. `scripts/` 안에만 있고
// `dist/` 에도 `functions/` 에도 `worker/` 에도 들어가지 않는다(`scripts/test-dist.mjs` 가 잰다).
//
// 왜 필요한가: 운영 코드(`worker/index.js` 의 `sameSecret`)는 Cloudflare 공식 권고대로
// `crypto.subtle.timingSafeEqual()` 하나만 부른다. Node 의 `crypto.subtle` 에는 그 메서드가
// 없는데, **그건 테스트 환경의 결핍이지 운영 구현을 약하게 만들 이유가 아니다.**
// 그래서 약한 쪽을 운영에 두는 대신 **테스트 쪽에 같은 보장을 가진 구현을 끼운다** —
// Node 의 `crypto.timingSafeEqual` 은 같은 성질(고정 시간 · 길이 불일치는 예외)을 가진
// 표준 API 다.
//
// ⚠️ **없을 때만 채운다.** workerd 에서 이 파일이 실행될 일은 없지만, 혹시 그런 일이
//    생겨도 런타임 구현을 덮어쓰지 않는다.
// ⚠️ **이 파일을 `worker/` 에서 import 하지 않는다.** 하는 순간 운영 번들에 들어가고,
//    그러면 「테스트에서만」이라는 전제가 깨진다.
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

const view = (b) => (ArrayBuffer.isView(b)
  ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  : new Uint8Array(b));

if (typeof crypto.subtle.timingSafeEqual !== "function") {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true, writable: true,
    value(a, b) {
      const x = view(a), y = view(b);
      // workerd 와 같은 실패 모양: 길이가 다르면 **던진다**(반환값 false 가 아니다).
      // 여기서 조용히 false 를 주면 운영에서 예외가 될 코드가 테스트만 통과한다.
      if (x.byteLength !== y.byteLength)
        throw new TypeError("Input buffers must have the same byte length.");
      return nodeTimingSafeEqual(x, y);
    },
  });
}

export const WORKERS_SHIM_INSTALLED = true;
