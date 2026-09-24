import type { Metadata, Viewport } from 'next'
// Fonts come from npm (@fontsource), not Google Fonts: the build needs no network and the
// files are served from /_next/static/media like any other asset. Subsets load by unicode-range.
import '@fontsource-variable/manrope'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'

export const metadata: Metadata = {
  title: 'Home Hub',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export const viewport: Viewport = {
  themeColor: '#0E1014',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
