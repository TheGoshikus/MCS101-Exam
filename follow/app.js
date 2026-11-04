/* No framework, analytics, cookies or client-side email storage. */
(() => {
  'use strict';
  const config = window.FOLLOW_CONFIG || {};
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('#main-nav');
  function closeMenu(returnFocus = false) {
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && nav.classList.contains('is-open')) closeMenu(true); });
  document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });
  window.matchMedia('(min-width: 701px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

  const privacy = document.querySelector('#privacy-link');
  if (config.privacyUrl) {
    try {
      const url = new URL(config.privacyUrl, location.href);
      if (['http:', 'https:'].includes(url.protocol)) {
        privacy.href = url.href;
        privacy.hidden = false;
      }
    } catch { /* Leave an unconfigured link hidden. */ }
  }
  const form = document.querySelector('#access-form');
  const email = document.querySelector('#email');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = false;
  const status = document.querySelector('#form-status');
  const initialLabel = button.textContent;
  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }
  email.addEventListener('input', () => {
    email.removeAttribute('aria-invalid');
    if (status.classList.contains('error')) message('');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    email.value = email.value.trim();
    if (!email.validity.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      email.setAttribute('aria-invalid', 'true');
      message('Enter a valid email address so we can send your invitation.', true);
      email.focus();
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs || 15000);
    button.disabled = true;
    email.readOnly = true;
    button.textContent = 'Sending…';
    form.setAttribute('aria-busy', 'true');
    message('');
    let succeeded = false;
    try {
      const response = await fetch(config.endpoint || form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'omit', signal: controller.signal,
        body: JSON.stringify({email: email.value, website: form.elements.website.value, source: 'follow-early-access'})
      });
      if (response.status === 429) {
        message('Too many attempts. Please wait a minute and try again.', true);
        return;
      }
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error('Not accepted');
      succeeded = true;
      // Hide the submitted address once it is accepted.
      email.value = '';
      email.blur();
      const field = email.closest('.email-field');
      if (field) field.hidden = true;
      button.textContent = 'Request received';
      message('You’re on the list. We’ll email you with the next steps.');
    } catch {
      message('We couldn’t save your request. Please try again, or email info@follow.com.ai.', true);
    } finally {
      clearTimeout(timeout);
      form.removeAttribute('aria-busy');
      if (!succeeded) {
        button.disabled = false;
        email.readOnly = false;
        button.textContent = initialLabel;
      }
    }
  });
})();
