# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
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

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/hub.db
RUN addgroup -S -g 1001 hub && adduser -S -u 1001 -G hub hub \
 && mkdir -p /data && chown hub:hub /data
COPY --from=build --chown=hub:hub /app/.next/standalone ./
COPY --from=build --chown=hub:hub /app/.next/static ./.next/static
COPY --from=build --chown=hub:hub /app/lib/db/migrations ./lib/db/migrations
USER hub
VOLUME /data
EXPOSE 3000
# Migrations, first prefix and the admin user are handled in instrumentation.ts before the server takes requests.
CMD ["node", "server.js"]
