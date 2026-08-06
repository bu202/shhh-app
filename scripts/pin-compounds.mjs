// 자동 추출 합성의 부품 수형을 CSV '수형설명'으로 못박는다 → data/ksl-compounds.json
//
// 왜 되는가: 합성어의 '수형설명'은 부품들의 수형설명을 **글자 그대로 이어붙인 것**이다.
//   조어 = 말 + 두드리다
//   CSV  "오른주먹의1지를펴서세워옆면을입에댔다가밖으로내민다음,모로세운오른주먹의밑면으로…"
//   말   "오른주먹의1지를펴서세워옆면을입에댔다"                 ← 통째로 들어있다
// 그래서 '말'의 후보 여럿 중 어느 수형인지가 **판단 없이 문자열 포함 검사로** 정해진다.
// 손 그림을 읽는 게 아니라서 ⛔ 규칙에 걸리지 않는다(CLAUDE.md "텍스트 교차대조").
//
// 못박아도 그 합성이 **실제로 쓰는 표현인지는 여전히 미검증**이다. 이 파일은 자동 추출본이라
// 화면에 "아직 사람이 확인하지 않았어요" 경고가 그대로 뜬다. 두 축은 별개다:
//   수형이 정해졌나(이 스크립트) / 사람이 영상으로 봤나(verify.mjs --add)
//
//   node scripts/pin-compounds.mjs "<CSV 경로>"        # CSV 로 기계 처리 + 사람 결정 반영
//   node scripts/pin-compounds.mjs "<CSV 경로>" --dry  # 미리보기(파일 안 건드림)
//   node scripts/pin-compounds.mjs --todo 100          # 오늘 사람이 고를 100건 (CSV 로 안 풀린 것)
//   node scripts/pin-compounds.mjs --pin 흉악 최고 IMG000233547   # 사람이 고른 것 기록
//   node scripts/pin-compounds.mjs --selftest          # 규칙만 검증(파일 불필요)
//
// 사람 결정은 data/ksl-pins.json 에 따로 쌓이고 **CSV 결과를 이긴다**. 따로 두는 이유:
// ksl-compounds.json 은 언제든 다시 빌드되는 파생물이라 거기 적으면 날아간다(사람이 이긴다).
// ⚠️ build-compounds.mjs 를 다시 돌린 뒤에는 이 스크립트를 한 번 더 돌려야 핀이 복구된다.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert";
import { parseCsv } from "./build-compounds.mjs";

const PINS = "data/ksl-pins.json";
const loadPins = () => (existsSync(PINS) ? JSON.parse(readFileSync(PINS, "utf8")) : {});
const pinKey = (word, part) => word + "|" + part;
// 받침 있으면 "을", 없으면 "를". app.js 의 eunNeun 과 같은 부류 — 표제어를 문장에 끼우면 늘 필요하다.
const eulReul = (w) => {
  const n = w.charCodeAt(w.length - 1) - 0xac00;
  return n >= 0 && n <= 11171 && n % 28 ? "을" : "를";
};

const tidy = (s) => (s || "").replace(/\s+/g, "").replace(/[.]$/, "");
const bare = (s) => s.split("@")[0];
const imgId = (e) => ((e.media?.src?.[0] || "").match(/IMG\d+/) || [""])[0];

// 합성어 수형설명 + 부품 후보들 → 못박을 그림 ID (못 정하면 null).
// 정확히 한 그림만 걸릴 때만 채택한다. 여럿 걸리면 기계가 고를 일이 아니다(⛔ 수칙).
// 그림 없는 후보가 이기면 @핀을 못 만든다(핀은 그림 파일 이름이다) → 포기.
export function pickPin(shapeDesc, cands) {
  const shape = tidy(shapeDesc);
  if (!shape) return null;
  const hits = cands.filter((e) => shape.includes(tidy(e.description)));
  const ids = new Set(hits.map(imgId));
  if (ids.size !== 1) return null;
  const id = [...ids][0];
  return id || null;
}

