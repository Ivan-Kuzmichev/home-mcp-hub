import { describe, expect, it } from 'vitest'
import {
  hostMatches,
  mockRuleSchema,
  payloadFor,
  pathMatches,
  ruleMatches,
  type MockRule,
} from '../lib/connectors/mitmproxy/rules'

describe('mitmproxy mock rules', () => {
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
    expect(pathMatches('/a.b', '/a.b')).toBe(true)
    expect(pathMatches('/axb', '/a.b')).toBe(false)
  })
  it('checks the method only when set, and validates rules', () => {
    const r = { id: 'a', name: 'n', enabled: true, kind: 'patch', match: { host: 'a.example', path: '/x', method: 'GET' }, json: [{ path: 'user.isPremium', value: true }] } as MockRule
    expect(ruleMatches(r, { method: 'POST', host: 'a.example', path: '/x' })).toBe(false)
    expect(ruleMatches(r, { method: 'get', host: 'A.example:443', path: '/x?y=1' })).toBe(true)
    expect(mockRuleSchema.safeParse({ ...r, json: [{ path: 'a..b', value: 1 }] }).success).toBe(false)
    expect(mockRuleSchema.safeParse({ name: 'n', kind: 'patch', match: { host: 'a.example', path: '/x' } }).success).toBe(false)
    expect(JSON.parse(payloadFor([{ ...r, id: 'b' }, { ...r, enabled: false }])).rules.map((x: MockRule) => x.id)).toEqual(['b'])
  })
  it('validates replace rules and match shape', () => {
    const base = { name: 'n', kind: 'replace', match: { host: 'a.example', path: '/x' } }
    expect(mockRuleSchema.safeParse({ ...base, body: '' }).success).toBe(true)
    expect(mockRuleSchema.safeParse(base).success).toBe(false)
    expect(mockRuleSchema.safeParse({ ...base, body: '', match: { host: 'https://a.example', path: '/x' } }).success).toBe(false)
    expect(mockRuleSchema.safeParse({ ...base, body: '', match: { host: 'a.example/x', path: '/x' } }).success).toBe(false)
    expect(mockRuleSchema.safeParse({ ...base, body: '', match: { host: 'a.example', path: 'x' } }).success).toBe(false)
    expect(mockRuleSchema.safeParse({ ...base, body: '', status: 99 }).success).toBe(false)
    expect(mockRuleSchema.safeParse({ ...base, body: '', delayMs: 30001 }).success).toBe(false)
    expect(mockRuleSchema.safeParse({ ...base, body: 'x'.repeat(1024 * 1024 + 1) }).success).toBe(false)
  })
  it('keeps the given order in the payload (listMocks orders by creation)', () => {
    const r = { name: 'n', enabled: true, kind: 'patch', match: { host: 'a.example', path: '/x' }, delayMs: 1 } as const
    const ids = JSON.parse(payloadFor([{ ...r, id: 'b' }, { ...r, id: 'a' }])).rules.map((x: MockRule) => x.id)
    expect(ids).toEqual(['b', 'a'])
  })
})
