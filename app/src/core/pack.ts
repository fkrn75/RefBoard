// 자동 패킹(Auto-Pack) — PureRef류 "정렬" 킬러 기능의 핵심 배치 엔진.
//
// 여러 이미지를 빈틈 적게(타이트하게) 모아 붙이되, 전체 배치의 바운딩 박스가
// 원하는 가로/세로 비율(aspect)에 가깝게 수렴하도록 한다.
//
// 알고리즘: Skyline(스카이라인) 기반 bottom-left bin packing.
//   - MaxRects보다 구현이 단순하면서도 결과 품질이 충분히 좋고, PureRef도
//     유사한 row/skyline 방식으로 동작한다.
//   - "스카이라인"이란 현재까지 쌓인 아이템들의 윗면 윤곽선(x구간별 높이)이다.
//     새 아이템은 이 윤곽선 위에서 가장 낮고(=y 최소), 그다음 가장 왼쪽인(=x 최소)
//     자리에 놓는다. 사람이 손으로 차곡차곡 쌓는 모습과 비슷하다.
//   - 컨테이너 "폭"을 이진 탐색으로 바꿔가며 패킹해, 결과 바운딩 비율이 목표
//     aspect에 가장 가까워지는 폭을 고른다.
//
// 좌표 규약: 반환값은 각 아이템의 **중심 좌표**(PixiJS sprite anchor 0.5 기준).
//   전체 배치의 바운딩 박스 중심이 원점(0,0)에 오도록 가운데 정렬해서 돌려준다.
//   호출측은 이 좌표를 카메라/뷰포트 중앙 등 원하는 위치로 평행이동만 하면 된다.

import type { BoardImage } from './board'

// ─────────────────────────────────────────────────────────────────────────
// 공개 타입
// ─────────────────────────────────────────────────────────────────────────

/** 패킹 입력 1건. w/h는 **표시 크기**(예: natural.w × transform.scale)를 호출측이 계산해 넘긴다. */
export interface PackItem {
  id: string
  w: number
  h: number
}

/** 패킹 옵션. */
export interface PackOptions {
  /** 목표 가로/세로 비율(폭/높이). 예: 16/9 ≈ 1.78, 정사각 = 1. 0 이하·NaN이면 1로 보정. */
  aspect: number
  /** 아이템 사이 간격(px). 음수면 0으로 보정. */
  padding: number
}

/** 배치 결과 1건의 중심 좌표. */
export interface PackPos {
  x: number
  y: number
}

// ─────────────────────────────────────────────────────────────────────────
// 메인 진입점
// ─────────────────────────────────────────────────────────────────────────

/**
 * 이미지들을 자동 패킹해 각 id의 **중심 좌표**(앵커 0.5)를 반환한다.
 *
 * @param items 표시 크기(w/h)를 가진 아이템 목록. 빈 배열·1개도 안전 처리.
 * @param opts  aspect(가로/세로 비율), padding(간격 px).
 * @returns id → {x, y} 중심 좌표 맵. 전체 바운딩 중심이 원점(0,0)에 정렬됨.
 *
 * @example
 *   // 보드의 BoardImage[] 를 표시 크기로 변환해 패킹한 뒤, transform에 반영
 *   const pin = images.map(im => ({
 *     id: im.id,
 *     w: im.natural.w * im.transform.scale,
 *     h: im.natural.h * im.transform.scale,
 *   }))
 *   const pos = packImages(pin, { aspect: 16 / 9, padding: 16 })
 *   for (const im of images) {
 *     const p = pos.get(im.id)!
 *     im.transform.x = camera.x + p.x   // 원점 정렬이므로 원하는 중심으로 평행이동
 *     im.transform.y = camera.y + p.y
 *   }
 */
