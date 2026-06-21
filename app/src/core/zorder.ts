// z-order(레이어 순서) 관리 — 순수 데이터 모듈.
// 모든 함수는 BoardItem(이미지/노트/드로잉) 배열의 z 값만 변경한다. 렌더(PIXI node.zIndex)는 모른다.
// 규약: z가 클수록 화면 앞(scene.ts: sprite.zIndex = img.z, world.sortableChildren = true).
//
// 핵심 전략 — "순위(rank) 위에서 연산 후 0..n-1 연속 정수로 재할당".
//   1) 현재 z 오름차순(동점이면 배열 인덱스 순)으로 안정 정렬해 '뒤→앞' 순위 목록을 만든다.
//   2) 요청에 맞춰 그 목록의 순서를 바꾼다(또는 인접 교환).
//   3) 목록 순서대로 z = 0,1,2,...,n-1 을 다시 부여한다.
// 이렇게 하면 z 동점(tie)이 섞여 있어도 항상 안전하고, 결과 z가 빈틈없는 연속 정수가 된다.

import type { BoardItem } from './board'

// ids 인자를 빠른 조회용 Set으로 정규화 (Set 그대로 받거나 배열로 받음)
function toIdSet(ids: Set<string> | string[]): Set<string> {
  return ids instanceof Set ? ids : new Set(ids)
}

// 현재 z 오름차순으로 안정 정렬한 '뒤(작은 z)→앞(큰 z)' 배열을 반환.
// z 동점은 원래 배열 인덱스 순서로 깨뜨려(stable) 결정적 결과를 보장한다.
function sortedBackToFront(items: BoardItem[]): BoardItem[] {
  return items
    .map((img, i) => ({ img, i }))            // 원본 인덱스를 보존해 tie-break에 사용
    .sort((a, b) => a.img.z - b.img.z || a.i - b.i)
    .map((e) => e.img)
}

// 정렬된(뒤→앞) 배열의 순서대로 z = 0..n-1 을 다시 부여한다.
function assignContiguousZ(orderedBackToFront: BoardItem[]): void {
  for (let i = 0; i < orderedBackToFront.length; i++) {
    orderedBackToFront[i].z = i
  }
}

/**
 * 선택 항목들을 맨 앞(가장 큰 z 위)으로 보낸다.
 * 비선택 항목은 자기들끼리, 선택 항목은 자기들끼리 상대 순서를 보존한다.
 * 예) z=[A0,B1,C2,D3], 선택={B,D} → 비선택[A,C] 뒤 + 선택[B,D] → A0,C1,B2,D3
 */
export function bringToFront(items: BoardItem[], ids: Set<string> | string[]): void {
  const sel = toIdSet(ids)
  if (sel.size === 0) return
  const ordered = sortedBackToFront(items)
  const others = ordered.filter((img) => !sel.has(img.id)) // 뒤쪽: 비선택
  const picked = ordered.filter((img) => sel.has(img.id))  // 앞쪽: 선택
  assignContiguousZ([...others, ...picked])
}

/**
 * 선택 항목들을 맨 뒤(가장 작은 z 아래)로 보낸다.
 * 양쪽 모두 상대 순서 보존. 예) 선택={B,D} → B,D,A,C 순(뒤→앞).
 */
export function sendToBack(items: BoardItem[], ids: Set<string> | string[]): void {
  const sel = toIdSet(ids)
  if (sel.size === 0) return
  const ordered = sortedBackToFront(items)
  const picked = ordered.filter((img) => sel.has(img.id))  // 뒤쪽: 선택
  const others = ordered.filter((img) => !sel.has(img.id)) // 앞쪽: 비선택
  assignContiguousZ([...picked, ...others])
}

/**
 * 선택 항목들을 한 단계 앞으로(바로 위 비선택 항목과 위치 교환).
 * 다중 선택 시 앞쪽(큰 z)부터 처리해 선택 항목들끼리는 서로 밀지 않고 상대 순서를 보존한다.
 * 이미 맨 앞에 연속으로 쌓인 선택 항목은 더 올라가지 않는다.
 * 예) [A,B,C,D], 선택={B} → A,C,B,D (B가 C와 교환).
 */
export function bringForward(items: BoardItem[], ids: Set<string> | string[]): void {
  const sel = toIdSet(ids)
  if (sel.size === 0) return
  const ordered = sortedBackToFront(items) // index 0 = 맨 뒤, 마지막 = 맨 앞
  // 앞에서부터(뒤→앞 배열의 끝에서부터) 보면서, 위 칸이 비선택이면 한 칸 위로 올린다.
  for (let i = ordered.length - 2; i >= 0; i--) {
    if (sel.has(ordered[i].id) && !sel.has(ordered[i + 1].id)) {
      const tmp = ordered[i]
      ordered[i] = ordered[i + 1]
      ordered[i + 1] = tmp
    }
  }
  assignContiguousZ(ordered)
}

/**
 * 선택 항목들을 한 단계 뒤로(바로 아래 비선택 항목과 위치 교환).
 * 다중 선택 시 뒤쪽(작은 z)부터 처리해 선택 항목들끼리 상대 순서를 보존한다.
 * 이미 맨 뒤에 연속으로 쌓인 선택 항목은 더 내려가지 않는다.
 * 예) [A,B,C,D], 선택={C} → A,C,B,D (C가 B와 교환).
 */
export function sendBackward(items: BoardItem[], ids: Set<string> | string[]): void {
  const sel = toIdSet(ids)
  if (sel.size === 0) return
  const ordered = sortedBackToFront(items) // index 0 = 맨 뒤, 마지막 = 맨 앞
  // 뒤에서부터(뒤→앞 배열의 앞에서부터) 보면서, 아래 칸이 비선택이면 한 칸 아래로 내린다.
  for (let i = 1; i < ordered.length; i++) {
    if (sel.has(ordered[i].id) && !sel.has(ordered[i - 1].id)) {
      const tmp = ordered[i]
      ordered[i] = ordered[i - 1]
      ordered[i - 1] = tmp
    }
  }
  assignContiguousZ(ordered)
}

/**
 * 전체 z를 현재 순서(z 오름차순, 동점은 인덱스 순) 기준 0..n-1 연속 정수로 재할당.
 * 항목 삭제 등으로 생긴 빈 z 값을 정리해 항상 빈틈없는 정수 레이어를 보장한다.
 * 시각적 앞뒤 순서는 그대로 유지된다.
 */
export function normalizeZ(items: BoardItem[]): void {
  assignContiguousZ(sortedBackToFront(items))
}
