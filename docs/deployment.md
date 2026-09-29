# Развёртывание

## Образ и версии

Каждый push в `main` собирает образ в GitHub Actions и публикует в GHCR: `ghcr.io/ivan-kuzmichev/home-mcp-hub:latest` и `:sha-<коммит>`.
Релиз (`pnpm release`, см. [development.md](development.md)) ставит тег `vX.Y.Z`, и CI публикует ещё `:X.Y.Z` и `:X.Y`.

- Можно жить на `:latest` с автообновлением или закрепить `:X.Y` и получать только патчи этой версии.
- Версия и коммит образа видны в админке → «Настройки».
- Если пакет в GHCR приватный — один раз `docker login ghcr.io` с токеном `read:packages`. Секретов в образе нет, пакет можно сделать публичным.

## Переменные окружения

| Переменная | Что это |
| --- | --- |
| `BASE_URL` | Публичный адрес хаба без префикса. MCP работает только по https; по http доступны админка и коннекторы |
| `HUB_MASTER_KEY` | `openssl rand -hex 32`. Шифрует пароли и ключи сервисов (AES-256-GCM). Потеряешь — придётся ввести их заново, остальное цело |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. Подпись сессий |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Админ, создаётся при первом старте, пароль от 12 символов |
| `DATABASE_PATH` | SQLite, в контейнере `/data/hub.db` |
| `TRUST_PROXY` | `1` — брать IP клиента из `X-Forwarded-For` (хаб за прокси), `0` — напрямую |
| `PORT` | Порт внутри контейнера, по умолчанию 3000 |
| `PUID`, `PGID` | Необязательно: владелец файлов в `/data` на хосте (`id -u`, `id -g`) |
| `TZ`, `LOG_LEVEL` | Часовой пояс для cron-скриптов, уровень логов (`info`) |

Права на `/data` образ выставляет сам при старте, `chown` на хосте не нужен.

## Реверс-прокси

Хаб рассчитан на работу за прокси с https: Traefik, Caddy, nginx, Pangolin и т. п.

- Прокси ведёт домен (`hub.example.com`) на контейнер `:3000`. Собственную авторизацию прокси **выключить** — авторизует сам хаб.
- `BASE_URL=https://hub.example.com`, `TRUST_PROXY=1`.
- Сами сервисы (Jackett, qBittorrent и т. д.) наружу не публиковать: хаб ходит к ним по внутренней сети.
- Если прокси с фильтрацией (CrowdSec и подобные), добавьте свой IP в allowlist: ответы 401/403 при настройке OAuth могут выглядеть как перебор.

Проверка снаружи:

```bash
scripts/check-oauth.sh https://hub.example.com <префикс>
```

Проверка по LAN до настройки прокси: `BASE_URL=http://<ip>:3000`, `TRUST_PROXY=0`.

## Сеть: bridge или сеть хоста

**Общая docker-сеть** — хаб подключается к той же сети, что сервисы, и обращается к ним по именам контейнеров:
`http://qbittorrent:8080`, `http://jackett:9117`, `http://torrserve:8090`, `http://transmission:9091`, `http://paperless:8000`.
Полный пример с Pangolin (Newt) и Watchtower — [`docker-compose.yml`](../docker-compose.yml) в корне репозитория.

**Сеть хоста** — если сервисы запущены на хосте или в `network_mode: host`:

```yaml
services:
  hub:
    image: ghcr.io/ivan-kuzmichev/home-mcp-hub:latest
    restart: unless-stopped
    network_mode: host
    env_file: .env
    environment:
      DATABASE_PATH: /data/hub.db
      PORT: 3245            # свободный порт на хосте
      TRUST_PROXY: '1'
    volumes:
      - ./data:/data
```

Сервисы тогда указываются через `http://127.0.0.1:<порт>`. Для qBittorrent в режиме «без авторизации» достаточно галочки
«Пропускать аутентификацию для клиентов на localhost».

## Первый вход и подключение ассистентов

1. `docker compose logs hub | grep "Admin panel"` — адрес админки с секретным префиксом (печатается один раз; потом префикс виден в «Настройках»).
2. Вход по паролю → настройка 2FA (QR-код и резервные коды). Без 2FA админка не пускает.
3. «Коннекторы» — адреса и ключи сервисов; для TorrServe ещё домашний адрес для плееров.
4. «MCP доступ» — скопировать MCP URL, включить «Регистрацию новых клиентов».
   - Claude → Settings → Connectors → Add custom connector → URL, OAuth-поля пустые → Connect.
   - ChatGPT → Плагины → Добавить → Создать MCP-приложение → URL-адрес сервера, аутентификация OAuth, «Я понимаю и хочу продолжить» → Создать.
5. Откроется страница хаба: вход, код 2FA, «Разрешить». Регистрация клиентов выключится сама.
6. Какие клиенты вообще могут регистрироваться — карточка «Разрешённые клиенты» на том же экране.

ChatGPT надёжно читает только первые ~512 символов инструкций сервера. Для него есть «Настройки» → «Свой initialize»:
клиент получает короткий текст, а полные правила ассистент берёт из инструмента `hub_guide`.

## Обновление

- Вручную: `docker compose pull && docker compose up -d`. Миграции базы применяются при старте.
- Автоматически: Watchtower из [`docker-compose.yml`](../docker-compose.yml) раз в сутки (05:00) тянет новый `latest`
  и перезапускает только контейнеры с меткой `com.centurylinklabs.watchtower.enable=true`.

## Бэкап

Всё состояние — в томе `/data`: `hub.db` и папка `prototypes/`. SQLite работает в режиме WAL, поэтому копировать базу через `.backup`, а не `cp`:

```bash
docker compose exec hub node -e "require('better-sqlite3')('/data/hub.db').backup('/data/hub-backup.db').then(()=>console.log('ok'))"
```

`.env` бэкапить отдельно и держать в секрете: без `HUB_MASTER_KEY` пароли сервисов не расшифровать.
