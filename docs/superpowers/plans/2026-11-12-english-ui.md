# Хаб на английском — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** весь хаб — админка, служебные страницы, всё, что видит модель, аддон mitmproxy — говорит на языке из настройки (en/ru), по умолчанию английский, в том числе после обновления существующей установки (миграции нет).

**Architecture:** свой модуль `lib/i18n` без библиотек, в стиле gettext: **в коде — английский текст, он же ключ**, русский лежит в каталоге
`ru.ts` рядом с кодом (в папке коннектора, страницы, компонента), куда исходные русские строки переносятся копированием. Динамические строки — тег `t\`…\``,
статические (подписи полей, описания инструментов и параметров) переводятся там, где их отдают наружу (`describeFields`, регистрация MCP, «Диагностика»). Язык — строка `language` в `setting`,
читается на сервере на каждый запрос; клиентские компоненты получают его из контекста.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, zod 4, `@modelcontextprotocol/server` 2.x, better-sqlite3/Drizzle, vitest, Playwright (демо), Python unittest (аддон).

**Spec:** `docs/superpowers/specs/2026-11-12-english-ui-design.md`

## Global Constraints

- Русские тексты не меняются ни на байт: в режиме `ru` `t`/`tr`/`plural` возвращают ровно то, что было в коде до перевода. Русскую строку переносить в `ru.ts`
  копированием (скриптом или выделением из исходника), никогда не перепечатывать. Существующие тесты с русскими строками не правятся — они и есть проверка.
- Не меняются имена инструментов, параметров, полей конфигурации, ключи `setting` и id — меняются только тексты.
- Язык: `'en' | 'ru'`, одна настройка на хаб (`setting.language`). Нет строки → `en`. Миграции нет: после обновления язык выбирают в настройках.
- Не переводится пользовательское: правила разметки, свои инструкции коннекторов, «Свой initialize», код и описания скриптов и `my_*`, заметки, имена тегов; записанное в журнал и историю запусков.
- Английский для модели не длиннее русского по смыслу: коротко, для телефона. Термины — как в интерфейсах сервисов (torrent, seed, tag, label).
- Никаких i18n-библиотек; новых зависимостей нет.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:addon` проходят после каждой задачи.

## Review Focus

1. **Сохранённая конфигурация Jackett без нового поля** открывается в форме и работает: поле показывает `en`, поиск не падает. Тест в задаче 5.
2. **Неизвестное значение `setting.language`** (руками в базе, будущий язык) — хаб работает на `en`, переключатель показывает English. Тест в задаче 2.
3. **Смена языка посреди работы:** уже открытый чат получает ответы инструментов на новом языке, новый — новые описания; кэш MCP-обработчика пересобирается. Тест в задаче 2.
4. **Старый аддон mitmproxy без поля `lang`** и старые потоки с меткой `mock:<id> (json пропущен)` — хаб не падает и показывает попадания. Тест в задаче 9.
5. **Переменная `HUB_LANG` выставлена** (тесты, демо) — переключатель в настройках не должен делать вид, что работает. Тест в задаче 2.

---

### Task 1: Ядро i18n

**Files:**
- Create: `lib/i18n/lang.ts`, `lib/i18n/t.ts`, `lib/i18n/catalog.ts`, `lib/i18n/index.ts`
- Create: `tests/setup.ts`; Modify: `vitest.config.ts` (`setupFiles: ['tests/setup.ts']`)
- Modify: `lib/connectors/format.ts` (`plural` переезжает в `lib/i18n`, здесь — реэкспорт, импорты по проекту не трогать), `lib/format.ts`
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Produces:
  - `type Lang = 'en' | 'ru'`; `getLang(): Lang` — порядок: `runWithLang` (AsyncLocalStorage) → `process.env.HUB_LANG` (если `en`/`ru`) → `setting.language` (кэш в памяти, сбрасывается `setLang`) → `'en'`.
  - `setLang(lang: Lang): void`, `runWithLang<T>(lang: Lang, fn: () => T): T`, `langFromEnv(): Lang | null`.
  - `t(strings: TemplateStringsArray, ...values: unknown[]): string` — ключ каталога = части шаблона, склеенные через `{0}`, `{1}`… (`t\`Found ${n} ${w}:\`` → ключ `Found {0} {1}:`); в `en` — обычная интерполяция, в `ru` — шаблон из каталога (порядок `{n}` может отличаться).
  - `tr(text: string): string` — перевод статической строки; в `en` — тот же текст; нет ключа в `ru` → английский как есть и запись в `missingKeys()`.
  - `plural(n: number, forms: [string, string]): string` — в `en` `[one, other]`; в `ru` — три формы из каталога по ключу `forms[0]`, правило — нынешний русский `plural`.
  - `missingKeys(): string[]` — ключи, которых не нашлось в `ru`-каталоге с запуска; для тестов покрытия.
  - `localeTag(): 'en-US' | 'ru-RU'`.
  - `registerCatalog(entries: Record<string, string>, plurals?: Record<string, [string, string, string]>): void`; `lib/i18n/catalog.ts` импортирует все `ru.ts` проекта по одной строке (как `registry.ts`), `index.ts` реэкспортирует API и импортирует `catalog.ts`.
  - `findCyrillic(text: string): string | null` — первая подстрока с кириллицей или `null`; для тестов покрытия английского режима.

