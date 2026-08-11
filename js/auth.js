// 계층: 입력 수신 + 판단. 로그인 화면과 동기화 규칙. 서버 호출은 js/authApi.js 만 한다.
//
// 로그인을 붙인 **유일한 이유는 단어장이 기기를 따라오게 하는 것**이다. 그래서 이 파일이 하는 일은
// 결국 하나 — 어느 쪽 단어장이 새것인지 정하는 것. 그 판단만 syncPlan() 에 순수 함수로 떼어
// scripts/test-auth.mjs 가 직접 잰다(화면 없이 돌아야 규칙이 회귀검증된다).

const AT_KEY = "shh-wordbook-at";   // 로컬 단어장이 마지막으로 바뀐 시각(ms)
const PEEK_KEY = "shh-peek";        // "로그인 없이 둘러보기"를 고른 적이 있는가
const NAME_KEY = "shh-name";        // 사용자가 지은 별명. 제공자에게 받은 이름이 아니다.
const BACK_KEY = "shh-back";        // 로그인하러 떠나기 직전의 해시(링크로 받은 단어장)
const UID_KEY = "shh-uid";          // 마지막으로 맞춰 둔 계정. 계정이 바뀌면 로컬을 물려주지 않는다
const NAMES = { kakao: "카카오", naver: "네이버", google: "구글" };

// 어느 쪽을 남길지 정한다. 순수 함수 — localStorage 도 DOM 도 안 본다.
//
// ponytail: 통째로 last-write-wins 다. 두 기기가 **둘 다 오프라인에서** 고치면 나중에 올라온 쪽이
//   이기고 다른 쪽 변경은 사라진다. 단어 단위 병합(CRDT)은 삭제를 기억할 저장소가 더 필요한데,
//   연인 둘이 쓰는 단어장에서 그 동시 편집이 실제로 문제가 되면 그때 만든다.
//   합집합으로 하지 않는 이유는 **뺀 단어가 다른 기기에서 되살아나기 때문**이다.
function syncPlan(remote, local, localAt, firstLogin, localName = "", accountChanged = false) {
  if (!remote) return { action: "none" };                     // 오프라인 — 로컬을 그대로 둔다
  // 계정이 바뀌었으면 이 기기의 단어장은 **앞 계정 것**이다. 새 계정에 물려주지 않는다 —
  // 안 그러면 한 기기를 두 사람이 쓸 때 앞사람 단어장이 뒷사람 계정으로 올라간다.
  // 버려도 잃는 게 없다: 앞 계정 것은 그쪽 서버에 있고, 담기는 로그인을 요구하므로
  // (mayAddToBook) 로그인 없이 생긴 로컬 단어장이란 것이 없다.
  if (accountChanged) return { action: "pull", words: remote.words, name: remote.name || "" };
  // 로그인 첫 순간만 합집합. 로그인 전에 담아둔 단어를 잃으면 안 되고,
  // 다른 기기에 있던 것도 가져와야 한다. 이때는 아직 "뺐다"는 뜻이 없으니 합집합이 안전하다.
  if (firstLogin) {
    const merged = remote.words.concat(local.filter((w) => !remote.words.includes(w)));
    // 별명도 같은 이유로 합친다: 이 기기에서 지은 별명이 있으면 그걸 쓰고, 없으면 계정에 있던 것.
    return { action: "merge", words: merged, name: localName || remote.name || "" };
  }
  // 별명은 단어장과 **같은 레코드**라 같은 시각을 공유한다. 따로 판정하면 "단어는 새것, 별명은 옛것"
  // 같은 반쪽 상태가 생긴다.
  if (remote.updated > localAt) return { action: "pull", words: remote.words, name: remote.name || "" };
  return { action: "push", words: local, name: localName };
}

