'use strict';
/* Máy chủ giả lập ntfy.sh + phục vụ file tĩnh, dùng cho kiểm thử cục bộ.
   Chạy: node tests/mock-server.js [port]   (mặc định 8787)
   Hỗ trợ: POST /:topic, GET /:topic/json?poll=1&since=, GET /:topic/sse?since=  (all | id | <thời gian>) */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function createServer(opts = {}) {
  const topics = new Map();                 // topic -> { msgs: [], subs: Set<res> }
  const stats = { posts: 0 };
  let seq = 0;
  const getTopic = t => { if (!topics.has(t)) topics.set(t, { msgs: [], subs: new Set() }); return topics.get(t); };
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

  function since(topic, q) {
    const all = topic.msgs;
    if (!q || q === 'all') return all;
    const i = all.findIndex(m => m.id === q);
    if (i >= 0) return all.slice(i + 1);
    return all;                              // id lạ => trả hết (client chống trùng)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const m = url.pathname.match(/^\/(thanhgame_[a-z0-9_]+)(?:\/(json|sse))?$/);
    if (m) {
      const topic = getTopic(m[1]);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          if (opts.failPosts && opts.failPosts() ) { res.writeHead(429, cors); return res.end('{"error":"limit"}'); }
          stats.posts++;
          const msg = { id: 'm' + String(++seq).padStart(6, '0'), time: Math.floor(Date.now() / 1000) + (opts.timeOffset || 0), expires: 0, event: 'message', topic: m[1], message: body };
          topic.msgs.push(msg);
          for (const s of topic.subs) s.write(`data: ${JSON.stringify(msg)}\n\n`);
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(msg));
        });
        return;
      }
      if (m[2] === 'json') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/x-ndjson' });
        return res.end(since(topic, url.searchParams.get('since')).map(x => JSON.stringify(x)).join('\n'));
      }
      if (m[2] === 'sse') {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`event: open\ndata: ${JSON.stringify({ id: 'o' + (++seq), time: Math.floor(Date.now() / 1000), event: 'open', topic: m[1] })}\n\n`);
        for (const x of since(topic, url.searchParams.get('since'))) res.write(`data: ${JSON.stringify(x)}\n\n`);
        topic.subs.add(res);
        const ka = setInterval(() => res.write(`event: keepalive\ndata: ${JSON.stringify({ time: Math.floor(Date.now() / 1000), event: 'keepalive' })}\n\n`), opts.keepalive || 5000);
        req.on('close', () => { clearInterval(ka); topic.subs.delete(res); });
        return;
      }
    }
    // file tĩnh
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });

  // ngắt mọi kết nối SSE (mô phỏng mất mạng)
  server.dropSse = () => { for (const t of topics.values()) for (const s of t.subs) s.destroy(); };
  server.topics = topics; server.stats = stats;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  createServer().listen(port, '127.0.0.1', () => console.log('mock ntfy + static on http://localhost:' + port));
}
