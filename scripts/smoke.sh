#!/bin/sh
set -eu

SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:8390}"
: "${API_KEY:?Set API_KEY before running smoke checks}"

curl --fail --silent --show-error "$SMOKE_BASE_URL/health"
printf '\n'
curl --fail --silent --show-error "$SMOKE_BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY"
printf '\n'

# Explicit opt-in: these checks use the server's real upstream cookie.
if [ "${LIVE_TRANSLATION:-false}" = "true" ]; then
  curl --fail --silent --show-error "$SMOKE_BASE_URL/auth/status" \
    -H "Authorization: Bearer $API_KEY"
  printf '\n'
  for smoke_stream in false true; do
    curl --fail --silent --show-error --no-buffer "$SMOKE_BASE_URL/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"doubao-ai\",\"target_lang\":\"zh\",\"stream\":$smoke_stream,\"messages\":[{\"role\":\"user\",\"content\":\"Hello world\"}]}"
    printf '\n'
    curl --fail --silent --show-error --no-buffer "$SMOKE_BASE_URL/v1/responses" \
      -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
      -d "{\"model\":\"doubao-ai\",\"target_lang\":\"zh\",\"stream\":$smoke_stream,\"input\":\"Hello world\"}"
    printf '\n'
    curl --fail --silent --show-error --no-buffer "$SMOKE_BASE_URL/v1/messages" \
      -H "x-api-key: $API_KEY" -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \
      -d "{\"model\":\"doubao-ai\",\"target_lang\":\"zh\",\"stream\":$smoke_stream,\"max_tokens\":1024,\"messages\":[{\"role\":\"user\",\"content\":\"Hello world\"}]}"
    printf '\n'
  done
fi
