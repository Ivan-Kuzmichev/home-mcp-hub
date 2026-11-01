# Deployment

**English** · [Русский](deployment.ru.md)

## Image and versions

Every push to `main` builds an image in GitHub Actions and publishes it to GHCR: `ghcr.io/ivan-kuzmichev/home-mcp-hub:latest` and `:sha-<commit>`.
A release (`pnpm release`, see [development.md](development.md)) creates the tag `vX.Y.Z`, and CI also publishes `:X.Y.Z` and `:X.Y`.

- You can run `:latest` with auto-update, or pin `:X.Y` and get only the patches of that version.
- The image version and commit are shown in the admin panel under **Настройки** (Settings).
- If the GHCR package is private, run `docker login ghcr.io` once with a token that has `read:packages`. The image contains no secrets, so you can make the package public.

## Environment variables

| Variable | What it is |
| --- | --- |
| `BASE_URL` | Public address of the hub without the prefix. MCP works over https only; the admin panel and connectors also work over http |
| `HUB_MASTER_KEY` | `openssl rand -hex 32`. Encrypts service passwords and keys (AES-256-GCM). If you lose it, you have to enter them again, everything else stays intact |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. Signs sessions |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The admin, created on the first start. The password needs 12+ characters |
| `DATABASE_PATH` | SQLite file, `/data/hub.db` in the container |
| `TRUST_PROXY` | `1`: take the client IP from `X-Forwarded-For` (the hub is behind a proxy), `0`: direct connections |
| `PORT` | Port inside the container, 3000 by default |
| `PUID`, `PGID` | Optional: owner of the files in `/data` and in the folders of the **Файлы** (Files) connector on the host (`id -u`, `id -g`) |
| `TZ`, `LOG_LEVEL` | Time zone for cron scripts, log level (`info`) |

The image sets permissions on `/data` itself at start, so you don't need `chown` on the host.

## Reverse proxy

The hub is meant to run behind an https proxy: Traefik, Caddy, nginx, Pangolin and so on.

- The proxy sends the domain (`hub.example.com`) to the container on `:3000`. **Turn off** the proxy's own authentication: the hub authenticates by itself.
- `BASE_URL=https://hub.example.com`, `TRUST_PROXY=1`.
- Don't publish the services themselves (Jackett, qBittorrent and so on) to the outside: the hub reaches them over the internal network.
- The prototype storage (`window.hub.db`) accepts requests up to 50 MB. nginx has `client_max_body_size 1m` by default,
  so raise it, for example `client_max_body_size 50m;`, or large saves will get 413 from the proxy.
- If the proxy filters traffic (CrowdSec and similar), add your IP to the allowlist: 401/403 responses during OAuth setup can look like brute force.

Check from outside:

```bash
scripts/check-oauth.sh https://hub.example.com <prefix>
```

Check over the LAN before the proxy is set up: `BASE_URL=http://<ip>:3000`, `TRUST_PROXY=0`.

## Network: bridge or host network

**Shared Docker network:** the hub joins the same network as the services and reaches them by container name:
`http://qbittorrent:8080`, `http://jackett:9117`, `http://torrserve:8090`, `http://transmission:9091`, `http://paperless:8000`.
A full example with Pangolin (Newt) and Watchtower is [`docker-compose.yml`](../docker-compose.yml) in the repository root.

**Host network:** use it if the services run on the host or with `network_mode: host`:

```yaml
services:
  hub:
    image: ghcr.io/ivan-kuzmichev/home-mcp-hub:latest
    restart: unless-stopped
    network_mode: host
    env_file: .env
    environment:
      DATABASE_PATH: /data/hub.db
      PORT: 3245            # a free port on the host
      TRUST_PROXY: '1'
    volumes:
      - ./data:/data
```

Then point the connectors at `http://127.0.0.1:<port>`. For qBittorrent in the "no authentication" mode, it is enough to tick
"Bypass authentication for clients on localhost".

## First sign-in and connecting assistants

1. `docker compose logs hub | grep "Admin panel"` shows the admin address with the secret prefix (printed once; afterwards the prefix is visible under **Настройки** (Settings)).
2. Sign in with the password, then set up 2FA (QR code and backup codes). The admin panel stays closed without 2FA.
3. **Коннекторы** (Connectors): service addresses and keys; for TorrServe also the home address for players.
4. **MCP доступ** (MCP access): copy the MCP URL and turn on "Регистрация новых клиентов" (Registration of new clients).
   - Claude: Settings → Connectors → Add custom connector → URL, leave the OAuth fields empty → Connect.
   - ChatGPT: Plugins → Add → Create MCP app → server URL, OAuth authentication, "I understand and want to continue" → Create.
5. The hub page opens: sign in, enter the 2FA code, press "Разрешить" (Allow). Client registration turns off by itself.
6. The card "Разрешённые клиенты" (Allowed clients) on the same screen shows which clients are allowed to register at all.

ChatGPT reliably reads only the first ~512 characters of the server instructions. For it there is **Настройки** (Settings) → "Свой initialize" (Custom initialize):
the client gets a short text, and the assistant takes the full rules from the `hub_guide` tool.

## Update

- Manually: `docker compose pull && docker compose up -d`. Database migrations run on start.
- Automatically: Watchtower from [`docker-compose.yml`](../docker-compose.yml) pulls a new `latest` once a day (05:00)
  and restarts only the containers with the label `com.centurylinklabs.watchtower.enable=true`.

## Backup

All state lives in the `/data` volume: `hub.db` and the `prototypes/` folder. SQLite runs in WAL mode, so copy the database with `.backup`, not `cp`:

```bash
docker compose exec hub node -e "require('better-sqlite3')('/data/hub.db').backup('/data/hub-backup.db').then(()=>console.log('ok'))"
```

Back up `.env` separately and keep it secret: without `HUB_MASTER_KEY` the service passwords can't be decrypted.
