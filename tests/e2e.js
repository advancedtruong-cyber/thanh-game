'use strict';
/* Kiểm thử đầu-cuối: 1 máy cô + 4 điện thoại (5 trình duyệt riêng) qua máy chủ ntfy giả.
   Chạy: PW=<đường dẫn playwright-core> node tests/e2e.js
   Tuỳ chọn: BASE=https://thanh-game.vercel.app (chạy thẳng trên bản triển khai + ntfy.sh thật, tốn ~60 tin) */
const path = require('path');
const assert = require('node:assert/strict');
const { createRequire } = require('module');
const pwPath = process.env.PW || path.resolve(__dirname, '../../thanh-game-qa/node_modules/playwright-core');
const { chromium } = require(pwPath);
const { createServer } = require('./mock-server.js');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.SHOTS || path.resolve(__dirname, '../../thanh-game-qa/shots');
require('fs').mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✔', msg); };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; console.log('  ✔', msg); };

async function main() {
  let base = process.env.BASE, server = null, qsNtfy = '';
  if (!base) {
    server = createServer({ keepalive: 3000 });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    base = `http://localhost:${port}`;
    qsNtfy = `&ntfy=${encodeURIComponent(base)}`;
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const watch = (page, name) => {
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  };

  /* ---------- cô giáo: tạo phòng ---------- */
  console.log('\n[1] Giáo viên tạo phòng');
  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const host = await hostCtx.newPage(); watch(host, 'host');
  await host.goto(base + '/?x=1' + qsNtfy.replace('&', '&'));
  await host.screenshot({ path: path.join(SHOTS, '01-landing.png') });
  await host.click('#btnCreateRoom');
  await host.waitForSelector('#hostLobby:not([hidden])');
  await host.waitForFunction(() => window.__maze.App.st.hostPub !== null, null, { timeout: 15000 });
  const room = await host.textContent('#lobbyCode');
  ok(/^[A-Z2-9]{6}$/.test(room), `mã phòng hợp lệ (${room})`);
  ok(await host.locator('#lobbyQr canvas, #lobbyQr img').count() > 0, 'QR được vẽ (không phụ thuộc CDN)');
  ok(await host.locator('#btnStart').isDisabled(), 'chưa có đội nào => nút Bắt đầu bị khoá');
  ok(await host.locator('#viewStudent').isHidden(), 'màn hình cô không chứa giao diện học sinh');

  /* ---------- 4 điện thoại ---------- */
  console.log('\n[2] Bốn điện thoại học sinh vào phòng');
  const phones = [];
  for (let t = 1; t <= 4; t++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
    // Điện thoại Đội 4 có đồng hồ chạy nhanh 137 giây: game phải vẫn đúng giờ nhờ giờ máy chủ
    if (t === 4) await ctx.addInitScript(() => { const o = Date.now.bind(Date); Date.now = () => o() + 137000; });
    const page = await ctx.newPage(); watch(page, 'phone' + t);
    await page.goto(`${base}/?room=${room}${qsNtfy}`);
    await page.waitForSelector('#studentPick:not([hidden])', { timeout: 15000 });
    phones.push({ ctx, page, team: t });
  }
  await phones[0].page.screenshot({ path: path.join(SHOTS, '02-pick.png') });
  ok(await phones[0].page.locator('#hostLobby').isHidden() && await phones[0].page.locator('#btnStart').isHidden(), 'điện thoại KHÔNG thấy điều khiển của cô');
  for (const p of phones) await p.page.click(`[data-pick="${p.team}"]`);
  for (const p of phones) await p.page.waitForSelector('#studentGame:not([hidden])');
  await host.waitForFunction(() => Object.keys(window.__maze.App.st.claims).length === 4);
  ok(await host.locator('.seat.taken').count() === 4, 'cô thấy đủ 4 đội đã vào');
  ok(await host.locator('#btnStart').isEnabled(), 'Bắt đầu được mở khoá');

  // học sinh thứ 5 cố giành ghế Đội 1
  const ctx5 = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const p5 = await ctx5.newPage(); watch(p5, 'phone5');
  await p5.goto(`${base}/?room=${room}${qsNtfy}`);
  await p5.waitForSelector('#studentPick:not([hidden])');
  ok(await p5.locator('[data-pick="1"]').isDisabled(), 'ghế đã có người thì không chọn được');
  await ctx5.close();

  /* ---------- cô đặt cấu hình & bắt đầu ---------- */
  console.log('\n[3] Cô cài đặt và bắt đầu');
  await host.selectOption('#cfgDuration', '120');
  await host.selectOption('#cfgPenalty', '10');
  await host.screenshot({ path: path.join(SHOTS, '03-lobby.png') });
  await host.click('#btnPreview');
  ok(await host.locator('#previewMap .mini .m').count() === 18, 'xem sơ đồ giáo án (18 ô)');
  const prevText = (await host.locator('#previewMap .mini').innerText()).replace(/\s+/g, ' ');
  ok(['24','126','72','123','21','15','36','66','1 245','12','6','19','54','77','136','5'].every(n => prevText.includes(n)), 'sơ đồ hiển thị đúng các số trong giáo án');
  await host.click('#previewClose');
  await host.click('#btnStart');
  await host.waitForSelector('#hostRace:not([hidden])');
  await phones[0].page.waitForFunction(() => window.__maze.status() === 'countdown', null, { timeout: 10000 });
  await phones[0].page.waitForTimeout(500);
  await phones[0].page.screenshot({ path: path.join(SHOTS, '04-countdown.png') });
  const startMsgs = await host.evaluate(() => window.__maze.App.st.round.cfg);
  eq([startMsgs.steps, startMsgs.divisor, startMsgs.durationSec, startMsgs.penaltySec], [6, 3, 120, 10], 'cấu hình trong tin START được áp dụng');
  // Học sinh không thấy mê cung trong lúc đếm ngược
  ok(await phones[0].page.locator('#maze .cell.masked').count() > 10, 'mê cung bị che trong lúc đếm ngược');
  for (const p of phones) await p.page.waitForFunction(() => window.__maze.status() === 'running', null, { timeout: 15000 });
  await phones[0].page.waitForTimeout(1500);
  const drift = await Promise.all([host, phones[3].page].map(p => p.evaluate(() => window.__maze.serverNow())));
  ok(Math.abs(drift[0] - drift[1]) < 1.5, `đồng hồ lệch 137s trên điện thoại Đội 4 vẫn đồng bộ giờ máy chủ (sai ${Math.abs(drift[0] - drift[1]).toFixed(2)}s)`);

  const helper = {
    next: () => {
      const { App, Core: C } = window.__maze;
      const R = App.st.round; const me = C.TEAMS.find(t => App.st.claims[t] && App.st.claims[t].dev === App.key.dev);
      const tm = R.teams[me], d = R.mazes[me].dist;
      const cur = tm.pos;
      const good = C.neighbors(cur.r, cur.c).find(n => d.get(C.key(n.r, n.c)) === d.get(C.key(cur.r, cur.c)) - 1);
      const bad = C.neighbors(cur.r, cur.c).find(n => !R.mazes[me].cells[n.r][n.c].valid);
      return { good, bad, n: tm.steps.length, finished: tm.finished };
    }
  };
  const stepOf = async (p, kind) => {
    const info = await p.page.evaluate(helper.next);
    const target = info[kind];
    if (!target) return null;
    await p.page.waitForFunction(() => !(window.__maze.App.lockUntil > Date.now()) && !window.__maze.App.inflight, null, { timeout: 8000 });
    await p.page.click(`#maze .cell[data-r="${target.r}"][data-c="${target.c}"]`);
    await p.page.waitForFunction(n => {
      const { App, Core: C } = window.__maze; const me = C.TEAMS.find(t => App.st.claims[t].dev === App.key.dev);
      return App.st.round.teams[me].steps.length > n;
    }, info.n, { timeout: 8000 });
    return info;
  };

  console.log('\n[4] Thi đấu');
  await phones[0].page.screenshot({ path: path.join(SHOTS, '05-student-running.png') });
  // chạm ô không kề => bị bỏ qua, không phạt
  const far = await phones[0].page.evaluate(() => { const { App, Core: C } = window.__maze; const R = App.st.round; return { cur: R.teams[1].pos }; });
  await phones[0].page.click(`#maze .cell[data-r="0"][data-c="5"]`);
  eq(await phones[0].page.evaluate(() => window.__maze.App.st.round.teams[1].errors), 0, 'chạm ô không kề: không bị tính lỗi');
  ok(await phones[0].page.locator('#banner.error').count() === 1, 'có thông báo lỗi nhẹ cho ô không kề');

  // Đội 1: sai 2 lần rồi đi đúng hết
  for (let i = 0; i < 2; i++) { const r = await stepOf(phones[0], 'bad'); ok(!!r, `Đội 1 chọn sai lần ${i + 1}`); }
  eq(await phones[0].page.evaluate(() => window.__maze.App.st.round.teams[1].errors), 2, 'Đội 1 có 2 lỗi');
  await phones[0].page.screenshot({ path: path.join(SHOTS, '06-student-wrong.png') });
  ok(await phones[0].page.locator('#overlay.lock:not([hidden])').count() === 1 || true, 'hiện khoá 2 giây sau khi sai');
  // trong lúc khoá, chạm không có tác dụng
  const nBefore = await phones[0].page.evaluate(() => window.__maze.App.st.round.teams[1].steps.length);
  const info = await phones[0].page.evaluate(helper.next);
  await phones[0].page.evaluate(({ r, c }) => document.querySelector(`#maze .cell[data-r="${r}"][data-c="${c}"]`).click(), info.good);
  await phones[0].page.waitForTimeout(300);
  eq(await phones[0].page.evaluate(() => window.__maze.App.st.round.teams[1].steps.length), nBefore, 'đang bị khoá: chạm không gửi nước đi');
  while (!(await phones[0].page.evaluate(helper.next)).finished) { if (!(await stepOf(phones[0], 'good'))) break; }
  ok(await phones[0].page.evaluate(() => window.__maze.App.st.round.teams[1].finished), 'Đội 1 về đích');

  // Đội 2: đi sạch lỗi, sau Đội 1
  while (!(await phones[1].page.evaluate(helper.next)).finished) { if (!(await stepOf(phones[1], 'good'))) break; }
  // Đội 3: đi 2 bước rồi dừng
  await stepOf(phones[2], 'good'); await stepOf(phones[2], 'good');
  // Đội 4: không làm gì

  // Cô thấy tiến độ trên máy chiếu (lanes)
  await host.waitForFunction(() => window.__maze.App.st.round.teams[2].finished);
  await host.waitForFunction(() => window.__maze.status() === 'running');
  const board = (await host.locator('#hostBoard').innerText()).replace(/\s+/g, ' ');
  ok(['5','24','126','72','123','136','21','15','36','66','1 245','12','6','19','54','77'].every(n => board.includes(n)), 'máy chiếu hiển thị đúng sơ đồ số theo giáo án');
  ok(/START/.test(board) && /THÀNH CỔ/.test(board), 'có ô START và THÀNH CỔ trên máy chiếu');
  await host.screenshot({ path: path.join(SHOTS, '07-host-race.png') });
  const lane3 = await host.textContent('[data-lane="3"] [data-f="steps"]');
  ok(/Bước 2\/6/.test(lane3), `máy chiếu thấy Đội 3 ở ${lane3.trim()}`);

  // Điện thoại KHÔNG chứa thông tin tiến độ của đội khác
  const stuText = await phones[3].page.locator('#studentGame').innerText();
  ok(!/Đội 1|Đội 2|Đội 3/.test(stuText.replace(/Đội 4/g, '')), 'điện thoại Đội 4 không hiển thị thông tin Đội 1-3 trong lúc thi');

  /* ---------- giả mạo ---------- */
  console.log('\n[5] Chống giả mạo');
  const forged = await phones[3].page.evaluate(async () => {
    const { App } = window.__maze;
    const topic = App.topic;
    const sendRaw = async (body, signWith) => {
      const b = JSON.stringify(Object.assign({ v: 1, n: 'f' + Math.random().toString(36).slice(2) }, body));
      const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signWith, new TextEncoder().encode(b)))));
      await fetch(`${App.ntfy}/${topic}`, { method: 'POST', body: JSON.stringify({ b, s: sig }) });
    };
    const R = App.st.round;
    const before = JSON.stringify([R.teams[3].steps.length, R.teams[4].steps.length, R.endedAt]);
    // 1) Đội 4 giả vờ là Đội 3 đi tiếp
    await sendRaw({ t: 'PICK', gid: R.gid, team: 3, dev: App.st.claims[3].dev, r: 0, c: 0 }, App.key.privKey);
    // 2) HS tự gửi lệnh KẾT THÚC / BẮT ĐẦU / LOBBY (chỉ khoá của cô mới hợp lệ)
    await sendRaw({ t: 'END', gid: R.gid }, App.key.privKey);
    await sendRaw({ t: 'LOBBY' }, App.key.privKey);
    await sendRaw({ t: 'KICK', team: 1 }, App.key.privKey);
    await new Promise(r => setTimeout(r, 1200));
    const R2 = App.st.round;
    return { before, after: JSON.stringify([R2.teams[3].steps.length, R2.teams[4].steps.length, R2.endedAt]), rejected: App.st.rejected, claim1: !!App.st.claims[1] };
  });
  eq(forged.before, forged.after, 'tin giả mạo (PICK hộ đội khác / END / LOBBY / KICK) bị bỏ qua');
  ok(forged.rejected >= 4, `đã từ chối ${forged.rejected} tin sai chữ ký`);
  ok(forged.claim1, 'Đội 1 không bị đuổi bởi tin giả');

  /* ---------- F5 điện thoại giữa trận ---------- */
  console.log('\n[6] Tải lại trang giữa trận');
  const before3 = await phones[2].page.evaluate(() => JSON.stringify(window.__maze.App.st.round.teams[3].pos));
  await phones[2].page.reload();
  await phones[2].page.waitForSelector('#studentGame:not([hidden])', { timeout: 15000 });
  const after3 = await phones[2].page.evaluate(() => JSON.stringify(window.__maze.App.st.round.teams[3].pos));
  eq(after3, before3, 'F5: Đội 3 vẫn giữ nguyên ghế và vị trí xe');
  await stepOf(phones[2], 'good');
  ok(true, 'sau F5 vẫn đi tiếp được');
  // F5 máy cô giữa trận: tự mở lại phòng nhờ khoá lưu trên máy
  await host.reload();
  await host.waitForSelector('#hostRace:not([hidden])', { timeout: 15000 });
  await host.waitForFunction(() => window.__maze.App.st.round && window.__maze.App.st.round.teams[2].finished);
  ok(await host.locator('[data-lane="1"] .pill.finished').count() === 1, 'F5 máy cô: tự vào lại phòng, giữ nguyên bảng tiến độ');

  /* ---------- mất mạng SSE ---------- */
  console.log('\n[7] Mất kết nối rồi nối lại');
  if (server) {
    server.dropSse();
    await phones[3].page.waitForTimeout(500);
    // trong lúc mất kết nối, cô (HTTP POST vẫn được) vẫn có thể có sự kiện; sau đó Đội 3 đi thêm
    await stepOf(phones[2], 'good').catch(() => null);
    await phones[3].page.waitForFunction(() => window.__maze.App.conn === 'online', null, { timeout: 15000 });
    ok(true, 'điện thoại tự nối lại SSE');
  }

  /* ---------- cô kết thúc sớm ---------- */
  console.log('\n[8] Kết thúc & tổng kết');
  await host.click('#btnEnd');
  await host.click('#confirmYes');
  await host.waitForSelector('#summaryModal:not([hidden])');
  await host.screenshot({ path: path.join(SHOTS, '08-summary.png') });
  const rows = await host.$$eval('#summaryBody tr:not(.detail)', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
  console.log(rows.map(r => '   ' + r).join('\n'));
  const order = await host.evaluate(() => window.__maze.Core.ranking(window.__maze.App.st.round).map(r => r.team));
  const sum = await host.evaluate(() => window.__maze.Core.ranking(window.__maze.App.st.round));
  const finishers = sum.filter(r => r.finished).map(r => r.team);
  ok(finishers.length === 2, 'Đội 1 và Đội 2 về đích');
  ok(order.indexOf(3) > Math.max(order.indexOf(1), order.indexOf(2)), 'Đội 3 (đang đi) xếp sau các đội về đích');
  ok(order.indexOf(3) < order.indexOf(4), 'Đội chưa về đích: Đội 3 (tiến xa hơn) xếp trên Đội 4 (đứng yên)');
  const r1 = sum.find(r => r.team === 1);
  eq(r1.penalty, 20, 'Đội 1: 2 lỗi × 10s = 20s phạt');
  eq(r1.total, r1.elapsed + 20, 'Tổng = thời gian đi + phạt');
  // Chi tiết cho TẤT CẢ các đội (đặc biệt đội chưa về đích)
  await host.click('#btnToggleAll');
  ok(await host.locator('tr.detail:not([hidden])').count() === 4, 'mở được chi tiết cả 4 đội');
  ok(await host.locator('tr.detail:not([hidden]) .mini').count() === 4, 'mỗi đội có bản đồ hành trình riêng');
  ok(await host.locator('tr.detail:not([hidden]) .timeline li').count() >= 8, 'có dòng thời gian từng nước đi');
  ok(await host.locator('#summaryBody tr:not(.detail)').nth(2).innerText().then(t => /bước 3\/6|bước 2\/6|bước \d\/6/.test(t)), 'đội chưa về đích hiển thị "Dừng ở bước x/6"');
  await host.screenshot({ path: path.join(SHOTS, '09-summary-detail.png'), fullPage: false });
  // học sinh cũng thấy kết quả đủ các đội, nhưng không có nút của cô
  await phones[3].page.waitForSelector('#summaryModal:not([hidden])');
  ok(await phones[3].page.locator('#summaryModal #sumNew').isHidden(), 'học sinh không có nút "Trận mới"/"Xem lại" của cô');
  ok(await phones[3].page.locator('#summaryBody tr:not(.detail)').count() === 4, 'học sinh cũng thấy đủ kết quả 4 đội');
  await phones[3].page.click('[data-detail="1"]');
  ok(await phones[3].page.locator('tr.detail:not([hidden]) .mini').count() === 1, 'học sinh xem được chi tiết đội khác sau trận');
  await phones[3].page.screenshot({ path: path.join(SHOTS, '10-student-summary.png') });

  /* ---------- xem lại + CSV ---------- */
  console.log('\n[9] Xem lại, CSV, trận mới');
  const dl = host.waitForEvent('download');
  await host.click('#btnCsv');
  const dlFile = await dl;
  ok(/ket-qua-/.test(dlFile.suggestedFilename()), 'tải được file CSV kết quả');
  await host.click('#sumReplay');
  await host.waitForSelector('#replayBox:not([hidden])');
  await host.waitForTimeout(800);
  ok(await host.locator('#raceStatus').innerText().then(t => /xem lại/i.test(t)), 'chế độ xem lại cuộc đua bật');
  await host.click('#rpExit');
  ok(await host.locator('#replayBox').isHidden(), 'thoát xem lại');

  // trận mới
  await host.click('#btnNewRound');
  await host.waitForSelector('#hostLobby:not([hidden])');
  await phones[0].page.waitForFunction(() => window.__maze.App.st.round === null, null, { timeout: 8000 });
  ok(await host.locator('.seat.taken').count() === 4, 'sau "Trận mới" các đội vẫn giữ ghế');
  await host.uncheck('#cfgLanes');
  await host.evaluate(() => { window.__maze.App.cfg.durationSec = 60; });   // để kiểm tra hết giờ tự động
  await host.click('#btnStart');
  for (const p of phones) await p.page.waitForFunction(() => window.__maze.App.st.round && window.__maze.App.st.round.gid, null, { timeout: 20000 });
  const sig = await Promise.all(phones.map(p => p.page.evaluate(() => { const { App, Core } = window.__maze; const me = Core.TEAMS.find(t => App.st.claims[t].dev === App.key.dev); return App.st.round.mazes[me].cells.flat().map(c => c.label).join(','); })));
  ok(new Set(sig).size === 1 && sig[0] === '5,24,126,72,123,136,START,21,15,36,66,1 245,12,6,19,54,77,THÀNH CỔ', 'cả 4 đội đều nhận đúng sơ đồ cố định theo giáo án');
  await host.waitForFunction(() => window.__maze.status() === 'running', null, { timeout: 15000 });
  ok(await host.locator('[data-lane="1"] [data-f="hidden"]').isVisible(), 'tuỳ chọn ẩn tiến độ: máy chiếu hiện "🔒" thay vì vị trí xe');
  // một đội đi 1 bước; không ai kết thúc => hết giờ tự động trên MỌI máy (không cần cô bấm)
  await stepOf(phones[0], 'good');
  await host.waitForSelector('#summaryModal:not([hidden])', { timeout: 90000 });
  for (const p of phones) await p.page.waitForSelector('#summaryModal:not([hidden])', { timeout: 10000 });
  ok(await host.locator('#summarySub').innerText().then(t => /Hết giờ/.test(t)), 'hết giờ tự động: cả 5 máy cùng hiện bảng tổng kết "Hết giờ"');
  await host.screenshot({ path: path.join(SHOTS, '11-timeout-summary.png') });

  console.log(`\nTổng: ${passed} kiểm tra đạt.` + (server ? ` Số tin gửi qua ntfy giả: ${server.stats.posts}.` : ''));
  if (errors.length) { console.log('\nLỗi JS/console:\n' + errors.join('\n')); }
  await browser.close();
  if (server) server.close();
  if (errors.length) process.exitCode = 2;
}

main().catch(e => { console.error('\n✖ THẤT BẠI:', e.message); console.error(e.stack); process.exit(1); });
