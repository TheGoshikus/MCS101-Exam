#!/usr/bin/env node
/*
 * Сервер сбора данных лендинга Follow. Без зависимостей, нужен только Node.js 18+.
 *
 *   ADMIN_TOKEN=секрет PORT=8080 node server/server.js
 *
 * Раздаёт лендинг и плеер, принимает записи сессий и заявки, хранит их в follow/data/:
 *   data/sessions/<sid>.jsonl — пачки событий одной записи (по строке на пачку)
 *   data/signups.json         — заявки (email, согласия, анкета)
 *
 * API:
 *   POST /api/track              — пачка событий от трекера
 *   POST /api/leads              — заявка, шаг 1: email + согласия
 *   POST /api/leads/answer       — ответ на вопрос анкеты
 *   GET  /api/sessions?token=    — список записей
 *   GET  /api/sessions/<sid>?token= — одна запись целиком
 *   GET  /api/leads?token=       — список заявок
 *   GET  /api/leads.csv?token=   — выгрузка заявок в CSV (UTF-8 с BOM)
 *
 * Логика заявок та же, что в functions/api/[[path]].js (Cloudflare Pages + D1).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const SESSIONS = path.join(DATA, 'sessions');
const SIGNUPS = path.join(DATA, 'signups.json');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const DISPOSABLE = new Set(['mailinator.com', 'yopmail.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
  'guerrillamail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com', 'dropmail.me', 'mohmal.com',
  'emailondeck.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'tempmail.plus', 'mail.tm', 'minuteinbox.com']);
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const IP_LIMIT_PER_HOUR = 10;
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

function loadSignups() {
  try { return JSON.parse(fs.readFileSync(SIGNUPS, 'utf8')); } catch (e) { return []; }
}

function saveSignups(list) {
  const tmp = SIGNUPS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, SIGNUPS);
}

function leadsBySid() {
  const map = {};
  loadSignups().forEach((l) => { if (l.sid) map[l.sid] = l; });
  return map;
}

function str(v, max) {
  return v === undefined || v === null ? '' : String(v).slice(0, max || 500);
}

function randomCode(len) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len), (b) => abc[b % abc.length]).join('');
}

function consent(c) {
  return c && c.value === true ? { value: true, at: str(c.at, 40) || new Date().toISOString() } : { value: false, at: null };
}

// Пустые значения из повторной заявки не затирают уже сохранённые (UTM, карточки и т. п.)
function mergeData(prev, next) {
  const out = Object.assign({}, prev);
  Object.keys(next).forEach((k) => {
    const v = next[k];
    const empty = v === '' || v === null || (Array.isArray(v) && !v.length);
    if (!empty) out[k] = v;
  });
  out.consents = Object.assign({}, prev.consents, next.consents);
  if (prev.consents && prev.consents.news && prev.consents.news.value && !next.consents.news.value) {
    out.consents.news = prev.consents.news;
  }
  return out;
}

function createLead(body, ip) {
  if (body && body.website) return [200, { ok: true, id: 0, token: '', ref: '', place: null }];
  const email = str(body && body.email, 254).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return [400, { ok: false, error: 'invalid_email' }];
  if (DISPOSABLE.has(email.split('@')[1])) return [400, { ok: false, error: 'disposable' }];
  const consents = body.consents || {};
  const pd = consent(consents.pd);
  const age = consent(consents.age);
  if (!pd.value || !age.value) return [400, { ok: false, error: 'consent_required' }];

  const list = loadSignups();
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  if (list.filter((l) => l.ip === ip && l.created > hourAgo).length >= IP_LIMIT_PER_HOUR) {
    return [429, { ok: false, error: 'rate_limited' }];
  }

  const data = {
    consents: { pd, age, news: consent(consents.news) },
    cards: Array.isArray(body.cards) ? body.cards.map(Number).filter((n) => n >= 0 && n <= 4).slice(0, 5) : [],
    ref: str(body.ref, 40),
    ab_variant: str(body.ab_variant, 20),
    ym_client_id: str(body.ym_client_id, 40),
    referrer: str(body.referrer, 500),
    page: str(body.page, 500),
    vid: str(body.vid, 40)
  };
  UTM.forEach((k) => { data[k] = str(body[k], 200); });
  const sid = SID_RE.test(body.sid || '') ? body.sid : null;

  const index = list.findIndex((l) => l.email === email);
  if (index !== -1) {
    const l = list[index];
    l.data = mergeData(l.data, data);
    l.sid = sid || l.sid;
    l.updated = now;
    saveSignups(list);
    return [200, { ok: true, id: l.id, token: l.token, ref: l.ref_code, place: index + 1, repeat: true }];
  }
  const l = {
    id: list.length ? list[list.length - 1].id + 1 : 1,
    email,
    token: randomCode(24),
    ref_code: randomCode(8),
    referred_by: /^[a-z0-9]{4,40}$/.test(data.ref) ? data.ref : null,
    status: 'new',
    data,
    answers: {},
    sid,
    ip,
    created: now,
    updated: now
  };
  list.push(l);
  saveSignups(list);
  console.log('Новая заявка:', email);
  return [200, { ok: true, id: l.id, token: l.token, ref: l.ref_code, place: list.length }];
}

function saveAnswer(body) {
  const q = Number(body && body.q);
  if (!body || !(q >= 1 && q <= 5)) return [400, { ok: false }];
  const list = loadSignups();
  const l = list.find((x) => x.id === Number(body.id));
  if (!l || l.token !== body.token) return [403, { ok: false }];
  let value = body.answer;
  if (Array.isArray(value)) value = value.slice(0, 10).map((v) => str(v, 100));
  else if (value && typeof value === 'object') {
    const clean = {};
    Object.keys(value).slice(0, 5).forEach((k) => { if (value[k]) clean[str(k, 40)] = str(value[k], 100); });
    value = clean;
  } else if (value !== null && value !== undefined) value = str(value, 200);
  else value = null;
  l.answers['q' + q] = { value, status: value === null ? 'skipped' : 'answered', at: new Date().toISOString() };
  l.updated = new Date().toISOString();
  saveSignups(list);
  return [200, { ok: true }];
}

function leadsCsv(rows) {
  const Q = ['Смартфон', 'Устройства', 'Что изменить', 'Почему бросали', 'Возраст и город'];
  const head = ['id', 'email', 'статус', 'создана', 'согласие ПД', '18+', 'рассылка', 'карточки',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'реф-код', 'пришёл по коду', 'A/B', 'ClientID Метрики', 'источник'].concat(Q);
  const cell = (v) => {
    const t = v === null || v === undefined ? '' : (typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : Object.values(v).join(', ')) : String(v));
    return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const lines = rows.map((r) => {
    const d = r.data;
    const c = d.consents || {};
    const a = r.answers || {};
    return [r.id, r.email, r.status, r.created, c.pd && c.pd.at, c.age && c.age.at, c.news && c.news.value ? c.news.at : '',
      (d.cards || []).join(' '), d.utm_source, d.utm_medium, d.utm_campaign, d.utm_content, d.utm_term,
      r.ref_code, r.referred_by, d.ab_variant, d.ym_client_id, d.referrer]
      .concat([1, 2, 3, 4, 5].map((n) => (a['q' + n] ? (a['q' + n].value === null ? 'пропущен' : a['q' + n].value) : '')))
      .map(cell).join(';');
  });
  return '\ufeff' + [head.join(';')].concat(lines).join('\r\n');
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
    lead: lead ? { email: lead.email, created: lead.created } : null
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

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'POST' && p === '/api/leads') {
    const [status, body] = createLead(await readBody(req), ip);
    return send(res, status, body);
  }

  if (req.method === 'POST' && p === '/api/leads/answer') {
    const [status, body] = saveAnswer(await readBody(req));
    return send(res, status, body);
  }

  if (req.method === 'GET' && p.startsWith('/api/')) {
    if (!authorized(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/leads') return send(res, 200, loadSignups().map(({ token, ip: _ip, ...rest }) => rest).reverse());
    if (p === '/api/leads.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="follow-leads.csv"',
        'Cache-Control': 'no-store'
      });
      return res.end(leadsCsv(loadSignups().reverse()));
    }

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
      const l = leadsBySid()[s.sid];
      s.lead = l ? { email: l.email, created: l.created, answers: l.answers } : null;
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
  if (!file.startsWith(ROOT + path.sep) || top === 'data' || top === 'server' || top === 'functions' || top.startsWith('.')) {
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
