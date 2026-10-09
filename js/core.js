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
  const COUNTDOWN_SEC = 3;      // 3-2-1 như bản gốc, tính từ lúc bấm "Bắt đầu"
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
    3: {
      label: '3',
      hint: 'Số có tổng các chữ số chia hết cho 3 thì chia hết cho 3.',
      explain: n => `tổng các chữ số = ${digitSum(n)}`
    }
  };
  const DIVISORS = [3];
  const isMultiple = (n, d) => n % d === 0;
  const explain = (d, n) => (RULES[d] || RULES[3]).explain(n);

  /* ------------------------------------------------------------------ */
  /* Cấu hình trận                                                       */
  /* ------------------------------------------------------------------ */
  function clampInt(v, lo, hi, dflt) {
    v = Math.round(Number(v));
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  }
  // Nội dung (số trong mê cung, chia hết cho 3, 6 bước) CỐ ĐỊNH theo giáo án — không còn tuỳ chọn.
  function normCfg(c) {
    c = c || {};
    return {
      divisor: 3,
      steps: 6,
      durationSec: clampInt(c.durationSec, 60, 1800, 180),
      penaltySec: clampInt(c.penaltySec, 0, 60, 10),
      showLanes: c.showLanes !== false,
      showHint: c.showHint !== false
    };
  }

  /* ------------------------------------------------------------------ */
  /* Mê cung CỐ ĐỊNH theo giáo án "Trò chơi đoàn xe 6A1"                  */
  /* (giữ nguyên MAZE_DATA của bản game gốc; mọi đội cùng một sơ đồ)       */
  /* ------------------------------------------------------------------ */
  const key = (r, c) => r * COLS + c;
  const inBounds = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  const isAdjacent = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
  function neighbors(r, c) {
    return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .filter(([a, b]) => inBounds(a, b)).map(([a, b]) => ({ r: a, c: b }));
  }
  const MAZE_VALUES = [
    [5, 24, 126, 72, 123, 136],
    [null, 21, 15, 36, 66, 1245],
    [12, 6, 19, 54, 77, null]
  ];
  const MAZE_LABELS = { 1245: '1 245' };   // đúng cách viết trong giáo án / bản gốc

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

  let _maze = null;
  function makeMaze() {
    if (_maze) return _maze;
    const cells = [];
    const valid = new Set();
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const v = MAZE_VALUES[r][c];
        if (r === START.r && c === START.c) row.push({ r, c, kind: 'start', val: null, label: 'START', valid: true });
        else if (r === FINISH.r && c === FINISH.c) row.push({ r, c, kind: 'finish', val: null, label: 'THÀNH CỔ', valid: true });
        else {
          const ok = v % 3 === 0;
          if (ok) valid.add(key(r, c));
          row.push({ r, c, kind: 'num', val: v, label: MAZE_LABELS[v] || String(v), valid: ok });
        }
      }
      cells.push(row);
    }
    const dist = bfsDist(valid);
    const steps = dist.get(key(START.r, START.c));
    const solution = [START];
    while (!(solution[solution.length - 1].r === FINISH.r && solution[solution.length - 1].c === FINISH.c)) {
      const cur = solution[solution.length - 1];
      const d = dist.get(key(cur.r, cur.c));
      solution.push(neighbors(cur.r, cur.c).find(n => dist.get(key(n.r, n.c)) === d - 1));
    }
    _maze = { rows: ROWS, cols: COLS, cells, steps, solution, dist, divisor: 3 };
    return _maze;
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
      mazes[t] = makeMaze();
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
    RULES, DIVISORS, MAZE_VALUES,
    normCfg, makeMaze, bfsDist, progressAt, isMultiple, explain, digitSum,
    isAdjacent, neighbors, fmtTime, key,
    createState, newRound, applyEvent, roundStatus, effectiveEnd,
    teamSummary, ranking, teamAt
  };
});
