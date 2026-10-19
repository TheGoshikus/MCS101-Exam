#!/usr/bin/env node
/*
 * Сервер сбора данных лендинга Follow. Без зависимостей, нужен только Node.js 18+.
 *
 *   ADMIN_TOKEN=секрет PORT=8080 node server/server.js
 *
 * Раздаёт лендинг и плеер, принимает записи сессий и заявки, хранит их в follow/data/:
 *   data/sessions/<sid>.jsonl — пачки событий одной записи (по строке на пачку)
 *   data/leads.jsonl          — заявки
 *
 * API:
 *   POST /api/track              — пачка событий от трекера
 *   POST /api/leads              — заявка с формы
 *   GET  /api/sessions?token=    — список записей
 *   GET  /api/sessions/<sid>?token= — одна запись целиком
 *   GET  /api/leads?token=       — список заявок
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const SESSIONS = path.join(DATA, 'sessions');
const LEADS = path.join(DATA, 'leads.jsonl');
const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY = 1024 * 1024;
const SID_RE = /^[a-z0-9]{6,16}-[a-z0-9]{1,16}$/;

if (!TOKEN) {
  console.warn('ВНИМАНИЕ: ADMIN_TOKEN не задан — записи и заявки доступны без пароля. Только для локальной проверки!');
}

fs.mkdirSync(SESSIONS, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!TOKEN) return true;
  return url.searchParams.get('token') === TOKEN || req.headers['x-admin-token'] === TOKEN;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (e) { return null; }
  }).filter(Boolean);
}

function loadSession(sid) {
  const chunks = readJsonl(path.join(SESSIONS, sid + '.jsonl')).sort((a, b) => a.seq - b.seq);
  if (!chunks.length) return null;
  const meta = (chunks.find((c) => c.meta) || {}).meta || {};
  const events = [];
  chunks.forEach((c) => { if (Array.isArray(c.events)) events.push(...c.events); });
  events.sort((a, b) => a[0] - b[0]);
  return { sid, vid: chunks[0].vid, meta, events };
}

function leadsBySid() {
  const map = {};
  readJsonl(LEADS).forEach((l) => { if (l.sid) map[l.sid] = l; });
  return map;
}

function summarize(session, lead) {
  const ev = session.events;
  const count = (type) => ev.filter((e) => e[1] === type).length;
  return {
    sid: session.sid,
    vid: session.vid,
    start: session.meta.start,
    duration: ev.length ? ev[ev.length - 1][0] : 0,
    events: ev.length,
    clicks: count('c'),
    touches: count('ts'),
    vw: session.meta.vw,
    vh: session.meta.vh,
    touch: session.meta.touch,
    ua: session.meta.ua,
    referrer: session.meta.referrer,
    utm: session.meta.utm,
    goals: ev.filter((e) => e[1] === 'g').map((e) => e[2]),
    lead: lead ? { name: lead.name, phone: lead.phone, created: lead.created } : null
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
    });
    return res.end();
  }

  if (req.method === 'POST' && p === '/api/track') {
    const chunk = await readBody(req);
    if (!chunk || !SID_RE.test(chunk.sid || '') || !Array.isArray(chunk.events)) return send(res, 400, { ok: false });
    const line = JSON.stringify({
      sid: chunk.sid,
      vid: String(chunk.vid || '').slice(0, 40),
      seq: Number(chunk.seq) || 0,
      meta: chunk.meta || undefined,
      events: chunk.events.slice(0, 5000),
      ip: chunk.meta ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : undefined
    });
    fs.appendFileSync(path.join(SESSIONS, chunk.sid + '.jsonl'), line + '\n');
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/leads') {
    const lead = await readBody(req);
    if (!lead || !lead.phone) return send(res, 400, { ok: false });
    const clean = {};
    Object.keys(lead).slice(0, 30).forEach((k) => { clean[k] = String(lead[k]).slice(0, 2000); });
    clean.received = new Date().toISOString();
    fs.appendFileSync(LEADS, JSON.stringify(clean) + '\n');
    console.log('Новая заявка:', clean.name, clean.phone);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p.startsWith('/api/')) {
    if (!authorized(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/leads') return send(res, 200, readJsonl(LEADS).reverse());

    if (p === '/api/sessions') {
      const leads = leadsBySid();
      const list = fs.readdirSync(SESSIONS)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => loadSession(f.slice(0, -6)))
        .filter(Boolean)
        .map((s) => summarize(s, leads[s.sid]))
        .sort((a, b) => (b.start || 0) - (a.start || 0));
      return send(res, 200, list);
    }

    const m = p.match(/^\/api\/sessions\/([a-z0-9-]+)$/);
    if (m && SID_RE.test(m[1])) {
      const s = loadSession(m[1]);
      if (!s) return send(res, 404, { ok: false });
      s.lead = leadsBySid()[s.sid] || null;
      return send(res, 200, s);
    }
  }

  return send(res, 404, { ok: false });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const top = path.relative(ROOT, file).split(path.sep)[0];

  // данные и код сервера наружу не отдаём
  if (!file.startsWith(ROOT + path.sep) || top === 'data' || top === 'server' || top.startsWith('.')) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(() => send(res, 400, { ok: false }));
  } else {
    serveStatic(req, res, url);
  }
}).listen(PORT, () => {
  console.log('Follow: лендинг   http://localhost:' + PORT + '/');
  console.log('Follow: записи    http://localhost:' + PORT + '/replay.html');
});
