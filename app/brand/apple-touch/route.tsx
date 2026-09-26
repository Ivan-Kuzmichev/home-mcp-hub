import { ImageResponse } from 'next/og'
import { BRAND_ACCENT, BRAND_INK, LOGO_GLYPH } from '@/lib/brand'

/** 180×180 PNG for «Add to Home Screen» on iPhone (iOS ignores SVG icons). */
export function GET(): ImageResponse {
  const { circle, path, strokeWidth } = LOGO_GLYPH
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: BRAND_ACCENT }}>
        <svg width="104" height="104" viewBox="0 0 24 24" fill="none" stroke={BRAND_INK} strokeWidth={strokeWidth} strokeLinecap="round">
          <circle cx={circle.cx} cy={circle.cy} r={circle.r} />
          <path d={path} />
        </svg>
      </div>
    ),
    { width: 180, height: 180, headers: { 'Cache-Control': 'public, max-age=604800' } },
  )
}
