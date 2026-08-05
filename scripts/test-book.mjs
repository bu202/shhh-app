// 단어장 링크 인코딩 검증. `node scripts/test-book.mjs`
// 한글은 UTF-8 3바이트라 btoa에 그냥 넣으면 깨진다 — 왕복이 되는지가 핵심.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const src = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const block = src.match(/function encodeBook[\s\S]*?\n}\nfunction decodeBook[\s\S]*?\n}/)[0];
const { encodeBook, decodeBook } = new Function(block + "; return { encodeBook, decodeBook };")();

const round = (ws) => decodeBook(encodeBook(ws));

assert.deepEqual(round(["사랑"]), ["사랑"]);
assert.deepEqual(round(["그리워하다", "만나다", "괜찮다", "미안", "보다"]), ["그리워하다", "만나다", "괜찮다", "미안", "보다"]);
assert.deepEqual(round(["(맛이)짜다", "튀르키예공화국(약칭 튀르키예)"]), ["(맛이)짜다", "튀르키예공화국(약칭 튀르키예)"], "괄호·공백 있는 표제어");
assert.deepEqual(round([]), [], "빈 단어장");

// URL 조각에 그대로 넣을 수 있어야 한다 — +, /, = 가 남으면 안 된다.
const enc = encodeBook(["그리워하다", "사랑", "만나다", "괜찮다", "미안"]);
assert.ok(/^[A-Za-z0-9_-]+$/.test(enc), `base64url 이 아님: ${enc}`);
assert.equal(encodeURIComponent(enc), enc, "URL 인코딩이 필요하면 안 된다");
assert.ok(enc.length < 200, `링크가 너무 김: ${enc.length}자`);

// 깨진 입력에 예외를 던져야 mergeFromHash가 catch로 잡는다.
assert.throws(() => decodeBook("!!!not base64!!!"));

console.log(`ok — 5단어 링크 ${enc.length}자, 왕복 일치`);
