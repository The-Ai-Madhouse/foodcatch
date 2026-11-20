#!/usr/bin/env bash
# Rebuild the web app and restart the LAN service (foodcatch-web, port 3000)
# so the latest local changes go live on the home network.
# Usage: pnpm deploy:lan   (or ./scripts/deploy-lan.sh)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing dependencies"
pnpm install --frozen-lockfile

echo "==> Building"
pnpm build

echo "==> Restarting foodcatch-web"
systemctl --user restart foodcatch-web

echo "==> Waiting for the site to answer"
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)
  if [ "$code" = "200" ]; then
    echo "OK: site is up (HTTP 200)"
    exit 0
  fi
  sleep 1
done

echo "FAILED: site did not return 200 (last: ${code:-none})" >&2
systemctl --user status foodcatch-web --no-pager -n 20 >&2 || true
exit 1
