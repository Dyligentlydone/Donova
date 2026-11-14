# Donova Studio cloud service — the real rebranded Studio (hyperframes preview
# via `donova studio`) backed by a GCS-synced project tree.
# Same heavy base as the render worker: pinned Node 22 + chrome-headless-shell +
# FFmpeg + fonts, because Studio's preview/render/check routes use them.
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-liberation fonts-noto-color-emoji ca-certificates curl unzip tar \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
    libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libxss1 libxtst6 libxkbcommon0 xvfb \
  && rm -rf /var/lib/apt/lists/*

ARG CHROME_BUILD=141.0.7390.54
# Install into the cache dir ensureChrome() scans: homedir()/.donova/chrome
# (HOME=/opt/donova). Any other path forces a ~100MB runtime download inside
# the agent's 60s run_command window — that's why `donova check` failed.
RUN npx -y @puppeteer/browsers install chrome-headless-shell@${CHROME_BUILD} --path /opt/donova/.donova/chrome

ENV DONOVA_CHROME_BUILD=${CHROME_BUILD} \
    DONOVA_HOME=/opt/donova \
    HOME=/opt/donova \
    PORT=8080

WORKDIR /app
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY packages ./packages
COPY apps/studio-service ./apps/studio-service
COPY registry ./registry
COPY skills ./skills
COPY LICENSE-hyperframes ./LICENSE-hyperframes

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && pnpm install --frozen-lockfile=false \
  && pnpm build

# Pre-bake the parakeet ASR model (~670MB int8) into the cache dir
# ensureParakeetModel() scans — same failure class as chrome above: the
# runtime download would happen inside the agent's run_command window and
# die, leaving `donova transcribe`/`captions` permanently broken in cloud.
# whisper.cpp is intentionally absent — auto engine resolves to parakeet.
# Also proves sherpa-onnx-node loads on this platform at build time.
RUN node packages/cli/bin/donova.mjs models install parakeet

EXPOSE 8080

CMD ["node", "apps/studio-service/dist/index.js"]
