// Fills an empty hub database with made-up data for the README screenshots and the static demo.
// Run by scripts/demo/capture.mjs with DATABASE_PATH pointing at a temp folder; never at a real hub.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getAuth } from '@/lib/auth'
import { getConnector } from '@/lib/connectors/registry'
import { recordCheck, saveConfig, setDisabledTools } from '@/lib/connectors/store'
import { encryptSecret } from '@/lib/crypto'
import { getDb } from '@/lib/db'
import { mitmMock, prototype, script, scriptSecret, toolCall } from '@/lib/db/schema'
import { oauthClient, oauthConsent, oauthRefreshToken, user } from '@/lib/db/auth-schema'
import { redactArgs, summarize } from '@/lib/journal'
import { savePrefix } from '@/lib/prefix'
import { publish } from '@/lib/prototypes/store'
import { approveScript, createScript, createTool, recordRun, setScriptEnabled } from '@/lib/scripts/store'

export const DEMO_PREFIX = 'DemoHubPrefix2026'

const MIN = 60_000
const HOUR = 60 * MIN
const now = Date.now()
const ago = (ms: number) => new Date(now - ms)

const db = getDb()
migrate(db, { migrationsFolder: path.join(process.cwd(), 'lib/db/migrations') })
savePrefix(DEMO_PREFIX)

// --- Admin with 2FA and a session for the browser ---------------------------------------------

const EMAIL = 'admin@example.com'
const PASSWORD = 'demo password 2026'
const ctx = await getAuth().$context
const admin = await ctx.internalAdapter.createUser({ email: EMAIL, name: 'Админ', emailVerified: true }, { method: 'email-password' })
await ctx.internalAdapter.linkAccount({ userId: admin.id, providerId: 'credential', accountId: admin.id, password: await ctx.password.hash(PASSWORD) })
const signIn = await getAuth().api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, asResponse: true })
const cookies = signIn.headers.getSetCookie().map((c) => {
  const [pair] = c.split(';')
  const i = pair!.indexOf('=')
  return { name: pair!.slice(0, i), value: pair!.slice(i + 1) }
})
// Signed in first, then 2FA on: better-auth would otherwise ask for the code.
db.update(user).set({ twoFactorEnabled: true }).where(eq(user.id, admin.id)).run()

// --- Connectors -------------------------------------------------------------------------------

function connect(id: string, raw: Record<string, unknown>, check: { ok: boolean; summary: string; details?: string[] }, checkedAgo = 2 * MIN): void {
  const c = getConnector(id)
  if (!c) throw new Error(`no connector ${id}`)
  const parsed = c.parseConfig(raw)
  if (!parsed.ok) throw new Error(`${id}: ${JSON.stringify(parsed.errors)}`)
  saveConfig(c, parsed.config as Record<string, unknown>)
  recordCheck(id, { ok: check.ok, summary: check.summary, details: check.details ?? [] })
  db.run(`UPDATE connector SET last_check_at = ${now - checkedAgo} WHERE id = '${id}'`)
}

connect('jackett', { baseUrl: 'http://jackett:9117', apiKey: 'demo', minSeeders: 3 }, { ok: true, summary: '4 индексатора' })
connect('qbittorrent', { baseUrl: 'http://qbittorrent:8080', authMode: 'none' }, { ok: true, summary: 'qBittorrent v5.2.1', details: ['WebAPI 2.12.1'] })
connect('torrserve', { baseUrl: 'http://torrserve:8090', streamUrl: 'https://tv.example.com' }, { ok: true, summary: 'TorrServe MatriX.136' })
connect('paperless', { baseUrl: 'http://paperless:8000', apiToken: 'demo', webUrl: 'https://docs.example.com' }, { ok: true, summary: '1284 документа' })
connect(
  'files',
  { folders: 'Фильмы | /files/movies | add\nСериалы | /files/tv | add\nДокументы | /files/docs | edit\nЗагрузки | /files/downloads | full' },
  { ok: true, summary: '4 папки' },
)
connect('browser', { baseUrl: 'http://camofox:9377', accessKey: 'demo' }, { ok: true, summary: 'camofox 1.6.2' })
connect('mitmproxy', { baseUrl: 'http://mitmweb:8081', password: 'demo', allowMocks: true }, { ok: true, summary: 'mitmproxy 12.3.0', details: ['аддон hub_mocks подключён'] })
connect('prototypes', {}, { ok: true, summary: '3 прототипа' }, 6 * MIN)
connect('scripts', {}, { ok: true, summary: '4 скрипта' }, 6 * MIN)
setDisabledTools('qbittorrent', ['torrent_delete'])

