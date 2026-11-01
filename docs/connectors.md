# Connectors and tools

**English** · [Русский](connectors.ru.md)

| Connector | Tools | Verified |
| --- | --- | --- |
| Jackett | `search_torrents`, `list_indexers` | ✅ |
| qBittorrent | `torrents_status`, `torrent_add`, `torrent_stop`, `torrent_start`, `torrent_delete`, `torrent_files`, `transfer_info` | ✅ |
| Transmission | `transmission_status`, `transmission_add`, `transmission_stop`, `transmission_start`, `transmission_delete`, `transmission_files`, `transmission_info` | ⚠️ automated tests only |
| Paperless (ngx) | `paperless_search`, `paperless_review`, `paperless_get`, `paperless_thumbnail`, `paperless_taxonomy`, `paperless_update`, `paperless_undo`, `paperless_link` | ⚠️ automated tests only |
| TorrServe | `torrserve_add`, `torrserve_list`, `torrserve_links`, `torrserve_remove` | ✅ |
| mitmproxy | `mitm_status`, `mitm_hosts`, `mitm_flows`, `mitm_flow`; with mocks: `mitm_mock_replace`, `mitm_mock_patch`, `mitm_mocks`, `mitm_mock_toggle`, `mitm_mock_delete`, `mitm_clear` | ⚠️ automated tests only |
| camofox (browser) | `browser_open`, `browser_snapshot`, `browser_links`, `browser_screenshot`, `browser_extract`, `browser_tabs`, `browser_youtube_transcript`; with actions: `browser_act`, `browser_close`, `browser_import_cookies` | ⚠️ automated tests only |
| Files | `files_list`, `files_read`, `files_search`, `files_write`, `files_edit`, `files_mkdir`, `files_move`, `files_copy`, `files_delete`, `files_link` | ⚠️ automated tests only |
| Scripts (built-in) | `cron_create`, `cron_update`, `tool_create`, `tool_update`, `cron_enable`, `cron_run`, `cron_logs`, `cron_list`, `cron_get`, `cron_delete`, `script_secrets`, your own `my_*` | ✅ |
| Prototypes (built-in) | `prototype_publish`, `prototype_append`, `prototype_update`, `prototype_list`, `prototype_data`, `prototype_delete` | ✅ |
| Hub | `hub_status`, `hub_guide` (with a custom initialize) | ✅ |

Connectors are turned on and configured in the admin panel under **Коннекторы** (Connectors). The assistant doesn't see the tools of a disabled connector,
and you can turn off individual tools in the connector form. qBittorrent and Transmission can both be enabled at the same time, because their tools have different names.

## Torrents

