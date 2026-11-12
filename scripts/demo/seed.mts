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
import { setSetting } from '@/lib/settings'
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
// The demo and the README screenshots are English.
setSetting('language', 'en')

// --- Admin with 2FA and a session for the browser ---------------------------------------------

const EMAIL = 'admin@example.com'
const PASSWORD = 'demo password 2026'
const ctx = await getAuth().$context
const admin = await ctx.internalAdapter.createUser({ email: EMAIL, name: 'Admin', emailVerified: true }, { method: 'email-password' })
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

connect('jackett', { baseUrl: 'http://jackett:9117', apiKey: 'demo', minSeeders: 3 }, { ok: true, summary: '4 indexers' })
connect('qbittorrent', { baseUrl: 'http://qbittorrent:8080', authMode: 'none' }, { ok: true, summary: 'qBittorrent v5.2.1', details: ['WebAPI 2.12.1'] })
connect('torrserve', { baseUrl: 'http://torrserve:8090', streamUrl: 'https://tv.example.com' }, { ok: true, summary: 'TorrServe MatriX.136' })
connect('paperless', { baseUrl: 'http://paperless:8000', apiToken: 'demo', webUrl: 'https://docs.example.com' }, { ok: true, summary: '1284 documents' })
connect(
  'files',
  { folders: 'Movies | /files/movies | add\nTV | /files/tv | add\nDocuments | /files/docs | edit\nDownloads | /files/downloads | full' },
  { ok: true, summary: '4 folders' },
)
connect('browser', { baseUrl: 'http://camofox:9377', accessKey: 'demo' }, { ok: true, summary: 'camofox 1.6.2' })
connect('mitmproxy', { baseUrl: 'http://mitmweb:8081', password: 'demo', allowMocks: true }, { ok: true, summary: 'mitmproxy 12.3.0', details: ['hub_mocks addon loaded'] })
connect('prototypes', {}, { ok: true, summary: '3 prototypes' }, 6 * MIN)
connect('scripts', {}, { ok: true, summary: '4 scripts' }, 6 * MIN)
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
  [26 * HOUR, 'hub_status', 'hub', {}, 'Hub v0.15 · 9 connectors', 140],
  [25 * HOUR, 'paperless_review', 'paperless', { scope: 'unlabeled', limit: 20 }, '7 unlabeled documents', 1900],
  [25 * HOUR - 3 * MIN, 'paperless_update', 'paperless', { changes: [{ id: 812 }, { id: 815 }, { id: 816 }] }, 'Updated 3 documents', 1300],
  [22 * HOUR, 'search_torrents', 'jackett', { query: 'Big Buck Bunny', type: 'movie' }, '6 results', 4200],
  [22 * HOUR - MIN, 'torrserve_add', 'torrserve', { result_id: 'r_2' }, 'Added to TorrServe', 1100],
  [20 * HOUR, 'browser_open', 'browser', { url: 'https://news.ycombinator.com' }, 'Hacker News · 30 links', 3800, 'chatgpt'],
  [19 * HOUR, 'mitm_hosts', 'mitmproxy', { minutes: 10 }, '14 hosts', 600],
  [19 * HOUR - 2 * MIN, 'mitm_mock_patch', 'mitmproxy', { host: 'api.example.com', path: '/v1/profile', json: [{ path: 'isPremium', value: true }] }, 'Mock #2 enabled', 500],
  [6 * HOUR, 'files_list', 'files', { path: 'Downloads' }, '18 files', 90],
  [5 * HOUR, 'search_torrents', 'jackett', { query: 'Sintel', type: 'movie', year: 2010 }, '4 results', 3900],
  [5 * HOUR - MIN, 'torrent_add', 'qbittorrent', { result_id: 'r_1', category: 'movies' }, 'Added: Sintel (2010) 1080p', 1200],
  [3 * HOUR, 'torrserve_add', 'torrserve', { result_id: 'r_4' }, { error: 'Timeout 25 s' }, 25_000],
  [2 * HOUR, 'prototype_publish', 'prototypes', { title: 'Istanbul trip plan', html: '<!doctype html>…' }, 'Published', 1100],
  [70 * MIN, 'my_weather', 'scripts', { city: 'Lisbon' }, 'Lisbon: +17°, cloudy', 700],
  [35 * MIN, 'paperless_search', 'paperless', { query: 'insurance', correspondent: 'Allianz' }, '3 documents', 800],
  [14 * MIN, 'torrents_status', 'qbittorrent', { filter: 'active' }, '2 active · 18.4 MB/s', 300],
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
  `<div class="card"><b>Day ${n} · ${title}</b><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`

