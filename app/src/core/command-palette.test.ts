import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePalette, openPalette } from './command-palette'
import type { Action } from './keymap'

const originalRaf = globalThis.requestAnimationFrame
const originalCancelRaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  document.body.innerHTML = ''
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  closePalette()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  globalThis.requestAnimationFrame = originalRaf
  globalThis.cancelAnimationFrame = originalCancelRaf
})

describe('openPalette', () => {
  it('ignores Enter while the input method is composing', () => {
    const onRun = vi.fn()
    const actions = [
      { id: 'demo.run', label: 'Run demo', defaultCombo: 'Ctrl+K' },
    ] satisfies Action[]

    openPalette(actions, onRun)

    const input = document.querySelector('input')
    expect(input).not.toBeNull()
    if (!input) return

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    input.dispatchEvent(event)

    expect(onRun).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
