'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

const PUB = { kty: 'EC', x: 'host', y: 'host' };
function setup(cfg = {}, seed = 'seed-1') {
  const st = Core.createState();
  let id = 0, time = 1000;
  const ev = (body, dt = 0) => ({ id: 'e' + (++id), time: (time += dt), body });
  Core.applyEvent(st, ev({ t: 'ROOM', pub: PUB }));
  const start = (gid = 'g1', c = cfg, sd = seed) => Core.applyEvent(st, ev({ t: 'START', gid, cfg: c, seed: sd }));
  return { st, ev, start, now: () => time };
}
const seat = (st, ev, t, dev = 'dev' + t) =>
  Core.applyEvent(st, ev({ t: 'JOIN', team: t, dev, pub: { x: dev } }));

// đường đi đúng của một đội (danh sách ô sau START, gồm cả FINISH)
function solutionMoves(maze) { return maze.solution.slice(1); }
const pick = (st, ev, t, cell, dt = 1) =>
  Core.applyEvent(st, ev({ t: 'PICK', gid: 'g1', team: t, dev: 'dev' + t, r: cell.r, c: cell.c }, dt));

test('mê cung: khớp từng ô với giáo án (và bản game gốc)', () => {
  const m = Core.makeMaze();
  const grid = m.cells.map(row => row.map(c => c.kind === 'start' ? 'START' : c.kind === 'finish' ? 'FINISH' : c.label));
  assert.deepEqual(grid, [
    ['5', '24', '126', '72', '123', '136'],
    ['START', '21', '15', '36', '66', '1 245'],
    ['12', '6', '19', '54', '77', 'FINISH']
  ]);
  assert.deepEqual(m.cells.flat().filter(c => c.kind === 'num' && !c.valid).map(c => c.val).sort((a, b) => a - b), [5, 19, 77, 136]);
  for (const c of m.cells.flat()) if (c.kind === 'num') assert.equal(c.valid, c.val % 3 === 0);
  assert.equal(m.steps, 6);
  assert.deepEqual(m.solution.map(p => m.cells[p.r][p.c].label), ['START', '21', '15', '36', '66', '1 245', 'THÀNH CỔ']);
});

test('mê cung: mọi đội dùng đúng một sơ đồ, cấu hình không đổi được nội dung', () => {
  const st = Core.createState();
  Core.applyEvent(st, { id: 'a', time: 1, body: { t: 'ROOM', pub: { x: 1 } } });
  Core.applyEvent(st, { id: 'b', time: 2, body: { t: 'START', gid: 'g', cfg: { divisor: 5, steps: 10, sameMaze: false, seed: 'x' }, seed: 's' } });
  const R = st.round;
  assert.equal(R.cfg.divisor, 3);
  assert.equal(R.cfg.steps, 6);
  for (const t of Core.TEAMS) assert.equal(R.mazes[t], R.mazes[1]);
  assert.equal(R.startAt, 2 + 3, 'đếm ngược 3 giây như bản gốc');
});

test('ghế: ai đến trước được, một thiết bị một ghế, KICK/LEAVE', () => {
  const { st, ev, start } = setup();
  assert.equal(seat(st, ev, 1, 'A'), true);
  assert.equal(seat(st, ev, 1, 'B'), false, 'đã có người');
  assert.equal(seat(st, ev, 2, 'A'), true, 'A chuyển sang ghế 2');
  assert.equal(st.claims[1], undefined);
  assert.equal(Core.applyEvent(st, ev({ t: 'KICK', team: 2 })), true);
  assert.equal(seat(st, ev, 2, 'B'), true);
  assert.equal(Core.applyEvent(st, ev({ t: 'LEAVE', team: 2, dev: 'X' })), false);
  assert.equal(Core.applyEvent(st, ev({ t: 'LEAVE', team: 2, dev: 'B' })), true);
});

