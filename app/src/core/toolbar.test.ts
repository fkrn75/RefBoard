import { describe, expect, it } from 'vitest'
import { formatToolbarCursor } from './toolbar'

describe('formatToolbarCursor', () => {
  it('shows an em dash when the cursor is unavailable', () => {
    expect(formatToolbarCursor(undefined)).toBe('—')
  })

  it('rounds finite world coordinates for display', () => {
    expect(formatToolbarCursor({ x: 12.4, y: -3.6 })).toBe('12, -4')
  })
})
