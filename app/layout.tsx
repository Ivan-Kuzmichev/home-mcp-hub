import type { Metadata, Viewport } from 'next'
// Fonts come from npm (@fontsource), not Google Fonts: the build needs no network and the
// files are served from /_next/static/media like any other asset. Subsets load by unicode-range.
import '@fontsource-variable/manrope'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'
import { LangProvider } from '@/components/i18n-provider'
import { getLang } from '@/lib/i18n'

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
  const lang = getLang()
  return (
    <html lang={lang}>
      <body className="min-h-dvh">
        <LangProvider lang={lang}>{children}</LangProvider>
      </body>
    </html>
  )
}
