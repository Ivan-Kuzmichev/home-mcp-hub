const dateTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })

/** «сегодня 09:14», «вчера 21:40», «12 сен, 21:40» */
export function formatWhen(date: Date | null | undefined, now = new Date()): string {
  if (!date) return '—'
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((day(now) - day(date)) / 86_400_000)
  if (diffDays === 0) return `сегодня ${time.format(date)}`
  if (diffDays === 1) return `вчера ${time.format(date)}`
  return dateTime.format(date).replace('.', '')
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-3)}` : id
}
