# Donova Cloud Render Worker (Google Cloud Run / Jobs)
# Deterministic image: pinned Node 22 + pinned chrome-headless-shell + pinned FFmpeg.
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-liberation fonts-noto-color-emoji ca-certificates curl unzip tar \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
    libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libxss1 libxtst6 libxkbcommon0 xvfb \
  && rm -rf /var/lib/apt/lists/*

# Pinned chrome-headless-shell for HeadlessExperimental.beginFrame
ARG CHROME_BUILD=141.0.7390.54
RUN npx -y @puppeteer/browsers install chrome-headless-shell@${CHROME_BUILD} --path /opt/donova/chrome

ENV DONOVA_CHROME_BUILD=${CHROME_BUILD} \
    DONOVA_HOME=/opt/donova \
    HOME=/opt/donova \
    PORT=8080

WORKDIR /app
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY packages ./packages
COPY apps/render-worker ./apps/render-worker
COPY registry ./registry
COPY skills ./skills
COPY LICENSE-hyperframes ./LICENSE-hyperframes

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && pnpm install --frozen-lockfile=false \
  && pnpm build

EXPOSE 8080

# Starts HTTP server on $PORT by default, or runs batch job if --job passed
CMD ["node", "apps/render-worker/dist/index.js"]
