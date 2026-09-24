# syntax=docker/dockerfile:1

FROM node:25-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Toolchain in case better-sqlite3 has no prebuild for the target platform.
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:25-alpine AS runner
WORKDIR /app
ARG HUB_GIT_SHA=dev
ARG HUB_VERSION=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/hub.db \
    HUB_GIT_SHA=${HUB_GIT_SHA} \
    HUB_VERSION=${HUB_VERSION}
# su-exec: drop from root to the app user after fixing /data ownership (docker-entrypoint.sh).
RUN apk add --no-cache su-exec \
 && addgroup -S -g 1001 hub && adduser -S -u 1001 -G hub hub \
 && mkdir -p /data && chown hub:hub /data
COPY --from=build --chown=hub:hub /app/.next/standalone ./
COPY --from=build --chown=hub:hub /app/.next/static ./.next/static
COPY --from=build --chown=hub:hub /app/lib/db/migrations ./lib/db/migrations
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME /data
EXPOSE 3000
# Without the prefix the hub answers an empty 404 — that is exactly «alive».
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status===404?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
# Migrations, first prefix and the admin user are handled in instrumentation.ts before the server takes requests.
CMD ["node", "server.js"]
