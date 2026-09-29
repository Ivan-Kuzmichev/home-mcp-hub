# Разработка

Стек: Next.js 15 (App Router, standalone), TypeScript, Tailwind + shadcn/ui, MCP SDK v2 (`mcp-handler`), better-auth с OAuth-провайдером,
SQLite + Drizzle, `node-cron`, QuickJS для скриптов. Правила для кода и неочевидные места — [`CLAUDE.md`](../CLAUDE.md).

## Локально

```bash
cp .env.example .env.local   # заполнить ключи: openssl rand -hex 32 / openssl rand -base64 32
pnpm install
pnpm dev                     # в логе: «Admin panel: http://localhost:3000/<префикс>/login»
```

По http MCP выключен (клиенты требуют https), админка и коннекторы работают.

## Проверки

```bash
pnpm lint && pnpm typecheck && pnpm test   # перед каждым коммитом
pnpm db:generate                           # миграция после правки lib/db/schema.ts
```

`pnpm build` не запускать рядом с работающим `pnpm dev` — он перезаписывает `.next` и ломает dev-сервер.

## Коннекторы

Коннектор — папка `lib/connectors/<name>/`, экспортирующая объект `Connector` (`id`, `name`, `configSchema`, `test`, `tools`,
необязательный `instructions`), и одна строка в `lib/connectors/registry.ts`. Админка рисует форму по `configSchema`, поля `secret()` шифруются.

## Релизы

`pnpm release` (или `pnpm release minor` / `major`) поднимает версию в `package.json`, делает коммит, ставит тег `vX.Y.Z` и пушит.
CI собирает образ и публикует `:X.Y.Z` и `:X.Y` рядом с `:latest`.

Зависимости обновляет Dependabot (`.github/dependabot.yml`) раз в неделю; better-auth и MCP SDK сгруппированы — их стоит обновлять вместе,
обе библиотеки быстро меняются.
