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

  it('masks whole subtrees under sensitive JSON keys', () => {
    const out = JSON.parse(maskBody(JSON.stringify({
      tokens: ['opaque1', 'opaque2'], session: { id: 'abc', n: 5 }, auth: { value: 'x' }, pin: 1234, otp: null, name: 'Ваня',
    }), 'application/json'))
    expect(out).toEqual({
      tokens: ['***', '***'], session: { id: '***', n: '***' }, auth: { value: '***' }, pin: '***', otp: '***', name: 'Ваня',
    })
  })

  it('masks URL-bearing headers', () => {
    expect(maskHeaders([
      ['Location', 'https://app/cb?code=abc&access_token=opaque'],
      ['Referer', 'https://app/x?token=t&page=1'],
      ['Origin', 'https://app'],
      ['Content-Location', '/a?sid=1'],
    ])).toEqual([
      ['Location', 'https://app/cb?code=***&access_token=***'],
      ['Referer', 'https://app/x?token=***&page=1'],
      ['Origin', 'https://app'],
      ['Content-Location', '/a?sid=***'],
    ])
  })

  it('masks Bearer, Basic and Token credentials in any header and in text bodies', () => {
    expect(maskHeaders([['X-Foo', 'Bearer opaque-abc.def_123'], ['X-Upstream', 'Basic dXNlcjpwYXNzd29yZA=='], ['Accept', 'json']]))
      .toEqual([['X-Foo', 'Bearer ***'], ['X-Upstream', 'Basic ***'], ['Accept', 'json']])
    expect(maskBody('use Token abcdef1234567890 now', 'text/plain')).toBe('use Token *** now')
    expect(maskBody('Authorization: bearer opaque-abc.def_123', undefined)).toBe('Authorization: bearer ***')
    expect(JSON.parse(maskBody(JSON.stringify({ note: 'Bearer opaque-abc.def_123' }), 'application/json'))).toEqual({ note: 'Bearer ***' })
  })

  it('treats key, signature and credential names as sensitive', () => {
    for (const n of ['key', 'accessKey', 'privateKey', 'private_key', 'secret-key', 'x-access-key', 'signature', 'X-Amz-Signature', 'sig', 'credential', 'credentials', 'X-Amz-Credential']) {
      expect(isSensitiveName(n), n).toBe(true)
    }
    for (const n of ['monkey', 'hockey', 'keyboard', 'design', 'signal', 'keys_count']) expect(isSensitiveName(n), n).toBe(false)
    expect(maskUrl('https://s3.example/o?X-Amz-Credential=AKIA&X-Amz-Signature=abc&sig=1&page=2'))
      .toBe('https://s3.example/o?X-Amz-Credential=***&X-Amz-Signature=***&sig=***&page=2')
  })

  it('sniffs JSON bodies sent with a non-JSON content type', () => {
    expect(JSON.parse(maskBody(' {"password":"p","name":"Ваня"}', 'text/plain'))).toEqual({ password: '***', name: 'Ваня' })
    expect(JSON.parse(maskBody('[{"token":"t"}]', undefined))).toEqual([{ token: '***' }])
    expect(maskBody('{not json, password=p', 'text/plain')).toBe('{not json, password=p')
  })

  it('masks fragment pairs and userinfo in URLs', () => {
    expect(maskUrl('https://a.example/cb#access_token=opaque&state=x')).toBe('https://a.example/cb#access_token=***&state=x')
    expect(maskUrl('https://user:pass@host/p?a=1')).toBe('https://user:***@host/p?a=1')
  })
})
