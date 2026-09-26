import { truncate } from './format'
import { ToolError } from './types'

export const shortHash = (hash: string) => hash.slice(0, 8)

/**
 * Claude passes back what it saw: a short hash, a full hash or part of the name.
 * Resolve to torrents or explain the ambiguity. Shared by the download clients.
 */
export function matchTorrents<T extends { hash: string; name: string }>(all: T[], refs: string[], listTool: string): T[] {
  return refs.map((ref) => {
    const r = ref.trim().toLowerCase()
    if (!r) throw new ToolError('Пустой hash')
    const byHash = all.filter((t) => t.hash.toLowerCase().startsWith(r))
    if (byHash.length === 1 && r.length >= 4) return byHash[0]!
    const byName = byHash.length ? [] : all.filter((t) => t.name.toLowerCase().includes(r))
    const matches = byHash.length ? byHash : byName
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new ToolError(`Торрент «${ref}» не найден — посмотри ${listTool}`)
    throw new ToolError(
      `«${ref}» подходит к нескольким торрентам:\n${matches
        .slice(0, 5)
        .map((t) => `• ${truncate(t.name, 60)} · hash ${shortHash(t.hash)}`)
        .join('\n')}`,
    )
  })
}
