// 주 D1 의 **구조적 fencing**. 사용자 데이터를 만지는 모든 문장이 여기를 지난다.
//
// ── 왜 있나 ────────────────────────────────────────────────────────────
// lease(`worker/ledger.js`)는 「지금 몇 개가 도나」를 **세는** 장치였을 뿐이다. ledger 쓰기에는
// `FENCE` 가 붙어 있었지만 **주 D1 접근 35곳 중 lease 유효성을 다시 보는 자리는 삭제 saga
// 하나뿐**이었다. 그래서 유지보수로 전환한 뒤에도 아직 살아 있는 요청은 주 D1 에 계속 쓸 수
// 있었고, stale lease 를 해제해도 되는 근거가 **경과 시간밖에** 없었다.
//
// ⛔ **경과 시간은 안전 근거가 아니다**(2026-08-25 사용자 정정). Cloudflare Workers 의 **CPU 제한**
//    (무료 플랜 10ms 등)과 **HTTP 요청의 wall-clock 수명**은 다른 것이다. 클라이언트 연결이
//    유지되는 동안 요청은 하드 wall-time 제한 없이 살아 있을 수 있으므로, 「N분 지났으니 그
//    요청은 끝났다」는 증명이 아니라 가정이다. 그래서 방어가 **구조**여야 한다.
//
// ── 어떻게 막나 ────────────────────────────────────────────────────────
// `withFence(env, lease)` 가 `env.DB` 를 감싼 새 env 를 돌려준다. 그 뒤로 이 env 를 받은 코드는
// **평소처럼** `env.DB.prepare(sql).bind(...).run()` 을 부르되, sql 안에 `{FENCE}` 를 적는다.
// 감싼 바인딩이 그것을
//   EXISTS (SELECT 1 FROM write_fence WHERE id = 1 AND epoch = ?)
// 로 바꾸고 lease 의 epoch 을 바인딩 **끝에** 붙인다. 검사와 쓰기가 **같은 DB 의 같은 문장**이라
// 그 사이에 창이 없다 — 옛 epoch 을 든 요청은 0행을 쓴다.
//
// ⚠️ **SQL 을 파싱해서 술어를 끼워 넣지 않는다.** 정규식 SQL 재작성은 조용히 틀리고, 틀린
//    자리가 곧 방어가 빠진 자리다. 저자가 `{FENCE}` 를 적게 하면 **없을 때 던질 수 있고**
//    아키텍처 검사가 전수로 셀 수 있다.
// ⚠️ 감싸지 않은 raw `env` 로 이 SQL 을 보내면 `{FENCE}` 가 그대로 나가 **SQL 오류로 죽는다.**
//    조용한 우회가 아니라 시끄러운 실패다 — 그쪽이 맞는 방향이다.
//
// ── 0행의 두 가지 뜻을 가른다 (원칙 2) ─────────────────────────────────
// 술어를 붙이면 「fence 불일치」와 「정상 비즈니스 0행」이 둘 다 `changes === 0` 이 된다.
// 그 둘을 뭉뚱그려 503 을 내면 `ON CONFLICT DO NOTHING`·멱등 DELETE·「친구가 아님」·「지울 것
// 없음」이 전부 오류가 되어 **기존 HTTP 상태와 멱등성이 바뀐다.**
// 그래서 0행일 때만 fence 를 한 번 더 읽어 가른다:
//   fence 가 지금도 내 epoch  →  **정상 비즈니스 0행**. 그대로 돌려준다
//   fence 가 내 epoch 이 아님  →  **fence 불일치**. `FenceMismatch` 를 던진다
// ⚠️ 0행일 때만 묻는다 — 성공한 요청에 질의를 하나 더 붙이지 않는다.
// ⚠️ 판별 질의와 원래 문장 사이에 전환이 끼어들면 **정상 0행을 불일치로** 읽는다.
//    닫히는 쪽의 오판이라 그대로 둔다(그 반대는 안 된다).
import { assertLeaseContext } from "./ledger.js";