test('PICK hợp lệ/không hợp lệ', () => {
  const { st, ev, start } = setup({ penaltySec: 10, steps: 6 });
  seat(st, ev, 1); seat(st, ev, 2);
  start();
  const R = st.round;
  // đưa đồng hồ tới sau startAt
  let guard = 0; while (true) { const e = ev({ t: 'HELLO' }, 1); if (e.time >= R.startAt || ++guard > 50) break; }
  const m1 = R.mazes[1];
  const sol = solutionMoves(m1);
  // chạm ô không kề => bỏ qua
  const far = m1.cells.flat().find(c => !Core.isAdjacent(Core.START, c) && !(c.r === 1 && c.c === 0));
  assert.equal(pick(st, ev, 1, far), false);
  // sai người (dev khác)
  assert.equal(Core.applyEvent(st, ev({ t: 'PICK', gid: 'g1', team: 1, dev: 'devX', r: sol[0].r, c: sol[0].c })), false);
  // sai gid
  assert.equal(Core.applyEvent(st, ev({ t: 'PICK', gid: 'old', team: 1, dev: 'dev1', r: sol[0].r, c: sol[0].c })), false);
  // ô sai kề START (nếu có) => +1 lỗi
  const wrong = Core.neighbors(Core.START.r, Core.START.c).map(n => m1.cells[n.r][n.c]).find(c => !c.valid);
  if (wrong) { assert.equal(pick(st, ev, 1, wrong), true); assert.equal(R.teams[1].errors, 1); assert.deepEqual(R.teams[1].pos, Core.START); }
  // đi đúng toàn bộ
  for (const cell of sol) assert.equal(pick(st, ev, 1, cell), true);
  assert.equal(R.teams[1].finished, true);
  const s1 = Core.teamSummary(R, 1);
  assert.equal(s1.progress, 6);
  assert.equal(s1.total, s1.elapsed + s1.errors * 10);
  // đã về đích => bỏ qua mọi tin sau đó
  assert.equal(pick(st, ev, 1, sol[0]), false);
  // đội 2 chưa về đích => trận chưa kết thúc sớm
  assert.equal(R.endedAt, null);
});

test('xếp hạng: về đích theo tổng thời gian; chưa về đích theo tiến độ; đội vắng cuối bảng', () => {
  const { st, ev, start } = setup({ penaltySec: 10, steps: 6 });
  [1, 2, 3].forEach(t => seat(st, ev, t));
  start();
  const R = st.round;
  while (true) { const e = ev({ t: 'HELLO' }, 1); if (e.time >= R.startAt) break; }
  const sol = t => solutionMoves(R.mazes[t]);
  // Đội 1: về đích nhưng sai 3 lần (phạt 30s)
  const wrongOf = t => { const m = R.mazes[t]; const pos = R.teams[t].pos; return Core.neighbors(pos.r, pos.c).map(n => m.cells[n.r][n.c]).find(c => !c.valid && c.kind === 'num'); };
  for (let i = 0; i < 3; i++) { const w = wrongOf(1); if (w) pick(st, ev, 1, w, 1); }
  sol(1).forEach(c => pick(st, ev, 1, c, 1));
  // Đội 2: về đích sạch lỗi, chậm hơn một chút
  ev({ t: 'HELLO' }, 5);
  sol(2).forEach(c => pick(st, ev, 2, c, 1));
  // Đội 3: đi được 2 bước
  sol(3).slice(0, 2).forEach(c => pick(st, ev, 3, c, 1));
  const rk = Core.ranking(R);
  const order = rk.map(r => r.team);
  assert.equal(order[order.length - 1], 4, 'đội vắng cuối bảng');
  assert.equal(rk.find(r => r.team === 4).rank, null);
  const r1 = rk.find(r => r.team === 1), r2 = rk.find(r => r.team === 2), r3 = rk.find(r => r.team === 3);
  assert.ok(r3.rank > r1.rank && r3.rank > r2.rank, 'chưa về đích xếp sau đội về đích');
  assert.equal(r3.progress, 2);
  assert.ok(r3.pct > 0 && r3.pct < 100);
  if (r1.errors >= 1) assert.ok(r1.total === r1.elapsed + r1.errors * 10);
});

