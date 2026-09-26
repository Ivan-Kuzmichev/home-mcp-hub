import { jackett } from './jackett'
import { prototypes } from './prototypes'
import { qbittorrent } from './qbittorrent'
import { torrserve } from './torrserve'
import { transmission } from './transmission'
import type { RegisteredConnector } from './types'

// A new connector = a folder in lib/connectors/<name>/ and one line here.
export const CONNECTORS: RegisteredConnector[] = [jackett, qbittorrent, transmission, torrserve, prototypes]

export function getConnector(id: string): RegisteredConnector | undefined {
  return CONNECTORS.find((c) => c.id === id)
}
