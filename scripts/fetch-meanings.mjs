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
  const exact = list.filter((it) => cleanDefinition(it.word) === word);
  // ⚠️ **동형어가 여럿이면 고르지 않는다.** 사전이 주는 첫 뜻은 흔한 뜻이 아니다 —
  //    가구①은 家具 가 아니라 佳句(잘 지은 글귀)고, 가계①은 家計 가 아니라 加計다.
  //    실제 수어는 가구④(살림 기구)·가계⑧(집안 수입 지출)인데, 어느 쪽인지는 사전이 안 알려준다.
  //    기계가 고르면 지화로 떨어지던 말이 **틀린 뜻으로 단정**된다(⛔ 2번과 같은 부류).
  //    임계값도 점수도 두지 않는다 — 고르는 건 판단이고 판단은 사람 몫이다(매일 100건 절과 같은 규칙).
  if (exact.length !== 1) return "";
  const sense = Array.isArray(exact[0].sense) ? exact[0].sense[0] : exact[0].sense;
  // **첫 문장만.** 사전 뜻풀이는 뒤에 유래·용례가 길게 붙는데(가나안은 기원전 13세기 얘기까지 나온다)
  // 카드에 필요한 건 "이게 무슨 말인가" 한 줄이다. 글자 수로만 자르면 말 중간에서 끊긴다.
  // 마침표 뒤 공백에서만 자른다 — '학자(?~?).' 처럼 괄호 안의 마침표에서 끊기지 않게.
  const first = cleanDefinition(sense?.definition).split(/(?<=\.)\s+/)[0] || "";
  return first.length > MAX_LEN ? first.slice(0, MAX_LEN - 1) + "…" : first;
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

  // 동형어가 여럿이면 **아무것도 안 고른다**. 실제로 가구①=佳句, 가구④=家具 라 첫 뜻을 쓰면 틀린다.
  const homograph = {
    channel: { item: [
      { word: "가구", sup_no: "1", sense: { definition: "잘 지은 글귀." } },
      { word: "가구", sup_no: "4", sense: { definition: "집안 살림에 쓰는 기구." } },
    ] },
  };
  a(pickDefinition(homograph, "가구") === "", "동형어가 여럿인데 하나를 골랐다");

  // 첫 문장만. 뒤에 붙는 유래·용례는 카드에 필요 없다.
  const long2 = { channel: { item: { word: "가나안",
    sense: { definition: "팔레스타인 요르단강 서쪽 지역의 옛 이름. 기원전 13세기경 이스라엘이 정착하였다." } } } };
  a(pickDefinition(long2, "가나안") === "팔레스타인 요르단강 서쪽 지역의 옛 이름.", "첫 문장만 남겨야 한다");
  // 괄호 안 마침표에서 끊기면 안 된다.
  const paren = { channel: { item: { word: "가말리엘",
    sense: { definition: "예루살렘의 유대인 율법학자(?~?). 1세기 초에 활동하였다." } } } };
  a(pickDefinition(paren, "가말리엘") === "예루살렘의 유대인 율법학자(?~?).", "괄호 안 마침표에서 끊겼다");

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
  // **대응표현이 이미 있으면 안 받는다.** 화면의 뜻은 대응표현이 먼저고(국어원이 이 수형에 붙인
  // 말이라 더 정확하다) 뜻풀이는 빈자리만 채운다. 안 거르면 쓰지도 않을 1만 건을 더 받고
  // 파일도 그만큼 커진다. 붙임표만 있는 것(사랑 → -애)은 화면에서 걸러지므로 빈자리로 친다.
  const usable = (e) => (e.aliases || []).some((a) => a !== e.word && !/^-|-$/.test(a));
  for (const f of ["data/ksl-dict.json", "data/ksl-fulldict.json"]) {
    if (!existsSync(f)) continue;
    for (const e of JSON.parse(readFileSync(f, "utf8"))) if (!usable(e)) out.add(e.word);
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 실패하면 **쉬었다 다시 온다.** 예전엔 실패 때 continue 로 대기를 건너뛰어서, 순간적인 끊김
  // 하나가 밀리초 안에 5연속 실패로 불어나 3,900개에서 통째로 멈췄다(API 는 멀쩡했다).
  // 쉬는 시간을 늘려 가며 참고, 정말 계속 안 되면(키 오류·점검) 그때 그만둔다.
  const MAX_FAIL = 8;
  let hit = 0, miss = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const w = todo[i];
    const url = `${ENDPOINT}?key=${key}&q=${encodeURIComponent(w)}&req_type=json&num=10`;
    let text = "";
    try {
      const res = await fetch(url);
      text = await res.text();
      if (!res.ok) throw new Error("http " + res.status);
      fail = 0;
      // ⚠️ **빈 본문은 "그런 낱말 없음"이다.** 이 API 는 결과가 없으면 JSON 대신 아무것도 안 준다
      //    (가로되·가르멜회 등). 이걸 실패로 세면 3,900개에서 통째로 멈춘다 — 실제로 두 번 멈췄고
      //    "네트워크 오류"로 오진했다. HTTP 상태가 200 이면 서버는 대답을 한 것이다.
      const def = text.trim() ? pickDefinition(JSON.parse(text), w) : "";
      // 못 찾은 것도 기록한다(빈 문자열). 안 그러면 다시 돌릴 때마다 없는 낱말을 또 물어본다.
      done[w] = def;
      def ? hit++ : miss++;
    } catch {
      if (++fail >= MAX_FAIL) {
        if (text) writeFileSync("scripts/last-response.txt", text);
        console.error(`\n연속 실패 ${MAX_FAIL}회. 인증키·서비스 상태를 확인하세요` +
          (text ? " → scripts/last-response.txt" : " (응답이 아예 안 옴 — 네트워크)"));
        break;
      }
      writeFileSync(OUT, JSON.stringify(done));   // 여기서 끊겨도 여태 받은 건 남긴다
      await sleep(1000 * fail);                   // 1초, 2초, 3초… 점점 길게 쉰다
      i--;                                        // 같은 낱말을 다시 시도한다
      continue;
    }
    // 남의 서버다. 간격을 두고 부른다.
    await sleep(120);
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
