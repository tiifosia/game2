/* 호스트(빔프로젝터) 화면 — 게임 진행 전부를 맡는다.
 * 원칙: 게임 상태(state, teams, roles, scores)는 호스트만 쓴다. 참가자는 자기 이름과 답만 쓴다. */
(function () {
  'use strict';
  const { esc, toArray, LS } = SSG;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const partKey = (p) => (SSG.PARTS[p] ? SSG.PARTS[p].key : 'etc');

  const KEYS = {
    settings: 'ssg-host-settings',
    conn: 'ssg-host-conn',
    room: 'ssg-host-room',
    sound: 'ssg-host-sound',
    extra: 'ssg-ai-extra',
    models: 'ssg-gemini-models',
    botBlank: 'ssg-bot-blank',
  };

  /** js/config.js 에 적어 둔 사이트 기본 Firebase 주소 */
  function configDb() {
    const c = window.SSG_CONFIG || {};
    return SSG.normalizeDbUrl(c.firebaseUrl || '');
  }
  function defaultConn() {
    const db = configDb();
    return db ? { mode: 'firebase', db } : { mode: '', db: '' };
  }

  const H = {
    hostId: 'h' + SSG.randomId(10),
    conn: LS.get(KEYS.conn, null) || defaultConn(),
    settings: SSG.sanitizeSettings(LS.get(KEYS.settings, null)),
    store: null,
    code: '',
    R: undefined,
    unsub: null,
    connected: true,
    sig: '',
    busy: false,
    flags: {},
    allSince: {},
    botTimers: new Map(),
    edit: null,
    aiRunning: false,
    modal: '',
    finalTab: 'rank',
    storyTid: '',
    sound: LS.get(KEYS.sound, true),
    botBlank: LS.get(KEYS.botBlank, false),
    lastBeep: -1,
  };

  // ============================================================ 작은 도구
  function toast(msg, kind, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' toast-' + kind : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 3500);
  }

  let actx = null;
  function beep(freq, dur, vol) {
    if (!H.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      const t = actx.currentTime;
      o.type = 'sine';
      o.frequency.value = freq || 880;
      g.gain.setValueAtTime(vol || 0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.15));
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + (dur || 0.15));
    } catch (e) { /* 소리 없음 */ }
  }

  function now() { return H.store ? H.store.now() : Date.now(); }
  function update(obj) { return H.store.update(obj); }
  function S() { return SSG.settingsOf(H.R); }
  function isPassive() { return !!(H.R && H.R.meta && H.R.meta.host && H.R.meta.host !== H.hostId); }
  function playerName(pid) { const p = H.R && H.R.players && H.R.players[pid]; return p ? p.name : ''; }
  function teamNames(t) { return toArray(t.members).map(pid => playerName(pid) || '?'); }
  function sortedTeamIds(R) { return Object.keys(R.teams || {}).sort((a, b) => R.teams[a].no - R.teams[b].no); }

  function playUrl() {
    const u = new URL('play.html', location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', H.code);
    if (H.store.mode === 'local') u.searchParams.set('local', '1');
    else u.searchParams.set('db', H.store.dbUrl);
    return u.toString();
  }

  function qrSvg(text) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: '참가 QR코드' });
    } catch (e) {
      return '<p>QR코드를 만들지 못했어요.</p>';
    }
  }

  // ============================================================ 연결
  function detach() {
    if (H.unsub) H.unsub();
    if (H.store && H.store.close) H.store.close();
    H.store = null; H.unsub = null; H.R = undefined; H.code = ''; H.sig = '';
    H.botTimers.forEach(t => clearTimeout(t));
    H.botTimers.clear();
    H.flags = {}; H.allSince = {}; H.edit = null;
  }

  async function attach(conn, code) {
    detach();
    const store = await SSG.connect({ mode: conn.mode, db: conn.db, room: code });
    H.store = store;
    H.code = code;
    LS.set(KEYS.room, { mode: conn.mode, db: conn.db, code });
    let connTimer = null;
    store.onStatus(ok => {
      clearTimeout(connTimer);
      if (ok) { H.connected = true; renderTopbar(); }
      else connTimer = setTimeout(() => { H.connected = false; renderTopbar(); }, 3000);
    });
    store.onError(msg => toast(msg, 'error', 6000));
    H.unsub = store.subscribe(data => { const prev = H.R; H.R = data; onData(prev); });
  }

  function onData(prev) {
    if (H.R === null) {
      // 처음 연결할 때(방을 막 만드는 중) 비어 있는 것은 무시
      if (!prev) return;
      // 방이 지워졌다
      LS.del(KEYS.room);
      detach();
      render();
      toast('방이 닫혔어요.');
      return;
    }
    render();
  }

  async function createGame() {
    const conn = H.conn;
    if (!conn.mode || (conn.mode === 'firebase' && !conn.db)) {
      toast('먼저 설정에서 연결 방식을 정해 주세요.', 'warn');
      openSettings();
      return;
    }
    let code = '';
    try {
      // 이미 쓰고 있는 방 코드와 겹치지 않게 확인
      for (let i = 0; i < 8; i++) {
        const c = SSG.roomCode();
        const tmp = await SSG.connect({ mode: conn.mode, db: conn.db, room: c });
        const existing = await withTimeout(tmp.once(), 10000);
        if (tmp.close) tmp.close();
        if (!existing) { code = c; break; }
      }
    } catch (e) {
      toast('연결하지 못했어요: ' + e.message, 'error', 7000);
      return;
    }
    if (!code) { toast('방 코드를 만들지 못했어요. 다시 시도해 주세요.', 'error'); return; }
    await attach(conn, code);
    const t = now();
    await update({
      meta: { created: t, version: 1, host: H.hostId, settings: H.settings },
      state: { phase: 'lobby', round: 0 },
    });
  }

  async function resume() {
    const saved = LS.get(KEYS.room, null);
    if (!saved || !saved.code || !saved.mode) return false;
    try {
      const probe = await SSG.connect({ mode: saved.mode, db: saved.db, room: saved.code });
      const data = await withTimeout(probe.once(), 10000);
      if (probe.close) probe.close();
      if (!data || !data.meta) { LS.del(KEYS.room); return false; }
      await attach({ mode: saved.mode, db: saved.db }, saved.code);
      await update({ 'meta/host': H.hostId });
      return true;
    } catch (e) {
      toast('이전 게임에 다시 연결하지 못했어요: ' + e.message, 'error', 6000);
      return false;
    }
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('응답이 없어요. 연결 설정과 인터넷을 확인해 주세요.')), ms))]);
  }

  // ============================================================ 그리기
  function render() {
    const inGame = !!(H.store && H.R);
    document.body.dataset.view = inGame ? 'game' : 'home';
    if (!H.store) { H.sig = ''; $('#passive').hidden = true; renderHome(); renderTopbar(); return; }
    if (!H.R) return;
    renderTopbar();
    $('#passive').hidden = !isPassive();
    const sig = signature(H.R);
    if (sig !== H.sig) {
      H.sig = sig;
      renderStage(H.R);
    }
    updateLive(H.R);
    if (H.modal === 'people') renderPeople();
  }

  function renderTopbar() {
    const tb = $('#topbar');
    if (!H.store || !H.R) { tb.hidden = true; return; }
    tb.hidden = false;
    const R = H.R;
    const st = R.state || {};
    const total = S().rounds.length;
    const nPlayers = Object.keys(R.players || {}).length;
    const roundTxt = (st.phase && st.phase !== 'lobby' && st.phase !== 'teams' && st.phase !== 'final')
      ? `<span class="tb-item">${(st.round || 0) + 1}/${total} 라운드</span>` : '';
    tb.innerHTML = `
      <div class="tb-left">
        <span class="tb-item">방 <b>${esc(H.code)}</b></span>
        ${H.store.mode === 'local' ? '<span class="tb-item tb-local">로컬 테스트</span>' : ''}
        ${roundTxt}
        <span class="tb-item">👥 ${nPlayers}명</span>
        ${H.connected ? '' : '<span class="tb-item tb-bad">연결 끊김 · 다시 연결 중</span>'}
      </div>
      <div class="tb-right">
        <button class="tb-btn" data-act="showQR" title="참가 QR 다시 보기">QR</button>
        <button class="tb-btn" data-act="openPeople" title="참가자 관리와 봇 추가">👥 참가자·봇</button>
        ${H.store.mode === 'local' ? '<button class="tb-btn" data-act="openPlayerTab" title="참가자 화면을 새 탭으로 열기">＋참가자 탭</button>' : ''}
        <button class="tb-btn" data-act="toggleSound" title="소리 켜기/끄기">${H.sound ? '🔊' : '🔇'}</button>
        <button class="tb-btn" data-act="fullscreen" title="전체 화면">⛶</button>
        <button class="tb-btn" data-act="openSettings" title="설정">⚙</button>
        <button class="tb-btn" data-act="newGameConfirm">새 게임</button>
      </div>`;
  }

  function renderHome() {
    const conn = H.conn;
    const key = SSG.AI.getKey();
    const model = SSG.AI.getModel();
    const st = H.settings;
    let connRow;
    if (conn.mode === 'firebase' && conn.db) {
      let host = conn.db;
      try { host = new URL(conn.db).host; } catch (e) { /* 그대로 */ }
      connRow = `<div class="check ok">✅ <b>연결</b> Firebase · ${esc(host)}${conn.db === configDb() ? ' <span class="muted">(사이트 기본 주소)</span>' : ''}</div>`;
    } else if (conn.mode === 'local') {
      connRow = `<div class="check warn">🧪 <b>연결</b> 로컬 테스트 모드 (이 브라우저의 탭끼리만 연결돼요)</div>`;
    } else {
      connRow = `<div class="check bad">⚠️ <b>연결</b> 아직 설정하지 않았어요 → ⚙ 설정</div>`;
    }
    const aiRow = key && model
      ? `<div class="check ok">✅ <b>AI 채점</b> ${esc(model.replace('models/', ''))}</div>`
      : `<div class="check warn">✍️ <b>AI 채점</b> ${key ? '모델을 고르지 않았어요' : 'API 키가 없어요'} → 직접 채점만 할 수 있어요</div>`;
    const rulesRow = `<div class="check ok">✅ <b>규칙</b> ${st.rounds.length}라운드 · 제한시간 ${st.timer}초 · 적격성 ${st.maxGrammar}점 + 문맥 ${st.maxContext}점</div>`;
    $('#stage').innerHTML = `
      <section class="home">
        <div class="home-chips">
          <span class="chip part-subj">주어</span><span class="plus">+</span>
          <span class="chip part-adv">부사어</span><span class="plus">+</span>
          <span class="chip part-pred">서술어</span>
        </div>
        <h1 class="home-title">문장 성분 조합 게임</h1>
        <p class="home-sub">세 명이 한 칸씩, 서로 모르게 한 문장을 완성해요</p>
        <div class="home-checks">${connRow}${aiRow}${rulesRow}</div>
        <div class="home-actions">
          <button class="btn btn-primary btn-lg" data-act="newGame">새 게임 만들기</button>
          <button class="btn btn-lg" data-act="openSettings">⚙ 설정</button>
        </div>
        <p class="home-foot">참가자는 이 화면이 아니라, 게임을 시작하면 나오는 QR코드를 폰으로 찍어 들어와요.</p>
      </section>`;
  }

  function signature(R) {
    const st = R.state || {};
    const r = st.round || 0;
    const ph = st.phase || 'lobby';
    const base = ph + '|' + r + '|' + JSON.stringify(SSG.settingsOf(R));
    const names = JSON.stringify(Object.keys(R.players || {}).map(k => k + R.players[k].name));
    switch (ph) {
      case 'lobby': return base + names;
      case 'teams': return base + JSON.stringify(R.teams || {}) + names;
      case 'input': return base + JSON.stringify(R.roles && R.roles['r' + r]) + JSON.stringify(R.teams || {}) + names;
      case 'reveal': return base + JSON.stringify(R.answers && R.answers['r' + r]) + JSON.stringify(R.teams || {}) + names;
      case 'scoring': {
        const d = (R.draft && R.draft['r' + r]) || {};
        return base + d.status + d.at + H.aiRunning + JSON.stringify(R.teams || {});
      }
      case 'scored': return base + JSON.stringify(R.scores && R.scores['r' + r]) + JSON.stringify(R.answers && R.answers['r' + r]) + names;
      case 'ranking': return base + JSON.stringify(R.scores || {}) + JSON.stringify(R.teams || {}) + names;
      case 'final': return base + JSON.stringify(R.scores || {}) + JSON.stringify(R.teams || {}) + names + H.finalTab + H.storyTid;
      default: return base;
    }
  }

  function renderStage(R) {
    const st = R.state || {};
    const ph = st.phase || 'lobby';
    const stage = $('#stage');
    const fn = { lobby: stageLobby, teams: stageTeams, input: stageInput, reveal: stageReveal, scoring: stageScoring, scored: stageScored, ranking: stageRanking, final: stageFinal }[ph];
    stage.innerHTML = fn ? fn(R) : '';
    if (ph === 'scoring') wireScoring(R);
    fitLayouts();
  }

  /** 화면 크기에 맞춰 카드 칸 수와 글자 크기를 정한다(빔프로젝터 해상도가 제각각이라서).
   *  data-fit="grid": 카드 n개를 몇 열로 놓을 때 글자가 가장 큰지 계산. data-w/h는 카드 하나의 대략 크기(em).
   *  data-fit="list": 한 줄짜리 항목 n개가 높이에 다 들어가게. data-h는 한 줄 높이(em). */
  function fitLayouts() {
    $$('[data-fit]').forEach(el => {
      el.style.fontSize = '';
      const n = Math.max(1, Number(el.dataset.n) || 1);
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.rowGap) || 0;
      const cap = Math.max(15, window.innerWidth * (Number(el.dataset.max) || 0.024));
      let fs;
      if (el.dataset.fit === 'list') {
        fs = Math.min(cap, ((H - gap * (n - 1)) / n) / Number(el.dataset.h));
      } else {
        const wEm = Number(el.dataset.w);
        const hEm = Number(el.dataset.h);
        let best = { fs: 0, cols: 1 };
        for (let cols = 1; cols <= Math.min(n, 4); cols++) {
          const rows = Math.ceil(n / cols);
          const cw = (W - gap * (cols - 1)) / cols;
          const ch = (H - gap * (rows - 1)) / rows;
          const f = Math.min(cap, cw / wEm, ch / hEm);
          if (f > best.fs + 0.3) best = { fs: f, cols };
        }
        el.style.setProperty('--cols', best.cols);
        fs = best.fs;
      }
      // 어림값이 커서 넘치면 다 들어갈 때까지 조금씩 줄인다.
      // offsetTop/offsetHeight는 등장 애니메이션(transform)의 영향을 받지 않는다.
      const kids = Array.from(el.children);
      const overflows = () => kids.some(ch => ch.offsetTop + ch.offsetHeight > el.clientHeight + 2 ||
        ch.offsetLeft + ch.offsetWidth > el.clientWidth + 2 ||
        ch.scrollHeight > ch.clientHeight + 2 || ch.scrollWidth > ch.clientWidth + 2);
      fs = Math.max(9, fs);
      el.style.fontSize = fs.toFixed(1) + 'px';
      for (let i = 0; i < 25 && fs > 9 && overflows(); i++) {
        fs = Math.max(9, fs * 0.93);
        el.style.fontSize = fs.toFixed(1) + 'px';
      }
    });
  }
  let resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(fitLayouts, 120); });

  // ------------------------------------------------------------ 대기실
  function stageLobby(R) {
    const players = Object.keys(R.players || {}).map(pid => ({ pid, ...R.players[pid] }))
      .sort((a, b) => (a.joined || 0) - (b.joined || 0));
    const url = playUrl();
    return `
      <section class="lobby">
        <div class="lobby-left">
          <div class="qr">${qrSvg(url)}</div>
          <p class="lobby-join">📱 폰 카메라로 QR코드를 찍어 입장하세요</p>
          <p class="lobby-code">방 코드 <b>${esc(H.code)}</b></p>
        </div>
        <div class="lobby-right">
          <h1 class="lobby-title">문장 성분 조합 게임</h1>
          <div class="lobby-count"><b>${players.length}</b>명 입장</div>
          <div class="name-cloud">
            ${players.length ? players.map(p => `<span class="name-chip">${esc(p.name)}</span>`).join('') : '<p class="muted">아직 아무도 없어요. QR코드를 찍어 주세요!</p>'}
          </div>
          <div class="stage-actions">
            <button class="btn btn-primary btn-lg" data-act="formTeams" data-primary ${players.length ? '' : 'disabled'}>조 편성하기 ▶</button>
          </div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ 조 발표
  function stageTeams(R) {
    const tids = sortedTeamIds(R);
    return `
      <section class="teams">
        <h1 class="stage-title">조 편성 완료!</h1>
        <p class="stage-sub">같은 조끼리 모여서 이름과 TMI 하나씩 나눠 보세요 👋</p>
        <div class="team-grid" data-fit="grid" data-n="${tids.length}" data-w="16" data-h="6">
          ${tids.map((tid, i) => `
            <div class="team-card" style="--i:${i}">
              <div class="team-no">${R.teams[tid].no}조</div>
              <div class="team-names">${teamNames(R.teams[tid]).map(n => `<span>${esc(n)}</span>`).join('')}</div>
            </div>`).join('')}
        </div>
        <div class="stage-actions">
          <button class="btn btn-lg" data-act="reshuffle">🔀 다시 섞기</button>
          <button class="btn btn-primary btn-lg" data-act="startRound" data-round="0" data-primary>1라운드 시작 ▶</button>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ 입력
  function structureChips(parts) {
    return parts.map(p => `<span class="chip chip-lg part-${partKey(p)}">${esc(p)}</span>`).join('<span class="plus">+</span>');
  }

  function stageInput(R) {
    const st = R.state;
    const r = st.round;
    const info = SSG.roundInfo(R, r);
    const total = S().rounds.length;
    return `
      <section class="round">
        <div class="round-no">ROUND ${r + 1} <small>/ ${total}</small></div>
        <div class="situation">${esc(info.situation)}</div>
        <div class="structure">${structureChips(info.parts)}</div>
        <div class="timer-wrap">
          <div class="timer" id="timer">--</div>
          <div class="timer-bar"><div id="timerBar"></div></div>
        </div>
        <p class="stage-sub">✏️ 내가 맡은 성분은 폰에서 확인하세요! 조원 답은 서로 안 보여요.</p>
        <div class="progress" id="progress"></div>
        <div class="stage-actions">
          <button class="btn" data-act="extend">⏱ +15초</button>
          <button class="btn" data-act="closeNow">지금 마감</button>
        </div>
      </section>`;
  }

  function submittedCount(R, r) {
    const roles = (R.roles && R.roles['r' + r]) || {};
    const ans = (R.answers && R.answers['r' + r]) || {};
    let done = 0, total = 0;
    const perTeam = {};
    Object.keys(roles).forEach(tid => {
      if (!R.teams || !R.teams[tid]) return;
      const list = toArray(roles[tid]);
      perTeam[tid] = list.map((pid, s) => {
        const active = !!(R.players && R.players[pid]);
        const ok = !!(ans[tid] && ans[tid]['s' + s] && ans[tid]['s' + s].text);
        if (active) { total++; if (ok) done++; }
        return ok ? 1 : (active ? 0 : -1);
      });
    });
    return { done, total, perTeam };
  }

  function allSubmitted(R, r) {
    const c = submittedCount(R, r);
    return c.total > 0 && c.done >= c.total;
  }

  /** 다시 그리지 않고 바뀌는 부분(타이머, 제출 현황)만 고친다. */
  function updateLive(R) {
    const st = R.state || {};
    if (st.phase === 'input') {
      const prog = $('#progress');
      if (prog) {
        const c = submittedCount(R, st.round);
        const tids = Object.keys(c.perTeam).sort((a, b) => R.teams[a].no - R.teams[b].no);
        prog.innerHTML = `<div class="progress-total">제출 <b>${c.done}</b> / ${c.total}</div>
          <div class="progress-teams">${tids.map(tid => {
            const dots = c.perTeam[tid];
            const full = dots.every(d => d !== 0);
            return `<span class="pt ${full ? 'pt-done' : ''}"><b>${R.teams[tid].no}조</b>${dots.map(d => `<i class="${d === 1 ? 'on' : d < 0 ? 'gone' : ''}"></i>`).join('')}</span>`;
          }).join('')}</div>`;
      }
    }
    tickTimer();
  }

  function tickTimer() {
    const R = H.R;
    if (!R || !R.state || R.state.phase !== 'input') return;
    const el = $('#timer');
    const bar = $('#timerBar');
    const st = R.state;
    const left = Math.max(0, st.deadline - now());
    const sec = Math.ceil(left / 1000);
    const totalMs = Math.max(1, st.deadline - (st.startedAt || st.deadline - S().timer * 1000));
    if (el) {
      el.textContent = left > 0 ? sec : '마감!';
      el.classList.toggle('urgent', left > 0 && sec <= 10);
    }
    if (bar) bar.style.width = Math.min(100, (left / totalMs) * 100) + '%';
    if (!isPassive() && left > 0 && sec <= 3 && sec !== H.lastBeep) { H.lastBeep = sec; beep(660, 0.12); }
  }

  // ------------------------------------------------------------ 문장 카드
  function piecesHtml(pieces) {
    return pieces.map(p => `
      <div class="piece part-${partKey(p.part)} ${p.text ? '' : 'is-empty'}">
        <span class="piece-part">${esc(p.part)}</span>
        <span class="piece-text">${p.text ? esc(p.text) : '(빈칸)'}</span>
        <span class="piece-who">${esc(p.name || '')}</span>
      </div>`).join('');
  }

  function sentenceCards(R, r, withScores) {
    const tids = SSG.roundTeams(R, r);
    const S_ = S();
    const cards = tids.map((tid, i) => {
      const pieces = SSG.teamSentence(R, r, tid);
      const sc = withScores && R.scores && R.scores['r' + r] && R.scores['r' + r][tid];
      return `
        <article class="scard" style="--i:${i}">
          <div class="scard-top">
            <span class="team-tag">${R.teams[tid].no}조</span>
            ${sc ? `<span class="score-badge">+${SSG.roundScore(sc)}</span>
              <span class="score-detail">적격성 ${sc.g}/${S_.maxGrammar} · 문맥 ${sc.c}/${S_.maxContext}</span>` : ''}
          </div>
          <div class="pieces">${piecesHtml(pieces)}</div>
          ${sc && sc.reason ? `<div class="scard-reason">💬 ${esc(sc.reason)}</div>` : ''}
        </article>`;
    }).join('');
    return `<div class="sgrid ${withScores ? 'with-scores' : ''}" data-fit="grid" data-n="${tids.length}" data-w="30" data-h="${withScores ? 9.5 : 7.5}">${cards || '<p class="muted">이번 라운드에 참여한 조가 없어요.</p>'}</div>`;
  }

  function stageReveal(R) {
    const r = R.state.round;
    const info = SSG.roundInfo(R, r);
    const hasKey = SSG.AI.getKey() && SSG.AI.getModel();
    return `
      <section class="reveal">
        <div class="reveal-head">
          <span class="round-no round-no-sm">ROUND ${r + 1}</span>
          <div class="situation situation-sm">${esc(info.situation)}</div>
        </div>
        ${sentenceCards(R, r, false)}
        <div class="stage-actions">
          <button class="btn btn-lg ${hasKey ? 'btn-primary' : ''}" data-act="aiScore" ${hasKey ? 'data-primary' : ''}>🤖 AI 채점</button>
          <button class="btn btn-lg ${hasKey ? '' : 'btn-primary'}" data-act="manualScore" ${hasKey ? '' : 'data-primary'}>✍️ 직접 채점</button>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ 채점(확정 전 수정)
  function ensureEdit(R, r) {
    const d = (R.draft && R.draft['r' + r]) || {};
    if (H.edit && H.edit.round === r && H.edit.draftAt === d.at) return;
    let items;
    if (H.edit && H.edit.round === r && d.status === 'done') items = d.items; // 새 AI 결과
    else items = (R.scores && R.scores['r' + r]) || d.items || {};
    H.edit = { round: r, draftAt: d.at, items: clone(items) || {} };
  }

  function stageScoring(R) {
    const r = R.state.round;
    const S_ = S();
    const d = (R.draft && R.draft['r' + r]) || {};
    ensureEdit(R, r);
    const loading = d.status === 'loading' && H.aiRunning;
    let status = '';
    if (loading) status = `<div class="ai-status loading"><span class="spinner"></span> AI가 모든 조의 문장을 읽고 채점하는 중…</div>`;
    else if (d.status === 'loading') status = `<div class="ai-status error">AI 채점이 중간에 멈췄어요. 다시 시도하거나 직접 입력해 주세요.</div>`;
    else if (d.status === 'error') status = `<div class="ai-status error">⚠️ AI 채점 실패: ${esc(d.error || '')}<br>점수를 직접 입력하거나 다시 시도해 주세요.</div>`;
    else if (d.status === 'done') status = `<div class="ai-status ok">🤖 AI 채점 완료${d.missing && d.missing.length ? ` · 빠진 조가 있어 직접 채워 주세요` : ''} — 확정 전에 고칠 수 있어요</div>`;
    else status = `<div class="ai-status">✍️ 점수를 직접 입력해 주세요 (빈칸은 0점)</div>`;
    const tids = SSG.roundTeams(R, r);
    const rows = tids.map(tid => {
      const pieces = SSG.teamSentence(R, r, tid);
      const e = H.edit.items[tid] || {};
      const v = (x) => (x === undefined || x === null || x === '' ? '' : x);
      return `
        <tr data-tid="${tid}">
          <td class="st-team">${R.teams[tid].no}조</td>
          <td class="st-sent">${pieces.map(p => `<span class="w part-${partKey(p.part)} ${p.text ? '' : 'is-empty'}">${p.text ? esc(p.text) : '(빈칸)'}</span>`).join(' ')}</td>
          <td><input class="num" type="number" inputmode="numeric" min="0" max="${S_.maxGrammar}" data-f="g" value="${v(e.g)}" ${loading ? 'disabled' : ''}></td>
          <td><input class="num" type="number" inputmode="numeric" min="0" max="${S_.maxContext}" data-f="c" value="${v(e.c)}" ${loading ? 'disabled' : ''}></td>
          <td class="st-sum" data-sum>${SSG.roundScore(e)}</td>
          <td><input class="reason" type="text" maxlength="80" data-f="reason" value="${esc(e.reason || '')}" placeholder="한 줄 이유 (선택)" ${loading ? 'disabled' : ''}></td>
        </tr>`;
    }).join('');
    const hasKey = SSG.AI.getKey() && SSG.AI.getModel();
    return `
      <section class="scoring">
        <div class="scoring-head">
          <h1 class="stage-title">ROUND ${r + 1} 채점</h1>
          ${status}
        </div>
        <div class="table-wrap" data-fit="list" data-n="${tids.length + 1}" data-h="2.75" data-max="0.016">
          <table class="score-table">
            <thead><tr><th>조</th><th>문장</th><th>적격성<small>/${S_.maxGrammar}</small></th><th>문맥<small>/${S_.maxContext}</small></th><th>합계</th><th>한 줄 이유</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="stage-actions">
          <button class="btn" data-act="backToReveal" ${loading ? 'disabled' : ''}>◀ 문장 다시 보기</button>
          ${hasKey ? `<button class="btn" data-act="aiScore" ${loading ? 'disabled' : ''}>🤖 ${d.status === 'done' ? 'AI 다시 채점' : 'AI 채점'}</button>` : ''}
          <button class="btn btn-primary btn-lg" data-act="confirmScores" ${loading ? 'disabled' : ''}>점수 확정 ✓</button>
        </div>
      </section>`;
  }

  function wireScoring(R) {
    const S_ = S();
    $$('.score-table tr[data-tid]').forEach(tr => {
      const tid = tr.dataset.tid;
      tr.addEventListener('input', (e) => {
        const f = e.target.dataset.f;
        if (!f) return;
        H.edit.items[tid] = H.edit.items[tid] || {};
        if (f === 'reason') H.edit.items[tid].reason = e.target.value;
        else {
          const max = f === 'g' ? S_.maxGrammar : S_.maxContext;
          let v = e.target.value === '' ? '' : Math.round(Number(e.target.value));
          if (v !== '' && (!Number.isFinite(v) || v < 0)) v = 0;
          if (v !== '' && v > max) { v = max; e.target.value = max; }
          H.edit.items[tid][f] = v;
        }
        $('[data-sum]', tr).textContent = SSG.roundScore(H.edit.items[tid]);
      });
    });
  }

  // ------------------------------------------------------------ 라운드 결과
  function stageScored(R) {
    const r = R.state.round;
    const info = SSG.roundInfo(R, r);
    return `
      <section class="reveal">
        <div class="reveal-head">
          <span class="round-no round-no-sm">ROUND ${r + 1} 결과</span>
          <div class="situation situation-sm">${esc(info.situation)}</div>
        </div>
        ${sentenceCards(R, r, true)}
        <div class="stage-actions">
          <button class="btn" data-act="backToScoring">◀ 점수 고치기</button>
          <button class="btn btn-primary btn-lg" data-act="showRanking" data-primary>누적 순위 보기 ▶</button>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ 순위
  function rankList(R, showDelta) {
    const list = SSG.ranking(R);
    const r = (R.state && R.state.round) || 0;
    const max = Math.max(1, ...list.map(x => x.total));
    return `<ol class="rank-list" data-fit="list" data-n="${list.length || 1}" data-h="2.6" data-max="0.03">
      ${list.map((x, i) => {
        const sc = R.scores && R.scores['r' + r] && R.scores['r' + r][x.tid];
        return `<li class="rank-row ${x.rank === 1 ? 'is-first' : ''}" style="--i:${i}">
          <span class="rank-no">${x.rank}</span>
          <span class="rank-team">${x.no}조</span>
          <span class="rank-names">${teamNames(R.teams[x.tid]).map(esc).join(' · ')}</span>
          <span class="rank-bar"><span style="width:${Math.round((x.total / max) * 100)}%"></span></span>
          <span class="rank-total">${x.total}점</span>
          ${showDelta ? `<span class="rank-delta">${sc ? '+' + SSG.roundScore(sc) : ''}</span>` : ''}
        </li>`;
      }).join('')}
    </ol>`;
  }

  function stageRanking(R) {
    const r = R.state.round;
    const last = r >= S().rounds.length - 1;
    return `
      <section class="ranking">
        <h1 class="stage-title">${r + 1}라운드까지 순위</h1>
        ${rankList(R, true)}
        <div class="stage-actions">
          <button class="btn btn-primary btn-lg" data-act="next" data-primary>${last ? '최종 결과 보기 🏆' : `${r + 2}라운드 시작 ▶`}</button>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ 최종
  function playedRounds(R) {
    const out = [];
    Object.keys(R.roundInfo || {}).forEach(k => out.push(Number(k.slice(1))));
    return out.sort((a, b) => a - b);
  }

  function stageFinal(R) {
    const list = SSG.ranking(R);
    const winners = list.filter(x => x.rank === 1);
    const tab = H.finalTab;
    let body = '';
    if (tab === 'rank') {
      body = `
        <div class="winner">
          <div class="winner-emoji">🏆</div>
          <div class="winner-title">${winners.map(w => w.no + '조').join(' · ')} ${winners.length > 1 ? '공동 우승!' : '우승!'}</div>
          <div class="winner-names">${winners.map(w => teamNames(R.teams[w.tid]).map(esc).join(' · ')).join(' / ')}</div>
          <div class="winner-score">${winners.length ? winners[0].total + '점' : ''}</div>
        </div>
        ${rankList(R, false)}`;
    } else if (tab === 'story') {
      const tids = list.map(x => x.tid);
      if (!H.storyTid || tids.indexOf(H.storyTid) < 0) H.storyTid = tids[0] || '';
      const tid = H.storyTid;
      const rounds = playedRounds(R);
      body = `
        <div class="story-tabs">${tids.map(t => `<button class="btn btn-sm ${t === tid ? 'btn-primary' : ''}" data-act="story" data-tid="${t}">${R.teams[t].no}조</button>`).join('')}</div>
        ${tid ? `
        <div class="story">
          <div class="story-head"><b>${R.teams[tid].no}조의 이야기</b> <span class="muted">${teamNames(R.teams[tid]).map(esc).join(' · ')}</span></div>
          ${rounds.map(r => {
            const info = SSG.roundInfo(R, r);
            const pieces = (R.roles && R.roles['r' + r] && R.roles['r' + r][tid]) ? SSG.teamSentence(R, r, tid) : null;
            const sc = R.scores && R.scores['r' + r] && R.scores['r' + r][tid];
            return `<div class="story-line">
              <div class="story-sit">${r + 1}. ${esc(info.situation)}</div>
              <div class="story-sent">${pieces ? pieces.map(p => `<span class="w part-${partKey(p.part)} ${p.text ? '' : 'is-empty'}">${p.text ? esc(p.text) : '(빈칸)'}</span>`).join(' ') : '<span class="muted">(참여 전)</span>'}
                ${sc ? `<span class="story-score">+${SSG.roundScore(sc)}</span>` : ''}</div>
            </div>`;
          }).join('')}
          <div class="story-nav">
            <button class="btn" data-act="storyStep" data-d="-1">◀ 이전 조</button>
            <button class="btn" data-act="storyStep" data-d="1">다음 조 ▶</button>
          </div>
        </div>` : ''}`;
    } else {
      const rounds = playedRounds(R);
      const tids = list.map(x => x.tid);
      body = `
        <div class="table-wrap">
          <table class="all-table">
            <thead><tr><th>조</th>${rounds.map(r => `<th>${r + 1}라운드</th>`).join('')}<th>합계</th></tr></thead>
            <tbody>${tids.map(tid => `<tr>
              <td class="st-team">${R.teams[tid].no}조</td>
              ${rounds.map(r => {
                const has = R.roles && R.roles['r' + r] && R.roles['r' + r][tid];
                const sc = R.scores && R.scores['r' + r] && R.scores['r' + r][tid];
                return `<td>${has ? esc(SSG.sentenceText(SSG.teamSentence(R, r, tid))) : '-'}${sc ? ` <b class="mini-score">+${SSG.roundScore(sc)}</b>` : ''}</td>`;
              }).join('')}
              <td class="st-sum">${(list.find(x => x.tid === tid) || {}).total || 0}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;
    }
    return `
      <section class="final">
        <div class="final-tabs">
          <button class="btn ${tab === 'rank' ? 'btn-primary' : ''}" data-act="finalTab" data-tab="rank">🏆 최종 순위</button>
          <button class="btn ${tab === 'story' ? 'btn-primary' : ''}" data-act="finalTab" data-tab="story">📖 조별 이야기</button>
          <button class="btn ${tab === 'all' ? 'btn-primary' : ''}" data-act="finalTab" data-tab="all">📋 전체 문장</button>
          <button class="btn btn-sm final-del" data-act="deleteRoom" title="참가자 이름과 문장을 데이터베이스에서 지워요">🗑 기록 지우고 끝내기</button>
        </div>
        <div class="final-body final-${tab}">${body}</div>
      </section>`;
  }

  // ============================================================ 게임 진행 동작
  async function formTeams() {
    const R = H.R;
    const pids = Object.keys(R.players || {});
    if (!pids.length) return;
    const teams = SSG.makeTeams(pids);
    await update({ teams, state: { phase: 'teams', round: 0 } });
  }

  async function startRound(r) {
    const R = H.R;
    const S_ = S();
    const info = S_.rounds[r];
    if (!info) return;
    const roles = SSG.rolesForRound(R.teams || {}, r, info.parts.length);
    const t = now();
    H.lastBeep = -1;
    await update({
      ['roundInfo/r' + r]: info,
      ['roles/r' + r]: roles,
      ['answers/r' + r]: null,
      ['draft/r' + r]: null,
      ['scores/r' + r]: null,
      state: { phase: 'input', round: r, startedAt: t, deadline: t + S_.timer * 1000 },
    });
    beep(523, 0.15);
  }

  async function closeInput() {
    await update({ 'state/phase': 'reveal', 'state/closedAt': now() });
    beep(392, 0.4, 0.2);
  }

  function aiInput(R, r) {
    const info = SSG.roundInfo(R, r);
    const S_ = S();
    return {
      situation: info.situation,
      parts: info.parts,
      teams: SSG.roundTeams(R, r).map(tid => ({ tid, no: R.teams[tid].no, pieces: SSG.teamSentence(R, r, tid) })),
      maxGrammar: S_.maxGrammar,
      maxContext: S_.maxContext,
      extra: LS.get(KEYS.extra, ''),
    };
  }

  async function aiScore() {
    const R = H.R;
    const r = R.state.round;
    if (!SSG.AI.getKey() || !SSG.AI.getModel()) {
      toast('설정에서 Gemini API 키와 모델을 먼저 넣어 주세요. 지금은 직접 채점할 수 있어요.', 'warn', 5000);
      return;
    }
    H.aiRunning = true;
    const input = aiInput(R, r);
    await update({ 'state/phase': 'scoring', ['draft/r' + r]: { status: 'loading', at: now() } });
    // AI 응답을 기다리는 동안에도 다른 버튼(전체 화면 등)이 막히지 않게 기다리지 않고 돌린다.
    SSG.AI.scoreRound(input).then(res => {
      H.aiRunning = false;
      return update({ ['draft/r' + r]: { status: 'done', at: now(), model: res.model, items: res.items, missing: res.missing } });
    }, e => {
      H.aiRunning = false;
      console.error(e);
      return update({ ['draft/r' + r]: { status: 'error', at: now(), error: String(e.message || e).slice(0, 300) } });
    }).catch(e => toast(e.message, 'error'));
  }

  async function manualScore() {
    const r = H.R.state.round;
    const d = H.R.draft && H.R.draft['r' + r];
    const upd = { 'state/phase': 'scoring' };
    if (!d) upd['draft/r' + r] = { status: 'manual', at: now() };
    await update(upd);
  }

  async function confirmScores() {
    const R = H.R;
    const r = R.state.round;
    const S_ = S();
    const items = {};
    const int = (v, max) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0; };
    SSG.roundTeams(R, r).forEach(tid => {
      const e = (H.edit && H.edit.items[tid]) || {};
      items[tid] = { g: int(e.g, S_.maxGrammar), c: int(e.c, S_.maxContext), reason: String(e.reason || '').trim().slice(0, 80) };
    });
    await update({ ['scores/r' + r]: items, 'state/phase': 'scored' });
    beep(784, 0.2);
  }

  async function next() {
    const R = H.R;
    const r = R.state.round;
    if (r + 1 < S().rounds.length) await startRound(r + 1);
    else {
      H.finalTab = 'rank';
      await update({ 'state/phase': 'final' });
      beep(523, 0.15); setTimeout(() => beep(659, 0.15), 160); setTimeout(() => beep(784, 0.3), 320);
    }
  }

  async function removePlayer(pid) {
    const R = H.R;
    const upd = { ['players/' + pid]: null };
    Object.keys(R.teams || {}).forEach(tid => {
      const m = toArray(R.teams[tid].members);
      if (m.indexOf(pid) >= 0) {
        const rest = m.filter(x => x !== pid);
        upd['teams/' + tid] = rest.length ? { no: R.teams[tid].no, members: rest } : null;
      }
    });
    await update(upd);
  }

  async function addBots(n) {
    const R = H.R;
    const used = new Set(Object.values(R.players || {}).map(p => p.name));
    const upd = {};
    let k = 0;
    const t = now();
    for (let i = 0; i < n; i++) {
      let name;
      do {
        const base = SSG.BOT_NAMES[k % SSG.BOT_NAMES.length];
        const round = Math.floor(k / SSG.BOT_NAMES.length);
        name = '🤖' + base + (round ? round + 1 : '');
        k++;
      } while (used.has(name));
      used.add(name);
      upd['players/bot' + SSG.randomId(8)] = { name, joined: t + i, bot: true };
    }
    await update(upd);
    toast(`봇 ${n}명을 추가했어요.`);
  }

  // ============================================================ 자동 진행(타이머 마감, 늦은 입장, 봇)
  function automate() {
    const R = H.R;
    if (!H.store || !R || !R.state || isPassive()) return;
    const st = R.state;
    if (st.phase === 'input') {
      const r = st.round;
      const flag = R.meta.created + ':close:' + r;
      if (!H.flags[flag]) {
        const t = now();
        const all = allSubmitted(R, r);
        if (all && !H.allSince[flag]) H.allSince[flag] = t;
        if (!all) H.allSince[flag] = 0;
        // 마감 직전 자동 제출을 받으려고 0.8초 더 기다린다. 전원 제출이면 1.2초 뒤 마감.
        if (t >= st.deadline + 800 || (all && t - H.allSince[flag] > 1200)) {
          H.flags[flag] = true;
          closeInput().catch(e => { H.flags[flag] = false; toast(e.message, 'error'); });
        }
      }
      scheduleBots(R, r);
    }
    if (st.phase && st.phase !== 'lobby' && st.phase !== 'final') placeLatecomers(R);
  }

  function placeLatecomers(R) {
    if (H.placing) return;
    const assigned = new Set();
    Object.values(R.teams || {}).forEach(t => toArray(t.members).forEach(p => assigned.add(p)));
    const late = Object.keys(R.players || {}).filter(pid => !assigned.has(pid))
      .sort((a, b) => (R.players[a].joined || 0) - (R.players[b].joined || 0));
    if (!late.length) return;
    const teams = clone(R.teams || {});
    const upd = {};
    late.forEach(pid => {
      const res = SSG.placeLatePlayer(teams, pid);
      teams[res.tid] = res.team;
      upd['teams/' + res.tid] = res.team;
    });
    H.placing = true;
    update(upd).catch(e => toast(e.message, 'error')).finally(() => { H.placing = false; });
  }

  function scheduleBots(R, r) {
    const roles = (R.roles && R.roles['r' + r]) || {};
    const S_ = S();
    Object.keys(roles).forEach(tid => {
      toArray(roles[tid]).forEach((pid, s) => {
        const p = R.players && R.players[pid];
        if (!p || !p.bot) return;
        const key = R.meta.created + ':' + r + ':' + tid + ':' + s;
        if (H.botTimers.has(key)) return;
        const ans = R.answers && R.answers['r' + r] && R.answers['r' + r][tid] && R.answers['r' + r][tid]['s' + s];
        if (ans) { H.botTimers.set(key, 0); return; }
        const maxDelay = Math.max(2500, Math.min(12000, (S_.timer - 5) * 1000));
        const delay = 1500 + Math.random() * (maxDelay - 1500);
        H.botTimers.set(key, setTimeout(() => botSubmit(r, tid, s, pid), delay));
      });
    });
  }

  function botSubmit(r, tid, s, pid) {
    const R = H.R;
    if (!R || !R.state || R.state.phase !== 'input' || R.state.round !== r || !R.players || !R.players[pid]) return;
    if (H.botBlank && Math.random() < 0.1) return; // 가끔 빈칸 남기기
    const info = SSG.roundInfo(R, r);
    update({ ['answers/r' + r + '/' + tid + '/s' + s]: { text: SSG.botAnswer(info.parts[s], info.parts), pid, at: now() } })
      .catch(e => console.warn('봇 제출 실패', e));
  }

  // ============================================================ 모달: QR, 참가자, 설정
  function openModal(name, html) {
    H.modal = name;
    const m = $('#modal');
    m.innerHTML = html;
    m.hidden = false;
  }
  function closeModal() {
    H.modal = '';
    $('#modal').hidden = true;
    $('#modal').innerHTML = '';
  }

  function showQR() {
    const url = playUrl();
    openModal('qr', `
      <div class="modal modal-qr">
        <div class="modal-head"><h2>참가 QR코드 · 방 ${esc(H.code)}</h2><button class="x" data-act="closeModal">✕</button></div>
        <div class="qr qr-big">${qrSvg(url)}</div>
        <p class="qr-url">${esc(url)}</p>
        <div class="modal-actions">
          <button class="btn" data-act="copyLink">🔗 링크 복사</button>
          <button class="btn btn-primary" data-act="closeModal">닫기</button>
        </div>
      </div>`);
  }

  function renderPeople() {
    const R = H.R;
    if (!R) return;
    const players = R.players || {};
    const assigned = new Set();
    const teamBlocks = sortedTeamIds(R).map(tid => {
      const m = toArray(R.teams[tid].members);
      m.forEach(p => assigned.add(p));
      return `<div class="pp-team"><b>${R.teams[tid].no}조</b> ${m.map(pid => personChip(pid, players[pid])).join('')}</div>`;
    }).join('');
    const rest = Object.keys(players).filter(pid => !assigned.has(pid))
      .sort((a, b) => (players[a].joined || 0) - (players[b].joined || 0));
    const body = $('#peopleBody');
    if (!body) return;
    body.innerHTML = `
      <div class="pp-count">입장 <b>${Object.keys(players).length}</b>명 (봇 ${Object.values(players).filter(p => p.bot).length}명)</div>
      ${teamBlocks}
      ${rest.length ? `<div class="pp-team"><b>${R.teams ? '조 배정 대기' : '입장한 사람'}</b> ${rest.map(pid => personChip(pid, players[pid])).join('')}</div>` : ''}
      ${!Object.keys(players).length ? '<p class="muted">아직 아무도 없어요.</p>' : ''}`;
  }

  function personChip(pid, p) {
    if (!p) return '';
    return `<span class="pp-chip ${p.bot ? 'is-bot' : ''}">${esc(p.name)}<button class="pp-x" data-act="removePlayer" data-pid="${esc(pid)}" title="내보내기">✕</button></span>`;
  }

  function openPeople() {
    openModal('people', `
      <div class="modal modal-wide">
        <div class="modal-head"><h2>👥 참가자 · 봇</h2><button class="x" data-act="closeModal">✕</button></div>
        <div class="modal-body">
          <div class="bot-row">
            <span>🤖 가짜 참가자(봇) 추가</span>
            <button class="btn btn-sm" data-act="addBots" data-n="1">+1</button>
            <button class="btn btn-sm" data-act="addBots" data-n="3">+3</button>
            <button class="btn btn-sm" data-act="addBots" data-n="5">+5</button>
            <button class="btn btn-sm" data-act="addBots" data-n="10">+10</button>
            <button class="btn btn-sm" data-act="removeBots">봇 모두 내보내기</button>
          </div>
          <label class="check-line"><input type="checkbox" id="botBlank" ${H.botBlank ? 'checked' : ''}> 봇이 가끔(10%) 칸을 비워 두기 — 빈칸 공개·채점을 시험할 때</label>
          <p class="muted small">봇은 1~12초 안에 미리 정해 둔 낱말을 무작위로 제출해요. 조 편성 뒤에 넣으면 늦게 온 사람처럼 2명 조부터 채워요.
            ✕를 누르면 그 사람을 내보내요(나간 사람 칸은 빈칸이 돼요).</p>
          <div id="peopleBody"></div>
        </div>
      </div>`);
    $('#botBlank').addEventListener('change', (e) => { H.botBlank = e.target.checked; LS.set(KEYS.botBlank, H.botBlank); });
    renderPeople();
  }

  // ------------------------------------------------------------ 설정
  let draftRounds = null;

  function openSettings() {
    const conn = H.conn;
    draftRounds = clone(H.settings.rounds);
    const models = LS.get(KEYS.models, []);
    const cur = SSG.AI.getModel();
    const st = H.settings;
    openModal('settings', `
      <div class="modal modal-wide settings">
        <div class="modal-head"><h2>⚙ 설정</h2><button class="x" data-act="closeModal">✕</button></div>
        <div class="modal-body">
          <section>
            <h3>1. 연결 방식</h3>
            <label class="radio"><input type="radio" name="mode" value="firebase" ${conn.mode === 'firebase' ? 'checked' : ''}>
              <span><b>Firebase</b> — 실제 수업용. 참가자가 각자 폰으로 들어와요.</span></label>
            <div class="field indent">
              <label for="setDb">Firebase Realtime Database 주소</label>
              <div class="row">
                <input id="setDb" type="url" spellcheck="false" placeholder="https://프로젝트이름-default-rtdb.asia-southeast1.firebasedatabase.app" value="${esc(conn.db || '')}">
                <button class="btn btn-sm" data-act="testDb">연결 테스트</button>
              </div>
              <p class="result" id="dbResult"></p>
              ${configDb() ? `<p class="muted small">사이트 기본 주소(js/config.js): ${esc(configDb())}
                ${configDb() !== SSG.normalizeDbUrl(conn.db) ? '<button class="btn btn-xs" data-act="useConfigDb">기본 주소로</button>' : ''}</p>` : ''}
            </div>
            <label class="radio"><input type="radio" name="mode" value="local" ${conn.mode === 'local' ? 'checked' : ''}>
              <span><b>로컬 테스트 모드</b> — Firebase 없이 이 브라우저의 여러 탭으로 리허설해요. (다른 기기는 못 들어와요)</span></label>
          </section>

          <section>
            <h3>2. AI 채점 (Gemini)</h3>
            <div class="field">
              <label for="setKey">Gemini API 키 <small>이 브라우저에만 저장되고, QR·데이터베이스에는 절대 들어가지 않아요</small></label>
              <div class="row">
                <input id="setKey" type="password" spellcheck="false" autocomplete="off" value="${esc(SSG.AI.getKey())}" placeholder="AIza로 시작하는 키">
                <button class="btn btn-sm" data-act="toggleKey">보기</button>
              </div>
            </div>
            <div class="field">
              <label for="setModel">AI 모델</label>
              <div class="row">
                <select id="setModel">${modelOptions(models, cur)}</select>
                <button class="btn btn-sm" data-act="loadModels">모델 목록 불러오기</button>
                <button class="btn btn-sm" data-act="pingAI">AI 연결 확인</button>
              </div>
              <p class="result" id="aiResult"></p>
            </div>
            <div class="field">
              <label for="setExtra">AI에게 덧붙일 말 <small>(선택) 예: 신조어나 밈도 너그럽게 봐 줘</small></label>
              <textarea id="setExtra" rows="2">${esc(LS.get(KEYS.extra, ''))}</textarea>
            </div>
          </section>

          <section>
            <h3>3. 게임 규칙</h3>
            <div class="row rules">
              <label>제한시간 <input id="setTimer" type="number" min="10" max="600" value="${st.timer}"> 초</label>
              <label>적격성 만점 <input id="setMaxG" type="number" min="0" max="100" value="${st.maxGrammar}"> 점</label>
              <label>문맥 만점 <input id="setMaxC" type="number" min="0" max="100" value="${st.maxContext}"> 점</label>
            </div>
          </section>

          <section>
            <h3>4. 라운드 <small>(성분은 2~4개. 3명 조라면 3개가 딱 맞아요)</small></h3>
            <div id="roundsEditor"></div>
            <div class="row">
              <button class="btn btn-sm" data-act="addRound">+ 라운드 추가</button>
              <button class="btn btn-sm" data-act="resetRounds">기본 라운드로 되돌리기</button>
            </div>
            ${H.store ? '<p class="muted small">저장하면 진행 중인 게임의 <b>다음 라운드부터</b> 바로 반영돼요. (이미 시작한 라운드는 그대로)</p>' : ''}
          </section>

          <section>
            <h3>5. 다른 기기로 설정 옮기기</h3>
            <p class="muted small">링크를 복사해서 새 노트북에서 열면 위 설정(연결, AI 키·모델, 규칙, 라운드)이 한 번에 들어가요.
              카카오톡 ‘나와의 채팅’이나 북마크에 넣어 두세요. 링크는 화면에 표시하지 않고 바로 복사만 해요.</p>
            <label class="check-line"><input type="checkbox" id="linkKey" checked> Gemini API 키도 넣기
              <span class="muted small">— 키가 든 링크는 다른 사람에게 보내지 마세요</span></label>
            <div class="row">
              <button class="btn btn-sm" data-act="copySetupLink">🔗 자동 설정 링크 복사</button>
              <span class="muted small">지금 이 창에 입력한 값 그대로 담겨요(저장 전이어도 돼요).</span>
            </div>
            <p class="result" id="linkResult"></p>
          </section>
        </div>
        <div class="modal-actions">
          <button class="btn" data-act="closeModal">취소</button>
          <button class="btn btn-primary" data-act="saveSettings">저장</button>
        </div>
      </div>`);
    renderRoundsEditor();
  }

  function modelOptions(models, cur) {
    const list = models.slice();
    if (cur && !list.some(m => m.name === cur)) list.unshift({ name: cur, label: cur.replace('models/', '') });
    if (!list.length) return '<option value="">(키를 넣고 [모델 목록 불러오기]를 눌러 주세요)</option>';
    return list.map(m => `<option value="${esc(m.name)}" ${m.name === cur ? 'selected' : ''}>${esc(m.label)} — ${esc(m.name.replace('models/', ''))}</option>`).join('');
  }

  function renderRoundsEditor() {
    const box = $('#roundsEditor');
    if (!box) return;
    const opts = (sel) => SSG.PART_NAMES.map(p => `<option ${p === sel ? 'selected' : ''}>${p}</option>`).join('');
    box.innerHTML = draftRounds.map((r, i) => `
      <div class="re-row">
        <div class="re-no">${i + 1}</div>
        <div class="re-main">
          <textarea data-re="situation" data-i="${i}" rows="2" maxlength="200" placeholder="상황 문장">${esc(r.situation)}</textarea>
          <div class="re-parts">
            ${r.parts.map((p, j) => `${j ? '<span class="plus">+</span>' : ''}<select data-re="part" data-i="${i}" data-j="${j}">${opts(p)}</select>`).join('')}
            <button class="btn btn-xs" data-act="rePart" data-i="${i}" data-d="1" ${r.parts.length >= 4 ? 'disabled' : ''} title="성분 추가">＋</button>
            <button class="btn btn-xs" data-act="rePart" data-i="${i}" data-d="-1" ${r.parts.length <= 2 ? 'disabled' : ''} title="성분 빼기">－</button>
          </div>
        </div>
        <button class="btn btn-xs re-del" data-act="reDel" data-i="${i}" ${draftRounds.length <= 1 ? 'disabled' : ''}>삭제</button>
      </div>`).join('');
  }

  // ------------------------------------------------------------ 자동 설정 링크
  // 링크 모양: 사이트주소#setup=<설정 JSON을 base64url로>
  // '#' 뒤는 서버로 전송되지 않고 GitHub에도 올라가지 않는다. 열면 바로 주소창에서 지운다.
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function copySetupLink() {
    const out = $('#linkResult');
    const mode = ($('input[name=mode]:checked') || {}).value || '';
    const payload = {
      v: 1,
      conn: { mode, db: mode === 'firebase' ? SSG.normalizeDbUrl($('#setDb').value) : '' },
      settings: SSG.sanitizeSettings({ timer: $('#setTimer').value, maxGrammar: $('#setMaxG').value, maxContext: $('#setMaxC').value, rounds: draftRounds }),
      model: $('#setModel').value || '',
      extra: $('#setExtra').value.trim().slice(0, 300),
    };
    const key = $('#setKey').value.trim();
    if ($('#linkKey').checked && key) payload.key = key;
    const base = location.origin + location.pathname;
    const link = base + '#setup=' + b64urlEncode(JSON.stringify(payload));
    let copied = false;
    try { await navigator.clipboard.writeText(link); copied = true; } catch (e) { /* 아래에서 다시 */ }
    if (!copied) {
      // 클립보드를 못 쓰는 환경: 직접 복사할 수 있게 창으로 보여 준다
      prompt('아래 링크를 복사하세요 (Ctrl+C)', link);
    }
    out.className = 'result ok';
    out.textContent = (copied ? '✅ 복사했어요. ' : '') + (payload.key ? 'API 키가 들어 있는 링크예요. 나만 보관하세요.' : 'API 키는 넣지 않았어요.') +
      (location.protocol === 'file:' ? ' ⚠️ 지금은 내려받은 파일로 열어서, 이 링크는 이 컴퓨터에서만 열려요. 배포한 사이트 주소에서 다시 만들어 주세요.' : '');
  }

  /** 주소에 #setup=… 이 있으면 설정을 불러온다. */
  function applySetupFromHash() {
    const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)$/);
    if (!m) return false;
    // 키가 주소창·방문 기록에 남지 않게 바로 지운다
    history.replaceState(null, '', location.pathname + location.search);
    let data;
    try { data = JSON.parse(b64urlDecode(m[1])); } catch (e) {
      toast('자동 설정 링크가 잘못됐어요. 링크를 끝까지 복사했는지 확인해 주세요.', 'error', 6000);
      return false;
    }
    const what = ['연결 방식', '규칙·라운드'];
    if (data.key) what.push('Gemini API 키');
    if (!confirm('자동 설정 링크로 이 브라우저의 설정을 바꿀까요?\n(' + what.join(', ') + ')')) return false;
    if (data.conn && (data.conn.mode === 'firebase' || data.conn.mode === 'local')) {
      H.conn = { mode: data.conn.mode, db: data.conn.mode === 'firebase' ? SSG.normalizeDbUrl(data.conn.db) : '' };
      LS.set(KEYS.conn, H.conn);
    }
    if (data.settings) {
      H.settings = SSG.sanitizeSettings(data.settings);
      LS.set(KEYS.settings, H.settings);
    }
    if (data.key) SSG.AI.setKey(String(data.key).trim());
    if (data.model) SSG.AI.setModel(String(data.model));
    if (typeof data.extra === 'string') LS.set(KEYS.extra, data.extra.slice(0, 300));
    toast('설정을 불러왔어요.' + (data.key ? '' : ' AI 키는 ⚙ 설정에서 넣어 주세요.'), '', 5000);
    return true;
  }

  async function saveSettings() {
    const mode = ($('input[name=mode]:checked') || {}).value || '';
    const dbRaw = $('#setDb').value;
    const db = SSG.normalizeDbUrl(dbRaw);
    if (mode === 'firebase' && !db) { toast('Firebase 주소를 넣어 주세요.', 'warn'); $('#setDb').focus(); return; }
    if (mode === 'firebase' && !SSG.isLikelyDbUrl(db)) {
      if (!confirm('Firebase Realtime Database 주소처럼 보이지 않아요.\n(보통 firebaseio.com 또는 firebasedatabase.app 으로 끝나요)\n그래도 저장할까요?')) return;
    }
    const newConn = { mode, db: mode === 'firebase' ? db : '' };
    const key = $('#setKey').value.trim();
    SSG.AI.setKey(key);
    SSG.AI.setModel($('#setModel').value || '');
    LS.set(KEYS.extra, $('#setExtra').value.trim().slice(0, 300));
    const settings = SSG.sanitizeSettings({
      timer: $('#setTimer').value,
      maxGrammar: $('#setMaxG').value,
      maxContext: $('#setMaxC').value,
      rounds: draftRounds,
    });
    const dropped = draftRounds.length - settings.rounds.length;
    H.settings = settings;
    LS.set(KEYS.settings, settings);
    const connChanged = newConn.mode !== H.conn.mode || newConn.db !== H.conn.db;
    H.conn = newConn;
    LS.set(KEYS.conn, newConn);
    closeModal();
    if (H.store && H.R) {
      await update({ 'meta/settings': settings });
      if (connChanged) toast('연결 방식은 [새 게임]부터 적용돼요.', 'warn', 5000);
      else toast('저장했어요. 진행 중인 게임에도 반영했어요.');
    } else {
      toast('저장했어요.');
      render();
    }
    if (dropped > 0) toast(`상황이 비었거나 성분이 2개 미만인 라운드 ${dropped}개는 빠졌어요.`, 'warn', 5000);
  }

  async function testDb() {
    const out = $('#dbResult');
    out.className = 'result';
    out.textContent = '확인하는 중…';
    try {
      await SSG.testFirebase($('#setDb').value);
      out.className = 'result ok';
      out.textContent = '✅ 연결 성공! 읽기·쓰기 모두 돼요.';
      $('input[name=mode][value=firebase]').checked = true;
    } catch (e) {
      out.className = 'result bad';
      out.textContent = '❌ ' + e.message;
    }
  }

  async function loadModels() {
    const out = $('#aiResult');
    const key = $('#setKey').value.trim();
    if (!key) { out.className = 'result bad'; out.textContent = '먼저 API 키를 넣어 주세요.'; return; }
    out.className = 'result';
    out.textContent = '모델 목록을 불러오는 중…';
    try {
      const models = await SSG.AI.listModels(key);
      LS.set(KEYS.models, models);
      const sel = $('#setModel');
      const cur = sel.value && models.some(m => m.name === sel.value) ? sel.value : (models[0] && models[0].name) || '';
      sel.innerHTML = modelOptions(models, cur);
      out.className = 'result ok';
      out.textContent = `✅ 모델 ${models.length}개를 불러왔어요. 맨 위(추천)를 쓰면 무난해요.`;
    } catch (e) {
      out.className = 'result bad';
      out.textContent = '❌ ' + e.message;
    }
  }

  async function pingAI() {
    const out = $('#aiResult');
    const key = $('#setKey').value.trim();
    const model = $('#setModel').value;
    if (!key || !model) { out.className = 'result bad'; out.textContent = '키와 모델을 먼저 정해 주세요.'; return; }
    out.className = 'result';
    out.textContent = 'AI에게 물어보는 중…';
    try {
      const reply = await SSG.AI.ping(key, model);
      out.className = 'result ok';
      out.textContent = '✅ AI 응답: ' + reply;
    } catch (e) {
      out.className = 'result bad';
      out.textContent = '❌ ' + e.message;
    }
  }

  // ============================================================ 버튼 처리
  const ACTIONS = {
    newGame: () => createGame(),
    newGameConfirm: () => {
      if (!confirm('지금 게임을 닫고 처음 화면으로 갈까요?\n(이 방의 기록은 남아 있어요. 다시 들어올 수는 없어요)')) return;
      LS.del(KEYS.room);
      detach();
      closeModal();
      render();
    },
    openSettings: () => openSettings(),
    closeModal: () => closeModal(),
    saveSettings: () => saveSettings(),
    testDb: () => testDb(),
    loadModels: () => loadModels(),
    pingAI: () => pingAI(),
    useConfigDb: () => {
      $('#setDb').value = configDb();
      $('input[name=mode][value=firebase]').checked = true;
    },
    copySetupLink: () => copySetupLink(),
    toggleKey: (el) => { const i = $('#setKey'); i.type = i.type === 'password' ? 'text' : 'password'; el.textContent = i.type === 'password' ? '보기' : '숨기기'; },
    addRound: () => { draftRounds.push({ situation: '', parts: ['주어', '부사어', '서술어'] }); renderRoundsEditor(); },
    resetRounds: () => { if (confirm('라운드를 기본 5개로 되돌릴까요?')) { draftRounds = clone(SSG.DEFAULT_ROUNDS); renderRoundsEditor(); } },
    reDel: (el) => { draftRounds.splice(Number(el.dataset.i), 1); renderRoundsEditor(); },
    rePart: (el) => {
      const r = draftRounds[Number(el.dataset.i)];
      if (Number(el.dataset.d) > 0 && r.parts.length < 4) r.parts.push('부사어');
      if (Number(el.dataset.d) < 0 && r.parts.length > 2) r.parts.pop();
      renderRoundsEditor();
    },
    formTeams: () => formTeams(),
    reshuffle: () => formTeams(),
    startRound: (el) => startRound(Number(el.dataset.round)),
    extend: () => { H.lastBeep = -1; return update({ 'state/deadline': Math.max(H.R.state.deadline, now()) + 15000 }); },
    closeNow: () => { const f = H.R.meta.created + ':close:' + H.R.state.round; H.flags[f] = true; return closeInput(); },
    aiScore: () => aiScore(),
    manualScore: () => manualScore(),
    confirmScores: () => confirmScores(),
    backToReveal: () => update({ 'state/phase': 'reveal' }),
    backToScoring: () => { H.edit = null; return update({ 'state/phase': 'scoring' }); },
    showRanking: () => update({ 'state/phase': 'ranking' }),
    next: () => next(),
    finalTab: (el) => { H.finalTab = el.dataset.tab; H.sig = ''; render(); },
    story: (el) => { H.storyTid = el.dataset.tid; H.sig = ''; render(); },
    storyStep: (el) => {
      const ids = SSG.ranking(H.R).map(x => x.tid);
      const i = ids.indexOf(H.storyTid);
      H.storyTid = ids[(i + Number(el.dataset.d) + ids.length) % ids.length];
      H.sig = ''; render();
    },
    showQR: () => showQR(),
    copyLink: async () => {
      try { await navigator.clipboard.writeText(playUrl()); toast('참가 링크를 복사했어요.'); }
      catch (e) { prompt('아래 링크를 복사하세요', playUrl()); }
    },
    openPeople: () => openPeople(),
    addBots: (el) => addBots(Number(el.dataset.n)),
    removeBots: () => {
      const pids = Object.keys(H.R.players || {}).filter(pid => H.R.players[pid].bot);
      if (!pids.length) return;
      // 한 번에 지우면 조 정보가 꼬일 수 있어 차례로 지운다
      return pids.reduce((p, pid) => p.then(() => removePlayer(pid)), Promise.resolve());
    },
    removePlayer: (el) => {
      const pid = el.dataset.pid;
      const name = playerName(pid);
      if (confirm(`'${name}'님을 내보낼까요?\n(이번 라운드에 맡은 칸은 빈칸이 돼요)`)) return removePlayer(pid);
    },
    openPlayerTab: () => window.open(playUrl(), '_blank'),
    toggleSound: () => { H.sound = !H.sound; LS.set(KEYS.sound, H.sound); renderTopbar(); if (H.sound) beep(880, 0.1); },
    fullscreen: () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    },
    takeover: () => update({ 'meta/host': H.hostId }),
    deleteRoom: async () => {
      if (!confirm('이 방의 기록(참가자 이름, 문장, 점수)을 데이터베이스에서 모두 지울까요?\n지우면 되돌릴 수 없어요. 결과 화면이 필요하면 먼저 사진을 찍어 두세요.')) return;
      await H.store.removeRoom();
      LS.del(KEYS.room);
    },
  };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    // 진행 버튼을 연달아 눌러도 한 번만 처리
    const gameAct = el.closest('#stage') || el.closest('#passive');
    if (gameAct) {
      if (H.busy) return;
      H.busy = true;
    }
    try {
      await fn(el);
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), 'error', 6000);
    } finally {
      if (gameAct) setTimeout(() => { H.busy = false; }, 250);
    }
  });

  // 설정 화면: 라운드 편집 입력
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset || !t.dataset.re || !draftRounds) return;
    const r = draftRounds[Number(t.dataset.i)];
    if (!r) return;
    if (t.dataset.re === 'situation') r.situation = t.value;
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.dataset || t.dataset.re !== 'part' || !draftRounds) return;
    const r = draftRounds[Number(t.dataset.i)];
    if (r) r.parts[Number(t.dataset.j)] = t.value;
  });

  // 발표용 리모컨(→, PageDown, Space)으로 다음 단계 버튼 누르기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && H.modal) { closeModal(); return; }
    if (H.modal) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(tag)) return;
    if (['ArrowRight', 'PageDown', ' ', 'Enter'].indexOf(e.key) < 0) return;
    const btn = $('#stage [data-primary]');
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  });

  // ============================================================ 시작
  async function boot() {
    applySetupFromHash();
    render();
    setInterval(() => { automate(); tickTimer(); }, 250);
    const ok = await resume();
    if (!ok) render();
  }

  // 테스트와 디버깅용
  window.SSG_HOST = H;
  boot();
})();
