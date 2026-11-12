import { localeTag, t, tr } from '../i18n'

export { plural } from '../i18n'

const nf1 = () => new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1, minimumFractionDigits: 0 })

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${nf1().format(v)} ${tr(units[i]!)}`
}

export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? t`${formatSize(bytesPerSec)}/s` : '0'
}

/** 8640000 is qBittorrent's «infinity». */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 8_640_000) return '∞'
  const m = Math.round(seconds / 60)
  if (m < 1) return t`<1 min`
  if (m < 60) return t`${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return t`${h} h ${m % 60} min`
  return t`${Math.floor(h / 24)} d ${h % 24} h`
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return ''
  // Jackett sends local time without a zone: keep its calendar date as is.
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10)
  const d = typeof date === 'string' ? new Date(date) : date
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}
