export interface EditorTouchHandlers {
  onPan: (dx: number, dy: number) => void
  onPinch: (factor: number, centerX: number, centerY: number) => void
}

interface TouchPoint {
  x: number
  y: number
}

interface TouchPair {
  cx: number
  cy: number
  dist: number
}

export function attachEditorTwoFingerGestures(el: HTMLElement, handlers: EditorTouchHandlers): () => void {
  const pointers = new Map<number, TouchPoint>()
  let previous: TouchPair | null = null
  const previousTouchAction = el.style.touchAction

  const toLocal = (event: PointerEvent): TouchPoint => {
    const rect = el.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const pair = (): TouchPair | null => {
    if (pointers.size < 2) return null
    const values = Array.from(pointers.values())
    const first = values[0]
    const second = values[1]
    if (!first || !second) return null
    return {
      cx: (first.x + second.x) / 2,
      cy: (first.y + second.y) / 2,
      dist: Math.hypot(first.x - second.x, first.y - second.y),
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') return
    pointers.set(event.pointerId, toLocal(event))
    try {
      el.setPointerCapture(event.pointerId)
    } catch {
      return
    }
    previous = pair()
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, toLocal(event))
    const current = pair()
    if (!current || !previous) {
      previous = current
      return
    }
    const dx = current.cx - previous.cx
    const dy = current.cy - previous.cy
    if (dx !== 0 || dy !== 0) handlers.onPan(dx, dy)
    if (previous.dist > 0) {
      const factor = current.dist / previous.dist
      if (factor > 0 && Math.abs(factor - 1) > 1e-3) handlers.onPinch(factor, current.cx, current.cy)
    }
    previous = current
  }

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId)
    try {
      el.releasePointerCapture(event.pointerId)
    } catch {
      return
    }
    previous = pair()
  }

  el.style.touchAction = 'none'
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', endPointer)
  el.addEventListener('pointercancel', endPointer)

  return () => {
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', endPointer)
    el.removeEventListener('pointercancel', endPointer)
    el.style.touchAction = previousTouchAction
    pointers.clear()
    previous = null
  }
}

