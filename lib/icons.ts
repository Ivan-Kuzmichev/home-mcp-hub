import type { Metadata } from 'next'
import { href } from './prefix'

/**
 * Icons for pages under the secret prefix. The root layout has none on purpose: the public
 * pin page must not carry a prefixed URL, and the bare /favicon.ico stays an empty 404.
 */
export function prefixedIcons(): Metadata['icons'] {
  return {
    icon: [{ url: href('/brand/icon'), type: 'image/svg+xml' }],
    apple: [{ url: href('/brand/apple-touch'), sizes: '180x180', type: 'image/png' }],
  }
}
