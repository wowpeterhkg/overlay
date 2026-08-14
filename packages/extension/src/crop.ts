export interface Rect { x: number; y: number; w: number; h: number }

/* rect is CSS px from the content script; capture bitmap is device px. */
export function cropRect(rect: Rect, dpr: number, img: { w: number; h: number }) {
  const sx = Math.max(0, Math.round(rect.x * dpr))
  const sy = Math.max(0, Math.round(rect.y * dpr))
  const sw = Math.min(Math.round(rect.w * dpr), img.w - sx)
  const sh = Math.min(Math.round(rect.h * dpr), img.h - sy)
  if (sw <= 0 || sh <= 0) return null
  return { sx, sy, sw, sh }
}

export async function cropDataUrl(dataUrl: string, rect: Rect, dpr: number): Promise<{ blob: Blob; cropped: boolean }> {
  const src = await (await fetch(dataUrl)).blob()
  const bmp = await createImageBitmap(src)
  const r = cropRect(rect, dpr, { w: bmp.width, h: bmp.height })
  if (!r) return { blob: src, cropped: false }           // spec §8: fall back to uncropped, flagged
  const canvas = new OffscreenCanvas(r.sw, r.sh)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh)
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), cropped: true }
}