export function packImages(
  items: { id: string; w: number; h: number }[],
  opts: PackOptions,
): Map<string, PackPos> {
  const result = new Map<string, PackPos>()

  // ── 예외 처리: 빈 배열 ──
  if (!items || items.length === 0) return result

  const padding = Math.max(0, opts.padding || 0)
  const aspect = opts.aspect > 0 && Number.isFinite(opts.aspect) ? opts.aspect : 1

  // 비정상 크기(0·음수·NaN) 방어. 최소 1px로 보정해 패킹이 깨지지 않게 한다.
  const safe: PackItem[] = items.map((it) => ({
    id: it.id,
    w: sanitizeSize(it.w),
    h: sanitizeSize(it.h),
  }))

  // ── 예외 처리: 1개 ──
  // 단독 아이템은 그대로 원점 중심에 둔다.
  if (safe.length === 1) {
    result.set(safe[0].id, { x: 0, y: 0 })
    return result
  }

  // ── 컨테이너 폭 후보를 이진 탐색해 목표 aspect에 가장 가까운 배치를 찾는다 ──
  const best = findBestLayout(safe, padding, aspect)

  // ── 좌상단 기준 배치를 중심 좌표로 변환 + 전체를 원점 가운데 정렬 ──
  const halfW = best.width / 2
  const halfH = best.height / 2
  for (const p of best.placements) {
    result.set(p.id, {
      x: p.x + p.w / 2 - halfW, // 좌상단 → 중심, 그리고 바운딩 중심을 0으로
      y: p.y + p.h / 2 - halfH,
    })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────
// 내부 구현
// ─────────────────────────────────────────────────────────────────────────

/** 좌상단 기준 배치 1건. */
interface Placement {
  id: string
  x: number // 좌상단 x
  y: number // 좌상단 y
  w: number // padding 포함 폭
  h: number // padding 포함 높이
}

/** 한 번의 패킹 결과(좌상단 배치 + 실제 바운딩 크기). */
interface Layout {
  placements: Placement[]
  width: number
  height: number
}

/** 크기 1개를 안전한 양수로 보정(0·음수·NaN·Infinity → 1). */
function sanitizeSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  return v
}

/**
 * 컨테이너 폭을 바꿔가며 패킹해, 결과 바운딩 비율이 목표 aspect에 가장 가까운 배치를 고른다.
 *
 * 폭을 키우면 가로로 퍼져(=비율↑), 줄이면 세로로 쌓인다(=비율↓). 이 단조 경향을
 * 이용해 이진 탐색한다. 단, 아이템은 통째로만 놓이므로 비율이 폭에 대해 완벽히
 * 연속·단조이지는 않다. 그래서 이진 탐색으로 좁힌 뒤, 근방을 선형 스캔해 보강한다.
 */
function findBestLayout(items: PackItem[], padding: number, aspect: number): Layout {
  // 면적 합으로 "이상적인 폭"을 추정해 탐색 범위를 잡는다.
  // padding을 각 아이템에 더한 실효 면적 기준.
  let areaSum = 0
  let maxItemW = 0
  for (const it of items) {
    const w = it.w + padding
    const h = it.h + padding
    areaSum += w * h
    if (w > maxItemW) maxItemW = w
  }
  // 목표 비율을 만족하는 직사각형(면적=areaSum, 가로/세로=aspect)의 폭 = sqrt(area*aspect)
  const idealW = Math.sqrt(areaSum * aspect)

  // 탐색 하한: 가장 넓은 아이템보다는 커야 한다(아이템이 잘리면 안 됨).
  // 탐색 상한: 모든 아이템을 한 줄로 늘어놓는 폭(가장 가로로 퍼진 극단).
  let totalRowW = 0
  for (const it of items) totalRowW += it.w + padding
  const lo = maxItemW
  const hi = Math.max(maxItemW, totalRowW)

  // 이진 탐색: 목표 비율과의 오차가 최소가 되는 폭으로 수렴.
  let best: Layout | null = null
  let bestErr = Infinity
  const consider = (containerW: number) => {
    const layout = packSkyline(items, padding, containerW)
    const ratio = layout.width / Math.max(1, layout.height)
    const err = Math.abs(ratio - aspect)
    if (err < bestErr) {
      bestErr = err
      best = layout
    }
    return ratio
  }

  // idealW를 우선 한 번 평가(좋은 초기 후보).
  consider(clamp(idealW, lo, hi))

  let a = lo
  let b = hi
  for (let i = 0; i < 24; i++) {
    const mid = (a + b) / 2
    const ratio = consider(mid)
    if (ratio < aspect) {
      // 너무 세로로 김 → 폭을 넓혀 가로로 퍼뜨린다.
      a = mid
    } else {
      // 너무 가로로 김 → 폭을 줄인다.
      b = mid
    }
    if (b - a < 1) break
  }

  return best ?? packSkyline(items, padding, Math.max(maxItemW, idealW))
}

/**
 * 스카이라인 패킹: 주어진 컨테이너 폭(containerW) 안에서 아이템을 bottom-left로 쌓는다.
 *
 * 컨테이너 높이는 무제한(아래로 계속 쌓임). 폭만 제한해 줄바꿈을 유도한다.
 * 큰 아이템을 먼저 놓을수록 빈틈이 줄어들어, 높이 내림차순으로 정렬해 배치한다.
 */
function packSkyline(items: PackItem[], padding: number, containerW: number): Layout {
  // 높이 내림차순(같으면 폭 내림차순). 원본 배열을 건드리지 않도록 복사 후 정렬.
  const order = items.slice().sort((p, q) => q.h - p.h || q.w - p.w)

  // 스카이라인: x로 정렬된 세그먼트들. 각 세그먼트는 [x, width, y(윗면 높이)].
  // 처음엔 컨테이너 전체 폭이 높이 0인 한 세그먼트.
  const skyline: { x: number; width: number; y: number }[] = [
    { x: 0, width: containerW, y: 0 },
  ]

  const placements: Placement[] = []
  let usedW = 0
  let usedH = 0

  for (const it of order) {
    const w = it.w + padding
    const h = it.h + padding

    // 이 아이템을 놓을 최적 위치(=가장 낮고, 동률이면 가장 왼쪽)를 스카이라인에서 찾는다.
    const spot = findSkylineSpot(skyline, w, containerW)
    const x = spot.x
    const y = spot.y

    placements.push({ id: it.id, x, y, w, h })
    addSkylineLevel(skyline, x, w, y + h)

    if (x + w > usedW) usedW = x + w
    if (y + h > usedH) usedH = y + h
  }

  return { placements, width: usedW, height: usedH }
}

/**
 * 폭 w짜리 아이템을 놓을 자리를 스카이라인에서 찾는다.
 * 각 후보 x(=세그먼트 시작점)에서 폭 w 구간이 걸치는 세그먼트들의 최대 높이를
 * 바닥 y로 삼고, 그 y가 최소인 자리를 고른다(동률이면 x가 더 작은 쪽).
 */
function findSkylineSpot(
  skyline: { x: number; width: number; y: number }[],
  w: number,
  containerW: number,
): { x: number; y: number } {
  let bestX = 0
  let bestY = Infinity

  for (let i = 0; i < skyline.length; i++) {
    const x = skyline[i].x
    // 컨테이너 폭을 넘으면 이 시작점에는 놓을 수 없다.
    // (단, 가장 넓은 아이템이 containerW보다 큰 경우를 대비해 x=0은 항상 허용)
    if (x + w > containerW + 0.001 && x > 0) continue

    const y = skylineTopAt(skyline, x, w)
    if (y < bestY - 0.001 || (Math.abs(y - bestY) <= 0.001 && x < bestX)) {
      bestY = y
      bestX = x
    }
  }

  // 어떤 세그먼트에도 못 놓는 극단(아이템이 containerW보다 큼)은 x=0에 강제 배치.
  if (!Number.isFinite(bestY)) {
    bestX = 0
    bestY = skylineTopAt(skyline, 0, w)
  }

  return { x: bestX, y: bestY }
}

/** [x, x+w] 구간이 걸치는 스카이라인 세그먼트들의 최대 윗면 높이를 구한다. */
function skylineTopAt(
  skyline: { x: number; width: number; y: number }[],
  x: number,
  w: number,
): number {
  const right = x + w
  let top = 0
  for (const seg of skyline) {
    const segRight = seg.x + seg.width
    // 구간이 전혀 겹치지 않으면 건너뜀.
    if (segRight <= x + 0.001) continue
    if (seg.x >= right - 0.001) break // 정렬돼 있으므로 이후는 모두 오른쪽
    if (seg.y > top) top = seg.y
  }
  return top
}

/**
 * [x, x+w] 구간의 윗면을 높이 newY로 끌어올린다(아이템을 놓은 뒤 스카이라인 갱신).
 * 걸친 세그먼트들을 잘라내고 [x, w, newY] 세그먼트를 삽입한 뒤, 같은 높이 인접
 * 세그먼트를 병합해 세그먼트 수가 무한정 늘지 않게 한다.
 */
function addSkylineLevel(
  skyline: { x: number; width: number; y: number }[],
  x: number,
  w: number,
  newY: number,
): void {
  const right = x + w
  const next: { x: number; width: number; y: number }[] = []

  for (const seg of skyline) {
    const segRight = seg.x + seg.width
    // 갱신 구간과 무관한(완전히 왼쪽/오른쪽) 세그먼트는 그대로 보존.
    if (segRight <= x + 0.001 || seg.x >= right - 0.001) {
      next.push(seg)
      continue
    }
    // 겹치는 세그먼트: 왼쪽 잔여 조각이 있으면 남긴다.
    if (seg.x < x - 0.001) {
      next.push({ x: seg.x, width: x - seg.x, y: seg.y })
    }
    // 오른쪽 잔여 조각이 있으면 남긴다.
    if (segRight > right + 0.001) {
      next.push({ x: right, width: segRight - right, y: seg.y })
    }
    // 겹친 가운데 부분은 새 높이로 대체되므로 버린다(아래에서 한 번에 삽입).
  }

  // 새 높이 세그먼트 삽입.
  next.push({ x, width: w, y: newY })

  // x 기준 정렬 후, 같은 높이의 인접 세그먼트 병합.
  next.sort((p, q) => p.x - q.x)
  const merged: { x: number; width: number; y: number }[] = []
  for (const seg of next) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.y - seg.y) <= 0.001 && Math.abs(last.x + last.width - seg.x) <= 0.001) {
      last.width += seg.width // 연속 + 동일 높이 → 합침
    } else {
      merged.push({ ...seg })
    }
  }

  // skyline 배열을 in-place로 교체.
  skyline.length = 0
  for (const seg of merged) skyline.push(seg)
}

/** 값 v를 [lo, hi]로 클램프. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// 참고: 위에서 import한 BoardImage 타입은 호출측(통합 코드)에서 표시 크기를 뽑을 때
// 함께 쓰라는 의도로 재노출한다. pack.ts 자체는 순수 함수만 제공한다.
export type { BoardImage }
