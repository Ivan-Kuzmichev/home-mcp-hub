import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { jackett } = await import('@/lib/connectors/jackett')
const store = await import('@/lib/connectors/store')
const { describeFields } = await import('@/lib/connectors/form')

afterAll(cleanup)

describe('connector config storage', () => {
  it('encrypts secrets, keeps them on empty input and never exposes them to the form', () => {
    const parsed = jackett.parseConfig({ baseUrl: 'http://jackett:9117/', apiKey: 'plain-key-123' })
    if (!parsed.ok) throw new Error('config should be valid')
    store.saveConfig(jackett, parsed.config as Record<string, unknown>)

    const row = store.getConnectorRow('jackett')!
    expect(row.configEnc).not.toContain('plain-key-123')
    expect(JSON.parse(row.configEnc).apiKey).toMatch(/^v1:/)
    expect(row.baseUrl).toBe('http://jackett:9117')
    expect(store.readConfig(jackett)).toMatchObject({ apiKey: 'plain-key-123', baseUrl: 'http://jackett:9117' })

    // Saving the form with the secret left empty keeps the stored key.
    const merged = store.mergeWithStoredSecrets(jackett, { baseUrl: 'http://10.0.0.2:9117', apiKey: '' })
    expect(merged.apiKey).toBe('plain-key-123')

    const fields = describeFields(jackett, row)
    const apiKey = fields.find((f) => f.name === 'apiKey')!
    expect(apiKey).toMatchObject({ secret: true, secretSet: true, value: '' })
    expect(JSON.stringify(fields)).not.toContain('plain-key-123')
    expect(fields.find((f) => f.name === 'minSeeders')?.value).toBe('1')
  })
})
