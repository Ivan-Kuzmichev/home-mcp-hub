import { magnetInfoHash } from '../bencode'
import { formatDate, formatSize, truncate } from '../format'
import type { CachedResult } from '../../mcp/result-cache'
import { stripApiKey, type Indexer, type JackettClient, type JackettResult } from './client'
import { hasRussianAudio, matchesSeason, parseQuality, qualityTags } from './parse'

export const SEARCH_DEADLINE_MS = 25_000

// Torznab categories
export const CATEGORIES = { movie: [2000], tv: [5000], anime: [5070], any: [] as number[] } as const
export type SearchType = keyof typeof CATEGORIES

export type SearchParams = {
  query: string
  type: SearchType
  season?: number
  episode?: number
  year?: number
  language: 'ru' | 'any'
  minSeeders: number
  limit: number
}

export type Release = {
  title: string
  tracker: string
  size: number
  seeders: number
  date: string
  tags: string[]
  russian: boolean
  magnet?: string
  link?: string
  infoHash?: string
}

export type SearchOutcome = {
  releases: Release[]
  total: number
  failed: { name: string; reason: 'timeout' | 'error' }[]
}

// Last known state per indexer, shown by list_indexers.
export const indexerHealth = new Map<string, { ok: boolean; at: Date; note?: string }>()

function toRelease(r: JackettResult): Release {
  const magnet = r.MagnetUri ?? undefined
  const infoHash = (r.InfoHash ?? (magnet ? magnetInfoHash(magnet) : null))?.toLowerCase() ?? undefined
  return {
    title: r.Title,
    tracker: r.Tracker,
    size: r.Size,
    seeders: r.Seeders ?? 0,
    date: formatDate(r.PublishDate),
    tags: qualityTags(parseQuality(r.Title)),
    russian: hasRussianAudio(r.Title),
    magnet,
    link: r.Link ? stripApiKey(r.Link) : undefined,
    infoHash,
  }
}

/** Same infohash → one release (most seeders); then one release per tracker + quality. */
export function dedupe(releases: Release[]): Release[] {
  const bySeeders = [...releases].sort((a, b) => b.seeders - a.seeders)
  const seenHash = new Set<string>()
  const seenGroup = new Set<string>()
  const out: Release[] = []
  for (const r of bySeeders) {
    if (r.infoHash) {
      if (seenHash.has(r.infoHash)) continue
      seenHash.add(r.infoHash)
    }
    const quality = parseQuality(r.title)
    const group = `${r.tracker}|${quality.resolution ?? '?'}|${quality.source ?? '?'}|${r.russian ? 'ru' : ''}`
    if (seenGroup.has(group)) continue
    seenGroup.add(group)
    out.push(r)
  }
  return out
}

export function rank(releases: Release[], language: 'ru' | 'any'): Release[] {
  return [...releases].sort((a, b) => {
    if (language === 'ru' && a.russian !== b.russian) return a.russian ? -1 : 1
    return b.seeders - a.seeders
  })
}

export async function searchAll(client: JackettClient, indexers: Indexer[], p: SearchParams, deadlineMs = SEARCH_DEADLINE_MS): Promise<SearchOutcome> {
  const query = [p.query, p.year].filter(Boolean).join(' ')
  const deadline = AbortSignal.timeout(deadlineMs)
  const failed: SearchOutcome['failed'] = []

  const perIndexer = await Promise.all(
    indexers.map(async (ix) => {
      try {
        const results = await client.search(ix.id, query, [...CATEGORIES[p.type]], deadline)
        indexerHealth.set(ix.id, { ok: true, at: new Date() })
        return results
      } catch (e) {
        const reason = deadline.aborted ? 'timeout' : 'error'
        failed.push({ name: ix.name, reason })
        indexerHealth.set(ix.id, { ok: false, at: new Date(), note: reason === 'timeout' ? 'не ответил за 25 с' : e instanceof Error ? e.message.slice(0, 80) : 'ошибка' })
        return []
      }
    }),
  )

  const all = perIndexer.flat().map(toRelease)
  const filtered = all.filter(
    (r) =>
      r.seeders >= p.minSeeders &&
      (p.season === undefined || matchesSeason(r.title, p.season, p.episode)),
  )
  const unique = rank(dedupe(filtered), p.language)
  return { releases: unique.slice(0, p.limit), total: unique.length, failed }
}

export function toCached(r: Release): CachedResult {
  return { title: r.title, tracker: r.tracker, size: r.size, magnet: r.magnet, link: r.link, infoHash: r.infoHash }
}

export function formatRelease(id: string, r: Release): string {
  const tags = r.tags.length ? ` · ${r.tags.join(', ')}` : ''
  return `${id} · ${truncate(r.title, 90)} · ${formatSize(r.size)} · сиды ${r.seeders} · ${r.tracker}${r.date ? ` · ${r.date}` : ''}${tags}`
}
