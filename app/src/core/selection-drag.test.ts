import { describe, expect, it } from 'vitest'
import { maybeStartRubberDrag } from './selection-drag'

describe('maybeStartRubberDrag', () => {
  it('starts a rubber-band drag when no movable origins remain', () => {
    expect(maybeStartRubberDrag(0, { x: 12, y: -8 }, true)).toEqual({
      mode: 'rubber',
      start: { x: 12, y: -8 },
      additive: true,
    })
  })

  it('returns null when at least one movable origin exists', () => {
    expect(maybeStartRubberDrag(1, { x: 0, y: 0 }, false)).toBeNull()
  })
})
