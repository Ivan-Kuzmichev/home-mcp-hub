# mitmproxy Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Коннектор `mitmproxy` в Home MCP Hub: Claude смотрит, куда ходит трафик iPhone через mitmweb, и подкладывает моки (подмена целиком и правка полей настоящего ответа), а токены из перехвата не попадают ни к модели, ни в журнал.

**Architecture:** Хаб ходит в REST API mitmweb (Bearer-пароль + XSRF). Моки применяет Python-аддон `hub_mocks.py` внутри mitmproxy; правила живут в SQLite хаба, и хаб раз в минуту сверяет их с опцией аддона `hub_mocks` (пусто, если коннектор или моки выключены). Всё, что уходит модели из перехвата, проходит общий модуль маскировки.

**Tech Stack:** Next.js 15 / TypeScript strict, zod, Drizzle + better-sqlite3, node-cron, vitest; Python 3 + mitmproxy 12.3 (аддон), тесты аддона — stdlib `unittest` без mitmproxy.

**Spec:** `docs/superpowers/specs/2026-10-31-mitmproxy-connector-design.md`

## Global Constraints

- Коннектор = папка `lib/connectors/mitmproxy/` + одна строка в `lib/connectors/registry.ts`; id `mitmproxy`, name `mitmproxy`.
- Все инструменты с префиксом `mitm_` (имена MCP глобальные).
- Тексты интерфейса и ответов инструментов — на русском, короткие (читаются с телефона); идентификаторы и комментарии — на английском.
- TypeScript strict, без `any`. Секреты — только через `secret()` (AES-256-GCM).
- Моки — только декларативные правила; аддон не исполняет присланный код и не читает файлы.
- Маскировка включена по умолчанию; переключатель «Показывать токены» (`showTokens`) по умолчанию выключен.
- «Разрешить моки» (`allowMocks`) по умолчанию выключен; без него инструменты моков и `mitm_clear` скрыты через `hiddenTools`.
- Желаемое состояние в прокси: коннектор включён и `allowMocks` → все включённые правила, иначе пустой список.
- Подмена целиком (`replace`) разрешена для любых типов ответа, включая HTML; правила действуют на всех устройствах.
- Шаблоны URL: хост точный или `*.example.com`, путь со `*`, без регулярных выражений; query не участвует.
- `stream_large_bodies=1m`: несохранённое тело — честная строка «тело не сохранено (больше 1 МБ, стрим)».
- Перед коммитом: `pnpm lint && pnpm typecheck && pnpm test`. Не логировать секреты (пароль mitmweb, значения токенов).

## Review Focus

1. **Неверный пароль mitmweb** — mitmweb отвечает 403 (не 401) с HTML-формой входа: ожидается «mitmproxy: неверный пароль веб-интерфейса (403)», а не HTML в ответе. Тест — Task 4.
2. **Токен вне заголовков** — JWT в пути URL, в form-urlencoded теле, в `Set-Cookie` с атрибутами: всё маскируется, имена cookies остаются. Тесты — Task 1.
3. **Шаблон с портом и регистром** — хост `API.Example.com:443`, путь с query `/v1/profile?x=1`: совпадает с правилом `api.example.com` + `/v1/profile`; `example.com` не совпадает с `*.example.com`. Тесты — Task 2 (TS) и Task 3 (Python, те же случаи).
4. **Аддон не подключён или mitmweb перезапущен** — опции `hub_mocks` нет → понятная ошибка с инструкцией; опция сброшена в пустую → следующая сверка возвращает правила. Тесты — Task 5.
5. **patch на не-JSON ответ** — правило с `json` на HTML/битом JSON не роняет прокси: статус и заголовки применяются, JSON-операции пропускаются, поток помечается `mock:<id> (json пропущен)`. Тест — Task 3.

---

## File Structure

