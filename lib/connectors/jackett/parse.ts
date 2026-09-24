// Release title parsing: quality tags, audio, season matching. Pure, easy to test.

export type Quality = { resolution?: string; source?: string; hdr?: boolean; audio: string[] }

const RESOLUTIONS: [RegExp, string][] = [
  [/\b(2160p|4k|uhd)\b/i, '2160p'],
  [/\b1080[pi]\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b(480p|576p|dvdrip|sd)\b/i, 'SD'],
]

const SOURCES: [RegExp, string][] = [
  [/\bremux\b/i, 'Remux'],
  [/\bweb-?dl\b/i, 'WEB-DL'],
  [/\bweb-?rip\b/i, 'WEBRip'],
  [/\b(blu-?ray|bdrip|bd-?rip|bdremux)\b/i, 'BluRay'],
  [/\bhdtv(rip)?\b/i, 'HDTV'],
  [/\bdvd(rip|9|5)?\b/i, 'DVD'],
  [/\b(camrip|ts|telesync|cam)\b/i, 'CAM'],
]

const AUDIO: [RegExp, string][] = [
  [/(дубляж|\bdub\b|\bd\b(?=[\s,)|]))/i, 'дубляж'],
  [/(\bmvo\b|многоголос)/i, 'многоголосый'],
  [/(\bdvo\b|двухголос)/i, 'двухголосый'],
  [/(\bavo\b|авторск)/i, 'авторский'],
  [/(оригинал|\boriginal\b|\beng\b)/i, 'оригинал'],
  [/(субтитр|\bsub(s)?\b)/i, 'субтитры'],
]

const RUSSIAN_AUDIO = /(дубляж|\bdub\b|\bmvo\b|\bdvo\b|\bavo\b|многоголос|двухголос|авторск|\brus\b|lostfilm|hdrezka|newstudio|кубик|пифагор|jaskier|red head sound|tvshows)/i

export function parseQuality(title: string): Quality {
  const find = (list: [RegExp, string][]) => list.find(([re]) => re.test(title))?.[1]
  return {
    resolution: find(RESOLUTIONS),
    source: find(SOURCES),
    hdr: /\b(hdr10?\+?|dolby ?vision|\bdv\b)/i.test(title) || undefined,
    audio: AUDIO.filter(([re]) => re.test(title)).map(([, name]) => name),
  }
}

export function qualityTags(q: Quality): string[] {
  return [q.resolution, q.source, q.hdr && 'HDR', ...q.audio].filter((t): t is string => !!t)
}

/** Russian audio: explicit voice-over markers, or a Cyrillic title from a Russian tracker. */
export function hasRussianAudio(title: string): boolean {
  return RUSSIAN_AUDIO.test(title) || (/[А-Яа-яЁё]/.test(title) && !/(оригинал|original)\s*(only|только)/i.test(title))
}

/**
 * Does the release cover the season (and episode)? Handles «S02», «S02E05», «Season 2»,
 * «Сезон: 2», «2 сезон», «Серии: 1-8», and complete-series packs «S01-S03».
 */
export function matchesSeason(title: string, season: number, episode?: number): boolean {
  const t = title.toLowerCase()
  const s = String(season)
  const pad = s.padStart(2, '0')

  const ranges = [...t.matchAll(/s(\d{1,2})\s*-\s*s?(\d{1,2})\b/g), ...t.matchAll(/сезон[ыа]?:?\s*(\d{1,2})\s*-\s*(\d{1,2})/g)]
  const inRange = ranges.some((m) => season >= Number(m[1]) && season <= Number(m[2]))

  const seasonHit =
    inRange ||
    new RegExp(`\\bs${pad}(?!\\d)`).test(t) ||
    new RegExp(`\\bs${s}e\\d`).test(t) ||
    new RegExp(`season\\s*${s}\\b`).test(t) ||
    new RegExp(`сезон[:\\s]*${s}\\b`).test(t) ||
    new RegExp(`\\b${s}\\s*сезон`).test(t)
  if (!seasonHit) return false
  if (episode === undefined) return true

  const ep = String(episode)
  const epPad = ep.padStart(2, '0')
  if (new RegExp(`s${pad}e${epPad}(?!\\d)`).test(t)) return true
  // Season packs or episode ranges («Серии: 1-8 из 10», «E01-E08»)
  const epRanges = [...t.matchAll(/(?:серии|эпизоды|episodes?)[:\s]*(\d{1,3})\s*-\s*(\d{1,3})/g), ...t.matchAll(/e(\d{1,3})\s*-\s*e?(\d{1,3})/g)]
  if (epRanges.length) return epRanges.some((m) => episode >= Number(m[1]) && episode <= Number(m[2]))
  // No episode info at all: probably the full season.
  return !/e\d{1,3}\b|серия\s*\d/.test(t)
}
