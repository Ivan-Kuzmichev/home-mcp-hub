import { describe, expect, it } from 'vitest'
import { isSensitiveName, maskBody, maskHeaders, maskUrl, maskValue } from '@/lib/redact'

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl'

describe('redact', () => {
  it('masks auth headers and keeps cookie names', () => {
    expect(maskHeaders([['Authorization', 'Bearer abcdef'], ['Cookie', 'sid=123; theme=dark'], ['Accept', 'json']]))
      .toEqual([['Authorization', '*** (13 симв.)'], ['Cookie', 'sid=***; theme=***'], ['Accept', 'json']])
    expect(maskHeaders([['Set-Cookie', 'session=xyz; Path=/; HttpOnly']])).toEqual([['Set-Cookie', 'session=***; Path=/; HttpOnly']])
    expect(maskHeaders([['X-Api-Key', 'k'], ['X-Auth-Token', 't'], ['X-Session-Id', 's']]).every(([, v]) => v.startsWith('***'))).toBe(true)
  })

  it('masks query, JWT in path, JSON and form bodies', () => {
    expect(maskUrl('https://a.example/v1/x?access_token=abc&page=2')).toBe('https://a.example/v1/x?access_token=***&page=2')
    expect(maskUrl(`https://a.example/v1/${jwt}/x`)).toBe('https://a.example/v1/***/x')
    expect(JSON.parse(maskBody(JSON.stringify({ user: { name: 'Ваня', password: 'p' }, refresh_token: 'r', items: [{ jwt }] }), 'application/json')))
      .toEqual({ user: { name: 'Ваня', password: '***' }, refresh_token: '***', items: [{ jwt: '***' }] })
    expect(maskBody('login=ivan&pass=secret', 'application/x-www-form-urlencoded')).toBe('login=ivan&pass=***')
    expect(maskBody(`token is ${jwt} here`, 'text/plain')).toBe('token is *** here')
    expect(maskBody('{broken', 'application/json')).toBe('{broken')
  })

  it('knows sensitive names and masks values', () => {
    for (const n of ['token', 'Access_Token', 'pass', 'sid', 'code', 'otp', 'pin', 'apikey', 'x-session-id', 'clientSecret']) {
      expect(isSensitiveName(n)).toBe(true)
    }
    for (const n of ['page', 'name', 'accept', 'login']) expect(isSensitiveName(n)).toBe(false)
    expect(maskValue('abc')).toBe('*** (3 симв.)')
  })
})