- `lib/redact.ts` — маскировка заголовков, URL, тел (общая, пригодится camofox).
- `lib/connectors/mitmproxy/rules.ts` — тип `MockRule`, zod-схема, сопоставление шаблонов, `payloadFor(rules)`.
- `addons/mitmproxy/hub_mocks.py` + `addons/mitmproxy/test_hub_mocks.py` — аддон и его тесты.
- `lib/connectors/mitmproxy/client.ts` — REST-клиент mitmweb.
- `lib/connectors/mitmproxy/mocks.ts` — хранилище правил (Drizzle) и сверка с прокси.
- `lib/connectors/mitmproxy/flows.ts` — разбор `/flows`: сводка по доменам, фильтры, приложение по User-Agent, рендер потока.
- `lib/connectors/mitmproxy/index.ts` — коннектор: настройки, `test`, `hiddenTools`, `instructions`, инструменты.
- Изменения: `lib/db/schema.ts`, новая миграция, `lib/jobs.ts`, `lib/journal.ts`, `lib/connectors/registry.ts`,
  `.github/workflows/docker.yml`, `package.json` (скрипт `test:addon`), документация.

---

### Task 1: Маскировка секретов

**Files:**
- Create: `lib/redact.ts`
- Test: `tests/redact.test.ts`

**Interfaces:**
- Produces:
  - `maskValue(v: string): string` → `*** (N симв.)`
  - `maskHeaders(h: [string, string][]): [string, string][]` — mitmweb отдаёт заголовки массивом пар
  - `maskUrl(url: string): string` — query-параметры и JWT в пути
  - `maskBody(text: string, contentType: string | undefined): string` — JSON (рекурсивно по ключам), form-urlencoded, JWT в любом тексте
  - `isSensitiveName(name: string): boolean`

- [ ] **Step 1: Write the failing tests** `tests/redact.test.ts`:

```ts
it('masks auth headers and keeps cookie names', () => {
  expect(maskHeaders([['Authorization', 'Bearer abcdef'], ['Cookie', 'sid=123; theme=dark'], ['Accept', 'json']]))
    .toEqual([['Authorization', '*** (13 симв.)'], ['Cookie', 'sid=***; theme=***'], ['Accept', 'json']])
  expect(maskHeaders([['Set-Cookie', 'session=xyz; Path=/; HttpOnly']])).toEqual([['Set-Cookie', 'session=***; Path=/; HttpOnly']])
  expect(maskHeaders([['X-Api-Key', 'k'], ['X-Auth-Token', 't'], ['X-Session-Id', 's']]).every(([, v]) => v.startsWith('***'))).toBe(true)
})
it('masks query, JWT in path, JSON and form bodies', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl'
  expect(maskUrl('https://a.example/v1/x?access_token=abc&page=2')).toBe('https://a.example/v1/x?access_token=***&page=2')
  expect(maskUrl(`https://a.example/v1/${jwt}/x`)).toBe('https://a.example/v1/***/x')
  expect(JSON.parse(maskBody(JSON.stringify({ user: { name: 'Ваня', password: 'p' }, refresh_token: 'r', items: [{ jwt }] }), 'application/json')))
    .toEqual({ user: { name: 'Ваня', password: '***' }, refresh_token: '***', items: [{ jwt: '***' }] })
  expect(maskBody('login=ivan&pass=secret', 'application/x-www-form-urlencoded')).toBe('login=ivan&pass=***')
  expect(maskBody(`token is ${jwt} here`, 'text/plain')).toBe('token is *** here')
  expect(maskBody('{broken', 'application/json')).toBe('{broken')
})
```

Чувствительные имена (без учёта регистра, точное совпадение или вхождение для `token|secret|session|auth|password|passwd`):
`token, access_token, refresh_token, id_token, password, pass, passwd, secret, client_secret, api_key, apikey, session, sid, code, jwt, otp, pin, authorization`.

- [ ] **Step 2: Run** `pnpm vitest run tests/redact.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `lib/redact.ts` по интерфейсу выше. JWT — `/eyJ[\w-]+\.[\w-]+\.[\w-]+/g`. Невалидный JSON — вернуть текст с одной лишь заменой JWT.
- [ ] **Step 4: Run** `pnpm vitest run tests/redact.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git add lib/redact.ts tests/redact.test.ts && git commit -m "Shared redaction of tokens in headers, URLs and bodies"`

---

### Task 2: Правила моков и сопоставление шаблонов (TS)

**Files:**
- Create: `lib/connectors/mitmproxy/rules.ts`
- Test: `tests/mitm-rules.test.ts`

**Interfaces:**
- Produces:

