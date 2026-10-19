#!/usr/bin/env bash
# Публикует лендинг на Cloudflare Pages (проект follow, домен follow.com.ai).
# Нужны переменные окружения CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
cd "$(dirname "$0")"

# В публикацию идут только страницы, стили и скрипты — без server/ и data/
rm -rf dist
mkdir -p dist
cp -r index.html replay.html css js dist/
[ -d images ] && cp -r images dist/ || true

npx --yes wrangler pages deploy dist --project-name follow --branch main --commit-dirty=true
