// 빌드타임 수집: 표준국어대사전 오픈 API → data/ksl-meanings.json
//
// 왜: 앱이 보여주던 건 **수형설명**(손을 어떻게 움직이나)뿐이라, 사용자가 친 말이 자기가 뜻한
// 그 말인지 확인할 방법이 없었다. '소령'을 찾으면 손 모양만 뜨고 그게 군 계급인지 알 수 없다.
//
// ⚠️ 여기서 받는 뜻은 **한국어 낱말의 뜻**이지 그 수형의 뜻이 아니다. 같은 낱말에 수형이 여럿인
//    자리(보다=[시각]/[조사])에서 어느 뜻이 어느 수형인지는 이 API 가 알려주지 않는다. 그래서
//    화면도 "국어사전에서 이 말은" 이라고 출처를 밝혀 말한다 — 수형의 뜻이라고 단정하면 ⛔ 위반이다.
//
// 실행:  node scripts/fetch-meanings.mjs <인증키>          전체(약 12,900개, 오래 걸림)
//        node scripts/fetch-meanings.mjs <인증키> 200      앞에서 200개만(맛보기)
// 자가검증: node scripts/fetch-meanings.mjs --mock         키·네트워크 없이 매핑만
//
// 인증키: https://stdict.korean.go.kr/openapi/openApiRegister.do (무료, 16진수 32자리)
// 이어받기: 이미 data/ksl-meanings.json 에 있는 낱말은 건너뛴다. 중간에 끊겨도 다시 돌리면 된다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://stdict.korean.go.kr/api/search.do";
// 화면 한두 줄에 들어갈 만큼만. 국어사전 뜻풀이는 길면 300자를 넘는데, 손모양 설명까지 같이
// 있는 카드에서 그만큼 읽게 하면 정작 손모양을 안 보게 된다.
const MAX_LEN = 90;

