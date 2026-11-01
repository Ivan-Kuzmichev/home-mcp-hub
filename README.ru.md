<p align="center">
  <img src="docs/logo.png" width="96" height="96" alt="Логотип Home MCP Hub">
</p>

<h1 align="center">Home MCP Hub</h1>

<p align="center">
  Self-hosted MCP-хаб, который подключает домашние сервисы к Claude и ChatGPT.
</p>

<p align="center">
  <a href="https://github.com/Ivan-Kuzmichev/home-mcp-hub/releases/latest"><img src="https://img.shields.io/github/v/release/Ivan-Kuzmichev/home-mcp-hub" alt="Последний релиз"></a>
  <a href="https://github.com/Ivan-Kuzmichev/home-mcp-hub/actions/workflows/docker.yml"><img src="https://github.com/Ivan-Kuzmichev/home-mcp-hub/actions/workflows/docker.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-7FA7FF" alt="MCP Streamable HTTP">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Ivan-Kuzmichev/home-mcp-hub" alt="Лицензия MIT"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>Русский</b>
</p>

Один Docker-контейнер с админкой:
ассистент ищет и качает торренты, запускает стриминг, разбирает документы, публикует HTML-прототипы и выполняет ваши скрипты.

<p align="center">
  <a href="https://ivan-kuzmichev.github.io/home-mcp-hub/"><b>Открыть живое демо</b></a>
</p>

<img src="docs/screenshots/desktop-dashboard.png" alt="Дашборд Home MCP Hub: коннекторы, их состояние и последние вызовы MCP">

## Что умеет

- **Коннекторы** — Jackett, qBittorrent, Transmission, TorrServe, Paperless-ngx, папки с диска (чтение, правка, перенос по режимам), браузер camofox, перехват трафика mitmproxy. Настраиваются в админке, лишние инструменты можно выключить.
- **camofox** — ассистент открывает сайты в stealth-браузере [camofox](https://github.com/jo-inc/camofox-browser) с домашнего IP:
  читает страницы, ссылки и субтитры YouTube, делает скриншоты. По умолчанию только чтение; клики, ввод и переходы — по переключателю.
  Например: «открой news.ycombinator.com и перескажи первые пять заголовков», «что пишут в этом видео: <ссылка на YouTube>»,
  «найди на avito.ru велосипед до 20 000 и пришли три ссылки» (последнее — с включёнными действиями).
- **mitmproxy** — ассистент видит, куда ходят приложения домашних устройств, и по переключателю подменяет ответы сервисов
  (аддон `hub_mocks.py`, правила — только данные). Например: «куда ходило приложение Bank за последние 10 минут», «покажи запрос к api.bank.example/v1/profile»,
  «подмени ответ api.example.com/v1/profile: isPremium = true», «выключи мок».
- **Прототипы** — ассистент публикует HTML-страницу и отдаёт ссылку, при желании с пином, сроком жизни и небольшой JSON-базой.
- **Скрипты** — cron-задачи и свои MCP-инструменты на JS в песочнице, с секретами, которые не видит ни скрипт, ни модель.
- **Безопасность** — OAuth 2.1 с PKCE и обязательной 2FA для входа, секретный префикс пути, шифрование паролей сервисов, всегда закрытые файлы (ключи, `.env`, конфиги VPN), журнал всех вызовов.
- **Инструкции для ассистента** — у каждого коннектора свой текст, который можно дополнить или заменить; что уходит модели — на экране «Диагностика».

<p align="center">
  <img src="docs/screenshots/desktop-connector.png" width="32%" alt="Настройки коннектора mitmproxy">
  <img src="docs/screenshots/desktop-activity.png" width="32%" alt="Журнал вызовов">
  <img src="docs/screenshots/desktop-scripts.png" width="32%" alt="Скрипт ждёт одобрения">
</p>

## На телефоне

<p align="center">
  <img src="docs/screenshots/phone-dashboard.png" width="260" alt="Дашборд на телефоне">
  <img src="docs/screenshots/phone-prototypes.png" width="260" alt="Прототипы на телефоне">
  <img src="docs/screenshots/phone-access.png" width="260" alt="MCP доступ на телефоне">
</p>

## Запуск в Docker

`docker-compose.yml`:

```yaml
services:
  hub:
    image: ghcr.io/ivan-kuzmichev/home-mcp-hub:latest   # или закрепить версию: :0.15
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_PATH: /data/hub.db
      TZ: Europe/Moscow
    ports:
      - '3000:3000'
    volumes:
      - ./data:/data
```

`.env` рядом (`chmod 600 .env`):

```bash
BASE_URL=https://hub.example.com        # публичный адрес, без префикса; MCP работает только по https
HUB_MASTER_KEY=                         # openssl rand -hex 32 — шифрует пароли сервисов
BETTER_AUTH_SECRET=                     # openssl rand -base64 32
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=                         # от 12 символов, нужен только при первом старте
TRUST_PROXY=1                           # хаб за реверс-прокси (Traefik, Caddy, Pangolin…)
```

```bash
docker compose up -d
docker compose logs hub | grep "Admin panel"   # адрес админки с секретным префиксом, печатается один раз
```

Дальше:

1. Открыть адрес из лога, войти и настроить 2FA — без неё админка не пустит.
2. «Коннекторы» — указать адреса сервисов, например `http://qbittorrent:8080`, если хаб в одной docker-сети с ними.
3. «MCP доступ» — скопировать MCP URL и включить регистрацию клиентов:
   - **Claude** → Settings → Connectors → Add custom connector → URL, OAuth-поля пустые → Connect.
   - **ChatGPT** → Плагины → Добавить → Создать MCP-приложение → URL, аутентификация OAuth → Создать.
4. Войти, ввести код 2FA, нажать «Разрешить». В новом чате попросить `вызови hub_status`.

Обновление — `docker compose pull && docker compose up -d`, миграции базы применяются при старте.
Всё состояние хранится в `./data`, бэкап и остальное — в [docs/deployment.md](docs/deployment.md).

## Документация

- [Развёртывание](docs/deployment.md) — реверс-прокси, сеть хоста, образы и версии, автообновление, бэкап
- [Коннекторы и инструменты](docs/connectors.md) — что умеет каждый коннектор, инструкции, Paperless, скрипты и свои инструменты
- [Безопасность](docs/security.md) — как закрыты вход, OAuth, префикс, секреты и прототипы
- [Разработка](docs/development.md) — локальный запуск, проверки, релизы

## Релизы

Тег `v*` собирает образ `ghcr.io/ivan-kuzmichev/home-mcp-hub` с тегами `X.Y.Z` и `X.Y` и публикует GitHub Release
с коммитами с прошлого тега. Каждый push в `main` обновляет `latest`.

## Лицензия

[MIT](LICENSE)
