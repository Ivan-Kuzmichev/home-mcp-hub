import { getCachedResult } from '../mcp/result-cache'
import { magnetInfoHash, torrentInfoHash } from './bencode'
import { expectOk, serviceFetch } from './http'
import { ToolError, type ResolvedResult } from './types'
import { t } from '../i18n'

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
    throw new ToolError(t`Jackett redirected to an external address — the hub does not download such a release`)
  }
  await expectOk('Jackett', res, t`downloading .torrent`)
  const data = new Uint8Array(await res.arrayBuffer())
  const infoHash = torrentInfoHash(data)
  if (!infoHash) throw new ToolError(t`The tracker did not return a .torrent (it may need a tracker login in Jackett)`)
  const filename = `${title.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 80) || 'release'}.torrent`
  return { kind: 'file', data, filename, title, infoHash }
}

/** result_id → magnet or .torrent. `jackett` is null when the Jackett connector is off. */
export async function resolveResult(resultId: string, jackett: JackettLinkAccess | null): Promise<ResolvedResult> {
  const r = getCachedResult(resultId.trim())
  if (!r) throw new ToolError(t`result_id ${resultId} not found or expired (kept for an hour) — run search_torrents again`)
  if (r.magnet) return { kind: 'magnet', uri: r.magnet, title: r.title, infoHash: r.infoHash ?? magnetInfoHash(r.magnet) ?? undefined }
  if (!r.link) throw new ToolError(t`The release has neither a magnet nor a .torrent link`)
  if (!jackett) throw new ToolError(t`The Jackett connector is off — the .torrent cannot be downloaded`)
  return downloadJackettLink(r.link, jackett, r.title)
}
