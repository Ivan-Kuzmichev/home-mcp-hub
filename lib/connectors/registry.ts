import { browser } from './browser'
import { files } from './files'
import { jackett } from './jackett'
import { mitmproxy } from './mitmproxy'
import { paperless } from './paperless'
import { papra } from './papra'
import { prototypes } from './prototypes'
import { qbittorrent } from './qbittorrent'
import { scripts } from './scripts'
import { torrserve } from './torrserve'
import { transmission } from './transmission'
import type { RegisteredConnector } from './types'

// A new connector = a folder in lib/connectors/<name>/ and one line here.
export const CONNECTORS: RegisteredConnector[] = [jackett, qbittorrent, transmission, torrserve, paperless, papra, files, browser, mitmproxy, prototypes, scripts]

export function getConnector(id: string): RegisteredConnector | undefined {
  return CONNECTORS.find((c) => c.id === id)
}
