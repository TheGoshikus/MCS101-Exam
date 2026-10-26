#!/usr/bin/env bash
# Собирает архив для ручной загрузки в панели Cloudflare (Workers & Pages → follow → Create deployment).
# Перетаскивание в панели не компилирует папку functions/, поэтому API упаковывается в _worker.js
# (advanced mode). Заголовки из _headers к ответам воркера не применяются — они продублированы ниже.
# Результат: follow-dashboard.zip рядом со скриптом. Для выкладки через wrangler по-прежнему ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist follow-dashboard.zip
mkdir -p dist
cp -r index.html replay.html privacy.html consent.html 404.html privacy-en.html terms-en.html ru \
  robots.txt sitemap.xml _headers favicon.ico favicon.png favicon-180.png favicon-512.png \
  css js assets dist/

{
  sed 's/^export async function onRequest/async function onRequest/' 'functions/api/[[path]].js'
  cat <<'WORKER'

// ---- advanced mode: /api/* → API, остальное — статика с заголовками безопасности ----
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://mc.yandex.ru https://yastatic.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://mc.yandex.ru https://mc.yandex.com; font-src 'self'; connect-src 'self' https://mc.yandex.ru https://mc.yandex.com wss://mc.yandex.com; frame-src https://mc.yandex.ru https://mc.yandex.com; frame-ancestors 'self' https://metrika.yandex.ru https://metrika.yandex.by https://metrica.yandex.com https://metrica.yandex.com.tr https://*.webvisor.com; base-uri 'self'; form-action 'self'"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return onRequest({ request, env });
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!out.headers.has(k)) out.headers.set(k, v);
    }
    if (url.pathname.startsWith('/assets/')) out.headers.set('Cache-Control', 'public, max-age=2592000');
    if (url.pathname === '/replay.html' || url.pathname === '/replay') out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  }
};
WORKER
} > dist/_worker.js

(cd dist && zip -qr ../follow-dashboard.zip .)
echo "Готово: $(pwd)/follow-dashboard.zip"