test('tất cả đội tham gia về đích => kết thúc sớm; PICK sau END/hết giờ bị bỏ', () => {
  const { st, ev, start } = setup({ steps: 6, durationSec: 60 });
  seat(st, ev, 1); seat(st, ev, 2);
  start();
  const R = st.round;
  while (true) { const e = ev({ t: 'HELLO' }, 1); if (e.time >= R.startAt) break; }
  solutionMoves(R.mazes[1]).forEach(c => pick(st, ev, 1, c));
  assert.equal(R.endedAt, null);
  solutionMoves(R.mazes[2]).forEach(c => pick(st, ev, 2, c));
  assert.equal(R.endReason, 'all_finished');
  assert.ok(Core.roundStatus(R, R.endedAt + 1) === 'ended');
});

test('hết giờ: tin PICK sau endAt bị bỏ qua; END thủ công', () => {
  const { st, ev, start } = setup({ steps: 6, durationSec: 60 });
  seat(st, ev, 1);
  start();
  const R = st.round;
  assert.equal(Core.roundStatus(R, R.startAt - 1), 'countdown');
  assert.equal(Core.roundStatus(R, R.startAt + 1), 'running');
  assert.equal(Core.roundStatus(R, R.endAt), 'ended');
  while (true) { const e = ev({ t: 'HELLO' }, 1); if (e.time > R.endAt) break; }
  assert.equal(pick(st, ev, 1, solutionMoves(R.mazes[1])[0]), false);
});

test('END thủ công; LOBBY và START mới đặt lại ván, giữ ghế', () => {
  const { st, ev, start } = setup({ penaltySec: 10 });
  seat(st, ev, 1);
  start();
  assert.equal(start('g2', { durationSec: 300 }, 's2'), false, 'đang chạy thì không START chồng');
  assert.equal(Core.applyEvent(st, ev({ t: 'LOBBY' })), false, 'đang chạy thì không về sảnh');
  assert.equal(Core.applyEvent(st, ev({ t: 'END', gid: 'g1' }, 10)), true);
  assert.equal(st.round.endReason, 'manual');
  assert.equal(start('g1'), false, 'trùng gid');
  assert.equal(start('g2', { durationSec: 300 }, 's2'), true);
  assert.ok(st.claims[1], 'ghế vẫn còn');
  assert.equal(st.round.cfg.durationSec, 300);
  Core.applyEvent(st, ev({ t: 'END', gid: 'g2' }, 1));
  assert.equal(Core.applyEvent(st, ev({ t: 'LOBBY' })), true);
  assert.equal(st.round, null);
});

test('START chỉ có tác dụng khi đã có ROOM; ROOM đầu tiên thắng', () => {
  const st = Core.createState();
  assert.equal(Core.applyEvent(st, { id: 'a', time: 1, body: { t: 'START', gid: 'g', cfg: {}, seed: 's' } }), false);
  assert.equal(Core.applyEvent(st, { id: 'b', time: 2, body: { t: 'ROOM', pub: { x: 1 } } }), true);
  assert.equal(Core.applyEvent(st, { id: 'c', time: 3, body: { t: 'ROOM', pub: { x: 2 } } }), false);
  assert.equal(st.hostPub.x, 1);
});

test('teamAt: dựng lại trạng thái theo thời điểm (replay)', () => {
  const { st, ev, start } = setup({ steps: 6 });
  seat(st, ev, 1);
  start();
  const R = st.round;
  while (true) { const e = ev({ t: 'HELLO' }, 1); if (e.time >= R.startAt) break; }
  const sol = solutionMoves(R.mazes[1]);
  const times = sol.map(c => { pick(st, ev, 1, c, 2); return R.teams[1].steps.at(-1).t; });
  assert.equal(Core.teamAt(R, 1, R.startAt).progress, 0);
  assert.equal(Core.teamAt(R, 1, times[1]).progress, 2);
  assert.equal(Core.teamAt(R, 1, times.at(-1)).finished, true);
});

test('định dạng', () => {
  assert.equal(Core.fmtTime(65), '01:05');
  assert.equal(Core.fmtTime(-3), '00:00');
  assert.match(Core.explain(3, 1245), /= 12/);
});
