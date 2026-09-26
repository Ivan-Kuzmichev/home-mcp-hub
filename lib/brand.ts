// The hub logo: the accent square with a crosshair, same geometry as components/logo.tsx.
export const BRAND_ACCENT = '#7FA7FF'
export const BRAND_INK = '#0E1014'

/** Crosshair paths in a 24×24 box. */
export const LOGO_GLYPH = { circle: { cx: 12, cy: 12, r: 3 }, path: 'M12 3v6M12 15v6M3 12h6M15 12h6', strokeWidth: 2.2 }

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="9" fill="${BRAND_ACCENT}"/>
<g transform="translate(7 7) scale(0.75)" fill="none" stroke="${BRAND_INK}" stroke-width="${LOGO_GLYPH.strokeWidth}" stroke-linecap="round">
<circle cx="12" cy="12" r="3"/><path d="${LOGO_GLYPH.path}"/>
</g>
</svg>`

export const LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString('base64')}`
