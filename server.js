// FXED Stork proxy: the token lives only in STORK_API_TOKEN (server env).
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const TOKEN = process.env.STORK_API_TOKEN;
const PORT = Number(process.env.PORT || 8787);
const REST = process.env.STORK_REST_URL || 'https://rest.jp.stork-oracle.network';
const WSS = process.env.STORK_WS_URL || 'wss://api.jp.stork-oracle.network/evm/subscribe';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const ASSETS = new Set((process.env.ALLOWED_ASSETS || [
  'SPCX_247_STORK','ANT_247_STORK','TSLA_247_STORK','AAPL_247_STORK','NVDA_247_STORK','XAGUSD_247_STORK','XAUUSD_247_STORK','QQQ_247_STORK','SPY_247_STORK',
  'EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD','BTCUSD','ETHUSD','COIN_24_5'
].join(',')).split(',').map(s => s.trim()).filter(Boolean));

if (!TOKEN) { console.error('STORK_API_TOKEN is not set'); process.exit(1); }
const AUTH = { Authorization: `Basic ${TOKEN}` };

function originOk(o) { return ORIGINS.includes('*') || (o && ORIGINS.includes(o)); }
function cors(req, res) {
  const o = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : (originOk(o) ? o : 'null'));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function pick(list) { return [...new Set(String(list || '').split(',').map(s => s.trim()).filter(a => ASSETS.has(a)))]; }

// Small cache so many browsers never exceed Stork's 5 req/s limit.
let cache = { at: 0, key: '', body: null }, inflight = null;
async function latest(assets) {
  const key = assets.slice().sort().join(',');
  if (cache.key === key && Date.now() - cache.at < 1000) return cache.body;
  if (inflight && inflight.key === key) return inflight.p;
  const p = (async () => {
    const r = await fetch(`${REST}/v1/prices/latest?assets=${encodeURIComponent(key)}`, { headers: AUTH });
    const body = { status: r.status, text: await r.text() };
    if (r.ok) cache = { at: Date.now(), key, body };
    return body;
  })().finally(() => { inflight = null; });
  inflight = { key, p };
  return p;
}

// OHLC history (Stork /v1/tradingview/history), cached so browsers share one upstream call.
const RES = { '1': 60, '5': 300, '15': 900, '60': 3600, '240': 14400, '1D': 86400, 'D': 86400, '1W': 604800, 'W': 604800 };
const histCache = new Map(), histInflight = new Map();
async function history(symbol, resolution, from, to) {
  const step = RES[resolution];
  const ttl = Math.min(60000, step * 1000);
  const f = Math.floor(from / step) * step, t = Math.ceil(to / step) * step;
  const key = `${symbol}|${resolution}|${f}|${t}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.body;
  if (histInflight.has(key)) return histInflight.get(key);
  const p = (async () => {
    const q = new URLSearchParams({ symbol, resolution, from: String(f), to: String(t) });
    const r = await fetch(`${REST}/v1/tradingview/history?${q}`, { headers: AUTH });
    const body = { status: r.status, text: await r.text() };
    if (r.ok) {
      histCache.set(key, { at: Date.now(), body });
      if (histCache.size > 500) histCache.delete(histCache.keys().next().value);
    }
    return body;
  })().finally(() => histInflight.delete(key));
  histInflight.set(key, p);
  return p;
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, assets: [...ASSETS] }));
  }
  if (url.pathname === '/v1/prices/latest' && req.method === 'GET') {
    const assets = pick(url.searchParams.get('assets'));
    if (!assets.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"no allowed assets"}'); }
    try {
      const b = await latest(assets);
      res.writeHead(b.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(b.text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"error":"upstream"}');
    }
  }
  if (url.pathname === '/v1/tradingview/history' && req.method === 'GET') {
    const symbol = pick(url.searchParams.get('symbol'))[0];
    const resolution = url.searchParams.get('resolution') || '';
    const now = Math.floor(Date.now() / 1000);
    const to = Math.min(Number(url.searchParams.get('to')) || now, now + 60);
    const from = Number(url.searchParams.get('from'));
    if (!symbol || !RES[resolution] || !Number.isFinite(from) || from <= 0 || from >= to || (to - from) / RES[resolution] > 1500) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad history request"}');
    }
    try {
      const b = await history(symbol, resolution, from, to);
      res.writeHead(b.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(b.text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end('{"error":"upstream"}');
    }
  }
  res.writeHead(404); res.end();
});

// WebSocket relay: browser -> /evm/subscribe (no key) -> Stork (with Basic header).
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path !== '/evm/subscribe' || !originOk(req.headers.origin)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', client => {
  const up = new WebSocket(WSS, { headers: AUTH });
  const queue = [];
  const sendUp = raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || !['subscribe', 'unsubscribe'].includes(m.type)) return;
    const data = pick((Array.isArray(m.data) ? m.data : m.assets || []).join(','));
    if (!data.length) return;
    const out = JSON.stringify({ type: m.type, data });
    up.readyState === WebSocket.OPEN ? up.send(out) : queue.push(out);
  };
  client.on('message', d => sendUp(d.toString()));
  up.on('open', () => { while (queue.length) up.send(queue.shift()); });
  up.on('message', d => { if (client.readyState === WebSocket.OPEN) client.send(d.toString()); });
  const close = () => { try { client.close(); } catch {} try { up.close(); } catch {} };
  up.on('close', close); up.on('error', close);
  client.on('close', close); client.on('error', close);
  const ping = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.ping(); }, 25000);
  client.on('close', () => clearInterval(ping));
});

server.listen(PORT, () => console.log(`fxed-stork-proxy listening on ${PORT}`));
