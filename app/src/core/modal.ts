const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface FocusTrap {
  activate(): void
  handleKeydown(event: KeyboardEvent): boolean
  dispose(): void
}

export function createFocusTrap(root: HTMLElement): FocusTrap {
  let previousFocus: Element | null = null

  const focusables = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
      if (el.hidden) return false
      const style = globalThis.getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })

  const focusFirst = (): void => {
    const first = focusables()[0]
    if (first) first.focus()
    else root.focus()
  }

  return {
    activate(): void {
      previousFocus = document.activeElement
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1')
      requestAnimationFrame(focusFirst)
    },
    handleKeydown(event: KeyboardEvent): boolean {
      if (event.key !== 'Tab') return false
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        root.focus()
        return true
      }
      const current = document.activeElement
      const index = current instanceof HTMLElement ? items.indexOf(current) : -1
      const nextIndex = event.shiftKey
        ? index <= 0 ? items.length - 1 : index - 1
        : index >= items.length - 1 ? 0 : index + 1
      event.preventDefault()
      items[nextIndex].focus()
      return true
    },
    dispose(): void {
      if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) {
        previousFocus.focus()
      }
      previousFocus = null
    },
  }
}

