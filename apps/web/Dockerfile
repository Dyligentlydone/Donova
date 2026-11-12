FROM node:22-bookworm-slim AS base
WORKDIR /app

ENV PORT=8080 \
    NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && pnpm install --frozen-lockfile=false --prod=false \
  && pnpm --filter @donova/web... build

ENV NODE_ENV=production
EXPOSE 8080

WORKDIR /app/apps/web
CMD ["node_modules/.bin/next", "start", "-p", "8080"]
