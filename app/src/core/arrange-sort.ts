// 기준별 격자 정렬(Arrange by Sort) — 선택/전체 아이템을 "이름·추가순·현재순·랜덤"으로
// 정렬한 뒤 행 우선(row-major) 격자로 가지런히 배치하는 순수 함수 모듈.
//
// 설계 원칙(pack.ts와 동일 규약):
//  - 상태를 갖지 않는 순수 함수. transform을 직접 바꾸지 않고 각 id의 "중심 좌표"만 반환한다.
//    (실제 transform 갱신·히스토리 기록은 호출측(main) 책임 — pack 결과와 동일하게 적용)
//  - 반환 좌표는 각 아이템의 **중심 좌표**(PixiJS sprite anchor 0.5 기준)이며,
//    전체 배치의 바운딩 박스 중심이 원점(0,0)에 오도록 가운데 정렬해서 돌려준다.
//    호출측은 이 좌표를 카메라/뷰포트 중앙 등 원하는 위치로 평행이동만 하면 된다.
//
// 격자 방식:
//  - pack.ts(빈틈 최소 타이트 패킹)와 달리, 여기서는 "정렬 순서가 한눈에 보이는" 규칙적
//    격자를 만든다. 셀 크기는 모든 항목을 담을 수 있는 균일 셀(최대 폭 × 최대 높이)로 잡아
//    행·열이 깔끔히 줄 맞춰지게 한다(파일 관리자 아이콘 격자/ PureRef grid 정렬과 동일 감각).
//  - 열 수는 aspect(가로/세로 비율)와 항목 수로 산정한다(pack.ts의 sqrt(area*aspect) 발상 차용).

// 정렬 기준 키.
//   name   = 파일명(name) 오름차순(locale 비교). 없으면 id로 폴백.
//   added  = 추가 시각(addedAt) 오름차순. addedAt 없는 레거시 항목은 앞으로 모아 z로 폴백.
//   order  = 현재 입력 순서 그대로(정렬하지 않음).
//   random = seed 기반 결정적 셔플(seed 없으면 입력순 유지).
export type SortKey = 'name' | 'added' | 'order' | 'random'

// 정렬/배치에 필요한 아이템 1건의 입력 정보. 호출측(main)이 각 대상 아이템에서 모아 넘긴다.
export interface SortItem {
  id: string
  name?: string // 파일명(name 정렬용). 없으면 id로 폴백
  addedAt?: number // 추가 시각 epoch ms(added 정렬용). 없으면 z로 폴백
  z: number // 레이어 순서(added 폴백 기준)
  w: number // 표시 폭(예: natural.w * transform.scale) — 호출측이 계산해 넘김
  h: number // 표시 높이(예: natural.h * transform.scale)
}

// 격자 배치 옵션.
export interface GridArrangeOptions {
  aspect: number // 목표 가로/세로 비율(폭/높이). 0 이하·NaN이면 1로 보정
  padding: number // 셀 간격(px). 음수면 0으로 보정
  reverse?: boolean // true면 정렬 결과를 역순으로(같은 키 재실행 시 역순 토글을 호출측이 제어)
  seed?: number // random 키의 셔플 시드(없으면 입력순)
}

// 배치 결과 1건의 중심 좌표.
export interface GridPos {
  x: number
  y: number
}

/**
 * 아이템들을 기준(key)으로 정렬 → 행 우선 격자로 배치하고, 각 id의 **중심 좌표**를 반환한다.
 *
 * @param items 표시 크기(w/h)와 정렬 키 필드를 가진 아이템 목록. 빈 배열·1개도 안전 처리.
 * @param key   정렬 기준('name'|'added'|'order'|'random').
 * @param opts  aspect(가로/세로 비율), padding(셀 간격), reverse(역순), seed(랜덤 시드).
 * @returns id → {x, y} 중심 좌표 맵. 전체 바운딩 중심이 원점(0,0)에 정렬됨(pack.ts와 동일 규약).
 */
