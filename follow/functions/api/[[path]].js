/*
 * API лендинга Follow для Cloudflare Pages Functions + D1.
 * Повторяет server/server.js: те же адреса и форматы, только данные хранятся в базе D1 (binding DB).
 *
 *   POST /api/track                 — пачка событий от трекера
 *   POST /api/leads                 — заявка, шаг 1: email + согласия (повторный email обновляет заявку)
 *   POST /api/leads/answer          — ответ на вопрос анкеты {id, token, q: 1..5, answer}
 *   GET  /api/sessions?token=       — список записей
 *   GET  /api/sessions/<sid>?token= — одна запись целиком
 *   GET  /api/leads?token=          — список заявок
 *   GET  /api/leads.csv?token=      — выгрузка заявок (UTF-8 с BOM, открывается в Excel)
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
  `CREATE INDEX IF NOT EXISTS leads_sid ON leads (sid)`,
  `CREATE TABLE IF NOT EXISTS signups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE, token TEXT NOT NULL, ref_code TEXT NOT NULL UNIQUE, referred_by TEXT,
     status TEXT NOT NULL DEFAULT 'new', data TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}',
     sid TEXT, ip TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS signups_sid ON signups (sid)`,
  `CREATE INDEX IF NOT EXISTS signups_ip ON signups (ip, created)`
];

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const DISPOSABLE = new Set(['mailinator.com', 'yopmail.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
  'guerrillamail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com', 'dropmail.me', 'mohmal.com',
  'emailondeck.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'tempmail.plus', 'mail.tm', 'minuteinbox.com']);
const IP_LIMIT_PER_HOUR = 10;
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

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

function str(v, max) {
  return v === undefined || v === null ? '' : String(v).slice(0, max || 500);
}

function randomCode(len) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
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

async function placeOf(db, id) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM signups WHERE id <= ?').bind(id).first();
  return row ? row.n : null;
}

async function lead(request, env) {
  const body = await readBody(request);
  // ловушка для ботов: делаем вид, что всё хорошо
  if (body && body.website) return json({ ok: true, id: 0, token: '', ref: '', place: null });

  const email = str(body && body.email, 254).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid_email' }, 400);
  if (DISPOSABLE.has(email.split('@')[1])) return json({ ok: false, error: 'disposable' }, 400);

  const consents = body.consents || {};
  const pd = consent(consents.pd);
  const age = consent(consents.age);
  if (!pd.value || !age.value) return json({ ok: false, error: 'consent_required' }, 400);

  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND created > ?').bind(ip, hourAgo).first();
  if (recent && recent.n >= IP_LIMIT_PER_HOUR) return json({ ok: false, error: 'rate_limited' }, 429);

  const data = {
    consents: { pd, age, news: consent(consents.news) },
    cards: Array.isArray(body.cards) ? body.cards.map(Number).filter((n) => n >= 0 && n <= 4).slice(0, 5) : [],
    ref: str(body.ref, 40),
    ab_variant: str(body.ab_variant, 20),
    ym_client_id: str(body.ym_client_id, 40),
    referrer: str(body.referrer, 500),
    page: str(body.page, 500),
    vid: str(body.vid, 40),
    country: request.cf && request.cf.country ? request.cf.country : '',
    user_agent: str(request.headers.get('User-Agent'), 300)
  };
  UTM.forEach((k) => { data[k] = str(body[k], 200); });
  const sid = SID_RE.test(body.sid || '') ? body.sid : null;

  const existing = await db.prepare('SELECT id, token, ref_code, data FROM signups WHERE email = ?').bind(email).first();
  if (existing) {
    // Дубль email не создаёт вторую заявку, а обновляет первую (ТЗ, разд. 7)
    const prev = JSON.parse(existing.data);
    const merged = mergeData(prev, data);
    await db.prepare('UPDATE signups SET data = ?, sid = COALESCE(?, sid), updated = ? WHERE id = ?')
      .bind(JSON.stringify(merged), sid, now, existing.id).run();
    return json({ ok: true, id: existing.id, token: existing.token, ref: existing.ref_code, place: await placeOf(db, existing.id), repeat: true });
  }

  const token = randomCode(24);
  let refCode = randomCode(8);
  const referredBy = data.ref && /^[a-z0-9]{4,40}$/.test(data.ref) ? data.ref : null;
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await db.prepare(`INSERT INTO signups (email, token, ref_code, referred_by, data, sid, ip, created, updated)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(email, token, refCode, referredBy, JSON.stringify(data), sid, ip, now, now).run();
      break;
    } catch (e) {
      if (!/UNIQUE/.test(String(e))) throw e;
      // совпал реф-код (или email пришёл одновременно с другого запроса)
      const again = await db.prepare('SELECT id, token, ref_code FROM signups WHERE email = ?').bind(email).first();
      if (again) return json({ ok: true, id: again.id, token: again.token, ref: again.ref_code, place: await placeOf(db, again.id), repeat: true });
      refCode = randomCode(8);
    }
  }
  const id = res.meta.last_row_id;
  return json({ ok: true, id, token, ref: refCode, place: await placeOf(db, id) });
}

async function answer(request, env) {
  const body = await readBody(request);
  const q = Number(body && body.q);
  if (!body || !(q >= 1 && q <= 5)) return json({ ok: false }, 400);
  const id = Number(body.id) || 0;
  const row = await env.DB.prepare('SELECT token FROM signups WHERE id = ?').bind(id).first();
  if (!row || row.token !== body.token) return json({ ok: false }, 403);

  let value = body.answer;
  if (Array.isArray(value)) value = value.slice(0, 10).map((v) => str(v, 100));
  else if (value && typeof value === 'object') {
    const clean = {};
    Object.keys(value).slice(0, 5).forEach((k) => { if (value[k]) clean[str(k, 40)] = str(value[k], 100); });
    value = clean;
  } else if (value !== null && value !== undefined) value = str(value, 200);
  else value = null;

  // json_set в одном UPDATE: ответы, пришедшие почти одновременно, не затирают друг друга
  const now = new Date().toISOString();
  const entry = { value, status: value === null ? 'skipped' : 'answered', at: now };
  await env.DB.prepare(`UPDATE signups SET answers = json_set(COALESCE(answers, '{}'), '$.q${q}', json(?)), updated = ? WHERE id = ?`)
    .bind(JSON.stringify(entry), now, id).run();
  return json({ ok: true });
}

async function listLeads(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, email, ref_code, referred_by, status, data, answers, sid, created, updated FROM signups ORDER BY id DESC LIMIT 5000').all();
  return results.map((r) => Object.assign({}, r, { data: JSON.parse(r.data), answers: JSON.parse(r.answers || '{}') }));
}

function csv(rows) {
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

async function listSessions(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, l.email AS lead_email, l.created AS lead_created FROM sessions s
     LEFT JOIN signups l ON l.sid = s.sid
     ORDER BY s.start DESC LIMIT 500`).all();
  return json(results.map((r) => {
    const meta = r.meta ? JSON.parse(r.meta) : {};
    const lead = r.lead_email ? { email: r.lead_email, created: r.lead_created } : null;
    return {
      sid: r.sid, vid: r.vid, start: r.start, duration: r.duration, events: r.events,
      clicks: r.clicks, touches: r.touches, vw: meta.vw, vh: meta.vh, touch: meta.touch,
      ua: meta.ua, referrer: meta.referrer, utm: meta.utm, goals: (r.goals || '').split(',').filter(Boolean),
      lead
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
  const leadRow = await env.DB.prepare('SELECT email, created, answers FROM signups WHERE sid = ? ORDER BY id DESC LIMIT 1').bind(sid).first();
  return json({
    sid, vid: results[0].vid, meta: metaRow ? JSON.parse(metaRow.meta) : {}, events,
    lead: leadRow ? { email: leadRow.email, created: leadRow.created, answers: JSON.parse(leadRow.answers || '{}') } : null
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
    if (request.method === 'POST' && p === '/api/leads/answer') return await answer(request, env);

    if (request.method === 'GET') {
      if (!authorized(request, url, env)) return json({ ok: false, error: 'unauthorized' }, 401);
      if (p === '/api/leads') return json(await listLeads(env));
      if (p === '/api/leads.csv') {
        return new Response(csv(await listLeads(env)), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="follow-leads.csv"',
            'Cache-Control': 'no-store'
          }
        });
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