```ts
export type JsonOp = { path: string; value: unknown }
export type MockRule = {
  id: string; name: string; enabled: boolean
  match: { host: string; path: string; method?: string }
  kind: 'replace' | 'patch'
  status?: number; headers?: Record<string, string>; body?: string      // replace
  setHeaders?: Record<string, string>; removeHeaders?: string[]; json?: JsonOp[] // patch
  delayMs?: number
}
export const mockRuleSchema: z.ZodType<Omit<MockRule, 'id' | 'enabled'>>
export function hostMatches(host: string, pattern: string): boolean
export function pathMatches(path: string, pattern: string): boolean   // query отбрасывается
export function ruleMatches(rule: MockRule, req: { method: string; host: string; path: string }): boolean
export const JSON_PATH = /^[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*(\.[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*)*$/
export function payloadFor(rules: MockRule[]): string   // JSON.stringify({ rules: enabledOnly }) — стабильный порядок по id
```

Ограничения схемы: `name` 1–80, `match.host` без схемы и пути, `match.path` начинается с `/`, `status` 100–599, `delayMs` 0–30000,
`replace` требует `body` (может быть пустой строкой), `patch` требует хотя бы одно из `status|setHeaders|removeHeaders|json|delayMs`,
каждый `json[].path` проходит `JSON_PATH`, `body` до 1 МБ.

- [ ] **Step 1: Write the failing tests**:

```ts
it('matches host patterns, ports and case', () => {
  expect(hostMatches('API.Example.com:443', 'api.example.com')).toBe(true)
  expect(hostMatches('x.api.example.com', '*.example.com')).toBe(true)
  expect(hostMatches('example.com', '*.example.com')).toBe(false)
  expect(hostMatches('notexample.com', 'example.com')).toBe(false)
})
it('matches paths with * and ignores query', () => {
  expect(pathMatches('/v1/profile?x=1', '/v1/profile')).toBe(true)
  expect(pathMatches('/v1/users/42/profile', '/v1/users/*/profile')).toBe(true)
  expect(pathMatches('/v1/profile/extra', '/v1/profile')).toBe(false)
  expect(pathMatches('/v1/profile/extra', '/v1/profile*')).toBe(true)
})
it('checks the method only when set, and validates rules', () => {
  const r = { id: 'a', name: 'n', enabled: true, kind: 'patch', match: { host: 'a.example', path: '/x', method: 'GET' }, json: [{ path: 'user.isPremium', value: true }] } as MockRule
  expect(ruleMatches(r, { method: 'POST', host: 'a.example', path: '/x' })).toBe(false)
  expect(mockRuleSchema.safeParse({ ...r, json: [{ path: 'a..b', value: 1 }] }).success).toBe(false)
  expect(mockRuleSchema.safeParse({ name: 'n', kind: 'patch', match: { host: 'a.example', path: '/x' } }).success).toBe(false)
  expect(JSON.parse(payloadFor([{ ...r, id: 'b' }, { ...r, enabled: false }])).rules.map((x: MockRule) => x.id)).toEqual(['b'])
})
```

- [ ] **Step 2: Run** `pnpm vitest run tests/mitm-rules.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `rules.ts`. Путь-шаблон → regex с экранированием и `*` = `.*`, якоря `^…$`; хост — нижний регистр, порт отрезается.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "mitmproxy: mock rule schema and URL patterns"`

---

### Task 3: Аддон `hub_mocks.py`

**Files:**
- Create: `addons/mitmproxy/hub_mocks.py`, `addons/mitmproxy/test_hub_mocks.py`
- Modify: `package.json` (скрипт `"test:addon": "python3 -m unittest discover -s addons/mitmproxy"`), `.github/workflows/docker.yml` (шаг `run: pnpm test:addon` после `pnpm test` в job `check`)

**Interfaces:**
- Consumes: формат `payloadFor()` из Task 2 — `{"rules": [MockRule…]}`, те же правила сопоставления.
- Produces (для хаба): опция mitmproxy `hub_mocks` (str, по умолчанию `""`); сработавший поток получает `flow.comment = "mock:<id>"`
  (или `"mock:<id> (json пропущен)"`). Хаб считает срабатывания по `comment` в `/flows`.

