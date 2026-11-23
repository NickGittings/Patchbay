import { describe, expect, it } from 'vitest'
import { MENTION_MAX_HEIGHT, placeMention } from './caretPoint'

const base = {
  lineHeight: 18,
  popover: { width: 240, height: 120 },
  bounds: { width: 600, top: -400, bottom: 200 },
}

describe('placeMention', () => {
  it('floats above the line holding the @', () => {
    expect(placeMention({ ...base, caret: { left: 100, top: 40 } })).toEqual({
      left: 96,
      top: 40 - 6 - 120,
      maxHeight: 120,
      placement: 'above',
    })
  })

  it('flips below when only the space below fits', () => {
    expect(
      placeMention({
        ...base,
        caret: { left: 100, top: 10 },
        bounds: { width: 600, top: -20, bottom: 400 },
      }),
    ).toEqual({ left: 96, top: 10 + 18 + 6, maxHeight: 120, placement: 'below' })
  })

  it('takes the roomier side and caps its height when neither side fits', () => {
    const tight = placeMention({
      ...base,
      caret: { left: 100, top: 60 },
      bounds: { width: 600, top: -10, bottom: 120 },
    })
    expect(tight).toEqual({ left: 96, top: 60 - 6 - 60, maxHeight: 60, placement: 'above' })
    const low = placeMention({
      ...base,
      caret: { left: 100, top: 10 },
      bounds: { width: 600, top: 0, bottom: 100 },
    })
    expect(low).toEqual({ left: 96, top: 34, maxHeight: 62, placement: 'below' })
  })

  it('never grows past seven rows', () => {
    const tall = placeMention({
      ...base,
      caret: { left: 100, top: 40 },
      popover: { width: 240, height: 900 },
    })
    expect(tall.maxHeight).toBe(MENTION_MAX_HEIGHT)
    expect(tall.top).toBe(40 - 6 - MENTION_MAX_HEIGHT)
  })

  it('stays inside the composer at both edges', () => {
    expect(placeMention({ ...base, caret: { left: 580, top: 40 } }).left).toBe(360)
    expect(placeMention({ ...base, caret: { left: 0, top: 40 } }).left).toBe(0)
  })

  it('pins to the left when the popover is wider than the composer', () => {
    expect(
      placeMention({
        ...base,
        caret: { left: 50, top: 40 },
        bounds: { width: 200, top: -400, bottom: 200 },
      }).left,
    ).toBe(0)
  })
})