// 뜻풀이에 섞여 오는 사전 표기를 걷어낸다. `<FL>...</FL>`(원어), `^`(붙임표) 등.
export function cleanDefinition(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\^/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- API 교체 이음새 ---
// 응답 → 뜻풀이 문자열 하나. 낱말 하나에 뜻이 여럿이면 **첫 뜻만** 쓴다.
// 여럿을 다 실으면 파일이 몇 배로 커지는데, 화면은 한두 줄만 보여준다 — 안 쓸 것을 내려받지 않는다.
// ⚠️ 그래서 이 값은 "가장 흔한 뜻"이지 "이 수형의 뜻"이 아니다. 위 주석 참고.
export function pickDefinition(json, word) {
  const items = json?.channel?.item;
  const list = Array.isArray(items) ? items : items ? [items] : [];
  // 표제어가 정확히 같은 것만 쓴다. 검색은 '보다'에 '보다못해'까지 물어 오는데,
  // 그걸 그대로 쓰면 엉뚱한 낱말의 뜻이 그 단어의 뜻인 척 붙는다.
  const hit = list.find((it) => cleanDefinition(it.word) === word);
  if (!hit) return "";
  const sense = Array.isArray(hit.sense) ? hit.sense[0] : hit.sense;
  const def = cleanDefinition(sense?.definition);
  return def.length > MAX_LEN ? def.slice(0, MAX_LEN - 1) + "…" : def;
}

function runMock() {
  const a = (c, msg) => { if (!c) { console.error("FAIL:", msg); process.exit(1); } };

  a(cleanDefinition("사람의 <FL>身體</FL>^부분") === "사람의 身體 부분", "태그·붙임표 제거");

  const fixture = {
    channel: {
      item: [
        { word: "보다못해", sense: { definition: "딴 것" } },
        { word: "보다", sense: [{ definition: "눈으로 대상의 존재나 형태적 특징을 알다." }, { definition: "두 번째 뜻" }] },
      ],
    },
  };
  a(pickDefinition(fixture, "보다").startsWith("눈으로 대상의"), "표제어 정확일치 + 첫 뜻");
  a(pickDefinition(fixture, "없는말") === "", "못 찾으면 빈 문자열");

  // 한 건만 오면 배열이 아니라 객체로 온다 — 이 형태를 놓치면 전부 빈칸이 된다.
  a(pickDefinition({ channel: { item: { word: "물", sense: { definition: "무색투명한 액체." } } } }, "물") === "무색투명한 액체.", "단건 응답");

  const long = { channel: { item: { word: "가", sense: { definition: "가".repeat(300) } } } };
  const got = pickDefinition(long, "가");
  a(got.length === MAX_LEN && got.endsWith("…"), `길이 제한 ${MAX_LEN} (실제 ${got.length})`);

  console.log("mock OK");
}

// 앱이 실제로 보여주는 표제어 전부(이미지 사전 + 전체 텍스트 사전).
function headwords() {
  const out = new Set();
  for (const f of ["data/ksl-dict.json", "data/ksl-fulldict.json"]) {
    if (!existsSync(f)) continue;
    for (const e of JSON.parse(readFileSync(f, "utf8"))) out.add(e.word);
  }
  // 순한글만. 한자·기호가 섞인 표제어는 국어사전 검색이 거의 안 잡히고, 잡혀도 엉뚱한 것이 온다.
  return [...out].filter((w) => /^[가-힣]+$/.test(w)).sort();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--mock")) return runMock();

  const key = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
  const limit = +(args.find((a) => /^\d+$/.test(a)) || 0);
  if (!key) {
    console.error("사용법:\n" +
      "  node scripts/fetch-meanings.mjs <인증키>       전체 수집\n" +
      "  node scripts/fetch-meanings.mjs <인증키> 200   앞에서 200개만\n" +
      "  node scripts/fetch-meanings.mjs --mock         자가검증\n\n" +
      "인증키 발급: https://stdict.korean.go.kr/openapi/openApiRegister.do");
    process.exit(1);
  }

  const OUT = "data/ksl-meanings.json";
  // 이어받기. 12,900번을 부르는 일이라 중간에 끊기는 게 정상이고, 처음부터 다시 도는 건 낭비다.
  const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  const words = headwords().filter((w) => !(w in done));
  const todo = limit ? words.slice(0, limit) : words;
  console.log(`표제어 ${words.length + Object.keys(done).length}개 · 이미 받은 것 ${Object.keys(done).length} · 이번에 ${todo.length}개`);

  let hit = 0, miss = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const w = todo[i];
    const url = `${ENDPOINT}?key=${key}&q=${encodeURIComponent(w)}&req_type=json&num=10`;
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok || text.trimStart()[0] !== "{") {
        // 키 오류·점검이면 전부 실패하므로 여기서 멈춘다 — 12,900번을 헛돌지 않게.
        if (++fail >= 5) {
          writeFileSync("scripts/last-response.txt", text);
          console.error("\n연속 실패 5회. 인증키·서비스 상태를 확인하세요 → scripts/last-response.txt");
          break;
        }
        continue;
      }
      fail = 0;
      const def = pickDefinition(JSON.parse(text), w);
      // 못 찾은 것도 기록한다(빈 문자열). 안 그러면 다시 돌릴 때마다 없는 낱말을 또 물어본다.
      done[w] = def;
      def ? hit++ : miss++;
    } catch {
      if (++fail >= 5) { console.error("\n연속 실패 5회(네트워크). 중단합니다."); break; }
      continue;
    }
    // 남의 서버다. 간격을 두고 부른다.
    await new Promise((r) => setTimeout(r, 120));
    if (i % 200 === 199) {
      writeFileSync(OUT, JSON.stringify(done));
      process.stdout.write(`\r  ${i + 1}/${todo.length} · 뜻 있음 ${hit} · 없음 ${miss}   `);
    }
  }

  writeFileSync(OUT, JSON.stringify(done));
  const filled = Object.values(done).filter(Boolean).length;
  console.log(`\n${OUT} — 낱말 ${Object.keys(done).length}개 중 뜻 있음 ${filled}개`);
}

// 직접 실행할 때만. 이 가드가 없으면 pickDefinition 을 import 하는 쪽에서 하단이 그대로 돌아
// 사용법을 찍고 process.exit(1) 한다 — test-meaning.mjs 에서 실제로 그랬다(함정 20).
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
