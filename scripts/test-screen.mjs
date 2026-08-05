// 유튜브 검색 결과 파서 검증. `node scripts/test-screen.mjs`
// (모델 호출은 검증하지 않는다 — 선별 품질은 사람이 결과를 보고 판단하는 것이라 단정할 수 없다.)
import assert from "node:assert";
import { parseSearch } from "./screen.mjs";

// ytInitialData가 없으면 빈 배열 — 유튜브가 페이지 구조를 바꾸면 여기서 잡힌다.
assert.deepEqual(parseSearch("<html>no data</html>"), []);

const fake = `<script>var ytInitialData = {"c":{"items":[
  {"videoRenderer":{"videoId":"X1","title":{"runs":[{"text":"'만나다' "},{"text":"수어"}]},
   "ownerText":{"runs":[{"text":"어느채널"}]},"lengthText":{"simpleText":"0:07"},
   "viewCountText":{"simpleText":"조회수 86회"}}},
  {"videoRenderer":{"videoId":"X1"}},
  {"videoRenderer":{"videoId":"X2","title":{"runs":[{"text":"딴거"}]},
   "longBylineText":{"runs":[{"text":"백업채널"}]}}}
]}};</script>`;

const r = parseSearch(fake);
assert.equal(r.length, 2, "같은 videoId는 한 번만");
assert.equal(r[0].id, "X1");
assert.equal(r[0].title, "'만나다' 수어", "title.runs 는 이어붙인다");
assert.equal(r[0].channel, "어느채널");
assert.equal(r[0].length, "0:07");
assert.equal(r[0].views, "조회수 86회");
assert.equal(r[1].channel, "백업채널", "ownerText 없으면 longBylineText");
assert.equal(r[1].views, "", "없는 필드는 빈 문자열");

console.log("ok — parseSearch");
