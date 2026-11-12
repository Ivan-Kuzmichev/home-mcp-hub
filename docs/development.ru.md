# Разработка

[English](development.md) · **Русский**

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

## Переводы

Код на английском, английский текст — он же ключ. Русский — в `ru.ts` рядом с кодом (папка коннектора, `components/ru.ts`, `lib/i18n/ru/*`),
подключённом в `lib/i18n/catalog.ts`. В серверном коде — `t`/`tr`/`trc`/`plural` из `lib/i18n`, в клиентских компонентах — те же имена из
`components/i18n-client`. `t` — тег шаблона (`` t`Found ${n} ${plural(n, ['document', 'documents'])}` ``), `tr` — для готовых строк,
`trc(context, text)` — когда у одного английского слова две русские формы. Подписи полей, описания инструментов и параметров остаются обычными
английскими строками: хаб переводит их там, где отдаёт. Не собирайте текст через `t` на уровне модуля: язык читается в момент вызова.

`tests/i18n-coverage.test.ts` проверяет каждый коннектор на обоих языках и что у английского текста нет двух разных русских переводов.
`pnpm demo` падает на кириллице в английских страницах и на тексте без русского во втором, русском проходе.

## Коннекторы

Коннектор — папка `lib/connectors/<name>/`, экспортирующая объект `Connector` (`id`, `name`, `configSchema`, `test`, `tools`,
необязательный `instructions`), и одна строка в `lib/connectors/registry.ts`. Админка рисует форму по `configSchema`, поля `secret()` шифруются.

## Релизы

`pnpm release` (или `pnpm release minor` / `major`) поднимает версию в `package.json`, делает коммит, ставит тег `vX.Y.Z` и пушит.
CI собирает образ, публикует `:X.Y.Z` и `:X.Y` рядом с `:latest` и создаёт GitHub Release со списком коммитов с прошлого тега.

Зависимости обновляет Dependabot (`.github/dependabot.yml`) раз в неделю; better-auth и MCP SDK сгруппированы — их стоит обновлять вместе,
обе библиотеки быстро меняются.
