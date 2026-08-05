// 검증 전 "어떤 영상을 볼지" 좁혀주는 도구. 판정은 하지 않는다.
//
// 왜 선별만 하나: 손 그림 판독은 이 프로젝트에서 두 번 틀렸다(지화 ㅗ 오판, 보고싶다 오판).
// 모델을 판정자로 세우면 틀린 답에 도장을 찍는 셈이다. 그래서 여기서는
// **제목·채널·조회수 텍스트만** 보고 "볼 만한 영상 순위"를 매긴다. 틀려도 사람이 영상을 보면 걸러진다.
// 최종 판정은 언제나 사람: node scripts/verify.mjs --add ...
//
//   node scripts/screen.mjs 만나다
//   node scripts/screen.mjs 만나다 --raw     # 모델 없이 유튜브 검색 결과만
//
// 인증: ANTHROPIC_API_KEY 환경변수, 또는 `ant auth login` 프로필(SDK가 알아서 찾는다).
import Anthropic from "@anthropic-ai/sdk";
import { pathToFileURL } from "node:url";

const MODEL = "claude-haiku-4-5"; // 텍스트 선별용. 판정이 아니라서 가장 싼 모델로 충분하다.

// 유튜브 검색 결과는 JS 렌더지만 ytInitialData가 HTML에 인라인으로 박혀 있다.
export function parseSearch(html) {
  const m = html.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s);
  if (!m) return [];
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const v = node.videoRenderer;
    if (v?.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push({
        id: v.videoId,
        title: v.title?.runs?.map((r) => r.text).join("") ?? "",
        channel: v.ownerText?.runs?.[0]?.text ?? v.longBylineText?.runs?.[0]?.text ?? "",
        views: v.viewCountText?.simpleText ?? "",
        length: v.lengthText?.simpleText ?? "",
      });
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(JSON.parse(m[1]));
  return out;
}

async function searchYouTube(word) {
  const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent("수어 " + word);
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "ko" } });
  if (!res.ok) throw new Error(`유튜브 검색 실패: HTTP ${res.status}`);
  return parseSearch(await res.text());
}

const PROMPT = `한국수어를 배우는 앱의 자료 조사를 돕고 있습니다.

찾는 단어: "%WORD%"

아래는 유튜브에서 "수어 %WORD%"로 검색한 결과입니다. 제목·채널·길이·조회수만 있고 영상 내용은 볼 수 없습니다.

%LIST%

이 중 **"%WORD%"의 수어 손모양을 정면으로 가르치는** 영상을 골라 순위를 매겨주세요.

판단 기준:
- 제목에 그 단어가 직접 있고 "수어/수화 배우기" 류인 것이 가장 높다
- 여러 단어를 한 영상에 몰아넣은 것, 뉴스·다큐·브이로그, 노래 수어 커버는 낮다
- 단어가 제목에 없고 검색어만 걸린 것은 제외한다

각 후보에 대해 한 줄 이유를 붙이고, 볼 가치가 있는 게 하나도 없으면 그렇게 말해주세요.
영상 내용을 추측해서 단정하지 마세요 — 당신은 제목만 봤습니다.`;

const OUT_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "integer" },
          index: { type: "integer", description: "목록에서의 번호(1부터)" },
          reason: { type: "string", description: "제목만 보고 판단한 한 줄 근거" },
        },
        required: ["rank", "index", "reason"],
        additionalProperties: false,
      },
    },
    note: { type: "string", description: "볼 만한 게 없거나 주의할 점이 있으면 한 줄" },
  },
  required: ["picks", "note"],
  additionalProperties: false,
};

async function screen(word, raw) {
  const vids = await searchYouTube(word);
  if (!vids.length) {
    console.log("유튜브 검색 결과가 없습니다.");
    return;
  }
  const list = vids
    .slice(0, 12)
    .map((v, i) => `${i + 1}. ${v.title} — ${v.channel} · ${v.length || "?"} · ${v.views || "?"}`)
    .join("\n");

  console.log(`\n== 유튜브 검색: 수어 ${word} ==\n${list}\n`);
  if (raw) return;

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: OUT_SCHEMA } },
    messages: [{ role: "user", content: PROMPT.replaceAll("%WORD%", word).replace("%LIST%", list) }],
  });

  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  const { picks = [], note = "" } = JSON.parse(text);

  console.log("-- 볼 만한 순서 (제목만 보고 고른 것, 판정 아님) --");
  if (!picks.length) console.log("  (없음)");
  for (const p of picks.sort((a, b) => a.rank - b.rank)) {
    const v = vids[p.index - 1];
    if (!v) continue;
    console.log(`  ${p.rank}. ${v.title}  [${v.channel}]`);
    console.log(`     https://www.youtube.com/watch?v=${v.id}`);
    console.log(`     ${p.reason}`);
  }
  if (note) console.log(`\n  참고: ${note}`);

  const u = res.usage;
  const usd = (u.input_tokens * 1 + u.output_tokens * 5) / 1e6; // Haiku 4.5 $1/$5 per MTok
  console.log(`\n  비용: 입력 ${u.input_tokens} · 출력 ${u.output_tokens} 토큰 ≈ $${usd.toFixed(5)} (약 ${Math.round(usd * 1400)}원)`);
  console.log(`\n  영상을 실제로 본 뒤에만:`);
  console.log(`    node scripts/verify.mjs --add "${word}" "부품1+부품2" "<영상URL>" "몇 초 자막 등 근거"`);
}

// 직접 실행할 때만 돈다 — 테스트가 parseSearch만 가져다 쓸 수 있게.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [word, ...flags] = process.argv.slice(2);
  if (!word) {
    console.error("사용법: node scripts/screen.mjs <단어> [--raw]");
    process.exit(1);
  }
  try {
    await screen(word, flags.includes("--raw"));
  } catch (e) {
    if (/api[_ ]?key|authentication/i.test(e.message)) {
      console.error("인증이 없습니다. ANTHROPIC_API_KEY 를 설정하거나 `ant auth login` 을 하세요.");
      console.error("모델 없이 검색 결과만 보려면: node scripts/screen.mjs " + word + " --raw");
    } else {
      console.error("실패:", e.message);
    }
    process.exit(1);
  }
}
