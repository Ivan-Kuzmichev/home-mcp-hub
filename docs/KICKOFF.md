# Как вести реализацию с Claude Code

Один этап — одна сессия. Каждый промпт начинается с чтения спеки, заканчивается проверкой, которую можно потрогать руками.
Этапы и критерии готовности — `docs/SPEC.md`, раздел «План работ».

## Этап 1 — каркас

```
Прочитай CLAUDE.md и docs/SPEC.md целиком. Реализуй этап 1 из «Плана работ»:

1. Next.js 15 (App Router, TypeScript, standalone), Tailwind + shadcn/ui, Drizzle + better-sqlite3, файл БД по пути из DATABASE_PATH (по умолчанию /data/hub.db).
2. better-auth с email+password и плагином twoFactor. Регистрация закрыта; единственный админ создаётся при старте из ADMIN_EMAIL / ADMIN_PASSWORD, если таблица user пуста.
3. Секретный префикс пути сразу: таблица setting, middleware.ts, lib/prefix.ts с href(); первый префикс генерируется при старте и печатается в лог. Без префикса — 404, кроме /p/* и /_next/static/*.
4. Экраны /{secret}/login и /{secret}/admin (пустой дашборд с сайдбаром) по мокапам docs/design/Login.html и docs/design/Dashboard.html, токены дизайна из docs/design/README.md. Мобильная вёрстка — нижние вкладки, как в docs/design/MobileDashboard.html.
5. Dockerfile (multi-stage, node:22-alpine), docker-compose.yml для NAS, .env.example, .github/workflows/docker.yml с публикацией в GHCR.
6. pnpm lint, typecheck и минимальные тесты на middleware (префикс верный / неверный / /p/* / корень).

Не делай этапы 2+. В конце напиши, как проверить руками: команды и адреса.
```

## Этап 2 — MCP + OAuth с Claude

```
Прочитай docs/SPEC.md, разделы «Авторизация» и «Что учесть при реализации». Реализуй этап 2:

1. @better-auth/mcp как OAuth 2.1 сервер: DCR (переключатель allow_dcr в setting), PKCE S256, issuer https://<BASE_URL>/{secret}, redirect URI только https://claude.ai/api/mcp/auth_callback, access-токен 1 ч, refresh 30 дней с ротацией.
2. Метаданные: PRM по /{secret}/.well-known/oauth-protected-resource; AS metadata по трём адресам из спеки; корневые /.well-known/* — 404.
3. app/api/mcp/route.ts: mcp-handler 2.x + requireMcpAuth, один tool hub_status (readOnlyHint), instructions при инициализации. На запрос без токена — 401 с WWW-Authenticate и resource_metadata.
4. Экран /{secret}/consent по docs/design/Consent.html.
5. Экран «Доступ Claude» (docs/design/Access.html): префикс, готовый URL, переключатель DCR, список клиентов и токенов с отзывом.
6. Скрипт scripts/check-oauth.sh с curl-проверками из раздела «План работ».

Не трогай коннекторы. В конце — пошаговая инструкция, как подключить Claude и что должно быть видно в логах.
```

Перед этапом 3 — реальное подключение из Claude. Если Claude не находит метаданные для issuer с путём,
переходим на запасной вариант из спеки (OAuth-часть без префикса) — это отдельный короткий промпт.

## Этап 3 — коннекторы

```
Прочитай docs/SPEC.md, раздел «Коннекторы и возможности MCP» и «Что учесть при реализации». Реализуй этап 3:

1. Интерфейс Connector в lib/connectors/types.ts, registry.ts, форма в админке по configSchema (docs/design/Connectors.html, три режима входа для qBittorrent), кнопка «Проверить соединение», шифрование секретов через HUB_MASTER_KEY.
2. Коннекторы по очереди, каждый с тестами на адаптер: qBittorrent → Jackett → TorrServe. Нюансы API — в CLAUDE.md.
3. Кэш result_id (таблица search_result, TTL 1 ч), склейка дублей по infohash, таймаут Jackett 25 с с частичным результатом.
4. Аннотации readOnlyHint / destructiveHint, confirm: true для torrent_delete с файлами.

После каждого коннектора останавливайся и показывай пример вызова через MCP Inspector.
```

## Этапы 4–6

Прототипы (`docs/design/Prototypes.html`, `Pin*.html`), журнал и фоновые задачи (`Activity.html`, `instrumentation.ts`),
закалка по чеклисту «Безопасность». Формулировка та же: раздел спеки → список пунктов → «не делай следующий этап» → как проверить.

## Что проверять после каждого этапа

- `pnpm lint && pnpm typecheck && pnpm test` зелёные
- образ собрался в GitHub Actions и запустился на NAS из GHCR
- новый экран совпадает с мокапом по структуре, а не только по цветам
- в журнале и логах нет секретов и префикса
