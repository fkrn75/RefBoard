import { describe, expect, it } from 'vitest'
import { buildDrawingGeometry } from './drawing-tool'

describe('buildDrawingGeometry', () => {
  it('펜: 점들을 중심 정규화하고 바운딩박스를 낸다', () => {
    const geo = buildDrawingGeometry(
      'pen',
      [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
      1,
    )
    expect(geo).not.toBeNull()
    if (!geo) return
    expect(geo.natural).toEqual({ w: 10, h: 20 })
    expect(geo.transform).toEqual({ x: 5, y: 10 }) // 바운딩박스 중심
    // points는 중심(5,10) 기준 로컬 좌표로 정규화된다
    expect(geo.points).toEqual([
      { x: -5, y: -10 },
      { x: 5, y: 10 },
    ])
  })

  it('2점 도형: 너무 작으면(클릭 수준) null, 충분히 크면 통과', () => {
    // rect, zoom=1 → tiny=3. 2×2 박스는 tiny 미만 → null
    expect(
      buildDrawingGeometry(
        'rect',
        [
          { x: 0, y: 0 },
          { x: 2, y: 2 },
        ],
        1,
      ),
    ).toBeNull()
    const big = buildDrawingGeometry(
      'rect',
      [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ],
      1,
    )
    expect(big?.natural).toEqual({ w: 100, h: 50 })
  })

  it('line: 중간 점은 버리고 시작·끝 2점만 쓰며 0두께는 1로 보정', () => {
    const geo = buildDrawingGeometry(
      'line',
      [
        { x: 0, y: 0 },
        { x: 50, y: 50 }, // 중간(무시되어야 함)
        { x: 100, y: 0 },
      ],
      1,
    )
    expect(geo).not.toBeNull()
    if (!geo) return
    expect(geo.points).toHaveLength(2) // 중간 점 제거
    expect(geo.natural.w).toBe(100)
    expect(geo.natural.h).toBe(1) // h=0 → 최소 1 보정
    expect(geo.transform.x).toBe(50)
  })

  it('빈 점·펜 1점은 null', () => {
    expect(buildDrawingGeometry('pen', [], 1)).toBeNull()
    expect(buildDrawingGeometry('pen', [{ x: 1, y: 1 }], 1)).toBeNull()
  })
})
