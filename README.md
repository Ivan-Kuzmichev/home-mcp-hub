# Home MCP Hub

Личный MCP-хаб для домашних сервисов: Jackett, qBittorrent, TorrServe и хостинг HTML-прототипов.
Один Docker-контейнер на NAS, наружу — через Pangolin, в Claude подключается как custom connector.
Архитектура и решения — [`docs/SPEC.md`](docs/SPEC.md).

## Коннекторы

| Коннектор | Инструменты для Claude | Проверено |
| --- | --- | --- |
| Jackett | `search_torrents`, `list_indexers` | ✅ |
| qBittorrent | `torrents_status`, `torrent_add`, `torrent_stop`, `torrent_start`, `torrent_delete`, `torrent_files`, `transfer_info` | ✅ |
| Transmission | `transmission_status`, `transmission_add`, `transmission_stop`, `transmission_start`, `transmission_delete`, `transmission_files`, `transmission_info` | ⚠️ только автотесты, с живым Transmission не проверялся |
| Paperless (ngx) | `paperless_search`, `paperless_review`, `paperless_get`, `paperless_thumbnail`, `paperless_taxonomy`, `paperless_update`, `paperless_undo`, `paperless_link` | ⚠️ только автотесты, с живым Paperless не проверялся |
| TorrServe | `torrserve_add`, `torrserve_list`, `torrserve_links`, `torrserve_remove` | ✅ |
| Прототипы (встроенный) | `prototype_publish`, `prototype_append`, `prototype_update`, `prototype_list`, `prototype_delete` | ✅ |
| Хаб | `hub_status` | ✅ |

Коннекторы включаются и настраиваются в админке → «Коннекторы»; инструменты выключенного коннектора Claude не видит.
qBittorrent и Transmission можно держать включёнными одновременно — у инструментов разные имена.

Paperless: ассистент ищет и читает документы (OCR-текст, превью), размечает их пачками — название, дата, корреспондент,
тип, теги — по «правилам разметки» из настроек коннектора, с откатом пачки (`paperless_undo`). Документы с тегом-исключением
(по умолчанию `private`) ему не видны. Ссылки на файлы — `/f/{токен}` без секретного префикса: личные (24 ч, только с входом
в админку) и пересылаемые по прямой просьбе (один раз, 15 минут). Загрузки файлов через ассистента пока нет.

## Локально

```bash
cp .env.example .env.local   # заполнить ключи: openssl rand -hex 32 / openssl rand -base64 32
pnpm install
pnpm dev                     # в логе: «Admin panel: http://localhost:3000/<secret>/login»
pnpm lint && pnpm typecheck && pnpm test
```

## Развёртывание на NAS

Минимальный `docker-compose.yml` — только хаб, в сети хоста (Newt и Watchtower — в полном файле в корне репозитория):

```yaml
services:
  hub:
    image: ghcr.io/ivan-kuzmichev/home-mcp-hub:latest   # или закрепить версию: :0.1
    container_name: hub
    restart: unless-stopped
    network_mode: host
    env_file: .env
    environment:
      DATABASE_PATH: /data/hub.db
      PORT: 3245            # порт на NAS
      TRUST_PROXY: '1'
      TZ: Europe/Moscow
      # PUID: 1026          # необязательно: файлы в ./data будут принадлежать этому пользователю NAS (id -u)
      # PGID: 100
    volumes:
      - ./data:/data
```

Права на `./data` образ выставляет сам при старте, `chown` на NAS не нужен.

В сети хоста хаб слушает `<ip-nas>:3000` напрямую, а сервисы в коннекторах указываются через localhost:
`http://127.0.0.1:8080` (qBittorrent), `http://127.0.0.1:9117` (Jackett), `http://127.0.0.1:8090` (TorrServe).
Для qBittorrent в режиме «без авторизации» хватит галочки «Пропускать аутентификацию для клиентов на localhost».
В Pangolin target — `<ip-nas>:3000` (или `localhost:3000`, если Newt тоже в сети хоста).

`.env` рядом с ним:

```bash
BASE_URL=https://hub.example.com
HUB_MASTER_KEY=
BETTER_AUTH_SECRET=
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=
```

1. **Образ.** Каждый push в `main` собирает образ в GitHub Actions и публикует в GHCR
   (`ghcr.io/<you>/home-mcp-hub:latest` и `sha-<commit>`). Пакет по умолчанию приватный:
   на NAS один раз `docker login ghcr.io` с токеном `read:packages` — или сделать пакет публичным, секретов в образе нет.

2. **Секреты.** Рядом с `docker-compose.yml` положить `.env` (шаблон — `.env.example`) и закрыть его:

   ```bash
   echo "HUB_MASTER_KEY=$(openssl rand -hex 32)" >> .env
   echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
   chmod 600 .env
   ```

   `HUB_MASTER_KEY` шифрует пароли сервисов: потеряешь — придётся ввести их заново, остальное цело.
   `ADMIN_PASSWORD` (от 12 символов) нужен только для первого старта.