// --- OAuth clients: Claude and ChatGPT are connected ----------------------------------------------

function client(name: string, redirect: string, connectedAgo: number): string {
  const clientId = randomUUID().replaceAll('-', '')
  const created = ago(connectedAgo)
  db.insert(oauthClient).values({ id: randomUUID(), clientId, name, redirectUris: [redirect], createdAt: created, updatedAt: created, tokenEndpointAuthMethod: 'none', requirePKCE: true }).run()
  db.insert(oauthConsent).values({ id: randomUUID(), clientId, userId: admin.id, scopes: ['openid', 'offline_access'], createdAt: created, updatedAt: created }).run()
  db.insert(oauthRefreshToken)
    .values({ id: randomUUID(), token: randomUUID(), clientId, userId: admin.id, scopes: ['openid', 'offline_access'], createdAt: created, expiresAt: new Date(now + 30 * 24 * HOUR) })
    .run()
  return clientId
}

const claude = client('Claude', 'https://claude.ai/api/mcp/auth_callback', 12 * 24 * HOUR)
const chatgpt = client('ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect', 3 * 24 * HOUR)

// --- Journal ----------------------------------------------------------------------------------

type Call = [agoMs: number, tool: string, connectorId: string, args: unknown, result: string | { error: string }, ms: number, who?: string]

const calls: Call[] = [
  [26 * HOUR, 'hub_status', 'hub', {}, 'Хаб v0.15 · 9 коннекторов', 140],
  [25 * HOUR, 'paperless_review', 'paperless', { scope: 'unlabeled', limit: 20 }, '7 неразмеченных документов', 1900],
  [25 * HOUR - 3 * MIN, 'paperless_update', 'paperless', { changes: [{ id: 812 }, { id: 815 }, { id: 816 }] }, 'Изменено 3 документа', 1300],
  [22 * HOUR, 'search_torrents', 'jackett', { query: 'Big Buck Bunny', type: 'movie' }, '6 результатов', 4200],
  [22 * HOUR - MIN, 'torrserve_add', 'torrserve', { result_id: 'r_2' }, 'Добавлено в TorrServe', 1100],
  [20 * HOUR, 'browser_open', 'browser', { url: 'https://news.ycombinator.com' }, 'Hacker News · 30 ссылок', 3800, 'chatgpt'],
  [19 * HOUR, 'mitm_hosts', 'mitmproxy', { minutes: 10 }, '14 хостов', 600],
  [19 * HOUR - 2 * MIN, 'mitm_mock_patch', 'mitmproxy', { host: 'api.example.com', path: '/v1/profile', json: [{ path: 'isPremium', value: true }] }, 'Мок #2 включён', 500],
  [6 * HOUR, 'files_list', 'files', { path: 'Загрузки' }, '18 файлов', 90],
  [5 * HOUR, 'search_torrents', 'jackett', { query: 'Sintel', type: 'movie', year: 2010 }, '4 результата', 3900],
  [5 * HOUR - MIN, 'torrent_add', 'qbittorrent', { result_id: 'r_1', category: 'movies' }, 'Добавлено: Sintel (2010) 1080p', 1200],
  [3 * HOUR, 'torrserve_add', 'torrserve', { result_id: 'r_4' }, { error: 'Таймаут 25 с' }, 25_000],
  [2 * HOUR, 'prototype_publish', 'prototypes', { title: 'План поездки в Стамбул', html: '<!doctype html>…' }, 'Опубликовано', 1100],
  [70 * MIN, 'my_weather', 'scripts', { city: 'Москва' }, 'Москва: +4°, облачно', 700],
  [35 * MIN, 'paperless_search', 'paperless', { query: 'страховка', correspondent: 'Ингосстрах' }, '3 документа', 800],
  [14 * MIN, 'torrents_status', 'qbittorrent', { filter: 'active' }, '2 активных · 18,4 МБ/с', 300],
]

