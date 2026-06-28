import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeLightbox, openLightbox } from './lightbox'

const items = [
  {
    id: 'image-1',
    src: 'data:image/png;base64,iVBORw0KGgo=',
    title: '단일 이미지',
  },
]

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  closeLightbox()
  document.body.innerHTML = ''
})

describe('openLightbox', () => {
  it('keeps a single image zoom state stable when arrow keys are pressed', () => {
    openLightbox(items, 0)

    const dialog = document.querySelector('[role="dialog"]')
    const img = document.querySelector('img')
    expect(dialog).not.toBeNull()
    expect(img).not.toBeNull()
    if (!dialog || !img) return

    dialog.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }))
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1.15)')

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    )

    expect(img.style.transform).toBe('translate(0px, 0px) scale(1.15)')
  })
})
