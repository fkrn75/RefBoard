// 정렬/분배/정규화 계산 모듈 (RefBoard Phase 2.4).
//
// 다중 선택된 아이템들의 "정렬·균등분배·크기 통일"을 순수 함수로만 제공한다.
// - 상태(선택 집합·줌·현재 transform)는 main이 관리하므로 이 모듈은 상태를 갖지 않는다.
// - 모든 함수는 transform을 직접 바꾸지 않고, 적용해야 할 "보정량/목표값"만 Map<id,...>으로 반환한다.
//   (실제 transform 갱신·히스토리 기록은 호출측(main) 책임)
// - 좌표계: scene.getItemAABB 와 동일한 월드 좌표. 길이/배율도 모두 월드 단위.
// - 회전: aabb 는 회전을 포함한 경계상자이며, 정렬은 단순화를 위해 회전 여부와 무관하게
//   aabb(경계) 기준으로 계산한다(회전된 항목도 그 경계로 정렬됨).

import type { AABB } from './snap'

// 정렬/분배/정규화에 필요한 아이템 1건의 입력 정보.
// 호출측(main)이 각 선택 아이템에서 모아 넘긴다.
export interface AlignItem {
  id: string
  aabb: AABB // 월드 경계상자(회전 포함). scene.getItemAABB 반환형과 동일
  cx: number // 현재 transform 중심 X (스프라이트 anchor=0.5 기준)
  cy: number // 현재 transform 중심 Y
  natural: { w: number; h: number } // 원본 픽셀 크기(배율 1일 때의 폭/높이)
  scale: number // 현재 균등 배율(가로·세로 동일)
}

// 이동 보정량(dx,dy를 현재 transform 중심에 더하면 정렬 위치가 된다).
export interface Delta {
  dx: number
  dy: number
}

// ---- 정렬(alignEdge) ----

// 선택 묶음의 공통 기준선에 각 아이템의 가장자리/중심을 맞추는 이동량 {dx,dy}를 id별로 반환한다.
// 기준선 정의:
//   left    = 묶음 내 최소 minX (가장 왼쪽 변)  → 각 항목 좌변을 여기에 맞춤
//   right   = 묶음 내 최대 maxX (가장 오른쪽 변) → 각 항목 우변을 여기에 맞춤
//   top     = 묶음 내 최소 minY (가장 위쪽 변)  → 각 항목 상변을 여기에 맞춤
//   bottom  = 묶음 내 최대 maxY (가장 아래쪽 변) → 각 항목 하변을 여기에 맞춤
//   hcenter = 전체 합집합 경계의 중심 X         → 각 항목 중심 X를 여기에 맞춤
//   vcenter = 전체 합집합 경계의 중심 Y         → 각 항목 중심 Y를 여기에 맞춤
// - left/right/top/bottom 은 한 축(x 또는 y)만 보정하고 다른 축 보정량은 0.
// - hcenter/vcenter 도 각각 한 축만 보정.
// - 2개 미만이면 정렬 대상이 없으므로 빈 Map 반환(경계조건 방어).
export function alignEdge(
  items: AlignItem[],
  edge: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter',
): Map<string, Delta> {
  const result = new Map<string, Delta>()
  if (items.length < 2) return result // 단일/빈 선택은 정렬 의미 없음

  // 묶음 전체의 합집합 경계(기준선 계산용).
  const bounds = unionBounds(items)

  for (const it of items) {
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left':
        // 좌변(minX)을 묶음 최소 minX에 맞춘다.
        dx = bounds.minX - it.aabb.minX
        break
      case 'right':
        // 우변(maxX)을 묶음 최대 maxX에 맞춘다.
        dx = bounds.maxX - it.aabb.maxX
        break
      case 'top':
        // 상변(minY)을 묶음 최소 minY에 맞춘다.
        dy = bounds.minY - it.aabb.minY
        break
      case 'bottom':
        // 하변(maxY)을 묶음 최대 maxY에 맞춘다.
        dy = bounds.maxY - it.aabb.maxY
        break
      case 'hcenter': {
        // 항목 중심 X를 묶음 중심 X에 맞춘다. aabb 중심을 기준으로 보정량을 구해
        // transform 중심(cx)에 더한다(둘의 오프셋은 동일하므로 cx로 직접 보정 가능).
        const targetCx = (bounds.minX + bounds.maxX) / 2
        const itemCx = (it.aabb.minX + it.aabb.maxX) / 2
        dx = targetCx - itemCx
        break
      }
      case 'vcenter': {
        // 항목 중심 Y를 묶음 중심 Y에 맞춘다.
        const targetCy = (bounds.minY + bounds.maxY) / 2
        const itemCy = (it.aabb.minY + it.aabb.maxY) / 2
        dy = targetCy - itemCy
        break
      }
    }
    result.set(it.id, { dx, dy })
  }
  return result
}

// ---- 분배(distribute) ----