for (const [agoMs, tool, connectorId, args, result, ms, who] of calls) {
  const failed = typeof result === 'object'
  db.insert(toolCall)
    .values({
      tool,
      connectorId,
      argsRedacted: redactArgs(args, tool),
      ok: !failed,
      resultSummary: failed ? null : summarize(result),
      error: failed ? result.error : null,
      durationMs: ms,
      clientId: who === 'chatgpt' ? chatgpt : claude,
      ip: '172.18.0.1',
      createdAt: ago(agoMs),
    })
    .run()
}
db.insert(toolCall)
  .values({ tool: 'auth.second_factor', connectorId: 'auth', argsRedacted: 'admin@example.com', ok: true, resultSummary: null, error: null, durationMs: null, ip: '192.168.1.20', createdAt: ago(40 * MIN) })
  .run()

// --- Prototypes -------------------------------------------------------------------------------

const page = (title: string, body: string) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f6f4ef;color:#1d1b16}main{max-width:720px;margin:0 auto;padding:32px 20px}h1{font-size:28px;margin:0 0 4px}p.sub{color:#6b665c;margin:0 0 24px}
.card{background:#fff;border-radius:14px;padding:16px 18px;margin:0 0 12px;box-shadow:0 1px 2px #0001}.card b{display:block}.muted{color:#6b665c;font-size:13px}.row{display:flex;justify-content:space-between;gap:12px}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`

const day = (n: number, title: string, items: string[]) =>
  `<div class="card"><b>День ${n} · ${title}</b><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`

const trip = await publish({
  title: 'План поездки в Стамбул',
  pin: '2468',
  html: page(
    'План поездки в Стамбул',
    `<p class="sub">12–16 мая · 2 человека</p>${day(1, 'Султанахмет', ['Айя-София утром, до очередей', 'Голубая мечеть', 'Обед: кёфте в Sultanahmet Köftecisi'])}${day(2, 'Босфор', ['Паром от Эминёню до Анадолу Кавагы', 'Ужин в Ортакёе'])}${day(3, 'Бейоглу', ['Галатская башня', 'Истикляль и Карабаш', 'Кофе на крыше'])}`,
  ),
})
const shop = await publish({
  title: 'Покупки на неделю',
  expiry: '7d',
  html: page(
    'Покупки на неделю',
    `<p class="sub">Собрано из рецептов на 5 ужинов</p>${['Овощи · томаты, цукини, лук, чеснок', 'Мясо · курица 1 кг, фарш 500 г', 'Молочное · сыр, йогурт, молоко', 'Бакалея · рис, паста, нут']
      .map((l) => `<div class="card row"><span>${l.split(' · ')[1]}</span><span class="muted">${l.split(' · ')[0]}</span></div>`)
      .join('')}`,
  ),
})
const mortgage = await publish({
  title: 'Калькулятор ипотеки',
  html: page(
    'Калькулятор ипотеки',
    `<p class="sub">Аннуитетный платёж, досрочное погашение</p><div class="card row"><span>Платёж в месяц</span><b>87 340 ₽</b></div><div class="card row"><span>Переплата</span><b>9,4 млн ₽</b></div><div class="card row"><span>С досрочным 20 000 ₽ в месяц</span><b>−6 лет 2 мес.</b></div>`,
  ),
})
for (const [p, createdAgo, views] of [[trip, 2 * HOUR, 14], [shop, 2 * 24 * HOUR, 6], [mortgage, 9 * 24 * HOUR, 31]] as const) {
  db.update(prototype).set({ createdAt: ago(createdAgo), updatedAt: ago(createdAgo), views, lastViewedAt: ago(createdAgo / 3) }).where(eq(prototype.id, p.id)).run()
}

// --- Scripts ----------------------------------------------------------------------------------

db.insert(scriptSecret)
  .values({ name: 'TELEGRAM_BOT_TOKEN', valueEnc: encryptSecret('demo'), hosts: ['api.telegram.org'], description: 'Бот для уведомлений', updatedAt: ago(10 * 24 * HOUR) })
  .run()

const episodes = await createScript({
  name: 'Новые серии в Telegram',
  description: 'Каждый вечер ищет новые серии отслеживаемых сериалов и пишет в Telegram',
  schedule: '0 20 * * *',
  code: `const shows = ['Severance', 'The Last of Us']\nfor (const q of shows) {\n  const r = await hub.tool('search_torrents', { query: q, type: 'tv' })\n  log(r)\n}\nawait fetch('https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendMessage', { method: 'POST' })\n`,
})
const disk = await createScript({
  name: 'Место на диске',
  description: 'Раз в час проверяет свободное место в «Загрузках»',
  schedule: '0 * * * *',
  code: `const r = await hub.tool('files_list', { path: 'Загрузки' })\nreturn r\n`,
})
const backup = await createScript({
  name: 'Бэкап настроек Paperless',
  description: 'Еженедельно сохраняет теги и корреспондентов в JSON',
  schedule: '0 3 * * 1',
  code: `const t = await hub.tool('paperless_taxonomy', {})\nstate.set('last', t)\n`,
})
const weather = await createTool({
  name: 'my_weather',
  description: 'Погода в городе на сегодня',
  params: [{ name: 'city', type: 'string', description: 'Город', required: true }],
  readOnly: true,
  code: `const r = await fetch('https://wttr.in/' + encodeURIComponent(args.city) + '?format=j1')\nreturn (await r.json()).current_condition[0]\n`,
})
for (const s of [episodes, disk, weather]) {
  approveScript(s.id, s.codeHash)
  setScriptEnabled({ ...s, approvedHash: s.codeHash }, true)
}
recordRun(episodes, 'cron', { ok: true, output: 'Новых серий: 1 · сообщение отправлено', logs: [], durationMs: 5200 })
recordRun(disk, 'cron', { ok: true, output: 'Свободно 1,2 ТБ из 4 ТБ', logs: [], durationMs: 300 })
db.update(script).set({ createdAt: ago(3 * HOUR) }).where(eq(script.id, backup.id)).run()

// --- mitmproxy mocks --------------------------------------------------------------------------

const mocks = [
  { name: 'Премиум в профиле', kind: 'patch', match: { host: 'api.example.com', path: '/v1/profile', method: 'GET' }, json: [{ path: 'isPremium', value: true }] },
  { name: 'Пустая лента', kind: 'replace', match: { host: 'api.example.com', path: '/v1/feed' }, status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[]}' },
]
mocks.forEach((m, i) => {
  db.insert(mitmMock).values({ id: `m${i + 1}`, name: m.name, enabled: i === 0, ruleJson: JSON.stringify(m), createdAt: ago((i + 1) * 20 * HOUR), updatedAt: ago((i + 1) * 20 * HOUR) }).run()
})

const out = process.env.DEMO_OUT ?? path.dirname(process.env.DATABASE_PATH!)
fs.writeFileSync(path.join(out, 'cookies.json'), JSON.stringify(cookies))
console.log(`seeded; prefix ${DEMO_PREFIX}`)
