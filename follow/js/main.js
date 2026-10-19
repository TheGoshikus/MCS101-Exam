(function () {
  'use strict';

  var cfg = window.FOLLOW_CONFIG || {};
  var track = window.followTrack || { goal: function () {} };
  var isReplay = document.documentElement.classList.contains('is-replay');

  // ---------- появление блоков при прокрутке ----------

  var revealed = document.querySelectorAll('.reveal');
  if (isReplay || !('IntersectionObserver' in window)) {
    revealed.forEach(function (el) { el.classList.add('is-visible'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    revealed.forEach(function (el) { io.observe(el); });
  }

  // ---------- глубина прокрутки как цели: 25 / 50 / 75 / 100% ----------

  var depthMarks = [25, 50, 75, 100];
  window.addEventListener('scroll', function () {
    if (!depthMarks.length) return;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var pct = max > 0 ? (window.scrollY / max) * 100 : 100;
    while (depthMarks.length && pct >= depthMarks[0] - 1) {
      track.goal('scroll_' + depthMarks.shift());
    }
  }, { passive: true });

  // ---------- плавающая кнопка: прячем, когда форма на экране ----------

  var sticky = document.querySelector('.sticky-cta');
  var leadSection = document.getElementById('lead');
  if (sticky && leadSection && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      sticky.classList.toggle('is-hidden', entries[0].isIntersecting);
    }, { threshold: 0.15 }).observe(leadSection);
  }

  // ---------- плашка cookies ----------

  var cookie = document.getElementById('cookie');
  var consent = null;
  try { consent = localStorage.getItem('follow_consent'); } catch (e) {}
  if (cookie && !consent && !isReplay) {
    cookie.hidden = false;
    document.getElementById('cookie-ok').addEventListener('click', function () {
      try { localStorage.setItem('follow_consent', '1'); } catch (e) {}
      cookie.hidden = true;
      document.dispatchEvent(new CustomEvent('follow:consent'));
    });
  }

  // ---------- форма заявки ----------

  var form = document.getElementById('lead-form');
  var nameInput = document.getElementById('lead-name');
  var phone = document.getElementById('lead-phone');
  var channel = document.getElementById('lead-channel');
  var comment = document.getElementById('lead-comment');
  var consentBox = document.getElementById('lead-consent');
  var errorBox = document.getElementById('lead-error');
  var success = document.getElementById('lead-success');
  var started = false;

  // Маска +7 (999) 999-99-99
  function formatPhone(value) {
    var d = value.replace(/\D/g, '');
    if (!d) return '';
    if (d[0] === '8') d = '7' + d.slice(1);
    if (d[0] !== '7') d = '7' + d;
    d = d.slice(0, 11);
    var out = '+7';
    if (d.length > 1) out += ' (' + d.slice(1, 4);
    if (d.length >= 4) out += ')';
    if (d.length > 4) out += ' ' + d.slice(4, 7);
    if (d.length > 7) out += '-' + d.slice(7, 9);
    if (d.length > 9) out += '-' + d.slice(9, 11);
    return out;
  }

  phone.addEventListener('input', function () {
    phone.value = formatPhone(phone.value);
  });

  form.addEventListener('focusin', function () {
    if (!started) {
      started = true;
      track.goal('form_start');
    }
  });

  function showError(text) {
    errorBox.textContent = text;
    errorBox.hidden = !text;
  }

  function validate() {
    var ok = true;
    form.querySelectorAll('.is-invalid').forEach(function (el) { el.classList.remove('is-invalid'); });

    if (nameInput.value.trim().length < 2) {
      nameInput.closest('.field').classList.add('is-invalid');
      ok = false;
    }
    if (phone.value.replace(/\D/g, '').length !== 11) {
      phone.closest('.field').classList.add('is-invalid');
      ok = false;
    }
    if (!consentBox.checked) {
      consentBox.closest('.check').classList.add('is-invalid');
      ok = false;
    }
    return ok;
  }

  function sendLead(data) {
    if (cfg.apiBase === null || cfg.apiBase === undefined) {
      // Без сервера: сохраняем локально, чтобы можно было проверить работу формы
      try {
        var leads = JSON.parse(localStorage.getItem('follow_leads') || '[]');
        leads.push(data);
        localStorage.setItem('follow_leads', JSON.stringify(leads));
      } catch (e) {}
      return Promise.resolve();
    }
    return fetch(cfg.apiBase + '/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(data)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    showError('');

    if (!validate()) {
      track.goal('form_invalid');
      showError('Проверьте имя, телефон и согласие на обработку данных.');
      return;
    }

    var button = form.querySelector('[type="submit"]');
    button.disabled = true;

    var params = new URLSearchParams(location.search);
    var data = {
      name: nameInput.value.trim(),
      phone: phone.value,
      channel: channel.value,
      comment: comment.value.trim(),
      // связь заявки с записью сессии — по ней в плеере видно путь этого клиента
      sid: track.sid,
      vid: track.vid,
      page: location.href.split('#')[0],
      referrer: document.referrer,
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      created: new Date().toISOString()
    };

    sendLead(data).then(function () {
      track.goal('lead_submit');
      form.reset();
      form.hidden = true;
      success.hidden = false;
    }).catch(function () {
      track.goal('lead_error');
      showError('Не получилось отправить заявку. Попробуйте ещё раз или позвоните нам.');
    }).then(function () {
      button.disabled = false;
    });
  });

  document.getElementById('lead-again').addEventListener('click', function () {
    success.hidden = true;
    form.hidden = false;
    started = false;
  });
})();