3. **Запуск.** Хаб должен быть в той же docker-сети, что Jackett, qBittorrent и TorrServe (`media` в compose).

   ```bash
   docker compose up -d
   docker compose logs hub | grep "Admin panel"   # секретный префикс печатается один раз
   ```

   Проверка по LAN до Pangolin: раскомментировать `ports` в compose, `BASE_URL=http://<ip-nas>:3000`, `TRUST_PROXY=0`.
   По http MCP выключен (Claude требует https), админка и коннекторы работают.

4. **Первый вход.** `/{secret}/login` → пароль → настройка 2FA (QR-код, резервные коды) — без неё админка не пустит.
   Затем «Коннекторы»: адреса сервисов внутри docker-сети (`http://qbittorrent:8080`, `http://transmission:9091`, `http://jackett:9117`, `http://torrserve:8090`),
   для TorrServe — ещё домашний адрес для плееров.

5. **Pangolin.** HTTP-ресурс `hub.<домен>` → `hub:3000`, авторизация Pangolin **выключена** (авторизует сам хаб).
   В `.env`: `BASE_URL=https://hub.<домен>`, `TRUST_PROXY=1`. Jackett, qBittorrent и TorrServe через Pangolin не публиковать.

6. **Проверка снаружи:**

   ```bash
   scripts/check-oauth.sh https://hub.<домен> <secret>
   ```

7. **Claude / ChatGPT.** Админка → «Доступ Claude»: скопировать MCP URL, включить регистрацию клиентов.
   - Claude → Settings → Connectors → Add custom connector → URL, OAuth-поля пустые.
   - ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode → Create → URL, аутентификация OAuth.

   Дальше вход, код, «Разрешить» — регистрация клиентов выключится сама. В новом чате попросить `hub_status`.
   Какие клиенты вообще могут регистрироваться — карточка «Разрешённые клиенты» на том же экране.

## Версии и обновление

- `main` → образ `:latest` и `:sha-<коммит>`.
- Релиз: `pnpm release` (или `minor` / `major`) поднимает версию в `package.json`, ставит тег `vX.Y.Z` и пушит —
  CI публикует `:X.Y.Z` и `:X.Y`. Версия и коммит образа видны в админке → «Настройки».
- На NAS можно жить на `:latest` (обновляет Watchtower) или закрепить `:X.Y` и получать только патчи этой версии.
- **Образ**: Watchtower из `docker-compose.yml` раз в сутки (05:00) тянет новый `latest` и перезапускает только контейнер хаба.
  Вручную: `docker compose pull && docker compose up -d`. Миграции БД применяются при старте.
- **Зависимости**: Dependabot (`.github/dependabot.yml`) раз в неделю открывает PR; better-auth и MCP SDK сгруппированы — их стоит
  обновлять сразу, обе библиотеки быстро меняются.

## Бэкап

Всё состояние — в томе `/data` (`./hub-data` на NAS): `hub.db` и `prototypes/`.
SQLite в режиме WAL — копировать через `.backup`, а не `cp`:

```bash
docker compose exec hub node -e "require('better-sqlite3')('/data/hub.db').backup('/data/hub-backup.db').then(()=>console.log('ok'))"
```

`.env` бэкапить отдельно и держать в секрете.

## Безопасность — чеклист из спеки

| Пункт | Как закрыт |
| --- | --- |
| Админ | Регистрация закрыта, обязательная 2FA (TOTP + резервные коды), 5 попыток входа за 15 мин с IP, блокировка после 5 неверных кодов |
| Cookie | По https — `__Host-hub.*`: Secure, HttpOnly, SameSite=Lax, Path=/; сессия 7 дней с продлением |
| Секретный префикс | Сравнение за постоянное время, пустой 404 на всё без префикса кроме `/p/*`, корневые `/.well-known/*` — 404, префикс не пишется в журнал, `Referrer-Policy: no-referrer` |
| OAuth | Только PKCE S256 (`plain` отклоняется), redirect только из белого списка клиентов (Claude, ChatGPT; Claude Code — по переключателю), `aud` = `/{secret}/api/mcp`, регистрация клиентов выключается после согласия, согласие — только после 2FA |
| MCP | Только POST, 60 запросов в минуту на клиента, таймаут сервисов 30 с, опциональный белый список CIDR, отзыв клиента действует сразу |
| Разрушающие tools | `torrent_delete` с файлами и `prototype_delete` требуют `confirm: true`, помечены `destructiveHint` |
| Секреты | AES-256-GCM с `HUB_MASTER_KEY`, в админке и ответах не показываются; ключи — в `.env` (600) |
| Jackett | Ссылки с API-ключом не попадают ни в ответы, ни в кэш, ни в журнал — только `result_id` |
| Прототипы | CSP `sandbox` без `allow-same-origin`, `noindex`, пин — argon2, 5 попыток за 10 мин на IP и 30 на прототип, случайный slug, лимит 1 МБ через MCP и 5 МБ вручную |
| Журнал | Вызовы и входы 30 дней, неудачные входы — на дашборде; HTML, пины и пароли не пишутся |
| Заголовки | HSTS (по https), `nosniff`, `no-referrer`; страницы админки — CSP с nonce, без inline-скриптов |
| Обновления | Dependabot + Watchtower |