Структура файла: чистые функции на уровне модуля (`host_matches`, `path_matches`, `rule_matches`, `parse_path`, `apply_json_ops(doc, ops) -> bool`)
без импорта mitmproxy; класс `HubMocks` импортирует `mitmproxy` (`ctx`, `http`) внутри методов `load`/`request`/`response`, чтобы
тесты шли на чистом Python. `request`: правило `replace` → `flow.response = http.Response.make(status, body, headers)`, задержка
через `asyncio.sleep` (хук `async def`). `response`: правило `patch` → статус, `setHeaders`/`removeHeaders`, JSON через
`flow.response.get_text()` / `set_text()` (mitmproxy сам разжимает gzip/br). Ошибки разбора правил — `ctx.log.warn`, без падения.
Первое совпавшее включённое правило побеждает (порядок списка).

- [ ] **Step 1: Write the failing tests** `test_hub_mocks.py` (`unittest`): те же случаи сопоставления, что в Task 2 (порт, регистр,
  `*.`, query, метод); `apply_json_ops({'user': {'isPremium': False}, 'items': [{'price': 5}, {'price': 7}]}, [{'path': 'user.isPremium', 'value': True}, {'path': 'items[*].price', 'value': 0}])`
  → `True` и документ изменён; путь в несуществующий ключ создаёт его, индекс за пределами массива — операция пропускается;
  `apply_json_ops` на не-dict/list документе → `False` без исключения.
- [ ] **Step 2: Run** `pnpm test:addon` — Expected: FAIL (ImportError / нет функций).
- [ ] **Step 3: Implement** `hub_mocks.py` по описанию выше; в docstring — как подключить: положить рядом с `autoclear.py`, добавить `-s /scripts/hub_mocks.py` в `command`.
- [ ] **Step 4: Run** `pnpm test:addon` — Expected: OK.
- [ ] **Step 5: Commit** `git commit -m "mitmproxy addon hub_mocks: replace and patch rules"`

---

### Task 4: REST-клиент mitmweb

**Files:**
- Create: `lib/connectors/mitmproxy/client.ts`
- Test: `tests/mitm-client.test.ts`

**Interfaces:**
- Consumes: `serviceFetch`, `scrub` из `lib/connectors/http.ts`.
- Produces:

```ts
export type MitmConfig = { baseUrl: string; password?: string; timeoutSec: number }
export type MitmFlow = { id: string; type: string; comment: string; timestamp_created: number
  client_conn?: { peername?: [string, number] }
  request?: { method: string; scheme: string; host: string; port: number; path: string; headers: [string, string][]; contentLength: number | null; timestamp_start: number }
  response?: { status_code: number; headers: [string, string][]; contentLength: number | null }
  error?: { msg: string } }
export class MitmClient {
  constructor(cfg: MitmConfig)
  state(): Promise<{ version: string; modes: string[] }>          // GET /state
  flows(): Promise<MitmFlow[]>                                     // GET /flows
  content(id: string, part: 'request' | 'response'): Promise<Buffer>  // GET /flows/{id}/{part}/content.data
  options(): Promise<Record<string, { value: unknown }>>           // GET /options
  setOptions(update: Record<string, unknown>): Promise<void>       // PUT /options
  clear(): Promise<void>                                           // POST /clear
}
```

Каждый запрос: `Authorization: Bearer <password>`. Для POST/PUT — один раз на клиент сгенерированный `randomBytes(16).toString('hex')`
в cookie `_mitmproxy_xsrf=<v>` и заголовке `X-XSRFToken: <v>`. Ошибки (`ToolError`): 403 → `mitmproxy: неверный пароль веб-интерфейса (403)`;
404 на потоке → `Запроса уже нет в mitmproxy — он хранит только последние запросы`; сеть/таймаут → `<сообщение serviceFetch> — проверь контейнер mitmweb и адрес в настройках`;
прочее → `mitmproxy: ошибка N (причина)`. Пароль не попадает в сообщения.

- [ ] **Step 1: Write the failing tests** (через `mockFetch` из `tests/helpers.ts`): Bearer на GET; на PUT `/options` одинаковое значение
  в cookie `_mitmproxy_xsrf` и `X-XSRFToken`, тело `{"hub_mocks":"…"}` с `Content-Type: application/json`; 403 с HTML-телом → текст
  из Review Focus 1 и в сообщении нет `<html`; 404 на `content()` → сообщение про последние запросы.
