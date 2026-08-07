// 계층: 입력 수신 + 판단. 로그인 화면과 동기화 규칙. 서버 호출은 js/authApi.js 만 한다.
//
// 로그인을 붙인 **유일한 이유는 단어장이 기기를 따라오게 하는 것**이다. 그래서 이 파일이 하는 일은
// 결국 하나 — 어느 쪽 단어장이 새것인지 정하는 것. 그 판단만 syncPlan() 에 순수 함수로 떼어
// scripts/test-auth.mjs 가 직접 잰다(화면 없이 돌아야 규칙이 회귀검증된다).

const AT_KEY = "shh-wordbook-at";   // 로컬 단어장이 마지막으로 바뀐 시각(ms)
const PEEK_KEY = "shh-peek";        // "로그인 없이 둘러보기"를 고른 적이 있는가
const BACK_KEY = "shh-back";        // 로그인하러 떠나기 직전의 해시(링크로 받은 단어장)
const NAMES = { kakao: "카카오", naver: "네이버", google: "구글" };

// 어느 쪽을 남길지 정한다. 순수 함수 — localStorage 도 DOM 도 안 본다.
//
// ponytail: 통째로 last-write-wins 다. 두 기기가 **둘 다 오프라인에서** 고치면 나중에 올라온 쪽이
//   이기고 다른 쪽 변경은 사라진다. 단어 단위 병합(CRDT)은 삭제를 기억할 저장소가 더 필요한데,
//   연인 둘이 쓰는 단어장에서 그 동시 편집이 실제로 문제가 되면 그때 만든다.
//   합집합으로 하지 않는 이유는 **뺀 단어가 다른 기기에서 되살아나기 때문**이다.
function syncPlan(remote, local, localAt, firstLogin) {
  if (!remote) return { action: "none" };                     // 오프라인 — 로컬을 그대로 둔다
  // 로그인 첫 순간만 합집합. 로그인 전에 담아둔 단어를 잃으면 안 되고,
  // 다른 기기에 있던 것도 가져와야 한다. 이때는 아직 "뺐다"는 뜻이 없으니 합집합이 안전하다.
  if (firstLogin) {
    const merged = remote.words.concat(local.filter((w) => !remote.words.includes(w)));
    return { action: "merge", words: merged };
  }
  if (remote.updated > localAt) return { action: "pull", words: remote.words };
  return { action: "push", words: local };
}

// ── 아래는 화면·부수효과 ────────────────────────────────────────────────
if (typeof document !== "undefined") {
  let putTimer = null;
  const touch = () => localStorage.setItem(AT_KEY, Date.now());

  // 단어를 담거나 뺄 때마다 불린다(app.js 의 saveBook). 서버 저장은 몰아서 한 번.
  onBookChanged((words) => {
    touch();
    if (!authToken()) return;
    clearTimeout(putTimer);
    putTimer = setTimeout(() => apiPutBook(words), 800);
  });

  async function sync(firstLogin) {
    const plan = syncPlan(await apiGetBook(), BOOK, +localStorage.getItem(AT_KEY) || 0, firstLogin);
    if (plan.action === "none") return;
    if (plan.action === "push") { if (BOOK.length) await apiPutBook(BOOK); return; }
    replaceBook(plan.words);
    // pull 은 서버 시각을 그대로 물려받는다. 여기서 Date.now() 를 쓰면 받아온 것이 늘 최신이 돼
    // 다음 기기의 변경을 계속 이긴다.
    if (plan.action === "pull") localStorage.setItem(AT_KEY, Date.now());
    else { touch(); await apiPutBook(BOOK); }   // merge 는 합친 결과를 서버에도 올린다
  }

  function render() {
    const btn = document.getElementById("account");
    const via = authVia();
    btn.textContent = authToken() ? (NAMES[via] || "로그인") + " ✓" : "로그인";
    btn.classList.toggle("on", !!authToken());
  }

  function panel() {
    const box = document.getElementById("account-panel");
    box.innerHTML = "";
    const add = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = cls; b.type = "button"; b.textContent = label;
      b.addEventListener("click", fn);
      box.appendChild(b);
      return b;
    };
    if (authToken()) {
      const p = document.createElement("p");
      p.className = "hint";
      p.innerHTML = `<b>${NAMES[authVia()] || ""} 계정</b>으로 단어장이 저장되고 있어요.<br>`
        + `다른 기기에서 같은 계정으로 로그인하면 그대로 이어져요.`;
      box.appendChild(p);
      add("로그아웃", "btn-ghost", () => {
        // 로컬 단어장은 남긴다. 로그아웃은 "이 기기에서 그만 보기"지 "지우기"가 아니다.
        setAuth(null); render(); box.hidden = true; toast("로그아웃했어요");
      });
      add("계정과 단어장 삭제", "btn-ghost danger", async () => {
        if (!confirm("서버에 저장된 단어장을 지우고 계정 연결을 끊어요.\n이 기기의 단어장은 남습니다. 계속할까요?")) return;
        await apiDeleteAccount();
        setAuth(null); render(); box.hidden = true; toast("서버에서 지웠어요");
      });
    } else {
      const p = document.createElement("p");
      p.className = "hint";
      p.innerHTML = "로그인하면 단어장이 <b>폰을 바꿔도 따라와요</b>.<br>"
        + "받는 건 계정의 고유 번호뿐이에요 — 이름도 이메일도 받지 않아요.";
      box.appendChild(p);
      loginButtons(box, "btn-primary sm");
    }
  }

  // 로그인 버튼 세 개. 헤더 패널과 게이트가 **같은 함수**를 쓴다 — 둘이 갈라지면
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
    box.innerHTML = "";
    const card = document.createElement("section");
    card.className = "intro gate";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.innerHTML = `<svg class="mascot sm" viewBox="0 0 100 100" aria-hidden="true"><use href="#mascot"/></svg>
      <div class="intro-h"><b>${reason || "둘이 같이 외우려면<br>먼저 로그인해요"}</b>
      <span>단어장이 <b>폰을 바꿔도 따라와요</b>.<br>받는 건 계정의 고유 번호뿐 — 이름도 이메일도 받지 않아요.</span></div>`;
    const foot = document.createElement("div");
    foot.className = "intro-foot";
    loginButtons(foot, "btn-primary");
    const peek = document.createElement("button");
    peek.type = "button"; peek.className = "btn-ghost";
    peek.textContent = localStorage.getItem(PEEK_KEY) ? "닫기" : "로그인 없이 둘러보기";
    peek.addEventListener("click", () => {
      localStorage.setItem(PEEK_KEY, "1");
      box.hidden = true;
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

  // app.js 의 main() 이 사전을 다 읽은 뒤 부른다 — replaceBook 이 bookItem 을 쓰므로
  // 사전보다 먼저 돌면 담아둔 단어가 통째로 "사전에 없음"으로 버려진다.
  onAppReady(() => {
    const fresh = takeLoginHash();
    render();
    const btn = document.getElementById("account");
    const box = document.getElementById("account-panel");
    btn.addEventListener("click", () => { panel(); box.hidden = !box.hidden; });
    if (fresh) { toast("로그인했어요"); box.hidden = true; }
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
