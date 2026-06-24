#!/usr/bin/env bash
#
# One-shot setup to run the fast-news mirror poller 24/7 on an always-on Linux
# VPS (Ubuntu/Debian). The poller reads the PUBLIC t.me/s/ pages, so it needs
# ONLY the bot token + group id — NOT your Telegram user session. Telegram then
# pushes the alerts to your phone anywhere.
#
# Usage on a fresh VPS (as a sudo user):
#   curl -fsSL https://raw.githubusercontent.com/mayanktaluja/stock-platform/<branch>/scripts/deploy-vps.sh | bash -s <branch>
# or: clone the repo and run  bash scripts/deploy-vps.sh <branch>
# <branch> defaults to "main" (use "feat/telegram-channel-listener" until PR #914 merges).

set -euo pipefail
REPO_URL="https://github.com/mayanktaluja/stock-platform.git"
BRANCH="${1:-main}"
DIR="${STOCK_DIR:-$HOME/stock-platform}"

echo "==> fast-news mirror poller — VPS setup (branch=${BRANCH}, dir=${DIR})"

# 1. Node 22 + git (skip if present)
if ! command -v node >/dev/null 2>&1; then
  echo "==> installing Node 22 + git"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs git
fi

# 2. Clone or update
if [ -d "${DIR}/.git" ]; then
  git -C "${DIR}" fetch origin "${BRANCH}" && git -C "${DIR}" checkout "${BRANCH}" && git -C "${DIR}" pull origin "${BRANCH}"
else
  git clone -b "${BRANCH}" "${REPO_URL}" "${DIR}"
fi
cd "${DIR}"

# 3. Deps
npm install --no-audit --no-fund

# 4. .env — poller needs ONLY these four (no Telegram session).
if [ ! -f .env ]; then
  cat > .env <<'EOF'
# Paste TG_BOT_TOKEN from your Mac's .env (the secret). The rest are filled in.
TG_BOT_TOKEN=PASTE_BOT_TOKEN_HERE
TG_CHAT_ID=6150109282
TG_GROUP_ID=-1004298377347
ALERTS_ENABLED=1
EOF
  echo ""
  echo "==> Created ${DIR}/.env — edit it and paste TG_BOT_TOKEN, then re-run this script."
  exit 0
fi
if grep -q "PASTE_BOT_TOKEN_HERE" .env; then
  echo "==> .env still has the placeholder — paste your real TG_BOT_TOKEN, then re-run."
  exit 1
fi

# 5. Cron — poll every minute (the config + topic-map come from the repo).
mkdir -p "${DIR}/data/alerts"
CRON_LINE="* * * * * cd ${DIR} && set -a && . ./.env && set +a && ALERTS_LEDGER_DIR=${DIR}/data/alerts node scripts/refresh-mirror-news.mjs --window-min 3 >> ${DIR}/data/mirror.log 2>&1"
( crontab -l 2>/dev/null | grep -v "refresh-mirror-news" ; echo "${CRON_LINE}" ) | crontab -

echo ""
echo "==> DONE. Polling every minute, 24/7."
echo "    Logs:   tail -f ${DIR}/data/mirror.log"
echo "    Edit sources/mute: ${DIR}/data/alerts/{news-sources,mute-keywords,watchlist}.json then \`git commit\`/redeploy"
echo "    (Optional real-time push: a VPS holds the MTProto connection — set TG_API_ID/HASH/SESSION in .env"
echo "     and run scripts/telegram-listener.mjs under systemd/pm2 instead of the poll cron.)"
