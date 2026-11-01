// pnpm demo — seeds a throwaway hub with made-up data, starts it and walks the admin panel in Chromium:
//   docs/screenshots/*.png  pictures for the README (with --screenshots)
//   demo-out/               the static demo for GitHub Pages: rendered pages without scripts, links rewritten
// Needs `pnpm build` first. Never touches a real hub: the database lives in a temp folder.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const PREFIX = 'DemoHubPrefix2026' // same as scripts/demo/seed.mts
const PORT = 3210
const ORIGIN = `http://localhost:${PORT}`
const BASE = (process.env.DEMO_BASE ?? '/home-mcp-hub').replace(/\/$/, '')
const OUT = path.resolve('demo-out')
const SHOTS = path.resolve('docs/screenshots')
const withShots = process.argv.includes('--screenshots')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-demo-'))
const env = {
  ...process.env,
  DATABASE_PATH: path.join(tmp, 'hub.db'),
  // Shown in the sidebar; the server itself still listens on localhost.
  BASE_URL: 'https://hub.example.com',
  HUB_MASTER_KEY: randomBytes(32).toString('hex'),
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  HUB_DEMO: '1',
  LOG_LEVEL: 'warn',
  TZ: 'Europe/Moscow',
}

const seed = spawnSync('node_modules/.bin/tsx', ['scripts/demo/seed.mts'], { env, stdio: 'inherit' })
if (seed.status !== 0) process.exit(1)
const cookies = JSON.parse(fs.readFileSync(path.join(tmp, 'cookies.json'), 'utf8'))

