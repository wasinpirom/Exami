# ============================================================
# Exami — all-in-one image: web app + Ollama (open-source AI)
# No environment variables needed. Just mount a volume at /data.
# ============================================================
FROM ollama/ollama:latest AS ollama
# keep the CPU runtime only (drops multi-GB GPU libraries)
RUN rm -rf /usr/lib/ollama/cuda* /usr/lib/ollama/rocm* /usr/lib/ollama/vulkan* /usr/lib/ollama/jetpack* || true

FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Bangkok PORT=3000 DATA_DIR=/data \
    OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=/data/ollama OLLAMA_KEEP_ALIVE=30m OLLAMA_NUM_PARALLEL=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ollama /usr/bin/ollama /usr/bin/ollama
COPY --from=ollama /usr/lib/ollama /usr/lib/ollama
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt binaries (x64 / arm64) → no compiler needed
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
RUN chmod +x docker-entrypoint.sh && mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./docker-entrypoint.sh"]
