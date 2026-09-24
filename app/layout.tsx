import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans, JetBrains_Mono, Manrope } from 'next/font/google'
import './globals.css'

const manrope = Manrope({ subsets: ['latin', 'cyrillic'], weight: ['600', '700', '800'], variable: '--font-manrope' })
const plex = IBM_Plex_Sans({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600'], variable: '--font-plex' })
const jetbrains = JetBrains_Mono({ subsets: ['latin', 'cyrillic'], weight: ['400', '500'], variable: '--font-jetbrains' })

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
    <html lang="ru" className={`${manrope.variable} ${plex.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
