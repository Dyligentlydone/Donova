# Editnce render worker (12 §cloud / 13 §docker)
# Deterministic image: pinned node + pinned chrome-headless-shell + pinned ffmpeg.
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-liberation fonts-noto-color-emoji ca-certificates curl unzip \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
    libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libxss1 libxtst6 libxkbcommon0 xvfb \
  && rm -rf /var/lib/apt/lists/*

# Pinned chrome-headless-shell for HeadlessExperimental.beginFrame
ARG CHROME_BUILD=141.0.7390.54
RUN npx -y @puppeteer/browsers install chrome-headless-shell@${CHROME_BUILD} --path /opt/editnce/chrome

ENV EDITNCE_CHROME_BUILD=${CHROME_BUILD} \
    EDITNCE_HOME=/opt/editnce \
    HOME=/opt/editnce

WORKDIR /app
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY packages ./packages
COPY registry ./registry
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && pnpm install --frozen-lockfile=false \
  && pnpm build

EXPOSE 8788
# Render server mode: POST /render {projectDir, composition, out, fps, quality, workers}
CMD ["node", "packages/cli/bin/editnce.mjs", "studio", "--port", "8788", "/work"]
