import QRCode from 'qrcode'
import type { CardData } from '@/components/prototypes/prototype-card'
import { expiryText } from '../connectors/prototypes'
import { formatSize } from '../connectors/format'
import { formatAgo, formatWhen } from '../format'
import { href } from '../prefix'
import { isExpired, listVersions, publicUrl, type Prototype } from './store'

export async function cardData(p: Prototype): Promise<CardData> {
  const url = publicUrl(p.slug)
  return {
    id: p.id,
    title: p.title,
    url,
    qr: await QRCode.toDataURL(url, { margin: 1, width: 360 }),
    meta: `Опубликован ${formatWhen(p.createdAt)} · ${formatSize(p.sizeBytes)} · ${p.views} просм.`,
    hasPin: !!p.pinHash,
    expiryText: expiryText(p),
    expired: isExpired(p),
    currentVersion: p.version,
    versions: listVersions(p.id).map((v) => ({ version: v.version, ago: formatAgo(v.savedAt), size: formatSize(v.size) })),
    previewUrl: href(`/admin/prototypes/${p.id}/preview?v=${p.version}`),
  }
}
