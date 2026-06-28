export interface Point {
  x: number
  y: number
}

export type RubberDragState = {
  mode: 'rubber'
  start: Point
  additive: boolean
}

export function maybeStartRubberDrag(originsSize: number, start: Point, additive: boolean): RubberDragState | null {
  if (originsSize !== 0) return null
  return { mode: 'rubber', start, additive }
}