- [ ] **Step 2: Run** `pnpm vitest run tests/mitm-client.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `client.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "mitmproxy: REST client with bearer auth and XSRF"`

---

### Task 5: Хранилище правил и сверка с прокси

**Files:**
- Modify: `lib/db/schema.ts` (таблица `mitm_mock`), `lib/jobs.ts`
- Create: миграция через `pnpm db:generate` (файл `lib/db/migrations/0013_*.sql` + meta), `lib/connectors/mitmproxy/mocks.ts`
- Test: `tests/mitm-mocks.test.ts`

**Interfaces:**
- Consumes: `MockRule`, `payloadFor` (Task 2); `MitmClient` (Task 4); `getConnectorRow`, `readConfig` (`lib/connectors/store.ts`), `getConnector`.
- Produces:

```ts
// table mitm_mock: id text pk, name text, enabled integer(boolean), rule_json text (match/kind/поля без id/enabled), created_at, updated_at
export function listMocks(): MockRule[]
export function saveMock(input: Omit<MockRule, 'id' | 'enabled'> & { id?: string }): MockRule   // новое — enabled: true
export function setMockEnabled(id: string, enabled: boolean): MockRule
export function deleteMock(id: string): void
export function deleteAllMocks(): number
export class AddonMissingError extends ToolError {}
/** Push the desired rules if the proxy differs. Returns what happened. */
export async function syncMocks(opts?: { strict?: boolean }): Promise<'in-sync' | 'pushed' | 'skipped'>
```

`syncMocks`: читает строку коннектора `mitmproxy` и её конфиг (`readConfig` + `parseConfig`) даже при выключенном коннекторе; нет
строки или конфиг невалиден → `'skipped'`. Желаемое: `row.enabled && config.allowMocks ? payloadFor(listMocks()) : payloadFor([])`.
`GET /options`: нет ключа `hub_mocks` → `AddonMissingError` с текстом «В mitmproxy не подключён аддон hub_mocks.py: положи его в
Docker/mitmproxy/scripts/ и добавь `-s /scripts/hub_mocks.py` в command» (бросается при `strict`, иначе `'skipped'`); значение равно
желаемому → `'in-sync'`; иначе `PUT /options {hub_mocks: desired}` → `'pushed'`. Сеть недоступна: при `strict` — бросить, иначе
`'skipped'` и `logger.warn` только при смене состояния доступности (модульная переменная). В `lib/jobs.ts` —
`cron.schedule('* * * * *', safe('mitm-mocks', () => syncMocks()), { name: 'mitm-mocks', noOverlap: true })`.

- [ ] **Step 1: Write the failing tests** (`setupTempDb`, `saveConfig` коннектора, `mockFetch` с состоянием опций в памяти):
  1) включён + `allowMocks` + 1 правило: первая сверка `'pushed'`, вторая `'in-sync'`; 2) «перезапуск» — опция сброшена в `""` → `'pushed'`
  с тем же телом; 3) `setConnectorEnabled('mitmproxy', false)` → пушится `{"rules":[]}`; 4) `allowMocks: false` → тоже пусто;
  5) опции `hub_mocks` нет: `syncMocks({ strict: true })` бросает `AddonMissingError`, без `strict` → `'skipped'`; 6) выключенное правило в payload не попадает.
- [ ] **Step 2: Run** `pnpm vitest run tests/mitm-mocks.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** схему, `pnpm db:generate`, `mocks.ts`, задачу в `lib/jobs.ts`.
- [ ] **Step 4: Run** `pnpm vitest run tests/mitm-mocks.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "mitmproxy: mock rules in SQLite, reconciled with the proxy every minute"`

---

### Task 6: Коннектор и инструменты просмотра

**Files:**
- Create: `lib/connectors/mitmproxy/flows.ts`, `lib/connectors/mitmproxy/index.ts`
- Modify: `lib/connectors/registry.ts` (после `browser`)
- Test: `tests/mitmproxy.test.ts`

