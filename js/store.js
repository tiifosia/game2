/* 실시간 저장소 두 가지
 *  - LocalStore   : Firebase 없이 한 브라우저의 여러 탭끼리 localStorage로 주고받는 리허설용
 *  - FirebaseStore: Firebase Realtime Database (실제 수업용)
 * 두 저장소는 같은 모양으로 쓴다.
 *   store.subscribe(cb)  방 전체 데이터가 바뀔 때마다 cb(room) 호출, 해제 함수를 돌려줌
 *   store.update({ 'a/b': 값, ... })  여러 경로를 한 번에 쓰기 (null이면 지움)
 *   store.now()          서버 기준 현재 시각(ms)
 *   store.onStatus(cb)   연결 상태(true/false)
 */
(function (root) {
  'use strict';
  const SSG = root.SSG;

  function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }

  function isEmpty(v) {
    return v == null || (typeof v === 'object' && Object.keys(v).length === 0);
  }

  /** obj 안의 'a/b/c' 경로에 값을 쓴다. null이나 빈 객체면 지우고, 비어 버린 부모도 정리한다. */
  function setPath(obj, path, value) {
    const keys = path.split('/').filter(Boolean);
    if (!keys.length) return isEmpty(value) ? {} : clone(value);
    const stack = [];
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
        if (isEmpty(value)) return obj;
        cur[keys[i]] = {};
      }
      stack.push([cur, keys[i]]);
      cur = cur[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (isEmpty(value)) {
      if (Array.isArray(cur)) cur[last] = null; else delete cur[last];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [parent, k] = stack[i];
        if (isEmpty(parent[k])) delete parent[k]; else break;
      }
    } else {
      cur[last] = clone(value);
    }
    return obj;
  }

  // ======================================================== LocalStore
  class LocalStore {
    constructor(room) {
      this.mode = 'local';
      this.room = room;
      this.key = 'ssg-local:' + room;
      this.subs = new Set();
      this.data = this._read();
      this._onStorage = (e) => {
        if (e.key === this.key) { this.data = this._read(); this._emit(); }
      };
      root.addEventListener('storage', this._onStorage);
    }
    _read() {
      try { return JSON.parse(root.localStorage.getItem(this.key)) || null; } catch (e) { return null; }
    }
    _emit() { this.subs.forEach(cb => { try { cb(this.data); } catch (e) { console.error(e); } }); }
    subscribe(cb) {
      this.subs.add(cb);
      setTimeout(() => cb(this.data), 0);
      return () => this.subs.delete(cb);
    }
    onStatus(cb) { setTimeout(() => cb(true), 0); }
    onError() { /* 로컬은 오류 없음 */ }
    now() { return Date.now(); }
    async once() { this.data = this._read(); return this.data; }
    async update(obj) {
      const run = () => {
        let data = this._read() || {};
        Object.keys(obj).forEach(p => { data = setPath(data, p, obj[p]); });
        if (isEmpty(data)) root.localStorage.removeItem(this.key);
        else root.localStorage.setItem(this.key, JSON.stringify(data));
        this.data = isEmpty(data) ? null : data;
      };
      // 여러 탭이 동시에 쓰면 덮어쓸 수 있어서 Web Locks로 한 번에 하나씩 쓴다.
      if (root.navigator && root.navigator.locks) {
        await root.navigator.locks.request(this.key, () => run());
      } else {
        run();
      }
      this._emit();
    }
    async removeRoom() { root.localStorage.removeItem(this.key); this.data = null; this._emit(); }
    close() { root.removeEventListener('storage', this._onStorage); this.subs.clear(); }
  }

  // ======================================================== FirebaseStore
  let sdkPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(src + ' 파일을 불러오지 못했어요.'));
      document.head.appendChild(s);
    });
  }
  function loadFirebaseSdk() {
    if (root.firebase && root.firebase.database) return Promise.resolve(root.firebase);
    if (!sdkPromise) {
      sdkPromise = loadScript('lib/firebase-app-compat.js')
        .then(() => loadScript('lib/firebase-database-compat.js'))
        .then(() => root.firebase)
        .catch(e => { sdkPromise = null; throw e; });
    }
    return sdkPromise;
  }

  function appFor(fb, dbUrl) {
    const name = 'ssg-' + dbUrl.replace(/[^a-z0-9]/gi, '_');
    const found = fb.apps.find(a => a.name === name);
    return found || fb.initializeApp({ databaseURL: dbUrl }, name);
  }

  function friendlyFirebaseError(e) {
    const msg = String((e && (e.code || e.message)) || e);
    if (/permission[_ -]denied/i.test(msg)) return '권한이 없어요. Firebase 보안 규칙을 README대로 붙여넣고 [게시]했는지 확인해 주세요.';
    return msg;
  }

  class FirebaseStore {
    constructor(fb, dbUrl, room) {
      this.mode = 'firebase';
      this.dbUrl = dbUrl;
      this.room = room;
      this.offset = 0;
      this.app = appFor(fb, dbUrl);
      this.db = this.app.database();
      this.ref = this.db.ref('rooms/' + room);
      this._offRef = this.db.ref('.info/serverTimeOffset');
      this._offCb = this._offRef.on('value', s => { this.offset = Number(s.val()) || 0; });
      this.errorCbs = new Set();
      this._connRef = null;
      this._connCbs = [];
    }
    subscribe(cb) {
      const handler = this.ref.on('value', s => cb(s.val()), err => {
        this.errorCbs.forEach(f => f(friendlyFirebaseError(err)));
      });
      return () => this.ref.off('value', handler);
    }
    onStatus(cb) {
      this._connRef = this._connRef || this.db.ref('.info/connected');
      const h = this._connRef.on('value', s => cb(!!s.val()));
      this._connCbs.push(h);
    }
    onError(cb) { this.errorCbs.add(cb); }
    now() { return Date.now() + this.offset; }
    once() { return this.ref.once('value').then(s => s.val()); }
    update(obj) {
      return this.ref.update(obj).catch(e => { throw new Error(friendlyFirebaseError(e)); });
    }
    removeRoom() { return this.ref.remove(); }
    close() {
      this.ref.off();
      this._offRef.off('value', this._offCb);
      if (this._connRef) this._connCbs.forEach(h => this._connRef.off('value', h));
      this._connCbs = [];
      this.errorCbs.clear();
    }
  }

  /** 저장소 연결. opts: { mode: 'local'|'firebase', db, room } */
  async function connect(opts) {
    if (opts.mode === 'local') return new LocalStore(opts.room);
    const db = SSG.normalizeDbUrl(opts.db);
    if (!db) throw new Error('Firebase 주소가 비어 있거나 형식이 맞지 않아요.');
    const fb = await loadFirebaseSdk();
    try {
      return new FirebaseStore(fb, db, opts.room);
    } catch (e) {
      throw new Error('Firebase 주소를 확인해 주세요. (' + (e.message || e) + ')');
    }
  }

  function withTimeout(promise, ms, msg) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  }

  /** 설정 화면의 [연결 테스트]: 읽기·쓰기·지우기를 한 번씩 해 본다. */
  async function testFirebase(dbUrl) {
    const db = SSG.normalizeDbUrl(dbUrl);
    if (!db) throw new Error('주소가 비어 있거나 형식이 맞지 않아요.');
    const fb = await loadFirebaseSdk();
    let app;
    try { app = appFor(fb, db); } catch (e) { throw new Error('주소 형식이 맞지 않아요. (' + (e.message || e) + ')'); }
    const ref = app.database().ref('rooms/TEST');
    const timeoutMsg = '10초 안에 응답이 없어요. 주소가 맞는지, 인터넷이 되는지 확인해 주세요.';
    try {
      await withTimeout(ref.once('value'), 10000, timeoutMsg);
      await withTimeout(ref.update({ ping: Date.now() }), 10000, timeoutMsg);
      await withTimeout(ref.remove(), 10000, timeoutMsg);
    } catch (e) {
      throw new Error(friendlyFirebaseError(e));
    }
    return true;
  }

  SSG.connect = connect;
  SSG.testFirebase = testFirebase;
  SSG._setPath = setPath;
})(window);
