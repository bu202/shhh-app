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

const P = { dict: "data/ksl-dict.json", full: "data/ksl-fulldict.json", comp: "data/ksl-compounds.json", ver: "data/ksl-verified.json" };
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, "");

const dict = load(P.dict) || [];
const fullRaw = load(P.full);
const full = Array.isArray(fullRaw) ? fullRaw : fullRaw ? Object.values(fullRaw)[0] : [];
const comp = load(P.comp) || {};
const ver = load(P.ver) || {};

// 표제어/별칭 → 항목. 앱의 buildIndex 와 같은 규칙(표제어 우선, 별칭 충돌은 먼저 온 것).
const index = new Map();
for (const pass of [0, 1]) {
  for (const e of [...dict, ...full]) {
    const keys = pass === 0 ? [e.word] : e.aliases || [];
    for (const k of keys) if (k && !index.has(norm(k))) index.set(norm(k), e);
  }
}

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
  const e = index.get(k);
  if (e) {
    const hasImg = !!(e.media?.src?.length);
    console.log(`사전 표제어 있음: ${e.word}${e.aliases?.length ? " [" + e.aliases.join(",") + "]" : ""}`);
    console.log(`   ${e.description}`);
    console.log(`   그림: ${hasImg ? "있음" : "없음(지화로 표시됨)"}`);
  } else if (comp[word]) {
    console.log(`합성 규칙만 있음(자동 추출, 미검증): ${comp[word].parts.join(" + ")}`);
  } else {
    console.log(`⚠️  사전에 없음 → 앱은 지금 이 단어를 지화(자모)로 떨어뜨립니다.`);
    console.log(`   합성으로 표현되는 말일 수 있습니다. 영상 확인이 필요합니다.`);
  }
  console.log(`\n   확인할 곳: ${ytSearch(word)}`);
  console.log(`   확인했으면: node scripts/verify.mjs --add "${word}" "부품1+부품2" "<영상URL>" "근거메모"`);
}

function add(word, partsStr, source, note) {
  if (!word || !partsStr || !source) {
    console.error('사용법: --add "<단어>" "<부품1+부품2>" "<영상URL>" "<메모>"');
    process.exit(1);
  }
  const labels = partsStr.split("+").map((x) => x.trim()).filter(Boolean);
  // 화면에 그림을 띄우려면 부품이 사전에 있어야 한다. 별칭이면 실제 표제어로 바꿔 적는다.
  const parts = labels.map((l) => {
    const e = index.get(norm(l));
    if (!e) { console.error(`✖ '${l}' 이(가) 사전에 없습니다. 사전에 있는 말로 적어주세요.`); process.exit(1); }
    return e.word;
  });
  ver[word] = { parts, labels, source, by: "", checked: new Date().toISOString().slice(0, 10), note: note || "" };
  writeFileSync(P.ver, JSON.stringify(ver, null, 2) + "\n");
  console.log(`기록됨: ${word} = ${labels.join(" + ")}  →  사전 표제어 [${parts.join(", ")}]`);
}

// 대장에 적힌 부품이 여전히 사전에 있는지. 사전을 갈아끼웠을 때 조용히 깨지는 걸 막는다.
function check() {
  let bad = 0;
  for (const [w, v] of Object.entries(ver)) {
    const missing = v.parts.filter((p) => !index.has(norm(p)));
    if (missing.length) { console.error(`✖ ${w}: 부품이 사전에 없음 — ${missing.join(", ")}`); bad++; }
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