Search goes through all Jackett indexers in parallel (25 s in total, a partial result instead of an error). Identical releases are merged.
The assistant gets a `result_id` and passes it to `torrent_add`, `transmission_add` or `torrserve_add`, so links with the Jackett API key
never reach the model. qBittorrent supports three login modes: no authentication (whitelist the hub's subnet), an API key (5.2+), or a login and password.

## Instructions for the assistant

Each connector form has an **Инструкция для ассистента** (Instructions for the assistant) block. The default text is built from the enabled tools.
In the **Дополнить** (Extend) mode your own text is added to it, in the **Заменить** (Replace) mode only your own text is sent.
The model receives the instructions of all enabled connectors at the start of every chat.

To see what the model gets right now (instructions, tools, schemas, an approximate size in tokens), open the admin panel and go to **Диагностика** (Diagnostics).
It also shows the 512-character limit: beyond it ChatGPT may not read the text. For ChatGPT use **Настройки** (Settings) → **Свой initialize** (Custom initialize) and the `hub_guide` tool.

## Paperless

The assistant searches and reads documents (OCR text, previews) and labels them in batches (title, date, correspondent, type, tags)
following the "labeling rules" from the connector settings. The rules arrive with the replies of `paperless_review`, `paperless_get` and `paperless_taxonomy`.
A batch can be rolled back (`paperless_undo`). Documents with the exclusion tag (`private` by default) are invisible to the assistant.

File links look like `/f/{token}` and have no secret prefix. They are either personal (24 h, only when signed in to the admin panel) or shareable on a direct request
(one use, 15 minutes). Uploading files through the assistant is not supported yet.

## Files

Gives the assistant access to folders on disk. Mount a folder into the hub container and list it in the connector settings,
one line per folder: `name | path in the container | mode`:

```yaml
    volumes:
      - ./data:/data
      - /volume1/docs:/files/docs
      - /volume1/photo:/files/photos:ro   # :ro — protection at the Docker level in addition to the mode
```

```
Документы | /files/docs | edit
Фото | /files/photos | read
```

| Mode | What is allowed |
| --- | --- |
| `read` | view, read, search (default) |
| `add` | also create new files and folders, copy into the folder; existing files are not changed |
| `edit` | also overwrite and edit files, rename and move |
| `full` | also delete (with `confirm: true`) |

The assistant sees paths like `Документы/2026/счёт.txt`, without container paths. `..` and symbolic links pointing outside the folder
are rejected, and a folder from the settings can't be deleted or moved. Moving between folders needs `edit` in the source
and `add` in the target. Text is read by lines, images (png, jpg, gif, webp up to 3 MB) are returned as images. The assistant writes large text in parts
(`files_write` with `mode: "append"`). Files are created as the container user. Set `PUID`/`PGID` if you need a specific owner.

**Запрещённые файлы** (Denied files). A field in the connector settings, one mask per line (`*` matches any characters, `?` matches one, case-insensitive).
The mask is checked against every name in the path, so `.ssh` closes the whole folder. The assistant can't read such files, find them by search,
copy or move them, create them, or get an `/f/` link to them. `files_list` shows only the name, marked as "закрыт" (closed).
By default keys and passwords are closed: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `id_rsa*`, `id_ecdsa*`,
`id_ed25519*`, `.ssh`, `.netrc`, `.git-credentials`, `wireguard*.conf`, `*secret*`. An empty field removes all the bans. This is a safety net,
not a replacement for choosing folders carefully: give the assistant specific subfolders, not a whole directory full of configs.

`files_link` gives an `/f/{token}` link, the same kind as in Paperless: personal (24 h, only when signed in to the admin panel) or shareable
(on a direct request, one use, 15 minutes). PDFs, images, video and plain text open in the browser, everything else (including HTML)
is downloaded. The path is checked on every open: if the file was moved or the folder was removed from the settings, the link stops working.

## camofox

A connector to [camofox-browser](https://github.com/jo-inc/camofox-browser), a stealth browser with a REST API in a neighboring container
(`http://camofox:9377`). The hub calls it with `Authorization: Bearer <CAMOFOX_ACCESS_KEY>`. There is one session (cookies, profile) per hub,
and it lives under the `userId` from the settings, so logins persist between chats.

**Read mode** (default): `browser_open` opens a page and returns a snapshot, which is text with element refs (`e1`, `e2`…).
`browser_snapshot` pages through long pages with `offset` (the character limit per reply is in the settings). The other tools are `browser_links`,
`browser_screenshot` (up to 2 MB), `browser_extract` (data by JSON Schema with `x-ref`), `browser_tabs`
and `browser_youtube_transcript`.

**Actions** are behind the **Разрешить действия** (Allow actions) switch: `browser_act` (click, type, press, scroll, navigate, back, forward, refresh, wait;
the reply includes a fresh snapshot right away), `browser_close`, a session reset with `browser_open(newSession: true)`, and `browser_import_cookies`.
While the switch is off, the assistant doesn't see these tools. Cookie import appears only if an API key is set. The Netscape
file (`cookies.txt`) is taken from the Files connector, and only from a `cookies/` subfolder (`folder/cookies/youtube.txt`), at most 500 cookies and 5 MB.

Before opening, the hub checks the address: http(s) only, no local names (`localhost`, `*.local`, `*.internal`…), all addresses
from DNS must be public, then the domain denylist and allowlist apply (`example.com` is the domain with its subdomains, `*.example.com` is subdomains only).
camofox follows redirects itself, so after opening and after actions the hub checks the final address and closes the tab if it is private.
Tabs are grouped by MCP client: `browser_close(all: true)` from Claude doesn't close ChatGPT's tabs. At most 3 requests to camofox
run at the same time, the rest wait in a queue.

If a Cloudflare check comes back instead of the page, the assistant offers a screenshot and a noVNC link from the **Адрес VNC** (VNC address) field. There you can
pass the check or sign in to the site by hand, and the cookies stay in the session. Text the assistant types into forms is not written to the log,
only its length.

Integration tests against a live camofox: `CAMOFOX_URL=http://localhost:9377 CAMOFOX_ACCESS_KEY=… pnpm vitest run tests/browser-live.test.ts`.

## mitmproxy

A connector to [mitmproxy](https://docs.mitmproxy.org/) (the `mitmweb` container, web interface `http://mitmweb:8081`). Devices go
through the proxy, and the assistant sees the captured traffic and, if you want, replaces service responses.

**Viewing** (always on): `mitm_status`, `mitm_hosts` (a summary by domain for the last N minutes: request count, size, status codes; filter by app
from the User-Agent), `mitm_flows` (a list of requests with short ids), `mitm_flow` (headers and bodies of the request and response, long ones in parts via
`offset`). The hub calls mitmweb with `Authorization: Bearer <password>` (the password is `MITM_WEB_PASSWORD`, empty means no password). Tokens, passwords,
keys, signatures, cookies, JWTs and `Bearer` values in headers, URLs and bodies are masked. The **Показывать токены** (Show tokens) switch turns masking off. mitmproxy streams bodies larger than
1 MB (`stream_large_bodies=1m`), and for those the reply says "тело не сохранено (больше 1 МБ, стрим)" (body not saved, larger than 1 MB, streamed).

**Mocks** are behind the **Разрешить моки** (Allow mocks) switch (off by default; while it is off, the assistant doesn't see the mock tools or `mitm_clear`):
- `mitm_mock_replace` replaces the whole response (code, headers, body; without `Content-Type` a JSON body gets `application/json`, anything else gets `text/plain`).
  The real server is not called.
- `mitm_mock_patch` lets the request go to the server and edits the real response: JSON fields (`user.items[0].price`, `items[*].price`),
  headers, the status code, or adds a delay.
- `mitm_mocks` (the list and how many times each one fired, including how many times a JSON edit was skipped because the response wasn't JSON),
  `mitm_mock_toggle`, `mitm_mock_delete` (all at once only with `confirm: true`), `mitm_clear` (clears captured traffic).

The counters "fired N times" and "N requests already matched" count only requests still held in mitmweb's memory
(the last ~3000; `mitm_clear` wipes them), not all time. A rule is edited by its `id` from `mitm_mocks`. The hub assigns ids, and
the tool returns an error for an unknown id. The host is taken from the `Host` header (in transparent mode and with WireGuard the connection address is an IP).

**In mitmweb.** Requests that triggered a mock are marked in the list: 🔵 means the whole response was replaced, 🔶 means the real response was edited
(the flow comment is `mock:<id>`). The mitmweb command line (`:`) has these commands:
- `hub.mocks` lists all rules with numbers, enabled ✓ and disabled ✗, and how many times each fired;
- `hub.mock.on <number|id>`, `hub.mock.off <number|id>`, `hub.mock.delete <number|id>` enable, disable and delete a rule; the number comes from `hub.mocks`.

The commands take effect in the proxy at once, and reach the hub at the next sync (within a minute at most; immediately when the assistant
runs `mitm_mocks`). You can't add mocks from mitmweb, only through the assistant. While mocks are off in the hub, the commands reply
"Моки выключены в хабе" (Mocks are off in the hub).

Pattern: the host is exact or `*.example.com`, the path may contain `*`, the method is optional, and the query is ignored. Rules apply to all devices
behind the proxy and are stored in the hub (SQLite). They are data only: the addon executes nothing. If several rules match a request,
the oldest `replace` fires. Otherwise the oldest `patch` fires (a fully replaced response is not edited further).

**Connecting the addon.** Mocks are applied by the addon `addons/mitmproxy/hub_mocks.py`:
1. copy it to `Docker/mitmproxy/scripts/` on the NAS;
2. add `-s /scripts/hub_mocks.py` to the mitmweb `command` and run `docker compose up -d`;
3. the hub needs access to the container: `fw.allow.containers: "mitmweb"` (dockfw);
4. in the admin panel set the password, turn on **Разрешить моки** and press **Проверить** (Check), which shows whether the addon is connected.

The hub passes the rules to the `hub_mocks` option via `PUT /options` and checks it once a minute (after a mitmproxy restart the rules come back
on their own). The addon writes changes made on the mitmweb command line to the `hub_mocks_edits` option, and the hub applies them to its own rules at the next check. If you turn off the connector or **Разрешить моки**, an empty list goes to the proxy and all mocks stop working, but they stay in the hub.
If the addon is not connected, the rule is saved, and the assistant's reply explains what to fix.

## Prototypes

`prototype_publish` publishes HTML at `/p/{slug}`, outside the secret prefix, so the link can be shared.
The assistant sends large pages in parts (`prototype_append`). Optional: a PIN (4 to 8 digits) and a lifetime, up to three versions with rollback.
The page is served in a CSP sandbox with no access to the admin cookies.

Each prototype has its own storage: one JSON document up to 50 MB, shared by everyone who opens the page (`localStorage`
doesn't work in the sandbox). The hub inserts a script with `window.hub.db` at the start of the page:

```js
const data = await hub.db.get()            // {} until something is saved
await hub.db.set({ items: [] })            // overwrite completely
await hub.db.update((d) => { d.items.push('новое'); return d })  // keeps other people's edits, retries on conflict
```

The script calls `/p/{slug}/db` with a token embedded in the served page. The token lives for 24 hours and stops working after
the PIN changes, so the page has to be reloaded. Anyone with the link can read and change the data of an open prototype.
The document is read and written as a whole, so it is meant for text and lists, not for base64 images.
The data is not versioned together with the HTML: rolling back a version doesn't touch it. You can view and clear it in the prototype card
or ask the assistant (`prototype_data`). When a prototype is deleted, its data is deleted with it.

## Cron scripts

The assistant writes the JS and the schedule, you approve the code in the admin panel under **Скрипты** (Scripts), and the script is enabled right away. You can also add a script by hand there.

- Any code change waits for approval again and pauses the script. Changing the schedule needs no approval.
  A rejected new script is deleted, a rejected change is rolled back to the previous version.
- You can turn a script off and on in the admin panel or ask the assistant (`cron_enable`).
- The sandbox is QuickJS (WebAssembly): no access to files, the process or the hub database, 30 s and 64 MB per run, up to 20 requests.
- Switches in the **Скрипты** connector settings:
  - **Без одобрения** (No approval): the assistant's code is enabled right away (off by default);
  - **Доступ к внешним адресам** (Access to external addresses): on by default;
  - **Доступ к локальной сети** (Access to the local network): off by default (host, containers, localhost; checked through DNS too).
- Secrets (for example a Telegram bot token) are created in the admin panel and bound to hosts. In the code you use the placeholder `{{secret:NAME}}`, and the hub substitutes
  the value only into a request to an allowed host. Neither the script nor the assistant sees the values.
- Hub tools from a script: `await hub.tool('torrents_status', { filter: 'completed' })`. They are read-only,
  and with **Доступ к локальной сети** on they can also write (`torrent_add`, `paperless_update`…).

### Connector settings for scripts

Open **Скрипты** → **Настройки коннекторов** (Connector settings), with one switch per connector. The fields become available as `{{secret:JACKETT_BASE_URL}}`,
`{{secret:JACKETT_API_KEY}}`, `{{secret:JACKETT_MIN_SEEDERS}}` and so on. Keys and passwords are substituted only into requests to the connector's address.
The address and parameters are plain values (the address can go at the start of a URL). The values are read from the connector on every run,
and the assistant sees only the names. This usually also needs **Доступ к локальной сети**.

## Custom MCP tools

The **MCP-инструменты** (MCP tools) block on the **Скрипты** screen. The assistant creates them with `tool_create` (or you do it with the **Добавить инструмент** (Add tool) button):
a `my_*` name, a description, parameters (string, number, yes/no, a choice from a list), and code with `args` and `return`. The assistant calls
an approved tool by itself like any other, in a new chat. In the current chat you can test it with `cron_run` and `args`.
Secrets, network, `hub.tool` and **Без одобрения** are shared with scripts, and a call is limited to 25 s.