// 양 끝 항목은 고정하고, 사이 항목들을 "가장자리 기준 간격(gap)이 동일"하도록 재배치하는
// 이동량 {dx,dy}를 id별로 반환한다.
// - axis='h': 수평(X)으로 분배, axis='v': 수직(Y)으로 분배.
// - 항목이 3개 미만이면 분배할 사이 공간이 없으므로 빈 Map 반환.
// - "균등 간격"의 정의: 정렬 순서상 인접한 두 항목 사이의 빈 틈(앞 항목 끝 ~ 뒤 항목 시작)을
//   모두 동일하게 만든다. 각 항목의 크기가 다를 수 있으므로 중심 등간격이 아니라 gap 등간격이다.
export function distribute(items: AlignItem[], axis: 'h' | 'v'): Map<string, Delta> {
  const result = new Map<string, Delta>()
  if (items.length < 3) return result // 양 끝 + 사이 1개 이상 필요

  const horizontal = axis === 'h'

  // 정렬 축의 시작 좌표(min) 기준으로 오름차순 정렬한 사본을 만든다(입력 배열은 불변).
  const sorted = [...items].sort((a, b) =>
    horizontal ? a.aabb.minX - b.aabb.minX : a.aabb.minY - b.aabb.minY,
  )

  // 축 방향 길이(폭 또는 높이)를 구하는 헬퍼.
  const sizeOf = (it: AlignItem): number =>
    horizontal ? it.aabb.maxX - it.aabb.minX : it.aabb.maxY - it.aabb.minY
  // 축 방향 시작 좌표(min)를 구하는 헬퍼.
  const startOf = (it: AlignItem): number => (horizontal ? it.aabb.minX : it.aabb.minY)

  const first = sorted[0]
  const last = sorted[sorted.length - 1]

  // 양 끝을 포함한 전체 span에서 모든 항목의 길이 합을 빼면, 사이에 분배할 총 여백.
  const span = (startOf(last) + sizeOf(last)) - startOf(first) // first 시작 ~ last 끝
  let totalSize = 0
  for (const it of sorted) totalSize += sizeOf(it)
  const totalGap = span - totalSize // 음수가 될 수도 있음(겹침) → 그대로 균등 분배
  const gap = totalGap / (sorted.length - 1) // 인접 쌍 개수로 균등 분할

  // 첫 항목은 고정. 이후 항목의 목표 시작 = 직전 항목 끝 + gap.
  let cursor = startOf(first) + sizeOf(first) // 첫 항목의 끝 위치
  for (let i = 1; i < sorted.length - 1; i++) {
    const it = sorted[i]
    const targetStart = cursor + gap // 이 항목이 놓일 목표 시작 좌표
    const delta = targetStart - startOf(it) // 현재 시작 → 목표 시작 보정량
    result.set(it.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta })
    cursor = targetStart + sizeOf(it) // 다음 항목을 위해 커서를 이 항목 끝으로 이동
  }
  // 마지막 항목은 고정이므로 결과에 넣지 않는다(보정량 0과 동일).
  return result
}

// ---- 크기 정규화(normalizeSize) ----

// 선택 아이템들의 크기를 통일하기 위한 "새 균등 배율(scale)"을 id별로 반환한다.
//   width  = 모든 항목의 폭(natural.w * scale)을 동일하게
//   height = 모든 항목의 높이(natural.h * scale)를 동일하게
//   scale  = 모든 항목의 배율(scale) 자체를 동일하게
// 기준값 선택: 일관성을 위해 "첫 항목(items[0])"을 기준으로 삼는다.
//   (평균이 아닌 첫 항목 기준 — 사용자가 기준으로 삼고 싶은 항목을 먼저 선택/지정하는 UX 전제)
// - 폭/높이 통일은 균등 배율만 바꾸므로, 목표 길이를 각 항목의 natural로 나눠 새 scale을 구한다.
// - natural 값이 0/음수/비유한이면 0 나눗셈을 피하기 위해 그 항목은 기존 scale 유지(방어).
// - 2개 미만이면 통일 대상이 없으므로 빈 Map 반환.
export function normalizeSize(
  items: AlignItem[],
  mode: 'width' | 'height' | 'scale',
): Map<string, { scale: number }> {
  const result = new Map<string, { scale: number }>()
  if (items.length < 2) return result

  const ref = items[0] // 기준 항목

  if (mode === 'scale') {
    // 배율 자체를 기준 항목의 scale로 통일.
    for (const it of items) result.set(it.id, { scale: ref.scale })
    return result
  }

  // width/height: 기준 항목의 현재 길이(원본*배율)를 목표 길이로 삼는다.
  const targetLen =
    mode === 'width' ? ref.natural.w * ref.scale : ref.natural.h * ref.scale

  for (const it of items) {
    // 이 항목의 원본 길이(목표 길이를 만들기 위한 분모).
    const naturalLen = mode === 'width' ? it.natural.w : it.natural.h
    // 분모가 유효하지 않으면 0 나눗셈/NaN을 피하기 위해 기존 배율을 유지.
    const newScale = naturalLen > 0 ? targetLen / naturalLen : it.scale
    result.set(it.id, { scale: newScale })
  }
  return result
}

// ---- 내부 헬퍼 ----

// 여러 아이템 aabb의 합집합 경계(전체를 감싸는 최소 경계상자)를 구한다.
// 호출측에서 items.length>=1 을 보장한 상태로만 사용한다(빈 배열 비대상).
function unionBounds(items: AlignItem[]): AABB {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const it of items) {
    if (it.aabb.minX < minX) minX = it.aabb.minX
    if (it.aabb.minY < minY) minY = it.aabb.minY
    if (it.aabb.maxX > maxX) maxX = it.aabb.maxX
    if (it.aabb.maxY > maxY) maxY = it.aabb.maxY
  }
  return { minX, minY, maxX, maxY }
}
