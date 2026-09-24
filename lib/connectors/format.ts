const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 0 })

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${nf1.format(v)} ${units[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatSize(bytesPerSec)}/с` : '0'
}

/** 8640000 is qBittorrent's «infinity». */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 8_640_000) return '∞'
  const m = Math.round(seconds / 60)
  if (m < 1) return '<1 мин'
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ч ${m % 60} мин`
  return `${Math.floor(h / 24)} дн ${h % 24} ч`
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

/** Russian plural: plural(3, ['торрент', 'торрента', 'торрентов']) */
export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}
