// 그룹 순수 로직 — Phase 2.6 그룹 기능의 부작용 없는 계산 코어.
// 그룹은 BoardImage.groupId?: string 로만 표현된다(같은 값=한 그룹, 없으면 미그룹).
// 이 모듈의 모든 함수는 순수 함수다: 입력을 변형(mutate)하지 않고, 전역 상태를 읽거나 쓰지 않으며,
// 오직 "무엇을 어떻게 바꿀지"의 계획(대상 id 목록 등)만 반환한다. 실제 변형은 호출측(board/scene)이 수행한다.

import type { BoardItem } from './board'
import { genId } from './board'

// 한 그룹(groupId)에 속한 모든 멤버의 id를 board 순서대로 반환한다.
// groupId가 빈 문자열이거나 매칭이 없으면 빈 배열.
export function groupMembers(items: BoardItem[], groupId: string): string[] {
  if (!groupId) return []
  const out: string[] = []
  for (const it of items) {
    if (it.groupId === groupId) out.push(it.id)
  }
  return out
}

// 선택 id들을 같은 그룹의 모든 멤버까지 확장한다.
// - 미그룹(groupId 없음) id는 그대로 유지.
// - 그룹에 속한 id는 그 그룹의 전체 멤버로 확장.
// - 중복은 제거하되, 입력 선택 순서를 기준으로 한 안정적(stable) 순서를 보장한다.
//   (선택 id를 순회하면서 처음 등장하는 시점에 해당 항목/그룹 멤버들을 board 순서로 끼워넣는다.)
// 클릭/러버밴드 선택 직후 "그룹 통째 선택"을 만드는 데 사용.
export function expandByGroup(items: BoardItem[], ids: string[]): string[] {
  if (ids.length === 0) return []

  // id → 아이템 빠른 조회용 인덱스.
  const byId = new Map<string, BoardItem>()
  for (const it of items) byId.set(it.id, it)

  const result: string[] = []
  const seen = new Set<string>()
  const expandedGroups = new Set<string>() // 이미 통째로 펼친 그룹(중복 확장 방지)

  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }

  for (const id of ids) {
    const it = byId.get(id)
    if (!it) continue // 존재하지 않는 id 방어

    const gid = it.groupId
    if (!gid) {
      // 미그룹: 자기 자신만 추가.
      push(id)
      continue
    }

    // 그룹 소속: 그룹 전체를 board 순서로 펼친다(그룹당 1회).
    if (!expandedGroups.has(gid)) {
      expandedGroups.add(gid)
      for (const memberId of groupMembers(items, gid)) push(memberId)
    } else {
      // 이미 펼친 그룹의 다른 멤버가 또 선택돼 있어도 안전(이미 seen 처리됨).
      push(id)
    }
  }

  return result
}

// 선택에 걸린 distinct groupId 목록을 반환한다(선택 순서 기준, 중복 제거).
// 미그룹 아이템은 무시된다.
export function groupsInSelection(items: BoardItem[], ids: string[]): string[] {
  if (ids.length === 0) return []
  const byId = new Map<string, BoardItem>()
  for (const it of items) byId.set(it.id, it)

  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const it = byId.get(id)
    if (!it || !it.groupId) continue
    if (!seen.has(it.groupId)) {
      seen.add(it.groupId)
      out.push(it.groupId)
    }
  }
  return out
}

// 그룹화 계획을 반환한다.
// - 선택된(존재하는) 아이템이 서로 다른 2개 이상일 때만 그룹화 가능 → 새 groupId(기존과 충돌 없음)와 멤버 id 반환.
// - 그 외(빈 선택 / 단일 선택 / 유효 아이템 2개 미만)에는 null.
// - 이미 같은 그룹이어도 "재그룹"으로 허용한다(새 groupId 발급).
// memberIds는 입력 선택 순서를 보존하되 중복 id는 제거한다.
export function planGroup(
  items: BoardItem[],
  ids: string[],
): { groupId: string; memberIds: string[] } | null {
  if (ids.length < 2) return null

  // 존재하는 아이템만, 순서 보존 + 중복 제거.
  const byId = new Map<string, BoardItem>()
  for (const it of items) byId.set(it.id, it)

  const memberIds: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!byId.has(id) || seen.has(id)) continue
    seen.add(id)
    memberIds.push(id)
  }

  // 서로 다른 유효 아이템이 2개 이상이어야 그룹 의미가 있다.
  if (memberIds.length < 2) return null

  // 기존 groupId와 충돌하지 않는 새 id 발급.
  const existing = new Set<string>()
  for (const it of items) if (it.groupId) existing.add(it.groupId)
  let groupId = genId()
  while (existing.has(groupId)) groupId = genId()

  return { groupId, memberIds }
}

// 그룹 해제 계획을 반환한다.
// 선택에 걸린 "모든 그룹"의 전체 멤버 id를 board 순서대로 반환한다.
// (호출측이 이 id들의 groupId를 지우면 해당 그룹들이 통째로 해제된다.)
// 선택이 어떤 그룹에도 걸리지 않으면 빈 배열.
// 부분 선택(그룹의 일부만 선택)이어도 그룹 전체가 해제 대상이 된다 — 그룹은 전부 또는 전무로 다룬다.
export function planUngroup(items: BoardItem[], ids: string[]): string[] {
  const groups = groupsInSelection(items, ids)
  if (groups.length === 0) return []

  const target = new Set(groups)
  const out: string[] = []
  for (const it of items) {
    if (it.groupId && target.has(it.groupId)) out.push(it.id)
  }
  return out
}