**Interfaces:**
- Consumes: `MitmClient`, `MitmFlow` (Task 4); `maskHeaders`, `maskUrl`, `maskBody` (Task 1); `syncMocks`, `listMocks` (Task 5); `ruleMatches` (Task 2).
- Produces:
  - `export const mitmproxy: RegisteredConnector` с `configSchema`: `baseUrl` (по умолчанию `http://mitmweb:8081`), `password` (`secret()`),
    `allowMocks` (false), `showTokens` (false), `textLimit` (2000–200000, по умолчанию 24000), `timeoutSec` (5–120, по умолчанию 15).
  - `hiddenTools(c)`: без `allowMocks` → `['mitm_mock_replace','mitm_mock_patch','mitm_mocks','mitm_mock_toggle','mitm_mock_delete','mitm_clear']`.
  - `flows.ts`: `appOf(f: MitmFlow): string` (из User-Agent: `AppName/1.2 CFNetwork…` → `AppName`; иначе первый токен UA; нет UA → `?`),
    `hostSummary(flows, { sinceMs, app? }): { host: string; count: number; bytes: number; codes: Record<string, number> }[]`
    (коды — `2xx/3xx/4xx/5xx/ошибка`, сортировка по `count` убыв.), `filterFlows(flows, { host?, path?, app?, sinceMs })`,
    `renderFlow(f, bodies, { masked, limit, offset }): string`.

Инструменты (все `readOnlyHint: true`):
- `mitm_status()` — `mitmproxy 12.3.1 · режимы regular, socks5, wireguard · в памяти N запросов · аддон hub_mocks подключён/нет · правил активно K`.
- `mitm_hosts({ minutes = 15, app? })` — строки `• host — N запр. · 1,2 МБ · 2xx 40 / 4xx 2`, сверху `За 15 мин: M доменов, P запросов`; лимит по `textLimit`.
- `mitm_flows({ host?, path?, app?, minutes = 15, limit = 30 })` — `• id8 · GET host/path · 200 · 12:03:41 · 3 КБ[ · мок «name»]`; путь через `maskUrl` (если не `showTokens`).
- `mitm_flow({ id, offset = 0 })` — принимает полный id или первые 8 символов; заголовки и тела запроса/ответа после маскировки;
  бинарные (`image/*`, `video/*`, `audio/*`, `font/*`, `application/octet-stream`, `application/protobuf` или не UTF-8) → `бинарное, N байт`;
  `contentLength` null при ненулевом `content-length` в заголовках → `тело не сохранено (больше 1 МБ, стрим)`; длинное — по `textLimit` с `… (offset для продолжения: N)`.
- `test(c)`: `state()` + `flows()` → `{ ok: true, summary: 'mitmproxy 12.3.1', details: ['в памяти N запросов', 'аддон hub_mocks: подключён|не подключён', 'ответ X мс'] }`.
- `instructions`: одна строка «mitmproxy: куда ходят приложения — mitm_hosts, детали — mitm_flow; токены в ответах скрыты.» + при
  доступных моках «Моки — mitm_mock_replace (ответ целиком) и mitm_mock_patch (поля настоящего ответа); перед удалением всех — переспроси.»

- [ ] **Step 1: Write the failing tests** (фикстура из 4–5 потоков: iOS-приложение `Bank/5.1 CFNetwork/1568 Darwin/24.0.0` на 2 домена, браузер, поток с ошибкой, поток с `comment: 'mock:m1'`):
  сводка группирует и сортирует, фильтр `app: 'bank'` (без регистра) оставляет только Bank, `minutes` отсекает старые; `mitm_flow`
  маскирует `Authorization` и `refresh_token` в JSON-теле, а с `showTokens: true` — нет; бинарный и «стрим» тексты; короткий id
  разрешается; `hiddenTools` без `allowMocks` возвращает 6 имён; `test()` пишет версию и «аддон hub_mocks: не подключён», если в `/options` нет `hub_mocks`.