function selftest() {
  const A = { word: "말", description: "오른 주먹의 1지를 펴서 세워 옆면을 입에 댔다가 밖으로 내민다.", media: { src: ["x/IMG000225447.jpg"] } };
  const B = { word: "말", description: "두 주먹을 위아래로 흔든다.", media: { src: ["x/IMG000999999.jpg"] } };
  const C = { word: "말", description: "두 주먹을 위아래로 흔든다.", media: { src: [] } };
  const shape = "오른 주먹의 1지를 펴서 세워 옆면을 입에 댔다가 밖으로 내민 다음, 모로 세운 오른 주먹의 밑면으로 두드린다.";
  assert.equal(pickPin(shape, [A, B]), "IMG000225447", "한 후보만 걸리면 못박는다");
  assert.equal(pickPin(shape, [B]), null, "아무도 안 걸리면 못박지 않는다");
  assert.equal(pickPin("", [A, B]), null, "수형설명이 없으면 못박지 않는다");
  assert.equal(pickPin("두 주먹을 위아래로 흔든다.", [B, C]), null, "그림 없는 후보가 섞이면 못박지 않는다");
  // 같은 그림을 가리키는 후보가 둘이면(별칭 중복) 모호가 아니다
  assert.equal(pickPin(shape, [A, { ...A, word: "언어" }]), "IMG000225447", "같은 그림이면 하나로 본다");
  console.log("selftest ok");
}

// 사전 색인 + CSV 수형설명 + 합성 목록. run/todo 가 같은 것을 봐야 목록과 결과가 어긋나지 않는다.
function context(csvPath) {
  const J = (p) => JSON.parse(readFileSync(p, "utf8"));
  const dict = J("data/ksl-dict.json");
  const fr = J("data/ksl-fulldict.json");
  const full = Array.isArray(fr) ? fr : Object.values(fr)[0];

  // 앱의 loadDictionary/buildIndex 와 같은 병합·색인 규칙. 다르면 "앱이 보는 후보"와 어긋난다.
  const known = new Set(dict.map((e) => e.word));
  const merged = dict.map((e) => ({ ...e, media: e.media || { src: [] } }));
  for (const r of full) {
    if (known.has(r.word)) continue;
    known.add(r.word);
    merged.push({ word: r.word, aliases: r.aliases || [], description: r.description, media: { src: [] } });
  }
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, "");
  const index = new Map();
  for (const pass of [0, 1]) {
    for (const e of merged) {
      for (const k of pass === 0 ? [e.word] : e.aliases || []) {
        if (!k) continue;
        if (!index.has(norm(k))) index.set(norm(k), []);
        const arr = index.get(norm(k));
        if (!arr.includes(e)) arr.push(e);
      }
    }
  }

  const rows = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
  const hdr = rows[0].map((h) => h.trim());
  const [iWord, iShape, iCombo] = ["한국어 대응표현", "수형설명", "결합정보"].map((k) => {
    const i = hdr.indexOf(k);
    if (i < 0) throw new Error(`컬럼 없음: ${k} (있는 컬럼: ${hdr.join(", ")})`);
    return i;
  });
  const shapeOf = new Map();
  for (const r of rows.slice(1)) {
    if (!(r[iCombo] || "").trim()) continue;
    for (const w of (r[iWord] || "").split(",").map((x) => x.trim()).filter(Boolean))
      if (!shapeOf.has(w)) shapeOf.set(w, (r[iShape] || "").trim());
  }

  return { index, norm, shapeOf, comp: J("data/ksl-compounds.json") };
}

// 못박아야 하는 자리인지. 후보가 하나거나 설명이 전부 같으면 어느 쪽을 집어도 같은 손모양이라
// 정할 게 없다 — 앱의 unpinnedCandidates() 와 같은 판정이어야 화면과 어긋나지 않는다.
function ambiguous(index, norm, part) {
  if (part.includes("@")) return null;
  const c = index.get(norm(part)) || [];
  return c.length >= 2 && new Set(c.map((e) => e.description)).size >= 2 ? c : null;
}

