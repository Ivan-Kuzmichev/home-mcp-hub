import { ToolError } from '../types'
import { t } from '../../i18n'

// PDF and image work. The libraries are heavy and native, so they load only when a tool needs them.

export type Angle = 0 | 90 | 180 | 270

const MAX_ROTATE_PAGES = 30

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
/** Longer images get scaled down by the model anyway. */
const PREVIEW_LONG_SIDE = 1568
const REBUILD_DPI = 200
const REBUILD_LONG_SIDE = 3000

const PDF = 'application/pdf'

async function openPdf(data: Buffer) {
  const { getDocumentProxy } = await import('unpdf')
  try {
    // A copy: pdf.js takes ownership of the buffer it is given.
    return await getDocumentProxy(new Uint8Array(data))
  } catch {
    throw new ToolError(t`The PDF does not open: the file is damaged or password-protected`)
  }
}

type Pdf = Awaited<ReturnType<typeof openPdf>>

async function renderPage(pdf: Pdf, pageNumber: number, opts: { longSide: number; maxScale: number }): Promise<{ png: Buffer; width: number; height: number }> {
  const { renderPageAsImage } = await import('unpdf')
  const viewport = (await pdf.getPage(pageNumber)).getViewport({ scale: 1 })
  const scale = Math.min(opts.maxScale, opts.longSide / Math.max(viewport.width, viewport.height))
  const out = await renderPageAsImage(pdf, pageNumber, { canvasImport: () => import('@napi-rs/canvas'), scale })
  return { png: Buffer.from(out), width: viewport.width, height: viewport.height }
}

/** A JPEG small enough to send to the model. autoOrient first: phones keep the rotation in EXIF. */
async function previewJpeg(input: Buffer, angle: Angle): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  for (const quality of [80, 60, 40]) {
    const out = await sharp(input).autoOrient().rotate(angle).resize({ width: PREVIEW_LONG_SIDE, height: PREVIEW_LONG_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer()
    if (out.length <= MAX_PREVIEW_BYTES) return out
  }
  throw new ToolError(t`The page does not fit in 2 MB even at low quality`)
}

export async function preview(data: Buffer, mimeType: string, page: number, angle: Angle): Promise<{ data: Buffer; mimeType: string; pages: number | null }> {
  if (mimeType !== PDF) {
    if (angle === 0 && data.length <= MAX_PREVIEW_BYTES && mimeType !== 'image/jpeg') return { data, mimeType, pages: null }
    return { data: await previewJpeg(data, angle), mimeType: 'image/jpeg', pages: null }
  }
  const pdf = await openPdf(data)
  if (page > pdf.numPages) throw new ToolError(t`The document has ${pdf.numPages} pages, there is no page ${page}`)
  const { png } = await renderPage(pdf, page, { longSide: PREVIEW_LONG_SIDE, maxScale: 4 })
  return { data: await previewJpeg(png, angle), mimeType: 'image/jpeg', pages: pdf.numPages }
}

async function rotateImage(data: Buffer, mimeType: string, angle: Angle): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const image = sharp(data).autoOrient().rotate(angle)
  if (mimeType === 'image/png') return image.png().toBuffer()
  if (mimeType === 'image/webp') return image.webp({ quality: 92 }).toBuffer()
  return image.jpeg({ quality: 92 }).toBuffer()
}

/**
 * Papra's OCR reads the images embedded in a PDF as they are and skips OCR altogether when the PDF
 * has a text layer, so the page /Rotate flag would change nothing for it. Every page is rebuilt
 * from a really rotated image instead, and any text layer goes: a kept one would stop the OCR.
 */
async function rotatePdf(data: Buffer, angle: Angle, pages: number[] | undefined, dropText: boolean): Promise<Buffer> {
  const pdf = await openPdf(data)
  if (pdf.numPages > MAX_ROTATE_PAGES) throw new ToolError(t`The document has ${pdf.numPages} pages: I rotate at most ${MAX_ROTATE_PAGES}`)
  for (const n of pages ?? []) if (n > pdf.numPages) throw new ToolError(t`The document has ${pdf.numPages} pages, there is no page ${n}`)

  const { extractText } = await import('unpdf')
  const { text } = await extractText(pdf, { mergePages: true })
  if (text.trim() && !dropText) {
    throw new ToolError(t`The PDF has a text layer: after rotating, the pages become images and the Papra OCR reads the text again. If this is a scan with bad OCR, repeat with drop_text: true`)
  }

  const [{ PDFDocument }, { default: sharp }] = await Promise.all([import('pdf-lib'), import('sharp')])
  const out = await PDFDocument.create()
  const selected = pages?.length ? new Set(pages) : null
  for (let n = 1; n <= pdf.numPages; n++) {
    const pageAngle = !selected || selected.has(n) ? angle : 0
    const { png, width, height } = await renderPage(pdf, n, { longSide: REBUILD_LONG_SIDE, maxScale: REBUILD_DPI / 72 })
    const jpeg = await sharp(png).rotate(pageAngle).jpeg({ quality: 85 }).toBuffer()
    const image = await out.embedJpg(jpeg)
    const [w, h] = pageAngle % 180 === 0 ? [width, height] : [height, width]
    out.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h })
  }
  return Buffer.from(await out.save())
}

export function rotateFile(data: Buffer, mimeType: string, angle: Angle, opts: { pages?: number[]; dropText: boolean }): Promise<Buffer> {
  return mimeType === PDF ? rotatePdf(data, angle, opts.pages, opts.dropText) : rotateImage(data, mimeType, angle)
}
