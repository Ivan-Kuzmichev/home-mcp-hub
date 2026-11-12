import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { findCyrillic, registerCatalog, runWithLang, t } = await import('@/lib/i18n')
const { localizeSchema, localizedJsonSchema } = await import('@/lib/i18n/schema')
const { defineConnector, field, secret } = await import('@/lib/connectors/types')
const { describeFields, describeTools } = await import('@/lib/connectors/form')

afterAll(cleanup)

registerCatalog({
  Address: 'Адрес',
  'Where the service lives': 'Где живёт сервис',
  Fast: 'Быстро',
  'Need an API key': 'Нужен API-ключ',
  'Look up things': 'Найти что-нибудь',
  'Search the archive': 'Поиск по архиву',
  'What to find': 'Что найти',
  'Page size': 'Размер страницы',
})

const configSchema = z
  .object({
    baseUrl: field(z.string().default('http://x'), { label: 'Address', help: 'Where the service lives', placeholder: 'Address' }),
    mode: field(z.enum(['fast', 'slow']).default('fast'), { label: 'Address', options: [{ value: 'fast', label: 'Fast', short: 'Fast', help: 'Fast' }] }),
    apiKey: secret({ label: 'Address' }),
  })
  .superRefine((c, ctx) => {
    if (!c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: t`Need an API key` })
  })

const inputSchema = z.object({
  query: z.string().describe('What to find'),
  pages: z.array(z.object({ size: z.number().int().min(1, { error: () => t`Page size` }).describe('Page size') })).optional(),
})

const demo = defineConnector<z.output<typeof configSchema>>({
  id: 'demo',
  name: 'Demo',
  description: 'demo',
  configSchema,
  test: async () => ({ ok: true, summary: '', details: [] }),
  tools: [{ name: 'demo_search', title: 'Look up things', description: 'Search the archive', inputSchema, annotations: {}, run: async () => 'ok' }],
})

describe('localized connector metadata', () => {
  it('form fields and tool titles come in the hub language', () => {
    const en = runWithLang('en', () => describeFields(demo, undefined))
    expect(en[0]).toMatchObject({ label: 'Address', help: 'Where the service lives', placeholder: 'Address' })
    expect(en[1]!.options![0]).toMatchObject({ label: 'Fast', short: 'Fast', help: 'Fast' })
    const ru = runWithLang('ru', () => describeFields(demo, undefined))
    expect(ru[0]).toMatchObject({ label: 'Адрес', help: 'Где живёт сервис', placeholder: 'Адрес' })
    expect(ru[1]!.options![0]).toMatchObject({ label: 'Быстро', short: 'Быстро', help: 'Быстро' })
    expect(runWithLang('ru', () => describeTools(demo))[0]!.title).toBe('Найти что-нибудь')
  })

  it('config errors are built when parsing, in the language of that moment', () => {
    expect(runWithLang('en', () => demo.parseConfig({}))).toEqual({ ok: false, errors: { apiKey: 'Need an API key' } })
    expect(runWithLang('ru', () => demo.parseConfig({}))).toEqual({ ok: false, errors: { apiKey: 'Нужен API-ключ' } })
  })

  it('a localized tool schema translates every description, nested ones too, and validates the same', () => {
    const ru = JSON.stringify(runWithLang('ru', () => localizedJsonSchema(inputSchema)))
    expect(ru).toContain('"Что найти"')
    expect(ru).toContain('"Размер страницы"')
    expect(findCyrillic(JSON.stringify(runWithLang('en', () => localizedJsonSchema(inputSchema))))).toBeNull()

    const schema = localizeSchema(inputSchema)['~standard']
    expect(schema.validate({ query: 'x' })).toEqual({ value: { query: 'x' } })
    const bad = runWithLang('ru', () => schema.validate({ query: 'x', pages: [{ size: 0 }] })) as { issues: { message: string }[] }
    expect(bad.issues[0]!.message).toBe('Размер страницы')
  })
})

describe('tools/list carries the localized texts', () => {
  it('title, description and parameter descriptions go through the catalog, and a call still validates', async () => {
    const { saveConfig } = await import('@/lib/connectors/store')
    const { getConnector } = await import('@/lib/connectors/registry')
    const { rpc } = await import('@/lib/mcp/inspect')
    const jackett = getConnector('jackett')!
    saveConfig(jackett, { baseUrl: 'http://jackett:9117', apiKey: 'k', minSeeders: 1 })
    const tool = jackett.tools.find((x) => x.name === 'list_indexers')!
    const search = jackett.tools.find((x) => x.name === 'search_torrents')!
    const queryDescription = (search.inputSchema.shape.query as z.ZodType).description!
    // In the code these are still Russian (jackett is translated later): a catalog entry proves the path.
    registerCatalog({ [tool.title]: 'TITLE-RU', [tool.description]: 'DESC-RU', [queryDescription]: 'QUERY-RU' })

    const { tools } = await runWithLang('ru', () => rpc<{ tools: { name: string; title?: string; description?: string; inputSchema: { properties: Record<string, { description?: string }> } }[] }>('tools/list'))
    const listed = tools.find((x) => x.name === 'list_indexers')!
    expect(listed).toMatchObject({ title: 'TITLE-RU', description: 'DESC-RU' })
    expect(tools.find((x) => x.name === 'search_torrents')!.inputSchema.properties.query!.description).toBe('QUERY-RU')

    const bad = await runWithLang('ru', () => rpc<{ isError?: boolean; content: { text: string }[] }>('tools/call', { name: 'search_torrents', arguments: {} }))
    expect(bad.isError).toBe(true)
  })
})
