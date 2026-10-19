/*
 * Follow tracker — запись пути пользователя на странице.
 *
 * Пишет движение мыши, касания и свайпы пальцем, прокрутку, клики по всем кнопкам и ссылкам,
 * фокус и ввод в поля формы (только длину текста, без самих значений), изменение размера окна,
 * сворачивание вкладки и цели. Данные пачками уходят на сервер (/api/track), откуда их можно
 * воспроизвести на странице replay.html.
 *
 * Формат события — массив: [t, тип, ...данные], где t — миллисекунды от начала записи.
 *   m  x y              — курсор мыши (координаты окна)
 *   s  x y              — прокрутка страницы
 *   c  x y sel label    — клик / тап по элементу
 *   ts x y / tm x y / te x y — касание: начало / движение / конец
 *   f  sel / b sel      — фокус / уход из поля
 *   i  sel len          — ввод в поле (длина значения)
 *   r  w h              — изменение размера окна
 *   v  state            — вкладка visible / hidden
 *   g  name [params]    — цель или событие аналитики (например, form_step1_submit)
 *
 * По ТЗ запись и Яндекс Метрика включаются только после согласия в cookie-баннере
 * (localStorage follow_consent = 'all').
 */
(function () {
  'use strict';

  var cfg = window.FOLLOW_CONFIG || {};
  var params = new URLSearchParams(location.search);

  // Внутри плеера страница открывается с ?replay=1 — там ничего не записываем,
  // а только выполняем команды плеера (через postMessage, чтобы работало и с file://).
  if (params.has('replay')) {
    document.documentElement.classList.add('is-replay');
    window.followTrack = { sid: null, goal: function () {}, event: function () {}, start: function () {}, clientId: function () { return ''; } };
    window.addEventListener('message', replayCommand);
    return;
  }

  // Элементы, клик по которым в плеере повторяется по-настоящему: так восстанавливается
  // состояние карточек, вкладок, FAQ и анкеты. Галочки сюда не входят — их состояние приходит
  // событием ввода, а повторный клик по label переключил бы их дважды.
  var REPLAY_CLICKABLE = '.card, .chip, [role="tab"], [data-tone], [data-freq], .acc__q, .opt, #quiz-next, #quiz-skip';

  function replayCommand(e) {
    var d = e.data;
    if (e.source !== window.parent || !d || d.follow !== 'replay') return;

    var hooks = window.followReplayHooks || {};
    var el = null;
    if (d.sel) {
      try { el = document.querySelector(d.sel); } catch (err) {}
    }

    if (d.cmd === 'scroll') {
      window.scrollTo(d.x, d.y);
    } else if (d.cmd === 'reset') {
      if (hooks.reset) hooks.reset();
    } else if (d.cmd === 'click' && el) {
      var target = el.closest(REPLAY_CLICKABLE);
      if (target) target.click();
      if (d.live) {
        var prev = el.style.outline;
        el.style.outline = '3px solid #ff5470';
        el.style.outlineOffset = '2px';
        setTimeout(function () { el.style.outline = prev; }, 900);
      }
    } else if (d.cmd === 'input' && el) {
      // самих значений нет — показываем точками, сколько символов было введено
      if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = d.len > 0;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.tagName !== 'SELECT') {
        el.value = new Array(d.len + 1).join('•');
      }
    } else if (d.cmd === 'goal') {
      if (d.name === 'form_step1_submit' && hooks.startQuiz) hooks.startQuiz();
      if (d.name === 'form_complete' && hooks.showDone) hooks.showDone();
    }
  }

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function storageGet(store, key) {
    try { return window[store].getItem(key); } catch (e) { return null; }
  }

  function storageSet(store, key, value) {
    try { window[store].setItem(key, value); return true; } catch (e) { return false; }
  }

  var vid = storageGet('localStorage', 'follow_vid');
  if (!vid) {
    vid = uid();
    storageSet('localStorage', 'follow_vid', vid);
  }

  var sid = uid();
  var started = false;
  var stopped = false;
  var t0 = 0;
  var seq = 0;
  var total = 0;
  var buffer = [];
  var localEvents = [];
  var metaSent = false;
  var meta = null;

  function now() {
    return Math.round(performance.now() - t0);
  }

  function push(ev) {
    if (!started || stopped) return;
    if (ev[0] > cfg.maxDurationMs || total >= cfg.maxEvents) {
      stopped = true;
      flush(true);
      return;
    }
    total++;
    buffer.push(ev);
    if (cfg.localRecordings) localEvents.push(ev);
  }

  // ---------- описание элементов ----------

  var CLICKABLE = 'a, button, input, select, textarea, label, summary, [role="button"], [data-track]';

  // Атрибуты, которые однозначно определяют элемент на странице — по ним плеер найдёт его снова
  var KEY_ATTRS = ['data-track', 'data-card', 'data-chip', 'data-tone', 'data-freq', 'data-share', 'data-cta', 'data-nav'];

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    for (var a = 0; a < KEY_ATTRS.length; a++) {
      var v = el.getAttribute(KEY_ATTRS[a]);
      if (v !== null) return '[' + KEY_ATTRS[a] + '="' + v + '"]';
    }
    if (el.id) return '#' + el.id;

    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 4) {
      var part = el.tagName.toLowerCase();
      if (el.id) {
        parts.unshift('#' + el.id);
        break;
      }
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }

  function labelOf(el) {
    if (!el) return '';
    var text = el.getAttribute('aria-label') ||
      (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? (el.name || el.type) : el.textContent) ||
      el.getAttribute('data-track') || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  // ---------- отправка ----------

  function payload() {
    var chunk = { sid: sid, vid: vid, seq: seq++, events: buffer };
    if (!metaSent) {
      chunk.meta = meta;
      metaSent = true;
    }
    buffer = [];
    return JSON.stringify(chunk);
  }

  function saveLocal() {
    if (!cfg.localRecordings) return;
    var key = 'follow_rec_' + sid;
    var ok = storageSet('localStorage', key, JSON.stringify({ sid: sid, vid: vid, meta: meta, events: localEvents }));
    if (!ok) return;

    var index = [];
    try { index = JSON.parse(storageGet('localStorage', 'follow_rec_index') || '[]'); } catch (e) {}
    if (index.indexOf(sid) === -1) index.push(sid);
    while (index.length > 10) {
      try { localStorage.removeItem('follow_rec_' + index.shift()); } catch (e) {}
    }
    storageSet('localStorage', 'follow_rec_index', JSON.stringify(index));
  }

  function flush(final) {
    if (!started) return;
    saveLocal();
    if (cfg.apiBase === null || cfg.apiBase === undefined) {
      buffer = [];
      return;
    }
    if (!buffer.length && metaSent) return;

    var url = cfg.apiBase + '/api/track';
    var body = payload();
    // text/plain не требует CORS preflight, поэтому сервер может жить на другом домене
    if (final && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    } else {
      fetch(url, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
        .catch(function () {});
    }
  }

  // ---------- обработчики ----------

  function throttle(fn, ms) {
    var last = 0;
    var timer = null;
    var lastArgs = null;
    return function () {
      lastArgs = arguments;
      var t = performance.now();
      var wait = ms - (t - last);
      if (wait <= 0) {
        last = t;
        fn.apply(null, lastArgs);
      } else if (!timer) {
        // последнее положение всё равно записываем, чтобы курсор не «застревал»
        timer = setTimeout(function () {
          timer = null;
          last = performance.now();
          fn.apply(null, lastArgs);
        }, wait);
      }
    };
  }

  // Мобильные браузеры после тапа присылают «мышиные» события — их не пишем,
  // иначе в записи с телефона появится курсор.
  var lastTouch = -Infinity;

  var onMouseMove = throttle(function (e) {
    if (performance.now() - lastTouch < 1000) return;
    push([now(), 'm', e.clientX, e.clientY]);
  }, 40);

  var onScroll = throttle(function () {
    push([now(), 's', Math.round(window.scrollX), Math.round(window.scrollY)]);
  }, 80);

  var onTouchMove = throttle(function (e) {
    var p = e.touches[0];
    if (p) push([now(), 'tm', Math.round(p.clientX), Math.round(p.clientY)]);
  }, 40);

  var onResize = throttle(function () {
    push([now(), 'r', window.innerWidth, window.innerHeight]);
  }, 200);

  var inputTimers = {};

  function bind() {
    var opts = { passive: true, capture: true };

    document.addEventListener('mousemove', onMouseMove, opts);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    document.addEventListener('touchstart', function (e) {
      lastTouch = performance.now();
      var p = e.touches[0];
      if (p) push([now(), 'ts', Math.round(p.clientX), Math.round(p.clientY)]);
    }, opts);
    document.addEventListener('touchmove', function (e) {
      lastTouch = performance.now();
      onTouchMove(e);
    }, opts);
    document.addEventListener('touchend', function (e) {
      lastTouch = performance.now();
      var p = e.changedTouches[0];
      if (p) push([now(), 'te', Math.round(p.clientX), Math.round(p.clientY)]);
    }, opts);

    // Клики по всем кнопкам, ссылкам и полям. Ловим на фазе capture, чтобы не терять клики,
    // которые останавливают всплытие.
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest(CLICKABLE) : null;
      var target = el || e.target;
      var sel = selectorOf(target);
      push([now(), 'c', Math.round(e.clientX), Math.round(e.clientY), sel, el ? labelOf(el) : '']);

    }, true);

    document.addEventListener('focusin', function (e) {
      if (e.target.matches && e.target.matches('input, select, textarea')) push([now(), 'f', selectorOf(e.target)]);
    }, true);
    document.addEventListener('focusout', function (e) {
      if (e.target.matches && e.target.matches('input, select, textarea')) push([now(), 'b', selectorOf(e.target)]);
    }, true);

    // Значения полей не записываем — только сколько символов введено
    document.addEventListener('input', function (e) {
      var el = e.target;
      // галочки и переключатели пишутся через change
      if (!el.matches || !el.matches('input, textarea') || el.type === 'checkbox' || el.type === 'radio') return;
      var sel = selectorOf(el);
      clearTimeout(inputTimers[sel]);
      inputTimers[sel] = setTimeout(function () {
        push([now(), 'i', sel, el.value.length]);
      }, 400);
    }, true);
    document.addEventListener('change', function (e) {
      var el = e.target;
      if (el.type === 'checkbox' || el.type === 'radio') push([now(), 'i', selectorOf(el), el.checked ? 1 : 0]);
    }, true);

    document.addEventListener('visibilitychange', function () {
      push([now(), 'v', document.visibilityState]);
      if (document.visibilityState === 'hidden') flush(true);
    });
    window.addEventListener('pagehide', function () { flush(true); });

    setInterval(function () { flush(false); }, cfg.flushIntervalMs || 3000);
  }

  function start() {
    if (started) return;
    started = true;
    t0 = performance.now();

    meta = {
      start: Date.now(),
      url: location.href.split('#')[0],
      path: location.pathname,
      referrer: document.referrer,
      utm: {
        source: params.get('utm_source') || '',
        medium: params.get('utm_medium') || '',
        campaign: params.get('utm_campaign') || '',
        content: params.get('utm_content') || '',
        term: params.get('utm_term') || ''
      },
      vw: window.innerWidth,
      vh: window.innerHeight,
      screen: screen.width + 'x' + screen.height,
      dpr: window.devicePixelRatio || 1,
      touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
      ua: navigator.userAgent,
      lang: navigator.language
    };

    push([0, 'r', meta.vw, meta.vh]);
    push([0, 's', Math.round(window.scrollX), Math.round(window.scrollY)]);
    bind();
    flush(false);
  }

  // ---------- Яндекс Метрика (Вебвизор, карта кликов, цели) ----------

  function loadMetrika() {
    if (!cfg.metrikaId) return;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');

    window.ym(cfg.metrikaId, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: true,
      params: { follow_sid: sid }
    });

    window.followMetrika = function (goal, goalParams) {
      window.ym(cfg.metrikaId, 'reachGoal', goal, goalParams);
    };
  }

  var metrikaClientId = '';

  function goal(name, goalParams) {
    var ev = [now(), 'g', name];
    if (goalParams && Object.keys(goalParams).length) ev.push(goalParams);
    push(ev);
    if (window.followMetrika) window.followMetrika(name, goalParams);
    flush(false);
  }

  window.followTrack = {
    sid: sid,
    vid: vid,
    start: start,
    goal: goal,
    event: goal,
    flush: flush,
    clientId: function () { return metrikaClientId; }
  };

  function consentGiven() {
    return storageGet('localStorage', 'follow_consent') === 'all';
  }

  function enable() {
    loadMetrika();
    if (cfg.metrikaId && window.ym) {
      window.ym(cfg.metrikaId, 'getClientID', function (id) { metrikaClientId = id || ''; });
    }
    start();
  }

  if (cfg.requireConsent && !consentGiven()) {
    document.addEventListener('follow:consent', enable, { once: true });
  } else {
    enable();
  }
})();