const trip = await publish({
  title: 'Istanbul trip plan',
  pin: '2468',
  html: page(
    'Istanbul trip plan',
    `<p class="sub">May 12–16 · 2 people</p>${day(1, 'Sultanahmet', ['Hagia Sophia in the morning, before the lines', 'Blue Mosque', 'Lunch: köfte at Sultanahmet Köftecisi'])}${day(2, 'Bosphorus', ['Ferry from Eminönü to Anadolu Kavağı', 'Dinner in Ortaköy'])}${day(3, 'Beyoğlu', ['Galata Tower', 'İstiklal and Karaköy', 'Coffee on a rooftop'])}`,
  ),
})
const shop = await publish({
  title: 'Weekly groceries',
  expiry: '7d',
  html: page(
    'Weekly groceries',
    `<p class="sub">Collected from the recipes of 5 dinners</p>${['Vegetables · tomatoes, zucchini, onion, garlic', 'Meat · chicken 1 kg, ground beef 500 g', 'Dairy · cheese, yogurt, milk', 'Pantry · rice, pasta, chickpeas']
      .map((l) => `<div class="card row"><span>${l.split(' · ')[1]}</span><span class="muted">${l.split(' · ')[0]}</span></div>`)
      .join('')}`,
  ),
})
const mortgage = await publish({
  title: 'Mortgage calculator',
  html: page(
    'Mortgage calculator',
    `<p class="sub">Annuity payment, early repayment</p><div class="card row"><span>Monthly payment</span><b>$2,340</b></div><div class="card row"><span>Total interest</span><b>$251,000</b></div><div class="card row"><span>With $500 extra a month</span><b>−6 years 2 months</b></div>`,
  ),
})
for (const [p, createdAgo, views] of [[trip, 2 * HOUR, 14], [shop, 2 * 24 * HOUR, 6], [mortgage, 9 * 24 * HOUR, 31]] as const) {
  db.update(prototype).set({ createdAt: ago(createdAgo), updatedAt: ago(createdAgo), views, lastViewedAt: ago(createdAgo / 3) }).where(eq(prototype.id, p.id)).run()
}

// --- Scripts ----------------------------------------------------------------------------------

db.insert(scriptSecret)
  .values({ name: 'TELEGRAM_BOT_TOKEN', valueEnc: encryptSecret('demo'), hosts: ['api.telegram.org'], description: 'Notification bot', updatedAt: ago(10 * 24 * HOUR) })
  .run()

const episodes = await createScript({
  name: 'New episodes to Telegram',
  description: 'Every evening looks for new episodes of the watched shows and posts to Telegram',
  schedule: '0 20 * * *',
  code: `const shows = ['Severance', 'The Last of Us']\nfor (const q of shows) {\n  const r = await hub.tool('search_torrents', { query: q, type: 'tv' })\n  log(r)\n}\nawait fetch('https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendMessage', { method: 'POST' })\n`,
})
const disk = await createScript({
  name: 'Disk space',
  description: 'Checks the free space in Downloads every hour',
  schedule: '0 * * * *',
  code: `const r = await hub.tool('files_list', { path: 'Downloads' })\nreturn r\n`,
})
const backup = await createScript({
  name: 'Paperless settings backup',
  description: 'Saves the tags and correspondents to JSON every week',
  schedule: '0 3 * * 1',
  code: `const t = await hub.tool('paperless_taxonomy', {})\nstate.set('last', t)\n`,
})
const weather = await createTool({
  name: 'my_weather',
  description: 'Today\'s weather in a city',
  params: [{ name: 'city', type: 'string', description: 'City', required: true }],
  readOnly: true,
  code: `const r = await fetch('https://wttr.in/' + encodeURIComponent(args.city) + '?format=j1')\nreturn (await r.json()).current_condition[0]\n`,
})
for (const s of [episodes, disk, weather]) {
  approveScript(s.id, s.codeHash)
  setScriptEnabled({ ...s, approvedHash: s.codeHash }, true)
}
recordRun(episodes, 'cron', { ok: true, output: 'New episodes: 1 · message sent', logs: [], durationMs: 5200 })
recordRun(disk, 'cron', { ok: true, output: 'Free 1.2 TB of 4 TB', logs: [], durationMs: 300 })
db.update(script).set({ createdAt: ago(3 * HOUR) }).where(eq(script.id, backup.id)).run()

// --- mitmproxy mocks --------------------------------------------------------------------------

const mocks = [
  { name: 'Premium in the profile', kind: 'patch', match: { host: 'api.example.com', path: '/v1/profile', method: 'GET' }, json: [{ path: 'isPremium', value: true }] },
  { name: 'Empty feed', kind: 'replace', match: { host: 'api.example.com', path: '/v1/feed' }, status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[]}' },
]
mocks.forEach((m, i) => {
  db.insert(mitmMock).values({ id: `m${i + 1}`, name: m.name, enabled: i === 0, ruleJson: JSON.stringify(m), createdAt: ago((i + 1) * 20 * HOUR), updatedAt: ago((i + 1) * 20 * HOUR) }).run()
})

const out = process.env.DEMO_OUT ?? path.dirname(process.env.DATABASE_PATH!)
fs.writeFileSync(path.join(out, 'cookies.json'), JSON.stringify(cookies))
console.log(`seeded; prefix ${DEMO_PREFIX}`)
