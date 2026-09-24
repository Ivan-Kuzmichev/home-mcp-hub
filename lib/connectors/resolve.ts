import { getCachedResult } from '../mcp/result-cache'
import { magnetInfoHash, torrentInfoHash } from './bencode'
import { expectOk, serviceFetch } from './http'
import { ToolError, type ResolvedResult } from './types'

export type JackettLinkAccess = { baseUrl: string; apiKey: string }

/** Jackett /dl/ links: add the API key back, follow a redirect to a magnet or read the .torrent. */
export async function downloadJackettLink(link: string, jackett: JackettLinkAccess, title: string): Promise<ResolvedResult> {
  const url = new URL(link)
  // Links point at whatever host Jackett thinks it has; always go through the configured address.
  const base = new URL(jackett.baseUrl)
  url.protocol = base.protocol
  url.host = base.host
  url.searchParams.set('jackett_apikey', jackett.apiKey)

  const res = await serviceFetch('Jackett', url.toString(), { redirect: 'manual' })
  const location = res.headers.get('location')
  if (res.status >= 300 && res.status < 400 && location) {
    if (location.startsWith('magnet:')) return { kind: 'magnet', uri: location, title, infoHash: magnetInfoHash(location) ?? undefined }
    throw new ToolError('Jackett перенаправил на внешний адрес — такой релиз хаб не скачивает')
  }
  await expectOk('Jackett', res, 'скачивание .torrent')
  const data = new Uint8Array(await res.arrayBuffer())
  const infoHash = torrentInfoHash(data)
  if (!infoHash) throw new ToolError('Трекер вернул не .torrent (возможно, нужна авторизация на трекере в Jackett)')
  const filename = `${title.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 80) || 'release'}.torrent`
  return { kind: 'file', data, filename, title, infoHash }
}

/** result_id → magnet or .torrent. `jackett` is null when the Jackett connector is off. */
export async function resolveResult(resultId: string, jackett: JackettLinkAccess | null): Promise<ResolvedResult> {
  const r = getCachedResult(resultId.trim())
  if (!r) throw new ToolError(`result_id ${resultId} не найден или устарел (хранится час) — повтори search_torrents`)
  if (r.magnet) return { kind: 'magnet', uri: r.magnet, title: r.title, infoHash: r.infoHash ?? magnetInfoHash(r.magnet) ?? undefined }
  if (!r.link) throw new ToolError('У релиза нет ни магнета, ни ссылки на .torrent')
  if (!jackett) throw new ToolError('Коннектор Jackett выключен — скачать .torrent не получится')
  return downloadJackettLink(r.link, jackett, r.title)
}
