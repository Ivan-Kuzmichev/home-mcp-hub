import { getLang, localeTag, t } from './i18n'

const dateTime = () => new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const time = () => new Intl.DateTimeFormat(localeTag(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** «today 09:14», «yesterday 21:40», «Sep 12, 21:40» (in Russian: «сегодня 09:14», «12 сен, 21:40») */
export function formatWhen(date: Date | null | undefined, now = new Date()): string {
  if (!date) return '—'
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((day(now) - day(date)) / 86_400_000)
  if (diffDays === 0) return t`today ${time().format(date)}`
  if (diffDays === 1) return t`yesterday ${time().format(date)}`
  const full = dateTime().format(date)
  return getLang() === 'ru' ? full.replace('.', '') : full
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-3)}` : id
}

/** «just now», «3 min ago», «2 h ago», «yesterday 21:40» */
export function formatAgo(date: Date | null | undefined, now = new Date()): string {
  if (!date) return '—'
  const min = Math.round((now.getTime() - date.getTime()) / 60_000)
  if (min < 1) return t`just now`
  if (min < 60) return t`${min} min ago`
  if (min < 12 * 60) return t`${Math.floor(min / 60)} h ago`
  return formatWhen(date, now)
}