- [ ] **Step 2: Run** `pnpm vitest run tests/mitmproxy.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `flows.ts`, `index.ts` (инструменты просмотра + пустые заглушки моков не нужны — моки в Task 7), строку в `registry.ts`.
- [ ] **Step 4: Run** `pnpm vitest run tests/mitmproxy.test.ts && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "mitmproxy connector: traffic by domain, flows and masked flow details"`

---

### Task 7: Инструменты моков, журнал, документация

**Files:**
- Modify: `lib/connectors/mitmproxy/index.ts`, `lib/journal.ts`, `tests/mitmproxy.test.ts`, `tests/journal.test.ts`,
  `tests/mcp-server.test.ts`, `docs/connectors.md`, `docs/security.md`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `saveMock`, `setMockEnabled`, `deleteMock`, `deleteAllMocks`, `listMocks`, `syncMocks({ strict: true })` (Task 5);
  `mockRuleSchema`, `ruleMatches` (Task 2); `MitmClient.flows/clear` (Task 4).
- Produces: инструменты
  - `mitm_mock_replace({ id?, name, host, path, method?, status = 200, headers?, body, delayMs? })`
  - `mitm_mock_patch({ id?, name, host, path, method?, status?, setHeaders?, removeHeaders?, json?, delayMs? })`
  - `mitm_mocks()`, `mitm_mock_toggle({ id, enabled })`, `mitm_mock_delete({ id?, all?, confirm? })` (`destructiveHint: true`; `all` без `confirm: true` → «Не удалено, переспроси…»), `mitm_clear()`.
  - Каждый меняющий инструмент: сохранить в БД → `syncMocks({ strict: true })` → ответ. Ответ на создание:
    `Мок «name» включён: GET api.example.com/v1/profile → isPremium = true. Под шаблон уже попадало N запросов из перехваченных.`
    `replace` без `headers['Content-Type']`: JSON-валидное тело → `application/json`, иначе `text/plain; charset=utf-8`.
  - `mitm_mocks()`: `• m1 «Премиум» — вкл · patch GET api.example.com/v1/profile · сработал N раз` (N — потоки с `comment` `mock:m1` в `/flows`).
  - `lib/journal.ts`: для `mitm_mock_replace`/`mitm_mock_patch` — `body` → `N симв.`, значения `headers`/`setHeaders` через `maskHeaders`,
    `json[].value` → `***`, если последний сегмент `path` — `isSensitiveName`. Расширить существующий `TYPED_ARGS` до карты санитайзеров по имени инструмента.

- [ ] **Step 1: Write the failing tests**: создание `patch` пишет правило и делает `PUT /options` с ним; ответ содержит «уже попадало 1»
  (по фикстуре); `id` существующего — обновляет, а не дублирует; `toggle false` → payload без правила; `delete all` без `confirm` ничего
  не удаляет; при `AddonMissingError` правило сохранено, а ответ — текст ошибки про аддон; журнал: `redactArgs({ name: 'x', body: '{"token":"t"}', headers: { Authorization: 'Bearer a' } }, 'mitm_mock_replace')`
  не содержит `Bearer a` и `"t"`; `tests/mcp-server.test.ts`: с `allowMocks: false` в `tools/list` есть `mitm_hosts`, нет `mitm_mock_patch`, с `true` — есть.
- [ ] **Step 2: Run** `pnpm vitest run tests/mitmproxy.test.ts tests/journal.test.ts tests/mcp-server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** инструменты и санитайзер журнала.
- [ ] **Step 4: Docs** — `docs/connectors.md`: строка таблицы и раздел «mitmproxy» (что умеет, режимы, подключение аддона: скопировать
  `addons/mitmproxy/hub_mocks.py` в `Docker/mitmproxy/scripts/`, добавить `-s /scripts/hub_mocks.py`, у хаба `fw.allow.containers: "mitmweb"`;
  маскировка и «Показывать токены»; моки и что выключение коннектора/моков снимает их); `docs/security.md` — строка «mitmproxy»;
  `README.md` — пункт в «Что умеет» с примерами запросов; `CLAUDE.md` — нюанс: Bearer + XSRF (`_mitmproxy_xsrf` / `X-XSRFToken`), 403 при неверном пароле,
  сверка `hub_mocks` раз в минуту, моки только декларативные.
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:addon` — Expected: всё зелёное.
- [ ] **Step 6: Commit** `git commit -m "mitmproxy: mock tools, journal redaction, docs"`

---

## После плана (вручную, пользователь)

На NAS: положить `hub_mocks.py`, добавить `-s` в `command`, `docker compose up -d` в `Docker/mitmproxy`; хабу `fw.allow.containers: "mitmweb"`;
в админке включить коннектор, задать пароль, «Проверить». Приёмка через Claude: «куда ходило приложение X за 10 минут»,
«подмени ответ … : isPremium true» → приложение показывает подмену → «выключи мок».
