// 단어 하나를 "앱이 지금 뭐라고 답하는지" 보여주고, 영상으로 확인한 결과를 대장에 적는 도구.
//
// 왜 필요한가: 사전에 표제어가 없다고 그 개념이 없는 게 아니다. '보고싶다'는 사전에 없지만
// 실제로는 [보다]+[원하다] 로 표현한다. 사전만 보면 이걸 못 보고 지화로 잘못 떨어뜨린다.
// 그래서 사람이 영상으로 확인한 것을 data/ksl-verified.json 에 적고, 그게 자동 추출본을 이긴다.
//
//   node scripts/verify.mjs 보고싶다                     # 지금 앱이 뭐라 하는지 + 확인할 영상 검색 링크
//   node scripts/verify.mjs --add 그립다 그리워하다 <URL> "45초 자막"   # 대장에 기록
//   node scripts/verify.mjs --check                      # 대장이 아직 사전과 맞는지(회귀검사)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadAppState } from "./_app.mjs";

const P = { ver: "data/ksl-verified.json" };
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const ver = load(P.ver) || {};

// 사전·합성·매칭은 전부 앱 것을 그대로 쓴다. 여기서 다시 만들면 두 번째 진실이 생기고,
// 실제로 그랬다 — 사전을 따로 병합하느라 활용(고마워→고맙다)을 몰라서 "사전에 없음"이라 답했다.
const APP = await loadAppState("COMPOUNDS, matchSentence, norm");
const { norm } = APP;
const index = APP.index();

// 그림 파일 이름 = 수형의 신분증. 앱의 @핀도 이 값을 쓴다.
const imgId = (e) => ((e.media?.src?.[0] || "").match(/IMG\d+/) || [""])[0];
const bare = (s) => s.split("@")[0];
// 앱의 lookup() 과 같은 규칙. "보다@IMG000227009" → 그 그림을 가진 후보.
function lookup(spec) {
  const [w, pin] = spec.split("@");
  const c = index.get(norm(w)) || [];
  return (pin && c.find((e) => imgId(e) === pin)) || c[0] || null;
}
const showCands = (w, c) => {
  console.error(`\n'${w}' 는 수형이 ${c.length}개입니다. 어느 것인지 사람이 골라야 합니다:`);
  c.forEach((e) => console.error(`   ${w}@${imgId(e) || "(그림없음)"}  ${e.description.slice(0, 60)}`));
  console.error(`   → 부품을 "${w}@<위 ID>" 로 적어 다시 실행하세요.`);
};

const ytSearch = (w) => "https://www.youtube.com/results?search_query=" + encodeURIComponent("수어 " + w);

function look(word) {
  const k = norm(word);
  console.log(`\n== ${word} ==`);
  const v = ver[word];
  if (v) {
    console.log(`✅ 검증됨 — ${(v.labels || v.parts).join(" + ")}`);
    console.log(`   출처: ${v.by} ${v.source}  (${v.checked})`);
    console.log(`   메모: ${v.note}`);
    return;
  }
  const cands = index.get(k) || [];
  if (cands.length) {
    // 동음이의를 전부 보여준다. 하나만 보여주면 "보다"처럼 뜻이 다른 수형을 못 보고 지나친다.
    console.log(`사전 표제어 있음 — 수형 ${cands.length}개`);
    cands.forEach((e) => {
      const id = imgId(e);
      console.log(`   ${word}@${id || "(그림없음)"}  ${e.word}${e.aliases?.length ? " [" + e.aliases.join(",") + "]" : ""}`);
      console.log(`      ${e.description}`);
    });
    if (cands.length > 1) console.log(`   ⚠️ 부품으로 쓸 땐 "${word}@<ID>" 로 어느 수형인지 못박으세요.`);
  } else {
    // 표제어가 그대로 없어도 앱은 활용을 풀고(고마워→고맙다) 합성을 본다.
    // 그러니 "없다"고 단정하지 말고 앱을 실제로 돌려 그 답을 보여준다.
    for (const k of APP.matchSentence(word)) {
      if (k.type === "compound") console.log(`합성으로 뜸${k.combo.verified ? "(검증됨)" : "(자동 추출, 미검증)"}: ${(k.combo.labels || k.combo.parts).join(" + ")}`);
      else if (k.type === "entry") console.log(`활용을 풀어 표제어로 뜸: ${k.text} → ${k.entries.map((e) => e.word).join(" | ")}`);
      else console.log(`⚠️  '${k.text}' 는 못 찾아 지화(자모)로 떨어집니다. 합성으로 표현되는 말일 수 있습니다.`);
    }
  }
  console.log(`\n   확인할 곳: ${ytSearch(word)}`);
  console.log(`   확인했으면: node scripts/verify.mjs --add "${word}" "부품1+부품2" "<영상URL>" "근거메모"`);
}

