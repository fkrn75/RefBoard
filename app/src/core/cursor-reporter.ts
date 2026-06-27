export interface CursorReporter {
  report(cursor: { x: number; y: number } | undefined): void
}

export function createCursorReporter(update: (cursor: { x: number; y: number } | undefined) => void): CursorReporter {
  let rafId = 0
  let pending: { x: number; y: number } | undefined

  return {
    report(cursor): void {
      pending = cursor
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        update(pending)
      })
    },
  }
}
