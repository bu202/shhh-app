// 계층: 입력 수신 + 판단. 로그인 화면과 동기화 규칙. 서버 호출은 js/authApi.js 만 한다.
//
// 로그인을 붙인 **유일한 이유는 단어장이 기기를 따라오게 하는 것**이다. 그래서 이 파일이 하는 일은
// 결국 하나 — 어느 쪽 단어장이 새것인지 정하는 것. 그 판단만 syncPlan() 에 순수 함수로 떼어
// scripts/test-auth.mjs 가 직접 잰다(화면 없이 돌아야 규칙이 회귀검증된다).

const DIRTY_KEY = "shh-dirty";      // 마지막 동기화 뒤에 이 기기에서 고친 적이 있는가
const PEEK_KEY = "shh-peek";        // "로그인 없이 둘러보기"를 고른 적이 있는가
const NAME_KEY = "shh-name";        // 사용자가 지은 별명. 제공자에게 받은 이름이 아니다.
const BACK_KEY = "shh-back";        // 로그인하러 떠나기 직전의 해시(링크로 받은 단어장)
const UID_KEY = "shh-uid";          // 마지막으로 맞춰 둔 계정. 계정이 바뀌면 로컬을 물려주지 않는다
const NAMES = { kakao: "카카오", naver: "네이버", google: "구글" };

// 어느 쪽을 남길지 정한다. 순수 함수 — localStorage 도 DOM 도 안 본다.
//
// ⚠️ **기기 시계는 더 이상 안 본다.** 예전엔 `remote.updated > localAt` 으로 정했는데,
//    시계가 미래인 기기(저가형 안드로이드·수동 설정·타임존 오류로 흔하다)는 언제나 자기가
//    새것이라 여겨 다른 기기에서 담은 단어를 조용히 지웠다. 서버가 버전을 세고 있는데도
//    막히지 않았다 — 앱이 **판정 직전에** 서버에서 최신 버전을 받아 그대로 되보냈기 때문이다
//    (js/authApi.js 의 apiGetBook 이 저장을 그만둔 이유).
//    이제 판정에 쓰는 것은 두 가지, **둘 다 시계와 무관하다**:
//      dirty — 마지막 동기화 뒤 이 기기에서 고친 적이 있나
//      base  — 그때 손에 들고 있던 서버 버전
//
// ponytail: 부딪히면 **합집합**이다. 어느 단어가 새로 담긴 것이고 어느 것이 지워진 것인지
//   구분하려면 마지막 스냅샷을 따로 들고 있어야 하는데(3-way merge), 그건 저장소가 하나 더
//   느는 일이다. 지금은 **지워진 단어가 되살아나는 쪽**을 고른다 — 되살아난 건 다시 지우면
//   되지만 사라진 건 무엇이 사라졌는지조차 모른다. 실제로 문제가 되면 그때 스냅샷을 만든다.
function syncPlan(remote, local, s = {}) {
  const { dirty = true, base = 0, firstLogin = false, localName = "", accountChanged = false } = s;
  const union = () => remote.words.concat(local.filter((w) => !remote.words.includes(w)));
  if (!remote) return { action: "none" };                     // 오프라인 — 로컬을 그대로 둔다
  // 계정이 바뀌었으면 이 기기의 단어장은 **앞 계정 것**이다. 새 계정에 물려주지 않는다 —
  // 안 그러면 한 기기를 두 사람이 쓸 때 앞사람 단어장이 뒷사람 계정으로 올라간다.
  // 버려도 잃는 게 없다: 앞 계정 것은 그쪽 서버에 있고, 담기는 로그인을 요구하므로
  // (mayAddToBook) 로그인 없이 생긴 로컬 단어장이란 것이 없다.
  if (accountChanged) return { action: "pull", words: remote.words, name: remote.name || "" };
  // 로그인 첫 순간만 무조건 합집합. 로그인 전에 담아둔 단어를 잃으면 안 되고,
  // 다른 기기에 있던 것도 가져와야 한다. 이때는 아직 "뺐다"는 뜻이 없으니 합집합이 안전하다.
  // 별명도 같은 이유로: 이 기기에서 지은 별명이 있으면 그걸 쓰고, 없으면 계정에 있던 것.
  if (firstLogin) return { action: "merge", words: union(), name: localName || remote.name || "" };
  // 이 기기에서 고친 적이 없다 → 서버가 진실이다. 시계를 볼 이유가 없다.
  if (!dirty) return { action: "pull", words: remote.words, name: remote.name || "" };
  // 고쳤고, 그 사이 서버는 그대로다 → 내 것을 올린다. 삭제도 이 길로 전파된다.
  if (base === remote.version) return { action: "push", words: local, name: localName };
  // 고쳤는데 서버도 움직였다 → **둘 다 고친 것**이다. 어느 쪽도 버리지 않는다.
  return { action: "merge", words: union(), name: localName || remote.name || "" };
}

