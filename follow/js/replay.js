/*
 * Плеер записей Follow: воспроизводит путь пользователя по событиям трекера (js/tracker.js).
 * Источники записей: сервер (/api/sessions), localStorage этого браузера, файл .json/.jsonl.
 */
(() => {
  'use strict';

  const cfg = window.FOLLOW_CONFIG || {};
  const hasServer = cfg.apiBase !== null && cfg.apiBase !== undefined;
  const $ = (id) => document.getElementById(id);

  const GOALS = {
    form_start: 'Начал заполнять форму',
    form_invalid: 'Ошибка при отправке формы',
    lead_submit: 'Заявка отправлена',
    lead_error: 'Заявка не ушла (ошибка сети)',
    scroll_25: 'Прокрутил 25% страницы',
    scroll_50: 'Прокрутил 50% страницы',
    scroll_75: 'Прокрутил 75% страницы',
    scroll_100: 'Долистал до конца'
  };

  const COLORS = { c: 'var(--click)', ts: 'var(--finger)', g: 'var(--goal)', i: 'var(--input)', f: 'var(--input)' };

  let token = '';
  try { token = localStorage.getItem('follow_admin_token') || ''; } catch (e) {}

  let sessions = [];
  let activeSid = null;

  // ---------- утилиты ----------

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtDate(ts) {
    return ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  }

  function device(meta) {
    const ua = meta.ua || '';
    if (/iPhone|iPad/.test(ua)) return 'iOS';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac OS/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    return meta.touch ? 'Мобильное' : 'Компьютер';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function api(p) {
    return cfg.apiBase + p + (token ? (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : '');
  }

  // Склеивает пачки трекера ({sid, seq, meta, events}) в одну запись
  function mergeChunks(chunks) {
    chunks.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const meta = (chunks.find((c) => c.meta) || {}).meta || {};
    const events = [];
    chunks.forEach((c) => { if (Array.isArray(c.events)) events.push(...c.events); });
    return { sid: chunks[0] && chunks[0].sid, vid: chunks[0] && chunks[0].vid, meta, events };
  }

  function summarize(s) {
    const ev = s.events || [];
    return {
      sid: s.sid,
      start: s.meta.start,
      duration: ev.length ? ev[ev.length - 1][0] : 0,
      clicks: ev.filter((e) => e[1] === 'c').length,
      touches: ev.filter((e) => e[1] === 'ts').length,
      touch: s.meta.touch,
      vw: s.meta.vw,
      vh: s.meta.vh,
      ua: s.meta.ua,
      utm: s.meta.utm,
      referrer: s.meta.referrer,
      goals: ev.filter((e) => e[1] === 'g').map((e) => e[2]),
      lead: s.lead || null
    };
  }

  // ---------- список записей ----------

  function localSessions() {
    const out = [];
    try {
      const index = JSON.parse(localStorage.getItem('follow_rec_index') || '[]');
      index.forEach((sid) => {
        const raw = localStorage.getItem('follow_rec_' + sid);
        if (!raw) return;
        const s = JSON.parse(raw);
        out.push(Object.assign(summarize(s), { source: 'local', data: s }));
      });
    } catch (e) {}
    return out;
  }

  async function loadList() {
    const notes = [];
    let server = [];
    $('auth').hidden = true;

    if (hasServer) {
      try {
        const res = await fetch(api('/api/sessions'));
        if (res.status === 401) {
          $('auth').hidden = false;
          notes.push('Сервер: нужен ADMIN_TOKEN');
        } else if (res.ok) {
          server = (await res.json()).map((s) => Object.assign(s, { source: 'server' }));
          notes.push('Сервер: ' + server.length);
        } else {
          notes.push('Сервер недоступен (' + res.status + ')');
        }
      } catch (e) {
        notes.push('Сервер недоступен');
      }
    }

    const local = localSessions();
    if (local.length || !hasServer) notes.push('Этот браузер: ' + local.length);

    const files = sessions.filter((s) => s.source === 'file');
    sessions = files.concat(server, local);
    $('source').textContent = notes.join(' · ');
    renderList();
  }

  function renderList() {
    const filter = $('filter').value;
    const visible = sessions.filter((s) => {
      if (filter === 'lead') return s.lead || (s.goals || []).includes('lead_submit');
      if (filter === 'touch') return s.touches > 0 || s.touch;
      if (filter === 'mouse') return !s.touches && !s.touch;
      return true;
    });

    const ul = $('sessions');
    if (!visible.length) {
      ul.innerHTML = '<li class="sessions__empty">Записей пока нет. Откройте лендинг, подвигайте мышью или полистайте пальцем — запись появится здесь.</li>';
      return;
    }

    ul.innerHTML = visible.map((s) => {
      const hasLead = s.lead || (s.goals || []).includes('lead_submit');
      const src = s.utm && s.utm.source ? s.utm.source : (s.referrer ? new URL(s.referrer, location.href).hostname : 'прямой заход');
      return '<li data-sid="' + escapeHtml(s.sid) + '" class="' + (s.sid === activeSid ? 'is-active' : '') + '">' +
        '<div class="sessions__row"><b>' + fmtDate(s.start) + '</b>' +
        (hasLead ? '<span class="tag tag--lead">заявка</span>' : '<span class="tag">' + fmtTime(s.duration) + '</span>') + '</div>' +
        '<div class="sessions__meta">' + escapeHtml(device(s)) + ', ' + s.vw + '×' + s.vh +
        ' · ' + (s.touches ? s.touches + ' касаний' : s.clicks + ' кликов') + ' · ' + escapeHtml(src) + '</div>' +
        (s.lead ? '<div class="sessions__meta">' + escapeHtml(s.lead.name) + ', ' + escapeHtml(s.lead.phone) + '</div>' : '') +
        '</li>';
    }).join('');
  }

  $('sessions').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-sid]');
    if (!li) return;
    const item = sessions.find((s) => s.sid === li.dataset.sid);
    if (!item) return;

    activeSid = item.sid;
    renderList();

    if (item.data) return open(item.data);
    try {
      const res = await fetch(api('/api/sessions/' + encodeURIComponent(item.sid)));
      if (!res.ok) throw new Error(res.status);
      open(await res.json());
    } catch (err) {
      alert('Не удалось загрузить запись: ' + err.message);
    }
  });

  $('filter').addEventListener('change', renderList);
  $('reload').addEventListener('click', loadList);
  $('token-save').addEventListener('click', () => {
    token = $('token').value.trim();
    try { localStorage.setItem('follow_admin_token', token); } catch (e) {}
    loadList();
  });

  $('import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    let session;
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith('[')) {
        session = mergeChunks(JSON.parse(trimmed));
      } else if (trimmed.includes('\n')) {
        session = mergeChunks(trimmed.split('\n').filter(Boolean).map((l) => JSON.parse(l)));
      } else {
        const obj = JSON.parse(trimmed);
        session = obj.events && obj.seq === undefined ? obj : mergeChunks([obj]);
      }
      session.sid = session.sid || file.name;
    } catch (err) {
      alert('Не получилось прочитать файл: ' + err.message);
      return;
    }
    const item = Object.assign(summarize(session), { source: 'file', data: session });
    sessions = [item].concat(sessions.filter((s) => s.sid !== item.sid));
    activeSid = item.sid;
    renderList();
    open(session);
    e.target.value = '';
  });

  // ---------- плеер ----------

  const frame = $('frame');
  const stage = $('stage');
  const box = $('stage-box');
  const canvas = $('trail');
  const ctx = canvas.getContext('2d');
  const cursor = $('cursor');
  const finger = $('finger');
  const toast = $('toast');

  const P = {
    s: null,
    events: [],
    log: [],
    duration: 0,
    time: 0,
    idx: 0,
    playing: false,
    last: 0,
    vw: 1280,
    vh: 800,
    trail: [],
    stroke: 0,
    logIdx: -1,
    toastTimer: null
  };

  function send(msg) {
    msg.follow = 'replay';
    if (frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
  }

  function setViewport(w, h) {
    P.vw = w || 1280;
    P.vh = h || 800;
    frame.width = P.vw;
    frame.height = P.vh;
    canvas.width = P.vw;
    canvas.height = P.vh;
    stage.style.width = P.vw + 'px';
    stage.style.height = P.vh + 'px';
    fit();
  }

  function fit() {
    const avail = $('viewer').clientWidth || 800;
    const maxH = Math.max(320, window.innerHeight * 0.68);
    const scale = Math.min(1, avail / P.vw, maxH / P.vh);
    stage.style.transform = 'scale(' + scale + ')';
    box.style.width = Math.round(P.vw * scale) + 'px';
    box.style.height = Math.round(P.vh * scale) + 'px';
  }

  window.addEventListener('resize', fit);

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('is-visible');
    clearTimeout(P.toastTimer);
    P.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1600);
  }

  function ripple(x, y) {
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    stage.appendChild(r);
    setTimeout(() => r.remove(), 950);
  }

  function place(el, x, y) {
    el.style.display = 'block';
    el.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function placeFinger(x, y) {
    finger.style.display = 'block';
    finger.style.left = x + 'px';
    finger.style.top = y + 'px';
  }

  // Применяет одно событие. live = true — при обычном воспроизведении (с анимацией),
  // false — при перемотке (только состояние).
  function apply(ev, live) {
    const t = ev[0];
    switch (ev[1]) {
      case 'm':
        place(cursor, ev[2], ev[3]);
        P.trail.push({ x: ev[2], y: ev[3], t, stroke: P.stroke, kind: 'm' });
        break;
      case 's':
        send({ cmd: 'scroll', x: ev[2], y: ev[3] });
        break;
      case 'c':
        if (cursor.style.display === 'block') place(cursor, ev[2], ev[3]);
        send({ cmd: 'click', sel: ev[4], live });
        if (live) {
          ripple(ev[2], ev[3]);
          showToast('Клик: ' + (ev[5] || ev[4]));
        }
        break;
      case 'ts':
        P.stroke++;
        placeFinger(ev[2], ev[3]);
        P.trail.push({ x: ev[2], y: ev[3], t, stroke: P.stroke, kind: 't' });
        break;
      case 'tm':
        placeFinger(ev[2], ev[3]);
        P.trail.push({ x: ev[2], y: ev[3], t, stroke: P.stroke, kind: 't' });
        break;
      case 'te':
        finger.style.display = 'none';
        P.stroke++;
        break;
      case 'r':
        if (ev[2] !== P.vw || ev[3] !== P.vh) setViewport(ev[2], ev[3]);
        break;
      case 'i':
        send({ cmd: 'input', sel: ev[2], len: ev[3] });
        break;
      case 'f':
        if (live) showToast('Поле: ' + ev[2]);
        break;
      case 'g':
        send({ cmd: 'goal', name: ev[2] });
        if (live) showToast('🎯 ' + (GOALS[ev[2]] || ev[2]));
        break;
      case 'v':
        if (live) showToast(ev[2] === 'hidden' ? 'Пользователь ушёл со вкладки' : 'Вернулся на вкладку');
        break;
    }
  }

  function drawTrail() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const from = P.time - 1500;
    P.trail = P.trail.filter((p) => p.t >= from - 500);
    let prev = null;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    P.trail.forEach((p) => {
      if (prev && prev.stroke === p.stroke && p.t - prev.t < 400 && p.t >= from) {
        const age = Math.min(1, Math.max(0, (P.time - p.t) / 1500));
        ctx.strokeStyle = p.kind === 't'
          ? 'rgba(0, 209, 178, ' + (0.8 * (1 - age)) + ')'
          : 'rgba(91, 123, 255, ' + (0.7 * (1 - age)) + ')';
        ctx.lineWidth = p.kind === 't' ? 8 : 3;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      prev = p;
    });
  }

  function updateUi() {
    $('time').textContent = fmtTime(P.time) + ' / ' + fmtTime(P.duration);
    const pct = P.duration ? (P.time / P.duration) * 100 : 0;
    $('timeline-fill').style.width = pct + '%';
    $('seek').value = Math.round(pct * 10);

    let li = -1;
    while (li + 1 < P.log.length && P.log[li + 1].t <= P.time) li++;
    if (li !== P.logIdx) {
      P.logIdx = li;
      const items = $('log').children;
      for (let k = 0; k < items.length; k++) {
        items[k].classList.toggle('is-past', k < li);
        items[k].classList.toggle('is-current', k === li);
      }
    }
  }

  // Перемотка: сбрасываем страницу и быстро применяем всё до момента t
  function seek(t) {
    P.time = Math.max(0, Math.min(t, P.duration));
    P.idx = 0;
    P.trail = [];
    P.stroke = 0;
    cursor.style.display = 'none';
    finger.style.display = 'none';
    send({ cmd: 'reset' });

    let lastScroll = null;
    let lastMouse = null;
    while (P.idx < P.events.length && P.events[P.idx][0] <= P.time) {
      const ev = P.events[P.idx++];
      if (ev[1] === 's') lastScroll = ev;
      else if (ev[1] === 'm') lastMouse = ev;
      else apply(ev, false);
      if (ev[0] >= P.time - 1500 && (ev[1] === 'm' || ev[1] === 'tm' || ev[1] === 'ts')) {
        P.trail.push({ x: ev[2], y: ev[3], t: ev[0], stroke: P.stroke, kind: ev[1] === 'm' ? 'm' : 't' });
      }
    }
    if (lastScroll) apply(lastScroll, false);
    else send({ cmd: 'scroll', x: 0, y: 0 });
    if (lastMouse) place(cursor, lastMouse[2], lastMouse[3]);

    drawTrail();
    updateUi();
  }

  function tick(ts) {
    if (!P.playing) return;
    const dt = Math.min(250, ts - P.last);
    P.last = ts;

    const next = P.events[P.idx];
    if ($('skip-idle').checked && next && next[0] - P.time > 1500) {
      P.time = next[0] - 400;
    } else {
      P.time += dt * Number($('speed').value);
    }

    while (P.idx < P.events.length && P.events[P.idx][0] <= P.time) apply(P.events[P.idx++], true);

    if (P.time >= P.duration) {
      P.time = P.duration;
      pause();
    }
    drawTrail();
    updateUi();
    if (P.playing) requestAnimationFrame(tick);
  }

  function play() {
    if (!P.s) return;
    if (P.time >= P.duration) seek(0);
    P.playing = true;
    P.last = performance.now();
    $('play').textContent = '❚❚';
    $('play').setAttribute('aria-label', 'Пауза');
    requestAnimationFrame(tick);
  }

  function pause() {
    P.playing = false;
    $('play').textContent = '▶';
    $('play').setAttribute('aria-label', 'Воспроизвести');
  }

  $('play').addEventListener('click', () => (P.playing ? pause() : play()));
  $('seek').addEventListener('input', (e) => seek((e.target.value / 1000) * P.duration));
  document.addEventListener('keydown', (e) => {
    if (!P.s || e.target.matches('input, select, textarea')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      P.playing ? pause() : play();
    } else if (e.code === 'ArrowRight') {
      seek(P.time + 5000);
    } else if (e.code === 'ArrowLeft') {
      seek(P.time - 5000);
    }
  });

  // ---------- журнал: путь пользователя в виде списка шагов ----------

  function buildLog(events) {
    const log = [];
    let scrollStart = null;
    let scrollLast = null;
    let touchStart = null;

    function flushScroll() {
      if (scrollStart && scrollLast && Math.abs(scrollLast[3] - scrollStart[3]) > 50) {
        const down = scrollLast[3] > scrollStart[3];
        log.push({ t: scrollStart[0], type: 's', text: 'Прокрутка ' + (down ? 'вниз ↓' : 'вверх ↑'), sub: 'до ' + scrollLast[3] + ' px' });
      }
      scrollStart = scrollLast = null;
    }

    events.forEach((ev, k) => {
      const [t, type] = ev;
      if (type === 's') {
        if (scrollLast && t - scrollLast[0] > 900) flushScroll();
        if (!scrollStart) scrollStart = k === 0 ? ev : (scrollLast || ev);
        scrollLast = ev;
        return;
      }
      if (type === 'ts') touchStart = ev;
      if (type === 'te' && touchStart) {
        const dx = ev[2] - touchStart[2];
        const dy = ev[3] - touchStart[3];
        if (Math.hypot(dx, dy) > 40) {
          const dir = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'вверх ↑' : 'вниз ↓') : (dx < 0 ? 'влево ←' : 'вправо →');
          log.push({ t: touchStart[0], type: 'ts', text: 'Свайп пальцем ' + dir, sub: Math.round(Math.hypot(dx, dy)) + ' px за ' + (t - touchStart[0]) + ' мс' });
        }
        touchStart = null;
      }
      if (type === 'c') log.push({ t, type, text: (ev[5] ? 'Нажал «' + ev[5] + '»' : 'Клик'), sub: ev[4] });
      if (type === 'f') log.push({ t, type, text: 'Перешёл в поле', sub: ev[2] });
      if (type === 'i') log.push({ t, type, text: /consent/.test(ev[2]) ? (ev[3] ? 'Отметил галочку' : 'Снял галочку') : 'Ввод в поле: ' + ev[3] + ' симв.', sub: ev[2] });
      if (type === 'g' && !/^scroll_/.test(ev[2])) log.push({ t, type, text: '🎯 ' + (GOALS[ev[2]] || ev[2]) });
      if (type === 'g' && /^scroll_/.test(ev[2])) log.push({ t, type: 'g', text: GOALS[ev[2]] || ev[2] });
      if (type === 'v') log.push({ t, type, text: ev[2] === 'hidden' ? 'Ушёл со вкладки' : 'Вернулся на вкладку' });
      if (type === 'r' && t > 0) log.push({ t, type, text: 'Размер окна ' + ev[2] + '×' + ev[3] });
    });
    flushScroll();
    return log.sort((a, b) => a.t - b.t);
  }

  function renderLog() {
    $('log').innerHTML = P.log.length
      ? P.log.map((l, k) => '<li data-k="' + k + '"><time>' + fmtTime(l.t) + '</time>' +
          '<i class="dot" style="background:' + (COLORS[l.type] || 'var(--muted)') + '"></i>' +
          '<span>' + escapeHtml(l.text) + (l.sub ? '<small>' + escapeHtml(l.sub) + '</small>' : '') + '</span></li>').join('')
      : '<li><time></time><i></i><span>Только движения курсора, без кликов и прокрутки</span></li>';

    $('timeline-marks').innerHTML = P.log
      .filter((l) => COLORS[l.type])
      .map((l) => '<i style="left:' + (l.t / P.duration * 100) + '%;background:' + COLORS[l.type] + '"></i>')
      .join('');
  }

  $('log').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]');
    if (li) seek(P.log[li.dataset.k].t - 1000);
  });

  function renderInfo(s) {
    const m = s.meta || {};
    const utm = m.utm || {};
    const lead = s.lead;
    const parts = [
      ['Дата', fmtDate(m.start)],
      ['Длительность', fmtTime(P.duration)],
      ['Устройство', device(m) + ', ' + (m.vw || '?') + '×' + (m.vh || '?')],
      ['Источник', utm.source ? [utm.source, utm.medium, utm.campaign].filter(Boolean).join(' / ') : (m.referrer || 'прямой заход')]
    ];
    if (lead) parts.push(['Заявка', lead.name + ', ' + lead.phone]);
    $('info').innerHTML = parts.map((p) => '<span>' + p[0] + ': <b>' + escapeHtml(p[1]) + '</b></span>').join('');
  }

  function open(s) {
    pause();
    P.s = s;
    P.events = (s.events || []).slice().sort((a, b) => a[0] - b[0]);
    P.duration = (P.events.length ? P.events[P.events.length - 1][0] : 0) + 500;
    P.log = buildLog(P.events);
    P.logIdx = -1;

    $('empty').hidden = true;
    $('viewer').hidden = false;

    setViewport((s.meta || {}).vw, (s.meta || {}).vh);
    renderInfo(s);
    renderLog();

    frame.onload = () => {
      seek(0);
      play();
    };
    frame.src = 'index.html?replay=1';
  }

  loadList();
})();
