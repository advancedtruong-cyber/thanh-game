/* =========================================================================
   core.js — logic thuần của game "Chinh phục Thành cổ mật mã"
   Không đụng tới DOM / mạng, chạy được cả trên trình duyệt lẫn Node (để test).

   Mô hình: "event sourcing". Mọi máy (cô + 4 đội) đọc cùng một nhật ký tin nhắn
   (ntfy.sh) và chạy cùng một reducer `applyEvent` => cùng một kết quả,
   không cần tin nhắn đồng bộ/ACK và không cần đồng hồ chung (dùng giờ máy chủ ntfy).
   ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROWS = 3, COLS = 6;
  const START = { r: 1, c: 0 };
  const FINISH = { r: 2, c: 5 };
  const TEAMS = [1, 2, 3, 4];
  const COUNTDOWN_SEC = 5;      // từ lúc bấm "Bắt đầu" tới lúc xuất phát
  const MAX_VALID_INTERIOR = 10;  // tối đa 10/16 ô số hợp lệ => luôn có ≥ 6 ô "bẫy"
  const WRONG_LOCK_MS = 2000;   // khóa thao tác sau mỗi lần chọn sai (phía học sinh)
  const TEAM_META = {
    1: { name: 'Đội 1', icon: '🚙', color: '#3b82f6' },
    2: { name: 'Đội 2', icon: '🚗', color: '#ef4444' },
    3: { name: 'Đội 3', icon: '🚕', color: '#f59e0b' },
    4: { name: 'Đội 4', icon: '🚓', color: '#10b981' }
  };

  /* ------------------------------------------------------------------ */
  /* Quy tắc chia hết                                                    */
  /* ------------------------------------------------------------------ */
  const digitSum = n => String(Math.abs(n)).split('').reduce((a, b) => a + (+b), 0);
  const RULES = {
    2: {
      label: '2',
      hint: 'Số có chữ số tận cùng là 0, 2, 4, 6, 8 thì chia hết cho 2.',
      explain: n => `chữ số tận cùng là ${n % 10}`
    },
    3: {
      label: '3',
      hint: 'Số có tổng các chữ số chia hết cho 3 thì chia hết cho 3.',
      explain: n => `tổng các chữ số = ${digitSum(n)}`
    },
    4: {
      label: '4',
      hint: 'Số có hai chữ số tận cùng tạo thành số chia hết cho 4 thì chia hết cho 4.',
      explain: n => `hai chữ số tận cùng là ${String(n % 100).padStart(2, '0')}`
    },
    5: {
      label: '5',
      hint: 'Số có chữ số tận cùng là 0 hoặc 5 thì chia hết cho 5.',
      explain: n => `chữ số tận cùng là ${n % 10}`
    },
    9: {
      label: '9',
      hint: 'Số có tổng các chữ số chia hết cho 9 thì chia hết cho 9.',
      explain: n => `tổng các chữ số = ${digitSum(n)}`
    },
    10: {
      label: '10',
      hint: 'Số có chữ số tận cùng là 0 thì chia hết cho 10.',
      explain: n => `chữ số tận cùng là ${n % 10}`
    }
  };
  const DIVISORS = Object.keys(RULES).map(Number);
  const isMultiple = (n, d) => n % d === 0;
  const explain = (d, n) => (RULES[d] || RULES[3]).explain(n);

  /* ------------------------------------------------------------------ */
  /* Cấu hình trận                                                       */
  /* ------------------------------------------------------------------ */
  const STEPS_OPTIONS = [6, 8, 10];
  function clampInt(v, lo, hi, dflt) {
    v = Math.round(Number(v));
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  }
  function normCfg(c) {
    c = c || {};
    const divisor = DIVISORS.includes(Number(c.divisor)) ? Number(c.divisor) : 3;
    const steps = STEPS_OPTIONS.includes(Number(c.steps)) ? Number(c.steps) : 8;
    return {
      divisor,
      steps,
      durationSec: clampInt(c.durationSec, 60, 1800, 180),
      penaltySec: clampInt(c.penaltySec, 0, 60, 10),
      decoys: clampInt(c.decoys, 0, 4, 2),
      sameMaze: !!c.sameMaze,
      showLanes: c.showLanes !== false,
      showHint: c.showHint !== false
    };
  }

  /* ------------------------------------------------------------------ */
  /* PRNG xác định (cùng seed => cùng mê cung trên mọi máy)              */
  /* ------------------------------------------------------------------ */
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rngFrom = str => mulberry32(xmur3(String(str))());
  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

  /* ------------------------------------------------------------------ */
  /* Mê cung                                                             */
  /* ------------------------------------------------------------------ */
  const key = (r, c) => r * COLS + c;
  const inBounds = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const isAdjacent = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
  function neighbors(r, c) {
    return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .filter(([a, b]) => inBounds(a, b)).map(([a, b]) => ({ r: a, c: b }));
  }

  // Khoảng cách (số bước) từ mọi ô hợp lệ tới FINISH, đi qua các ô hợp lệ
  function bfsDist(validKeys) {
    const allowed = new Set(validKeys);
    allowed.add(key(START.r, START.c));
    allowed.add(key(FINISH.r, FINISH.c));
    const dist = new Map([[key(FINISH.r, FINISH.c), 0]]);
    const queue = [FINISH];
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(key(cur.r, cur.c));
      for (const n of neighbors(cur.r, cur.c)) {
        const k = key(n.r, n.c);
        if (allowed.has(k) && !dist.has(k)) { dist.set(k, d + 1); queue.push(n); }
      }
    }
    return dist;
  }

  // Mọi đường đi tự tránh từ START tới FINISH trên lưới 3x6 (~360 đường), gom theo
  // độ dài đường ngắn nhất thực sự (có tính cả lối tắt giữa các ô của chính đường đó).
  let _shapes = null;
  function shapesByLength() {
    if (_shapes) return _shapes;
    const out = {};
    const visited = new Set([key(START.r, START.c)]);
    const path = [START];
    (function dfs() {
      const cur = path[path.length - 1];
      if (cur.r === FINISH.r && cur.c === FINISH.c) {
        const keys = path.map(p => key(p.r, p.c));
        const L = bfsDist(keys).get(key(START.r, START.c));
        if (path.length - 2 <= MAX_VALID_INTERIOR) (out[L] = out[L] || []).push(path.map(p => ({ r: p.r, c: p.c })));
        return;
      }
      for (const n of neighbors(cur.r, cur.c)) {
        const k = key(n.r, n.c);
        if (visited.has(k)) continue;
        visited.add(k); path.push(n);
        dfs();
        path.pop(); visited.delete(k);
      }
    })();
    _shapes = out;
    return out;
  }

  function fmtNum(n) {
    const s = String(n);
    return s.length > 3 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') : s;
  }

  function makeValue(rng, d, valid, used) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = rng();
      const [lo, hi] = x < 0.3 ? [10, 99] : x < 0.8 ? [100, 999] : [1000, 2999];
      const m = d * randInt(rng, Math.ceil(lo / d), Math.floor(hi / d));
      let v = m;
      if (!valid) {
        // "gần đúng": lệch một chút so với một bội số để dễ tính nhầm
        const off = randInt(rng, 1, d - 1);
        v = rng() < 0.7 ? m + off : m - (d - off);
        if (v < 10 || isMultiple(v, d)) continue;
      }
      if (v < 10 || used.has(v)) continue;
      used.add(v);
      return v;
    }
    throw new Error('Không sinh được số cho ô mê cung');
  }

  function makeMaze(cfgIn, seed, team) {
    const cfg = normCfg(cfgIn);
    const shapes = shapesByLength()[cfg.steps] || [];
    if (!shapes.length) throw new Error('Không có mê cung độ dài ' + cfg.steps);
    const shapeOrder = shuffle(shapes, rngFrom(seed + '|shape'));
    const slot = cfg.sameMaze ? 0 : (team - 1);
    const shape = shapeOrder[slot % shapeOrder.length];
    const rng = rngFrom(seed + '|vals|' + (cfg.sameMaze ? 0 : team));

    const valid = new Set(shape.map(p => key(p.r, p.c)));
    // ô hợp lệ "mồi" (ngõ cụt) — không được làm đường ngắn đi
    const startKey = key(START.r, START.c), finishKey = key(FINISH.r, FINISH.c);
    const free = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const k = key(r, c);
      if (!valid.has(k)) free.push({ r, c, k });
    }
    let decoys = 0;
    for (const f of shuffle(free, rng)) {
      if (decoys >= cfg.decoys || valid.size - 2 >= MAX_VALID_INTERIOR) break;
      const trial = new Set(valid); trial.add(f.k);
      if (bfsDist(trial).get(startKey) === cfg.steps) { valid.add(f.k); decoys++; }
    }
    const dist = bfsDist(valid);

    const used = new Set();
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const k = key(r, c);
        if (k === startKey) row.push({ r, c, kind: 'start', val: null, label: 'START', valid: true });
        else if (k === finishKey) row.push({ r, c, kind: 'finish', val: null, label: 'THÀNH CỔ', valid: true });
        else {
          const isValid = valid.has(k);
          const val = makeValue(rng, cfg.divisor, isValid, used);
          row.push({ r, c, kind: 'num', val, label: fmtNum(val), valid: isValid });
        }
      }
      cells.push(row);
    }
    // một đường đi ngắn nhất thực sự (dùng để gợi ý đáp án khi tổng kết)
    const solution = [START];
    while (!(solution[solution.length - 1].r === FINISH.r && solution[solution.length - 1].c === FINISH.c)) {
      const cur = solution[solution.length - 1];
      const d = dist.get(key(cur.r, cur.c));
      const next = neighbors(cur.r, cur.c).find(n => dist.get(key(n.r, n.c)) === d - 1);
      solution.push(next);
    }
    return { rows: ROWS, cols: COLS, cells, steps: cfg.steps, solution, dist, divisor: cfg.divisor };
  }

  // Tiến độ = số bước đã "đi đúng hướng" (steps - khoảng cách còn lại tới đích)
  function progressAt(maze, pos) {
    const d = maze.dist.get(key(pos.r, pos.c));
    return d === undefined ? 0 : Math.max(0, maze.steps - d);
  }

  /* ------------------------------------------------------------------ */
  /* Trạng thái & reducer                                                */
  /* ------------------------------------------------------------------ */
  function createState() {
    return { hostPub: null, claims: {}, round: null, rejected: 0 };
  }

  function newRound(gid, cfg, seed) {
    const c = normCfg(cfg);
    const mazes = {}, teams = {};
    TEAMS.forEach(t => {
      mazes[t] = makeMaze(c, seed, t);
      teams[t] = {
        pos: { r: START.r, c: START.c }, steps: [], errors: 0, best: 0, bestAt: null,
        finished: false, finishAt: null, joined: false
      };
    });
    return { gid, cfg: c, seed, mazes, teams, startAt: null, endAt: null, endedAt: null, endReason: null };
  }

  const effectiveEnd = round => round.endedAt != null ? round.endedAt : round.endAt;
  // Giờ ntfy chỉ chính xác tới giây, nên cho phép lệch 1 giây khi cô bấm "Trận mới" ngay lúc hết giờ.
  const isOver = (round, t) => round.endedAt != null || t >= round.endAt - 1;

  function roundStatus(round, now) {
    if (!round) return 'none';
    if (round.endedAt != null) return 'ended';
    if (now < round.startAt) return 'countdown';
    if (now >= round.endAt) return 'ended';
    return 'running';
  }

  /**
   * ev = { id, time (giây, giờ máy chủ ntfy), body }
   * Tin của host / học sinh đã được xác thực chữ ký TRƯỚC khi gọi hàm này.
   * Trả về true nếu tin có tác dụng.
   */
  function applyEvent(st, ev) {
    const b = ev && ev.body;
    if (!b || typeof b.t !== 'string') return false;
    const round = st.round;
    switch (b.t) {
      case 'ROOM':
        if (st.hostPub || !b.pub) return false;
        st.hostPub = b.pub;
        return true;

      case 'LOBBY':               // cô quay về màn hình chuẩn bị trận mới
        if (!st.hostPub || !round || !isOver(round, ev.time)) return false;
        st.round = null;
        return true;

      case 'START': {             // cô bắt đầu một trận: cấu hình + seed nằm trong tin này
        if (!st.hostPub || typeof b.gid !== 'string' || !b.gid) return false;
        if (round && (round.gid === b.gid || !isOver(round, ev.time))) return false;
        const r = newRound(b.gid, b.cfg, String(b.seed || b.gid));
        r.startAt = ev.time + COUNTDOWN_SEC;
        r.endAt = r.startAt + r.cfg.durationSec;
        TEAMS.forEach(t => { r.teams[t].joined = !!st.claims[t]; });
        st.round = r;
        return true;
      }

      case 'END': {
        if (!round || round.gid !== b.gid || round.endedAt != null) return false;
        round.endedAt = Math.max(round.startAt, Math.min(ev.time, round.endAt));
        round.endReason = 'manual';
        return true;
      }

      case 'KICK': {
        const t = b.team;
        if (!TEAMS.includes(t) || !st.claims[t]) return false;
        delete st.claims[t];
        return true;
      }

      case 'JOIN': {
        const t = b.team;
        if (!TEAMS.includes(t) || !b.pub || !b.dev) return false;
        const cur = st.claims[t];
        if (cur) return false;                      // ghế đã có người (ai đến trước thắng)
        // một thiết bị chỉ giữ một ghế: bỏ ghế cũ nếu trận chưa chạy
        for (const k of TEAMS) {
          if (st.claims[k] && st.claims[k].dev === b.dev) {
            const running = round && round.endedAt == null && ev.time < round.endAt && round.teams[k].joined;
            if (running) return false;
            delete st.claims[k];
          }
        }
        st.claims[t] = { dev: b.dev, pub: b.pub };
        // vào muộn khi trận đang diễn ra vẫn tính là đội thi đấu
        if (round && round.endedAt == null && ev.time < round.endAt) round.teams[t].joined = true;
        return true;
      }

      case 'LEAVE': {
        const t = b.team;
        const cur = st.claims[t];
        if (!cur || cur.dev !== b.dev) return false;
        const started = round && round.teams[t].joined && round.endedAt == null && ev.time < round.endAt;
        if (started) return false;
        delete st.claims[t];
        return true;
      }

      case 'PICK': {
        if (!round || round.gid !== b.gid) return false;
        const t = b.team;
        if (!TEAMS.includes(t)) return false;
        const claim = st.claims[t];
        if (!claim || claim.dev !== b.dev) return false;
        const team = round.teams[t];
        if (!team.joined || team.finished) return false;
        if (ev.time < round.startAt || ev.time > effectiveEnd(round)) return false;
        if (!Number.isInteger(b.r) || !Number.isInteger(b.c) || !inBounds(b.r, b.c)) return false;
        const target = { r: b.r, c: b.c };
        if (!isAdjacent(team.pos, target)) return false;
        const maze = round.mazes[t];
        const cell = maze.cells[b.r][b.c];
        const rel = ev.time - round.startAt;
        if (cell.kind === 'finish') {
          team.pos = target;
          team.finished = true;
          team.finishAt = ev.time;
          team.steps.push({ t: ev.time, rel, r: b.r, c: b.c, ok: true });
          team.best = maze.steps; team.bestAt = ev.time;
        } else if (cell.valid) {
          team.pos = target;
          team.steps.push({ t: ev.time, rel, r: b.r, c: b.c, ok: true });
          const p = progressAt(maze, target);
          if (p > team.best) { team.best = p; team.bestAt = ev.time; }
        } else {
          team.errors++;
          team.steps.push({ t: ev.time, rel, r: b.r, c: b.c, ok: false });
        }
        // tất cả các đội tham gia đã về đích => kết thúc sớm
        const joined = TEAMS.filter(x => round.teams[x].joined);
        if (joined.length && joined.every(x => round.teams[x].finished) && round.endedAt == null) {
          round.endedAt = ev.time;
          round.endReason = 'all_finished';
        }
        return true;
      }

      case 'HELLO':
      default:
        return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Thống kê, xếp hạng, xem lại                                         */
  /* ------------------------------------------------------------------ */
  function teamSummary(round, t) {
    const tm = round.teams[t];
    const maze = round.mazes[t];
    const pen = round.cfg.penaltySec;
    const picks = tm.steps.length;
    const wrong = tm.errors;
    const elapsed = tm.finished ? tm.finishAt - round.startAt : null;
    return {
      team: t, joined: tm.joined, finished: tm.finished,
      progress: tm.best, steps: maze.steps,
      pct: Math.round(100 * tm.best / maze.steps),
      errors: wrong, penalty: wrong * pen,
      elapsed, total: tm.finished ? elapsed + wrong * pen : null,
      picks, accuracy: picks ? Math.round(100 * (picks - wrong) / picks) : null,
      bestAt: tm.bestAt
    };
  }

  function ranking(round) {
    if (!round) return [];
    const rows = TEAMS.map(t => teamSummary(round, t));
    const cmp = (a, b) => {
      if (a.joined !== b.joined) return a.joined ? -1 : 1;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) {
        return (a.total - b.total) || (a.errors - b.errors) || (a.elapsed - b.elapsed);
      }
      return (b.progress - a.progress) || (a.errors - b.errors)
        || ((a.bestAt == null ? Infinity : a.bestAt) - (b.bestAt == null ? Infinity : b.bestAt));
    };
    rows.sort((a, b) => cmp(a, b) || a.team - b.team);
    let rank = 0;
    rows.forEach((r, i) => {
      if (!r.joined) { r.rank = null; return; }
      if (i === 0 || cmp(rows[i - 1], r) !== 0) rank = i + 1;
      r.rank = rank;
    });
    return rows;
  }

  // Trạng thái một đội tại thời điểm tuyệt đối tAbs (giây giờ máy chủ) — dùng cho replay
  function teamAt(round, t, tAbs) {
    const tm = round.teams[t];
    const maze = round.mazes[t];
    let pos = { r: START.r, c: START.c }, errors = 0, best = 0, finished = false, finishAt = null;
    for (const s of tm.steps) {
      if (s.t > tAbs) break;
      if (s.ok) {
        pos = { r: s.r, c: s.c };
        if (maze.cells[s.r][s.c].kind === 'finish') { finished = true; finishAt = s.t; best = maze.steps; }
        else best = Math.max(best, progressAt(maze, pos));
      } else errors++;
    }
    return { pos, errors, progress: best, finished, finishAt, steps: maze.steps };
  }

  const pad2 = n => String(n).padStart(2, '0');
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  }

  return {
    ROWS, COLS, START, FINISH, TEAMS, TEAM_META, COUNTDOWN_SEC, WRONG_LOCK_MS,
    RULES, DIVISORS, STEPS_OPTIONS, MAX_VALID_INTERIOR,
    normCfg, makeMaze, shapesByLength, bfsDist, progressAt, isMultiple, explain, digitSum,
    isAdjacent, neighbors, fmtNum, fmtTime, key,
    createState, newRound, applyEvent, roundStatus, effectiveEnd,
    teamSummary, ranking, teamAt
  };
});