function run(csvPath, dry) {
  const { index, norm, shapeOf, comp } = context(csvPath);
  const pins = loadPins();
  let slots = 0, byCsv = 0, byHuman = 0, already = 0;
  const words = new Set(), samples = [];
  for (const [w, v] of Object.entries(comp)) {
    v.parts = v.parts.map((p) => {
      if (p.includes("@")) { already++; return p; }
      const c = ambiguous(index, norm, p);
      if (!c) return p;
      slots++;
      // 사람이 고른 것이 CSV 를 이긴다.
      const id = pins[pinKey(w, p)] || pickPin(shapeOf.get(w), c);
      if (!id) return p;
      if (pins[pinKey(w, p)]) byHuman++; else byCsv++;
      words.add(w);
      if (samples.length < 5) samples.push(`${w}: ${p} → ${p}@${id}`);
      return p + "@" + id;
    });
  }

  if (!dry) writeFileSync("data/ksl-compounds.json", JSON.stringify(comp));
  console.log(`${dry ? "[미리보기] " : ""}애매한 부품 자리 ${slots} · CSV 로 못박음 ${byCsv} · 사람이 고른 것 ${byHuman} · 이미 못박힘 ${already}`);
  console.log(`합성어 ${words.size}건이 최소 한 자리 해결${dry ? " (파일은 안 건드렸습니다)" : ""}`);
  if (samples.length) console.log("예:", samples.join(" · "));
}

// 오늘 사람이 골라야 할 목록. CSV 로도 안 풀리고 아직 안 고른 것만, 파일 순서대로.
// 고를 때마다 앞에서부터 사라지므로 날짜 기록이 필요 없다 — 목록이 곧 진도다.
function todo(csvPath, n) {
  const { index, norm, shapeOf, comp } = context(csvPath);
  const pins = loadPins();
  const imgId = (e) => ((e.media?.src?.[0] || "").match(/IMG\d+/) || [""])[0];
  let left = 0, shown = 0;
  for (const [w, v] of Object.entries(comp)) {
    for (const p of v.parts) {
      const c = ambiguous(index, norm, p);
      if (!c || pins[pinKey(w, p)] || pickPin(shapeOf.get(w), c)) continue;
      left++;
      if (shown >= n) continue;
      shown++;
      console.log(`\n${shown}. ${w} = ${v.parts.map((x) => x.split("@")[0]).join(" + ")}   ← '${p}'${eulReul(p)} 고르세요`);
      console.log(`   합성 전체 동작: ${shapeOf.get(w) || "(없음)"}`);
      c.forEach((e) => console.log(`   · ${imgId(e) || "(그림없음 — 고를 수 없음)"}  ${e.word}  ${e.description}`));
      console.log(`   → node scripts/pin-compounds.mjs --pin "${w}" "${p}" <IMG…>`);
    }
  }
  console.log(`\n남은 자리 ${left}개 중 ${shown}개 표시. 고른 뒤 CSV 경로로 한 번 더 돌려 반영하세요.`);
}

function pin(word, part, id) {
  if (!word || !part || !/^IMG\d+$/.test(id || "")) {
    console.error('사용법: --pin "<합성어>" "<부품>" "<IMG000123456>"');
    process.exit(1);
  }
  const pins = loadPins();
  pins[pinKey(word, part)] = id;
  writeFileSync(PINS, JSON.stringify(pins, null, 2) + "\n");
  console.log(`기록됨: ${word} 의 '${part}' → ${id}  (총 ${Object.keys(pins).length}건)`);
}

const [a, b, c, d] = process.argv.slice(2);
if (a === "--selftest") selftest();
else if (a === "--pin") pin(b, c, d);
else if (a === "--todo") todo(process.env.KSL_CSV || b, Number(c) || Number(b) || 100);
else if (a) run(a, b === "--dry");
else console.error('사용법: node scripts/pin-compounds.mjs "<CSV 경로>" [--dry] | --todo <N> | --pin … | --selftest');
