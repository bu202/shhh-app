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
// **행위자 술어를 빼는 자리표시자.** 유지보수 fence 는 그대로 지나고 사용자 술어만 빠진다.
// ⛔ **이유 없이 쓰지 않는다** — `scripts/test-fence.mjs` 가 사용처를 전수로 세고, 등재되지
//    않은 자리가 하나라도 있으면 실패한다.
export const FENCE_ONLY_MARK = "{FENCE_ONLY}";
// ⚠️ **문자열 `.replace("?", …)` 로 자리를 채우지 않는다.** 채운 값 자체가 `?3` 처럼 `?` 를
//    담고 있어서, 두 번째 replace 가 **첫 번째가 넣은 `?` 를 다시 잡는다**(`?54` 가 나온다).
//    실제로 그렇게 만들었다가 친구 단어장 질의가 조용히 틀린 컬럼을 비교했다 — 자리는
//    템플릿 리터럴로 **한 번에** 짠다.
const fenceSql = (e) => `EXISTS (SELECT 1 FROM write_fence WHERE id = 1 AND epoch = ${e})`;

// ── 행위자(actor) 술어 — **사용자 단위 fencing** (2026-08-27 · 위협 79) ──
// 유지보수 fence 는 「지금 전체가 멈췄나」를 묻는다. 그것만으로는 **처리정지**를 못 막는다:
// `POST /me/suspend` 가 끝난 뒤에도, 그보다 먼저 `whoAmI()` 를 통과한 요청은 자기 SQL 을
// 그대로 던진다. 요청 초입의 한 번 조회는 검사와 사용 사이에 창이 있는 TOCTOU 이고,
// **사전조회를 하나 더 붙여도 창이 하나 더 생길 뿐이다.**
//
// 그래서 검사를 **문장 안**에 넣는다. 요구하는 것은 셋이다:
//   ① 그 계정이 아직 있다      — 탈퇴가 끝난 뒤의 옛 요청을 막는다
//   ② `suspended_at IS NULL`   — 처리정지가 끝난 뒤의 옛 요청을 막는다
//   ③ 세대가 인증 당시와 같다  — 로그아웃(모든 기기)이 끝난 뒤의 옛 요청을 막는다
// 셋 다 **쓰기와 같은 문장**이라 그 사이에 창이 없다.
const actorSql = (u, g) =>
  `EXISTS (SELECT 1 FROM users WHERE id = ${u} AND suspended_at IS NULL AND session_version = ${g})`;

// fence 불일치. 부르는 쪽은 이것을 **503** 으로 바꾼다(사용자 오류가 아니다).
export class FenceMismatch extends Error {
  constructor() { super("write fence epoch mismatch"); this.name = "FenceMismatch"; }
}

// 행위자가 더 이상 유효하지 않다. `reason` 은 **부르는 쪽이 상태코드를 고르는 데만** 쓴다 —
// 응답 본문에는 싣지 않는다(정지 시각·세대·uid 는 전부 내부값이다).
//   "suspended"  그 계정이 처리정지 중이다        → 403 (다음 요청이 게이트에서 받는 답과 같다)
//   "stale"      계정이 없거나 세대가 지났다       → 401 (로그아웃·탈퇴가 받는 답과 같다)
// ⚠️ 두 값을 가르는 것이 새로 알려주는 정보는 **없다** — 같은 사람이 요청을 한 번 더 보내면
//    게이트가 정확히 같은 답을 준다. 가르지 않으면 로그아웃한 사람에게 「정지 중」이라고 말하게 된다.
export class ActorGone extends Error {
  constructor(reason) { super("actor no longer live"); this.name = "ActorGone"; this.reason = reason; }
}

