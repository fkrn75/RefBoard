// arrange-sort 정렬(sortItems) 단위 테스트.
// 특히 'added' 정렬에서 addedAt(epoch ms)과 z(작은 정수)를 같은 축에서 섞지 않는지
// (P3 굳히기로 그룹 분리한 회귀)를 고정한다.
import { describe, it, expect } from 'vitest'
import { sortItems, type SortItem } from './arrange-sort'

// 최소 필드만 채운 SortItem 헬퍼.
function mk(id: string, over: Partial<SortItem> = {}): SortItem {
  return { id, z: 0, w: 10, h: 10, ...over }
}

describe('sortItems', () => {
  it("added: addedAt이 모두 있으면 시각 오름차순", () => {
    const r = sortItems([mk('a', { addedAt: 300 }), mk('b', { addedAt: 100 }), mk('c', { addedAt: 200 })], 'added')
    expect(r.map((i) => i.id)).toEqual(['b', 'c', 'a'])
  })

  it("added: addedAt 없는 레거시 항목은 앞으로 모이고 그들끼리는 z 오름차순", () => {
    // a=시각 있음, b/c=z만(레거시). 기대: 레거시(c z2, b z5) 먼저, 그 뒤 시각 항목 a.
    const r = sortItems([mk('a', { addedAt: 1000 }), mk('b', { z: 5 }), mk('c', { z: 2 })], 'added')
    expect(r.map((i) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it("added: ms와 z를 같은 축에서 섞지 않는다(큰 z가 작은 addedAt보다 앞서던 구버그 회귀)", () => {
    // 구코드(av = addedAt ?? z)는 z(999)와 addedAt(1.7e12)을 직접 빼서 비교 → z 항목이 항상 앞.
    // 새 정책은 그룹을 분리해 "레거시(z만) → 시각 있음" 순서를 보장(값 혼합 비교 없음).
    const r = sortItems([mk('big', { addedAt: 1_700_000_000_000 }), mk('leg', { z: 999 })], 'added')
    expect(r.map((i) => i.id)).toEqual(['leg', 'big'])
  })

  it("added: addedAt=0(epoch)도 '있음'으로 취급(레거시로 폴백하지 않음)", () => {
    const r = sortItems([mk('zero', { addedAt: 0 }), mk('leg', { z: 5 })], 'added')
    // zero는 시각 있음 → 레거시(leg) 뒤.
    expect(r.map((i) => i.id)).toEqual(['leg', 'zero'])
  })

  it("name: name 오름차순, 없으면 id 폴백", () => {
    const r = sortItems([mk('x', { name: 'banana' }), mk('y', { name: 'apple' })], 'name')
    expect(r.map((i) => i.id)).toEqual(['y', 'x'])
  })

  it("order: 입력 순서 보존(사본 반환, 원본 불변)", () => {
    const input = [mk('a'), mk('b'), mk('c')]
    const r = sortItems(input, 'order')
    expect(r.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(r).not.toBe(input) // 사본
  })

  it("random: seed 같으면 결정적, seed 없으면 입력순 유지", () => {
    const input = [mk('a'), mk('b'), mk('c'), mk('d')]
    const r1 = sortItems(input, 'random', 42)
    const r2 = sortItems(input, 'random', 42)
    expect(r1.map((i) => i.id)).toEqual(r2.map((i) => i.id)) // 결정적
    const noSeed = sortItems(input, 'random')
    expect(noSeed.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']) // 입력순
  })
})
