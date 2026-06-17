// 그리드/이웃 스냅 계산 모듈 (RefBoard Phase 1.4).
//
// 드래그 이동 중의 위치 보정을 "순수 함수"로만 제공한다.
// - 상태(그리드 on/off, 스냅 on/off)나 줌은 main이 관리하므로 이 모듈은 상태를 갖지 않는다.
// - threshold/grid 는 모두 "월드 단위"이며, main이 화면px/zoom으로 환산해 넘긴다.
// - 좌표계: scene.getItemAABB 와 동일한 월드 좌표.

// 축 정렬 경계상자. scene.getItemAABB 의 반환형과 동일.
export interface AABB {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// 값 v를 가장 가까운 grid 배수로 반올림한다.
// grid<=0(또는 유한하지 않은 값)이면 스냅 불가로 보고 v를 그대로 반환(경계조건 방어).
export function snapValueToGrid(v: number, grid: number): number {
  if (!(grid > 0)) return v // grid<=0, NaN, Infinity 모두 방어 (부정 비교로 한 번에 처리)
  return Math.round(v / grid) * grid
}

// 점(x,y)을 각 축 독립으로 그리드에 스냅한 새 점을 반환한다.
export function snapPointToGrid(x: number, y: number, grid: number): { x: number; y: number } {
  return { x: snapValueToGrid(x, grid), y: snapValueToGrid(y, grid) }
}

// 현재점(curX,curY)을 그리드에 붙이기 위한 보정량 delta(dx,dy)를 반환한다.
// 사용 맥락: 새 위치에 delta를 더하면 그리드에 정렬된 위치가 된다.
export function snapDeltaToGrid(curX: number, curY: number, grid: number): { dx: number; dy: number } {
  return {
    dx: snapValueToGrid(curX, grid) - curX,
    dy: snapValueToGrid(curY, grid) - curY,
  }
}

// 한 축(x 또는 y)에 대한 이동 박스의 정렬 후보 좌표.
// left/right/center 처럼 "비교 기준이 되는 가장자리 위치"들을 담는다.
interface AxisCandidates {
  // 이동 박스 쪽 후보 (이 좌표들이 타깃에 맞춰진다)
  moving: number[]
  // 다른 박스들 쪽 후보 (정렬 타깃이 되는 좌표들)
  targets: number[]
}

// 한 축에 대해, 이동 박스 후보들과 타깃 후보들을 비교해
// threshold 이내에서 "가장 가까운 1쌍"의 보정량을 구한다.
// 정렬 가능한 쌍이 없으면 0을 반환한다.
function bestAxisDelta(cand: AxisCandidates, threshold: number): number {
  let bestDelta = 0
  let bestDist = Infinity // 현재까지 찾은 최소 거리(절댓값)
  for (const m of cand.moving) {
    for (const t of cand.targets) {
      const delta = t - m // m을 t에 맞추기 위한 보정량
      const dist = Math.abs(delta)
      // threshold 이내 + 지금까지보다 더 가까우면 갱신
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist
        bestDelta = delta
      }
    }
  }
  return bestDelta
}

// 이동 중 박스(moving)의 가장자리(left/right/centerX, top/bottom/centerY)를
// 다른 박스들(others)의 동일 종류 후보와 비교해, threshold(월드px) 이내면
// 가장 가까운 것에 정렬되는 보정량 {dx,dy} 를 반환한다.
// - x축/y축은 서로 독립적으로 각각 가장 가까운 1개씩 선택.
// - 정렬 후보가 없으면(others 빈 배열 포함) {dx:0,dy:0}.
// - threshold<=0(또는 비유한)이면 스냅 비활성으로 보고 {dx:0,dy:0}(경계조건 방어).
export function snapToNeighbors(
  moving: AABB,
  others: AABB[],
  threshold: number,
): { dx: number; dy: number } {
  if (others.length === 0 || !(threshold > 0)) return { dx: 0, dy: 0 }

  // 이동 박스의 x축 후보: 좌변 / 우변 / 수평 중심
  const movingX = [moving.minX, moving.maxX, (moving.minX + moving.maxX) / 2]
  // 이동 박스의 y축 후보: 상변 / 하변 / 수직 중심
  const movingY = [moving.minY, moving.maxY, (moving.minY + moving.maxY) / 2]

  // 다른 박스들의 동일 종류 후보를 한데 모은다.
  const targetsX: number[] = []
  const targetsY: number[] = []
  for (const o of others) {
    targetsX.push(o.minX, o.maxX, (o.minX + o.maxX) / 2)
    targetsY.push(o.minY, o.maxY, (o.minY + o.maxY) / 2)
  }

  // x축/y축 각각 독립적으로 가장 가까운 1쌍의 보정량을 구한다.
  const dx = bestAxisDelta({ moving: movingX, targets: targetsX }, threshold)
  const dy = bestAxisDelta({ moving: movingY, targets: targetsY }, threshold)
  return { dx, dy }
}