const server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], { env, stdio: ['ignore', 'inherit', 'inherit'] })
const stop = () => server.kill()
process.on('exit', stop)

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${ORIGIN}/${PREFIX}/login`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('the hub did not start')
}

/** Admin path («/admin/connectors/jackett») → path inside the static site («/connectors/jackett/»). */
const staticPath = (adminPath) => `${adminPath.replace(/^\/admin/, '') || ''}/`.replace(/\/+$/, '/')

const assets = new Set()

function toStatic(html) {
  const adminLink = new RegExp(`/${PREFIX}/admin((?:/[^"'?#\\s]*)?)(?:\\?[^"'#\\s]*)?`, 'g')
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*rel="(?:preload|modulepreload)"[^>]*as="script"[^>]*>/g, '')
    .replace(/<link\b[^>]*as="script"[^>]*rel="preload"[^>]*>/g, '')
    .replace(adminLink, (_m, sub) => `${BASE}${staticPath(`/admin${sub}`)}`)
    .replace(new RegExp(`/${PREFIX}/brand/([a-z-]+)`, 'g'), (_m, name) => {
      assets.add(`/${PREFIX}/brand/${name}`)
      return `${BASE}/brand/${name}`
    })
    .replace(/(["'(])\/_next\/static\//g, `$1${BASE}/_next/static/`)
    .replace(
      '</body>',
      `<div style="position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:100;padding:8px 14px;border-radius:999px;background:#7FA7FF;color:#0E1014;font:500 13px system-ui,sans-serif;box-shadow:0 4px 16px #0006">Демо Home MCP Hub: данные выдуманы, кнопки не работают · <a href="https://github.com/Ivan-Kuzmichev/home-mcp-hub" style="color:inherit">GitHub</a></div></body>`,
    )
}

function write(rel, content) {
  const file = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function buildDemo(context) {
  fs.rmSync(OUT, { recursive: true, force: true })
  const page = await context.newPage()
  const queue = ['/admin']
  const seen = new Set(queue)
  while (queue.length) {
    const adminPath = queue.shift()
    await page.goto(`${ORIGIN}/${PREFIX}${adminPath}`, { waitUntil: 'networkidle' })
    const links = await page.$$eval('a[href], iframe[src]', (els) => els.map((e) => e.getAttribute('href') ?? e.getAttribute('src')))
    for (const link of links) {
      const m = link?.match(new RegExp(`^/${PREFIX}(/admin[^?#]*)`))
      if (!m || m[1].endsWith('/export')) continue
      if (!seen.has(m[1])) {
        seen.add(m[1])
        queue.push(m[1])
      }
    }
    if (adminPath.endsWith('/preview')) {
      // Prototype HTML for the sandboxed iframe: served as is.
      write(`${staticPath(adminPath)}index.html`, await (await context.request.get(`${ORIGIN}/${PREFIX}${adminPath}`)).text())
      continue
    }
    write(`${staticPath(adminPath)}index.html`, toStatic(await page.content()))
  }
  for (const asset of assets) {
    const res = await context.request.get(`${ORIGIN}${asset}`)
    write(asset.replace(`/${PREFIX}`, ''), await res.body())
  }
  // Styles and fonts only: the demo has no scripts.
  for (const dir of ['css', 'media']) {
    const from = path.resolve('.next/static', dir)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, '_next/static', dir), { recursive: true })
  }
  // Fonts in the CSS are absolute «/_next/static/media/…»: the site lives under BASE.
  for (const file of fs.readdirSync(path.join(OUT, '_next/static/css'), { recursive: true })) {
    const css = path.join(OUT, '_next/static/css', String(file))
    if (css.endsWith('.css')) fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replaceAll('/_next/static/', `${BASE}/_next/static/`))
  }
  // Links the demo has no page for (CSV export) land here.
  write('404.html', `<!doctype html><meta charset="utf-8"><title>Демо Home MCP Hub</title><body style="background:#0E1014;color:#E8EAF0;font:16px system-ui,sans-serif;padding:48px">В демо этого нет. <a href="${BASE}/" style="color:#7FA7FF">На дашборд</a></body>`)
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '')
  console.log(`demo: ${seen.size} pages in ${path.relative(process.cwd(), OUT)}`)
}

async function shoot(browser, name, adminPath, viewport, scale = 2) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: 'ru-RU', timezoneId: 'Europe/Moscow', colorScheme: 'dark' })
  await context.addCookies(cookies.map((c) => ({ ...c, domain: 'localhost', path: '/', secure: true })))
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/${PREFIX}${adminPath}`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await context.close()
}

async function socialPreview(browser) {
  const shot = fs.readFileSync(path.join(SHOTS, 'desktop-dashboard.png')).toString('base64')
  const logo = fs.readFileSync('docs/logo.png').toString('base64')
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.setContent(`<body style="margin:0;width:1280px;height:640px;overflow:hidden;background:#0E1014;color:#E8EAF0;font-family:system-ui,sans-serif">
    <div style="position:absolute;left:72px;top:150px;width:460px">
      <img src="data:image/png;base64,${logo}" width="72" height="72" style="border-radius:18px">
      <div style="font-size:56px;font-weight:700;margin-top:28px;letter-spacing:-1px">Home MCP Hub</div>
      <div style="font-size:24px;line-height:1.4;color:#9BA3B4;margin-top:16px">Your home services for Claude and ChatGPT: torrents, documents, files, a browser, traffic capture, prototypes and scripts.</div>
    </div>
    <img src="data:image/png;base64,${shot}" style="position:absolute;left:600px;top:80px;width:880px;border-radius:14px;border:1px solid #2A2F3A;box-shadow:0 20px 60px #0008">
  </body>`)
  await page.screenshot({ path: path.join(SHOTS, 'social-preview.png') })
  await context.close()
}

try {
  await waitForServer()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' })
  await context.addCookies(cookies.map((c) => ({ ...c, domain: 'localhost', path: '/', secure: true })))
  await buildDemo(context)
  await context.close()

  if (withShots) {
    fs.mkdirSync(SHOTS, { recursive: true })
    const desktop = { width: 1280, height: 800 }
    const phone = { width: 390, height: 844 }
    await shoot(browser, 'desktop-dashboard', '/admin', desktop)
    await shoot(browser, 'desktop-connector', '/admin/connectors/mitmproxy', desktop)
    await shoot(browser, 'desktop-activity', '/admin/activity', desktop)
    await shoot(browser, 'desktop-scripts', '/admin/scripts', desktop)
    await shoot(browser, 'phone-dashboard', '/admin', phone, 3)
    await shoot(browser, 'phone-prototypes', '/admin/prototypes', phone, 3)
    await shoot(browser, 'phone-access', '/admin/access', phone, 3)
    await socialPreview(browser)
    console.log(`screenshots: ${path.relative(process.cwd(), SHOTS)}`)
  }
  await browser.close()
} finally {
  stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}