// 문장이 반드시 담아야 하는 자리표시자.
export const FENCE_MARK = "{FENCE}";
const FENCE_SQL = "EXISTS (SELECT 1 FROM write_fence WHERE id = 1 AND epoch = ?)";

// fence 불일치. 부르는 쪽은 이것을 **503** 으로 바꾼다(사용자 오류가 아니다).
export class FenceMismatch extends Error {
  constructor() { super("write fence epoch mismatch"); this.name = "FenceMismatch"; }
}

// `{FENCE}` 가 몇 번 나오나. **여러 번 적을 수 있다**(UNION·서브쿼리) — 나온 수만큼 epoch 을
// 더한다. 개수가 어긋나면 바인딩이 밀려 조용히 엉뚱한 값을 비교하게 된다.
// ⚠️ **문장의 파라미터 번호 체계를 따라간다.** 이 저장소의 SQL 은 익명 `?` 와 번호형 `?1` 을
//    둘 다 쓴다. 번호형 문장에 익명 `?` 를 덧붙이면 드라이버마다 다음 번호를 다르게 매겨
//    「column index out of range」로 죽거나 **더 나쁘게는 엉뚱한 값을 비교한다.**
//    그래서 이미 번호형을 쓰는 문장에는 `?<다음번호>` 를 명시적으로 만들어 붙인다.
//    (실제로 겪었다 — `?1..?5` 를 쓰는 books upsert 가 이 오류로 죽었다.)
function expand(sql) {
  const src = String(sql);
  const parts = src.split(FENCE_MARK);
  if (parts.length < 2)
    throw new Error("fenced statement must contain " + FENCE_MARK + ": " + src.slice(0, 70));
  const uses = parts.length - 1;
  const numbered = [...src.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  let out = parts[0];
  for (let i = 0; i < uses; i++) {
    const mark = numbered.length ? "?" + (Math.max(...numbered) + 1 + i) : "?";
    out += FENCE_SQL.replace("?", mark) + parts[i + 1];
  }
  return { sql: out, uses };
}

// 지금 fence 가 이 epoch 인가. **판별용이고 방어가 아니다** — 방어는 문장 안의 술어다.
async function fenceCurrent(raw, epoch) {
  const r = await raw.prepare("SELECT 1 AS ok FROM write_fence WHERE id = 1 AND epoch = ?")
    .bind(epoch).first();
  return !!r;
}

// 0행이 나왔다. 정상인가 fence 불일치인가.
async function classifyEmpty(raw, epoch) {
  if (!(await fenceCurrent(raw, epoch))) throw new FenceMismatch();
}

// 감싼 문장. `bind()` 로 받은 사용자 바인딩 **뒤에** epoch 을 붙인다.
class FencedStmt {
  constructor(raw, epoch, sql) {
    this.raw = raw; this.epoch = epoch;
    const e = expand(sql);
    this.sql = e.sql; this.uses = e.uses; this.args = [];
  }
  bind(...args) { this.args = args; return this; }
  #prep() { return this.raw.prepare(this.sql).bind(...this.args, ...Array(this.uses).fill(this.epoch)); }
  async run() {
    const r = await this.#prep().run();
    if (!((r.meta && r.meta.changes) || 0)) await classifyEmpty(this.raw, this.epoch);
    return r;
  }
  async first(col) {
    const row = await this.#prep().first(col);
    if (row === null || row === undefined) await classifyEmpty(this.raw, this.epoch);
    return row;
  }
  async all() {
    const r = await this.#prep().all();
    if (!((r && r.results && r.results.length) || 0)) await classifyEmpty(this.raw, this.epoch);
    return r;
  }
  // batch 안에서 쓰기 위한 **준비된 문장**. 판별은 batch 가 모아서 한다.
  _forBatch() { return this.#prep(); }
}

// ── batch (원칙 3) ──────────────────────────────────────────────────────
// **모든 문장이 `{FENCE}` 를 들고 있어야 한다.** 감싼 바인딩으로 만든 문장만 받으므로 그것이
// 구조적으로 보장된다 — raw 문장을 섞으면 던진다. 「대부분 막혔다」는 막힌 것이 아니다.
//
// ⚠️ **「전부 쓰이거나 전부 0행」이라고 문서에 적지 않는다.** D1 의 batch 가 하나의 트랜잭션이라는
//    것은 Cloudflare 문서의 서술이고 이 저장소가 **독립적으로 증명한 사실이 아니다**(테스트는
//    node:sqlite 의 실제 트랜잭션을 돌리지만 그것은 D1 이 아니다). 그래서 정확성이 그 성질에
//    기대지 않게 만든다: 문장마다 술어를 들고, 결과를 **전수로** 검증한다.
async function fencedBatch(raw, epoch, stmts) {
  if (!Array.isArray(stmts) || !stmts.length) throw new Error("fenced batch needs statements");
  for (const s of stmts)
    if (!(s instanceof FencedStmt))
      throw new Error("fenced batch got an unfenced statement — every statement must carry " + FENCE_MARK);
  const rs = await raw.batch(stmts.map((s) => s._forBatch()));
  const changes = rs.map((r) => (r && r.meta && r.meta.changes) || 0);
  // 하나도 안 바뀌었으면 fence 불일치일 수 있다. 하나라도 바뀌었으면 fence 는 통과한 것이다
  // (술어가 모든 문장에 같은 값으로 붙으므로 fence 때문이라면 전부 0행이어야 한다).
  if (!changes.some((c) => c > 0)) await classifyEmpty(raw, epoch);
  return rs;
}

// 이 env 로 주 D1 을 만지면 모든 문장이 fence 를 통과해야 한다.
// ⚠️ **ledger 바인딩은 감싸지 않는다.** ledger 는 자기 `FENCE`(lease_id + epoch)를 이미 들고 있고,
//    fence 행은 주 D1 쪽 이야기다. 둘을 한 함수로 합치면 어느 쪽이 막았는지 못 가린다.
export function withFence(env, lease) {
  assertLeaseContext(lease);
  const raw = env.DB;
  if (!raw) throw new Error("withFence needs env.DB");
  const epoch = lease.epoch;
  return {
    ...env,
    DB: {
      prepare: (sql) => new FencedStmt(raw, epoch, sql),
      batch: (stmts) => fencedBatch(raw, epoch, stmts),
      // 감싸기 전의 바인딩. **운영 예외 하나만** 쓴다(`worker/ops.js` 의 `setFenceEpoch`).
      // 아키텍처 검사가 이 이름의 사용처를 전수로 센다.
      _raw: raw,
    },
  };
}

// ── 두 DB 가 서로를 가리키고 있나 ────────────────────────────────────────
// 주 D1 의 `write_fence.epoch` 과 ledger 의 `maintenance.epoch` 이 같고, 전환이 진행 중이
// 아니어야 참이다. **어긋난 상태에서는 사용자 데이터 문장이 전부 0행**이 되므로 어차피
// 아무도 앱을 못 쓴다 — 그 사실을 `/api/ready` 가 초록으로 감추면 배포가 통과하고
// 사용자의 첫 요청에서만 드러난다.
// ⚠️ 둘 중 하나라도 못 읽으면 **거짓**이다. 「모른다」를 「맞다」로 읽지 않는다.
// ⚠️ 여기 두는 이유: 이것은 **fence 의 상태**이지 운영 명령이 아니다. `worker/ops.js` 에 두면
//    요청 경로(`worker/index.js`)가 운영 명령 모듈을 import 하게 되어 계층이 거꾸로 이어진다.
export async function fenceEpoch(env) {
  const r = await (env.DB._raw || env.DB).prepare("SELECT epoch FROM write_fence WHERE id = 1").first();
  if (!r) throw new Error("write_fence row missing");
  return Number(r.epoch);
}

export async function fenceInSync(env) {
  try {
    const g = await env.LEDGER.prepare(
      "SELECT epoch, pending_transition FROM maintenance WHERE id = 1").first();
    if (!g) return false;
    return Number(g.epoch) === (await fenceEpoch(env)) && !g.pending_transition;
  } catch { return false; }
}
