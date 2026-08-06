#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    npm install
  fi
fi

PORT=3920
if command -v pnpm >/dev/null 2>&1; then
  pnpm start &
else
  npm start &
fi
SERVER_PID=$!

sleep 1
open "http://127.0.0.1:${PORT}"

wait $SERVER_PID