// by 는 앱이 출처 링크의 글자로 쓴다(채널명). 비우면 "영상 출처"로 뜬다.
function add(word, partsStr, source, note, by) {
  if (!word || !partsStr || !source) {
    console.error('사용법: --add "<단어>" "<부품1+부품2>" "<영상URL>" "<메모>" ["<채널명>"]');
    process.exit(1);
  }
  const specs = partsStr.split("+").map((x) => x.trim()).filter(Boolean);
  const labels = specs.map(bare);
  // 화면에 그림을 띄우려면 부품이 사전에 있어야 한다. 별칭이면 실제 표제어로 바꿔 적는다.
  // 수형이 여럿이면 여기서 멈춘다 — 어느 수어를 보여줄지는 기계가 정할 일이 아니다(⛔ 수칙).
  const parts = specs.map((spec) => {
    const [l, pin] = spec.split("@");
    const c = index.get(norm(l)) || [];
    if (!c.length) { console.error(`✖ '${l}' 이(가) 사전에 없습니다. 사전에 있는 말로 적어주세요.`); process.exit(1); }
    if (!pin && c.length > 1) { showCands(l, c); process.exit(1); }
    const e = lookup(spec);
    if (pin && imgId(e) !== pin) { console.error(`✖ '${l}' 에 ${pin} 그림이 없습니다.`); showCands(l, c); process.exit(1); }
    return pin ? e.word + "@" + pin : e.word;
  });
  ver[word] = { parts, labels, source, by: by || "", checked: new Date().toISOString().slice(0, 10), note: note || "" };
  writeFileSync(P.ver, JSON.stringify(ver, null, 2) + "\n");
  console.log(`기록됨: ${word} = ${labels.join(" + ")}  →  사전 표제어 [${parts.join(", ")}]`);
}

// 대장에 적힌 부품이 여전히 사전에 있는지 + 어느 수형인지 못박혀 있는지.
// 사전을 갈아끼웠을 때 조용히 다른 수어가 뜨는 것이 가장 위험하다(⛔ 실제 수어만 보여준다).
function check() {
  let bad = 0;
  for (const [w, v] of Object.entries(ver)) {
    for (const spec of v.parts) {
      const [l, pin] = spec.split("@");
      const c = index.get(norm(l)) || [];
      const e = lookup(spec);
      if (!e) { console.error(`✖ ${w}: 부품이 사전에 없음 — ${l}`); bad++; }
      else if (pin && imgId(e) !== pin) { console.error(`✖ ${w}: '${l}' 의 ${pin} 그림이 사라져 다른 수형으로 떨어짐`); bad++; }
      else if (!pin && c.length > 1) { console.error(`✖ ${w}: '${l}' 은 수형이 ${c.length}개인데 못박혀 있지 않음 — 앱이 첫 번째를 임의로 보여줌`); showCands(l, c); bad++; }
    }
  }
  const n = Object.keys(ver).length;
  if (bad) { console.error(`\n${bad}/${n} 건 깨짐`); process.exit(1); }
  console.log(`ok — 검증 대장 ${n}건 전부 사전과 연결됨`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "--check") check();
else if (cmd === "--add") add(...rest);
else if (cmd) look(cmd);
else console.error("사용법: node scripts/verify.mjs <단어> | --add … | --check");
