/*
 * API лендинга Follow для Cloudflare Pages Functions + D1.
 * Повторяет server/server.js: те же адреса и форматы, только данные хранятся в базе D1 (binding DB).
 *
 *   POST /api/track                 — пачка событий от трекера
 *   POST /api/leads                 — заявка с формы
 *   GET  /api/sessions?token=       — список записей
 *   GET  /api/sessions/<sid>?token= — одна запись целиком
 *   GET  /api/leads?token=          — список заявок
 *
 * Пароль для чтения — секрет ADMIN_TOKEN в настройках проекта Pages.
 */
const SID_RE = /^[a-z0-9]{6,16}-[a-z0-9]{1,16}$/;
const MAX_BODY = 1024 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chunks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sid TEXT NOT NULL, vid TEXT, seq INTEGER, meta TEXT, events TEXT NOT NULL,
     ip TEXT, country TEXT, created INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chunks_sid ON chunks (sid, seq)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     sid TEXT PRIMARY KEY, vid TEXT, start INTEGER, meta TEXT,
     duration INTEGER DEFAULT 0, events INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
     touches INTEGER DEFAULT 0, goals TEXT DEFAULT '', updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS leads (
     id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, data TEXT NOT NULL, received TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS leads_sid ON leads (sid)`
];

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('too large');
  return JSON.parse(text);
}

function authorized(request, url, env) {
  if (!env.ADMIN_TOKEN) return false;
  return url.searchParams.get('token') === env.ADMIN_TOKEN || request.headers.get('X-Admin-Token') === env.ADMIN_TOKEN;
}

async function track(request, env) {
  const chunk = await readBody(request);
  if (!chunk || !SID_RE.test(chunk.sid || '') || !Array.isArray(chunk.events)) return json({ ok: false }, 400);

  const events = chunk.events.slice(0, 5000);
  const meta = chunk.meta || null;
  const now = Date.now();
  const count = (type) => events.filter((e) => e[1] === type).length;
  const lastT = events.length ? Math.max(...events.map((e) => Number(e[0]) || 0)) : 0;
  const goals = events.filter((e) => e[1] === 'g').map((e) => String(e[2]));

  const db = env.DB;
  const stmts = [
    db.prepare('INSERT INTO chunks (sid, vid, seq, meta, events, ip, country, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(chunk.sid, String(chunk.vid || '').slice(0, 40), Number(chunk.seq) || 0,
        meta ? JSON.stringify(meta) : null, JSON.stringify(events),
        meta ? request.headers.get('CF-Connecting-IP') : null,
        request.cf && request.cf.country ? request.cf.country : null, now),
    db.prepare(`INSERT INTO sessions (sid, vid, start, meta, duration, events, clicks, touches, goals, updated)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(sid) DO UPDATE SET
                  start = COALESCE(sessions.start, excluded.start),
                  meta = COALESCE(sessions.meta, excluded.meta),
                  duration = MAX(sessions.duration, excluded.duration),
                  events = sessions.events + excluded.events,
                  clicks = sessions.clicks + excluded.clicks,
                  touches = sessions.touches + excluded.touches,
                  goals = sessions.goals || excluded.goals,
                  updated = excluded.updated`)
      .bind(chunk.sid, String(chunk.vid || '').slice(0, 40), meta ? Number(meta.start) || now : null,
        meta ? JSON.stringify(meta) : null, lastT, events.length, count('c'), count('ts'),
        goals.map((g) => ',' + g.replace(/,/g, '')).join(''), now)
  ];
  await db.batch(stmts);
  return json({ ok: true });
}

async function lead(request, env) {
  const data = await readBody(request);
  if (!data || !data.phone) return json({ ok: false }, 400);
  const clean = {};
  Object.keys(data).slice(0, 30).forEach((k) => { clean[k] = String(data[k]).slice(0, 2000); });
  clean.received = new Date().toISOString();
  await env.DB.prepare('INSERT INTO leads (sid, data, received) VALUES (?, ?, ?)')
    .bind(SID_RE.test(clean.sid || '') ? clean.sid : null, JSON.stringify(clean), clean.received).run();
  return json({ ok: true });
}

async function listSessions(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, l.data AS lead FROM sessions s
     LEFT JOIN leads l ON l.sid = s.sid
     ORDER BY s.start DESC LIMIT 500`).all();
  return json(results.map((r) => {
    const meta = r.meta ? JSON.parse(r.meta) : {};
    const lead = r.lead ? JSON.parse(r.lead) : null;
    return {
      sid: r.sid, vid: r.vid, start: r.start, duration: r.duration, events: r.events,
      clicks: r.clicks, touches: r.touches, vw: meta.vw, vh: meta.vh, touch: meta.touch,
      ua: meta.ua, referrer: meta.referrer, utm: meta.utm, goals: (r.goals || '').split(',').filter(Boolean),
      lead: lead ? { name: lead.name, phone: lead.phone, created: lead.created } : null
    };
  }));
}

async function getSession(env, sid) {
  const { results } = await env.DB.prepare('SELECT vid, seq, meta, events FROM chunks WHERE sid = ? ORDER BY seq').bind(sid).all();
  if (!results.length) return json({ ok: false }, 404);
  const metaRow = results.find((r) => r.meta);
  const events = [];
  results.forEach((r) => events.push(...JSON.parse(r.events)));
  events.sort((a, b) => a[0] - b[0]);
  const leadRow = await env.DB.prepare('SELECT data FROM leads WHERE sid = ? ORDER BY id DESC LIMIT 1').bind(sid).first();
  return json({
    sid, vid: results[0].vid, meta: metaRow ? JSON.parse(metaRow.meta) : {}, events,
    lead: leadRow ? JSON.parse(leadRow.data) : null
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token'
      }
    });
  }

  try {
    await ensureSchema(env.DB);

    if (request.method === 'POST' && p === '/api/track') return await track(request, env);
    if (request.method === 'POST' && p === '/api/leads') return await lead(request, env);

    if (request.method === 'GET') {
      if (!authorized(request, url, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      if (p === '/api/leads') {
        const { results } = await env.DB.prepare('SELECT data FROM leads ORDER BY id DESC LIMIT 1000').all();
        return json(results.map((r) => JSON.parse(r.data)));
      }
      if (p === '/api/sessions') return await listSessions(env);
      const m = p.match(/^\/api\/sessions\/([a-z0-9-]+)$/);
      if (m && SID_RE.test(m[1])) return await getSession(env, m[1]);
    }
    return json({ ok: false }, 404);
  } catch (e) {
    return json({ ok: false }, 400);
  }
}
