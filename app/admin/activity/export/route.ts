import { headers } from 'next/headers'
import { getAuth } from '@/lib/auth'
import { queryJournal } from '@/lib/journal'
import { connectorTag, filterFrom, resultText, toolLabel, type JournalSearch } from '@/lib/journal-view'

export const dynamic = 'force-dynamic'

function cell(v: string | number | null): string {
  const s = v === null ? '' : String(v)
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session?.user.twoFactorEnabled) return new Response(null, { status: 404 })

  const sp = Object.fromEntries(new URL(req.url).searchParams) as JournalSearch
  const rows = queryJournal(filterFrom(sp), 10_000)
  const lines = [
    ['time', 'tool', 'connector', 'args', 'ok', 'result', 'duration_ms', 'ip'].join(','),
    ...rows.map((r) =>
      [r.createdAt.toISOString(), toolLabel(r).text, connectorTag(r), r.argsRedacted, r.ok ? 'ok' : 'error', resultText(r), r.durationMs, r.ip].map(cell).join(','),
    ),
  ]
  // BOM so Excel reads UTF-8 Cyrillic correctly.
  return new Response(`﻿${lines.join('\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hub-journal-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
