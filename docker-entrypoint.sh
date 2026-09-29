#!/bin/sh
# Start the built-in Ollama (AI) in the background — restarts itself if it crashes —
# then start Exami. The default model (qwen3:4b) is downloaded automatically on first boot.
mkdir -p /data/ollama
if [ "${BUILTIN_AI:-true}" != "false" ] && command -v ollama >/dev/null 2>&1; then
  ( while true; do ollama serve >>/tmp/ollama.log 2>&1; echo "[ollama] restarting..."; sleep 3; done ) &
fi
exec node src/server.js
