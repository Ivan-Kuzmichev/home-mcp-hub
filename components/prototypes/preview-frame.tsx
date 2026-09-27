'use client'

import { useEffect, useRef, useState } from 'react'

// The prototype renders at a desktop size and is scaled down to the card, like a thumbnail:
// a wide page neither overflows the phone screen nor shows up cropped.
const VIEW_W = 1280
const VIEW_H = 800

export function PreviewFrame({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const update = () => setScale(el.clientWidth / VIEW_W)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-md border border-border bg-white" style={{ height: VIEW_H * scale }}>
      <iframe
        title={title}
        src={src}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className="absolute top-0 left-0 block origin-top-left border-0"
        style={{ width: VIEW_W, height: VIEW_H, transform: `scale(${scale})` }}
        loading="lazy"
      />
    </div>
  )
}
