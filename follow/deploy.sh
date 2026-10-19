#!/usr/bin/env bash
# Публикует лендинг на Cloudflare Pages (проект follow, домен follow.com.ai).
# Нужны переменные окружения CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID.
# Использование: ./deploy.sh            — боевой сайт (ветка main)
#                ./deploy.sh preview    — тестовый адрес preview.follow-3xn.pages.dev
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${1:-main}"

# В публикацию идут только страницы и статика — без server/, data/ и исходников
rm -rf dist
mkdir -p dist
cp -r index.html replay.html privacy.html consent.html 404.html \
  robots.txt sitemap.xml _headers favicon.ico favicon.png favicon-180.png favicon-512.png \
  css js assets dist/

npx --yes wrangler pages deploy dist --project-name follow --branch "$BRANCH" --commit-dirty=true
