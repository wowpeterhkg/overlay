import { describe, it, expect } from 'vitest'
import { cropRect } from './crop'

describe('cropRect', () => {
  it('scales by dpr and clamps to image bounds', () => {
    expect(cropRect({ x: 10, y: 20, w: 100, h: 50 }, 2, { w: 400, h: 300 }))
      .toEqual({ sx: 20, sy: 40, sw: 200, sh: 100 })
  })
  it('clamps overflow', () => {
    expect(cropRect({ x: 190, y: 140, w: 100, h: 50 }, 2, { w: 400, h: 300 }))
      .toEqual({ sx: 380, sy: 280, sw: 20, sh: 20 })
  })
  it('rejects empty result', () => {
    expect(cropRect({ x: 500, y: 0, w: 10, h: 10 }, 2, { w: 400, h: 300 })).toBeNull()
  })
})