// ── 아래는 화면·부수효과 ────────────────────────────────────────────────
if (typeof document !== "undefined") {
  let putTimer = null;
  // "이 기기에서 고쳤다"는 표시. **키가 없으면 고친 것으로 본다** — 이 표시가 생기기 전에
  // 담아둔 단어장이 있는 기기에서 clean 으로 오판하면 그 단어장이 통째로 서버 것으로 덮인다.
  // 기본값이 안전한 쪽이다.
  const isDirty = () => localStorage.getItem(DIRTY_KEY) !== "0";
  // 이 기기의 **편집 세대**. 고칠 때마다 하나 오른다(그래서 touch 안에 둔다 — 따로 두면
  // 새 편집 자리가 생길 때마다 둘 중 하나를 빠뜨린다).
  // 저장 응답이 왔을 때 "그 사이에 또 고쳤나"를 이 값으로 안다. 고쳤다면 서버에 있는 건 옛
  // 것이므로 dirty 를 지우면 안 된다.
  // 서버 버전(shh-bookver)과는 **다른 값**이다: 저쪽은 서버가 세고 이쪽은 이 기기가 센다.
  // 저장이 성공했는데 그 사이 편집이 있었다면 **서버 버전은 받아 적고 dirty 만 남긴다** —
  // 둘을 한 값으로 묶으면 둘 중 하나는 반드시 틀린 말을 하게 된다.
  //
  // ⚠️ **localStorage 에 둔다(탭 안의 변수가 아니다).** 짝이 되는 `shh-dirty` 가 이미 공용이라,
  //    한쪽만 탭별이면 둘이 어긋난다. 실제로 어긋났다:
  //      탭 A 가 저장을 보낸다 → 탭 B 가 단어를 담아 공용 dirty 를 1 로 만든다 →
  //      A 의 응답이 성공으로 온다 → A 는 **자기 편집만** 보고 "그 사이 편집 없음"이라 판정해
  //      공용 dirty 를 0 으로 지운다 → B 가 담은 단어는 서버에 없는데 "저장 끝"이 된다.
  //    B 의 저장까지 실패하면(오프라인) 다음 동기화가 pull 로 덮어 **그 단어가 사라진다.**
  //    공용 값으로 두면 A 는 "누구든 그 사이에 고쳤나"를 보게 되고, 답은 언제나 안전한 쪽이다.
  const REV_KEY = "shh-rev";
  const editRevision = () => Number(localStorage.getItem(REV_KEY)) || 0;
  const touch = () => {
    localStorage.setItem(REV_KEY, String(editRevision() + 1));
    localStorage.setItem(DIRTY_KEY, "1");
  };
  const synced = () => localStorage.setItem(DIRTY_KEY, "0");
  const myName = () => localStorage.getItem(NAME_KEY) || "";

  // 저장은 한 번에 하나만 날아간다. 겹쳐 보내면 서로 충돌을 만들고, 응답 순서가 뒤집혀
  // 어느 응답이 어느 편집의 것인지 알 수 없게 된다. 큐 길이는 1 — 밀린 저장이 몇 개든
  // 마지막 상태 한 번이면 같은 결과다.
  let inflight = null, queued = false;
  function queuePush(words, name) {
    if (inflight) { queued = true; return inflight; }
    inflight = pushBook(words, name).finally(() => {
      inflight = null;
      if (queued) { queued = false; queuePush(BOOK, myName()); }
    });
    return inflight;
  }

  // 서버에 올린다. 충돌(409)이면 **어느 쪽도 버리지 않고 합친 뒤 다시 올린다.**
  //
  // 왜 합집합인가: 충돌은 "두 기기가 둘 다 고쳤다"는 뜻이다. 한쪽을 고르면 반드시 한쪽이
  // 사라지는데, **담은 단어를 잃는 것이 지운 단어가 되살아나는 것보다 나쁘다** — 되살아난 건
  // 다시 지우면 되지만, 사라진 건 무엇이 사라졌는지조차 모른다.
  // (평상시 동기화는 그대로 LWW 다 — 합집합은 실제로 부딪힌 이 순간에만 쓴다.)
  //
  // ⚠️ **저장 완료 표시(synced)는 서버가 2xx 로 대답했을 때만** 세운다. 예전엔 재시도 결과를
  //    `if (again)` 으로 봤는데 충돌 응답도 객체라 참이었다 — 두 번째도 충돌인데(=저장 안 됨)
  //    "저장 끝"으로 적었고, 다음 동기화가 dirty:false 를 보고 로컬을 서버 것으로 덮었다.
  async function pushBook(words, name) {
    const rev = editRevision();
    const r = await apiPutBook(words, name);
    // 성공. 다만 이 요청이 날아간 뒤에 **누가(어느 탭이든) 또 고쳤다면** 서버에 있는 건 그 편집 전 상태다.
    if (r.ok) { if (rev === editRevision()) synced(); return r; }
    // ⚠️ **계정이 바뀐 것을 기기 충돌로 오해하면 안 된다.** 둘 다 409 로 오지만 뜻이 정반대다:
    //    기기 충돌은 "같은 사람의 다른 기기가 먼저 저장했다"라 합치는 게 맞고,
    //    계정 변경은 "지금 쿠키의 주인이 다른 사람이다"라 **합치면 남의 단어장에 내 것을 섞는다.**
    //    dirty 는 그대로 둔다 — 이 단어들은 아직 원래 계정에 저장되지 않았다.
    if (r.data && r.data.accountChanged) {
      markMoved();
      toast("다른 계정으로 로그인돼 있어요. 앱을 새로고침한 뒤 다시 담아주세요.");
      return r;
    }
    if (r.kind !== "conflict") return r;   // 실패 — dirty 를 그대로 둬야 다음에 다시 올라간다
    const server = (r.data && r.data.words) || [];
    const mine = BOOK.slice();
    const merged = server.concat(mine.filter((w) => !server.includes(w)));
    replaceBook(merged);
    localStorage.setItem(NAME_KEY, name || (r.data && r.data.name) || "");
    touch();           // 합친 것도 이 기기의 편집이다 — 아직 서버에 없다
    const rev2 = editRevision();
    renderAll();
    // 버전은 apiPutBook 이 409 본문에서 이미 받아 뒀다 — 그래서 이번 저장은 통과할 수 있다.
    const again = await apiPutBook(merged, name || (r.data && r.data.name) || "");
    if (again.ok && rev2 === editRevision()) synced();
    toast(again.ok ? "다른 기기에서 담은 단어와 합쳤어요"
                   : "다른 기기 단어와 합쳤어요. 저장은 연결되면 다시 시도해요");
    return again;
  }

  // ── 이 탭이 어느 계정인지 확실한가 ──
  // 쿠키는 탭이 아니라 **브라우저 전체**가 공유한다. 그래서 다른 탭에서 계정을 바꾸면 이 탭의
  // 요청도 그 순간부터 새 계정의 쿠키로 나간다 — 이 탭은 그걸 모른 채 손에 든 앞 계정 단어장을
  // 저장하고, 그러면 남의 계정에 내 단어장이 쌓인다.
  //
  // 문지기를 둘 둔다. 서버가 `me` 를 대조하는 것이 진짜 방어이고(worker/index.js), 아래 둘은
  // 그 전에 **애초에 잘못된 요청을 안 만드는** 쪽이다:
  //   ① 서버가 누구라고 말해 준 적이 없으면(`authUid()` 가 빔) 보내지 않는다. 계정 전환 직후
  //      `GET /book` 이 오프라인·timeout·500 이면 정확히 이 상태가 되는데, 그때 보내면
  //      **틀렸는지 맞았는지 서버조차 가릴 수 없다**(대조할 값을 안 실었으므로).
  //   ② 다른 탭이 계정을 바꾼 것을 알면 그 자리에서 멈춘다.
  // 어느 쪽이든 dirty 는 그대로 남으므로 **담은 단어를 잃지 않는다** — 다음 동기화에 올라간다.
  let accountMoved = false;
  // 이 탭이 마지막으로 **서버에게 확인받은** 계정. sync() 가 대답을 받은 뒤에만 갱신한다.
  let myAccount = authUid();
  const canPush = () => !!authToken() && !!authUid() && !accountMoved;
  // 계정이 옮겨간 것을 알게 된 순간. 다시 켜는 길은 새로고침뿐이다 —
  // 이 탭의 메모리에 있는 BOOK 이 앞 계정 것이라, 여기서 조용히 이어붙이면 그게 곧 사고다.
  const markMoved = () => { accountMoved = true; clearTimeout(putTimer); };

  // 다른 탭이 로그인·로그아웃·계정 변경을 하면 localStorage 가 바뀌고 이 이벤트가 난다.
  // (같은 탭에서 난 변경에는 안 뜬다 — 그건 이 탭이 이미 아는 일이다.)
  addEventListener("storage", (e) => {
    if (e.key !== UID_KEY && e.key !== ME_KEY && e.key !== VIA_KEY) return;
    // ⚠️ 계정을 가리키는 값이 **둘**이라 둘 다 본다(`shh-me` = 서버가 말해 준 id,
    //    `shh-uid` = 마지막으로 맞춰 둔 id). 로그인은 둘을 잇달아 쓰므로 **하나만 바뀐 순간**이
    //    반드시 존재하고, storage 이벤트는 그 순간에 먼저 온다. 한쪽만 보면 그 창을 놓친다 —
    //    실브라우저에서 `shh-uid` 만 바꿔 보고 찾은 구멍이다(둘 다 바꾸는 테스트는 통과했었다).
    // 로그아웃(표시가 사라짐)도 여기 걸린다 — 다른 탭이 로그아웃했는데 이 탭이 계속 올리면 안 된다.
    const moved = (authUid() || "") !== myAccount
               || (localStorage.getItem(UID_KEY) || "") !== myAccount;
    if (authToken() && !moved) return;
    markMoved();
  });

  // 단어를 담거나 뺄 때마다 불린다(app.js 의 saveBook). 서버 저장은 몰아서 한 번.
  onBookChanged((words) => {
    touch();
    if (!canPush()) return;   // dirty 는 남는다 — 잃는 것이 아니라 미루는 것이다
    clearTimeout(putTimer);
    putTimer = setTimeout(() => queuePush(words, myName()), 800);
  });

  async function sync(firstLogin) {
    // 앞서 맞춰 둔 계정. 처음이면(빈 값) 계정이 바뀌었다고 보지 않는다 —
    // 로그인 기능이 붙기 전에 담아둔 단어장을 첫 로그인에서 살려야 하기 때문이다.
    const was = localStorage.getItem(UID_KEY) || "";
    // 손에 든 서버 버전. **읽기 전에** 확보한다 — 응답이 이 값을 갈아치우면 판정 근거가 사라진다.
    const base = bookVersion();
    // syncPlan 은 "서버 레코드 또는 null"만 안다(순수 함수라 HTTP 를 몰라야 한다).
    // 그래서 경계인 여기서 결과를 레코드로 바꾼다 — 실패는 전부 null = 오프라인 취급이고,
    // 그때 syncPlan 은 action:"none" 을 내어 **로컬을 건드리지 않는다**(가장 안전한 쪽).
    const res = await apiGetBook();
    const remote = res.ok ? res.data : null;
    // ⚠️ 계정 판정은 **서버가 누구라고 대답한 뒤에** 한다. 예전엔 요청 전에 localStorage 의 옛
    //    값끼리 비교해서, 로그인한 채로 다른 계정 로그인이 끝난 경우(탭 두 개, 또는 남의 콜백
    //    링크를 연 경우) "계정이 안 바뀌었다"로 읽고 앞 계정 단어장을 뒷 계정 서버로 올렸다.
    const nowUid = (remote && remote.me) || "";
    const accountChanged = !!was && !!nowUid && was !== nowUid;
    // 프로 여부는 **서버가 정한다.** 로컬에만 두면 폰을 바꾸는 순간 사라져서, 마스터 계정도
    // 새 기기에서는 무료 벽에 걸린다. 오프라인(remote === null)이면 손대지 않는다 —
    // 연결이 안 된다고 프로를 끄면 지하철에서 벽이 다시 선다.
    if (remote && setEntitlement(remote.pro, remote.master)) renderAll();
    const plan = syncPlan(remote, BOOK, { dirty: isDirty(), base, firstLogin, localName: myName(), accountChanged });
    if (plan.action === "none") return;   // 오프라인 — 아무것도 적지 않는다(계정 표시도)
    // 서버가 대답한 뒤에만 적는다. 오프라인에서 적어 두면 다음에 온라인으로 들어올 때
    // 계정이 안 바뀐 것으로 보여 앞 계정 단어장이 그대로 올라간다.
    setAuthUid(nowUid);
    localStorage.setItem(UID_KEY, nowUid);
    // 서버가 방금 확인해 준 계정이다. 이제부터 이 탭은 이 계정이고, storage 이벤트는
    // **이 값과 다를 때만** 경보를 울린다(우리가 방금 쓴 값에 스스로 놀라지 않게).
    myAccount = nowUid;
    // 이제부터 손에 든 서버 버전은 방금 받은 것이다. push·merge 는 이 위에 얹는다.
    setBookVersion(remote.version);
    if (plan.action === "push") {
      if (BOOK.length || myName()) await queuePush(BOOK, myName());
      else synced();   // 올릴 것이 없으면 그 자체로 서버와 같은 상태다
      return;
    }
    localStorage.setItem(NAME_KEY, plan.name);
    replaceBook(plan.words);
    renderAll();   // 별명이 바뀌었을 수 있다
    if (plan.action === "pull") synced();                  // 서버 것을 그대로 받았다
    else await queuePush(BOOK, myName());                  // merge 는 합친 결과를 서버에도 올린다
  }

  // ── 마이페이지 ──
  // 화면 전환마다 다시 그리지 않는다. 바뀌는 건 로그인 상태뿐이라 **상태가 바뀔 때만** 그린다 —
  // 그래서 app.js 의 화면 전환에 훅을 하나 더 뚫지 않아도 된다.
  // **계정 화면을 그려도 되는가.** 로그인 표시가 있고 **서버가 실제로 대답할 때만** 참이다.
  // 표시만 보고 그리면 계정 라우트가 전부 503 인 배포에서 「카카오 계정」이라고 말한다(2026-08-23).
  // ⚠️ 표시는 **지우지 않는다** — 503 은 「세션이 죽었다」가 아니라 「지금은 모른다」이고,
  //    지워 버리면 사용자가 이유 없이 로그아웃된 것으로 보인다(그 자리에서는 로그인도 503 이다).
  const accountReady = () => !!authToken() && !accountDown();
  const DOWN_MSG = "계정 기능을 점검 중이에요. 사전과 연습은 그대로 쓸 수 있어요.";
  // 점검 안내 한 줄. 계정 화면 자리마다 같은 말을 쓴다.
  const downNote = (box) => {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = DOWN_MSG;
    box.appendChild(p);
  };

  const subText = () => {
    if (!accountReady()) return "";
    return myName() ? `${myName()}님 · ${NAMES[authVia()] || ""} 계정` : (NAMES[authVia()] || "") + " 계정";
  };
  onMyPageSub(subText);

  // 목록 한 줄. 왼쪽 이름, 오른쪽 값(또는 화살표). 설정 화면이 전부 이걸로 되어 있다.
  function row(box, label, value, fn, cls = "") {
    const el = document.createElement(fn ? "button" : "div");
    el.className = "list-row " + cls;
    if (fn) { el.type = "button"; el.addEventListener("click", fn); }
    const l = document.createElement("span"); l.className = "l"; l.textContent = label;
    const v = document.createElement("span"); v.className = "v"; v.textContent = value || "";
    el.append(l, v);
    box.appendChild(el);
    return el;
  }

  // ── 마이 ── 맨 위가 지금 쓰는 플랜. 여기서 제일 궁금한 건 "내가 뭘 쓸 수 있나"라서.
  function renderMyPage() {
    const box = document.getElementById("mypage");
    box.innerHTML = "";

    if (!accountReady()) {
      // 계정 기능이 닫혀 있으면 **왜 안 되는지**를 먼저 말한다. 로그인 표시가 남아 있어도
      // 「계정」 행·별명·제공자 이름을 그리지 않는다 — 그게 거짓말이 되는 자리다.
      if (authToken()) { downNote(box); return; }
      // 안내 문단은 뺐다 — 게이트에서 이미 본 말을 여기서 또 읽게 된다. 버튼만 둔다.
      loginButtons(box, "btn-primary");
      return;
    }

    // ⚠️ 베타에는 무료 벽이 없다(app.js 의 BETA_NO_WALL). 그래서 이 블록도 **자리 수를 세지 않고**
    //    「프로 알아보기 (₩4,900/월)」 버튼을 그리지 않는다 — 팔 물건이 없는데 값을 부르면
    //    누른 사람이 "결제는 앱 버전에서 열려요"라는 막다른 길에 닿는다.
    //    벽을 되살리는 날 BETA_NO_WALL 을 끄면 아래 갈래가 그대로 돌아온다.
    const plan = document.createElement("div");
    plan.className = "plan" + (isPro ? " pro" : "");
    if (BETA_NO_WALL) {
      plan.innerHTML = `<div class="k">현재 플랜</div><div class="n">베타</div>`
        + `<div class="d">지금은 단어를 제한 없이 담을 수 있어요</div>`;
      box.appendChild(plan);
    } else {
      const used = bookCost(), free = isPro ? "" : ` · 손짓 ${used}/${FREE_LIMIT}`;
      // 마스터와 프로를 갈라 말한다 — 만든 사람이 화면만 보고 "지금 무엇으로 열려 있나"를 알아야
      // 벽 문구를 고칠 때 자기 기기에서 확인이 되는지 안 되는지 헷갈리지 않는다.
      const desc = isMaster ? "" : isPro ? "단어장을 무제한으로 담을 수 있어요"
        : `무료로 손짓 ${FREE_LIMIT}개까지 담을 수 있어요`;
      plan.innerHTML = `<div class="k">현재 플랜</div>`
        + `<div class="n">${isMaster ? "마스터" : isPro ? "프로" : "무료"}${free}</div>`
        + (desc ? `<div class="d">${desc}</div>` : "");
      box.appendChild(plan);
      if (!isPro && PRO_PRICE) {
        const up = document.createElement("button");
        up.className = "btn-primary"; up.type = "button";
        up.textContent = `프로 알아보기 (${PRO_PRICE})`;
        up.addEventListener("click", () => GO("settings"));
        box.appendChild(up);
      }
    }

    const list = document.createElement("div");
    list.className = "list";
    row(list, "우리 단어장", `${BOOK.length}개`, () => GO("book"));
    row(list, "계정", NAMES[authVia()] || "", () => GO("settings"));
    box.appendChild(list);
  }

  // ── 설정 ── 위에 내 계정, 아래로 목록, 맨 끝에 로그아웃.
  function renderSettings() {
    const box = document.getElementById("settings");
    box.innerHTML = "";
    if (!accountReady()) {
      if (authToken()) { downNote(box); return; }
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "로그인하면 계정 설정이 열려요.";
      box.appendChild(p);
      loginButtons(box, "btn-primary");
      return;
    }

    // 프로필. 별명은 여기서 바로 고친다 — "관리"를 한 번 더 누르게 할 만큼 깊은 설정이 아니다.
    const prof = document.createElement("div");
    prof.className = "profile";
    prof.innerHTML = `<svg class="mascot" viewBox="0 0 100 100" aria-hidden="true"><use href="#mascot"/></svg>`;
    const col = document.createElement("div");
    col.className = "profile-col";
    nameField(col);
    const sub = document.createElement("div");
    sub.className = "profile-sub";
    sub.textContent = `${NAMES[authVia()] || ""} 계정으로 로그인됨`;
    col.appendChild(sub);
    prof.appendChild(col);
    box.appendChild(prof);

    const list = document.createElement("div");
    list.className = "list";
    // 계정을 지우는 자리는 **계정 화면 안**이다. 설정 목록에 '계정과 단어장 삭제'를 나란히 두면
    // 두 가지(계정 연결 · 담은 단어)를 한 번에 지우면서 어느 쪽을 지우는지 고를 수가 없었다.
    row(list, "계정", NAMES[authVia()] || "", () => GO("account"));
    // 결제는 아직 없다. 자리를 만들어 두되 **되는 척하지 않는다** — 누르면 왜 아직인지 말한다.
    row(list, "결제 및 구독", "준비 중", () => requestPro());
    row(list, "수어 문법 안내문", "다시 보기", () => {
      localStorage.removeItem("shh-intro-muted");
      location.reload();
    });
    row(list, "개인정보처리방침", "", () => { location.href = "privacy.html"; });
    box.appendChild(list);

    const out = document.createElement("button");
    out.className = "btn-ghost logout"; out.type = "button"; out.textContent = "로그아웃";
    out.addEventListener("click", async () => {
      // 서버에 **먼저** 알린다. 표시를 지운 뒤에 부르면 request 가 표시가 없다고 그냥 돌아가서
      // D1 의 세션이 180일을 더 산다.
      //
      // ⚠️ **서버가 끊었다고 대답해야만 로그아웃한다.** 예전엔 결과를 안 보고 무조건 화면을
      //    정리해서, 오프라인이나 500 일 때 "화면은 로그아웃, 서버는 로그인"이 남았다.
      //    이 앱의 세션은 계정 단위라 그 상태에서는 **다른 기기도 계속 열려 있다** —
      //    폰을 빌려준 사람이 로그아웃했다고 믿는 순간이 가장 위험한 자리다.
      const r = await apiLogout();
      // 401 = 세션이 이미 죽어 있었다. 사용자가 원한 결과가 이미 이뤄진 것이고,
      // request 가 로컬 정리와 안내까지 끝냈다. 여기서 또 말하지 않는다.
      if (r.status === 401) return;
      if (!r.ok) {
        toast(r.kind === "network"
          ? "연결이 안 돼요. 인터넷에 연결된 뒤 다시 눌러주세요"
          : "로그아웃하지 못했어요. 잠시 뒤 다시 눌러주세요");
        return;
      }
      // 로컬 단어장은 남긴다. 로그아웃은 "이 기기에서 그만 보기"지 "지우기"가 아니다.
      // 다만 **마스터·프로는 끈다** — 계정에 달린 값이라 계정을 놓으면 같이 놓아야 한다.
      // 안 끄면 로그아웃한 기기가 계속 마스터로 보이고, 다음 사람이 그대로 물려받는다.
      setEntitlement(false, false);
      setAuth(null); renderAll(); GO("me"); toast("로그아웃했어요");
    });
    box.appendChild(out);

    // 세션이 계정 단위라 로그아웃은 **모든 기기**에 듣는다. 노트북에서 눌렀는데 폰까지
    // 풀리는 건 예상 밖이라 한 줄로 알린다 — 확인 대화상자를 세우지 않은 이유는
    // 누르는 흐름을 막지 않기 위해서다(8/8 「읽을 것을 줄인다」와 저울질한 결과).
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "다른 기기에서도 로그인이 풀려요.";
    box.appendChild(note);
  }

  // ── 계정 ── 설정 → 계정으로 들어온다. 여기서 하는 일은 하나: 계정을 지우는 것.
  function renderAccount() {
    const box = document.getElementById("account");
    box.innerHTML = "";
    // 로그아웃 상태면 비워만 둔다. **여기서 GO 를 부르면 안 된다** — renderAll 은 앱이 뜰 때도
    // 도는데, 그때 화면을 옮기면 링크로 들어온 사람이 마이 탭으로 튕긴다.
    if (!accountReady()) { if (authToken()) downNote(box); return; }

    const list = document.createElement("div");
    list.className = "list";
    row(list, "로그인 방법", NAMES[authVia()] || "");
    box.appendChild(list);

    const p = document.createElement("p");
    p.className = "hint";
    // 두 가지를 모두 말해야 한다. ① 이제 **모든 기기에서** 풀린다(세션이 계정 단위라).
    // ② 이 기기 단어장은 남지만 **다른 계정으로 로그인하면 그 계정 것으로 바뀐다** —
    //    계정이 바뀌면 병합하지 않기로 했으므로(syncPlan 의 accountChanged) "그대로 남는다"는
    //    이제 조건부다. 조건을 안 적으면 화면이 거짓말한다.
    p.innerHTML = "계정을 지우면 <b>서버에 저장된 단어장도 함께</b> 지워지고 <b>모든 기기에서</b> 로그인이 풀려요.<br>"
      + "이 폰에 담아둔 단어는 남지만, 다른 계정으로 로그인하면 그 계정 단어장으로 바뀝니다.";
    box.appendChild(p);

    const del = document.createElement("button");
    del.className = "btn-ghost logout danger"; del.type = "button"; del.textContent = "계정 삭제";
    del.addEventListener("click", async () => {
      if (!confirm("계정 연결을 끊고 서버에 저장된 단어장을 지워요. 모든 기기에서 로그인이 풀립니다.\n"
        + "이 폰의 단어장은 남지만, 다른 계정으로 로그인하면 바뀝니다.\n계속할까요?")) return;
      // ⚠️ **서버가 지웠다고 대답해야만 지웠다고 말한다.** 예전엔 결과를 안 보고 무조건
      //    "계정을 지웠어요"를 띄웠다 — 500 이 나도 그랬고, 그때 단어장·별명·친구 관계는
      //    서버에 그대로 남아 있었다. privacy.html 이 "그 자리에서 지워진다"고 약속하는
      //    바로 그 자리라, 화면이 거짓말하면 방침도 같이 거짓이 된다.
      const r = await apiDeleteAccount();
      if (!r.ok) {
        toast(r.status === 401 ? "로그인이 풀렸어요. 다시 로그인한 뒤 지워주세요"
          : r.kind === "network" ? "연결이 안 돼요. 인터넷에 연결된 뒤 다시 눌러주세요"
          : "계정을 지우지 못했어요. 잠시 뒤 다시 시도해 주세요");
        return;
      }
      setAuth(null); renderAll(); GO("me"); toast("계정을 지웠어요");
    });
    box.appendChild(del);
  }

  const renderAll = () => { renderMyPage(); renderSettings(); renderAccount(); };

  // 세션이 죽은 걸 알게 된 순간(401) 화면을 되돌린다. 전에는 토큰만 지워서, 다른 기기에서
  // 로그아웃해도 이 기기는 계속 로그인한 것처럼 보였다 — 담기를 눌러야 안 되는 걸 알았다.
  //
  // ponytail: **즉시는 아니다.** 서버와 한 번 이야기해야 알 수 있으므로 앱을 다시 열거나
  //   단어를 담을 때 반영된다. 즉시 하려면 푸시가 필요한데 PWA 에는 아직 안 붙였다(5b 자리).
  onAuthLost(() => {
    setEntitlement(false, false);   // 마스터·프로는 계정에 달린 값이라 계정을 놓으면 같이 놓는다
    renderAll();
    toast("로그아웃됐어요. 다시 로그인해 주세요.");
  });

  // 별명 한 칸. **제공자에게 이름을 받지 않고 사용자가 직접 짓는다** — 아무 말이나 쓸 수 있으니
  // 신원 정보가 아니고, 그래서 카카오 비즈앱 전환도 구글 범위 확대도 필요 없다.
  // 계정에 붙여 저장하므로 폰을 바꿔도 따라온다(그게 별명을 서버에 두는 유일한 이유다).
  function nameField(box) {
    const wrap = document.createElement("div");
    wrap.className = "search name-field";
    const input = document.createElement("input");
    input.type = "text"; input.id = "nickname"; input.maxLength = 20;
    input.placeholder = "별명 (선택)";
    input.value = myName();
    input.setAttribute("aria-label", "내 별명");
    wrap.appendChild(input);
    box.appendChild(wrap);

    const save = () => {
      const v = input.value.trim().slice(0, 20);
      if (v === myName()) return;
      localStorage.setItem(NAME_KEY, v);
      // 별명은 단어장과 같은 레코드라 시각도 같이 올린다 — 안 올리면 다음 동기화에서
      // 서버가 더 새것으로 판정돼 방금 지은 별명이 되돌아간다.
      touch();
      queuePush(BOOK, v);
      // 화면을 다시 그리지 않는다. 지금 이 입력칸을 부수는 짓이고, 목록엔 별명이 안 쓰인다.
      // 바뀌는 건 헤더 부제 한 줄뿐이라 그것만 갈아끼운다.
      const el = document.getElementById("screen-sub");
      if (el) el.textContent = subText();
      toast(v ? `${v}님으로 부를게요` : "별명을 지웠어요");
    };
    // change 는 포커스가 빠질 때 한 번만 난다 — 글자마다 서버를 때리지 않는다.
    input.addEventListener("change", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  }

  // 서버가 실제로 로그인시킬 수 있는 제공자. null = **아직 물어보지 못했다**(연결 실패 포함).
  let PROVIDERS = null;
  // **가입은 로그인과 따로 준비된다.** 가입 전용 키(SIGNUP_STATE_KEY·TOMBSTONE_KEY)가 빠지면
  // 서버는 로그인은 시켜 주고 `/signup/start` 만 503 을 낸다. 그 상태를 화면이 모르면
  // 「가입하기」 버튼을 그려 놓고 누른 사람에게만 실패를 보여준다 — 기다리게 하고 실패시키는 꼴이다.
  // null = 아직 못 물어봤다 · false = 서버가 지금은 가입을 못 받는다 · true = 받는다.
  let SIGNUP_READY = null;
  // 사람 확인 위젯의 **공개** site key(2026-08-22 · 결정 3). null = 서버가 안 줬다 = 위젯을
  // 그릴 수 없다 = 가입을 시작해 봐야 서버가 400 이다. 그 상태는 SIGNUP_READY 가 false 로 온다.
  let TURNSTILE_KEY = null;
  // 방금 가입한 사람과 다시 온 사람에게 다른 말을 하기 위해서만 쓴다. 자격증명이 아니다.
  let JUST_SIGNED_UP = false;
  // ⚠️ **돌아온 자리에서 이미 화면을 정했으면 게이트가 그 위를 덮지 않는다.**
  //    돌아온 해시가 `signup_required` 면 그 자리에서 가입 화면을 여는데, 그 뒤 onAppReady 의
  //    기본 게이트가 같은 상자를 다시 그려서 **방금 띄운 안내가 통째로 사라졌다.**
  //    (실측: scripts/test-client.mjs 「가입 안 된 사람에게 가입 화면을 안 띄운다」)
  let GATE_TAKEN = false;

  // 로그인 버튼. 마이페이지와 게이트가 **같은 함수**를 쓴다 — 둘이 갈라지면
  // 한쪽에만 제공자를 추가하는 실수가 난다.
  //
  // ⚠️ **비밀값이 안 들어간 제공자는 그리지 않는다.** 예전엔 셋을 늘 그렸고, 서버에 키가 없으면
  //    누른 뒤에야 503 을 봤다 — 화면이 "된다"고 말하고 서버가 "안 된다"고 하는 상태다.
  //
  // ⚠️ **서버에 못 물어봤을 때도 그리지 않는다(fail-closed).** 예전에는 그 경우 오히려 셋 다
  //    그렸다 — "아직 모르니 아무것도 숨기지 말자"는 뜻이었는데, 실제로 사용자가 얻는 것은
  //    눌러도 503 만 나는 버튼 세 개였다. 모를 때는 되는 척하지 않는 쪽이 맞다.
  //
  // 문구를 두 갈래로 가른다. **원인이 다르면 사용자가 할 일도 다르다** — 연결 문제는
  // 다시 시도할 일이고, 제공자 미설정은 기다릴 일이라 같은 말을 하면 헛수고를 시킨다.
  // 어느 쪽이든 **사전과 연습은 그대로 열려 있다**는 말을 반드시 붙인다(로그인만 닫는 것이다).
  function loginButtons(box, cls) {
    // 순서는 **우리가 정한다**(서버 응답 순서에 화면 순서를 맡기지 않는다).
    const list = ["kakao", "naver", "google"].filter((k) => (PROVIDERS || []).includes(k));
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = PROVIDERS === null
        ? "지금은 서버에 연결할 수 없어 로그인을 시작할 수 없어요. 연결된 뒤 앱을 다시 열어주세요. 사전과 연습은 그대로 쓸 수 있어요."
        : "지금은 로그인을 준비 중이에요. 로그인 없이도 사전과 연습은 그대로 쓸 수 있어요.";
      box.appendChild(p);
      return;
    }
    for (const k of list) {
      const b = document.createElement("button");
      b.type = "button"; b.className = cls + " login-" + k;
      b.textContent = NAMES[k] + "로 로그인";
      b.addEventListener("click", () => {
        // 링크(#w=)로 들어온 사람이 로그인하러 가면 해시가 날아간다. 맡아 뒀다 돌아와서 되돌린다.
        if (location.hash) localStorage.setItem(BACK_KEY, location.hash);
        location.href = loginUrl(k);
      });
      box.appendChild(b);
    }
  }

  // ── 로그인 게이트 ──
  // 로그인이 기본이되 **둘러보기는 막지 않는다**: 수어를 알리는 게 앱의 목적이라
  // 문 앞에서 돌려보내면 목적을 스스로 깎는다. 대신 단어장에 담는 순간 로그인을 요구한다.
  //
  // ⚠️ **길이 셋이다**(2026-08-18). 예전에는 「로그인」 하나였고 그 버튼이 곧 가입이었다 —
  //    누르면 약관도 연령 확인도 없이 계정이 만들어졌다. 이제 가입은 자기 화면을 가진다.
  //
  // ⚠️ **여기에 방침·약관 링크가 있어야 한다.** 전에는 게이트가 화면을 완전히 덮는데
  //    (css/style.css 의 `.gate-backdrop`) 링크는 그 아래 푸터에만 있어서,
  //    "로그인하면 동의한 것으로 본다"고 적어 놓고 **동의한다는 그 순간 문서에 닿을 수 없었다.**
  function policyLinks(box) {
    const p = document.createElement("p");
    p.className = "hint gate-docs";
    const a1 = document.createElement("a");
    a1.href = "privacy.html"; a1.textContent = "개인정보처리방침";
    const sep = document.createElement("span");
    sep.textContent = " · ";
    const a2 = document.createElement("a");
    a2.href = "policies/"; a2.textContent = "이용약관";
    p.append(a1, sep, a2);
    box.appendChild(p);
    return p;
  }

  function gateBox() {
    const box = document.getElementById("gate");
    const intro = document.getElementById("intro");
    const introWasOpen = intro && !intro.hidden;
    if (intro) intro.hidden = true;
    box.innerHTML = "";
    return { box, intro, introWasOpen };
  }

  function gateCard(box, title) {
    const card = document.createElement("section");
    card.className = "intro gate";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.innerHTML = `<svg class="mascot sm" viewBox="0 0 100 100" aria-hidden="true"><use href="#mascot"/></svg>
      <div class="intro-h"><b>${title}</b></div>`;
    box.appendChild(card);
    const foot = document.createElement("div");
    foot.className = "intro-foot";
    card.appendChild(foot);
    return foot;
  }

  function peekButton(foot, intro, introWasOpen, box, label) {
    const peek = document.createElement("button");
    peek.type = "button"; peek.className = "btn-ghost";
    peek.textContent = label || (localStorage.getItem(PEEK_KEY) ? "닫기" : "로그인 없이 둘러보기");
    peek.addEventListener("click", () => {
      localStorage.setItem(PEEK_KEY, "1");
      box.hidden = true;
      if (introWasOpen && intro) intro.hidden = false;
    });
    foot.appendChild(peek);
    return peek;
  }

  function openGate(reason) {
    const { box, intro, introWasOpen } = gateBox();
    const foot = gateCard(box, reason || "쉿! 우리만 알 수 있는<br>언어로 얘기해요");

    const join = document.createElement("button");
    join.type = "button"; join.className = "btn-primary";
    join.textContent = "가입하기";
    join.addEventListener("click", () => openSignup());
    foot.appendChild(join);

    const login = document.createElement("button");
    login.type = "button"; login.className = "btn-ghost";
    login.textContent = "이미 계정이 있어요 — 로그인";
    login.addEventListener("click", () => openLogin());
    foot.appendChild(login);

    peekButton(foot, intro, introWasOpen, box);
    policyLinks(foot);
    box.hidden = false;
  }

  // 기존 사용자용. **여기서는 계정이 만들어지지 않는다** — 서버가 계정이 없으면
  // `signup_required` 로 돌려보내고, 그때 이 화면이 가입 화면을 연다.
  function openLogin() {
    const { box, intro, introWasOpen } = gateBox();
    const foot = gateCard(box, "다시 오셨네요<br>어떻게 로그인하시겠어요?");
    loginButtons(foot, "btn-primary");
    const back = document.createElement("button");
    back.type = "button"; back.className = "btn-ghost";
    back.textContent = "처음 오셨나요? 가입하기";
    back.addEventListener("click", () => openSignup());
    foot.appendChild(back);
    peekButton(foot, intro, introWasOpen, box);
    policyLinks(foot);
    box.hidden = false;
  }

  // ── 회원가입 화면 ──
  // 비동기 화면이라 **네 가지 상태를 전부 가진다**: loading · error(+재시도) · ready · 진행 중.
  // 무한 spinner 와 영구 disabled 버튼을 만들지 않는다 — 친구 목록이 겪은 그 증상이다.
  let SIGNUP_BUSY = false;
  async function openSignup(notice) {
    const { box, intro, introWasOpen } = gateBox();
    const foot = gateCard(box, "shhh! 시작하기");
    box.hidden = false;

    let noticeEl = null;
    if (notice) {
      noticeEl = document.createElement("p");
      noticeEl.className = "hint"; noticeEl.textContent = notice;
      foot.appendChild(noticeEl);
    }
    const status = document.createElement("p");
    status.className = "hint";
    status.textContent = "약관을 불러오고 있어요…";
    foot.appendChild(status);
    peekButton(foot, intro, introWasOpen, box, "나중에 할게요");
    policyLinks(foot);

    // ⓪ **되지 않는 버튼을 그리지 않는다.** 서버가 「지금 가입은 못 받는다」고 이미 말했으면
    //    약관을 받아 오지도 않고 여기서 끝낸다 — 체크박스를 다 채운 뒤 마지막 버튼에서
    //    503 을 만나는 것이 사용자에게 가장 나쁜 순서다. 기존 사용자는 로그인이 되므로 길을 준다.
    //    ⚠️ null(못 물어봄)은 여기서 막지 않는다 — 아래 제공자 목록이 "연결할 수 없어요"로 답한다.
    if (SIGNUP_READY === false) {
      status.textContent = "지금은 새로 가입할 수 없어요. 준비가 끝나면 열릴 거예요. "
        + "로그인 없이도 사전과 연습은 그대로 쓸 수 있어요.";
      const go = document.createElement("button");
      go.type = "button"; go.className = "btn-ghost";
      go.textContent = "이미 계정이 있어요 — 로그인";
      go.addEventListener("click", () => openLogin());
      status.parentNode.insertBefore(go, status.nextSibling);
      return;
    }

    // ① 서버가 말하는 현재 번들
    const b = await apiPolicies();
    if (!b.ok) return signupFailed(status, b.kind, notice);
    // ② **우리가 실제로 렌더할 바이트**를 받아 직접 해시해 서버 값과 대조한다.
    //    다르면 가입 버튼을 그리지 않는다 — 화면이 옛 문서를 보여주면서 서버가 새 해시를
    //    기록하는 상태를 만들지 않는다.
    const summary = await fetchPolicyDoc(b.docs.summary && b.docs.summary.path, b.docs.summary && b.docs.summary.hash);
    const age14 = await fetchPolicyDoc(b.docs.age14 && b.docs.age14.path, b.docs.age14 && b.docs.age14.hash);
    if (!summary.ok) return signupFailed(status, summary.kind, notice);
    if (!age14.ok) return signupFailed(status, age14.kind, notice);

    status.remove();
    const form = document.createElement("div");
    form.className = "signup";
    foot.insertBefore(form, foot.firstChild);
    // ⚠️ **왜 안내를 다시 옮기나.** 안내는 약관을 받기 전에 붙었는데, 그 뒤 약관 본문이
    //    `foot.firstChild` 앞에 들어가면서 안내가 **화면 맨 아래로 밀려났다**(실측: 974자짜리
    //    화면의 918번째 글자). 사용자는 「왜 이 화면이 떴는지」를 못 읽고 긴 약관부터 만난다.
    if (noticeEl) foot.insertBefore(noticeEl, form);

    const sum = document.createElement("pre");
    sum.className = "signup-summary";
    sum.textContent = summary.text;
    form.appendChild(sum);

    const docs = document.createElement("p");
    docs.className = "hint";
    const tLink = document.createElement("a");
    tLink.href = b.docs.terms.path; tLink.target = "_blank"; tLink.rel = "noopener";
    tLink.textContent = "이용약관 전문";
    const pLink = document.createElement("a");
    pLink.href = b.docs.privacy.path; pLink.target = "_blank"; pLink.rel = "noopener";
    pLink.textContent = "개인정보처리방침 전문";
    const dot = document.createElement("span"); dot.textContent = " · ";
    docs.append(tLink, dot, pLink);
    form.appendChild(docs);

    // 체크박스는 **둘뿐이다.** 「개인정보 수집·이용 동의」를 만들지 않는다 —
    // 처리 근거가 동의가 아니라 계약의 이행이라, 받지 않은 동의를 받은 척하면 기록이 거짓이 된다.
    // 「전체 동의」 단일 체크박스도 두지 않는다.
    const mk = (id, label) => {
      const row = document.createElement("label");
      row.className = "signup-check";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.id = id;
      const sp = document.createElement("span");
      sp.textContent = label;
      row.append(cb, sp);
      form.appendChild(row);
      return cb;
    };
    const cbTerms = mk("su-terms", "(필수) 이용약관에 동의합니다");
    const cbAge = mk("su-age", "(필수) 만 14세 이상입니다");

    const ageNote = document.createElement("pre");
    ageNote.className = "signup-summary sm";
    ageNote.textContent = age14.text;
    form.appendChild(ageNote);

    const why = document.createElement("p");
    why.className = "hint";
    why.textContent = "두 항목을 확인하셔야 가입할 수 있어요.";
    form.appendChild(why);

    const buttons = document.createElement("div");
    buttons.className = "signup-providers";
    form.appendChild(buttons);

    const list = ["kakao", "naver", "google"].filter((k) => (PROVIDERS || []).includes(k));
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "hint";
      // 서버에 못 물어봤을 때와 제공자가 없을 때를 가른다 — 사용자가 할 일이 다르다.
      p.textContent = PROVIDERS === null
        ? "지금은 서버에 연결할 수 없어 가입을 시작할 수 없어요. 연결된 뒤 다시 열어주세요. 사전과 연습은 그대로 쓸 수 있어요."
        : "지금은 가입을 준비 중이에요. 로그인 없이도 사전과 연습은 그대로 쓸 수 있어요.";
      buttons.appendChild(p);
      return;
    }
    // 사람 확인 자리. **버튼 위**에 둔다 — 다 채우고 마지막에 막히는 순서를 만들지 않는다.
    // ⚠️ 토큰은 **1회용**이다(공식 문서: 300초·재사용은 `timeout-or-duplicate`). 그래서
    //    한 번 보낸 뒤에는 반드시 버리고 위젯을 다시 풀게 한다 — 안 그러면 사용자는 같은
    //    토큰으로 계속 눌러 원인 없는 실패를 반복한다(실제로 그랬다).
    const hv = { token: null };
    const hvBox = document.createElement("div");
    hvBox.className = "signup-human";
    buttons.parentNode.insertBefore(hvBox, buttons);
    const hvNote = document.createElement("p");
    hvNote.className = "hint";
    buttons.parentNode.insertBefore(hvNote, buttons);

    const btns = list.map((k) => {
      const el = document.createElement("button");
      el.type = "button"; el.className = "btn-primary login-" + k;
      el.textContent = NAMES[k] + "로 가입하기";
      el.addEventListener("click", () => startSignup(k, el, why, b.pv, cbTerms, cbAge, hv));
      buttons.appendChild(el);
      return el;
    });
    const sync = () => {
      const ok = cbTerms.checked && cbAge.checked && !!hv.token;
      for (const el of btns) { el.disabled = !ok || SIGNUP_BUSY; }
      why.textContent = ok ? "가입할 방법을 골라주세요."
        : !cbTerms.checked || !cbAge.checked ? "두 항목을 확인하셔야 가입할 수 있어요."
        : "사람 확인을 마쳐야 가입할 수 있어요.";
    };
    cbTerms.addEventListener("change", sync);
    cbAge.addEventListener("change", sync);
    // 보낸 토큰을 버리고 위젯을 처음 상태로 되돌린다. **화면이 아직 남아 있을 때만** 부른다
    // (성공하면 제공자로 이동하므로 되돌릴 화면이 없다).
    hv.spend = () => { hv.token = null; resetTurnstile(); sync(); };
    sync();
    // ⚠️ **위젯이 안 뜨면 그 사실을 말한다.** 조용히 두면 사용자는 체크를 다 하고도 버튼이
    //    회색인 이유를 모른다 — 화면에 이유가 없으면 그건 고장이다.
    renderTurnstile(hvBox, (tok) => { hv.token = tok || null; sync(); }).then((drawn) => {
      hvNote.textContent = drawn
        ? "가입 전에 사람 확인을 한 번 거쳐요."
        : "사람 확인을 불러오지 못했어요. 연결을 확인하고 새로고침해 주세요.";
    });
  }

  // 실패해도 **끝이 있는 화면**을 준다. 재시도 버튼이 없으면 사용자가 할 수 있는 일이 없다.
  function signupFailed(status, kind, notice) {
    status.textContent = kind === "timeout" || kind === "network"
      ? "연결이 안 돼요. 인터넷을 확인하고 다시 시도해 주세요."
      : kind === "hash_mismatch"
        ? "앱이 옛 약관을 들고 있어요. 새로고침한 뒤 다시 시도해 주세요."
        : kind === "no_crypto"
          ? "이 환경에서는 약관을 확인할 수 없어 가입을 진행하지 않아요. https 주소로 열어주세요."
          : "약관을 불러오지 못했어요. 잠시 뒤에 다시 시도해 주세요.";
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "btn-ghost";
    retry.textContent = "다시 시도";
    retry.addEventListener("click", () => openSignup(notice));
    status.parentNode.insertBefore(retry, status.nextSibling);
  }

  // ── 사람 확인 위젯 (2026-08-22 · 사용자 결정 3) ─────────────────────────
  // ⚠️ **외부 스크립트다.** `_headers` 의 CSP 에 `challenges.cloudflare.com` 을 script-src·
  //    frame-src 로 열어 뒀다. 실패하면 **조용히 넘어가지 않는다** — 토큰 없이 가입을 시작하면
  //    서버가 400 을 내고, 사용자는 이유를 모른 채 버튼만 다시 누른다.
  // ⚠️ 가입 화면을 **열 때만** 부른다. 앱을 켜자마자 받으면 가입할 생각이 없는 사람에게도
  //    외부 요청이 나간다(그 자체가 privacy.html 이 설명해야 할 사실이 된다).
  let turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(true);
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise((done) => {
      const el = document.createElement("script");
      el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      el.async = true;
      el.addEventListener("load", () => done(!!window.turnstile));
      el.addEventListener("error", () => { turnstileLoading = null; done(false); });
      document.head.appendChild(el);
    });
    return turnstileLoading;
  }

  // 위젯 하나를 그리고 **토큰이 오면** onToken 을 부른다. 반환값은 「그렸나」다.
  //
  // ⚠️ **위젯 id 를 보관한다.** 없으면 `turnstile.reset()` 을 부를 수 없어, 한 번 쓴 토큰이
  //    화면에 그대로 남는다 — 사용자는 같은 값을 계속 보내고 서버는 계속 거절한다.
  // ⚠️ `action` 을 실어 보낸다. 서버가 그 값을 대조하므로(worker/index.js 의 TURNSTILE_ACTION),
  //    다른 자리에 붙인 위젯의 토큰을 가입에 재사용하는 길이 닫힌다. **두 값은 같아야 한다.**
  let HV_WIDGET = null;
  const TURNSTILE_ACTION = "signup";
  async function renderTurnstile(box, onToken) {
    if (!TURNSTILE_KEY) return false;
    if (!(await loadTurnstile())) return false;
    try {
      HV_WIDGET = window.turnstile.render(box, {
        sitekey: TURNSTILE_KEY,
        action: TURNSTILE_ACTION,
        callback: (token) => onToken(token),
        // 만료·오류는 **토큰을 지운다.** 남겨 두면 이미 쓴 토큰으로 다시 시도하게 되고
        // 서버는 `timeout-or-duplicate` 로 거절한다 — 사용자에게는 원인 없는 실패로 보인다.
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
      return HV_WIDGET !== undefined && HV_WIDGET !== null;
    } catch { HV_WIDGET = null; return false; }
  }

  // 위젯을 처음 상태로. 실패해도 삼킨다 — 되돌리기가 안 되는 것보다 화면이 멈추는 쪽이 나쁘다.
  function resetTurnstile() {
    if (HV_WIDGET === null || !window.turnstile || !window.turnstile.reset) return;
    try { window.turnstile.reset(HV_WIDGET); } catch { /* 위젯이 이미 사라진 화면 */ }
  }

  async function startSignup(provider, btn, why, pv, cbTerms, cbAge, hv) {
    if (SIGNUP_BUSY) return;                 // 두 번 눌러도 왕복이 둘로 갈라지지 않는다
    SIGNUP_BUSY = true;
    btn.disabled = true;
    why.textContent = "가입을 시작하고 있어요…";
    if (location.hash) localStorage.setItem(BACK_KEY, location.hash);
    const r = await apiSignupStart(provider, {
      terms: !!(cbTerms && cbTerms.checked), age14: !!(cbAge && cbAge.checked), pv,
      turnstile: hv ? hv.token : null,
    });
    if (r.ok) { location.href = r.url; return; }
    SIGNUP_BUSY = false;
    // ⚠️ **보낸 토큰은 성공·실패와 무관하게 죽은 값이다.** 여기서 버리고 위젯을 다시 풀게
    //    하지 않으면, 사용자가 같은 토큰으로 다시 눌러 `timeout-or-duplicate` 로 또 막힌다 —
    //    화면에는 아무 이유도 안 보이는 무한 반복이 된다.
    //    `hv.spend()` 안의 `sync()` 가 버튼을 다시 잠그므로 아래에서 되살리지 않는다.
    if (hv && hv.spend) hv.spend(); else btn.disabled = false;
    why.textContent = r.kind === "policy_stale"
      ? "약관이 새로 바뀌었어요. 새로고침한 뒤 다시 시도해 주세요."
      // 사람 확인은 **다시 풀어야** 한다. 토큰은 1회용이라 같은 값으로 다시 보내면 또 막힌다.
      : r.kind === "human_check"
        ? "사람 확인을 다시 해주세요."
      : r.kind === "rate_limited"
        ? "잠시 뒤에 다시 시도해 주세요."
        : r.kind === "timeout" || r.kind === "network"
          ? "연결이 안 돼요. 인터넷을 확인하고 다시 시도해 주세요."
          : (r.message || "가입을 시작하지 못했어요. 다시 시도해 주세요.");
  }

  // 담기를 막는 자리. 둘러보기 중이어도 사전·연습은 그대로 쓸 수 있다.
  onSaveGuard(() => {
    if (authToken()) return true;
    openGate("담은 단어를 지키려면<br>로그인이 필요해요");
    return false;
  });

  // 로그인하고 돌아온 자리. 서버가 `#login=ok&via=<제공자>&n=<nonce>` 로 되돌려보낸다.
  //
  // ⚠️ **토큰은 해시에 없다.** 서버가 HttpOnly 쿠키로 심었다 — 앱이 손에 쥐지 않으므로
  //    "남에게 보낼 수 있는 로그인 링크" 라는 것 자체가 만들어지지 않는다(세션 고정이 원천 봉쇄).
  //    서버도 이제 **로그인 왕복 표**(shh_t 쿠키)로 이 브라우저가 시작한 왕복인지 확인한다 —
  //    그게 진짜 방어이고, 아래 n 대조는 그 뒤에 오는 심층 방어다.
  //
  // ⚠️ n 이 안 맞으면 **서버에도 알려 세션을 끊는다.** 전에는 안내 문구만 띄우고 말았는데,
  //    그 시점에 쿠키는 이미 심어져 있어서 화면은 로그아웃인데 서버는 로그인인 상태가 남았다.
  //    그 상태로 다음 동기화가 돌면 이 기기의 단어장이 **남의 계정으로** 올라간다.
  //    아래 takeCodeQuery 에는 이 처리가 있었는데 여기만 빠져 있었다 — 두 갈래가 같아야 한다.
  async function takeLoginHash() {
    const m = location.hash.match(/[#&]login=([^&]+)/);
    if (!m) return false;
    const via = (location.hash.match(/[#&]via=(\w+)/) || [])[1];
    // safeDecode(app.js) — 반쪽 인코딩(`#login=ok&n=%E0%A4%A`)이면 decodeURIComponent 가 던진다.
    // 여기서 던지면 onAppReady 전체가 멈춰 로그인·친구가 통째로 안 붙는다.
    const n = safeDecode((location.hash.match(/[#&]n=([^&]*)/) || [])[1] || "");
    // ⚠️ **해시를 지우기 전에** 읽는다. replaceState 뒤에는 이 값이 없다.
    const isNew = /[#&]new=1(&|$)/.test(location.hash);
    history.replaceState(null, "", location.pathname + location.search);
    if (m[1] === "denied") { takeNonce(); toast("로그인을 취소했어요"); return false; }
    // ⚠️ **「아직 가입 안 했다」를 「실패」로 말하지 않는다.** 사용자가 할 일이 다르다 —
    //    다시 누르는 것이 아니라 가입 화면으로 가야 한다. 예전에는 이 갈래가 아예 없었다
    //    (로그인이 곧 가입이었으므로).
    const SIGNUP_BACK = {
      signup_required: "아직 가입하지 않으셨어요. 여기서 가입하실 수 있어요.",
      used: "이미 처리된 가입 요청이에요. 다시 시작해 주세요.",
      stale: "약관이 새로 바뀌었어요. 새 약관을 확인하고 다시 가입해 주세요.",
    };
    if (SIGNUP_BACK[m[1]]) {
      takeNonce();
      GATE_TAKEN = true;                 // 아래 기본 게이트가 이 화면을 덮지 않게
      openSignup(SIGNUP_BACK[m[1]]);
      return false;
    }
    if (m[1] !== "ok") { takeNonce(); toast("로그인에 실패했어요. 다시 시도해 주세요."); return false; }
    const mine = takeNonce();
    if (!mine || n !== mine) {
      await apiLogoutRaw();   // 쿠키가 이미 심어졌다 — 화면만 되돌리면 서버는 로그인인 채로 남는다
      toast("로그인 정보가 맞지 않아요. 앱에서 다시 로그인해 주세요.");
      return false;
    }
    setAuth(via);
    JUST_SIGNED_UP = isNew;   // 서버가 `&new=1` 로 알려준다. 화면 문구에만 쓴다
    return true;
  }

  // 네이버는 **앱 주소로** 돌아온다(네이버가 서비스 URL 도메인 안의 콜백만 허용해서).
  // 그래서 code 가 쿼리로 들어오고, 앱이 그걸 서버에 넘겨 세션 토큰으로 바꾼다.
  async function takeCodeQuery() {
    const q = new URLSearchParams(location.search);
    const code = q.get("code"), state = q.get("state");
    if (!code || !state) return false;
    // code 가 주소창·방문기록에 남지 않게 즉시 지운다. 해시(#w= 같은)는 남긴다.
    history.replaceState(null, "", location.pathname + location.hash);
    const r = await apiExchange("naver", code, state);
    // 원인이 다르면 할 일도 다르다 — 연결 문제는 인터넷을 확인할 일이고, 서버 거절은 다시 누를 일,
    // **가입 안 함은 가입 화면으로 갈 일**이다. 하나로 뭉개면 사용자가 헛수고를 한다.
    if (!r.ok) {
      takeNonce();
      const BACK = {
        signup_required: "아직 가입하지 않으셨어요. 여기서 가입하실 수 있어요.",
        state_used: "이미 처리된 가입 요청이에요. 다시 시작해 주세요.",
        policy_stale: "약관이 새로 바뀌었어요. 새 약관을 확인하고 다시 가입해 주세요.",
      };
      if (BACK[r.kind]) {
        GATE_TAKEN = true;
        openSignup(BACK[r.kind]);
        return false;
      }
      toast(r.kind === "timeout" || r.kind === "network"
        ? "연결이 안 돼요. 인터넷에 연결된 뒤 다시 로그인해 주세요."
        : "로그인에 실패했어요. 다시 시도해 주세요.");
      return false;
    }
    // ⚠️ **이 갈래에는 n 대조가 여전히 필수다.** `?code=…&state=…` 는 링크로 보낼 수 있고,
    //    받은 사람의 앱이 **남의 code** 를 교환하면 서버가 그 브라우저에 **남의 계정 쿠키**를 심는다.
    //    쿠키로 옮겨도 이 갈래만은 세션 고정이 그대로 성립한다 — code 를 우리 앱이 대신 내밀기 때문이다.
    const mine = takeNonce();
    if (!mine || r.n !== mine) {
      // 이미 쿠키가 심어졌다. 표시만 안 세우면 화면은 로그아웃인데 서버는 로그인 상태로 남으므로
      // **서버에 알려 그 세션을 끊는다.** 그래야 다음 요청이 남의 계정으로 나가지 않는다.
      await apiLogoutRaw();
      toast("로그인 정보가 맞지 않아요. 앱에서 다시 로그인해 주세요.");
      return false;
    }
    setAuth("naver");
    JUST_SIGNED_UP = !!r.signedUp;
    return true;
  }

  // app.js 의 main() 이 사전을 다 읽은 뒤 부른다 — replaceBook 이 bookItem 을 쓰므로
  // 사전보다 먼저 돌면 담아둔 단어가 통째로 "사전에 없음"으로 버려진다.
  onAppReady(async () => {
    const fresh = (await takeLoginHash()) || (await takeCodeQuery());
    // 어느 제공자가 실제로 설정돼 있나. **renderAll 보다 먼저** 물어야 버튼이 한 번에 맞게 그려진다.
    const h = await apiHealth();
    // 못 물어봤으면 null 로 남긴다 — loginButtons 가 그걸 보고 "연결 안 됨"이라 말한다.
    if (h.ok) { PROVIDERS = h.providers; SIGNUP_READY = h.signupReady;
                TURNSTILE_KEY = h.turnstileSiteKey; }
    // 계정 기능이 열렸는지는 **`ready` 하나**로 판정한다(서버 계약은 그대로다).
    // ⚠️ `providers: []` 를 근거로 쓰지 않는다 — 그건 「로그인을 시작할 수 있나」이지
    //    「지금 로그인돼 있나」가 아니다. 제공자가 없어도 세션은 살아 있을 수 있다.
    // 못 물어봤으면 그것도 "모른다" 라서 계정처럼 그리지 않는다 — 여기가 그 판정 자리다.
    // (개별 요청의 일시적 끊김은 down 이 아니다. 그건 「다시 시도」로 회복하는 길이 있다.)
    setAccountState(!h.ok ? "down" : h.ready === false ? "down" : "ok");
    renderAll();
    // 서버가 돌아오거나 닫히면 그 자리에서 화면을 다시 그린다 — 되돌아올 수 있어야 한다.
    onAccountState(() => renderAll());
    if (fresh) toast(JUST_SIGNED_UP ? "가입했어요. 환영해요!" : "로그인했어요");
    if (authToken()) {
      sync(fresh);
      // 로그인하러 떠나기 전에 맡아 둔 해시(#w=…)를 되돌린다. hashchange 가 나면서
      // app.js 의 openHash 가 링크로 받은 단어장을 그때 합친다.
      const back = localStorage.getItem(BACK_KEY);
      localStorage.removeItem(BACK_KEY);
      if (fresh && back) location.hash = back;
    } else if (!GATE_TAKEN && !localStorage.getItem(PEEK_KEY)) {
      openGate();   // 첫 화면은 가입/로그인. 둘러보기를 한 번 고르면 다시 막지 않는다.
    }
  });
}