// ── 아래는 화면·부수효과 ────────────────────────────────────────────────
if (typeof document !== "undefined") {
  let putTimer = null;
  const touch = () => localStorage.setItem(AT_KEY, Date.now());
  const myName = () => localStorage.getItem(NAME_KEY) || "";

  // 단어를 담거나 뺄 때마다 불린다(app.js 의 saveBook). 서버 저장은 몰아서 한 번.
  onBookChanged((words) => {
    touch();
    if (!authToken()) return;
    clearTimeout(putTimer);
    putTimer = setTimeout(() => apiPutBook(words, myName()), 800);
  });

  async function sync(firstLogin) {
    // 앞서 맞춰 둔 계정과 지금 계정이 다른가. 처음이면(빈 값) 다르다고 보지 않는다 —
    // 로그인 기능이 붙기 전에 담아둔 단어장을 첫 로그인에서 살려야 하기 때문이다.
    const was = localStorage.getItem(UID_KEY) || "";
    const accountChanged = !!was && was !== authUid();
    const remote = await apiGetBook();
    // 프로 여부는 **서버가 정한다.** 로컬에만 두면 폰을 바꾸는 순간 사라져서, 마스터 계정도
    // 새 기기에서는 무료 벽에 걸린다. 오프라인(remote === null)이면 손대지 않는다 —
    // 연결이 안 된다고 프로를 끄면 지하철에서 벽이 다시 선다.
    if (remote && setEntitlement(remote.pro, remote.master)) renderAll();
    const plan = syncPlan(remote, BOOK, +localStorage.getItem(AT_KEY) || 0, firstLogin, myName(), accountChanged);
    // 서버가 대답한 뒤에만 적는다. 오프라인(none)에서 적어 두면 다음에 온라인으로 들어올 때
    // 계정이 안 바뀐 것으로 보여 앞 계정 단어장이 그대로 올라간다.
    if (plan.action !== "none") localStorage.setItem(UID_KEY, authUid());
    if (plan.action === "none") return;
    if (plan.action === "push") { if (BOOK.length || myName()) await apiPutBook(BOOK, myName()); return; }
    localStorage.setItem(NAME_KEY, plan.name);
    replaceBook(plan.words);
    renderAll();   // 별명이 바뀌었을 수 있다
    // pull 은 서버 시각을 그대로 물려받는다. 여기서 Date.now() 를 쓰면 받아온 것이 늘 최신이 돼
    // 다음 기기의 변경을 계속 이긴다.
    if (plan.action === "pull") localStorage.setItem(AT_KEY, Date.now());
    else { touch(); await apiPutBook(BOOK, myName()); }   // merge 는 합친 결과를 서버에도 올린다
  }

  // ── 마이페이지 ──
  // 화면 전환마다 다시 그리지 않는다. 바뀌는 건 로그인 상태뿐이라 **상태가 바뀔 때만** 그린다 —
  // 그래서 app.js 의 화면 전환에 훅을 하나 더 뚫지 않아도 된다.
  const subText = () => {
    if (!authToken()) return "";
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

    if (!authToken()) {
      // 안내 문단은 뺐다 — 게이트에서 이미 본 말을 여기서 또 읽게 된다. 버튼만 둔다.
      loginButtons(box, "btn-primary");
      return;
    }

    const used = bookCost(), free = isPro ? "" : ` · 손짓 ${used}/${FREE_LIMIT}`;
    const plan = document.createElement("div");
    plan.className = "plan" + (isPro ? " pro" : "");
    // 마스터와 프로를 갈라 말한다 — 만든 사람이 화면만 보고 "지금 무엇으로 열려 있나"를 알아야
    // 벽 문구를 고칠 때 자기 기기에서 확인이 되는지 안 되는지 헷갈리지 않는다.
    // 마스터에는 설명 줄을 안 붙인다 — 이름만으로 충분하고, 왜 열려 있는지는 화면이 말할 일이 아니다.
    const desc = isMaster ? "" : isPro ? "단어장을 무제한으로 담을 수 있어요"
      : `무료로 손짓 ${FREE_LIMIT}개까지 담을 수 있어요`;
    plan.innerHTML = `<div class="k">현재 플랜</div>`
      + `<div class="n">${isMaster ? "마스터" : isPro ? "프로" : "무료"}${free}</div>`
      + (desc ? `<div class="d">${desc}</div>` : "");
    box.appendChild(plan);
    if (!isPro) {
      const up = document.createElement("button");
      up.className = "btn-primary"; up.type = "button";
      up.textContent = `프로 알아보기 (${PRO_PRICE})`;
      up.addEventListener("click", () => GO("settings"));
      box.appendChild(up);
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
    if (!authToken()) {
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
      // 서버에 **먼저** 알린다. 토큰을 지운 뒤에 부르면 apiCall 이 토큰이 없다고 그냥 돌아가서
      // KV 의 세션이 180일을 더 산다. 오프라인이면 실패하지만 그때도 로컬은 정리한다 —
      // 사용자가 로그아웃을 눌렀는데 화면이 로그인 상태로 남으면 그게 더 나쁘다.
      await apiLogout();
      // 로컬 단어장은 남긴다. 로그아웃은 "이 기기에서 그만 보기"지 "지우기"가 아니다.
      // 다만 **마스터·프로는 끈다** — 계정에 달린 값이라 계정을 놓으면 같이 놓아야 한다.
      // 안 끄면 로그아웃한 기기가 계속 마스터로 보이고, 다음 사람이 그대로 물려받는다.
      setEntitlement(false, false);
      setAuth(null); renderAll(); GO("me"); toast("로그아웃했어요");
    });
    box.appendChild(out);
  }

  // ── 계정 ── 설정 → 계정으로 들어온다. 여기서 하는 일은 하나: 계정을 지우는 것.
  function renderAccount() {
    const box = document.getElementById("account");
    box.innerHTML = "";
    // 로그아웃 상태면 비워만 둔다. **여기서 GO 를 부르면 안 된다** — renderAll 은 앱이 뜰 때도
    // 도는데, 그때 화면을 옮기면 링크로 들어온 사람이 마이 탭으로 튕긴다.
    if (!authToken()) return;

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
      await apiDeleteAccount();
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
      apiPutBook(BOOK, v);
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

  // 로그인 버튼 세 개. 마이페이지와 게이트가 **같은 함수**를 쓴다 — 둘이 갈라지면
  // 한쪽에만 제공자를 추가하는 실수가 난다.
  function loginButtons(box, cls) {
    for (const k of ["kakao", "naver", "google"]) {
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
  function openGate(reason) {
    const box = document.getElementById("gate");
    // 안내문을 **완전히 덮는다.** 반투명 위에 반쯤 걸치면 뒤 글자가 읽히려다 말아 방해만 된다.
    // 안내문은 게이트를 닫은 뒤 다시 띄운다 — 순서가 로그인 → 안내문 → 앱이어야 한다.
    const intro = document.getElementById("intro");
    const introWasOpen = intro && !intro.hidden;
    if (intro) intro.hidden = true;
    box.innerHTML = "";
    const card = document.createElement("section");
    card.className = "intro gate";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    // 설명 두 줄(단어장이 따라온다 · 고유 번호만 받는다)은 뺐다. 첫 화면에서 읽을 것을 줄인다 —
    // 무엇을 받는지는 푸터의 개인정보처리방침이 정식으로 말한다.
    card.innerHTML = `<svg class="mascot sm" viewBox="0 0 100 100" aria-hidden="true"><use href="#mascot"/></svg>
      <div class="intro-h"><b>${reason || "쉿! 우리만 알 수 있는<br>언어로 얘기해요"}</b></div>`;
    const foot = document.createElement("div");
    foot.className = "intro-foot";
    loginButtons(foot, "btn-primary");
    const peek = document.createElement("button");
    peek.type = "button"; peek.className = "btn-ghost";
    peek.textContent = localStorage.getItem(PEEK_KEY) ? "닫기" : "로그인 없이 둘러보기";
    peek.addEventListener("click", () => {
      localStorage.setItem(PEEK_KEY, "1");
      box.hidden = true;
      if (introWasOpen) intro.hidden = false;
    });
    foot.appendChild(peek);
    card.appendChild(foot);
    box.appendChild(card);
    box.hidden = false;
  }

  // 담기를 막는 자리. 둘러보기 중이어도 사전·연습은 그대로 쓸 수 있다.
  onSaveGuard(() => {
    if (authToken()) return true;
    openGate("담은 단어를 지키려면<br>로그인이 필요해요");
    return false;
  });

  // 로그인하고 돌아온 자리. 서버가 #login=<토큰>&via=<제공자> 로 되돌려보낸다.
  function takeLoginHash() {
    const m = location.hash.match(/[#&]login=([^&]+)/);
    if (!m) return false;
    const via = (location.hash.match(/[#&]via=(\w+)/) || [])[1];
    // 토큰이 주소창·방문기록에 남지 않게 즉시 지운다.
    history.replaceState(null, "", location.pathname + location.search);
    if (m[1] === "denied") { toast("로그인을 취소했어요"); return false; }
    if (m[1] === "fail") { toast("로그인에 실패했어요. 다시 시도해 주세요."); return false; }
    setAuth(m[1], via);
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
    if (!r || !r.token) { toast("로그인에 실패했어요. 다시 시도해 주세요."); return false; }
    setAuth(r.token, "naver");
    return true;
  }

  // app.js 의 main() 이 사전을 다 읽은 뒤 부른다 — replaceBook 이 bookItem 을 쓰므로
  // 사전보다 먼저 돌면 담아둔 단어가 통째로 "사전에 없음"으로 버려진다.
  onAppReady(async () => {
    const fresh = takeLoginHash() || (await takeCodeQuery());
    renderAll();
    if (fresh) toast("로그인했어요");
    if (authToken()) {
      sync(fresh);
      // 로그인하러 떠나기 전에 맡아 둔 해시(#w=…)를 되돌린다. hashchange 가 나면서
      // app.js 의 openHash 가 링크로 받은 단어장을 그때 합친다.
      const back = localStorage.getItem(BACK_KEY);
      localStorage.removeItem(BACK_KEY);
      if (fresh && back) location.hash = back;
    } else if (!localStorage.getItem(PEEK_KEY)) {
      openGate();   // 첫 화면은 로그인. 둘러보기를 한 번 고르면 다시 막지 않는다.
    }
  });
}
