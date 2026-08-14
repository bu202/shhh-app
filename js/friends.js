// 계층: 입력 수신 + 화면. 친구 목록·요청·친구 단어장 보기. 서버 호출은 js/authApi.js 만 한다.
//
// 왜 링크 공유가 아니라 친구인가: 예전 `#w=` 링크는 **보낸 순간의 복사본**이라, 그 뒤에 담은
// 단어가 상대에게 안 갔다. 둘이 같이 외우는 앱에서 그건 한 번 쓰고 끝나는 기능이다.
// 친구로 이어 두면 서로의 단어장이 계속 보인다.
//
// 왜 수락을 받나: 링크는 어디로든 퍼진다. 링크를 여는 것만으로 이어지면 내 단어장과 별명이
// 링크를 주운 사람에게 보인다. 게임의 친구 추가와 같은 순서 — 요청을 보내고, 받은 사람이 수락한다.
//
// ⚠️ 알림(푸시)은 아직 없다. PWA 는 출시 전 테스트용이라 요청이 와도 상대가 앱을 열어야 안다.
//    Play 출시(5b) 때 붙일 자리다 — 그때까지는 친구 탭의 빨간 점이 알림 노릇을 한다.
if (typeof document !== "undefined") {
  const CODE_KEY = "shh-invite";   // 내 초대 코드. 링크를 만들 때마다 서버를 부르지 않으려고 둔다.

  let VIEW = "mine";               // 단어장 화면의 갈래: mine | friends
  let DATA = null;                 // 마지막으로 받은 {code, friends, in, out}

  const el = (id) => document.getElementById(id);

  // ── 갈래 전환 ──
  // 화면(data-screen)을 새로 만들지 않은 이유: 둘 다 "단어장"이고 하단 탭도 하나다.
  // 화면을 가르면 탭이 어디를 가리켜야 하는지가 애매해진다.
  function applyView() {
    const friends = VIEW === "friends";
    el("wordbook").hidden = friends;
    el("book-actions").hidden = friends;
    el("friends").hidden = !friends;
    for (const b of document.querySelectorAll(".seg[data-book]")) {
      const on = b.dataset.book === VIEW;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    if (friends) renderFriends();
  }

  for (const b of document.querySelectorAll(".seg[data-book]")) {
    b.addEventListener("click", () => { VIEW = b.dataset.book; applyView(); });
  }

  // 단어장 화면을 다시 열 때마다 갈래를 되살린다. app.js 의 go() 가 renderWordbook 을 부르면서
  // #wordbook 을 채우는데, 친구 갈래에 있었다면 그게 다시 보이면 안 된다.
  // 단어장 화면에서만 다시 부른다. 화면이 바뀔 때마다 부르면 탭을 누를 때마다 서버를 때린다.
  onScreenShown((name) => {
    if (name !== "book") return;
    applyView();
    if (authToken()) refreshBadge();
  });

  // ── 받은 요청 표시 ──
  // 푸시가 없는 동안 이게 유일한 알림이다. 숫자를 안 쓰고 점만 찍는다 — 몇 개인지는
  // 들어가면 바로 보이고, 탭 안에 숫자를 넣으면 글자가 두 줄이 된다.
  //
  // **두 곳에 찍는다.** 전에는 「우리」 화면 안의 세그먼트에만 있어서, 요청이 와도 홈에서는
  // 아무것도 안 보였다 — 이미 알고 들어간 사람만 보는 알림이라 알림이 아니었다.
  // 하단 탭의 점이 "들어가 볼 이유"를 만들고, 안쪽 점이 "어느 갈래인지"를 가리킨다.
  const showBadge = (n) => {
    for (const id of ["fr-badge", "fr-tab-badge"]) {
      const b = el(id);
      if (b) b.hidden = !n;
    }
  };

  async function refreshBadge() {
    const d = await apiFriends();
    if (!d) return;
    DATA = d;
    if (d.code) localStorage.setItem(CODE_KEY, d.code);
    showBadge(d.in.length);
  }

  // ── 초대 링크 ──
  // app.js 의 공유 버튼이 이걸 부른다. 빈 값을 돌려주면 app.js 는 조용히 멈춘다 —
  // 이유는 여기서 이미 말했으므로 두 번 말하지 않는다.
  onInviteLink(async () => {
    if (!authToken()) { toast("친구를 추가하려면 로그인이 필요해요"); GO("me"); return ""; }
    let code = localStorage.getItem(CODE_KEY);
    if (!code) {
      const d = await apiFriends();
      if (!d) { toast("연결이 안 돼요. 잠시 뒤 다시 눌러주세요"); return ""; }
      DATA = d; code = d.code;
      localStorage.setItem(CODE_KEY, code);
    }
    return location.origin + location.pathname + "#f=" + code;
  });

  // ── 링크를 받은 쪽 ──
  // app.js 의 mergeFromHash 는 `w=` 가 없으면 해시를 안 건드리므로 여기까지 살아서 온다.
  async function takeInvite() {
    const m = location.hash.match(/[#&]f=([A-Za-z0-9]+)/);
    if (!m) return;
    if (!authToken()) {
      // 해시를 **지우지 않는다.** 로그인하고 돌아와서 이어서 처리해야 한다(auth.js 의 shh-back 과 같은 이유).
      toast("친구를 추가하려면 로그인이 필요해요");
      return;
    }
    history.replaceState(null, "", location.pathname + location.search); // 새로고침마다 다시 보내지 않게
    const r = await apiAddFriend(m[1]);
    if (!r) return toast("친구 추가에 실패했어요");
    if (r.error) return toast(r.error);
    const who = r.friend?.name ? `${r.friend.name}님` : "상대방";
    toast(r.state === "ok" ? `${who}과 친구가 됐어요!` : `${who}에게 친구 요청을 보냈어요`);
    // 방금 만든 상태를 목록에 직접 반영한다. 다시 GET 하면 KV 가 옛 값을 줄 수 있어서
    // "요청을 보냈다"고 말해놓고 목록은 비어 있는 화면이 나온다.
    if (DATA && r.friend) {
      const where = r.state === "ok" ? "friends" : "out";
      if (!DATA[where].some((x) => x.uid === r.friend.uid)) DATA = { ...DATA, [where]: [...DATA[where], r.friend] };
    } else {
      DATA = null;   // 아직 목록을 받은 적이 없으면 renderFriends 가 받아온다
    }
    VIEW = "friends";
    GO("book");
  }

  // ── 친구 목록 화면 ──
  function renderFriends() {
    const box = el("friends");
    box.innerHTML = "";
    if (!authToken()) {
      box.innerHTML = '<p class="hint">로그인하면 친구를 추가할 수 있어요.<br>친구와 서로의 단어장을 볼 수 있게 돼요.</p>';
      return;
    }
    if (!DATA) {
      box.innerHTML = '<p class="hint">불러오는 중이에요…</p>';
      apiFriends().then((d) => { if (d) { DATA = d; localStorage.setItem(CODE_KEY, d.code); renderFriends(); } });
      return;
    }

    // 받은 요청이 맨 위. 사용자가 해야 할 일이 있는 자리를 먼저 보여준다.
    // 안내문을 같이 둔다 — 별명은 선택이라 대부분 비어 있고, 그러면 화면에 "이름 없는 사람이
    // 수락을 기다린다"만 남는다. 이게 연인인지 링크를 주운 사람인지 가릴 단서가 하나도 없다.
    // 서버가 더 알려줄 수 있는 것도 없다(우리가 아는 건 초대 코드를 열었다는 사실뿐이다).
    // 그래서 **아는 사실을 그대로** 적는다: 내 초대 링크를 연 사람이다.
    if (DATA.in.length) box.appendChild(section("나에게 온 친구 요청", DATA.in, "in",
      "내 초대 링크를 연 사람이에요. 수락하면 서로의 단어장이 보여요 — 링크를 보낸 상대가 맞는지 확인하고 수락해주세요."));
    if (DATA.friends.length) box.appendChild(section("내 친구", DATA.friends, "ok"));
    else if (!DATA.in.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.innerHTML = "아직 친구가 없어요.<br><b>친구 초대 링크 보내기</b>로 링크를 보내면,<br>상대가 열고 내가 수락하면 이어져요.";
      box.appendChild(p);
    }
    if (DATA.out.length) box.appendChild(section("보낸 요청 (수락 기다리는 중)", DATA.out, "out"));

    const invite = document.createElement("button");
    invite.className = "btn-primary"; invite.type = "button";
    invite.textContent = "🔗 친구 초대 링크 보내기";
    invite.addEventListener("click", () => el("share-btn").click()); // 만드는 자리는 한 곳(app.js)
    box.appendChild(invite);

    // 링크는 어디로든 퍼진다. 퍼진 걸 되돌릴 방법이 없으면 초대 코드는 한 번 새는 순간
    // 영영 요청을 받는 주소가 된다. 만료를 자동으로 걸지 않은 이유는 그러면 멀쩡한 링크까지
    // 조용히 끊기기 때문이다 — **언제 죽일지는 사람이 정한다.**
    const rotate = document.createElement("button");
    rotate.className = "btn-ghost"; rotate.type = "button";
    rotate.textContent = "초대 링크 새로 만들기";
    rotate.addEventListener("click", async () => {
      if (!confirm("새 링크를 만들면 전에 보낸 링크는 못 쓰게 돼요.\n이미 친구가 된 사람은 그대로예요. 계속할까요?")) return;
      const d = await apiRotateCode();
      if (!d || !d.code) { toast("연결이 안 돼요. 잠시 뒤 다시 눌러주세요"); return; }
      localStorage.setItem(CODE_KEY, d.code);
      if (DATA) DATA.code = d.code;   // 손에 든 목록을 고친다 — KV 는 쓰고 바로 읽으면 옛 값이 온다(함정 49)
      toast("새 초대 링크를 만들었어요");
    });
    box.appendChild(rotate);
  }

  function section(title, list, kind, note) {
    const wrap = document.createElement("div");
    const h = document.createElement("p");
    h.className = "list-head"; h.textContent = title;
    wrap.appendChild(h);
    if (note) {
      const p = document.createElement("p");
      p.className = "hint"; p.textContent = note;
      wrap.appendChild(p);
    }
    const box = document.createElement("div");
    box.className = "list";
    for (const f of list) box.appendChild(friendRow(f, kind));
    wrap.appendChild(box);
    return wrap;
  }

  function friendRow(f, kind) {
    const row = document.createElement("div");
    row.className = "list-row friend";
    const l = document.createElement("span");
    l.className = "l";
    // 별명은 사용자가 짓는 값이라 안 지은 사람이 있다. 그때 빈칸을 두면 누구인지 알 수가 없다.
    // 아직 수락 전인 사람을 "친구"라 부르지 않는다 — 이미 이어진 것처럼 읽혀서 수락을 재촉한다.
    l.textContent = f.name || (kind === "ok" ? "이름 없는 친구" : "별명을 안 지은 사람");
    // 수락된 친구만 단어 개수를 보여준다. 요청 단계에서 개수를 보여주면 아직 남인데 정보가 샌다.
    if (kind === "ok") {
      const s = document.createElement("small");
      s.textContent = ` 손짓 ${f.count}개`;
      l.appendChild(s);
    }
    row.appendChild(l);

    const act = document.createElement("span");
    act.className = "v row-act";
    // 처리기에 **자기 버튼을 넘긴다** — 요청이 도는 동안 그 버튼을 잠그기 위해서다.
    const btn = (text, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip " + cls; b.textContent = text;
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
      act.appendChild(b);
    };
    // 서버를 다시 부르지 않고 **손에 든 목록을 그 자리에서 고친다.**
    // Cloudflare KV 는 쓰고 바로 읽으면 옛 값이 올 수 있어서(최대 60초), 수락 직후 GET 하면
    // "수락했는데 목록이 그대로"인 화면이 나온다. 무엇이 바뀌었는지는 우리가 이미 아는 값이다.
    const move = (to) => {
      DATA = { ...DATA, friends: DATA.friends.filter((x) => x.uid !== f.uid),
               in: DATA.in.filter((x) => x.uid !== f.uid), out: DATA.out.filter((x) => x.uid !== f.uid) };
      if (to) DATA[to] = [...DATA[to], f];
      showBadge(DATA.in.length);
      renderFriends();
    };

    // 거절 · 요청 취소 · 친구 끊기는 서버에서 **같은 한 가지**다(이 연결을 지운다).
    //
    // ⚠️ **서버가 확인해 준 뒤에만 목록에서 지운다.** 예전엔 결과를 안 보고 행부터 지워서,
    //    500 이나 오프라인일 때 사용자는 "끊었다"고 믿는데 관계는 서버에 그대로 남았다 —
    //    상대에겐 내 단어장이 계속 보인다. privacy.html 의 "끊는 즉시 사라진다"와 어긋난다.
    //
    // 404 는 예외다. 서버는 지운 행이 0개일 때 404 를 내는데, 그건 "이미 그런 관계가 없다"는
    // 뜻이라 **사용자가 원한 결과가 이미 이뤄진 것**이다. 이걸 실패로 묶으면 이미 사라진
    // 관계의 유령 행을 화면에서 영영 못 지운다.
    const withdraw = async (b) => {
      if (b.disabled) return;   // 도는 동안 또 누르면 두 번째 요청은 404 를 받는다
      b.disabled = true;
      const r = await apiRemoveFriend(f.uid);
      if (r.ok || r.status === 404) return move(null);
      b.disabled = false;
      toast(r.kind === "network" ? "연결이 안 돼요. 잠시 뒤 다시 눌러주세요"
        : "지금은 처리하지 못했어요. 잠시 뒤 다시 눌러주세요");
    };

    if (kind === "in") {
      btn("수락", "ok", async () => {
        const r = await apiAcceptFriend(f.uid);
        if (!r || r.error) return toast(r?.error || "수락하지 못했어요");
        // 개수는 서버가 방금 준 값으로 채운다 — 요청 단계에선 안 받아 온 값이라 0 으로 남는다.
        f.count = r.friend?.count ?? 0;
        toast(`${f.name || "친구"}님과 친구가 됐어요!`);
        move("friends");
      });
      btn("거절", "no", withdraw);
    } else if (kind === "out") {
      btn("취소", "no", withdraw);
    } else {
      btn("단어장 보기", "ok", () => openFriendBook(f));
      btn("끊기", "no", (b) => {
        if (!confirm(`${f.name || "이 친구"}와 친구를 끊어요.\n서로의 단어장이 안 보이게 됩니다. 계속할까요?`)) return;
        withdraw(b);
      });
    }
    row.appendChild(act);
    return row;
  }

  // ── 친구 단어장 팝업 ──
  // 담는 버튼은 두지 않았다. 사용자가 이번엔 **보기만** 하기로 정했고, 담기까지 두면
  // 무료 벽·프로 상태가 남의 단어장 화면에서 또 갈라진다(문구가 두 곳으로 늘어난다).
  const dlg = el("fr-book");
  el("fr-book-close").addEventListener("click", () => dlg.close());

  async function openFriendBook(f) {
    el("fr-book-title").textContent = `${f.name || "이 친구"}님의 단어장이에요!`;
    const body = el("fr-book-body");
    body.innerHTML = '<p class="hint">불러오는 중이에요…</p>';
    dlg.showModal();
    const r = await apiFriendBook(f.uid);
    body.innerHTML = "";
    if (!r || r.error) { body.innerHTML = '<p class="hint">단어장을 불러오지 못했어요.</p>'; return; }
    if (!r.words.length) { body.innerHTML = '<p class="hint">아직 담은 단어가 없어요.</p>'; return; }

    for (const w of r.words) {
      // 사전에서 다시 펼친다. 서버가 들고 있는 건 단어 문자열뿐이고, 뜻과 그림은 여기서 찾는다 —
      // 내 단어장과 **같은 규칙**이라야 두 화면이 다른 걸 보여주지 않는다.
      const it = bookItem(w);
      if (!it) continue;
      const cards = it.entries.map((x, n) => x && card(
        (it.parts.length > 1 ? "①②③④⑤"[n] + " " : "") + it.labels[n],
        namedFingers(x.description), entryFrames(x), "", meaningOf(x, it.labels[n]))).filter(Boolean);
      if (!cards.length) continue;
      // 합성은 부품 카드가 여러 장이라, 이름을 안 붙이면 **친구가 담은 말이 화면에서 사라진다**
      // (내 단어장은 항목 이름을 보여주는데 여기만 안 보여주면 두 화면이 어긋난다).
      if (it.parts.length > 1) {
        const h = document.createElement("p");
        h.className = "list-head";
        h.textContent = `${it.label} — 손짓 ${it.parts.length}개`;
        body.appendChild(h);
      }
      body.appendChild(cardRow(cards));
    }
    if (!body.children.length) body.innerHTML = '<p class="hint">사전에서 찾을 수 있는 단어가 없어요.</p>';
  }

  // 앱이 서고 사전이 다 읽힌 뒤에 시작한다 — openFriendBook 이 bookItem 을 쓰고,
  // takeInvite 가 화면을 옮기므로 화면 전환이 준비된 뒤여야 한다.
  onAppReady(async () => {
    if (authToken()) await refreshBadge();
    await takeInvite();
  });
  // 앱을 열어둔 채 초대 링크를 누르면 해시만 바뀌고 리로드가 안 된다(#w= 와 같은 함정).
  addEventListener("hashchange", takeInvite);
}
