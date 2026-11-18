/* Gemini API로 AI 채점. 호스트 화면에서만 쓴다.
 * API 키는 호스트 브라우저 localStorage에만 두고, 요청 헤더(x-goog-api-key)로만 보낸다. */
(function (root) {
  'use strict';
  const SSG = root.SSG;
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';

  const KEY_STORE = 'ssg-gemini-key';
  const MODEL_STORE = 'ssg-gemini-model';

  function getKey() { return SSG.LS.get(KEY_STORE, '') || ''; }
  function setKey(k) { if (k) SSG.LS.set(KEY_STORE, k); else SSG.LS.del(KEY_STORE); }
  function getModel() { return SSG.LS.get(MODEL_STORE, '') || ''; }
  function setModel(m) { if (m) SSG.LS.set(MODEL_STORE, m); else SSG.LS.del(MODEL_STORE); }

  async function call(path, opts, timeoutMs) {
    const key = (opts && opts.key) || getKey();
    if (!key) throw new Error('Gemini API 키가 없어요. 설정에서 넣어 주세요.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    let res;
    try {
      res = await fetch(BASE + path, {
        method: opts.body ? 'POST' : 'GET',
        headers: Object.assign({ 'x-goog-api-key': key }, opts.body ? { 'Content-Type': 'application/json' } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('AI 응답이 너무 오래 걸려요. 다시 시도하거나 직접 채점해 주세요.');
      throw new Error('AI 서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      const err = new Error(explain(res.status, msg));
      err.status = res.status;
      err.raw = msg;
      throw err;
    }
    return data;
  }

  function explain(status, msg) {
    if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) return 'API 키가 올바르지 않아요. 키를 다시 복사해 넣어 주세요.';
    if (status === 403) return 'API 키 권한 문제예요. (' + msg + ')';
    if (status === 404) return '이 모델을 찾을 수 없어요. 설정에서 모델 목록을 다시 불러와 주세요.';
    if (status === 429) return '무료 사용량 한도에 걸렸어요. 1분쯤 뒤에 다시 시도하거나 다른 모델을 골라 주세요.';
    if (status >= 500) return 'AI 서버가 잠시 불안정해요. 다시 시도해 주세요. (' + status + ')';
    return msg;
  }

  /** generateContent를 쓸 수 있는 Gemini 모델 목록. 추천 모델(flash 계열)을 앞에 둔다. */
  async function listModels(key) {
    const all = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const data = await call('/models?pageSize=1000' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { key }, 20000);
      (data.models || []).forEach(m => all.push(m));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    const skip = /(embedding|aqa|tts|image|imagen|veo|live|audio|vision|robotics|computer-use|learnlm)/i;
    const models = all
      .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
      .filter(m => /gemini|gemma/i.test(m.name) && !skip.test(m.name))
      .map(m => ({ name: m.name, label: m.displayName || m.name.replace('models/', ''), desc: m.description || '' }));
    const score = (m) => {
      const n = m.name;
      let s = 0;
      if (/gemma/.test(n)) s -= 50;
      if (/flash/.test(n)) s += 20;
      if (/lite/.test(n)) s -= 3;
      if (/latest/.test(n)) s += 2;
      if (/preview|exp/.test(n)) s -= 8;
      const v = n.match(/gemini-(\d+(?:\.\d+)?)/);
      if (v) s += parseFloat(v[1]) * 10;
      return s;
    };
    models.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
    return models;
  }

  function buildPrompt(input) {
    const lines = [];
    lines.push('[상황]');
    lines.push(input.situation);
    lines.push('');
    lines.push('[문장 구조] ' + input.parts.join(' + '));
    lines.push('');
    lines.push('[조별 문장]  (빈칸)은 시간 안에 아무것도 쓰지 않은 칸');
    input.teams.forEach(t => {
      const pieces = t.pieces.map(p => '[' + p.part + '] ' + (p.text ? p.text : '(빈칸)')).join(' / ');
      const full = t.pieces.filter(p => p.text).map(p => p.text).join(' ');
      lines.push(t.no + '조: ' + pieces + '  →  "' + (full || '(전부 빈칸)') + '"');
    });
    lines.push('');
    if (input.parts.indexOf('주어') < 0) {
      lines.push('※ 이번 문장 구조에는 주어 칸이 없다. 주어는 [상황]의 마지막 부분에 이미 나와 있으니, 상황 끝의 주어와 이어서 한 문장으로 읽고 판단한다.');
      lines.push('');
    }
    lines.push('[채점 기준] 세 항목을 따로 매긴다.');
    lines.push('1) context = 상황 (0~' + input.maxContext + '점): 제시된 [상황]에 맞게 자연스럽게 이어지는가. 상황 속 장소·인물·사건과 어울리는가.');
    lines.push('2) grammar = 구조 (0~' + input.maxGrammar + '점): 문장 구조가 알맞은가. 각 칸이 지정된 문장 성분 역할을 하는가(조사·어미까지 확인), 성분끼리 호응하는가.');
    lines.push('   - 목적어가 있으면 서술어가 목적어를 받는 말(먹다, 꺼내다 등)이어야 한다. 목적어가 없으면 서술어가 목적어 없이 쓰일 수 있어야 한다.');
    lines.push('   - 관형어는 뒤의 명사를 꾸미는 꼴(-ㄴ, -는, -의 등)이어야 한다. 부사어는 서술어를 꾸며야 한다. 주어는 이/가(께서)가 자연스러워야 한다.');
    lines.push('   - 주어와 서술어, 높임, 시제가 서로 어울리는가.');
    lines.push('3) wit = 재치 (0~' + input.maxWit + '점): 엉뚱하지만 그럴듯한 조합, 예상을 뒤집는 반전, 웃음이 나는 표현인가. 평범하고 뻔하면 낮게.');
    lines.push('- 빈칸이 있으면 세 항목 모두 그만큼 깎는다. 모두 빈칸이면 모두 0점.');
    lines.push('');
    lines.push('[채점 방법]');
    lines.push('- 모든 조의 문장을 서로 비교해서 상대적으로 평가한다. 더 나은 문장에 더 높은 점수를 주고, 점수가 한두 값에 몰리지 않도록 범위를 넓게 쓴다. 정말 비슷하면 동점도 괜찮다.');
    lines.push('- 각 칸은 서로 보지 못한 채 따로 쓴 것이다. 우연히 잘 맞아떨어진 조합을 칭찬해 줘라.');
    lines.push('- reason: 조마다 한국어 한 줄(45자 이내). 점수의 핵심 이유를 친근하고 재치 있게. 반말 금지, "~요" 체.');
    if (input.extra) {
      lines.push('');
      lines.push('[진행자 추가 지시]');
      lines.push(input.extra);
    }
    lines.push('');
    lines.push('반드시 아래 JSON 형식으로만 답한다. 모든 조(' + input.teams.map(t => t.no).join(', ') + '조)를 빠짐없이 포함한다.');
    lines.push('{"results":[{"team":조번호,"context":정수,"grammar":정수,"wit":정수,"reason":"한 줄 이유"}]}');
    return lines.join('\n');
  }

  const SYSTEM = '너는 대학 수업에서 진행하는 자기소개용 \'문장 성분 조합 게임\'의 공정하고 유쾌한 심사위원이다. ' +
    '한국어 문법(문장 성분: 주어, 서술어, 목적어, 보어, 관형어, 부사어, 독립어)을 정확히 알고 있다.';

  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      results: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            team: { type: 'INTEGER' },
            context: { type: 'INTEGER' },
            grammar: { type: 'INTEGER' },
            wit: { type: 'INTEGER' },
            reason: { type: 'STRING' },
          },
          required: ['team', 'context', 'grammar', 'wit', 'reason'],
        },
      },
    },
    required: ['results'],
  };

  function extractText(data) {
    const cand = data && data.candidates && data.candidates[0];
    if (!cand) {
      const block = data && data.promptFeedback && data.promptFeedback.blockReason;
      throw new Error(block ? 'AI가 응답을 거부했어요 (' + block + '). 직접 채점해 주세요.' : 'AI 응답이 비어 있어요.');
    }
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    if (!text) throw new Error('AI 응답이 비어 있어요 (' + (cand.finishReason || '이유 모름') + ').');
    return text;
  }

  function parseJson(text) {
    let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) { /* 아래에서 다시 */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 실패 */ }
    }
    throw new Error('AI 응답을 읽지 못했어요. 다시 시도하거나 직접 채점해 주세요.');
  }

  /** 한 라운드 채점.
   * input: { situation, parts, teams:[{tid,no,pieces:[{part,text}]}], maxContext, maxGrammar, maxWit, extra }
   * 결과: { model, items: { tid: {g, c, reason} }, missing: [tid...] } */
  async function scoreRound(input) {
    const model = getModel();
    if (!model) throw new Error('AI 모델을 고르지 않았어요. 설정에서 [모델 목록 불러오기] 후 골라 주세요.');
    const prompt = buildPrompt(input);
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, responseMimeType: 'application/json', responseSchema: SCHEMA },
    };
    let data;
    try {
      data = await call('/' + model + ':generateContent', { body }, 90000);
    } catch (e) {
      // 일부 모델은 responseSchema를 받지 않는다 → 스키마 없이 한 번 더
      if (e.status === 400 && !/API key/i.test(e.raw || '')) {
        delete body.generationConfig.responseSchema;
        data = await call('/' + model + ':generateContent', { body }, 90000);
      } else {
        throw e;
      }
    }
    const parsed = parseJson(extractText(data));
    const results = Array.isArray(parsed) ? parsed : (parsed.results || []);
    const clamp = (v, max) => {
      v = Math.round(Number(v));
      return Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0;
    };
    const items = {};
    input.teams.forEach(t => {
      const r = results.find(x => Number(x.team) === t.no || String(x.team).replace(/\D/g, '') === String(t.no));
      if (r) {
        items[t.tid] = {
          c: clamp(r.context, input.maxContext),
          g: clamp(r.grammar, input.maxGrammar),
          w: clamp(r.wit, input.maxWit),
          reason: String(r.reason || '').trim().slice(0, 80),
        };
      }
    });
    const missing = input.teams.filter(t => !items[t.tid]).map(t => t.tid);
    return { model, items, missing };
  }

  /** 설정 화면의 [AI 연결 확인] */
  async function ping(key, model) {
    const data = await call('/' + model + ':generateContent', {
      key,
      body: { contents: [{ role: 'user', parts: [{ text: '"좋아요" 한 단어로만 답해 주세요.' }] }] },
    }, 30000);
    return extractText(data).trim().slice(0, 40);
  }

  SSG.AI = { getKey, setKey, getModel, setModel, listModels, scoreRound, ping, buildPrompt };
})(window);
