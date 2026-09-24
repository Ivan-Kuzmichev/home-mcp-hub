import { jackett } from './jackett'
import { qbittorrent } from './qbittorrent'
import { torrserve } from './torrserve'
import type { RegisteredConnector } from './types'

// A new connector = a folder in lib/connectors/<name>/ and one line here.
export const CONNECTORS: RegisteredConnector[] = [jackett, qbittorrent, torrserve]

export function getConnector(id: string): RegisteredConnector | undefined {
  return CONNECTORS.find((c) => c.id === id)
}
