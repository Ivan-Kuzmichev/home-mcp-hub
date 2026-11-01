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

## Скриншоты и демо

```bash
pnpm build
pnpm screenshots   # docs/screenshots/*.png для README и social preview
pnpm demo          # demo-out/ — статическое демо для GitHub Pages
```

Оба поднимают хаб на выдуманных данных (`scripts/demo/seed.mts`) во временной папке с `HUB_DEMO=1` (без фоновых задач),
обходят админку в Chromium и сохраняют страницы без скриптов. Демо публикует `.github/workflows/demo.yml` при каждом push в `main`;
в настройках репозитория Pages → Source должно быть «GitHub Actions».

## Коннекторы

Коннектор — папка `lib/connectors/<name>/`, экспортирующая объект `Connector` (`id`, `name`, `configSchema`, `test`, `tools`,
необязательный `instructions`), и одна строка в `lib/connectors/registry.ts`. Админка рисует форму по `configSchema`, поля `secret()` шифруются.

## Релизы

`pnpm release` (или `pnpm release minor` / `major`) поднимает версию в `package.json`, делает коммит, ставит тег `vX.Y.Z` и пушит.
CI собирает образ, публикует `:X.Y.Z` и `:X.Y` рядом с `:latest` и создаёт GitHub Release со списком коммитов с прошлого тега.

Зависимости обновляет Dependabot (`.github/dependabot.yml`) раз в неделю; better-auth и MCP SDK сгруппированы — их стоит обновлять вместе,
обе библиотеки быстро меняются.