- [ ] **Step 1: Тесты** — `tests/i18n.test.ts`:
  - `runWithLang('en', () => t\`Found ${3} ${plural(3, ['document', 'documents'])}:\`)` === `'Found 3 documents:'`, `plural(1, …)` → `'document'`, `plural(0, …)` → `'documents'`;
  - с каталогом `{'Found {0} {1}:': 'Найдено {0} {1}:'}` и plural `{document: ['документ', 'документа', 'документов']}` в `ru` → `'Найдено 3 документа:'`, для 21 — `документ`, для 11 — `документов`;
  - `tr('No key')` в `ru` → `'No key'` и `missingKeys()` содержит `'No key'`; `findCyrillic('ok Привет')` → `'Привет'`;
  - `formatAgo` / `formatWhen` / `formatSize` / `formatEta` в `en`: `'just now'`, `'3 min ago'`, `'2 h ago'`, `'yesterday 21:40'`, `'today 09:14'`, `'1.5 MB'`, `'2 h 5 min'`, `'3 d 4 h'`; в `ru` — прежние значения.
- [ ] **Step 2:** `pnpm vitest run tests/i18n.test.ts` — FAIL (нет модуля).
- [ ] **Step 3:** реализовать модуль; `tests/setup.ts` ставит `process.env.HUB_LANG = 'ru'`, чтобы весь прежний набор тестов шёл на русском. Форматтеры берут `localeTag()` и строки через `t`/`tr` при вызове (никаких `Intl` на уровне модуля).
- [ ] **Step 4:** `pnpm vitest run tests/i18n.test.ts` и `pnpm test` — PASS.
- [ ] **Step 5:** commit `i18n: core module, bilingual formatting`.

### Task 2: Настройка языка, переключатель, MCP, `<html lang>`

