// 조작된 주소 해시가 앱 초기화를 멈추지 못한다. `node scripts/test-hash.mjs`
//
// 왜 생겼나: `#q=%E0%A4%A` 처럼 반쪽 인코딩된 링크를 열면 decodeURIComponent 가 URIError 를 던졌다.
// 그게 main() 안에서 나면 **그 뒤가 통째로 안 돈다** — 로그인·친구 초기화(appReadyFns)가
// 뒤에 붙어 있어서, 링크 하나로 앱을 반쯤 죽일 수 있었다. 증상은 "왜 로그인 버튼이 안 먹지"라
// 원인까지 가는 길이 멀다.
import assert from "node:assert";
import { loadApp } from "./_app.mjs";

const M = loadApp("safeDecode, MAX_HASH");

// 1. 정상 입력은 그대로 푼다.
assert.equal(M.safeDecode("%EB%B3%B4%EA%B3%A0%EC%8B%B6%EC%96%B4"), "보고싶어");
assert.equal(M.safeDecode("사랑"), "사랑");
assert.equal(M.safeDecode(""), "");

// 2. 던지는 입력이 **던지지 않고 빈 값**이 된다. 이게 이 파일의 전부다.
for (const bad of ["%E0%A4%A", "%", "%zz", "%FF%FE", "abc%", "%C0%80%", "%u0041"])
  assert.doesNotThrow(() => assert.equal(M.safeDecode(bad), "", `'${bad}' 가 빈 값이 아니다`),
    `'${bad}' 에서 던졌다 — 링크 하나로 앱 초기화가 멈춘다`);

// 3. 문자열이 아닌 것도 안전하다(정규식이 못 잡으면 undefined 가 온다).
for (const junk of [undefined, null, 0, {}, []])
  assert.equal(M.safeDecode(junk), "", `${JSON.stringify(junk)} 가 빈 값이 아니다`);

// 4. 터무니없이 긴 해시는 풀기 전에 버린다. 해시는 아무나 만들어 보내는 값이라
//    메가바이트짜리도 오고, 그걸 그대로 디코드하면 그 자리에서 탭이 멈춘다.
assert.equal(M.safeDecode("a".repeat(M.MAX_HASH + 1)), "", "길이 한도가 안 걸린다");
assert.equal(M.safeDecode("a".repeat(M.MAX_HASH)), "a".repeat(M.MAX_HASH), "한도 안쪽인데 버렸다");

// 5. 앱이 실제로 쓰는 추출 경로 그대로. 여러 파라미터가 섞여도, 순서가 바뀌어도 안 죽는다.
const pick = (hash, key) => M.safeDecode((hash.match(new RegExp(`[#&]${key}=([^&]*)`)) || [])[1] || "");
assert.equal(pick("#q=%EC%82%AC%EB%9E%91&w=abc", "q"), "사랑");
assert.equal(pick("#w=abc&q=%EC%82%AC%EB%9E%91", "q"), "사랑");
assert.equal(pick("#login=x&n=%E0%A4%A", "n"), "", "로그인 nonce 의 반쪽 인코딩이 안 걸러진다");
assert.equal(pick("#q=%E0%A4%A&q=%EC%82%AC%EB%9E%91", "q"), "", "첫 값이 깨졌는데 던졌다");
assert.equal(pick("#nope=1", "q"), "");

console.log("test-hash: 통과 — 조작된 해시가 앱 초기화를 멈추지 못한다");
