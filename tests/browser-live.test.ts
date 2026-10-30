import { describe, expect, it } from 'vitest'
import { browser } from '@/lib/connectors/browser'
import { TAB_GONE } from '@/lib/connectors/browser/client'
import { configOf, runTool, runToolRaw } from './helpers'

// Against a real camofox: CAMOFOX_URL=http://localhost:9377 CAMOFOX_ACCESS_KEY=… pnpm vitest run tests/browser-live.test.ts
const url = process.env.CAMOFOX_URL
const cfg = () => configOf(browser, { baseUrl: url, accessKey: process.env.CAMOFOX_ACCESS_KEY, allowActions: true, userId: 'hub-test', timeoutSec: 60 })
const tabOf = (text: string) => /^tab: (\S+)/.exec(text)![1]!

describe.skipIf(!url)('camofox live', { timeout: 120_000 }, () => {
  it('open → snapshot → click by ref → snapshot', async () => {
    const opened = await runTool(browser, 'browser_open', cfg(), { url: 'https://example.com/' })
    expect(opened).toContain('Example Domain')
    const tab = tabOf(opened)
    const ref = /\[(e\d+)\]/.exec(opened.split('\n').find((l) => l.includes('link')) ?? '')?.[1]
    expect(ref).toBeDefined()
    const after = await runTool(browser, 'browser_act', cfg(), { tab, action: 'click', ref })
    expect(after).toMatch(/URL: https:\/\/www\.iana\.org\//)
    await runTool(browser, 'browser_close', cfg(), { tab })
  })

  it('screenshot is a PNG, extract follows the schema', async () => {
    const opened = await runTool(browser, 'browser_open', cfg(), { url: 'https://example.com/' })
    const tab = tabOf(opened)
    const shot = await runToolRaw(browser, 'browser_screenshot', cfg(), { tab })
    const img = typeof shot === 'object' ? shot.images?.[0] : undefined
    expect(Buffer.from(img!.data, 'base64').subarray(1, 4).toString()).toBe('PNG')

    const ref = /heading "Example Domain"[^\n]*\[(e\d+)\]/.exec(opened)?.[1]
    const data = JSON.parse(await runTool(browser, 'browser_extract', cfg(), { tab, schema: { type: 'object', properties: { title: { type: 'string', 'x-ref': ref } } } }))
    expect(data.title).toContain('Example Domain')
    await runTool(browser, 'browser_close', cfg(), { tab })

    await expect(runTool(browser, 'browser_snapshot', cfg(), { tab })).rejects.toThrow(TAB_GONE)
  })

  it('YouTube transcript of a public video', async () => {
    const text = await runTool(browser, 'browser_youtube_transcript', cfg(), { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', languages: ['en'] })
    expect(text).toMatch(/^«.+» · язык en/)
  })

  it('a wrong access key is a 401', async () => {
    await expect(runTool(browser, 'browser_tabs', configOf(browser, { baseUrl: url, accessKey: 'wrong' }))).rejects.toThrow('неверный access key (401)')
  })
})
