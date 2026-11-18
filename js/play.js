/* 참가자 폰 화면 */
(function () {
  'use strict';
  const { esc, toArray, LS, LIMITS } = SSG;
  const $ = (s) => document.querySelector(s);
  const app = $('#app');

  const params = new URLSearchParams(location.search);
  const ROOM = (params.get('room') || '').trim().toUpperCase();
  const LOCAL = params.get('local') === '1';
  const DB = LOCAL ? '' : SSG.normalizeDbUrl(params.get('db'));
  const ID_KEY = 'ssg-player:' + (LOCAL ? 'local' : DB) + ':' + ROOM;

  // 내 정보는 탭마다 따로(sessionStorage: 새로고침해도 유지) 둔다.
  // 그래야 로컬 테스트 모드에서 한 브라우저의 여러 탭이 서로 다른 참가자가 된다.
  // 실제 폰에서는 탭을 닫았다가 QR로 다시 들어와도 이어할 수 있게 localStorage에도 남긴다.
  const SS = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 무시 */ } },
  };

  const P = {
    store: null,
    R: undefined,          // 방 데이터 (undefined = 아직 못 받음, null = 방 없음)
    me: SS.get(ID_KEY),    // 이 탭의 참가자 { pid, name }
    saved: LOCAL ? null : LS.get(ID_KEY, null), // 이 기기에서 전에 쓴 참가자
    sig: '',
    editing: false,        // 제출 뒤 [다시 고치기]를 눌렀는지
    sending: false,
    autoSent: '',          // 시간 끝나기 직전 자동 제출한 라운드
    joinMsg: '',
  };

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  // ------------------------------------------------------------ 상태 읽기
  function myTeam(R) {
    if (!R || !R.teams || !P.me) return null;
    for (const tid of Object.keys(R.teams)) {
      if (toArray(R.teams[tid].members).indexOf(P.me.pid) >= 0) return { tid, team: R.teams[tid] };
    }
    return null;
  }

  function mySlots(R, r, tid) {
    const roles = toArray(R.roles && R.roles['r' + r] && R.roles['r' + r][tid]);
    const out = [];
    roles.forEach((pid, s) => { if (pid === P.me.pid) out.push(s); });
    return out;
  }

  function myAnswers(R, r, tid) {
    return (R.answers && R.answers['r' + r] && R.answers['r' + r][tid]) || {};
  }

  function isJoined(R) {
    return !!(R && P.me && R.players && R.players[P.me.pid]);
  }

  // ------------------------------------------------------------ 화면
  function render() {
    const R = P.R;
    if (!ROOM || (!LOCAL && !DB)) {
      return show('bad', `<div class="p-card p-center"><div class="big-emoji">📷</div><h2>링크가 올바르지 않아요</h2><p>앞 화면의 QR코드를 다시 찍어 주세요.</p></div>`);
    }
    if (R === undefined) return;
    if (R === null || !R.meta) {
      return show('noroom', `<div class="p-card p-center"><div class="big-emoji">🔍</div><h2>방을 찾을 수 없어요</h2><p>게임이 끝났거나 새 게임이 시작됐을 수 있어요.<br>앞 화면의 QR코드를 다시 찍어 주세요.</p></div>`);
    }
    if (!isJoined(R)) return renderJoin(R);
    renderMain(R);
  }

  /** 화면 내용이 바뀔 때만 다시 그린다(입력 중인 글자가 지워지지 않게). */
  function show(sig, html, after) {
    if (sig === P.sig) return;
    P.sig = sig;
    app.innerHTML = html;
    if (after) after();
  }

  function renderJoin(R) {
    const st = R.state || {};
    if (st.phase === 'final') {
      return show('join-final', `<div class="p-card p-center"><div class="big-emoji">🏁</div><h2>게임이 이미 끝났어요</h2><p>앞 화면에서 결과를 확인해 주세요.</p></div>`);
    }
    const removed = P.me && P.me.pid && !(R.players && R.players[P.me.pid]);
    const canResume = !P.me && P.saved && R.players && R.players[P.saved.pid];
    const sig = 'join|' + (removed ? 'r' : '') + '|' + (canResume ? P.saved.pid : '') + '|' + P.joinMsg;
    show(sig, `
      <div class="p-hero">
        <div class="p-logo">문장 성분<br>조합 게임</div>
        <p class="p-sub">세 명이 한 칸씩, 서로 모르게<br>한 문장을 완성해요!</p>
      </div>
      ${canResume ? `<div class="p-card p-center">
        <p>이 폰으로 이미 입장했어요.</p>
        <button class="btn btn-primary btn-block" type="button" id="resumeBtn">‘${esc(R.players[P.saved.pid].name)}’ 이름으로 계속하기</button>
      </div><p class="p-room">처음 입장하는 사람이라면 아래에 이름을 써 주세요.</p>` : ''}
      <form class="p-card" id="joinForm" autocomplete="off">
        ${removed ? '<p class="p-note">연결이 끊겨서 다시 입장해야 해요.</p>' : ''}
        <label class="p-label" for="nameInput">이름을 입력해 주세요</label>
        <input id="nameInput" class="p-input" maxlength="${LIMITS.name}" placeholder="예: 김민수" value="${esc((P.me && P.me.name) || '')}" enterkeyhint="go">
        <p class="p-help">조원과 친구들이 알아볼 수 있는 이름 (${LIMITS.name}자까지)</p>
        ${P.joinMsg ? `<p class="p-error">${esc(P.joinMsg)}</p>` : ''}
        <button class="btn btn-primary btn-block" type="submit" id="joinBtn">입장하기</button>
      </form>
      <p class="p-room">방 코드 <b>${esc(ROOM)}</b>${LOCAL ? ' · 로컬 테스트' : ''}</p>
    `, () => {
      $('#joinForm').addEventListener('submit', (e) => { e.preventDefault(); join(); });
      if ($('#resumeBtn')) $('#resumeBtn').addEventListener('click', () => { P.me = P.saved; SS.set(ID_KEY, P.me); P.sig = ''; render(); });
      if (!(P.me && P.me.name) && !canResume) setTimeout(() => $('#nameInput') && $('#nameInput').focus(), 50);
    });
  }

  async function join() {
    const R = P.R;
    const input = $('#nameInput');
    const name = input.value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
    if (!name) { P.joinMsg = '이름을 입력해 주세요.'; P.sig = ''; render(); return; }
    const pid = (P.me && P.me.pid) || ('p' + SSG.randomId(10));
    const taken = Object.keys(R.players || {}).some(id => id !== pid && (R.players[id].name || '').trim() === name);
    if (taken) {
      P.joinMsg = `'${name}'은(는) 이미 있어요. 성이나 별명을 붙여 주세요.`;
      P.sig = '';
      render();
      return;
    }
    $('#joinBtn').disabled = true;
    P.me = { pid, name };
    SS.set(ID_KEY, P.me);
    if (!LOCAL) { P.saved = P.me; LS.set(ID_KEY, P.me); }
    P.joinMsg = '';
    try {
      await P.store.update({ ['players/' + pid]: { name, joined: P.store.now() } });
    } catch (e) {
      P.joinMsg = '입장하지 못했어요: ' + e.message;
      P.sig = '';
      render();
    }
  }

  function header(R, mt) {
    return `
      <div class="p-top">
        <span class="p-me">${esc(P.me.name)}</span>
        ${mt ? `<span class="team-pill">${mt.team.no}조</span>` : ''}
      </div>`;
  }

  function teamBox(R, mt) {
    if (!mt) return '';
    const names = toArray(mt.team.members).map(pid => {
      const nm = (R.players[pid] && R.players[pid].name) || '?';
      return `<li class="${pid === P.me.pid ? 'is-me' : ''}">${esc(nm)}${pid === P.me.pid ? ' (나)' : ''}</li>`;
    }).join('');
    return `<div class="p-team"><div class="p-team-no">${mt.team.no}조</div><ul class="p-team-list">${names}</ul></div>`;
  }

  function lookUp(emoji, title, sub, extra) {
    return `<div class="p-card p-center p-look">
      <div class="big-emoji">${emoji}</div>
      <h2>${title}</h2>
      ${sub ? `<p>${sub}</p>` : ''}
      ${extra || ''}
    </div>`;
  }

  function renderMain(R) {
    const st = R.state || {};
    const phase = st.phase || 'lobby';
    const r = st.round || 0;
    const mt = myTeam(R);
    const total = toArray(R.meta.settings && R.meta.settings.rounds).length || 5;
    const roundLabel = `${r + 1} / ${total} 라운드`;

    // ---------- 대기실
    if (phase === 'lobby' || !mt) {
      const sig = 'wait|' + phase + '|' + !!mt;
      return show(sig, header(R, mt) + lookUp('🎉', '입장 완료!',
        phase === 'lobby' ? '조 편성을 기다리는 중이에요.<br>앞 화면을 봐 주세요.' : '조를 배정하는 중이에요. 잠시만요…'));
    }

    const membersSig = toArray(mt.team.members).map(pid => pid + ':' + (R.players[pid] ? R.players[pid].name : '')).join(',');

    // ---------- 조 발표
    if (phase === 'teams') {
      return show('teams|' + mt.tid + '|' + membersSig, header(R, mt) +
        `<div class="p-card p-center"><p class="p-kicker">우리 조는</p>${teamBox(R, mt)}
         <p>조원을 찾아 인사해 보세요 👋<br>곧 1라운드가 시작돼요.</p></div>`);
    }

    // ---------- 입력
    if (phase === 'input') {
      const info = SSG.roundInfo(R, r);
      const slots = mySlots(R, r, mt.tid);
      if (!info || !slots.length) {
        return show('input-none|' + r, header(R, mt) + lookUp('☕', '이번 라운드는 쉬어요', '라운드 중간에 들어와서 다음 라운드부터 참여해요.<br>앞 화면을 봐 주세요.') + teamBox(R, mt));
      }
      const ans = myAnswers(R, r, mt.tid);
      const done = slots.every(s => ans['s' + s] && ans['s' + s].text);
      if (done && !P.editing) {
        const mine = slots.map(s => `<div class="p-done-item"><span class="chip part-${SSG.PARTS[info.parts[s]].key}">${esc(info.parts[s])}</span> ${esc(ans['s' + s].text)}</div>`).join('');
        return show('input-done|' + r + '|' + slots.map(s => ans['s' + s].text).join('|'), header(R, mt) + `
          <div class="p-timer" id="pTimer"></div>
          <div class="p-card p-center p-look">
            <div class="big-emoji">✅</div>
            <h2>제출 완료!</h2>
            <p>이제 앞 화면을 봐 주세요 👀</p>
            <div class="p-done">${mine}</div>
            <button class="btn btn-ghost" id="editBtn" type="button">다시 고치기</button>
          </div>`, () => {
          $('#editBtn').addEventListener('click', () => { P.editing = true; P.sig = ''; render(); });
          tick();
        });
      }
      const chips = info.parts.map((p, s) => `<span class="chip part-${SSG.PARTS[p].key} ${slots.indexOf(s) >= 0 ? 'is-mine' : 'is-other'}">${slots.indexOf(s) >= 0 ? '✏️ ' : ''}${esc(p)}</span>`).join('<span class="plus">+</span>');
      const fields = slots.map(s => {
        const part = info.parts[s];
        const h = SSG.partHint(part, info.parts);
        const prev = ans['s' + s] ? ans['s' + s].text : '';
        return `<div class="p-field part-${SSG.PARTS[part].key}">
          <label class="p-field-label" for="ans${s}"><span class="p-part">${esc(part)}</span><span class="p-q">${esc(h.q)}</span></label>
          <p class="p-hint">${esc(h.desc)} · 예: ${esc(h.ex)}</p>
          <input class="p-input" id="ans${s}" data-slot="${s}" maxlength="${LIMITS.answer}" value="${esc(prev)}" placeholder="${esc(part)}를 써 주세요" autocomplete="off" enterkeyhint="send">
        </div>`;
      }).join('');
      return show('input|' + r + '|' + slots.join(',') + '|' + P.editing, header(R, mt) + `
        <div class="p-timer" id="pTimer"></div>
        <div class="p-round">${roundLabel}</div>
        <div class="p-situation">${esc(info.situation)}</div>
        <div class="p-chips">${chips}</div>
        <form class="p-card" id="ansForm" autocomplete="off">
          ${fields}
          <p class="p-tip">💡 조사(이/가, 을/를 …)까지 붙여서 써요. 조원이 뭘 쓰는지는 안 보여요!</p>
          <button class="btn btn-primary btn-block" type="submit" id="sendBtn">제출하기</button>
        </form>`, () => {
        $('#ansForm').addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
        const first = document.querySelector('#ansForm input');
        if (first && !first.value) setTimeout(() => first.focus(), 80);
        tick();
      });
    }

    P.editing = false;

    // ---------- 그 밖의 단계: 앞 화면 보기
    if (phase === 'reveal') {
      return show('reveal|' + r + '|' + mt.tid, header(R, mt) + lookUp('📢', '문장 공개!', '조별로 완성된 문장을 공개하고 있어요.<br>앞 화면을 봐 주세요 👀') + teamBox(R, mt));
    }
    if (phase === 'scoring') {
      return show('scoring|' + r + '|' + mt.tid, header(R, mt) + lookUp('🤖', '채점 중…', '어떤 점수가 나올까요?<br>앞 화면을 봐 주세요 👀') + teamBox(R, mt));
    }
    if (phase === 'scored' || phase === 'ranking') {
      const sc = R.scores && R.scores['r' + r] && R.scores['r' + r][mt.tid];
      const rk = SSG.ranking(R).find(x => x.tid === mt.tid);
      const extra = `<div class="p-score">
        ${sc ? `<div>이번 라운드 <b>+${SSG.roundScore(sc)}점</b></div>` : ''}
        ${rk && phase === 'ranking' ? `<div>지금 <b>${rk.rank}위</b> · 누적 ${rk.total}점</div>` : ''}
      </div>`;
      return show(phase + '|' + r + '|' + mt.tid + '|' + JSON.stringify(sc || null) + '|' + (rk ? rk.rank + ':' + rk.total : ''),
        header(R, mt) + lookUp(phase === 'ranking' ? '📊' : '💯', phase === 'ranking' ? '순위 발표!' : '점수 발표!', '앞 화면을 봐 주세요 👀', extra) + teamBox(R, mt));
    }
    if (phase === 'final') {
      const rk = SSG.ranking(R).find(x => x.tid === mt.tid);
      const win = rk && rk.rank === 1;
      return show('final|' + mt.tid + '|' + (rk ? rk.rank + ':' + rk.total : ''), header(R, mt) +
        lookUp(win ? '🏆' : '🎊', win ? '우승!' : '게임 끝!',
          rk ? `우리 조 최종 <b>${rk.rank}위</b> · ${rk.total}점` : '수고하셨어요!',
          '<p>앞 화면에서 조별로 만든 이야기를 함께 봐요.</p>') + teamBox(R, mt));
    }
    show('other|' + phase, header(R, mt) + lookUp('👀', '앞 화면을 봐 주세요', ''));
  }

  // ------------------------------------------------------------ 제출
  async function submit(auto) {
    const R = P.R;
    if (P.sending || !R || !R.state || R.state.phase !== 'input') return;
    const r = R.state.round;
    const mt = myTeam(R);
    if (!mt) return;
    const inputs = Array.from(document.querySelectorAll('#ansForm input[data-slot]'));
    const upd = {};
    let empty = false;
    inputs.forEach(inp => {
      const text = inp.value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.answer);
      if (!text) { empty = true; return; }
      upd['answers/r' + r + '/' + mt.tid + '/s' + inp.dataset.slot] = { text, pid: P.me.pid, at: P.store.now() };
    });
    if (!auto && empty) { toast('빈칸이 있어요. 한 글자 이상 써 주세요.'); return; }
    if (!Object.keys(upd).length) return;
    P.sending = true;
    const btn = $('#sendBtn');
    if (btn) btn.disabled = true;
    try {
      await P.store.update(upd);
      P.editing = false;
      P.sig = '';
      render();
      if (auto) toast('시간이 다 돼서 쓴 내용을 자동으로 냈어요.');
    } catch (e) {
      toast(/권한|permission/i.test(e.message) ? '입력이 마감됐어요.' : '제출하지 못했어요. 다시 눌러 주세요.');
      if (btn) btn.disabled = false;
    } finally {
      P.sending = false;
    }
  }

  // ------------------------------------------------------------ 타이머
  function tick() {
    const R = P.R;
    const el = $('#pTimer');
    if (!R || !R.state || R.state.phase !== 'input' || !P.store) return;
    const left = Math.max(0, (R.state.deadline || 0) - P.store.now());
    const sec = Math.ceil(left / 1000);
    if (el) {
      el.textContent = left > 0 ? `⏱ ${sec}초` : '⏱ 마감!';
      el.classList.toggle('urgent', sec <= 10);
    }
    // 마감 1초 전, 써 놓고 안 낸 내용이 있으면 자동 제출
    const key = R.meta.created + ':' + R.state.round;
    if (left > 0 && left < 1200 && P.autoSent !== key && document.querySelector('#ansForm')) {
      const has = Array.from(document.querySelectorAll('#ansForm input[data-slot]')).some(i => i.value.trim());
      if (has) { P.autoSent = key; submit(true); }
    }
  }

  // ------------------------------------------------------------ 시작
  async function start() {
    if (!ROOM || (!LOCAL && !DB)) { P.R = null; render(); return; }
    try {
      P.store = await SSG.connect({ mode: LOCAL ? 'local' : 'firebase', db: DB, room: ROOM });
    } catch (e) {
      app.innerHTML = `<div class="p-card p-center"><div class="big-emoji">⚠️</div><h2>연결하지 못했어요</h2><p>${esc(e.message)}</p><button class="btn btn-primary" onclick="location.reload()">다시 시도</button></div>`;
      return;
    }
    // 처음 연결될 때 잠깐 끊김으로 보이는 것은 무시하고, 3초 넘게 끊겼을 때만 알린다.
    let connTimer = null;
    P.store.onStatus(ok => {
      clearTimeout(connTimer);
      if (ok) $('#conn').hidden = true;
      else connTimer = setTimeout(() => { $('#conn').hidden = false; }, 3000);
    });
    P.store.onError(msg => toast(msg, 5000));
    P.store.subscribe(data => { P.R = data; render(); });
    setInterval(tick, 250);
  }

  start();
})();
