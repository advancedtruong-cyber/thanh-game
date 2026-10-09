/* =========================================================================
   app.js — giao diện + mạng của game "Chinh phục Thành cổ mật mã"

   Hai vai trò hoàn toàn tách biệt:
   • GIÁO VIÊN (máy chiếu): tạo phòng, cài đặt, bắt đầu/kết thúc, xem tiến độ & kết quả.
   • HỌC SINH (điện thoại, 1 điện thoại/đội): chỉ thấy mê cung CỦA ĐỘI MÌNH.

   Mạng: ntfy.sh (SSE + HTTPS POST). Mọi tin đều được KÝ (ECDSA P-256):
   tin điều khiển do khoá của cô ký, nước đi do khoá của từng đội ký.
   Mọi máy đọc cùng một nhật ký và chạy cùng reducer (js/core.js).
   ========================================================================= */
(() => {
  'use strict';
  const C = window.Core;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const media = q => window.matchMedia && window.matchMedia(q).matches;

  /* ------------------------------------------------------------------ */
  /* Lưu trữ cục bộ, tham số URL                                         */
  /* ------------------------------------------------------------------ */
  const LS = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* bỏ qua */ } }
  };
  const qs = new URLSearchParams(location.search);
  // ?ntfy= chỉ để kiểm thử với máy chủ giả trên localhost
  const NTFY = (() => {
    const o = qs.get('ntfy');
    if (o) { try { const u = new URL(o); if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin; } catch { /* bỏ qua */ } }
    return 'https://ntfy.sh';
  })();
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function randId(n, alphabet = ALPHA) {
    const a = new Uint32Array(n); crypto.getRandomValues(a);
    return Array.from(a, x => alphabet[x % alphabet.length]).join('');
  }
  const randToken = n => randId(n, 'abcdefghijklmnopqrstuvwxyz0123456789');

  /* ------------------------------------------------------------------ */
  /* Trạng thái ứng dụng                                                 */
  /* ------------------------------------------------------------------ */
  const App = {
    view: 'landing', role: null, room: null, topic: null,
    st: C.createState(), loading: false, phase: 'connecting',
    key: null,                                  // { pub, priv, privKey, dev }
    cfg: C.normCfg(LS.get('maze.cfg', {})),
    lockUntil: 0, inflight: false,
    summaryGid: null, prevKey: null, lastCd: null,
    replay: null, flash: null, banner: { text: 'Chờ cô giáo bắt đầu…', type: 'info' },
    sfx: LS.get('maze.sfx', true) !== false, bgm: LS.get('maze.bgm', true) !== false,
    conn: 'idle', skews: [], netStart: 0, previewSeed: 'preview-1'
  };
  App.ntfy = NTFY;

  const isHost = () => App.role === 'host';
  const isStudent = () => App.role === 'student';
  const serverNow = () => {
    if (!App.skews.length) return Date.now() / 1000;
    const s = App.skews.slice().sort((a, b) => a - b);
    return Date.now() / 1000 + s[Math.floor(s.length / 2)];
  };
  // Chờ mẫu giờ máy chủ đầu tiên (tới từ SSE trong < 1 giây) để máy có đồng hồ lệch không nhận định sai trạng thái trận
  const clockReady = () => App.skews.length > 0 || Date.now() - App.netStart > 5000;
  const addSkew = serverSec => {
    App.skews.push(serverSec - Date.now() / 1000);
    if (App.skews.length > 9) App.skews.shift();
  };
  const myTeam = () => {
    if (!App.key) return null;
    return C.TEAMS.find(t => App.st.claims[t] && App.st.claims[t].dev === App.key.dev) || null;
  };
  const curRound = () => App.st.round;
  const curStatus = () => App.st.round ? C.roundStatus(App.st.round, serverNow()) : 'none';
  window.__maze = { App, Core: C, status: curStatus, serverNow };   // phục vụ kiểm thử/gỡ lỗi

  /* ------------------------------------------------------------------ */
  /* Mật mã: ký / xác minh                                               */
  /* ------------------------------------------------------------------ */
  const subtle = (window.crypto && window.crypto.subtle) || null;
  const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const pubOnly = j => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });
  const devOf = pub => String(pub && pub.x || '').slice(0, 16);

  async function genKey() {
    const kp = await subtle.generateKey(ALG, true, ['sign', 'verify']);
    return {
      pub: pubOnly(await subtle.exportKey('jwk', kp.publicKey)),
      priv: await subtle.exportKey('jwk', kp.privateKey)
    };
  }
  async function loadKey(storageKey) {
    let k = LS.get(storageKey);
    if (!k || !k.pub || !k.priv) { k = await genKey(); LS.set(storageKey, k); }
    const privKey = await subtle.importKey('jwk', k.priv, ALG, false, ['sign']);
    return { pub: k.pub, priv: k.priv, privKey, dev: devOf(k.pub) };
  }
  const pubCache = new Map();
  async function importPub(jwk) {
    const id = jwk.x + '.' + jwk.y;
    if (!pubCache.has(id)) {
      pubCache.set(id, await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ALG, false, ['verify']));
    }
    return pubCache.get(id);
  }
  async function verify(pubJwk, text, sig) {
    try {
      if (!pubJwk || !pubJwk.x || !pubJwk.y) return false;
      return await subtle.verify(SIGN, await importPub(pubJwk), unb64(sig), new TextEncoder().encode(text));
    } catch { return false; }
  }
  async function sign(privKey, text) {
    return b64(await subtle.sign(SIGN, privKey, new TextEncoder().encode(text)));
  }

  /* ------------------------------------------------------------------ */
  /* Mạng (ntfy.sh)                                                      */
  /* ------------------------------------------------------------------ */
  const Net = { es: null, lastId: null, retry: 0, timer: null, active: false, beat: 0, seen: new Set(), nonces: new Set(), queue: Promise.resolve(), lastStatusToast: 0 };

  function setConn(state) { App.conn = state; renderConn(); }

  function closeNet() {
    Net.active = false;
    if (Net.es) { Net.es.close(); Net.es = null; }
    clearTimeout(Net.timer);
    Net.seen.clear(); Net.nonces.clear(); Net.lastId = null; Net.retry = 0;
    Net.queue = Promise.resolve();
  }

  async function loadHistory() {
    const res = await fetch(`${NTFY}/${App.topic}/json?poll=1&since=all`, { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      await ingest(j);
    }
  }

  function connectSSE() {
    if (!Net.active || Net.es) return;
    const url = `${NTFY}/${App.topic}/sse?since=${encodeURIComponent(Net.lastId || 'all')}`;
    const es = new EventSource(url);
    Net.es = es;
    Net.beat = Date.now();
    es.onopen = () => { Net.retry = 0; Net.beat = Date.now(); setConn('online'); };
    es.onmessage = e => { Net.beat = Date.now(); try { ingest(JSON.parse(e.data)); } catch { /* bỏ qua */ } };
    const sample = e => {
      Net.beat = Date.now();
      try { const j = JSON.parse(e.data); if (j && j.time) addSkew(j.time + 0.5); } catch { /* sự kiện open gốc không có data */ }
    };
    es.addEventListener('open', sample);
    es.addEventListener('keepalive', sample);
    es.onerror = () => {
      es.close(); Net.es = null; setConn('retry');
      if (!Net.active) return;
      const delay = Math.min(1000 * Math.pow(2, Net.retry), 8000);
      Net.retry++;
      if (Net.retry >= 3) Net.lastId = null;          // id có thể đã hết hạn: đọc lại từ đầu (đã chống trùng)
      clearTimeout(Net.timer);
      Net.timer = setTimeout(connectSSE, delay);
    };
  }
  function reconnectNow() {
    if (!Net.active) return;
    if (Net.es) { Net.es.close(); Net.es = null; }
    clearTimeout(Net.timer);
    connectSSE();
  }
  setInterval(() => { if (Net.active && Net.es && Date.now() - Net.beat > 110000) reconnectNow(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Net.active && !Net.es) reconnectNow(); else if (!document.hidden) render(); });
  window.addEventListener('online', () => reconnectNow());

  async function openRoom(room) {
    closeNet();
    App.room = room; App.topic = 'thanhgame_' + room.toLowerCase(); App.netStart = Date.now(); App.skews = [];
    App.st = C.createState(); App.loading = true; App.phase = 'connecting';
    App.summaryGid = null; App.prevKey = null; App.replay = null; App.lockUntil = 0; App.inflight = false;
    setConn('connecting');
    for (let attempt = 0; ; attempt++) {
      try { await loadHistory(); break; }
      catch (e) {
        if (attempt >= 2) { App.loading = false; setConn('bad'); throw e; }
        await sleep(800 * (attempt + 1));
        App.st = C.createState(); Net.seen.clear(); Net.nonces.clear(); Net.lastId = null;
      }
    }
    App.loading = false;
    App.phase = App.st.hostPub ? 'ready' : 'noroom';
    Net.active = true;
    connectSSE();
  }

  function ingest(evt) {
    Net.queue = Net.queue.then(() => processEvent(evt)).catch(e => console.warn('ingest', e));
    return Net.queue;
  }

  const HOST_TYPES = new Set(['LOBBY', 'START', 'END', 'KICK']);
  async function processEvent(evt) {
    if (!evt || evt.event !== 'message' || !evt.id || Net.seen.has(evt.id)) return;
    Net.seen.add(evt.id);
    Net.lastId = evt.id;
    let msg, body;
    try { msg = JSON.parse(evt.message); body = JSON.parse(msg.b); } catch { return; }
    if (!body || typeof body.t !== 'string' || typeof body.n !== 'string' || typeof msg.s !== 'string') return;
    if (Net.nonces.has(body.n)) return;               // tin gửi lại / chép lại nguyên văn
    const st = App.st;
    let pub = null;
    if (body.t === 'ROOM') { if (st.hostPub) return; pub = body.pub; }
    else if (HOST_TYPES.has(body.t)) pub = st.hostPub;
    else if (body.t === 'JOIN') { pub = body.pub; if (body.dev !== devOf(body.pub)) return; }
    else if (body.t === 'LEAVE' || body.t === 'PICK') pub = st.claims[body.team] && st.claims[body.team].pub;
    else return;
    if (!pub || !(await verify(pub, msg.b, msg.s))) { st.rejected++; return; }
    Net.nonces.add(body.n);
    const before = Date.now();
    const changed = C.applyEvent(st, { id: evt.id, time: evt.time, body });
    onApplied(body, evt, changed, before);
  }

  async function post(text) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      try {
        const res = await fetch(`${NTFY}/${App.topic}`, { method: 'POST', body: text });
        if (res.status === 429) { const e = new Error('rate'); e.rate = true; throw e; }
        if (!res.ok) throw new Error('http ' + res.status);
        const j = await res.json();
        if (j.time) addSkew(j.time + 0.5 - (Date.now() - t0) / 2000);
        ingest(j);
        return j;
      } catch (e) {
        lastErr = e;
        if (e.rate) break;
        await sleep(350 * (i + 1));
      }
    }
    if (lastErr && lastErr.rate && Date.now() - Net.lastStatusToast > 5000) {
      Net.lastStatusToast = Date.now();
      toast('ntfy.sh đang giới hạn số tin (tối đa 250 tin / 12 giờ cho mỗi địa chỉ mạng). Hãy chờ một lúc hoặc đổi sang mạng 4G.', 'error', 7000);
    }
    throw lastErr || new Error('post');
  }

  async function send(type, payload, privKey) {
    const body = Object.assign({ v: 1, t: type, n: randToken(12) }, payload);
    const b = JSON.stringify(body);
    const s = await sign(privKey, b);
    return post(JSON.stringify({ b, s }));
  }

  /* ------------------------------------------------------------------ */
  /* Phản ứng khi trạng thái thay đổi                                    */
  /* ------------------------------------------------------------------ */
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function onApplied(body, evt, changed, _t) {
    const live = !App.loading;
    const R = curRound();
    const me = myTeam();
    const mine = App.key && body.dev === App.key.dev;
    if (!changed) {
      if (live && body.t === 'PICK' && mine) toast('Lượt chạm này không được ghi nhận (có thể đã hết giờ).', 'error');
      return;
    }
    switch (body.t) {
      case 'START':
        App.replay = null; App.flash = null; App.lockUntil = 0; App.summaryGid = null; App.lastCd = null;
        closeSummary();
        setBanner(isStudent() ? '🚦 Chuẩn bị xuất phát!' : '', 'info');
        break;
      case 'LOBBY':
        App.replay = null; closeSummary(); setBanner('Chờ cô giáo bắt đầu trận mới…', 'info');
        break;
      case 'KICK':
        if (live && isStudent() && App.key && !me && body.team) toast('Cô giáo đã mời bạn ra khỏi đội. Hãy chọn lại đội.', 'error');
        break;
      case 'JOIN':
        if (live && isHost() && body.dev !== (App.key && App.key.dev)) playBeep(660, .12);
        break;
      case 'PICK': {
        if (!R) break;
        const tm = R.teams[body.team];
        const step = tm.steps[tm.steps.length - 1];
        const maze = R.mazes[body.team];
        const cell = maze.cells[step.r][step.c];
        if (mine && live) feedbackOwn(R, tm, step, cell);
        else if (live && tm.finished && step.ok && cell.kind === 'finish') {
          toast(`🏁 ${C.TEAM_META[body.team].name} đã về đích!`, 'success');
          if (isHost()) playWin();
        }
        break;
      }
      default: break;
    }
    scheduleRender();
  }

  function feedbackOwn(R, tm, step, cell) {
    const d = R.cfg.divisor;
    App.flash = { r: step.r, c: step.c, ok: step.ok, until: Date.now() + 700 };
    if (!step.ok) {
      App.lockUntil = Date.now() + C.WRONG_LOCK_MS;
      const pen = R.cfg.penaltySec;
      setBanner(`❌ CHƯA ĐÚNG! ${cell.label} không chia hết cho ${d} (${C.explain(d, cell.val)}). Hãy tính lại!${pen ? ` (+${pen} giây phạt)` : ''}`, 'error');
      playWrong();
    } else if (cell.kind === 'finish') {
      const el = step.rel, s = C.teamSummary(R, myTeam());
      setBanner(`🏆 CHÚC MỪNG! Đội bạn về đích sau ${C.fmtTime(el)}${s.penalty ? ` (+${s.penalty}s phạt = ${C.fmtTime(s.total)})` : ''}!`, 'success');
      playWin();
    } else if (cell.kind === 'start') {
      setBanner('↩️ Bạn đã quay lại ô xuất phát.', 'info');
      playBeep(330, .1);
    } else {
      setBanner(`✅ ĐÚNG! ${cell.label} chia hết cho ${d} (${C.explain(d, cell.val)}).`, 'success');
      playRight();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Âm thanh                                                            */
  /* ------------------------------------------------------------------ */
  let actx = null;
  function audio() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(f, dur = .18, type = 'sine', vol = .1, delay = 0) {
    try {
      const c = audio(), o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.value = f;
      const t = c.currentTime + delay;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(.001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur);
    } catch { /* thiết bị không phát được âm thanh */ }
  }
  function playBeep(f, dur = .18) { if (App.sfx) tone(f, dur); }
  function playRight() { if (App.sfx) { tone(523, .12, 'sine', .1); tone(659, .16, 'sine', .1, .1); } }
  function playWrong() { if (App.sfx) { tone(180, .18, 'sawtooth', .06); tone(140, .22, 'sawtooth', .06, .12); } }
  function playWin() { if (App.sfx) { [523, 659, 784, 1047].forEach((f, i) => tone(f, .22, 'sine', .1, i * .13)); } }
  let bgmTimer = null, bgmStep = 0;
  const BGM_NOTES = [196, 247, 294, 392, 294, 247, 220, 262, 330, 440, 330, 262];
  function startBGM() {
    if (!isHost() || !App.bgm || bgmTimer) return;
    bgmTimer = setInterval(() => { tone(BGM_NOTES[bgmStep++ % BGM_NOTES.length], .38, 'triangle', .035); }, 430);
  }
  function stopBGM() { clearInterval(bgmTimer); bgmTimer = null; }
  document.addEventListener('pointerdown', () => { try { if (actx && actx.state === 'suspended') actx.resume(); } catch { /* bỏ qua */ } }, { passive: true });

  /* ------------------------------------------------------------------ */
  /* Tiện ích giao diện                                                  */
  /* ------------------------------------------------------------------ */
  function toast(text, type = 'info', ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function setBanner(text, type) { App.banner = { text, type }; }
  function askConfirm(title, text, yes = 'Đồng ý') {
    return new Promise(resolve => {
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#confirmYes').textContent = yes;
      const m = $('#confirmModal');
      m.hidden = false;
      const done = v => { m.hidden = true; $('#confirmYes').onclick = $('#confirmNo').onclick = null; resolve(v); };
      $('#confirmYes').onclick = () => done(true);
      $('#confirmNo').onclick = () => done(false);
    });
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Đã sao chép link!', 'success'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Đã sao chép link!', 'success'); } catch { toast(text); }
      ta.remove();
    }
  }
  const studentLink = () => `${location.origin}${location.pathname}?room=${App.room}`;
  function renderQR(el, text, size) {
    el.innerHTML = '';
    if (typeof window.QRCode === 'function') {
      try { new window.QRCode(el, { text, width: size, height: size, colorDark: '#0f172a', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M }); return; } catch { /* rơi xuống dưới */ }
    }
    el.textContent = 'Không tạo được mã QR — hãy đọc mã phòng cho học sinh.';
  }
  const teamName = t => `${C.TEAM_META[t].icon} ${C.TEAM_META[t].name}`;

  /* ------------------------------------------------------------------ */
  /* Vòng lặp thời gian                                                  */
  /* ------------------------------------------------------------------ */
  function tick() {
    if (!clockReady()) return;
    const R = curRound();
    const now = serverNow();
    const status = R ? C.roundStatus(R, now) : 'none';
    const key = R ? R.gid + ':' + status : 'none';
    if (key !== App.prevKey) {
      const prev = App.prevKey; App.prevKey = key;
      onStatusChange(prev, status, R);
      render();
    }
    updateTimer(status, now);
    updateOverlays(status, now);
    if (App.lockUntil && Date.now() > App.lockUntil) { App.lockUntil = 0; if (isStudent()) renderStudent(); }
    if (App.flash && Date.now() > App.flash.until) { App.flash = null; if (isStudent()) renderStudent(); }
  }

  function onStatusChange(prevKey, status, R) {
    if (status === 'running') {
      playBeep(880, .3);
      if (isStudent()) setBanner(`Mê cung mở ra! Hãy chọn các ô số chia hết cho ${R.cfg.divisor}.`, 'info');
      startBGM();
    } else if (status === 'ended') {
      stopBGM();
      if (!App.loading && prevKey && !prevKey.endsWith(':ended')) playWin();
      if (R && App.summaryGid !== R.gid && App.role) { App.summaryGid = R.gid; openSummary(); }
      if (isStudent()) {
        const reason = R.endReason === 'all_finished' ? '🎉 Tất cả các đội đã về đích!' : R.endReason === 'manual' ? '⏹ Cô giáo đã kết thúc thử thách.' : '⏰ Hết giờ!';
        setBanner(reason, 'success');
      }
    } else if (status === 'none' || status === 'countdown') {
      stopBGM();
    }
  }

  function updateTimer(status, now) {
    const box = $('#timerBox');
    const R = curRound();
    if (!App.role) { box.hidden = true; return; }
    box.hidden = false;
    let txt = '--:--', cls = 'timer-box';
    if (!R) txt = isHost() ? C.fmtTime(App.cfg.durationSec) : '--:--';
    else if (App.replay) txt = C.fmtTime(Math.max(0, R.endAt - App.replay.t));
    else if (status === 'countdown') txt = C.fmtTime(R.cfg.durationSec);
    else if (status === 'running') {
      const left = Math.max(0, Math.ceil(R.endAt - now));
      txt = C.fmtTime(left); cls += left <= 30 ? ' low' : ' running';
    } else if (status === 'ended') {
      const left = Math.max(0, Math.ceil(R.endAt - C.effectiveEnd(R)));
      txt = C.fmtTime(left);
    }
    if (box.textContent !== txt) box.textContent = txt;
    if (box.className !== cls) box.className = cls;
  }

  function overlayHTML(kind, data) {
    switch (kind) {
      case 'count': return `<div class="big">${data.n}</div><div class="mid">CHUẨN BỊ XUẤT PHÁT!</div>`;
      case 'go': return `<div class="big">🚀</div><div class="mid">XUẤT PHÁT!</div>`;
      case 'wait': return `<div class="big">⏳</div><div class="mid">${esc(data.title)}</div><div class="sub">${esc(data.sub || '')}</div>`;
      case 'lock': return `<div class="big">🔒</div><div class="mid">Chọn sai rồi! Chờ ${data.sec} giây…</div><div class="sub">Hãy tính lại thật cẩn thận.</div>`;
      case 'done': return `<div class="big">🏁</div><div class="mid">ĐÃ VỀ ĐÍCH!</div><div class="sub">${esc(data.sub)}</div>`;
      default: return '';
    }
  }
  function setOverlay(el, kind, data, cls = '') {
    if (!kind) { if (!el.hidden) el.hidden = true; el.dataset.sig = ''; return; }
    const html = overlayHTML(kind, data);
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
    el.className = 'overlay' + (cls ? ' ' + cls : '');
    el.hidden = false;
  }

  function updateOverlays(status, now) {
    const R = curRound();
    // đếm ngược
    let cd = null;
    if (R && status === 'countdown') {
      cd = Math.max(1, Math.ceil(R.startAt - now));
      if (cd !== App.lastCd) { App.lastCd = cd; playBeep(440, .15); }
    }
    const justStarted = R && status === 'running' && now - R.startAt < 1.2;
    // học sinh
    if (isStudent() && !$('#studentGame').hidden) {
      const ov = $('#overlay');
      const me = myTeam();
      const tm = R && me ? R.teams[me] : null;
      if (!R) setOverlay(ov, 'wait', { title: `Đã vào ${C.TEAM_META[me] ? C.TEAM_META[me].name : 'đội'}!`, sub: 'Chờ cô giáo bắt đầu thử thách…' });
      else if (status === 'countdown') setOverlay(ov, 'count', { n: cd });
      else if (justStarted) setOverlay(ov, 'go', {});
      else if (status === 'running' && tm && !tm.joined) setOverlay(ov, 'wait', { title: 'Bạn vào đội sau khi trận bắt đầu', sub: 'Hãy chờ trận kế tiếp.' });
      else if (status === 'running' && tm && tm.finished) {
        const s = C.teamSummary(R, me);
        setOverlay(ov, 'done', { sub: `Thời gian ${C.fmtTime(s.elapsed)}${s.penalty ? ` + phạt ${s.penalty}s = ${C.fmtTime(s.total)}` : ''}. Chờ các đội khác…` });
      } else if (status === 'running' && App.lockUntil > Date.now()) {
        setOverlay(ov, 'lock', { sec: Math.ceil((App.lockUntil - Date.now()) / 1000) }, 'lock');
      } else setOverlay(ov, null);
    }
    // cô giáo
    if (isHost()) {
      const ho = ensureHostOverlay();
      if (R && status === 'countdown') setOverlay(ho, 'count', { n: cd });
      else if (justStarted && !App.replay) setOverlay(ho, 'go', {});
      else setOverlay(ho, null);
    }
  }
  function ensureHostOverlay() {
    let ho = $('#hostOverlay');
    if (!ho) { ho = document.createElement('div'); ho.id = 'hostOverlay'; ho.className = 'overlay'; ho.hidden = true; $('#hostRace').appendChild(ho); }
    return ho;
  }

  /* ------------------------------------------------------------------ */
  /* Vẽ giao diện                                                        */
  /* ------------------------------------------------------------------ */
  function render() {
    document.body.dataset.view = App.view;
    renderChrome();
    $('#viewLanding').hidden = App.view !== 'landing';
    $('#viewHost').hidden = App.view !== 'host';
    $('#viewStudent').hidden = App.view !== 'student';
    if (App.view === 'host') renderHost();
    else if (App.view === 'student') renderStudent();
    else renderLanding();
    const R = curRound();
    if (R && App.role && C.roundStatus(R, serverNow()) === 'ended' && App.summaryGid !== R.gid) { App.summaryGid = R.gid; openSummary(); }
    else if (!$('#summaryModal').hidden) fillSummary();
  }

  function renderConn() {
    const el = $('#connStatus');
    if (!App.role) { el.hidden = true; return; }
    el.hidden = false;
    const map = {
      connecting: ['● Đang kết nối…', 'warn'], online: ['● Trực tuyến', ''], retry: ['● Đang kết nối lại…', 'warn'], bad: ['● Mất kết nối', 'bad'], idle: ['●', '']
    };
    const [t, c] = map[App.conn] || map.idle;
    el.textContent = t; el.className = 'conn' + (c ? ' ' + c : '');
  }

  function renderChrome() {
    const R = curRound();
    const d = R ? R.cfg.divisor : App.cfg.divisor;
    $('#subtitle').textContent = App.role ? `Thử thách – Giải mã mê cung (Toán 6: Chia hết cho ${d})` : 'Thử thách – Giải mã mê cung';
    const inRoom = !!App.role;
    $('#roomBadge').hidden = !isHost();
    $('#roomCodeText').textContent = App.room || '';
    const rb = $('#roleBadge');
    rb.hidden = !inRoom;
    if (isHost()) { rb.textContent = '👑 GIÁO VIÊN · MÁY CHIẾU'; rb.style.borderColor = ''; }
    else if (isStudent()) {
      const me = myTeam();
      rb.textContent = me ? `${C.TEAM_META[me].icon} ĐỘI ${me}` : `📱 PHÒNG ${App.room || ''}`;
      rb.style.borderColor = me ? C.TEAM_META[me].color : '';
    }
    $('#btnSfx').hidden = !inRoom;
    $('#btnSfx').textContent = App.sfx ? '🔊' : '🔇';
    $('#btnBgm').hidden = !isHost();
    $('#btnBgm').textContent = App.bgm ? '🎵' : '🔕';
    $('#btnExit').hidden = !inRoom;
    renderConn();
  }

  /* ---- Landing ---- */
  function renderLanding() {
    const last = LS.get('maze.lastHost');
    const has = last && last.room && LS.get('maze.host.' + last.room);
    $('#btnResumeHost').hidden = !has;
    if (has) $('#resumeHostCode').textContent = last.room;
    const input = $('#roomInput');
    if (!input.value) input.value = LS.get('maze.lastRoom', '') || '';
  }

  /* ---- Cô giáo ---- */
  const DIV_LABEL = d => `Chia hết cho ${d}` + (d === 3 ? ' (Toán 6)' : '');
  function initHostForm() {
    const sel = $('#cfgDivisor');
    sel.innerHTML = C.DIVISORS.map(d => `<option value="${d}">${DIV_LABEL(d)}</option>`).join('');
    const bind = (id, get, set) => {
      const el = $(id);
      el.addEventListener('change', () => { set(el); App.cfg = C.normCfg(App.cfg); LS.set('maze.cfg', App.cfg); render(); });
      return el;
    };
    bind('#cfgDivisor', e => e.value, e => { App.cfg.divisor = +e.value; });
    bind('#cfgSteps', 0, e => { App.cfg.steps = +e.value; });
    bind('#cfgDuration', 0, e => { App.cfg.durationSec = +e.value; });
    bind('#cfgPenalty', 0, e => { App.cfg.penaltySec = +e.value; });
    bind('#cfgSame', 0, e => { App.cfg.sameMaze = e.value === '1'; });
    bind('#cfgLanes', 0, e => { App.cfg.showLanes = e.checked; });
    bind('#cfgHint', 0, e => { App.cfg.showHint = e.checked; });
  }
  function syncHostForm() {
    const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = String(v); };
    set('#cfgDivisor', App.cfg.divisor); set('#cfgSteps', App.cfg.steps);
    set('#cfgDuration', App.cfg.durationSec); set('#cfgPenalty', App.cfg.penaltySec);
    set('#cfgSame', App.cfg.sameMaze ? '1' : '0');
    $('#cfgLanes').checked = App.cfg.showLanes; $('#cfgHint').checked = App.cfg.showHint;
  }

  let qrDrawnFor = null;
  function renderHost() {
    const R = curRound();
    const lobby = !R;
    $('#hostLobby').hidden = !lobby;
    $('#hostRace').hidden = lobby;
    if (lobby) renderLobby(); else renderRace();
  }

  function renderLobby() {
    syncHostForm();
    const link = studentLink();
    if (qrDrawnFor !== link) { qrDrawnFor = link; renderQR($('#lobbyQr'), link, 190); }
    $('#lobbyCode').textContent = App.room || '';
    $('#lobbyLink').textContent = link;
    $('#fileWarning').hidden = location.protocol !== 'file:';
    const seats = $('#seats');
    seats.innerHTML = C.TEAMS.map(t => {
      const taken = !!App.st.claims[t];
      return `<div class="seat t${t} ${taken ? 'taken' : ''}">
        <div><div class="seat-name">${teamName(t)}</div><div class="seat-state">${taken ? '✅ Đã có điện thoại vào đội' : 'Chưa có ai'}</div></div>
        ${taken ? `<button class="btn" data-kick="${t}" type="button">Mời ra</button>` : ''}
      </div>`;
    }).join('');
    const n = Object.keys(App.st.claims).length;
    const ready = !!App.st.hostPub && !!App.key && App.st.hostPub.x === App.key.pub.x;
    $('#btnStart').disabled = !ready || n < 1;
    $('#startHint').textContent = !ready ? 'Đang mở phòng…'
      : n === 0 ? 'Chưa có đội nào vào phòng.'
      : n < 4 ? `${n}/4 đội đã vào. Đội chưa vào sẽ không được tính.` : '4/4 đội đã sẵn sàng!';
  }

  let lanesBuilt = false;
  function ensureLanes() {
    if (lanesBuilt) return;
    lanesBuilt = true;
    $('#lanes').innerHTML = C.TEAMS.map(t => `
      <div class="lane t${t}" data-lane="${t}">
        <div><div class="lane-name">${teamName(t)}</div><div class="lane-sub" data-f="sub"></div></div>
        <div class="lane-track">
          <div class="lane-fill" data-f="fill"></div>
          <span class="lane-car" data-f="car">${C.TEAM_META[t].icon}</span>
          <span class="lane-castle">🏰</span>
          <div class="lane-hidden" data-f="hidden" hidden>🔒 Tiến độ đang được ẩn</div>
        </div>
        <div class="lane-right"><span class="pill" data-f="pill"></span><div class="lane-sub" data-f="steps"></div></div>
      </div>`).join('');
  }

  function renderRace() {
    ensureLanes();
    const R = curRound();
    const status = curStatus();
    const rp = !!App.replay;
    $('#raceMission').innerHTML = `🎯 <b>Nhiệm vụ:</b> đi qua các số chia hết cho <b>${R.cfg.divisor}</b> từ <b>START</b> tới <b>THÀNH CỔ</b> (${R.cfg.steps} bước). Sai +${R.cfg.penaltySec}s/lỗi.`;
    $('#raceStatus').textContent = rp ? '🎬 Đang xem lại' : status === 'countdown' ? '🚦 Chuẩn bị…' : status === 'running' ? '🏎️ Đang thi đấu' : '🏁 Đã kết thúc';
    $('#raceHint').innerHTML = `<strong>💡 Dấu hiệu chia hết cho ${R.cfg.divisor}:</strong><br>${esc(C.RULES[R.cfg.divisor].hint)}`;
    const ended = status === 'ended';
    $('#btnEnd').hidden = ended || rp;
    $('#btnSummary').hidden = !ended || rp;
    $('#btnReplay').hidden = !ended || rp;
    $('#btnNewRound').hidden = !ended || rp;
    $('#replayBox').hidden = !rp;
    if (rp) {
      $('#rpPlay').textContent = App.replay.playing ? '⏸' : '▶';
      $$('.rp-speed').forEach(b => b.classList.toggle('active', +b.dataset.speed === App.replay.speed));
    }
    renderLanes();
  }

  function laneView(R, t) {
    if (App.replay) return C.teamAt(R, t, App.replay.t);
    const tm = R.teams[t];
    return { progress: tm.best, errors: tm.errors, finished: tm.finished, finishAt: tm.finishAt, steps: R.mazes[t].steps };
  }

  function renderLanes() {
    ensureLanes();
    const R = curRound();
    if (!R) return;
    const status = curStatus();
    const showAll = App.replay || status === 'ended' || R.cfg.showLanes;
    C.TEAMS.forEach(t => {
      const lane = $(`[data-lane="${t}"]`);
      const f = n => $(`[data-f="${n}"]`, lane);
      const v = laneView(R, t);
      const joined = R.teams[t].joined;
      const pen = v.errors * R.cfg.penaltySec;
      const pct = Math.round(100 * v.progress / v.steps);
      lane.classList.toggle('absent', !joined);
      const visible = joined && (showAll || v.finished);
      const shownPct = visible ? pct : 0;
      const carLeft = v.finished ? 94 : 4 + shownPct * 0.86;
      f('fill').style.width = carLeft + '%';
      f('car').style.left = carLeft + '%';
      f('hidden').hidden = !(joined && !showAll && !v.finished);
      f('sub').textContent = !joined ? 'Không tham gia' : showAll || v.finished ? `Lỗi: ${v.errors}${R.cfg.penaltySec ? ` · phạt +${pen}s` : ''}` : '…';
      f('steps').textContent = !joined ? '' : showAll || v.finished ? `Bước ${v.progress}/${v.steps}` : '';
      const pill = f('pill');
      if (!joined) { pill.className = 'pill absent'; pill.textContent = '— Vắng'; }
      else if (v.finished) { pill.className = 'pill finished'; pill.textContent = `🏆 Về đích ${C.fmtTime(v.finishAt - R.startAt)}`; }
      else if (status === 'ended' && !App.replay) { pill.className = 'pill'; pill.textContent = `⏹ Dừng ở bước ${v.progress}/${v.steps}`; }
      else if (status === 'countdown') { pill.className = 'pill ready'; pill.textContent = 'Sẵn sàng'; }
      else { pill.className = 'pill ready'; pill.textContent = 'Đang dò đường'; }
    });
  }

  /* ---- Học sinh ---- */
  function renderStudent() {
    const me = myTeam();
    const ready = App.phase === 'ready' || !!App.st.hostPub;
    const connecting = $('#studentConnecting');
    if (!App.loading && !App.st.hostPub) {
      connecting.hidden = false;
      connecting.innerHTML = `❓ Chưa thấy phòng <b>${esc(App.room || '')}</b>.<br><span class="small-note">Hãy kiểm tra lại mã phòng hoặc nhờ cô giáo mở phòng. Trang sẽ tự vào khi phòng xuất hiện.</span>
        <div class="row-gap"><button class="btn" id="btnBackLanding" type="button">↩️ Nhập mã khác</button></div>`;
      $('#btnBackLanding').onclick = leaveRoom;
    } else if (App.loading) { connecting.hidden = false; connecting.textContent = '⏳ Đang kết nối phòng…'; }
    else connecting.hidden = true;
    $('#studentPick').hidden = !(ready && !App.loading && !me);
    $('#studentGame').hidden = !(ready && !App.loading && !!me);
    if (!$('#studentPick').hidden) renderPick();
    if (!$('#studentGame').hidden) renderGame(me);
  }

  function renderPick() {
    $('#pickGrid').innerHTML = C.TEAMS.map(t => {
      const taken = !!App.st.claims[t];
      return `<button class="pick-btn t${t}" data-pick="${t}" type="button" ${taken ? 'disabled' : ''}>
        <span class="em">${C.TEAM_META[t].icon}</span><span>ĐỘI ${t}</span><small>${taken ? 'Đã có người' : 'Còn trống'}</small></button>`;
    }).join('');
  }

  function renderGame(me) {
    const R = curRound();
    const status = curStatus();
    const meta = C.TEAM_META[me];
    $('#stuTeam').innerHTML = `<span style="color:${meta.color}">${meta.icon} ${meta.name}</span>`;
    const tm = R ? R.teams[me] : null;
    $('#stuErrors').textContent = tm ? tm.errors : 0;
    $('#stuPenalty').textContent = '+' + (tm ? tm.errors * R.cfg.penaltySec : 0) + 's';
    $('#stuProgress').textContent = R && R.startAt ? `${tm.best}/${R.mazes[me].steps}` : '—';
    const b = $('#banner');
    b.className = 'banner ' + App.banner.type;
    b.textContent = App.banner.text;
    const hint = $('#stuHint');
    hint.hidden = !(R && R.cfg.showHint);
    if (R) hint.innerHTML = `<strong>💡 Dấu hiệu chia hết cho ${R.cfg.divisor}:</strong> ${esc(C.RULES[R.cfg.divisor].hint)}`;
    $('#btnResults').hidden = !(R && status === 'ended');
    $('#btnLeave').hidden = !(!R || status === 'ended');
    renderStudentMaze(me, R, status);
  }

  function renderStudentMaze(me, R, status) {
    const grid = $('#maze');
    const transposed = media('(orientation: portrait) and (max-width: 760px)');
    grid.className = 'maze' + (transposed ? ' transposed' : '');
    const reveal = R && (status === 'running' || status === 'ended');
    const maze = R ? R.mazes[me] : null;
    const tm = R ? R.teams[me] : null;
    const interactive = R && status === 'running' && tm.joined && !tm.finished;
    const visited = new Set(tm ? tm.steps.filter(s => s.ok).map(s => C.key(s.r, s.c)) : []);
    if (tm) visited.add(C.key(C.START.r, C.START.c));
    const frag = document.createDocumentFragment();
    for (let r = 0; r < C.ROWS; r++) for (let c = 0; c < C.COLS; c++) {
      const cell = maze ? maze.cells[r][c] : null;
      const div = document.createElement('div');
      div.className = 'cell';
      div.style.gridRow = String(transposed ? c + 1 : r + 1);
      div.style.gridColumn = String(transposed ? r + 1 : c + 1);
      const isStart = r === C.START.r && c === C.START.c, isFinish = r === C.FINISH.r && c === C.FINISH.c;
      if (isStart) div.classList.add('start');
      if (isFinish) div.classList.add('finish');
      if (isStart) div.innerHTML = '<small>🚩 START</small>';
      else if (isFinish) div.innerHTML = '<small>THÀNH CỔ</small><span>🏰</span>';
      else if (reveal && cell) div.textContent = cell.label;
      else { div.textContent = '?'; div.classList.add('masked'); }
      if (tm && visited.has(C.key(r, c)) && !isStart) div.classList.add('visited');
      if (tm && tm.pos.r === r && tm.pos.c === c) { div.classList.add('here'); div.dataset.car = C.TEAM_META[me].icon; }
      if (interactive && C.isAdjacent(tm.pos, { r, c })) div.classList.add('reach');
      if (App.flash && App.flash.r === r && App.flash.c === c) div.classList.add(App.flash.ok ? 'flash-ok' : 'flash-wrong');
      div.dataset.r = r; div.dataset.c = c;
      frag.appendChild(div);
    }
    grid.replaceChildren(frag);
  }

  /* ------------------------------------------------------------------ */
  /* Hành động                                                           */
  /* ------------------------------------------------------------------ */
  async function onCellTap(r, c) {
    const R = curRound(), me = myTeam();
    if (!R || !me) return;
    const status = curStatus();
    if (status === 'countdown') { setBanner('Chưa tới giờ xuất phát!', 'info'); renderStudent(); return; }
    if (status !== 'running') return;
    const tm = R.teams[me];
    if (!tm.joined || tm.finished) return;
    if (Date.now() < App.lockUntil || App.inflight) return;
    if (!C.isAdjacent(tm.pos, { r, c })) {
      setBanner('❌ Chỉ được đi sang ô kề bên (sáng viền vàng) của xe!', 'error');
      playBeep(200, .1); renderStudent(); return;
    }
    App.inflight = true;
    try {
      await send('PICK', { gid: R.gid, team: me, dev: App.key.dev, r, c }, App.key.privKey);
    } catch (e) {
      toast('Mạng chập chờn — chưa gửi được nước đi. Hãy thử lại.', 'error');
    } finally { App.inflight = false; }
  }

  async function joinTeam(t) {
    $('#pickMsg').textContent = '';
    try {
      await send('JOIN', { team: t, dev: App.key.dev, pub: App.key.pub }, App.key.privKey);
      await Net.queue;
      if (!myTeam()) $('#pickMsg').textContent = 'Đội này vừa có người khác chọn. Hãy chọn đội khác.';
    } catch { $('#pickMsg').textContent = 'Không gửi được — kiểm tra mạng rồi thử lại.'; }
    render();
  }

  async function leaveTeam() {
    const me = myTeam(); if (!me) return;
    try { await send('LEAVE', { team: me, dev: App.key.dev }, App.key.privKey); } catch { toast('Mạng chập chờn, thử lại nhé.', 'error'); }
  }

  async function hostStart() {
    if (!isHost() || curRound() && curStatus() !== 'ended') return;
    audio();
    const btn = $('#btnStart'); btn.disabled = true;
    try {
      await send('START', { gid: randToken(8), cfg: C.normCfg(App.cfg), seed: randToken(10) }, App.key.privKey);
    } catch { toast('Không gửi được lệnh bắt đầu — kiểm tra mạng.', 'error'); }
    render();
  }
  async function hostEnd() {
    const R = curRound(); if (!isHost() || !R) return;
    if (!(await askConfirm('Kết thúc sớm?', 'Trận đấu sẽ dừng ngay và chốt kết quả hiện tại.', 'Kết thúc'))) return;
    try { await send('END', { gid: R.gid }, App.key.privKey); } catch { toast('Không gửi được lệnh kết thúc.', 'error'); }
  }
  async function hostNewRound() {
    if (!isHost()) return;
    closeSummary(); stopReplay();
    try { await send('LOBBY', {}, App.key.privKey); } catch { toast('Không gửi được — kiểm tra mạng.', 'error'); }
  }
  async function hostKick(t) {
    if (!(await askConfirm('Mời đội ra?', `${C.TEAM_META[t].name} sẽ phải chọn lại đội trên điện thoại.`, 'Mời ra'))) return;
    try { await send('KICK', { team: t }, App.key.privKey); } catch { toast('Không gửi được.', 'error'); }
  }

  /* ------------------------------------------------------------------ */
  /* Vào / ra phòng                                                      */
  /* ------------------------------------------------------------------ */
  function setUrl(param, code) {
    const keep = qs.get('ntfy') ? `&ntfy=${encodeURIComponent(qs.get('ntfy'))}` : '';
    try { history.replaceState(null, '', code ? `?${param}=${code}${keep}` : location.pathname + (keep ? '?' + keep.slice(1) : '')); } catch { /* bỏ qua */ }
  }

  function leaveRoom() {
    closeNet(); stopBGM(); stopReplay(); closeSummary();
    App.role = null; App.view = 'landing'; App.room = null; App.key = null; App.st = C.createState();
    App.prevKey = null; App.summaryGid = null; qrDrawnFor = null;
    setUrl('', null);
    render();
  }

  async function enterHost(code) {
    App.role = 'host'; App.view = 'host'; App.loading = true; App.st = C.createState();
    App.key = await loadKey('maze.host.' + code);
    LS.set('maze.lastHost', { room: code });
    setUrl('host', code);
    render();
    await openRoom(code);
    if (!App.st.hostPub) {                       // phòng mới (hoặc đã hết hạn 12 giờ): mở / mở lại phòng bằng khoá này
      await send('ROOM', { pub: App.key.pub }, App.key.privKey);
      await Net.queue;
    } else if (App.st.hostPub.x !== App.key.pub.x) {
      toast('Phòng này thuộc về một máy giáo viên khác.', 'error', 6000);
      leaveRoom(); return;
    }
    render();
  }

  async function createRoom() {
    const msg = $('#landingHostMsg'); msg.textContent = 'Đang tạo phòng…'; msg.className = 'form-msg ok';
    if (!subtle) { msg.textContent = 'Trình duyệt này không hỗ trợ mật mã (cần HTTPS).'; msg.className = 'form-msg'; return; }
    try {
      let code = null;
      for (let i = 0; i < 6 && !code; i++) {
        const c = randId(6);
        const res = await fetch(`${NTFY}/thanhgame_${c.toLowerCase()}/json?poll=1&since=all`, { cache: 'no-store' });
        if (res.ok && !(await res.text()).trim()) code = c;
      }
      if (!code) throw new Error('code');
      const key = await genKey();
      LS.set('maze.host.' + code, key);
      msg.textContent = '';
      await enterHost(code);
    } catch (e) {
      msg.textContent = 'Không tạo được phòng — kiểm tra kết nối mạng rồi thử lại.'; msg.className = 'form-msg';
      if (App.role) leaveRoom();
    }
  }

  async function resumeHost(code) {
    const msg = $('#landingHostMsg');
    if (!LS.get('maze.host.' + code)) { msg.textContent = 'Máy này không giữ khoá của phòng ' + code + '.'; return; }
    try { await enterHost(code); } catch { toast('Không mở lại được phòng — kiểm tra mạng.', 'error'); if (App.role) leaveRoom(); }
  }

  async function enterStudent(code) {
    const msg = $('#landingStudentMsg');
    if (!subtle) { msg.textContent = 'Trình duyệt này không hỗ trợ mật mã (cần HTTPS).'; return; }
    code = code.toUpperCase();
    App.role = 'student'; App.view = 'student'; App.loading = true; App.st = C.createState();
    App.key = await loadKey('maze.key');
    LS.set('maze.lastRoom', code);
    setUrl('room', code);
    render();
    try { await openRoom(code); }
    catch { toast('Không kết nối được. Kiểm tra mạng rồi thử lại.', 'error', 5000); leaveRoom(); return; }
    render();
  }

  /* ------------------------------------------------------------------ */
  /* Bảng tổng kết                                                       */
  /* ------------------------------------------------------------------ */
  function miniMap(R, t, opts = {}) {
    const maze = R.mazes[t];
    const steps = opts.steps || [];
    const visitOrder = new Map(), wrong = new Map();
    steps.forEach((s, i) => {
      const k = C.key(s.r, s.c);
      if (s.ok) { if (!visitOrder.has(k)) visitOrder.set(k, visitOrder.size + 1); }
      else wrong.set(k, (wrong.get(k) || 0) + 1);
    });
    const sol = new Set(maze.solution.map(p => C.key(p.r, p.c)));
    let html = '<div class="mini">';
    for (let r = 0; r < C.ROWS; r++) for (let c = 0; c < C.COLS; c++) {
      const cell = maze.cells[r][c], k = C.key(r, c);
      const cls = ['m'];
      if (cell.kind === 'start') cls.push('start');
      if (cell.kind === 'finish') cls.push('finish');
      if (sol.has(k) && cell.kind === 'num') cls.push('sol');
      if (visitOrder.has(k) && cell.kind === 'num') cls.push('visited');
      if (wrong.has(k)) cls.push('wrongc');
      if (opts.showValid && cell.valid && cell.kind === 'num') cls.push('visited');
      const label = cell.kind === 'start' ? '🚩' : cell.kind === 'finish' ? '🏰' : esc(cell.label);
      const sup = wrong.has(k) ? `<sup>✗${wrong.get(k)}</sup>` : (visitOrder.has(k) && cell.kind === 'num' ? `<sup>${visitOrder.get(k)}</sup>` : '');
      html += `<div class="${cls.join(' ')}">${label}${sup}</div>`;
    }
    return html + '</div>';
  }
  const MINI_LEGEND = '<div class="mini-legend"><span>🟦 ô đã đi (số nhỏ = thứ tự)</span><span>🟥 ô chọn sai (✗ = số lần)</span><span>🟨 nét đứt: đường ngắn nhất (đáp án)</span></div>';

  function timelineHTML(R, t) {
    const maze = R.mazes[t], d = R.cfg.divisor;
    const steps = R.teams[t].steps;
    if (!steps.length) return '<ol class="timeline"><li>Chưa có nước đi nào.</li></ol>';
    return '<ol class="timeline">' + steps.map(s => {
      const cell = maze.cells[s.r][s.c];
      const time = `<b>${C.fmtTime(s.rel)}</b>`;
      if (cell.kind === 'finish') return `<li class="ok">${time} · 🏰 Về đích</li>`;
      if (cell.kind === 'start') return `<li class="ok">${time} · ↩ Quay lại START</li>`;
      return s.ok
        ? `<li class="ok">${time} · ${esc(cell.label)} ✓ <span>(${esc(C.explain(d, cell.val))})</span></li>`
        : `<li class="bad">${time} · ${esc(cell.label)} ✗ <span>(${esc(C.explain(d, cell.val))} — không chia hết cho ${d})</span></li>`;
    }).join('') + '</ol>';
  }

  const medal = r => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : '🏅';
  const openDetails = new Set();

  function fillSummary() {
    const R = curRound(); if (!R) return;
    const me = myTeam();
    const rows = C.ranking(R);
    const reason = R.endReason === 'all_finished' ? '🎉 Tất cả các đội tham gia đã về đích!'
      : R.endReason === 'manual' ? '⏹ Cô giáo đã kết thúc thử thách.' : '⏰ Hết giờ!';
    $('#summarySub').textContent = `${reason} · Chia hết cho ${R.cfg.divisor} · ${R.cfg.steps} bước · phạt ${R.cfg.penaltySec}s/lỗi`;
    $('#summaryBody').innerHTML = rows.map(row => {
      const t = row.team, meta = C.TEAM_META[t];
      const tm = R.teams[t];
      const result = !row.joined ? '— Vắng'
        : row.finished ? '🏆 Về đích'
        : `⏳ Chưa về đích<div class="prog"><small>Dừng ở bước ${row.progress}/${row.steps} (${row.pct}%)</small><div class="prog-bar"><i style="width:${row.pct}%"></i></div></div>`;
      const open = openDetails.has(t);
      return `<tr class="${t === me ? 'me' : ''} ${row.joined ? '' : 'absent'}">
        <td class="c-rank" data-l="Hạng"><b>${row.rank ? medal(row.rank) + ' ' + row.rank : '—'}</b></td>
        <td class="team-cell c-team" data-l="Đội" style="color:${meta.color}">${meta.icon} ${meta.name}${t === me ? '<span class="you">BẠN</span>' : ''}</td>
        <td class="c-result" data-l="Kết quả">${result}${row.finished ? `<div class="prog"><div class="prog-bar done"><i style="width:100%"></i></div></div>` : ''}</td>
        <td class="c-time" data-l="Thời gian"><b>${row.finished ? C.fmtTime(row.elapsed) : '—'}</b></td>
        <td class="errs c-err ${row.errors ? 'some' : 'zero'}" data-l="Lỗi">${row.joined ? row.errors : '—'}</td>
        <td class="c-pen" data-l="Phạt">${row.joined ? '+' + row.penalty + 's' : '—'}</td>
        <td class="c-total" data-l="Tổng"><b>${row.finished ? C.fmtTime(row.total) : '—'}</b></td>
        <td class="c-btn">${row.joined ? `<button class="btn" data-detail="${t}" type="button">${open ? '▲ Ẩn' : '▼ Chi tiết'}</button>` : ''}</td>
      </tr>
      <tr class="detail" data-detail-row="${t}" ${open ? '' : 'hidden'}><td colspan="8">
        ${row.joined ? `<div class="kv">
            <span>🖱 Số lượt chạm: <b>${row.picks}</b></span>
            <span>🎯 Chính xác: <b>${row.accuracy == null ? '—' : row.accuracy + '%'}</b></span>
            <span>📍 Tiến độ: <b>${row.progress}/${row.steps}</b></span>
            <span>⏱ Thời gian đi: <b>${row.finished ? C.fmtTime(row.elapsed) : 'chưa về đích'}</b></span>
          </div>
          <div class="detail-grid"><div>${miniMap(R, t, { steps: tm.steps })}${MINI_LEGEND}</div>${timelineHTML(R, t)}</div>` : ''}
      </td></tr>`;
    }).join('');
  }

  function openSummary() { fillSummary(); $('#summaryModal').hidden = false; }
  function closeSummary() { $('#summaryModal').hidden = true; }

  function exportCsv() {
    const R = curRound(); if (!R) return;
    const rows = C.ranking(R);
    const head = ['Hạng', 'Đội', 'Kết quả', 'Bước đạt được', 'Thời gian đi', 'Số lỗi', 'Phạt (giây)', 'Tổng thời gian'];
    const lines = rows.map(r => [
      r.rank || '', C.TEAM_META[r.team].name, !r.joined ? 'Vắng' : r.finished ? 'Về đích' : 'Chưa về đích',
      `${r.progress}/${r.steps}`, r.finished ? C.fmtTime(r.elapsed) : '', r.joined ? r.errors : '', r.joined ? r.penalty : '', r.finished ? C.fmtTime(r.total) : ''
    ]);
    const csv = '\uFEFF' + [head, ...lines].map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `ket-qua-${App.room}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ------------------------------------------------------------------ */
  /* Xem lại cuộc đua                                                    */
  /* ------------------------------------------------------------------ */
  let replayTimer = null;
  function startReplay() {
    const R = curRound(); if (!R) return;
    closeSummary();
    stopReplay(true);
    App.replay = { t: R.startAt, speed: 4, playing: true };
    replayTimer = setInterval(() => {
      const rp = App.replay; if (!rp) return;
      if (rp.playing) {
        rp.t += 0.1 * rp.speed;
        const end = C.effectiveEnd(R) + 1;
        if (rp.t >= end) { rp.t = end; rp.playing = false; $('#rpPlay').textContent = '▶'; }
      }
      renderLanes();
      updateTimer('ended', serverNow());
    }, 100);
    render();
  }
  function stopReplay(silent) {
    clearInterval(replayTimer); replayTimer = null;
    if (App.replay) { App.replay = null; if (!silent) render(); }
  }

  /* ------------------------------------------------------------------ */
  /* Xem thử mê cung mẫu                                                 */
  /* ------------------------------------------------------------------ */
  function openPreview() {
    const cfg = C.normCfg(App.cfg);
    const R = { mazes: { 1: C.makeMaze(cfg, App.previewSeed, 1) } };
    $('#previewSub').textContent = `${DIV_LABEL(cfg.divisor)} · ${cfg.steps} bước (đường ngắn nhất). Ô xanh = số hợp lệ, nét đứt vàng = một đường đi ngắn nhất, ô còn lại là bẫy.`;
    $('#previewMap').innerHTML = `<div style="display:flex;justify-content:center">${miniMap(R, 1, { showValid: true })}</div>${MINI_LEGEND}`;
    $('#previewModal').hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* Khởi động                                                           */
  /* ------------------------------------------------------------------ */
  function bind() {
    $('#btnCreateRoom').onclick = createRoom;
    $('#btnResumeHost').onclick = () => { const l = LS.get('maze.lastHost'); if (l) resumeHost(l.room); };
    $('#joinForm').onsubmit = e => {
      e.preventDefault();
      const code = $('#roomInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) { $('#landingStudentMsg').textContent = 'Mã phòng gồm 6 ký tự.'; return; }
      $('#landingStudentMsg').textContent = '';
      enterStudent(code);
    };
    $('#roomInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    $('#btnSfx').onclick = () => { App.sfx = !App.sfx; LS.set('maze.sfx', App.sfx); if (App.sfx) playBeep(660, .1); render(); };
    $('#btnBgm').onclick = () => { App.bgm = !App.bgm; LS.set('maze.bgm', App.bgm); if (!App.bgm) stopBGM(); else if (curStatus() === 'running') startBGM(); render(); };
    $('#btnExit').onclick = async () => {
      const R = curRound();
      const busy = R && ['countdown', 'running'].includes(curStatus());
      if (busy && !(await askConfirm('Thoát phòng?', isHost() ? 'Trận đang diễn ra. Bạn vẫn có thể mở lại phòng này sau.' : 'Trận đang diễn ra. Bạn có thể vào lại bằng cùng mã phòng.', 'Thoát'))) return;
      leaveRoom();
    };
    $('#roomBadge').onclick = openBigQr;
    $('#btnBigQr').onclick = openBigQr;
    $('#btnCopyLink').onclick = () => copyText(studentLink());
    $('#qrCopy').onclick = () => copyText(studentLink());
    $('#qrClose').onclick = () => { $('#qrModal').hidden = true; };
    $('#btnStart').onclick = hostStart;
    $('#btnEnd').onclick = hostEnd;
    $('#btnSummary').onclick = openSummary;
    $('#btnReplay').onclick = startReplay;
    $('#btnNewRound').onclick = hostNewRound;
    $('#sumReplay').onclick = startReplay;
    $('#sumNew').onclick = hostNewRound;
    $('#sumClose').onclick = closeSummary;
    $('#btnCsv').onclick = exportCsv;
    $('#btnToggleAll').onclick = () => {
      const R = curRound(); if (!R) return;
      const all = C.TEAMS.filter(t => R.teams[t].joined);
      if (all.every(t => openDetails.has(t))) openDetails.clear(); else all.forEach(t => openDetails.add(t));
      fillSummary();
    };
    $('#summaryBody').addEventListener('click', e => {
      const b = e.target.closest('[data-detail]'); if (!b) return;
      const t = +b.dataset.detail;
      if (openDetails.has(t)) openDetails.delete(t); else openDetails.add(t);
      fillSummary();
    });
    $('#btnPreview').onclick = openPreview;
    $('#previewClose').onclick = () => { $('#previewModal').hidden = true; };
    $('#previewReroll').onclick = () => { App.previewSeed = 'preview-' + randToken(5); openPreview(); };
    $('#seats').addEventListener('click', e => { const b = e.target.closest('[data-kick]'); if (b) hostKick(+b.dataset.kick); });
    $('#pickGrid').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b && !b.disabled) joinTeam(+b.dataset.pick); });
    $('#maze').addEventListener('click', e => { const c = e.target.closest('.cell'); if (c) onCellTap(+c.dataset.r, +c.dataset.c); });
    $('#btnResults').onclick = openSummary;
    $('#btnLeave').onclick = leaveTeam;
    $('#rpPlay').onclick = () => {
      const rp = App.replay; if (!rp) return;
      const R = curRound();
      if (!rp.playing && rp.t >= C.effectiveEnd(R) + 1) rp.t = R.startAt;
      rp.playing = !rp.playing; $('#rpPlay').textContent = rp.playing ? '⏸' : '▶';
    };
    $$('.rp-speed').forEach(b => { b.onclick = () => { if (App.replay) { App.replay.speed = +b.dataset.speed; render(); } }; });
    $('#rpExit').onclick = () => stopReplay();
    $$('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m && m.id !== 'confirmModal') m.hidden = true; }));
    window.addEventListener('orientationchange', () => setTimeout(scheduleRender, 200));
    window.addEventListener('resize', () => { if (isStudent()) scheduleRender(); });
  }

  function openBigQr() {
    renderQR($('#bigQr'), studentLink(), 280);
    $('#bigCode').textContent = App.room || '';
    $('#bigLink').textContent = studentLink();
    $('#qrModal').hidden = false;
  }

  async function init() {
    initHostForm();
    bind();
    render();
    setInterval(tick, 200);
    const hostCode = (qs.get('host') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const roomCode = (qs.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (hostCode.length === 6 && LS.get('maze.host.' + hostCode)) resumeHost(hostCode);
    else if (roomCode.length === 6) enterStudent(roomCode);
  }
  init();
})();
