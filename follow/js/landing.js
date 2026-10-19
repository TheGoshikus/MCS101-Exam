/*
 * FOLLOW — интерактив лендинга: карточки, демо помощника, вкладки, тон, FAQ,
 * форма заявки (шаг 1 → анкета из 5 вопросов → «Вы в списке»), cookie-баннер и события аналитики.
 *
 * События (ТЗ, разд. 4; README хэндоффа, «Аналитика»):
 *   cta_click {block, placement}, card_select {card_id, state}, form_step1_submit,
 *   form_q1…form_q5 {status: answered|skipped}, form_complete, share_click {channel}
 *   + доп. (согласовать): chip_click, tab_switch, tone_select, faq_open, nav_click, scroll_depth.
 */
(function () {
  'use strict';

  var cfg = window.FOLLOW_CONFIG || {};
  var track = window.followTrack || { event: function () {}, goal: function () {} };
  var root = document.documentElement;
  var isReplay = root.classList.contains('is-replay');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var params = new URLSearchParams(location.search);

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function event(name, data) {
    if (track.event) track.event(name, data || {});
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {}
    return null;
  }

  // ---------- CTA: плавный скролл к форме с фокусом в email ----------

  function goToForm() {
    var target = $('#signup');
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    var email = $('#email');
    if (email && !$('#step1').hidden) {
      setTimeout(function () { email.focus({ preventScroll: true }); }, reduceMotion ? 0 : 600);
    }
  }

  $$('[data-cta]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      event('cta_click', { block: el.getAttribute('data-cta'), placement: el.getAttribute('data-placement') });
      goToForm();
    });
  });

  $$('[data-nav]').forEach(function (el) {
    el.addEventListener('click', function () {
      event('nav_click', { target: el.getAttribute('data-nav') });
    });
  });

  // ---------- 2. циферблат: третий сектор заполняется при скролле ----------

  var segs = $$('.dial__seg');
  var dialCount = $('.dial__count');
  var FULL = 71.5;

  function setDial(p) {
    // два сектора уже выполнены, третий заполняется по мере прокрутки первого экрана
    segs[2].setAttribute('stroke-dasharray', (FULL * p).toFixed(1) + ' 393.5');
    dialCount.textContent = (p >= 1 ? 3 : 2) + '/6';
  }

  if (segs.length === 3 && !reduceMotion && !isReplay) {
    var dialTick = false;
    var updateDial = function () {
      dialTick = false;
      setDial(Math.max(0, Math.min(1, window.scrollY / 220)));
    };
    setDial(0);
    window.addEventListener('scroll', function () {
      if (!dialTick) {
        dialTick = true;
        requestAnimationFrame(updateDial);
      }
    }, { passive: true });
    updateDial();
  }

  // ---------- 3. «Узнаёте себя?» ----------

  var selectedCards = [1];
  var cardsNote = $('#cards-note');

  function renderCardsNote() {
    cardsNote.textContent = selectedCards.length
      ? 'Отмечено: ' + selectedCards.length + ' — передадим в анкету'
      : 'Нажмите на карточку';
  }

  $$('.card').forEach(function (card) {
    card.addEventListener('click', function () {
      var id = Number(card.getAttribute('data-card'));
      var on = card.getAttribute('aria-pressed') !== 'true';
      card.setAttribute('aria-pressed', String(on));
      selectedCards = selectedCards.filter(function (x) { return x !== id; });
      if (on) selectedCards.push(id);
      selectedCards.sort();
      renderCardsNote();
      event('card_select', { card_id: id, state: on ? 'on' : 'off' });
    });
  });

  // ---------- 5. демо «Помощник объясняет себя» ----------

  var TAG_CLASS = { 'факт': 'fact', 'гипотеза': 'hyp', 'рекомендация': 'rec' };
  var ANSWERS = [
    ['Почему сегодня лёгкая тренировка?', 'Вы спали 6 ч, пульс покоя выше обычного на 5 уд/мин. Сегодня лучше 30 минут спокойно, чем час через силу.', [['факт', 'сон 6 ч, пульс покоя +5'], ['гипотеза', 'организм ещё восстанавливается'], ['рекомендация', 'лёгкая тренировка 30 мин']]],
    ['Почему я устаю после обеда?', 'Пять дней подряд завтрак почти без белка, а обед после 15:00. Попробуем неделю белок на завтрак и посмотрим.', [['факт', 'обед после 15:00 пять дней'], ['гипотеза', 'энергии не хватает с утра'], ['рекомендация', 'белок на завтрак, 7 дней']]],
    ['Что изменить в сне?', 'Вы ложитесь в разное время — разброс 1 ч 40 мин. Начнём с одного: лечь до 23:00 три вечера подряд.', [['факт', 'разброс отхода ко сну 1 ч 40 мин'], ['гипотеза', 'ровный режим даст больше сил'], ['рекомендация', 'лечь до 23:00, 3 вечера']]],
    ['С чего начать?', 'С того, что уже есть. Подключите часы — или просто отвечайте утром на один вопрос. План на сегодня будет готов.', [['факт', 'устройств пока нет — это нормально'], ['гипотеза', 'хватит одного вопроса утром'], ['рекомендация', 'начать с 1 действия в день']]]
  ];

  var bubbles = $$('.bubble');

  function showAnswer(i) {
    var a = ANSWERS[i];
    var apply = function () {
      $('#demo-q').textContent = a[0];
      $('#demo-a').textContent = a[1];
      var tags = $('#demo-tags');
      tags.innerHTML = '';
      a[2].forEach(function (t) {
        var row = document.createElement('div');
        row.className = 'tag';
        var k = document.createElement('span');
        k.className = 'tag__k tag__k--' + TAG_CLASS[t[0]];
        k.textContent = t[0];
        var v = document.createElement('span');
        v.textContent = t[1];
        row.appendChild(k);
        row.appendChild(v);
        tags.appendChild(row);
      });
      bubbles.forEach(function (b) { b.classList.remove('is-fading'); });
    };
    if (reduceMotion) return apply();
    bubbles.forEach(function (b) { b.classList.add('is-fading'); });
    setTimeout(apply, 160);
  }

  $$('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var i = Number(chip.getAttribute('data-chip'));
      if (chip.getAttribute('aria-pressed') === 'true') return;
      $$('.chip').forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      showAnswer(i);
      event('chip_click', { q: i });
    });
  });

  // ---------- 6. вкладки ----------

  var TAB_NAMES = ['protocols', 'people', 'together'];
  var tabs = $$('[role="tab"]');

  function selectTab(i, focus) {
    tabs.forEach(function (t, k) {
      var on = k === i;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#panel-' + k).hidden = !on;
    });
    if (focus) tabs[i].focus();
    lazyLoadIn($('#panel-' + i));
  }

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () {
      if (t.getAttribute('aria-selected') === 'true') return;
      selectTab(i);
      event('tab_switch', { tab: TAB_NAMES[i] });
    });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var n = (i + d + tabs.length) % tabs.length;
      selectTab(n, true);
      event('tab_switch', { tab: TAB_NAMES[n] });
    });
  });

  // ---------- 7. характер помощника ----------

  var tone = 0;
  var freq = 1;
  var FREQ_TEXT = ['сообщения каждое утро', 'сводка раз в неделю', 'сам не пишет — только когда спросите'];
  var TONE_TEXT = [
    '«Доброе утро. Сегодня спокойный день — 30 минут прогулки будет достаточно.»',
    '«Сегодня: прогулка 30 мин, белок на завтрак, сон до 23:00.»'
  ];

  function renderTone() {
    $$('[data-tone]').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-tone')) === tone)); });
    $$('[data-freq]').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-freq')) === freq)); });
    $('#tone-msg').textContent = TONE_TEXT[tone] + ' · ' + FREQ_TEXT[freq];
  }

  $$('[data-tone]').forEach(function (b) {
    b.addEventListener('click', function () {
      tone = Number(b.getAttribute('data-tone'));
      renderTone();
      event('tone_select', { tone: tone === 0 ? 'soft' : 'direct', freq: ['daily', 'weekly', 'never'][freq] });
    });
  });

  $$('[data-freq]').forEach(function (b) {
    b.addEventListener('click', function () {
      freq = Number(b.getAttribute('data-freq'));
      renderTone();
      event('tone_select', { tone: tone === 0 ? 'soft' : 'direct', freq: ['daily', 'weekly', 'never'][freq] });
    });
  });

  // ---------- 9. FAQ: одновременно открыт один вопрос ----------

  var accs = $$('.acc');

  accs.forEach(function (acc) {
    var btn = $('.acc__q', acc);
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') !== 'true';
      accs.forEach(function (other) {
        var b = $('.acc__q', other);
        var isThis = other === acc;
        var o = isThis && open;
        b.setAttribute('aria-expanded', String(o));
        $('i', b).textContent = o ? '−' : '+';
        $('.acc__a', other).hidden = !o;
      });
      if (open) event('faq_open', { q_id: Number(acc.getAttribute('data-q')) });
    });
  });

  // ---------- ленивые фоны и глубина просмотра по блокам ----------

  function lazyLoadIn(ctx) {
    $$('.lazybg', ctx).forEach(function (el) { el.classList.add('is-in'); });
    if (ctx && ctx.classList && ctx.classList.contains('lazybg')) ctx.classList.add('is-in');
  }

  if ('IntersectionObserver' in window && !isReplay) {
    var bgObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-in');
          bgObserver.unobserve(en.target);
        }
      });
    }, { rootMargin: '600px 0px' });
    $$('.lazybg').forEach(function (el) { bgObserver.observe(el); });

    var seenBlocks = {};
    var blockObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var b = en.target.getAttribute('data-block');
        if (en.isIntersecting && !seenBlocks[b]) {
          seenBlocks[b] = true;
          event('scroll_depth', { block: b });
          blockObserver.unobserve(en.target);
        }
      });
    }, { threshold: 0.25 });
    $$('[data-block]').forEach(function (el) { blockObserver.observe(el); });
  } else {
    lazyLoadIn(document);
  }

  // ---------- sticky-кнопка: после первого скролла и пока форма не на экране ----------

  var sticky = $('#sticky');
  var signupVisible = false;

  function updateSticky() {
    sticky.classList.toggle('is-shown', window.scrollY > 120 && !signupVisible);
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      signupVisible = entries[0].isIntersecting;
      updateSticky();
    }, { threshold: 0.1 }).observe($('#signup'));
  }
  window.addEventListener('scroll', updateSticky, { passive: true });
  updateSticky();

  // ---------- cookie-баннер с выбором ----------

  var cookie = $('#cookie');
  if (!store('follow_consent') && !isReplay) {
    cookie.hidden = false;
    $('#cookie-all').addEventListener('click', function () {
      store('follow_consent', 'all');
      cookie.hidden = true;
      document.dispatchEvent(new CustomEvent('follow:consent'));
    });
    $('#cookie-min').addEventListener('click', function () {
      store('follow_consent', 'necessary');
      cookie.hidden = true;
    });
  }

  // ---------- 10. форма: шаг 1 ----------

  var form = $('#step1');
  var email = $('#email');
  var pd = $('#c-pd');
  var age = $('#c-age');
  var news = $('#c-news');
  var submit = $('#step1-submit');
  var emailError = $('#email-error');
  var consentAt = {};
  var lead = null;

  // Частые одноразовые домены; полная проверка — на сервере
  var DISPOSABLE = ['mailinator.com', 'yopmail.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com', 'guerrillamail.com', 'sharklasers.com', 'trashmail.com', 'getnada.com', 'dropmail.me', 'mohmal.com', 'emailondeck.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com'];

  function emailProblem(v) {
    if (!v) return 'Введите email.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Похоже, в адресе опечатка. Проверьте, пожалуйста.';
    if (DISPOSABLE.indexOf(v.split('@')[1].toLowerCase()) !== -1) return 'Одноразовые адреса не подойдут — укажите почту, которую вы читаете.';
    return '';
  }

  function showEmailError(text) {
    emailError.textContent = text;
    emailError.hidden = !text;
    email.setAttribute('aria-invalid', text ? 'true' : 'false');
  }

  function updateSubmit() {
    submit.disabled = !(pd.checked && age.checked);
  }

  [pd, age, news].forEach(function (c) {
    c.addEventListener('change', function () {
      consentAt[c.name] = c.checked ? new Date().toISOString() : null;
      updateSubmit();
    });
  });

  email.addEventListener('input', function () {
    if (!emailError.hidden) showEmailError('');
  });

  function api(path, body) {
    if (isReplay || cfg.apiBase === null || cfg.apiBase === undefined) {
      // без сервера (открыто с диска): имитируем ответ, чтобы можно было пройти весь сценарий
      var demo = { ok: true, id: 1, token: 'local', ref: 'local', place: null };
      if (path === '/api/leads' && !isReplay) {
        try {
          var list = JSON.parse(store('follow_leads') || '[]');
          list.push(body);
          store('follow_leads', JSON.stringify(list));
        } catch (e) {}
      }
      return Promise.resolve(demo);
    }
    return fetch(cfg.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.ok) {
          var err = new Error(data.error || 'HTTP ' + res.status);
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = email.value.trim();
    var problem = emailProblem(value);
    if (problem) {
      showEmailError(problem);
      email.focus();
      return;
    }
    if (!pd.checked || !age.checked) return;

    submit.disabled = true;
    submit.textContent = 'Отправляем…';

    var now = new Date().toISOString();
    var body = {
      email: value,
      consents: {
        pd: { value: true, at: consentAt.pd || now },
        age: { value: true, at: consentAt.age || now },
        news: { value: news.checked, at: news.checked ? (consentAt.news || now) : null }
      },
      cards: selectedCards.slice(),
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_content: params.get('utm_content') || '',
      utm_term: params.get('utm_term') || '',
      ref: params.get('ref') || store('follow_ref') || '',
      ab_variant: root.getAttribute('data-ab') || 'A',
      ym_client_id: track.clientId ? track.clientId() : '',
      referrer: document.referrer,
      page: location.href.split('#')[0],
      sid: track.sid || '',
      vid: track.vid || '',
      website: form.website.value
    };

    api('/api/leads', body).then(function (res) {
      lead = { id: res.id, token: res.token, ref: res.ref, place: res.place };
      event('form_step1_submit', { cards: selectedCards.length });
      startQuiz();
    }).catch(function (err) {
      var msg = {
        disposable: 'Одноразовые адреса не подойдут — укажите почту, которую вы читаете.',
        invalid_email: 'Похоже, в адресе опечатка. Проверьте, пожалуйста.',
        rate_limited: 'Слишком много заявок с этого подключения. Попробуйте через час.'
      }[err.code] || 'Не получилось отправить. Проверьте интернет и попробуйте ещё раз.';
      showEmailError(msg);
    }).then(function () {
      submit.textContent = 'Хочу ранний доступ';
      updateSubmit();
    });
  });

  // запоминаем реф-код, если человек пришёл по ссылке друга
  if (params.get('ref')) store('follow_ref', params.get('ref'));

  // ---------- шаг 2: анкета ----------

  var QUESTIONS = [
    { q: 'Ваш смартфон', type: 'single', opts: ['iPhone', 'Android'] },
    { q: 'Что носите на руке или пальце', hint: 'Можно выбрать несколько', type: 'multi', opts: ['Apple Watch', 'Oura', 'Garmin', 'Xiaomi/Amazfit', 'Huawei', 'Samsung', 'Ничего'], exclusive: 'Ничего' },
    { q: 'Что хотите изменить первым', hint: 'До двух вариантов', type: 'multi', max: 2, opts: ['Сон', 'Энергия', 'Движение', 'Питание', 'Стресс'] },
    { q: 'Почему бросали трекеры раньше', type: 'single', opts: ['Надоело отмечать', 'Не понял цифры', 'Не было результата', 'Не пробовал'], other: 'Свой вариант' },
    { q: 'Возраст и город', type: 'groups', groups: [['Возраст', ['18–24', '25–34', '35–44', '45+']], ['Город', ['Москва', 'СПб', 'Другой']]] }
  ];

  var quiz = $('#quiz');
  var qIndex = 0;
  var answer = null;

  function startQuiz() {
    form.hidden = true;
    quiz.hidden = false;
    qIndex = 0;
    renderQuestion();
  }

  function optButton(label, pressed, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onClick);
    return b;
  }

  function renderQuestion() {
    var Q = QUESTIONS[qIndex];
    var box = $('#quiz-opts');
    $('#quiz-progress').textContent = 'Вопрос ' + (qIndex + 1) + ' из ' + QUESTIONS.length;
    $('#quiz-bar').style.width = ((qIndex + 1) / QUESTIONS.length * 100) + '%';
    $('#quiz-q').textContent = Q.q;
    $('#quiz-hint').textContent = Q.hint || '';
    $('#quiz-hint').hidden = !Q.hint;
    $('#quiz-next').textContent = qIndex === QUESTIONS.length - 1 ? 'Готово' : 'Дальше';
    box.innerHTML = '';
    answer = Q.type === 'groups' ? {} : (Q.type === 'multi' ? [] : null);

    function rerender() { renderOptions(); }

    function renderOptions() {
      box.innerHTML = '';
      if (Q.type === 'groups') {
        Q.groups.forEach(function (g) {
          var title = document.createElement('div');
          title.className = 'quiz__group';
          title.textContent = g[0];
          box.appendChild(title);
          g[1].forEach(function (o) {
            box.appendChild(optButton(o, answer[g[0]] === o, function () {
              answer[g[0]] = answer[g[0]] === o ? undefined : o;
              rerender();
            }));
          });
        });
        return;
      }
      Q.opts.concat(Q.other ? [Q.other] : []).forEach(function (o) {
        var pressed = Q.type === 'multi' ? answer.indexOf(o) !== -1 : (answer === o || (o === Q.other && answer !== null && Q.opts.indexOf(answer) === -1));
        box.appendChild(optButton(o, pressed, function () {
          if (Q.type === 'multi') {
            var i = answer.indexOf(o);
            if (i !== -1) answer.splice(i, 1);
            else if (Q.exclusive === o) answer = [o];
            else {
              answer = answer.filter(function (x) { return x !== Q.exclusive; });
              if (Q.max && answer.length >= Q.max) answer.shift();
              answer.push(o);
            }
          } else if (o === Q.other) {
            answer = (answer !== null && Q.opts.indexOf(answer) === -1) ? null : '';
          } else {
            answer = answer === o ? null : o;
          }
          rerender();
        }));
      });
      if (Q.other && answer !== null && Q.opts.indexOf(answer) === -1) {
        var input = document.createElement('input');
        input.className = 'input opt-input';
        input.maxLength = 200;
        input.placeholder = 'Напишите коротко';
        input.setAttribute('aria-label', Q.other);
        input.value = answer;
        input.addEventListener('input', function () { answer = input.value; });
        box.appendChild(input);
        input.focus();
      }
    }

    renderOptions();
    $('#quiz-q').focus({ preventScroll: true });
  }

  function hasAnswer() {
    if (answer === null) return false;
    if (Array.isArray(answer)) return answer.length > 0;
    if (typeof answer === 'object') return Object.keys(answer).some(function (k) { return answer[k]; });
    return String(answer).trim() !== '';
  }

  function nextQuestion(skipped) {
    var n = qIndex + 1;
    var value = skipped || !hasAnswer() ? null : answer;
    var status = value === null ? 'skipped' : 'answered';
    event('form_q' + n, { status: status });
    // ответ сохраняем сразу, даже если анкету бросят на следующем шаге
    api('/api/leads/answer', { id: lead.id, token: lead.token, q: n, answer: value }).catch(function () {});

    if (n < QUESTIONS.length) {
      qIndex = n;
      renderQuestion();
    } else {
      event('form_complete', {});
      showDone();
    }
  }

  $('#quiz-next').addEventListener('click', function () { nextQuestion(false); });
  $('#quiz-skip').addEventListener('click', function () { nextQuestion(true); });

  // ---------- шаг 3: «Вы в списке» ----------

  function refLink() {
    var base = (cfg.siteUrl || (location.origin + location.pathname)).replace(/#.*$/, '');
    return base + '?ref=' + encodeURIComponent(lead.ref);
  }

  function showDone() {
    quiz.hidden = true;
    $('#done').hidden = false;
    $('#done-place').textContent = lead.place ? '. Ваше место — №' + lead.place + '.' : '.';
    var link = refLink();
    var text = 'Я записался в первую тестовую группу FOLLOW — приложения, которое превращает данные о сне, движении и питании в несколько простых действий на сегодня. Присоединяйся:';
    $('#ref-link').value = link;
    var urls = {
      telegram: 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text),
      whatsapp: 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + link),
      vk: 'https://vk.com/share.php?url=' + encodeURIComponent(link) + '&title=' + encodeURIComponent('FOLLOW — ранний доступ')
    };
    $$('[data-share]').forEach(function (el) {
      var ch = el.getAttribute('data-share');
      if (urls[ch]) el.href = urls[ch];
    });
    $('#done-title').focus({ preventScroll: true });
  }

  $$('[data-share]').forEach(function (el) {
    el.addEventListener('click', function () {
      var ch = el.getAttribute('data-share');
      event('share_click', { channel: ch });
      if (ch === 'copy') {
        var input = $('#ref-link');
        var done = function () {
          el.textContent = 'Скопировано';
          setTimeout(function () { el.textContent = 'Скопировать ссылку'; }, 2000);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
        else { input.select(); document.execCommand('copy'); done(); }
      }
    });
  });

  // ---------- плеер записей: восстановление состояния страницы ----------

  if (isReplay) {
    window.followReplayHooks = {
      reset: function () {
        $$('.card').forEach(function (c) {
          if ((c.getAttribute('aria-pressed') === 'true') !== (c.getAttribute('data-card') === '1')) c.click();
        });
        var chip0 = $('[data-chip="0"]');
        if (chip0.getAttribute('aria-pressed') !== 'true') chip0.click();
        if (tabs[0].getAttribute('aria-selected') !== 'true') tabs[0].click();
        tone = 0;
        freq = 1;
        renderTone();
        var faq0 = $('#faq-q0');
        if (faq0.getAttribute('aria-expanded') !== 'true') faq0.click();
        form.reset();
        updateSubmit();
        form.hidden = false;
        quiz.hidden = true;
        $('#done').hidden = true;
        lead = null;
      },
      startQuiz: function () {
        lead = { id: 0, token: '', ref: 'demo', place: null };
        startQuiz();
      },
      showDone: function () {
        if (!lead) lead = { id: 0, token: '', ref: 'demo', place: null };
        showDone();
      }
    };
  }
})();