**Files:**
- Modify: `lib/settings.ts`, `app/layout.tsx`, `app/admin/settings/page.tsx`, `app/admin/settings/actions.ts`
- Create: `components/settings/language-form.tsx`, `components/i18n-provider.tsx` (`LangProvider`, `useT()` для клиентских компонентов)
- Test: `tests/language.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: server action `setLanguageAction(lang: Lang)`; `LangProvider({ lang })` в корневом layout и `useT(): { t, tr, plural, lang }` — тот же API, что на сервере, язык из контекста.

- [ ] **Step 1: Тесты:**
  - пустая база → `getLang()` === `'en'`; `setLang('ru')` → `'ru'`; `setting.language = 'de'` → `'en'` (Review Focus 2);
  - после `setLang('en')` текст `instructions` MCP — английский и обработчик пересобран (`getMcpHandler()` возвращает новый объект), после `setLang('ru')` — снова русский (Review Focus 3);
  - при `HUB_LANG` в env страница/компонент получает `langFromEnv()`, а `setLanguageAction` отвечает ошибкой «language is fixed by HUB_LANG» (Review Focus 5).
- [ ] **Step 2:** запуск — FAIL.
- [ ] **Step 3:** реализовать. Переключатель «English / Русский» на «Настройки»; под ним — предупреждение (на текущем языке): скрипты, разбирающие текст ответов `hub.tool`, могут сломаться; описания инструментов обновятся в новом чате. `<html lang={getLang()}>`.
- [ ] **Step 4:** тесты — PASS; `pnpm test` — PASS.
- [ ] **Step 5:** commit `i18n: language setting, migration for existing installs, switch`.

### Task 3: Перевод метаданных коннекторов и схем

**Files:**
- Modify: `lib/connectors/form.ts` (`describeFields`, `describeTools`), `lib/connectors/types.ts`, `lib/mcp/server.ts` (регистрация инструментов, `inputSchemaOf` для `my_*` не трогать — это текст пользователя), `app/admin/diagnostics/page.tsx`
- Create: `lib/i18n/schema.ts`
- Test: `tests/i18n-schema.test.ts`

**Interfaces:**
- Produces:
  - `localizeSchema<S extends z.ZodObject>(schema: S): S` — копия схемы, где все `description` (включая вложенные массивы и объекты) пропущены через `tr`; кэш на пару (схема, язык). Валидация та же.
  - Подписи полей (`label`, `help`, `placeholder`, `options[].label|short|help`), `title`/`description` инструментов — через `tr` в местах выдачи.
  - Сообщения zod в `configSchema` и `inputSchema` с текстом — в форме `{ error: () => t\`…\` }` (вычисляются при разборе, а не при загрузке модуля). Правило для задач 4–10.

- [ ] **Step 1: Тест** на тестовом коннекторе с каталогом: в `en` `describeFields` отдаёт английские подписи, `z.toJSONSchema(localizeSchema(s))` не содержит кириллицы, ошибка `parseConfig` — английская; в `ru` всё побайтно прежнее.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS, `pnpm test` PASS.
- [ ] **Step 5:** commit `i18n: localized connector metadata and tool schemas`.

### Задачи 4–10: перевод модулей

Общий порядок для каждой (дальше не повторяется):
1. Каждую русскую строку модуля перенести копированием в `ru.ts` в папке модуля (ключ — английский перевод), строка импорта — в `lib/i18n/catalog.ts`.
   В коде — английский: в выражениях `t\`…\``, в статике — простая строка (её переведёт задача 3), сообщения zod — функцией. Комментарии и так английские.
2. Тест в `tests/<модуль>.test.ts` (новый `describe('… in English')`): внутри `runWithLang('en', …)` — метаданные модуля без кириллицы (`findCyrillic` по `describeFields`, `title`, `description`, `z.toJSONSchema(localizeSchema(inputSchema))`, `instructions(...)`) и 2–3 характерных ответа инструментов на английском с точным текстом, включая одну ошибку `ToolError`.
3. Тот же набор метаданных в `ru` даёт пустой `missingKeys()` для ключей модуля.
4. `pnpm test` — прежние русские тесты зелёные без правок. Упавший русский тест = ошибка переноса в `ru.ts`, чинить каталог, а не тест.
5. Commit `i18n: <module>`.

### Task 4: Общие сервисные тексты и MCP-сервер
**Files:** `lib/connectors/http.ts`, `lib/connectors/health.ts`, `lib/connectors/summary.ts`, `lib/connectors/instructions.ts`, `lib/connectors/torrents.ts`, `lib/connectors/resolve.ts`, `lib/mcp/server.ts` (тексты `hub_status`, `hub_guide`, стартовый текст «Свой initialize», ошибки), `lib/prototypes/http.ts` и вызовы `simplePage`, `app/f/[token]/route.ts`, `app/p/**`, `app/not-found.tsx`; каталог — `lib/i18n/ru/common.ts`.
Тест: `'X did not respond in 30 s'` для `serviceFetch`, `hub_guide` и `/f/{token}` (404, 410) без кириллицы в `en`.

### Task 5: Jackett и язык озвучки
**Files:** `lib/connectors/jackett/{index,search,parse}.ts`, `lib/connectors/jackett/ru.ts`.
- Поле `audioLanguage` (`field(z.string()…, { label: 'Preferred audio language', section: 'defaults' })`, по-русски — «Предпочитаемый язык озвучки»), допустимые коды: `en, ru, uk, de, fr, es, it, pl`; другое — ошибка со списком.
- По умолчанию в схеме `en`, миграции нет: сохранённая конфигурация без поля получает `en` (Review Focus 1).
- `hasRussianAudio` → `detectAudio(title: string): Set<AudioLang>`; русская логика без изменений, для `uk, de, fr, es, it, pl` — типичные метки релизов (например `UKR`/`Ukr`, `GERMAN`/`German DL`, `FRENCH`/`VFF`/`TRUEFRENCH`, `SPANISH`/`Castellano`/`Latino`, `ITALIAN`/`ITA`, `POLISH`/`PLDUB`/`Lektor PL`); `en` — без приоритета.
- `search_torrents.language`: строка — код из списка или `any`; по умолчанию — `audioLanguage` из настроек; `ru` работает как раньше; `rank()` принимает код.
- Тесты: прежние русские; `detectAudio` по 2 названия на язык; `rank` с `de` ставит немецкие выше; с `en` — только по сидам; старая конфигурация без `audioLanguage` разбирается и даёт `en`.

### Task 6: qBittorrent, Transmission, TorrServe
**Files:** `lib/connectors/{qbittorrent,transmission,torrserve}/*`, по `ru.ts` в каждой папке.

### Task 7: Paperless и Papra
**Files:** `lib/connectors/{paperless,papra}/*` (+ `ru.ts`). Сравнение имён тегов (`toLocaleLowerCase('ru')` в `paperless/logic.ts`) — через `localeTag()`; тест: в `en` тег `Банк` находится по `банк`.

### Task 8: Файлы и браузер
**Files:** `lib/connectors/{files,browser}/*` (+ `ru.ts`). Сортировка `files_list` — `localeCompare(b, localeTag())`; тест порядка `['Downloads', 'Документы', 'apple']` в обоих языках (ожидаемый порядок — фактический результат `Intl.Collator` для локали, зафиксированный в тесте).

### Task 9: mitmproxy и аддон
**Files:** `lib/connectors/mitmproxy/*` (+ `ru.ts`), `addons/mitmproxy/hub_mocks.py`, `addons/mitmproxy/test_hub_mocks.py`.
- Хаб кладёт `lang` в опцию `hub_mocks`: `{allowed, rules, lang}`. Аддон выбирает тексты по `lang`, без поля — русский (как сейчас).
- Метка `mock:<id> (json пропущен)` не меняется; `MOCK_COMMENT` в `flows.ts` не трогать.
- Тесты: Python — `lang: 'en'` даёт `No mocks.`, без `lang` — `Моков нет.`; TS — `syncMocks` шлёт `lang`; поток со старой меткой распознаётся в `en` (Review Focus 4). `pnpm test:addon` PASS.

### Task 10: Скрипты и прототипы (коннекторы и песочница)
**Files:** `lib/connectors/{scripts,prototypes}/*`, `lib/scripts/{sandbox,store,limits,tool-spec,secrets,net}.ts`, `lib/prototypes/*` (+ `ru.ts`). `SANDBOX_API_DOC` — через `tr` при выдаче описаний.

### Task 11: Админка, вход, служебные клиентские экраны
**Files:** все `app/admin/**`, `app/(public)/**`, `app/[secret]/**`, `components/**` (серверные — `t`/`tr`, клиентские — `useT()`), каталоги `ru.ts` рядом (`app/admin/ru.ts`, `components/ru.ts` или по папкам).
- Проверка — в задаче 12 (сканер демо), здесь: `pnpm build` проходит, тест `tests/i18n-coverage.test.ts` пока не включён.
- Commit по разделам: `connectors`, `access/activity/diagnostics`, `settings/more`, `scripts/prototypes`, `auth`.

### Task 12: Покрытие, демо, скриншоты

**Files:**
- Create: `tests/i18n-coverage.test.ts`
- Modify: `scripts/demo/seed.mts` (все выдуманные данные — на английском: документы, теги, торренты, скрипты, журнал, прототипы; `setSetting('language', 'en')`), `scripts/demo/capture.mjs`
- Regenerate: `docs/screenshots/*.png` (включая `social-preview.png`), статическое демо

- [ ] **Step 1: Тест покрытия:** для каждого коннектора из `CONNECTORS` в `en` — `describeFields`, `describeTools`, `title`/`description` всех инструментов, `localizeSchema` → JSON Schema, `instructions(defaultConfig, { tools: all })` — `findCyrillic` === `null`; то же в `ru` — `missingKeys()` пуст.
- [ ] **Step 2:** `capture.mjs`: после обхода страниц собрать видимый текст каждой и упасть со списком «страница → кириллица», если она есть (демо-данные английские, так что любая кириллица — непереведённый текст).
  Плюс второй проход того же демо с `HUB_LANG=ru` без скриншотов: сервер пишет в лог каждый ключ из `missingKeys()`, проход падает, если они есть.
- [ ] **Step 3:** `pnpm build && pnpm screenshots && pnpm demo` — без ошибок сканера; глазами проверить 6 скриншотов.
- [ ] **Step 4:** commit `demo: English data, screenshots and static demo`.

### Task 13: Документация

**Files:** `README.md`, `README.ru.md`, `docs/*.md`, `docs/*.ru.md`, `CLAUDE.md`.
- EN-документы называют элементы интерфейса английскими подписями (убрать «**Коннекторы** (Connectors)» и подобные пары), RU — русскими.
- Заметки к релизу (тело аннотированного тега или правка GitHub Release после публикации): «After updating, pick the language in Settings; Russian users: also set the Jackett audio language to `ru`», по-русски — то же.
- Описать: настройку языка и что меняется сразу/в новом чате; предупреждение про скрипты; `HUB_LANG` (для тестов и демо); поле озвучки Jackett; что аддон mitmproxy нужно обновить ради английского.
- `CLAUDE.md`: правило «Тексты интерфейса на русском» → «на двух языках: в коде — английский (он же ключ), русский — в `ru.ts` рядом; `t`/`tr`/`plural` из `lib/i18n`; новый текст без перевода ловит `tests/i18n-coverage.test.ts`»; раздел про Jackett — язык озвучки.
- Финальная проверка: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:addon && pnpm build`.
- Commit `docs: language setting, English UI labels`.