export function arrangeGrid(
  items: SortItem[],
  key: SortKey,
  opts: GridArrangeOptions,
): Map<string, GridPos> {
  const result = new Map<string, GridPos>()

  // ── 예외 처리: 빈 배열 ──
  if (!items || items.length === 0) return result

  const padding = Math.max(0, opts.padding || 0)
  const aspect = opts.aspect > 0 && Number.isFinite(opts.aspect) ? opts.aspect : 1

  // ── 1) 정렬 ──
  const sorted = sortItems(items, key, opts.seed)
  if (opts.reverse) sorted.reverse()

  // ── 예외 처리: 1개 ──
  // 단독 아이템은 그대로 원점 중심에 둔다.
  if (sorted.length === 1) {
    result.set(sorted[0].id, { x: 0, y: 0 })
    return result
  }

  // ── 2) 균일 셀 크기 산정(모든 항목을 담는 최대 폭/높이 + 간격) ──
  let maxW = 0
  let maxH = 0
  for (const it of sorted) {
    const w = sanitizeSize(it.w)
    const h = sanitizeSize(it.h)
    if (w > maxW) maxW = w
    if (h > maxH) maxH = h
  }
  const cellW = maxW + padding // 가로 간격 포함 셀 폭
  const cellH = maxH + padding // 세로 간격 포함 셀 높이

  // ── 3) 열 수 산정 ──
  // 목표 비율을 만족하는 격자: cols/rows ≈ aspect, cols*rows ≥ n.
  // 셀이 균일(cellW×cellH)이므로 셀의 가로세로비를 반영해 열 수를 보정한다.
  //   원하는 배치 가로/세로 = (cols*cellW)/(rows*cellH) ≈ aspect
  //   rows ≈ n/cols  ⇒  cols ≈ sqrt(n * aspect * cellH / cellW)
  const n = sorted.length
  let cols = Math.round(Math.sqrt((n * aspect * cellH) / cellW))
  cols = clampInt(cols, 1, n) // 최소 1열, 최대 n열(한 줄)
  const rows = Math.ceil(n / cols)

  // ── 4) 행 우선 배치 → 중심 좌표(좌상단 기준) ──
  // (col,row) 셀의 중심 = (col*cellW + maxW/2, row*cellH + maxH/2).
  // 각 항목은 자기 셀 중앙에 놓아 크기가 달라도 셀 가운데 정렬되게 한다.
  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = col * cellW + maxW / 2
    const cy = row * cellH + maxH / 2
    result.set(sorted[i].id, { x: cx, y: cy })
  }

  // ── 5) 전체 바운딩 중심을 원점(0,0)으로 평행이동 ──
  // 사용 셀 격자의 폭/높이(마지막 셀은 padding이 바깥으로 안 나가도록 maxW/maxH로 닫음).
  const usedCols = Math.min(cols, n) // 1행밖에 안 차는 경우 실제 사용 열 수
  const totalW = (usedCols - 1) * cellW + maxW
  const totalH = (rows - 1) * cellH + maxH
  const halfW = totalW / 2
  const halfH = totalH / 2
  for (const [id, pos] of result) {
    result.set(id, { x: pos.x - halfW, y: pos.y - halfH })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────
// 내부 구현
// ─────────────────────────────────────────────────────────────────────────

// 기준 키로 정렬한 새 배열을 반환한다(입력 배열은 불변).
// 순수 함수라 단위 테스트용으로 export(arrange-sort.test.ts).
export function sortItems(items: SortItem[], key: SortKey, seed?: number): SortItem[] {
  // order: 입력 순서 그대로(사본만 반환).
  if (key === 'order') return items.slice()

  // random: seed 기반 결정적 Fisher-Yates 셔플. seed 없으면 입력순 유지.
  if (key === 'random') {
    if (seed === undefined || !Number.isFinite(seed)) return items.slice()
    const arr = items.slice()
    const rand = mulberry32(seed >>> 0)
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const t = arr[i]
      arr[i] = arr[j]
      arr[j] = t
    }
    return arr
  }

  const arr = items.slice()
  if (key === 'name') {
    // 파일명 오름차순. name 없으면 id로 폴백. localeCompare로 숫자/한글 자연스러운 순서.
    arr.sort((a, b) => {
      const an = a.name ?? a.id
      const bn = b.name ?? b.id
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' })
    })
    return arr
  }

  // added: 추가 시각(epoch ms) 오름차순. addedAt(ms)과 z(작은 정수)는 자릿수가 크게 달라
  // 같은 축에서 섞으면 정렬이 왜곡되므로(z만 있는 레거시 아이템이 항상 앞으로 쏠림) 그룹을 분리한다.
  //  - 둘 다 addedAt 있음 → addedAt 비교
  //  - 한쪽만 있음 → addedAt 없는(레거시) 쪽을 앞으로
  //  - 둘 다 없음 → z(레이어 순서)로 폴백
  arr.sort((a, b) => {
    const aHas = a.addedAt != null
    const bHas = b.addedAt != null
    if (aHas && bHas) return a.addedAt! - b.addedAt!
    if (aHas !== bHas) return aHas ? 1 : -1
    return a.z - b.z
  })
  return arr
}

// 크기 1개를 안전한 양수로 보정(0·음수·NaN·Infinity → 1). pack.ts와 동일 정책.
function sanitizeSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  return v
}

// 정수 값 v를 [lo, hi]로 클램프(반올림 후).
function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v)
  return r < lo ? lo : r > hi ? hi : r
}

// mulberry32 — 시드 1개로 결정적 난수(0~1)를 내는 작은 PRNG. 셔플 재현성 확보용.
function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