// `{FENCE}` 가 몇 번 나오나. **여러 번 적을 수 있다**(UNION·서브쿼리) — 나온 수만큼 epoch 을
// 더한다. 개수가 어긋나면 바인딩이 밀려 조용히 엉뚱한 값을 비교하게 된다.
// ⚠️ **문장의 파라미터 번호 체계를 따라간다.** 이 저장소의 SQL 은 익명 `?` 와 번호형 `?1` 을
//    둘 다 쓴다. 번호형 문장에 익명 `?` 를 덧붙이면 드라이버마다 다음 번호를 다르게 매겨
//    「column index out of range」로 죽거나 **더 나쁘게는 엉뚱한 값을 비교한다.**
//    그래서 이미 번호형을 쓰는 문장에는 `?<다음번호>` 를 명시적으로 만들어 붙인다.
//    (실제로 겪었다 — `?1..?5` 를 쓰는 books upsert 가 이 오류로 죽었다.)
function expand(sql, withActor) {
  const src = String(sql);
  const only = src.includes(FENCE_ONLY_MARK);
  if (only && src.replace(new RegExp(FENCE_ONLY_MARK.replace(/[{}]/g, "\\$&"), "g"), "").includes(FENCE_MARK))
    throw new Error("statement mixes " + FENCE_MARK + " and " + FENCE_ONLY_MARK + ": " + src.slice(0, 70));
  const mark = only ? FENCE_ONLY_MARK : FENCE_MARK;
  const parts = src.split(mark);
  if (parts.length < 2)
    throw new Error("fenced statement must contain " + FENCE_MARK + ": " + src.slice(0, 70));
  const uses = parts.length - 1;
  const actor = withActor && !only;
  // 자리표시자 하나가 쓰는 파라미터 수. 행위자가 붙으면 epoch + uid + 세대 셋이다.
  const per = actor ? 3 : 1;
  const numbered = [...src.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  const base = numbered.length ? Math.max(...numbered) : 0;
  // ⚠️ **번호형과 익명형을 섞지 않는다.** 이미 번호형을 쓰는 문장에는 다음 번호를 명시적으로
  //    만들어 붙인다(그러지 않으면 드라이버마다 번호를 다르게 매겨 **엉뚱한 값을 비교한다**).
  const slot = (k) => (numbered.length ? "?" + (base + 1 + k) : "?");
  let out = parts[0];
  for (let i = 0; i < uses; i++) {
    const at = i * per;
    let pred = fenceSql(slot(at));
    if (actor) pred += " AND " + actorSql(slot(at + 1), slot(at + 2));
    out += pred + parts[i + 1];
  }
  return { sql: out, uses, actor };
}

// 지금 fence 가 이 epoch 인가. **판별용이고 방어가 아니다** — 방어는 문장 안의 술어다.
async function fenceCurrent(raw, epoch) {
  const r = await raw.prepare("SELECT 1 AS ok FROM write_fence WHERE id = 1 AND epoch = ?")
    .bind(epoch).first();
  return !!r;
}

// 0행이 나왔다. 정상인가, fence 불일치인가, 행위자가 사라졌나.
// ⚠️ **0행일 때만 묻는다** — 성공한 요청에 질의를 하나 더 붙이지 않는다.
// ⚠️ 순서가 있다: fence 가 먼저다. 전환 중에는 행위자 조회 자체가 옛 세대를 볼 수 있다.
async function classifyEmpty(raw, epoch, actor) {
  if (!(await fenceCurrent(raw, epoch))) throw new FenceMismatch();
  if (!actor) return;
  const u = await raw.prepare("SELECT suspended_at AS s, session_version AS v FROM users WHERE id = ?")
    .bind(actor.uid).first();
  if (u && u.s !== null && u.s !== undefined) throw new ActorGone("suspended");
  if (!u || Number(u.v) !== Number(actor.gen)) throw new ActorGone("stale");
}

// 감싼 문장. `bind()` 로 받은 사용자 바인딩 **뒤에** epoch 을 붙인다.
class FencedStmt {
  // ⚠️ **확장을 생성자가 아니라 실행 시점에 한다.** 행위자는 요청 초입의 `whoAmI()` 뒤에야
  //    정해지는데, 그 앞뒤가 같은 감싼 env 를 쓴다. 셀 하나를 들고 있다가 실행할 때 읽으면
  //    「인증 전 문장은 행위자 없이, 인증 후 문장은 행위자와 함께」가 저절로 된다.
  constructor(raw, epoch, sql, cell) {
    this.raw = raw; this.epoch = epoch; this.src = String(sql); this.cell = cell; this.args = [];
    // ⚠️ **자리표시자 유무는 여기서 본다.** 확장은 실행 시점으로 미뤘지만, 「빠뜨렸다」는
    //    준비하는 그 자리에서 터져야 어느 문장인지가 바로 보인다.
    if (!this.src.includes(FENCE_MARK) && !this.src.includes(FENCE_ONLY_MARK))
      throw new Error("fenced statement must contain " + FENCE_MARK + ": " + this.src.slice(0, 70));
  }
  bind(...args) { this.args = args; return this; }
  #actor() { return this.cell && this.cell.current ? this.cell.current : null; }
  #plan() {
    const a = this.#actor();
    const e = expand(this.src, !!a);
    const extra = [];
    for (let i = 0; i < e.uses; i++) {
      extra.push(this.epoch);
      if (e.actor) extra.push(a.uid, a.gen);
    }
    return { stmt: this.raw.prepare(e.sql).bind(...this.args, ...extra), actor: e.actor ? a : null };
  }
  async run() {
    const p = this.#plan();
    const r = await p.stmt.run();
    if (!((r.meta && r.meta.changes) || 0)) await classifyEmpty(this.raw, this.epoch, p.actor);
    return r;
  }
  async first(col) {
    const p = this.#plan();
    const row = await p.stmt.first(col);
    if (row === null || row === undefined) await classifyEmpty(this.raw, this.epoch, p.actor);
    return row;
  }
  async all() {
    const p = this.#plan();
    const r = await p.stmt.all();
    if (!((r && r.results && r.results.length) || 0)) await classifyEmpty(this.raw, this.epoch, p.actor);
    return r;
  }
  // batch 안에서 쓰기 위한 **준비된 문장**. 판별은 batch 가 모아서 한다.
  _forBatch() { const p = this.#plan(); this._actorUsed = p.actor; return p.stmt; }
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
  // ★ **한 batch 안에서 자리표시자를 섞지 않는다**(2026-08-27 · 독립 검토 H1).
  //
  // 아래 판별은 「하나라도 바뀌었으면 술어는 통과한 것」이라는 성질에 기댄다. 그 성질은
  // **모든 문장이 같은 술어를 들 때만** 참이다. `{FENCE}` 와 `{FENCE_ONLY}` 를 한 batch 에
  // 섞으면 깨진다 — 술어가 약한 문장이 쓰고 강한 문장이 0행일 때 판별이 아예 안 돌아,
  // **실패한 작업이 성공으로 보고된다.**
  // 실제로 그럴 뻔했다: `suspendAccount` 가 세션 삭제(`{FENCE_ONLY}`)와 정지 표시(`{FENCE}`)를
  // 한 batch 로 보냈고, 그 사이에 다른 기기가 로그아웃하면 **세션만 지워지고 정지는 안 된 채
  // `{ok:true}`** 가 나갔다. 섞는 것을 금지하면 그 상태가 존재할 수 없다.
  const marks = stmts.map((s) => (s.src.includes(FENCE_ONLY_MARK) ? "only" : "fence"));
  if (new Set(marks).size > 1)
    throw new Error("fenced batch mixes " + FENCE_MARK + " and " + FENCE_ONLY_MARK
      + " — 한 batch 안에서는 같은 자리표시자만 쓴다");
  const prepared = stmts.map((s) => s._forBatch());
  const actor = stmts.map((s) => s._actorUsed).find(Boolean) || null;
  const rs = await raw.batch(prepared);
  const changes = rs.map((r) => (r && r.meta && r.meta.changes) || 0);
  // 하나도 안 바뀌었으면 술어 불일치일 수 있다. 하나라도 바뀌었으면 통과한 것이다
  // (위에서 자리표시자가 같음을 강제했으므로 술어도 같은 값으로 붙는다).
  if (!changes.some((c) => c > 0)) await classifyEmpty(raw, epoch, actor);
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
  // 행위자 셀. `bindActor()` 가 **요청당 한 번** 채운다.
  const cell = { current: null };
  return {
    ...env,
    DB: {
      prepare: (sql) => new FencedStmt(raw, epoch, sql, cell),
      batch: (stmts) => fencedBatch(raw, epoch, stmts),
      _actor: cell,
      // 감싸기 전의 바인딩. **운영 예외 하나만** 쓴다(`worker/ops.js` 의 `setFenceEpoch`).
      // 아키텍처 검사가 이 이름의 사용처를 전수로 센다.
      _raw: raw,
    },
  };
}

// 이 요청을 인증한 사람. **이 뒤로 나가는 모든 주 D1 문장이** 그 계정의 생존·비정지·세대를
// 같은 문장 안에서 요구한다.
// ⚠️ 한 번만 부른다. 요청 하나에 행위자가 둘이면 어느 술어가 붙었는지 읽는 사람이 알 수 없다.
// ⚠️ 감싸지 않은 env(=lease 없는 라우트)에는 **아무것도 하지 않는다** — 그 라우트는 사용자
//    데이터를 만지지 않으므로 감쌀 것도 없다. `ROUTES` 의 `auth:true` 는 전부 `lease:true` 다
//    (`scripts/test-fence.mjs` 가 그 성질을 전수로 잰다).
export function bindActor(env, me) {
  const cell = env && env.DB && env.DB._actor;
  if (!cell) return env;
  if (cell.current) throw new Error("actor already bound for this request");
  if (!me || !me.uid || !Number.isFinite(Number(me.gen)))
    throw new Error("bindActor needs { uid, gen }");
  cell.current = { uid: me.uid, gen: Number(me.gen) };
  return env;
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
