#!/usr/bin/env bash
# setup.sh — 自动配置 Cloudflare Email Routing 规则（幂等）
# 用法: bash scripts/setup.sh
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
[ -f "$ENV_FILE" ] || { echo "Missing .env — copy .env.example and fill in"; exit 1; }
eval "$(grep -v '^#' "$ENV_FILE" | grep '=' | sed 's/^/export /')"

for v in CF_Key CF_Email WORKER_DOMAIN WORKER_ALIAS; do
  [ -n "${!v:-}" ] || { echo "✗ Missing $v in .env"; exit 1; }
done

API="https://api.cloudflare.com/client/v4"
H=( -H "X-Auth-Email: $CF_Email" -H "X-Auth-Key: $CF_Key" -H "Content-Type: application/json" )

echo "→ Finding zone: $WORKER_DOMAIN"
ZONE=$(curl -s "${H[@]}" "$API/zones?name=$WORKER_DOMAIN" | jq -r '.result[0].id')
[ -n "$ZONE" ] && [ "$ZONE" != "null" ] || { echo "✗ Zone not found"; exit 1; }
echo "  Zone: $ZONE"

echo "→ Fetching rules…"
RULES=$(curl -s "${H[@]}" "$API/zones/$ZONE/email/routing/rules")
W="${WORKER_ALIAS}@${WORKER_DOMAIN}"
N="noreply@${WORKER_DOMAIN}"

if echo "$RULES" | grep -qF "\"$W\""; then
  echo "  [OK] $W → mail-worker"
else
  echo "  [++] Creating $W → mail-worker"
  curl -s -o /dev/null -w "  HTTP %{http_code}\n" "${H[@]}" -X POST "$API/zones/$ZONE/email/routing/rules" \
    -d "{\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"$W\"}],\"actions\":[{\"type\":\"worker\",\"value\":[\"mail-worker\"]}],\"enabled\":true,\"name\":\"Mail Worker\"}"
fi

if echo "$RULES" | grep -qF "\"$N\""; then
  echo "  [OK] $N → drop"
else
  echo "  [++] Creating $N → drop"
  curl -s -o /dev/null -w "  HTTP %{http_code}\n" "${H[@]}" -X POST "$API/zones/$ZONE/email/routing/rules" \
    -d "{\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"$N\"}],\"actions\":[{\"type\":\"drop\"}],\"enabled\":true,\"name\":\"Drop noreply\"}"
fi

echo "✓ Setup complete"
