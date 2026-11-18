/* 문장 성분 조합 게임 — 호스트와 참가자가 함께 쓰는 공통 코드
 * 브라우저에서는 window.SSG, Node(테스트)에서는 module.exports 로 쓴다. */
(function (root) {
  'use strict';

  const SSG = root.SSG || {};

  // ---------------------------------------------------------------- 문장 성분
  // q: 묻는 말, desc: 뜻, ex: 예시. 폰 입력칸 아래 한 줄 힌트로 보여 준다.
  const PARTS = {
    '주어':   { key: 'subj', q: '누가 / 무엇이',            desc: '문장의 주인공',                 ex: '고양이가, 우리 반 반장이' },
    '서술어': { key: 'pred', q: '어찌하다 / 어떠하다',        desc: '주어의 움직임이나 상태를 풀이',   ex: '도망쳤다, 반짝였다' },
    '목적어': { key: 'obj',  q: '무엇을 / 누구를',            desc: '움직임의 대상',                 ex: '우유를, 비밀 편지를' },
    '보어':   { key: 'comp', q: '무엇이 (되다·아니다)',        desc: "'되다·아니다' 앞에서 뜻을 채움",   ex: '외계인이, 사람이' },
    '관형어': { key: 'adn',  q: '어떤 / 누구의',              desc: '뒤에 오는 명사를 꾸밈',           ex: '거대한, 우리 엄마의' },
    '부사어': { key: 'adv',  q: '어떻게 / 언제 / 어디서',       desc: '서술어를 꾸밈',                 ex: '갑자기, 부엌에서' },
    '독립어': { key: 'ind',  q: '감탄 / 부름 / 대답',          desc: '다른 말과 따로 떨어져 쓰임',      ex: '앗, 여보세요' },
  };
  const PART_NAMES = Object.keys(PARTS);

  /** 라운드 구조에 맞춘 한 줄 힌트. 보어가 있는 문장의 서술어는 '되다/아니다' 꼴로 안내한다. */
  function partHint(part, parts) {
    const p = PARTS[part] || { q: '', desc: '', ex: '' };
    if (part === '서술어' && parts && parts.indexOf('보어') >= 0) {
      return { q: "'되다' 또는 '아니다'", desc: '보어와 짝을 이루는 서술어', ex: '되었다, 아니었다' };
    }
    return { q: p.q, desc: p.desc, ex: p.ex };
  }

  // ---------------------------------------------------------------- 기본 설정
  const DEFAULT_ROUNDS = [
    { situation: '아침에 알람 소리에 겨우 눈을 떴더니 천장에서…', parts: ['주어', '부사어', '서술어'] },
    { situation: '밤 11시, 출출해서 동네 편의점에 갔다. 문을 여는 순간…', parts: ['주어', '목적어', '서술어'] },
    { situation: '소원을 빌며 동전을 던지자 분수 속에서…', parts: ['관형어', '주어', '서술어'] },
    { situation: '전국 요리 대회 결승전, 심사위원 앞에서 세계 최고의 요리사는…', parts: ['관형어', '목적어', '서술어'] },
    { situation: '마법에 걸려 백 년 동안 잠들다가 깨어난 공주는…', parts: ['부사어', '목적어', '서술어'] },
  ];

  // 예전 기본 라운드. 브라우저에 이것이 그대로 저장돼 있으면 새 기본 라운드로 바꿔 준다.
  const OLD_DEFAULT_ROUNDS = [
    { situation: '어느 평범한 월요일 아침, 냉장고 문을 열었더니…', parts: ['주어', '부사어', '서술어'] },
    { situation: '이 소식은 순식간에 퍼져 대통령의 귀에까지 들어갔다. 대통령은…', parts: ['목적어', '부사어', '서술어'] },
    { situation: '그날 밤, 하늘에서 거대한 그림자가 천천히 내려왔다. 그림자 속에서…', parts: ['관형어', '주어', '서술어'] },
    { situation: '모두가 숨을 죽인 순간, 누군가 외쳤다. "잠깐! 사실은…"', parts: ['주어', '보어', '서술어'] },
    { situation: '그리고 다음 날 아침, 냉장고 문을 다시 열었더니…', parts: ['주어', '목적어', '서술어'] },
  ];

  /** 채점 항목. 키(c, g, w)는 데이터베이스에 저장되는 이름이다. */
  const CRITERIA = [
    { key: 'c', max: 'maxContext', label: '상황', desc: '제시된 상황에 맞게 이어지는가' },
    { key: 'g', max: 'maxGrammar', label: '구조', desc: '문장 구조와 성분 호응이 알맞은가' },
    { key: 'w', max: 'maxWit', label: '재치', desc: '재치 있고 재미있는가' },
  ];

  function defaultSettings() {
    return {
      timer: 60,          // 입력 제한시간(초)
      maxContext: 5,      // 상황 만점: 제시된 상황에 맞는가
      maxGrammar: 5,      // 구조 만점: 문장 구조·성분 호응이 알맞은가
      maxWit: 5,          // 재치 만점
      rounds: JSON.parse(JSON.stringify(DEFAULT_ROUNDS)),
    };
  }

  /** 잘못된 값이 섞여 있어도 쓸 수 있는 설정으로 고친다. */
  function sanitizeSettings(s) {
    const d = defaultSettings();
    s = s || {};
    const num = (v, lo, hi, def) => {
      v = Math.round(Number(v));
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
    };
    const out = {
      timer: num(s.timer, 10, 600, d.timer),
      maxContext: num(s.maxContext, 0, 100, d.maxContext),
      maxGrammar: num(s.maxGrammar, 0, 100, d.maxGrammar),
      maxWit: num(s.maxWit, 0, 100, d.maxWit),
      rounds: [],
    };
    if (out.maxGrammar + out.maxContext + out.maxWit === 0) {
      out.maxContext = d.maxContext; out.maxGrammar = d.maxGrammar; out.maxWit = d.maxWit;
    }
    const rounds = toArray(s.rounds);
    for (const r of rounds) {
      if (!r) continue;
      const parts = toArray(r.parts).filter(p => PARTS[p]).slice(0, 4);
      const situation = String(r.situation || '').trim().slice(0, 200);
      if (parts.length >= 2 && situation) out.rounds.push({ situation, parts });
    }
    if (!out.rounds.length) out.rounds = d.rounds;
    return out;
  }

  /** 브라우저에 예전 기본 라운드가 그대로 저장돼 있으면 새 기본 라운드로 바꾼다(직접 고친 라운드는 그대로 둔다). */
  function migrateSettings(s) {
    s = sanitizeSettings(s);
    if (JSON.stringify(s.rounds) === JSON.stringify(OLD_DEFAULT_ROUNDS)) s.rounds = JSON.parse(JSON.stringify(DEFAULT_ROUNDS));
    return s;
  }

  function maxTotal(settings) {
    return CRITERIA.reduce((sum, k) => sum + (Number(settings[k.max]) || 0), 0);
  }

  // ---------------------------------------------------------------- 작은 도구들
  /** Firebase는 배열을 객체로 돌려줄 때가 있어서 항상 배열로 바꿔 쓴다. */
  function toArray(x) {
    if (Array.isArray(x)) return x.filter(v => v !== undefined && v !== null);
    if (x && typeof x === 'object') {
      return Object.keys(x).sort((a, b) => Number(a) - Number(b)).map(k => x[k]).filter(v => v !== undefined && v !== null);
    }
    return [];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function randomId(len) {
    const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
    let s = '';
    const buf = (root.crypto && root.crypto.getRandomValues) ? root.crypto.getRandomValues(new Uint32Array(len)) : null;
    for (let i = 0; i < len; i++) s += chars[(buf ? buf[i] : Math.floor(Math.random() * 1e9)) % chars.length];
    return s;
  }

  function roomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I, O 제외 (1, 0과 헷갈림)
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function shuffle(arr, rand) {
    rand = rand || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** Firebase 주소를 정리한다. 'xxx.firebasedatabase.app' 처럼 https:// 없이 넣어도 된다. */
  function normalizeDbUrl(url) {
    url = String(url || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const u = new URL(url);
      const ns = u.searchParams.get('ns');
      // 에뮬레이터(http://127.0.0.1:9000/?ns=xxx)는 ns를 남긴다.
      return u.protocol + '//' + u.host + (ns ? '/?ns=' + encodeURIComponent(ns) : '');
    } catch (e) {
      return '';
    }
  }

  function isLikelyDbUrl(url) {
    try {
      const u = new URL(url);
      return /(\.firebaseio\.com|\.firebasedatabase\.app)$/.test(u.hostname) ||
        ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.searchParams.get('ns'));
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- 조 편성
  /** 인원별 조 크기. 3명 조를 기본으로, 남으면 2명 조를 만든다. 4명 조는 만들지 않는다. */
  function teamSizes(n) {
    if (n <= 0) return [];
    if (n <= 3) return [n];
    const r = n % 3;
    if (r === 0) return new Array(n / 3).fill(3);
    if (r === 2) return new Array((n - 2) / 3).fill(3).concat([2]);
    return new Array((n - 4) / 3).fill(3).concat([2, 2]); // r === 1
  }

  /** pid 목록을 무작위로 섞어 조를 만든다. 결과: { t1: {no:1, members:[...]}, ... } */
  function makeTeams(pids, rand) {
    const shuffled = shuffle(pids, rand);
    const sizes = teamSizes(shuffled.length);
    const teams = {};
    let idx = 0;
    sizes.forEach((size, i) => {
      teams['t' + (i + 1)] = { no: i + 1, members: shuffled.slice(idx, idx + size) };
      idx += size;
    });
    return teams;
  }

  /** 조 편성 뒤 늦게 온 사람을 넣을 조를 고른다.
   * 2명 조 → 1명 조 순서로 채우고(번호가 작은 조부터), 빈 조가 없으면 새 조를 만든다.
   * 돌려주는 값: { tid, team, created } (teams 원본은 바꾸지 않는다) */
  function placeLatePlayer(teams, pid) {
    const list = Object.keys(teams || {}).map(tid => ({ tid, team: teams[tid] }))
      .sort((a, b) => a.team.no - b.team.no);
    for (const want of [2, 1]) {
      const hit = list.find(x => toArray(x.team.members).length === want);
      if (hit) {
        return { tid: hit.tid, team: { no: hit.team.no, members: toArray(hit.team.members).concat([pid]) }, created: false };
      }
    }
    const no = list.reduce((m, x) => Math.max(m, x.team.no), 0) + 1;
    return { tid: 't' + no, team: { no, members: [pid] }, created: true };
  }

  /** 라운드별 성분 담당. 칸 s는 조원[(s + 라운드) % 인원]이 맡는다.
   * 3명 조는 라운드마다 맡는 칸이 한 칸씩 돌아가고, 2명 조는 한 사람이 2칸을 번갈아 맡는다. */
  function rolesForTeam(members, roundIdx, nParts) {
    members = toArray(members);
    const k = members.length;
    if (!k) return [];
    const out = [];
    for (let s = 0; s < nParts; s++) out.push(members[(s + roundIdx) % k]);
    return out;
  }

  function rolesForRound(teams, roundIdx, nParts) {
    const roles = {};
    Object.keys(teams || {}).forEach(tid => {
      const r = rolesForTeam(teams[tid].members, roundIdx, nParts);
      if (r.length) roles[tid] = r;
    });
    return roles;
  }

  // ---------------------------------------------------------------- 점수
  function roundScore(sc) {
    if (!sc) return 0;
    return (Number(sc.c) || 0) + (Number(sc.g) || 0) + (Number(sc.w) || 0);
  }

  /** 확정된 점수 합계. { tid: 합계 } */
  function totals(room) {
    const out = {};
    Object.keys((room && room.teams) || {}).forEach(tid => { out[tid] = 0; });
    const scores = (room && room.scores) || {};
    Object.keys(scores).forEach(rk => {
      const byTeam = scores[rk] || {};
      Object.keys(byTeam).forEach(tid => {
        out[tid] = (out[tid] || 0) + roundScore(byTeam[tid]);
      });
    });
    return out;
  }

  /** 공동 순위(1, 1, 3 …)로 정렬한 목록. [{tid, no, total, rank}] */
  function ranking(room) {
    const t = totals(room);
    const teams = (room && room.teams) || {};
    const list = Object.keys(t).filter(tid => teams[tid]).map(tid => ({ tid, no: teams[tid].no, total: t[tid] }));
    list.sort((a, b) => b.total - a.total || a.no - b.no);
    list.forEach((x, i) => { x.rank = (i > 0 && list[i - 1].total === x.total) ? list[i - 1].rank : i + 1; });
    return list;
  }

  /** 이번 라운드 정보(시작할 때 고정해 둔 것). 없으면 설정에서 가져온다. */
  function roundInfo(room, r) {
    const saved = room && room.roundInfo && room.roundInfo['r' + r];
    if (saved) return { situation: saved.situation, parts: toArray(saved.parts) };
    const rounds = toArray(room && room.meta && room.meta.settings && room.meta.settings.rounds);
    const x = rounds[r];
    return x ? { situation: x.situation, parts: toArray(x.parts) } : null;
  }

  function settingsOf(room) {
    return sanitizeSettings(room && room.meta && room.meta.settings);
  }

  /** 한 조의 한 라운드 문장 조각들. [{part, text, pid, name}] */
  function teamSentence(room, r, tid) {
    const info = roundInfo(room, r);
    if (!info) return [];
    const roles = toArray(room.roles && room.roles['r' + r] && room.roles['r' + r][tid]);
    const ans = (room.answers && room.answers['r' + r] && room.answers['r' + r][tid]) || {};
    const players = room.players || {};
    return info.parts.map((part, s) => {
      const a = ans['s' + s];
      const pid = roles[s];
      const text = a && typeof a.text === 'string' ? a.text.trim() : '';
      return { part, text, pid, name: (players[pid] && players[pid].name) || (pid ? '(나감)' : '') };
    });
  }

  function sentenceText(pieces) {
    return pieces.map(p => p.text || '___').join(' ');
  }

  /** 이번 라운드에 문장을 만드는 조(담당이 정해진 조) 목록, 조 번호순 */
  function roundTeams(room, r) {
    const roles = (room.roles && room.roles['r' + r]) || {};
    const teams = room.teams || {};
    return Object.keys(roles).filter(tid => teams[tid]).sort((a, b) => teams[a].no - teams[b].no);
  }

  // ---------------------------------------------------------------- 봇
  const BOT_WORDS = {
    '주어':   ['고양이가', '우리 교수님이', '냉장고가', '외계인이', '김치가', '펭귄이', '달걀이', '옆집 강아지가'],
    '서술어': ['사라졌다', '노래했다', '도망쳤다', '웃었다', '반짝였다', '잠들었다', '울었다', '춤췄다'],
    '목적어': ['우유를', '비밀을', '대통령을', '달걀을', '편지를', '냉장고를', '김밥을'],
    '보어':   ['외계인이', '고양이가', '대통령이', '김치가', '사람이', '로봇이'],
    '관형어': ['거대한', '반짝이는', '수상한', '작은', '우리 엄마의', '초록색'],
    '부사어': ['갑자기', '조용히', '천천히', '부엌에서', '몰래', '힘차게'],
    '독립어': ['앗', '어머나', '여보세요', '네'],
  };
  const BOT_NAMES = ['로봇김', '봇돌이', '자동이', '삐삐', '기계박', '알파', '베타', '감마', '델타', '오메가',
    '똑똑이', '척척이', '깡통', '볼트', '너트', '나사', '모터', '칩', '램', '코어'];

  function botAnswer(part, parts) {
    if (part === '서술어' && parts && parts.indexOf('보어') >= 0) {
      return ['되었다', '아니었다', '아니다'][Math.floor(Math.random() * 3)];
    }
    if (part === '서술어' && parts && parts.indexOf('목적어') >= 0) {
      const v = ['꺼냈다', '먹었다', '던졌다', '주문했다', '끓였다', '안아 주었다', '숨겼다'];
      return v[Math.floor(Math.random() * v.length)];
    }
    const list = BOT_WORDS[part] || ['무언가'];
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---------------------------------------------------------------- 저장소(localStorage) 안전하게
  const LS = {
    get(key, def) {
      try {
        const v = root.localStorage.getItem(key);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(key, value) {
      try { root.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    del(key) {
      try { root.localStorage.removeItem(key); } catch (e) { /* 무시 */ }
    },
  };

  const LIMITS = { name: 10, answer: 30 };

  Object.assign(SSG, {
    PARTS, PART_NAMES, partHint, DEFAULT_ROUNDS, CRITERIA, defaultSettings, sanitizeSettings, migrateSettings, maxTotal,
    toArray, esc, randomId, roomCode, shuffle, normalizeDbUrl, isLikelyDbUrl,
    teamSizes, makeTeams, placeLatePlayer, rolesForTeam, rolesForRound,
    roundScore, totals, ranking, roundInfo, settingsOf, teamSentence, sentenceText, roundTeams,
    BOT_WORDS, BOT_NAMES, botAnswer, LS, LIMITS,
  });

  root.SSG = SSG;
  if (typeof module !== 'undefined' && module.exports) module.exports = SSG;
})(typeof window !== 'undefined' ? window : globalThis);
