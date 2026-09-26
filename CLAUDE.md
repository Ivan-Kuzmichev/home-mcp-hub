# Home MCP Hub

Личный MCP-хаб для домашних сервисов (Jackett, qBittorrent, TorrServe, хостинг HTML-прототипов) с админкой.
Один Docker-контейнер на NAS, наружу через Pangolin, подключается к Claude как custom connector.

## Главное правило

Спецификация лежит в `docs/SPEC.md` — это источник истины по архитектуре, авторизации, инструментам и плану.
Перед началом каждого этапа перечитай соответствующие разделы спеки. Если решение в коде расходится со спекой —
сначала спроси, потом меняй. Мокапы экранов — `docs/design/*.html` (см. `docs/design/README.md`).

## Стек (версии на сентябрь 2026)

- Next.js 15 (App Router, `output: 'standalone'`), TypeScript, Tailwind + shadcn/ui, zod
- MCP: `mcp-handler` 2.x + `@modelcontextprotocol/server` 2.x — **SDK v2**, не v1. `createMcpHandler` в `app/api/mcp/route.ts`,
  stateless Streamable HTTP, только POST, Redis не нужен
- Авторизация: `better-auth` 1.7 + `@better-auth/mcp` (OAuth 2.1 сервер с DCR и PKCE) + `twoFactor`; `requireMcpAuth` оборачивает MCP-route
- БД: SQLite (`better-sqlite3`) + Drizzle ORM, файл `/data/hub.db`
- Секреты коннекторов: AES-256-GCM, ключ из `HUB_MASTER_KEY`
- Фоновые задачи: `node-cron`, стартует из `instrumentation.ts`
- Логи: pino в stdout

Старые примеры в интернете написаны под MCP SDK v1 и better-auth 1.6 — имена API отличаются
(`withMcpAuth` → `requireMcpAuth`, эндпоинты `/mcp/*` → `/oauth2/*`, `StreamableHTTPServerTransport` → `createMcpHandler`).
Ориентируйся на актуальные README библиотек, ссылки в `docs/SPEC.md` → «Источники».

## Нюансы, на которых легко ошибиться

- **Секретный префикс пути.** Всё приложение живёт под `/{secret}/…` (`/{secret}/admin`, `/{secret}/login`, `/{secret}/api/mcp`,
  `/{secret}/api/auth/*`). Без префикса — только `/p/{slug}` (прототипы), `/_next/static/*` и well-known-документы,
  в пути которых уже есть `{secret}`. Всё остальное отвечает пустым 404. Реализация — `middleware.ts` + хелпер `href()` в `lib/prefix.ts`.
  Префикс хранится в таблице `setting` и меняется в админке; сравнение — за постоянное время.
- **OAuth issuer с путём.** `issuer` = `https://hub.example.com/{secret}`. Корневые `/.well-known/*` отдают 404 (иначе префикс утечёт).
  Метаданные AS отдаются по трём адресам (RFC 8414 path-insert, OIDC path-insert, OIDC path-append) — см. спеку, раздел «Авторизация».
  На 401 хаб шлёт `WWW-Authenticate: Bearer resource_metadata="https://hub.example.com/{secret}/.well-known/oauth-protected-resource"`.
- **qBittorrent 5.x:** эндпоинты `torrents/stop` и `torrents/start` (не `pause`/`resume` — те отдают 404), параметр добавления `stopped`
  (не `paused`), состояния `stoppedDL`/`stoppedUP`, имя cookie в 5.2 — `QBT_SID_<port>` (брать из `Set-Cookie`), заголовок `Referer` обязателен
  при логине. Три режима входа: без авторизации (whitelist подсети хаба в qBittorrent), API-ключ (5.2+), логин и пароль.
- **Jackett:** ссылки `Link` содержат API-ключ — никогда не возвращать их Claude. Результаты поиска кладутся в кэш под `result_id`,
  `torrent_add` / `torrserve_add` принимают `result_id`. Таймаут поиска 25 с, частичный результат вместо ошибки.
- **Transmission:** RPC `POST /transmission/rpc` с `{method, arguments}`; первый запрос получает `409` с `X-Transmission-Session-Id` —
  повторить с этим заголовком. Метки (`labels`) вместо категорий, `torrent-add` c `filename` (magnet/URL) или `metainfo` (base64).
  Имена tools с префиксом `transmission_` — имена в MCP глобальные и не должны совпадать с qBittorrent.
- **Paperless (ngx, совместимо с ng):** `Authorization: Token …`; фильтры дат — только `date__gt`/`date__lt` (в ng нет `__gte`);
  «неразмеченные» = inbox-тег ИЛИ без корреспондента ИЛИ без типа — API не умеет OR, запросы сливаются. Тег-исключение проверяется
  на каждом чтении и правке. Правки пишутся в `paperless_change` для `paperless_undo`. Ссылки на файлы — `/f/{token}` вне префикса.
- **TorrServe:** `POST /torrents` с JSON `{action, link, title, poster, save_to_db}`, `/echo` — версия, Basic-auth только если включён `--httpauth`.
- **Прототипы** отдаются с `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups` (без `allow-same-origin`)
  и `X-Robots-Tag: noindex`. Пин — argon2-хэш, cookie на 24 ч, 5 попыток за 10 мин.
- **Разрушающие tools** (`torrent_delete` с файлами, `prototype_delete`) требуют `confirm: true` и помечены `destructiveHint`.
  Read-only tools — `readOnlyHint`. Сервер отдаёт `instructions` при инициализации (текст — в спеке, «Что учесть при реализации»).
- **Claude требует:** PKCE S256, `code_challenge_methods_supported: ["S256"]`, `/token` принимает `application/x-www-form-urlencoded`,
  ответ discovery/register/token за 10 с, redirect URI `https://claude.ai/api/mcp/auth_callback`, никаких редиректов на другой хост.

## Структура

Дерево проекта — в `docs/SPEC.md`, раздел «Стек и структура проекта». Коннектор = папка в `lib/connectors/<name>/`, экспортирующая объект
`Connector` (`id`, `name`, `configSchema`, `test`, `tools`) и одна строка в `lib/connectors/registry.ts`. Админка рисует форму по `configSchema`,
поля с маркером `secret()` шифруются.

## Команды

- `pnpm dev` — локально (`.env.local` из `.env.example`)
- `pnpm db:generate` / `pnpm db:migrate` — Drizzle
- `pnpm lint && pnpm typecheck && pnpm test` — перед каждым коммитом
- Образ собирается в GitHub Actions (`.github/workflows/docker.yml`) и публикуется в GHCR; на NAS — `docker compose pull && up -d`

## Стиль

- TypeScript strict, без `any`; серверный код в route handlers и server actions, клиентские компоненты только там, где нужна интерактивность
- Тексты интерфейса на русском, идентификаторы и комментарии в коде на английском
- Ответы MCP-tools короткие и читаемые: Claude показывает их пользователю на телефоне
- Не логировать секреты, префикс пути и HTML прототипов
